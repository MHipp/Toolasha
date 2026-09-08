/** @vitest-environment happy-dom
 *
 * That the panel actually draws a plan.
 *
 * The arithmetic is tested against fixtures in `goal-planner.test.js`; nothing
 * here re-checks a number. What this catches is the other failure — a renamed
 * helper, a property read off something that stopped having it — which no
 * arithmetic test can see, because the panel swallows per-goal errors so one
 * bad goal does not blank the rest. `could not be drawn` on screen is the
 * symptom, so it is the assertion.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));
// Mutable so a test can simulate a character switch mid-await; every other
// test leaves it at the default and never notices it exists.
const character = vi.hoisted(() => ({ id: 'char1' }));
/**
 * The reservation ledger, doubled at the seam. Its arithmetic belongs to
 * `utils/inventory-reservations.test.js`; what matters here is which character
 * a claim is written under.
 */
const ledger = vi.hoisted(() => ({ enabled: false, reserved: [], swept: [], onSweep: null }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    reservationsEnabled: () => ledger.enabled,
    effectiveInventory: (_hrid, _level, { held = 0 } = {}) => held,
    shortfallNote: () => '',
    releaseMissing: async (prefix, live) => {
        ledger.swept.push({ prefix, live: [...live] });
        await ledger.onSweep?.();
        return 0;
    },
    reserve: async (ownerId) => {
        ledger.reserved.push({ ownerId, character: character.id });
        return true;
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1100, getSetting: () => true, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, _name, fallback = null) => store.data[key] ?? fallback,
        tryGet: async (key) =>
            store.data[key] != null ? { found: true, value: store.data[key] } : { found: false, value: null },
        set: async (key, value) => {
            store.data[key] = value;
            return true;
        },
        delete: async (key) => {
            delete store.data[key];
            return true;
        },
        getAllKeys: async () => Object.keys(store.data),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/sinister_cape': { name: 'Sinister Cape', equipmentDetail: { type: '/equipment_types/back' } },
            },
            houseRoomDetailMap: { '/house_rooms/observatory': { name: 'Observatory' } },
        }),
        getSkills: () => [{ skillHrid: '/skills/enhancing', level: 90, experience: 90_000 }],
        on: () => {},
        off: () => {},
    },
}));
// Only the two functions the planner calls; the real one reaches the market
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateMultiLevelProgress: (currentLevel, _currentXP, targetLevel, _eff, actionTime, xpPerAction) => ({
        actionsNeeded: (targetLevel - currentLevel) * 100,
        timeNeeded: (targetLevel - currentLevel) * 100 * actionTime * (xpPerAction > 0 ? 1 : 1),
    }),
}));

// The two marketplace hand-offs. Both reach the live DOM and the game's own
// panels; what this file is about is that a buy step *offers* the trip, not
// what the marketplace does when it gets there.
const shopping = vi.hoisted(() => ({ calls: [] }));
vi.mock('../actions/missing-materials-button.js', () => ({
    openMissingMaterials: (actionHrid, numActions) => shopping.calls.push({ kind: 'action', actionHrid, numActions }),
}));
vi.mock('../../utils/shopping-list.js', () => ({
    openShoppingList: (items, options) => shopping.calls.push({ kind: 'list', items, options }),
}));

// The game's own navigation, which reaches the React root
const navigation = vi.hoisted(() => ({ calls: [], answer: true }));
vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: (actionHrid) => {
        navigation.calls.push(actionHrid);
        return navigation.answer;
    },
}));

const plannerContext = vi.hoisted(() => ({ value: null, builds: 0 }));
vi.mock('./goal-planner-context.js', () => ({
    buildPlannerContext: async () => {
        plannerContext.builds += 1;
        return plannerContext.value;
    },
    withHouseCosts: async (context) => context,
    coinsHeld: () => 50_000_000,
}));

const { goalPlannerPanel } = await import('./goal-planner-ui.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => document.getElementById('toolasha-goal-planner-panel')?.textContent ?? '';

/**
 * A context that can answer every goal the test asks for.
 * @returns {Object} A planning context
 */
function fixtureContext() {
    return {
        now: 1_700_000_000_000,
        gold: 50_000_000,
        levelExperienceTable: Array.from({ length: 201 }, (_, level) => level * 1000),
        pricingNote: 'Priced at 10:00.',
        itemName: () => 'Sinister Cape',
        skillName: () => 'Enhancing',
        houseRoomName: () => 'Observatory',
        skill: () => ({ level: 90, experience: 90_000 }),
        owned: () => 0,
        ownedEnhancementLevel: () => -1,
        houseLevel: () => 6,
        goldRates: () => [{ label: 'Milking: Cow', goldPerHour: 4_000_000, actionHrid: '/actions/milking/cow' }],
        xpRates: () => [
            {
                label: 'Cheese Sword +0 → +5',
                requiredLevel: 1,
                xpPerHour: 500_000,
                xpPerAction: 250,
                actionTime: 10,
                totalEfficiency: 0,
                flatRate: true,
                goldPerHour: -1_000_000,
            },
        ],
        acquire: () => ({
            strategy: 'buy',
            totalCost: 12_000_000,
            unitCost: 12_000_000,
            buyPrice: 12_000_000,
            craftCost: 15_000_000,
            requires: [],
        }),
        enhance: () => ({
            attempts: 41.3,
            totalTimeSeconds: 3600,
            materialCost: 30_000_000,
            protectionCost: 5_000_000,
            protectionCount: 3,
            protectFrom: 4,
            baseCost: 12_000_000,
            totalCost: 47_000_000,
            materialBill: [
                {
                    itemHrid: '/items/mystical_charm',
                    name: 'Mystical Charm',
                    count: 41.3,
                    unitPrice: 700_000,
                    totalCost: 28_910_000,
                    kind: 'material',
                },
                {
                    itemHrid: '/items/mirror_of_protection',
                    name: 'Mirror of Protection',
                    count: 2.4,
                    unitPrice: 2_000_000,
                    totalCost: 4_800_000,
                    kind: 'protection',
                },
            ],
        }),
        houseCost: () => ({
            coins: 20_000_000,
            totalValue: 60_000_000,
            materials: [
                { itemHrid: '/items/log', name: 'Log', count: 500, marketPrice: 80_000, totalValue: 40_000_000 },
            ],
        }),
    };
}

beforeEach(() => {
    character.id = 'char1';
    ledger.enabled = false;
    ledger.reserved = [];
    ledger.swept = [];
    ledger.onSweep = null;
    shopping.calls = [];
    navigation.calls = [];
    navigation.answer = true;
    plannerContext.builds = 0;
    store.data = {
        goalPlannerGoals_char1: [
            { id: 'g-gold', type: 'gold', amount: 500_000_000 },
            { id: 'g-cape', type: 'equipment', itemHrid: '/items/sinister_cape', enhancementLevel: 10 },
            { id: 'g-enh', type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 110 },
            { id: 'g-obs', type: 'house', roomHrid: '/house_rooms/observatory', targetLevel: 8 },
        ],
    };
    plannerContext.value = fixtureContext();
});

afterEach(() => {
    // A panel remembers which form was open between openings, which is right
    // for a panel and wrong for a test
    goalPlannerPanel.hide({ remember: false });
    goalPlannerPanel.formType = null;
    goalPlannerPanel.goals = [];
    goalPlannerPanel.plans = [];
    goalPlannerPanel.pricedAt = null;
    goalPlannerPanel.loaded = null;
    goalPlannerPanel.context = null;
    goalPlannerPanel.notice = null;
});

describe('drawing a plan', () => {
    test('every goal type renders without a section failing', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('Goal Planner');
        expect(text()).toContain('Have 500.0M coins');
        expect(text()).toContain('Own Sinister Cape +10');
        expect(text()).toContain('Enhancing 110');
        expect(text()).toContain('Observatory 8');
    });

    test('the steps of a plan are on screen, in order, with their bill', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        const body = text();
        expect(body).toContain('Buy Sinister Cape');
        expect(body).toContain('Enhance Sinister Cape +0 → +10');
        // Spending 47M against 50M held needs no grind first; the house goal does
        expect(body).toContain('Earn');
        expect(body).toContain('Priced at 10:00.');
    });

    test('a satisfied step is struck through rather than dropped', async () => {
        plannerContext.value.ownedEnhancementLevel = () => 0;
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).toContain('Already hold Sinister Cape');
        const struck = [...document.querySelectorAll('#toolasha-goal-planner-panel *')].some(
            (element) => element.style.textDecoration === 'line-through'
        );
        expect(struck).toBe(true);
    });

    test('a context that answers nothing still draws every goal', async () => {
        // Everything absent is the ordinary state before the market has loaded,
        // and it must degrade to warnings rather than to a blank panel
        plannerContext.value = { gold: 0, levelExperienceTable: null };
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain('⚠');
    });
});

describe('the character-switch boundary', () => {
    test('disable clears the priced context and plans, so the next character does not inherit them', async () => {
        // Build up everything a priced session accumulates
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(goalPlannerPanel.context).not.toBeNull();
        expect(goalPlannerPanel.plans.length).toBeGreaterThan(0);
        expect(goalPlannerPanel.pricedAt).not.toBeNull();

        // feature-registry calls this on every character_switching event
        goalPlannerPanel.disable();

        // A context still in hand would let the next replan() (add/remove a
        // goal without a Refresh) quote a new goal against this character's
        // ranked income and cached prices instead of the next one's
        expect(goalPlannerPanel.context).toBeNull();
        expect(goalPlannerPanel.plans).toEqual([]);
        expect(goalPlannerPanel.rateNotes).toEqual([]);
        expect(goalPlannerPanel.combatStatus).toBeNull();
        expect(goalPlannerPanel.pricedAt).toBeNull();
    });

    test('a replan after disable prices a fresh context rather than reusing the old one', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();
        expect(plannerContext.builds).toBe(1);

        goalPlannerPanel.disable();
        goalPlannerPanel.goals = [];
        await goalPlannerPanel.addGoal({ type: 'gold', amount: 1 });

        // Without a context in hand, replan() has to reprice rather than reuse
        expect(plannerContext.builds).toBe(2);
    });

    test('a switch during the reservation write leaves no claim under the arriving character', async () => {
        ledger.enabled = true;
        // The switch lands inside the orphan sweep — after replan() checked
        // `gone()` for the snapshot, before a single claim has been written
        ledger.onSweep = () => {
            character.id = 'char2';
        };

        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(ledger.swept).toHaveLength(1);
        expect(ledger.reserved).toEqual([]);
    });

    test('removing a goal before anything is priced does not write under whoever switches in mid-removal', async () => {
        // No refresh yet: `this.context` is null, so removeGoal() takes the
        // early-return branch that saves the snapshot itself instead of
        // handing off to replan(). char2 has never had a snapshot of its own.
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        expect(goalPlannerPanel.context).toBeNull();

        const removal = goalPlannerPanel.removeGoal('g-gold');
        // The switch lands after removeGoal() has read `getCurrentCharacterId()`
        // for its own owner check but before the store round trip resolves —
        // the same window `replan()` guards with its own captured `owner`.
        character.id = 'char2';
        await removal;

        expect(store.data.goalPlannerSnapshot_char2).toBeUndefined();
        // char1's own list is untouched too: the store-level guard already
        // aborted the removal itself once it saw the switch
        expect(store.data.goalPlannerGoals_char1).toHaveLength(4);
    });
});

describe('a step that says buy can go and buy', () => {
    /**
     * Click a button by its label, on the step whose text contains `within`.
     * @param {string} label - Button text
     * @param {string} [within] - Text the step row must contain
     * @returns {boolean} Whether one was found
     */
    function press(label, within = '') {
        const found = [...document.querySelectorAll('#toolasha-goal-planner-panel button')].find(
            (element) =>
                element.textContent === label && (!within || element.parentElement?.textContent.includes(within))
        );
        found?.click();
        return Boolean(found);
    }

    test('house materials go across as a shopping list of what is missing', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        // Named by the room rather than by the word "material": the enhance step
        // says "in materials" too, and now has a Buy button of its own
        expect(press('Buy', 'Observatory')).toBe(true);
        const list = shopping.calls.find((call) => call.kind === 'list');
        expect(list.items).toEqual([{ itemHrid: '/items/log', name: 'Log', count: 500 }]);
    });

    test('a single purchase goes the same way, named and counted', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy', 'Buy Sinister Cape')).toBe(true);
        expect(shopping.calls[0].items).toEqual([
            { itemHrid: '/items/sinister_cape', name: 'Sinister Cape', count: 1 },
        ]);
    });

    test('a craft hands the action to the missing-materials machinery', async () => {
        plannerContext.value.acquire = () => ({
            strategy: 'craft',
            totalCost: 9_000_000,
            craftCost: 9_000_000,
            buyPrice: 12_000_000,
            actionHrid: '/actions/crafting/sinister_cape',
            actionsNeeded: 3,
            requires: [],
        });
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy mats')).toBe(true);
        expect(shopping.calls[0]).toEqual({
            kind: 'action',
            actionHrid: '/actions/crafting/sinister_cape',
            numActions: 3,
        });
    });

    test('an enhance step offers its expected materials, rounded up and named as an estimate', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy', 'Enhance Sinister Cape')).toBe(true);
        const list = shopping.calls.find((call) => call.kind === 'list');
        expect(list.items).toEqual([
            { itemHrid: '/items/mystical_charm', name: 'Mystical Charm', count: 42 },
            { itemHrid: '/items/mirror_of_protection', name: 'Mirror of Protection', count: 3 },
        ]);
        // The marketplace is where somebody decides how many to actually buy, so
        // the tab bar has to carry the caveat as well as the button's tooltip
        expect(list.options.heading).toContain('expected materials — enhancing is random');
    });

    test('an enhance step with no bill offers no button rather than an empty marketplace', async () => {
        const run = plannerContext.value.enhance();
        plannerContext.value.enhance = () => ({ ...run, materialBill: [] });
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy', 'Enhance Sinister Cape')).toBe(false);
    });

    test('a step that is already satisfied offers no trip to the marketplace', async () => {
        plannerContext.value.owned = () => 10_000;
        plannerContext.value.ownedEnhancementLevel = () => 10;
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(press('Buy mats')).toBe(false);
    });
});

describe('reading the plan', () => {
    test('a step is wrapped rather than cut off, so no tooltip has to cover the plan', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        const clipped = [...document.querySelectorAll('#toolasha-goal-planner-panel *')].filter(
            (element) => element.style.textOverflow === 'ellipsis'
        );
        expect(clipped).toEqual([]);
    });

    test('a method an earlier goal already spent is named under the step that lost it', async () => {
        // Two gold goals against one crossbow: the first takes it, and the second
        // has to say why it is milking cows rather than appearing to change its mind
        store.data.goalPlannerGoals_char1 = [
            { id: 'g1', type: 'gold', amount: 800_000_000 },
            { id: 'g2', type: 'gold', amount: 800_000_000 },
        ];
        plannerContext.value.goldRates = () => [
            { label: 'Milk a Cow', kind: 'gathering', goldPerHour: 10_000_000 },
            {
                label: 'Decompose Sundering Crossbow ★',
                kind: 'alchemy',
                itemHrid: '/items/sundering_crossbow',
                goldPerHour: 437_900_000_000,
                sustainable: {
                    gold: 800_000_000,
                    goldPerUnit: 800_000_000,
                    units: 1,
                    unitLabel: 'Sundering Crossbow ★',
                    verb: 'Decompose',
                },
            },
        ];
        plannerContext.value.gold = 0;

        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('could not be drawn');
        expect(text()).toContain("Sundering Crossbow ★ already spent by 'Have 800.0M coins'");
    });

    test('the pricing note is said once for the panel, not once per goal', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        const occurrences = text().split('Priced at 10:00.').length - 1;
        expect(occurrences).toBe(1);
    });

    test('the bottom line says which two figures it is the difference of', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).toContain('Left to do');
        expect(text()).toContain('earn');
        expect(text()).toContain('spend');
    });

    test('one combat loadout is not a choice, and is not offered as one', async () => {
        plannerContext.value.combatStatus = { loadoutName: 'Fighting', loadoutChoices: ['Fighting'] };
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).not.toContain('Combat rates judged against');
    });

    test('two combat loadouts are a guess, so the guess can be corrected', async () => {
        plannerContext.value.combatStatus = { loadoutName: 'Ranged', loadoutChoices: ['Fighting', 'Ranged'] };
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(text()).toContain('Combat rates judged against');
        const picker = document.querySelector('#toolasha-goal-planner-panel select');
        expect(picker.value).toBe('Ranged');
    });
});

describe('a step that names an activity can take you to it', () => {
    /**
     * Click the description of the first step whose text contains `within`.
     * @param {string} within - Text the step's description must contain
     * @returns {boolean} Whether one was found and it was clickable
     */
    function clickStep(within) {
        const found = [...document.querySelectorAll('#toolasha-goal-planner-panel span')].find((element) =>
            element.textContent.includes(within)
        );
        if (!found || found.style.cursor !== 'pointer') return false;
        found.click();
        return true;
    }

    test('a training step opens the action it was costed from', async () => {
        plannerContext.value.xpRates = () => [
            {
                actionHrid: '/actions/cheesesmithing/griffin_bulwark',
                label: 'Griffin Bulwark ★',
                requiredLevel: 1,
                xpPerHour: 500_000,
                xpPerAction: 250,
                actionTime: 10,
                totalEfficiency: 0,
                flatRate: true,
                goldPerHour: 0,
            },
        ];
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(clickStep('Train Enhancing')).toBe(true);
        expect(navigation.calls).toEqual(['/actions/cheesesmithing/griffin_bulwark']);
    });

    test('an earning step opens the action it would have you do', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(clickStep('Earn 450.0M coins')).toBe(true);
        expect(navigation.calls).toEqual(['/actions/milking/cow']);
    });

    test('an enhance step opens the enhancing screen', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(clickStep('Enhance Sinister Cape')).toBe(true);
        expect(navigation.calls).toEqual(['/actions/enhancing/enhance']);
    });

    test('a craft step opens the craft', async () => {
        plannerContext.value.acquire = () => ({
            strategy: 'craft',
            totalCost: 9_000_000,
            craftCost: 9_000_000,
            buyPrice: 12_000_000,
            actionHrid: '/actions/crafting/sinister_cape',
            actionsNeeded: 3,
            requires: [],
        });
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(clickStep('Craft Sinister Cape')).toBe(true);
        expect(navigation.calls).toEqual(['/actions/crafting/sinister_cape']);
    });

    test('a house upgrade has nowhere to go, and does not pretend to', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        expect(clickStep('Upgrade Observatory')).toBe(false);
        expect(navigation.calls).toEqual([]);
    });

    test('a game that will not navigate says so on the panel rather than silently', async () => {
        navigation.answer = false;
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();

        clickStep('Enhance Sinister Cape');
        expect(text()).toContain('would not navigate');
    });
});

describe('adding and removing a goal', () => {
    test('an added goal is planned and on screen without pressing Refresh', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();
        const pricedBuilds = plannerContext.builds;

        await goalPlannerPanel.addGoal({ type: 'gold', amount: 900_000_000 });

        expect(text()).toContain('Have 900.0M coins');
        expect(text()).not.toContain('Not priced yet');
        // and it did not go back to the market to do it
        expect(plannerContext.builds).toBe(pricedBuilds);
    });

    test('a goal added before anything was priced prices once, rather than showing nothing', async () => {
        store.data = {};
        goalPlannerPanel.show();
        await goalPlannerPanel.load();

        await goalPlannerPanel.addGoal({ type: 'gold', amount: 900_000_000 });

        expect(plannerContext.builds).toBe(1);
        expect(text()).toContain('Have 900.0M coins');
        expect(text()).not.toContain('Not priced yet');
    });

    test('removing a goal gives its windfall back to the goal below it', async () => {
        // Two gold goals against one crossbow: the first has it, the second is
        // milking cows and saying so. Remove the first and the second should
        // claim it — which only happens if the ledger is run again.
        store.data.goalPlannerGoals_char1 = [
            { id: 'g1', type: 'gold', amount: 800_000_000 },
            { id: 'g2', type: 'gold', amount: 800_000_000 },
        ];
        plannerContext.value.gold = 0;
        plannerContext.value.goldRates = () => [
            { label: 'Milk a Cow', kind: 'gathering', goldPerHour: 10_000_000, actionHrid: '/actions/milking/cow' },
            {
                label: 'Decompose Sundering Crossbow ★',
                kind: 'alchemy',
                itemHrid: '/items/sundering_crossbow',
                goldPerHour: 437_900_000_000,
                sustainable: {
                    gold: 800_000_000,
                    goldPerUnit: 800_000_000,
                    units: 1,
                    unitLabel: 'Sundering Crossbow ★',
                    verb: 'Decompose',
                },
            },
        ];

        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();
        expect(text()).toContain('already spent by');

        await goalPlannerPanel.removeGoal('g1');

        expect(text()).not.toContain('already spent by');
        expect(text()).toContain('Decompose 1 Sundering Crossbow ★');
        // Reallocating did not cost a trip to the market either
        expect(plannerContext.builds).toBe(1);
    });

    test('a replan that fails says so, and the redraw does not wipe the message', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        plannerContext.value = null;
        await goalPlannerPanel.refresh();

        // The message used to be written to the header and then overwritten by
        // the redraw in the same tick, so a failed refresh looked like a
        // successful one that found nothing
        expect(text()).toContain('Pricing failed');
    });

    test('removing before anything was priced says what to press rather than pricing', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();

        await goalPlannerPanel.removeGoal('g-obs');

        expect(plannerContext.builds).toBe(0);
        expect(text()).toContain('press Refresh');
    });
});

describe('the goal list', () => {
    test('an empty list says so instead of drawing nothing', async () => {
        store.data = {};
        goalPlannerPanel.show();
        await goalPlannerPanel.load();

        expect(text()).toContain('No goals yet');
    });

    test('every goal type offers a creation form that draws', async () => {
        goalPlannerPanel.show();
        await settled();

        for (const type of ['gold', 'equipment', 'skill', 'house']) {
            goalPlannerPanel.formType = type;
            goalPlannerPanel._render();
            expect(text()).not.toContain('could not be drawn');
            expect(document.querySelectorAll(`#${'toolasha-goal-planner-panel'} input`).length).toBeGreaterThan(0);
        }
    });

    test('removing a goal takes its plan with it', async () => {
        goalPlannerPanel.show();
        await goalPlannerPanel.load();
        await goalPlannerPanel.refresh();
        expect(text()).toContain('Observatory 8');

        await goalPlannerPanel.removeGoal('g-obs');

        expect(text()).not.toContain('Observatory 8');
        expect(text()).toContain('Have 500.0M coins');
    });
});

describe('whether the panel was open', () => {
    test('opening it is remembered, and closing it is', async () => {
        const { wasOpen } = await import('../../utils/panel-geometry.js');

        goalPlannerPanel.show();
        await settled();
        await expect(wasOpen('goalPlannerPanel')).resolves.toBe(true);

        goalPlannerPanel.hide();
        await settled();
        await expect(wasOpen('goalPlannerPanel')).resolves.toBe(false);
    });
});
