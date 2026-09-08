/**
 * What the planner decides, given what it is told.
 *
 * Every test here builds its own context, which is the point of the engine
 * taking one: the interesting behaviour is a *choice between costed options*,
 * and a choice can only be tested when the fixture can move the prices. "Buying
 * is cheaper" and "crafting is cheaper" are the same code twice.
 *
 * The enhancement figures are pulled through the real Markov calculator rather
 * than typed in, so a change to the chain shows up here as a changed plan rather
 * than as a plan that quietly disagrees with every other surface in the script.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import {
    planGoal,
    planGoals,
    normalizeGoal,
    orderSteps,
    summarize,
    planEarnings,
    describeLeg,
    sustainableGold,
    createResourceLedger,
    reservationLines,
    GOAL_TYPES,
} from './goal-planner.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

/** A level table where each level costs 1,000 more experience than the last */
const LEVEL_TABLE = Array.from({ length: 201 }, (_, level) => level * 1000);

/**
 * A context with nothing in it, so each test only states what it cares about.
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object} A planning context
 */
function context(overrides = {}) {
    return {
        now: 1_700_000_000_000,
        gold: 0,
        levelExperienceTable: LEVEL_TABLE,
        itemName: (hrid) => hrid.split('/').pop(),
        skillName: (hrid) =>
            hrid
                .split('/')
                .pop()
                .replace(/^./, (letter) => letter.toUpperCase()),
        houseRoomName: (hrid) => hrid.split('/').pop(),
        skill: () => ({ level: 1, experience: 0 }),
        owned: () => 0,
        ownedEnhancementLevel: () => -1,
        houseLevel: () => 0,
        goldRates: () => [],
        xpRates: () => [],
        acquire: () => null,
        enhance: () => null,
        houseCost: () => null,
        ...overrides,
    };
}

/**
 * @param {Object} plan - A plan
 * @param {string} id - A step id
 * @returns {Object|undefined} That step
 */
const step = (plan, id) => plan.steps.find((entry) => entry.id === id);

describe('normalizeGoal', () => {
    test('names every type it can plan', () => {
        expect(Object.keys(GOAL_TYPES).sort()).toEqual(['equipment', 'gold', 'house', 'skill']);
    });

    test('rejects a goal it cannot plan rather than half-building it', () => {
        expect(normalizeGoal({ type: 'gold', amount: 0 })).toBeNull();
        expect(normalizeGoal({ type: 'equipment' })).toBeNull();
        expect(normalizeGoal({ type: 'nonsense', amount: 5 })).toBeNull();
        expect(normalizeGoal(null)).toBeNull();
    });

    test('clamps an enhancement level to what the game allows', () => {
        expect(normalizeGoal({ type: 'equipment', itemHrid: '/items/x', enhancementLevel: 99 }).enhancementLevel).toBe(
            20
        );
    });
});

describe('a gold target', () => {
    test('picks the best of the rates it is given', () => {
        const plan = planGoal(
            { type: 'gold', amount: 500_000_000 },
            context({
                gold: 100_000_000,
                goldRates: () => [
                    { label: 'Slow', goldPerHour: 1_000_000 },
                    { label: 'Fast', goldPerHour: 4_000_000 },
                    { label: 'Middling', goldPerHour: 2_000_000 },
                ],
            })
        );

        const earn = step(plan, 'earn');
        expect(earn.details.rate.label).toBe('Fast');
        expect(earn.goldDelta).toBe(400_000_000);
        expect(earn.timeHours).toBeCloseTo(100, 6);
        expect(earn.description).toContain('Fast');
    });

    test('ranks all four sources of income against each other and takes the winner', () => {
        // One rate per provider, in the shape each of them hands over
        const fromEveryProvider = [
            { actionHrid: '/actions/milking/cow', label: 'Milk a Cow', goldPerHour: 900_000, kind: 'gathering' },
            { actionHrid: '/actions/cooking/stew', label: 'Cook Stew', goldPerHour: 1_400_000, kind: 'production' },
            {
                actionHrid: '/actions/alchemy/transmute',
                label: 'Transmute Ore',
                goldPerHour: 1_800_000,
                kind: 'alchemy',
            },
            {
                actionHrid: '/actions/combat/fly',
                label: 'Fly Zone T2 — from your all-zones run 3d ago',
                goldPerHour: 2_100_000,
                kind: 'combat',
            },
        ];

        const plan = planGoal(
            { type: 'gold', amount: 21_000_000 },
            context({ gold: 0, goldRates: () => fromEveryProvider })
        );

        const earn = step(plan, 'earn');
        expect(earn.details.rate.kind).toBe('combat');
        expect(earn.timeHours).toBeCloseTo(10, 6);
        // And the losers stay on the card as alternatives, best first
        expect(earn.details.alternatives.map((rate) => rate.kind)).toEqual([
            'combat',
            'alchemy',
            'production',
            'gathering',
        ]);
    });

    test('picks alchemy when alchemy is what wins', () => {
        const plan = planGoal(
            { type: 'gold', amount: 12_000_000 },
            context({
                gold: 0,
                goldRates: () => [
                    { label: 'Milk a Cow', goldPerHour: 900_000, kind: 'gathering' },
                    { label: 'Transmute Ore', goldPerHour: 3_000_000, kind: 'alchemy' },
                ],
            })
        );

        const earn = step(plan, 'earn');
        expect(earn.description).toContain('Transmute Ore');
        expect(earn.timeHours).toBeCloseTo(4, 6);
    });

    test('ignores a provider that offered nothing, rather than quoting a zero rate', () => {
        // What a character with no all-zones run and no profitable alchemy sees
        const plan = planGoal(
            { type: 'gold', amount: 2_000_000 },
            context({
                gold: 0,
                goldRates: () => [
                    { label: 'Milk a Cow', goldPerHour: 500_000, kind: 'gathering' },
                    { label: 'Transmute Ore', goldPerHour: 0, kind: 'alchemy' },
                ],
            })
        );

        const earn = step(plan, 'earn');
        expect(earn.details.rate.kind).toBe('gathering');
        expect(earn.details.alternatives).toHaveLength(1);
        expect(earn.timeHours).toBeCloseTo(4, 6);
    });

    test('a target already met comes back done, with nothing left to do', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 250 }));

        expect(plan.satisfied).toBe(true);
        expect(step(plan, 'earn').done).toBe(true);
        expect(plan.totals.timeHours).toBe(0);
        expect(plan.totals.stepsDone).toBe(1);
    });

    test('says so when there is no rate to measure against', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 0 }));

        expect(step(plan, 'earn').timeHours).toBeNull();
        expect(plan.warnings.join(' ')).toContain('No earning rate');
    });
});

describe('a rate is only a rate while its inputs last', () => {
    /** The bug in one object: one crossbow, decomposed, at a fantasy hourly rate */
    const crossbow = {
        label: 'Decompose Sundering Crossbow ★',
        kind: 'alchemy',
        goldPerHour: 437_900_000_000,
        sustainable: {
            gold: 851_200_000,
            goldPerUnit: 851_200_000,
            units: 1,
            unitLabel: 'Sundering Crossbow ★',
            verb: 'Decompose',
            source: 'inventory',
        },
    };
    const milking = { label: 'Milk a Cow', kind: 'gathering', goldPerHour: 12_400_000 };

    test('a rate with no ceiling is unbounded, which is the default', () => {
        expect(sustainableGold(milking)).toBe(Infinity);
        expect(sustainableGold({ sustainable: { unbounded: true } })).toBe(Infinity);
        expect(sustainableGold(crossbow)).toBe(851_200_000);
    });

    test('an absent ceiling is unbounded, not zero — Number(null) must not zero the rate', () => {
        // A cap that says nothing about gold limits nothing. Coercing null to 0
        // silently removed the rate from the ranking altogether.
        expect(sustainableGold({ sustainable: { gold: null, unitLabel: 'Ore' } })).toBe(Infinity);
        expect(sustainableGold({ sustainable: { unitLabel: 'Ore' } })).toBe(Infinity);
        // A measured empty stack is a real zero and stays one
        expect(sustainableGold({ sustainable: { gold: 0 } })).toBe(0);
    });

    test('the windfall is taken once, and the rest is earned honestly', () => {
        const { legs, hours, covered } = planEarnings([milking, crossbow], 903_400_000);

        expect(legs).toHaveLength(2);
        expect(legs[0].rate.label).toBe('Decompose Sundering Crossbow ★');
        expect(legs[0].gold).toBe(851_200_000);
        expect(legs[0].units).toBe(1);
        expect(legs[0].oneOff).toBe(true);

        expect(legs[1].rate.label).toBe('Milk a Cow');
        expect(legs[1].gold).toBe(903_400_000 - 851_200_000);
        expect(legs[1].oneOff).toBe(false);

        // Seven seconds of crossbow plus four hours of cow, not seven seconds
        expect(hours).toBeCloseTo(851_200_000 / 437_900_000_000 + 52_200_000 / 12_400_000, 6);
        expect(covered).toBe(true);
    });

    test('the step says what you actually do, not a per-hour figure nobody can earn', () => {
        const plan = planGoal(
            { type: 'gold', amount: 903_400_000 },
            context({ gold: 0, goldRates: () => [milking, crossbow] })
        );

        const earn = step(plan, 'earn');
        expect(earn.description).toContain('Decompose 1 Sundering Crossbow ★ (+851.2M one-off)');
        expect(earn.description).toContain('Milk a Cow at 12.4M/hr');
        // The number that started all this is nowhere on the step
        expect(earn.description).not.toContain('437.9B');
    });

    test('a windfall that covers the whole target on its own is still a windfall', () => {
        // The screenshot bug. One charm stack worth more than the goal needs, so
        // the leg never exhausts it and there is no fallback leg behind it — and
        // the step read "Master Tailoring Charm at 134.3B/hr" beside "24s".
        const charms = {
            label: 'Decompose Master Tailoring Charm',
            kind: 'alchemy',
            goldPerHour: 134_300_000_000,
            sustainable: {
                gold: 1_200_000_000,
                goldPerUnit: 40_000_000,
                units: 30,
                unitLabel: 'Master Tailoring Charm',
                verb: 'Decompose',
            },
        };

        const { legs } = planEarnings([charms], 877_900_000);

        expect(legs).toHaveLength(1);
        expect(legs[0].exhausts).toBe(false);
        expect(legs[0].oneOff).toBe(true);
        expect(describeLeg(legs[0])).toBe('Decompose 22 Master Tailoring Charm (+877.9M one-off)');
    });

    test('and says so on the step, whichever kind of goal asked for it', () => {
        const charms = {
            label: 'Decompose Master Tailoring Charm',
            kind: 'alchemy',
            goldPerHour: 134_300_000_000,
            sustainable: {
                gold: 1_200_000_000,
                goldPerUnit: 40_000_000,
                units: 30,
                unitLabel: 'Master Tailoring Charm',
                verb: 'Decompose',
            },
        };

        const gold = planGoal({ type: 'gold', amount: 500_000_000 }, context({ gold: 0, goldRates: () => [charms] }));
        expect(step(gold, 'earn').description).toContain('one-off');
        expect(step(gold, 'earn').description).not.toContain('/hr');

        const funded = planGoal(
            { type: 'equipment', itemHrid: '/items/cape', enhancementLevel: 0 },
            context({
                gold: 0,
                goldRates: () => [charms],
                acquire: () => ({ strategy: 'buy', totalCost: 877_900_000, buyPrice: 877_900_000, requires: [] }),
            })
        );
        expect(step(funded, 'fund').description).toContain('(+877.9M one-off)');
        expect(step(funded, 'fund').description).not.toContain('/hr');
    });

    test('a ceiling that outlasts an hour is still an income, and is quoted as one', () => {
        const ore = {
            label: 'Transmute Ore',
            goldPerHour: 30_000_000,
            sustainable: { gold: 90_000_000, goldPerUnit: 3_000, units: 30_000, unitLabel: 'Ore', verb: 'Transmute' },
        };
        const { legs } = planEarnings([ore, milking], 120_000_000);

        expect(legs[0].oneOff).toBe(false);
        expect(legs[0].hours).toBeCloseTo(3, 6);
        expect(describeLeg(legs[0])).toBe('Transmute Ore at 30.0M/hr, for 90.0M');
        expect(legs[1].rate.label).toBe('Milk a Cow');
    });

    test('an uncapped method covers the remainder in one leg, whatever is below it', () => {
        const { legs } = planEarnings([crossbow, milking, { label: 'Slow', goldPerHour: 1 }], 5_000_000_000);
        expect(legs.map((leg) => leg.rate.label)).toEqual(['Decompose Sundering Crossbow ★', 'Milk a Cow']);
    });

    test('a stack that has run out is not offered at all', () => {
        const empty = { ...crossbow, sustainable: { ...crossbow.sustainable, gold: 0, units: 0 } };
        const plan = planGoal(
            { type: 'gold', amount: 10_000_000 },
            context({ gold: 0, goldRates: () => [empty, milking] })
        );

        const earn = step(plan, 'earn');
        expect(earn.details.rate.label).toBe('Milk a Cow');
        expect(earn.details.alternatives.map((rate) => rate.label)).toEqual(['Milk a Cow']);
    });

    test('when nothing can cover the target the plan says so rather than inventing time', () => {
        const { covered, gold, hours } = planEarnings([crossbow], 2_000_000_000);
        expect(covered).toBe(false);
        expect(gold).toBe(851_200_000);
        expect(hours).toBeNull();

        const plan = planGoal(
            { type: 'gold', amount: 2_000_000_000 },
            context({ gold: 0, goldRates: () => [crossbow] })
        );
        expect(step(plan, 'earn').timeHours).toBeNull();
        expect(plan.warnings.join(' ')).toContain('run out of what they consume');
    });

    test('the same ceiling applies to the funding a purchase needs', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: '/items/cape', enhancementLevel: 0 },
            context({
                gold: 0,
                goldRates: () => [milking, crossbow],
                acquire: () => ({ strategy: 'buy', totalCost: 900_000_000, buyPrice: 900_000_000, requires: [] }),
            })
        );

        const fund = step(plan, 'fund');
        expect(fund.details.legs.map((leg) => leg.oneOff)).toEqual([true, false]);
        expect(fund.description).toContain('one-off');
    });
});

describe('one bagful, shared between the goals', () => {
    /** The bug in one object: one crossbow, decomposed, at a fantasy hourly rate */
    const crossbow = () => ({
        label: 'Decompose Sundering Crossbow ★',
        kind: 'alchemy',
        actionHrid: '/actions/alchemy/decompose',
        itemHrid: '/items/sundering_crossbow',
        goldPerHour: 437_900_000_000,
        sustainable: {
            gold: 800_000_000,
            goldPerUnit: 800_000_000,
            units: 1,
            unitLabel: 'Sundering Crossbow ★',
            verb: 'Decompose',
            source: 'inventory',
        },
    });
    const milking = { label: 'Milk a Cow', kind: 'gathering', goldPerHour: 10_000_000 };

    /**
     * @param {Object} plan - A plan
     * @returns {Object|undefined} Whichever step does this plan's earning
     */
    const earning = (plan) => plan.steps.find((entry) => entry.kind === 'earn');

    test('the first goal takes the crossbow and the second plans without it', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'gold', amount: 800_000_000 },
                { id: 'b', type: 'gold', amount: 800_000_000 },
            ],
            context({ gold: 0, goldRates: () => [milking, crossbow()] })
        );

        expect(earning(plans[0]).details.legs[0].rate.label).toContain('Sundering Crossbow');
        // Second goal: the stack is gone, so it falls through to the next-best
        // method exactly as it would if the bag had been empty to begin with
        expect(earning(plans[1]).details.legs.map((leg) => leg.rate.label)).toEqual(['Milk a Cow']);
        expect(earning(plans[1]).timeHours).toBeCloseTo(80, 6);
    });

    test('and says who took it, rather than quietly showing a worse rate', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'skill', skillHrid: '/skills/cheesesmithing', targetLevel: 108 },
                { id: 'b', type: 'gold', amount: 800_000_000 },
            ],
            context({
                gold: 0,
                skill: () => ({ level: 100, experience: 100_000 }),
                xpRates: () => [
                    {
                        label: 'Cheese',
                        requiredLevel: 1,
                        xpPerHour: 1000,
                        xpPerAction: 100,
                        actionTime: 10,
                        totalEfficiency: 0,
                        // Dear enough that funding the grind eats the whole crossbow
                        goldPerHour: -8_000_000_000,
                    },
                ],
                goldRates: () => [milking, crossbow()],
            })
        );

        expect(plans[0].title).toBe('Cheesesmithing 108');
        const notes = earning(plans[1]).details.ledgerNotes;
        expect(notes).toContain("Sundering Crossbow ★ already spent by 'Cheesesmithing 108'");
    });

    test('a stack only partly spent leaves the rest, and says how much', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'gold', amount: 300_000_000 },
                { id: 'b', type: 'gold', amount: 800_000_000 },
            ],
            context({ gold: 0, goldRates: () => [milking, crossbow()] })
        );

        const legs = earning(plans[1]).details.legs;
        expect(legs[0].rate.label).toContain('Sundering Crossbow');
        expect(legs[0].gold).toBe(500_000_000);
        expect(earning(plans[1]).details.ledgerNotes.join(' ')).toContain('partly spent');
    });

    test('coins in hand are spent once, so the second goal has to earn them', () => {
        const acquire = () => ({ strategy: 'buy', totalCost: 40_000_000, buyPrice: 40_000_000, requires: [] });
        const plans = planGoals(
            [
                { id: 'a', type: 'equipment', itemHrid: '/items/cape', enhancementLevel: 0 },
                { id: 'b', type: 'equipment', itemHrid: '/items/boots', enhancementLevel: 0 },
            ],
            context({ gold: 50_000_000, acquire, goldRates: () => [milking] })
        );

        // 50M covers the first cape outright
        expect(plans[0].steps.map((entry) => entry.id)).not.toContain('fund');
        // 10M left, so the second is 30M short rather than fully funded
        const fund = plans[1].steps.find((entry) => entry.id === 'fund');
        expect(fund.goldDelta).toBe(30_000_000);
        expect(fund.details.ledgerNotes.join(' ')).toContain('already committed');
    });

    test('a gold goal holds its coins rather than lending them to the goal below', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'gold', amount: 500_000_000 },
                { id: 'b', type: 'equipment', itemHrid: '/items/cape', enhancementLevel: 0 },
            ],
            context({
                gold: 50_000_000,
                acquire: () => ({ strategy: 'buy', totalCost: 40_000_000, buyPrice: 40_000_000, requires: [] }),
                goldRates: () => [milking],
            })
        );

        // You cannot both keep 500M and spend 40M of it on a cape
        expect(plans[1].steps.find((entry) => entry.id === 'fund').goldDelta).toBe(40_000_000);
    });

    test('an unbounded method is never claimed, because nothing runs out', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'gold', amount: 100_000_000 },
                { id: 'b', type: 'gold', amount: 100_000_000 },
            ],
            context({ gold: 0, goldRates: () => [milking] })
        );

        expect(earning(plans[0]).timeHours).toBeCloseTo(10, 6);
        expect(earning(plans[1]).timeHours).toBeCloseTo(10, 6);
        expect(earning(plans[1]).details.ledgerNotes).toEqual([]);
    });

    test('a satisfied goal claims nothing it does not need', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'gold', amount: 1000 },
                { id: 'b', type: 'gold', amount: 800_000_000 },
            ],
            context({ gold: 1_000_000, goldRates: () => [milking, crossbow()] })
        );

        expect(plans[0].satisfied).toBe(true);
        // The satisfied goal did no earning, so the crossbow is still there
        expect(earning(plans[1]).details.legs[0].rate.label).toContain('Sundering Crossbow');
    });

    test('planning one goal on its own is unchanged — the ledger is a property of the list', () => {
        const alone = planGoal(
            { type: 'gold', amount: 800_000_000 },
            context({ gold: 0, goldRates: () => [crossbow()] })
        );
        expect(step(alone, 'earn').details.legs[0].gold).toBe(800_000_000);
    });

    test('the rate list is decorated once per goal, not once per provider call', () => {
        // The ledger costs one pass over the rates per goal. If it were per call
        // it would scale with however many places happen to ask, which is the
        // kind of cost that grows silently as the planners gain steps.
        let calls = 0;
        const rates = [milking, crossbow()];
        planGoals(
            [
                { id: 'a', type: 'equipment', itemHrid: '/items/cape', enhancementLevel: 0 },
                { id: 'b', type: 'equipment', itemHrid: '/items/boots', enhancementLevel: 0 },
            ],
            context({
                gold: 0,
                acquire: () => ({ strategy: 'buy', totalCost: 1_000_000_000, buyPrice: 1_000_000_000, requires: [] }),
                goldRates: () => {
                    calls += 1;
                    return rates;
                },
            })
        );

        expect(calls).toBe(2);
    });
});

describe('a method you cannot start is not a recommendation', () => {
    const transmute = {
        label: 'Transmute Ore',
        kind: 'alchemy',
        actionHrid: '/actions/alchemy/transmute',
        goldPerHour: 80_000_000,
        // What one action costs to begin: the catalyst and the drinks
        upfrontCost: 12_000_000,
    };
    const milking = { label: 'Milk a Cow', kind: 'gathering', goldPerHour: 10_000_000, upfrontCost: 0 };

    test('a rate that costs more to start than you hold is not offered', () => {
        const plan = planGoal(
            { type: 'gold', amount: 500_000_000 },
            context({ gold: 3_000_000, goldRates: () => [transmute, milking] })
        );

        // planGoal on its own has no ledger, so the filter has to live somewhere
        // both paths reach — it does, in the ledger's view, which planGoals uses
        expect(step(plan, 'earn').details.rate.label).toBe('Transmute Ore');
    });

    test('planned as a list, it is excluded and says what it needed', () => {
        const [plan] = planGoals(
            [{ id: 'g', type: 'gold', amount: 500_000_000 }],
            context({ gold: 3_000_000, goldRates: () => [transmute, milking] })
        );

        const earn = step(plan, 'earn');
        expect(earn.details.rate.label).toBe('Milk a Cow');
        expect(earn.details.alternatives.map((rate) => rate.label)).toEqual(['Milk a Cow']);
        expect(earn.details.ledgerNotes).toContain('Transmute Ore needs ~12.0M upfront to start — you have 3.0M');
    });

    test('and comes back the moment the coins are there', () => {
        const [plan] = planGoals(
            [{ id: 'g', type: 'gold', amount: 500_000_000 }],
            context({ gold: 12_000_000, goldRates: () => [transmute, milking] })
        );

        expect(step(plan, 'earn').details.rate.label).toBe('Transmute Ore');
        expect(step(plan, 'earn').details.ledgerNotes).toEqual([]);
    });

    test('a goal above can spend the coins out from under it', () => {
        const plans = planGoals(
            [
                { id: 'a', type: 'equipment', itemHrid: '/items/cape', enhancementLevel: 0 },
                { id: 'b', type: 'gold', amount: 500_000_000 },
            ],
            context({
                gold: 12_000_000,
                acquire: () => ({ strategy: 'buy', totalCost: 11_000_000, buyPrice: 11_000_000, requires: [] }),
                goldRates: () => [transmute, milking],
            })
        );

        // The cape eats 11M of the 12M, so the second goal can no longer start
        // the method the first goal could — the same ledger, a different cap
        const earn = step(plans[1], 'earn');
        expect(earn.details.rate.label).toBe('Milk a Cow');
        expect(earn.details.ledgerNotes.join(' ')).toContain('needs ~12.0M upfront to start — you have 1.0M');
    });

    test('a method that needs nothing upfront is never blocked', () => {
        const [plan] = planGoals(
            [{ id: 'g', type: 'gold', amount: 500_000_000 }],
            context({ gold: 0, goldRates: () => [milking] })
        );

        expect(step(plan, 'earn').details.rate.label).toBe('Milk a Cow');
        expect(step(plan, 'earn').details.ledgerNotes).toEqual([]);
    });

    test('a rate that says nothing about capital is taken at its word', () => {
        // Combat rates come from a saved simulation and carry no input cost
        const [plan] = planGoals(
            [{ id: 'g', type: 'gold', amount: 500_000_000 }],
            context({ gold: 0, goldRates: () => [{ label: 'Fly Zone T2', kind: 'combat', goldPerHour: 20_000_000 }] })
        );

        expect(step(plan, 'earn').details.rate.label).toBe('Fly Zone T2');
    });
});

describe('a bound the rate was already reduced by is said beside it', () => {
    test('a throttled leg names the market volume that throttled it', () => {
        const charm = {
            label: 'Decompose Master Tailoring Charm',
            kind: 'alchemy',
            goldPerHour: 1_200_000,
            limits: [{ kind: 'volume', note: 'limited by market volume (~1/week)' }],
            sustainable: {
                gold: 200_000_000,
                goldPerUnit: 40_000_000,
                units: 5,
                unitLabel: 'Master Tailoring Charm',
                verb: 'Decompose',
            },
        };

        const plan = planGoal({ type: 'gold', amount: 100_000_000 }, context({ gold: 0, goldRates: () => [charm] }));

        // A reader who knows this method is worth billions will assume the
        // planner is broken unless it says what it took off
        expect(step(plan, 'earn').description).toContain('limited by market volume (~1/week)');
    });
});

describe('createResourceLedger', () => {
    const stack = {
        label: 'Transmute Ore',
        kind: 'alchemy',
        itemHrid: '/items/ore',
        goldPerHour: 30_000_000,
        sustainable: { gold: 90_000_000, goldPerUnit: 3000, units: 30_000, unitLabel: 'Ore', verb: 'Transmute' },
    };

    test('an untouched ledger hands the context straight through', () => {
        const ledger = createResourceLedger(1000);
        const view = ledger.view(context({ gold: 1000, goldRates: () => [stack] }));

        expect(view.gold).toBe(1000);
        expect(view.goldRates()[0]).toBe(stack);
        expect(view.rateClaims()).toEqual([]);
    });

    test('a recorded leg comes off the ceiling and off the unit count with it', () => {
        const ledger = createResourceLedger(0);
        ledger.record({
            title: 'Some goal',
            type: 'gold',
            goal: { amount: 0 },
            totals: { goldSpend: 0 },
            steps: [{ done: false, details: { legs: [{ rate: stack, gold: 60_000_000 }] } }],
        });

        const decorated = ledger.view(context({ goldRates: () => [stack] })).goldRates()[0];
        expect(decorated.sustainable.gold).toBe(30_000_000);
        expect(decorated.sustainable.units).toBe(10_000);
        // The original is untouched, or the next refresh would start from a lie
        expect(stack.sustainable.gold).toBe(90_000_000);
    });

    test('a step already done consumed nothing, so it claims nothing', () => {
        const ledger = createResourceLedger(0);
        ledger.record({
            title: 'Some goal',
            type: 'gold',
            goal: { amount: 0 },
            totals: { goldSpend: 0 },
            steps: [{ done: true, details: { legs: [{ rate: stack, gold: 60_000_000 }] } }],
        });

        expect(ledger.view(context({ goldRates: () => [stack] })).rateClaims()).toEqual([]);
    });

    test('coins are claimed up to what is there, never past it', () => {
        const ledger = createResourceLedger(100);
        ledger.record({ title: 'Greedy', type: 'house', goal: {}, totals: { goldSpend: 400 }, steps: [] });

        expect(ledger.view(context()).gold).toBe(0);
        expect(ledger.view(context()).goldClaims()).toEqual([{ title: 'Greedy', gold: 100 }]);
    });
});

describe('an equipment target', () => {
    const cape = '/items/sinister_cape';

    /**
     * @param {Object} acquisition - What `acquire` should answer
     * @param {Object} [extra] - Further context overrides
     * @returns {Object} A plan for the bare cape
     */
    const planFor = (acquisition, extra = {}) =>
        planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({ gold: 1_000_000_000, acquire: () => acquisition, ...extra })
        );

    test('buys the base when buying is cheaper', () => {
        const plan = planFor({ strategy: 'buy', totalCost: 1000, buyPrice: 1000, craftCost: 1500 });

        expect(step(plan, 'base').description).toContain('Buy');
        expect(step(plan, 'base').goldDelta).toBe(-1000);
    });

    test('and crafts it when the same call says crafting is', () => {
        // The only difference is the prices; the flip is the behaviour under test
        const plan = planFor({ strategy: 'craft', totalCost: 900, buyPrice: 1500, craftCost: 900 });

        expect(step(plan, 'base').description).toContain('Craft');
        expect(step(plan, 'base').goldDelta).toBe(-900);
    });

    test('costs the enhancement run through the real Markov chain', () => {
        // +0 → +2 at level == item level: E0 = 20/3 attempts, hand-solved in the
        // enhancement calculator's own tests
        const materialPerAttempt = 300;
        const baseCost = 1000;

        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 2 },
            context({
                gold: 1_000_000_000,
                acquire: () => ({ strategy: 'buy', totalCost: baseCost, buyPrice: baseCost, craftCost: null }),
                enhance: ({ targetLevel, startLevel }) => {
                    const run = calculateEnhancement({
                        enhancingLevel: 50,
                        itemLevel: 50,
                        toolBonus: 0,
                        speedBonus: 0,
                        targetLevel,
                        startLevel,
                    });
                    return {
                        attempts: run.attempts,
                        totalTimeSeconds: run.totalTime,
                        materialCost: run.attempts * materialPerAttempt,
                        protectionCost: 0,
                        protectionCount: 0,
                        protectFrom: 0,
                        baseCost,
                        totalCost: baseCost + run.attempts * materialPerAttempt,
                    };
                },
            })
        );

        const enhance = step(plan, 'enhance');
        expect(enhance.details.attempts).toBeCloseTo(20 / 3, 6);
        // The base is bought by its own step, so the run must not be billed for it again
        expect(enhance.goldDelta).toBeCloseTo(-((20 / 3) * materialPerAttempt), 6);
        expect(step(plan, 'base').goldDelta).toBe(-baseCost);
        expect(plan.totals.goldSpend).toBeCloseTo(baseCost + (20 / 3) * materialPerAttempt, 6);
    });

    test('an item already owned at the target level needs no steps', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 10 },
            context({ ownedEnhancementLevel: () => 12 })
        );

        expect(plan.satisfied).toBe(true);
        expect(plan.steps.every((entry) => entry.done)).toBe(true);
        expect(plan.totals.goldSpend).toBe(0);
    });

    test('a base already held is struck through rather than dropped', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 5 },
            context({
                gold: 1_000_000,
                ownedEnhancementLevel: () => 0,
                enhance: () => ({ attempts: 10, totalTimeSeconds: 120, totalCost: 500, baseCost: 0, protectFrom: 0 }),
            })
        );

        // The step is still there — that is what makes it the same plan
        expect(step(plan, 'base').done).toBe(true);
        expect(step(plan, 'base').goldDelta).toBe(0);
        expect(step(plan, 'enhance').done).toBe(false);
        expect(plan.totals.stepsDone).toBe(1);
    });

    test('a craft the character cannot perform becomes a level step first', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({
                gold: 1_000_000,
                skill: () => ({ level: 40, experience: 40_000 }),
                acquire: () => ({
                    strategy: 'craft',
                    totalCost: 900,
                    buyPrice: 5000,
                    craftCost: 900,
                    actionHrid: '/actions/crafting/sinister_cape',
                    requires: [{ skillHrid: '/skills/crafting', level: 70 }],
                }),
                xpRates: () => [
                    {
                        label: 'Sinister Cape',
                        requiredLevel: 1,
                        xpPerHour: 10_000,
                        xpPerAction: 100,
                        actionTime: 10,
                        totalEfficiency: 0,
                        goldPerHour: 0,
                    },
                ],
            })
        );

        const ids = plan.steps.map((entry) => entry.id);
        expect(ids).toContain('train-crafting');
        expect(ids.indexOf('train-crafting')).toBeLessThan(ids.indexOf('base'));
        expect(step(plan, 'train-crafting').description).toContain('Crafting 70');
    });

    test('a plan that spends more than is held earns the shortfall first', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({
                gold: 200,
                acquire: () => ({ strategy: 'buy', totalCost: 1000, buyPrice: 1000, craftCost: null }),
                goldRates: () => [{ label: 'Milking', goldPerHour: 400 }],
            })
        );

        const ids = plan.steps.map((entry) => entry.id);
        expect(ids[0]).toBe('fund');
        expect(step(plan, 'fund').goldDelta).toBe(800);
        expect(step(plan, 'fund').timeHours).toBeCloseTo(2, 6);
        expect(step(plan, 'base').prerequisites).toContain('fund');
    });

    test('and does not, when the coins are already there', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({
                gold: 5000,
                acquire: () => ({ strategy: 'buy', totalCost: 1000, buyPrice: 1000, craftCost: null }),
                goldRates: () => [{ label: 'Milking', goldPerHour: 400 }],
            })
        );

        expect(plan.steps.map((entry) => entry.id)).not.toContain('fund');
    });
});

describe('a skill target', () => {
    const rate = (label, xpPerHour, requiredLevel = 1, extra = {}) => ({
        label,
        requiredLevel,
        xpPerHour,
        xpPerAction: 100,
        actionTime: 10,
        totalEfficiency: 0,
        goldPerHour: 0,
        ...extra,
    });

    test('picks the fastest action the level already allows', () => {
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/cooking', targetLevel: 60 },
            context({
                skill: () => ({ level: 50, experience: 50_000 }),
                xpRates: () => [rate('Slow', 1000), rate('Locked', 99_999, 80), rate('Best available', 5000)],
            })
        );

        expect(step(plan, 'train').details.rate.label).toBe('Best available');
    });

    test('a level already reached comes back done', () => {
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/cooking', targetLevel: 40 },
            context({ skill: () => ({ level: 50, experience: 50_000 }) })
        );

        expect(plan.satisfied).toBe(true);
        expect(step(plan, 'train').done).toBe(true);
    });

    test('a flat rate is timed straight off experience per hour', () => {
        // 10 levels at 1,000 experience each, from a standing start of 50,000
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 60 },
            context({
                skill: () => ({ level: 50, experience: 50_000 }),
                xpRates: () => [rate('Cheese Sword +0 → +5', 5000, 1, { flatRate: true })],
            })
        );

        expect(step(plan, 'train').timeHours).toBeCloseTo(10_000 / 5000, 6);
    });

    test('carries what the grind costs, when it costs', () => {
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 60 },
            context({
                gold: 1_000_000,
                skill: () => ({ level: 50, experience: 50_000 }),
                xpRates: () => [rate('Burning coins', 5000, 1, { flatRate: true, goldPerHour: -100_000 })],
            })
        );

        expect(step(plan, 'train').goldDelta).toBeCloseTo(-200_000, 6);
    });
});

describe('a house room target', () => {
    const observatory = '/house_rooms/observatory';

    test('bills the materials it is short of and the coins on top', () => {
        const plan = planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 8 },
            context({
                gold: 1_000_000_000,
                houseLevel: () => 6,
                owned: (hrid) => (hrid === '/items/cheese' ? 100 : 0),
                houseCost: () => ({
                    coins: 5_000_000,
                    totalValue: 9_000_000,
                    materials: [
                        { itemHrid: '/items/cheese', count: 40, marketPrice: 1000, totalValue: 40_000 },
                        { itemHrid: '/items/log', count: 50, marketPrice: 2000, totalValue: 100_000 },
                    ],
                }),
            })
        );

        // The cheese is already in the bag, so only the logs are a purchase
        expect(step(plan, 'materials').goldDelta).toBe(-100_000);
        expect(step(plan, 'materials').details.materials.map((entry) => entry.itemHrid)).toEqual(['/items/log']);
        expect(step(plan, 'build').goldDelta).toBe(-5_000_000);
        expect(plan.totals.goldSpend).toBe(5_100_000);
    });

    test('materials already held mark their step done', () => {
        const plan = planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 7 },
            context({
                gold: 1_000_000_000,
                houseLevel: () => 6,
                owned: () => 1000,
                houseCost: () => ({
                    coins: 1000,
                    totalValue: 2000,
                    materials: [{ itemHrid: '/items/cheese', count: 40, marketPrice: 1000, totalValue: 40_000 }],
                }),
            })
        );

        expect(step(plan, 'materials').done).toBe(true);
        expect(step(plan, 'build').prerequisites).toContain('materials');
    });

    test('a room already at the target needs nothing', () => {
        const plan = planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 5 },
            context({ houseLevel: () => 8 })
        );

        expect(plan.satisfied).toBe(true);
        expect(step(plan, 'build').done).toBe(true);
    });
});

describe('orderSteps', () => {
    const node = (id, prerequisites = []) => ({ id, prerequisites, done: false, goldDelta: 0, timeHours: 0 });

    test('puts prerequisites first', () => {
        const ordered = orderSteps([node('c', ['b']), node('a'), node('b', ['a'])]);
        expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    });

    test('leaves independent steps in the order they were emitted', () => {
        const ordered = orderSteps([node('x'), node('y'), node('z')]);
        expect(ordered.map((entry) => entry.id)).toEqual(['x', 'y', 'z']);
    });

    test('keeps a step whose prerequisite is not in the list', () => {
        const ordered = orderSteps([node('only', ['missing'])]);
        expect(ordered.map((entry) => entry.id)).toEqual(['only']);
    });

    test('a cycle loses nothing', () => {
        const ordered = orderSteps([node('a', ['b']), node('b', ['a'])]);
        expect(ordered.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
    });
});

describe('summarize', () => {
    test('totals only what is left to do', () => {
        const totals = summarize([
            { done: true, goldDelta: -500, timeHours: 5 },
            { done: false, goldDelta: 1000, timeHours: 2 },
            { done: false, goldDelta: -300, timeHours: 1 },
        ]);

        expect(totals).toMatchObject({
            goldEarn: 1000,
            goldSpend: 300,
            netGold: 700,
            timeHours: 3,
            timeKnown: true,
            stepsDone: 1,
            stepCount: 3,
        });
    });

    test('an untimeable step makes the total a floor rather than a figure', () => {
        expect(summarize([{ done: false, goldDelta: 0, timeHours: null }]).timeKnown).toBe(false);
    });
});

describe('the confidence note', () => {
    test('says the numbers move with the market', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 0 }));
        expect(plan.confidence.priceDependent).toBe(true);
        expect(plan.confidence.note).toMatch(/market/i);
    });

    test('carries whatever the context has to say about its prices', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 500, pricingNote: 'Priced at 10:00.' }));
        expect(plan.confidence.note).toBe('Priced at 10:00.');
    });
});

describe('a shortfall that is somebody else’s claim', () => {
    const observatory = '/house_rooms/observatory';

    /**
     * @param {Object} [overrides] - Context fields to replace
     * @returns {Object} A house-goal plan over 500 logs held and 200 wanted
     */
    const housePlan = (overrides = {}) =>
        planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 8 },
            context({
                gold: 1_000_000_000,
                houseLevel: () => 6,
                itemName: () => 'Log',
                houseCost: () => ({
                    coins: 0,
                    totalValue: 400_000,
                    materials: [{ itemHrid: '/items/log', count: 200, marketPrice: 2000, totalValue: 400_000 }],
                }),
                ...overrides,
            })
        );

    test('the goal asks what is available to IT, by its own id', () => {
        const asked = [];
        housePlan({
            owned: (hrid, goalId) => {
                asked.push([hrid, goalId]);
                return 500;
            },
        });
        expect(asked).toHaveLength(1);
        expect(asked[0][0]).toBe('/items/log');
        expect(typeof asked[0][1]).toBe('string');
    });

    test('a provider that ignores the reservation ledger plans exactly as before', () => {
        const plan = housePlan({ owned: () => 500 });
        expect(step(plan, 'materials').done).toBe(true);
        expect(plan.warnings).toEqual([]);
    });

    test('another plan’s claim turns a full bag into a shortfall, and the line says whose', () => {
        const plan = housePlan({
            // 500 held, 400 claimed elsewhere
            owned: () => 100,
            reservationNote: (short) => `${short} short — 400 reserved by "Goal: Cheese sword"`,
        });

        expect(step(plan, 'materials').details.materials[0].missing).toBe(100);
        expect(plan.warnings).toEqual(['Log: 100 short — 400 reserved by "Goal: Cheese sword"']);
    });

    test('no note means no line, so nothing is said about an ordinary shortfall', () => {
        const plan = housePlan({ owned: () => 100, reservationNote: () => '' });
        expect(plan.warnings).toEqual([]);
    });

    test('a plan claims what it needs in full, not only what it is short of', () => {
        const plan = housePlan({ owned: () => 150 });
        expect(reservationLines(plan)).toEqual([{ itemHrid: '/items/log', count: 200 }]);
    });

    test('a step already done claims nothing', () => {
        const plan = housePlan({ owned: () => 500 });
        expect(reservationLines(plan)).toEqual([]);
    });
});
