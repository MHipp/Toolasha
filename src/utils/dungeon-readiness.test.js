import { describe, test, expect } from 'vitest';
import {
    runsCovered,
    typicalRunSeconds,
    keyReadiness,
    memberReadiness,
    memberLimit,
    whoStopsFirst,
    levelGapWarnings,
    mergePartyRoster,
    buildReadiness,
    parseRunsPlanned,
    nextRunStep,
    keyShortfallCost,
    keyShortfalls,
    formatKeyShortfall,
    formatKeyShortfalls,
    MAX_RUNS_PLANNED,
    UNKNOWN_CONSUMABLES,
    UNKNOWN_KEYS,
} from './dungeon-readiness.js';

const RUN = 600;

describe('runsCovered', () => {
    test('whole runs only', () => {
        expect(runsCovered(1800, RUN)).toBe(3);
        expect(runsCovered(1799, RUN)).toBe(2);
        expect(runsCovered(0, RUN)).toBe(0);
    });

    test('unknown without a run length or a finite stock', () => {
        expect(runsCovered(1800, null)).toBeNull();
        expect(runsCovered(1800, 0)).toBeNull();
        expect(runsCovered(Infinity, RUN)).toBeNull();
    });
});

describe('typicalRunSeconds', () => {
    const runs = [
        { dungeonName: 'Chimerical Den', tier: 0, duration: 600_000 },
        { dungeonName: 'Chimerical Den', tier: 0, duration: 660_000 },
        { dungeonName: 'Chimerical Den', tier: 0, duration: 14_400_000 },
        { dungeonName: 'Pirate Cove', tier: 0, duration: 100_000 },
    ];

    test('the median, so one afk run cannot move it', () => {
        expect(typicalRunSeconds(runs, { dungeonName: 'Chimerical Den' })).toEqual({ seconds: 660, samples: 3 });
    });

    test('a run with no tier recorded still counts against a tiered query', () => {
        const mixed = [
            { dungeonName: 'Chimerical Den', tier: null, duration: 600_000 },
            { dungeonName: 'Chimerical Den', tier: 2, duration: 900_000 },
        ];
        expect(typicalRunSeconds(mixed, { dungeonName: 'Chimerical Den', tier: 2 }).samples).toBe(2);
        expect(typicalRunSeconds(mixed, { dungeonName: 'Chimerical Den', tier: 0 }).samples).toBe(1);
    });

    test('no history is null, not zero', () => {
        expect(typicalRunSeconds(runs, { dungeonName: 'Enchanted Fortress' })).toBeNull();
        expect(typicalRunSeconds([], { dungeonName: 'Chimerical Den' })).toBeNull();
        expect(typicalRunSeconds(runs, { dungeonName: 'Unknown' })).toBeNull();
    });
});

describe('keyReadiness', () => {
    test('one key per run, and the shortfall for the plan', () => {
        const keys = keyReadiness({
            itemHrid: '/items/chimerical_entry_key',
            itemName: 'Chimerical Entry Key',
            held: 4,
            runsPlanned: 10,
        });
        expect(keys).toMatchObject({ held: 4, runsCovered: 4, shortfall: 6, enough: false });
    });

    test('enough is enough', () => {
        expect(keyReadiness({ itemHrid: '/items/pirate_entry_key', held: 10, runsPlanned: 10 })).toMatchObject({
            enough: true,
            shortfall: 0,
        });
    });

    test('outside a dungeon there is no key line at all', () => {
        expect(keyReadiness({ itemHrid: null, held: 5, runsPlanned: 5 })).toBeNull();
    });
});

describe('memberReadiness', () => {
    const forecasts = [
        { itemHrid: '/items/blueberry_cake', name: 'Blueberry Cake', secondsLeft: 3000 },
        { itemHrid: '/items/swiftness_coffee', name: 'Swiftness Coffee', secondsLeft: 1200 },
        { itemHrid: '/items/spare', name: 'Spare', secondsLeft: Infinity },
    ];

    test('the soonest slot decides, and it converts to runs', () => {
        const row = memberReadiness({ name: 'Me', isSelf: true, forecasts, runSeconds: RUN, measuredFrom: 'live run' });
        expect(row).toMatchObject({
            runsCovered: 2,
            secondsLeft: 1200,
            limitedBy: 'Swiftness Coffee',
            unknown: null,
            measuredFrom: 'live run',
        });
    });

    test('no run length leaves the time known and the runs unknown', () => {
        const row = memberReadiness({ name: 'Me', forecasts });
        expect(row.secondsLeft).toBe(1200);
        expect(row.runsCovered).toBeNull();
        expect(row.unknown).toBeNull();
    });

    test('a member never seen is unknown, not stocked', () => {
        const row = memberReadiness({ name: 'Stranger', forecasts: null, combatLevel: 140 });
        expect(row).toMatchObject({ runsCovered: null, secondsLeft: null, unknown: UNKNOWN_CONSUMABLES });
        expect(row.combatLevel).toBe(140);
    });

    test('slots that are filled but not being consumed are not "lasts forever"', () => {
        const row = memberReadiness({ name: 'Idle', forecasts: [{ name: 'Cake', secondsLeft: Infinity }] });
        expect(row.unknown).toBe(UNKNOWN_CONSUMABLES);
    });
});

describe('a member whose keys are known but whose food is not', () => {
    test('keeps the keys and stays unread', () => {
        const row = memberReadiness({ name: 'Ally', forecasts: null, keysHeld: 3, keyName: 'Chimerical Entry Key' });
        // The keys are exact and the food is still missing: both have to survive
        expect(row).toMatchObject({ keysHeld: 3, keyRunsCovered: 3, keysUnknown: null, unknown: UNKNOWN_CONSUMABLES });
    });

    test('no key count is an unknown of its own, not a zero', () => {
        const row = memberReadiness({ name: 'Ally', forecasts: null });
        expect(row).toMatchObject({ keysHeld: null, keyRunsCovered: null, keysUnknown: UNKNOWN_KEYS });
    });
});

describe('memberLimit', () => {
    const food = (secondsLeft, runSeconds) =>
        memberReadiness({ name: 'Me', forecasts: [{ name: 'Cake', secondsLeft }], runSeconds });

    test('keys bind when they run out before the food does', () => {
        const row = { ...food(6000, RUN), keysHeld: 3, keyRunsCovered: 3, keyName: 'Key' };
        expect(memberLimit(row)).toMatchObject({ runs: 3, source: 'keys', label: 'Key' });
    });

    test('food binds when it is the shorter of the two, and ties go to food', () => {
        expect(memberLimit({ ...food(6000, RUN), keysHeld: 20, keyRunsCovered: 20 })).toMatchObject({
            runs: 10,
            source: 'food',
        });
        expect(memberLimit({ ...food(6000, RUN), keysHeld: 10, keyRunsCovered: 10 })).toMatchObject({
            source: 'food',
        });
    });

    test('with no run length the two are in different units and keys are not ranked', () => {
        const row = { ...food(6000, null), keysHeld: 3, keyRunsCovered: 3 };
        expect(memberLimit(row)).toMatchObject({ runs: null, secondsLeft: 6000, source: 'food' });
    });

    test('keys alone are a limit; nothing at all is not', () => {
        const bare = memberReadiness({ name: 'Ally', forecasts: null, keysHeld: 4 });
        expect(memberLimit(bare)).toMatchObject({ runs: 4, source: 'keys' });
        expect(memberLimit(memberReadiness({ name: 'Stranger' }))).toMatchObject({ source: null });
    });
});

describe('mergePartyRoster', () => {
    test('an empty slot map mid-battle is filled from the names the run stated', () => {
        expect(mergePartyRoster([], ['Ally', 'Me'])).toEqual([
            { characterID: null, characterName: 'Ally' },
            { characterID: null, characterName: 'Me' },
        ]);
    });

    test('named slots win, and a name already in them is not added twice', () => {
        const roster = mergePartyRoster([{ characterID: 'c1', characterName: 'Me' }], ['Me', 'Ally']);
        expect(roster).toHaveLength(2);
        expect(roster[0]).toMatchObject({ characterID: 'c1', characterName: 'Me' });
        expect(roster[1]).toMatchObject({ characterID: null, characterName: 'Ally' });
    });

    test('a nameless slot no name accounts for stays on the card as an unknown', () => {
        const roster = mergePartyRoster([{ characterID: 'c1' }, { characterID: 'c2' }], ['Ally']);
        expect(roster.map((member) => member.characterName)).toEqual(['Ally', '']);
    });
});

describe('whoStopsFirst', () => {
    test('the soonest of the members that could be read, and says how many that was', () => {
        const rows = [
            memberReadiness({ name: 'Me', isSelf: true, forecasts: [{ name: 'Cake', secondsLeft: 4000 }] }),
            memberReadiness({ name: 'Ally', forecasts: [{ name: 'Coffee', secondsLeft: 900 }] }),
            memberReadiness({ name: 'Stranger', forecasts: null }),
        ];
        expect(whoStopsFirst(rows)).toMatchObject({ name: 'Ally', secondsLeft: 900, known: 2, total: 3 });
    });

    test('nobody readable is null rather than a guess', () => {
        expect(whoStopsFirst([memberReadiness({ name: 'Stranger', forecasts: null })])).toBeNull();
        expect(whoStopsFirst([])).toBeNull();
    });

    test('a member counted only by their keys is partial, never read', () => {
        const rows = [
            memberReadiness({
                name: 'Me',
                isSelf: true,
                forecasts: [{ name: 'Cake', secondsLeft: 6000 }],
                runSeconds: RUN,
            }),
            memberReadiness({ name: 'Ally', forecasts: null, keysHeld: 3, keyName: 'Key' }),
        ];
        expect(whoStopsFirst(rows)).toMatchObject({
            name: 'Ally',
            runsCovered: 3,
            source: 'keys',
            limitedBy: 'Key',
            known: 1,
            partial: 1,
            total: 2,
        });
    });

    test('keys that outlast the food leave the food verdict standing', () => {
        const rows = [
            memberReadiness({
                name: 'Me',
                isSelf: true,
                forecasts: [{ name: 'Cake', secondsLeft: 6000 }],
                runSeconds: RUN,
                keysHeld: 400,
            }),
            memberReadiness({ name: 'Ally', forecasts: null, keysHeld: 900 }),
        ];
        expect(whoStopsFirst(rows)).toMatchObject({ name: 'Me', source: 'food', known: 1, partial: 1, total: 2 });
    });

    test('keys are not ranked against a food figure that has no run length', () => {
        const rows = [
            memberReadiness({ name: 'Me', isSelf: true, forecasts: [{ name: 'Cake', secondsLeft: 60 }] }),
            memberReadiness({ name: 'Ally', forecasts: null, keysHeld: 1 }),
        ];
        expect(whoStopsFirst(rows)).toMatchObject({ name: 'Me', source: 'food' });
    });
});

describe('levelGapWarnings', () => {
    test('flags the members below the party and names the ones it could not check', () => {
        const rows = [
            { name: 'Top', combatLevel: 200 },
            { name: 'Low', combatLevel: 100 },
            { name: 'Stranger', combatLevel: null },
        ];
        const result = levelGapWarnings(rows);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].name).toBe('Low');
        expect(result.warnings[0].debuff).toBeLessThan(0);
        expect(result.unknownLevels).toEqual(['Stranger']);
    });

    test('one known level cannot establish a top, so nothing is claimed', () => {
        expect(levelGapWarnings([{ name: 'Me', combatLevel: 100 }, { name: 'Stranger' }]).warnings).toEqual([]);
    });
});

describe('buildReadiness', () => {
    const dungeon = { actionHrid: '/actions/combat/chimerical_den', name: 'Chimerical Den', tier: 0 };

    test('assembles the card and footnotes exactly what was missing', () => {
        const model = buildReadiness({
            dungeon,
            runsPlanned: 10,
            keys: keyReadiness({ itemHrid: '/items/chimerical_entry_key', held: 4, runsPlanned: 10 }),
            members: [
                memberReadiness({
                    name: 'Me',
                    isSelf: true,
                    combatLevel: 200,
                    forecasts: [{ name: 'Cake', secondsLeft: 3000 }],
                    runSeconds: RUN,
                }),
                memberReadiness({ name: 'Ally', forecasts: null, combatLevel: 100 }),
            ],
            lint: ['Ally has skilling gear equipped: Cheese Hatchet'],
            lintScope: 'Gear is read from captured profiles only.',
            runLength: { seconds: RUN, samples: 12 },
        });

        expect(model.keys.shortfall).toBe(6);
        expect(model.stopsFirst).toMatchObject({ name: 'Me', known: 1, total: 2 });
        expect(model.levelGap.warnings[0].name).toBe('Ally');
        expect(model.runSeconds).toBe(RUN);
        expect(model.footnotes.some((note) => note.includes('after the key is spent'))).toBe(true);
        expect(model.footnotes.some((note) => note.includes('key-count message'))).toBe(false);
        expect(model.footnotes).toContain('Gear is read from captured profiles only.');
        expect(model.footnotes.some((note) => note.includes('how long one takes'))).toBe(false);
    });

    test('a stated key count is sourced in a footnote, since it is the one member figure there is', () => {
        const model = buildReadiness({
            dungeon,
            runsPlanned: 10,
            members: [memberReadiness({ name: 'Ally', forecasts: null, keysHeld: 40 })],
        });
        expect(model.footnotes.some((note) => note.includes('key-count message'))).toBe(true);
        expect(model.stopsFirst).toMatchObject({ known: 0, partial: 1, total: 1 });
    });

    test('no run history footnotes the missing conversion', () => {
        const model = buildReadiness({ dungeon, runsPlanned: 3, members: [] });
        expect(model.runSeconds).toBeNull();
        expect(model.footnotes.some((note) => note.includes('how long one takes'))).toBe(true);
        expect(model.stopsFirst).toBeNull();
    });
});

describe('parseRunsPlanned', () => {
    test('a whole count is taken as typed', () => {
        expect(parseRunsPlanned('2753')).toBe(2753);
        expect(parseRunsPlanned(4)).toBe(4);
    });

    test('the separators the card itself prints are read back', () => {
        expect(parseRunsPlanned('2,753')).toBe(2753);
        expect(parseRunsPlanned(' 1 000 ')).toBe(1000);
    });

    test('zero, negatives and fractions are not run counts', () => {
        for (const raw of ['0', '-5', '2.5', '1e3', '0x10', 'ten', '', '   ', null, undefined, {}]) {
            expect(parseRunsPlanned(raw)).toBeNull();
        }
    });

    test('the bound rejects rather than clamps, so a typo changes nothing', () => {
        expect(parseRunsPlanned(String(MAX_RUNS_PLANNED))).toBe(MAX_RUNS_PLANNED);
        expect(parseRunsPlanned(String(MAX_RUNS_PLANNED + 1))).toBeNull();
        expect(parseRunsPlanned('1000000')).toBeNull();
    });
});

describe('nextRunStep', () => {
    const STEPS = [1, 3, 5, 10, 25, 50, 100, 250, 500, 1000];

    test('a preset steps to the one above it', () => {
        expect(nextRunStep(25, STEPS)).toBe(50);
        expect(nextRunStep(1, STEPS)).toBe(3);
    });

    test('the top wraps to the bottom', () => {
        expect(nextRunStep(1000, STEPS)).toBe(1);
    });

    test('a typed count between steps goes up, not back to the start', () => {
        expect(nextRunStep(60, STEPS)).toBe(100);
        expect(nextRunStep(4, STEPS)).toBe(5);
    });

    test('a typed count above every step wraps rather than sticking', () => {
        expect(nextRunStep(2753, STEPS)).toBe(1);
    });
});

describe('keyShortfallCost', () => {
    const cost = (over) => ({
        itemHrid: '/items/chimerical_entry_key',
        pricingMode: 'ask',
        buyPrice: 1000,
        craftCost: 600,
        craftSeconds: 20,
        ...over,
    });

    test('nothing missing is nothing to price', () => {
        expect(keyShortfallCost({ shortfall: 0, cost: cost() })).toBeNull();
    });

    test('both totals are reported, and the cheaper route named', () => {
        const plan = keyShortfallCost({ shortfall: 10, cost: cost() });
        expect(plan).toMatchObject({
            shortfall: 10,
            buyTotal: 10000,
            craftTotal: 6000,
            cheaper: 'craft',
            total: 6000,
            saves: 4000,
            priceBasis: 'ask',
            craftSeconds: 200,
        });
    });

    test('buying wins when the recipe costs more', () => {
        const plan = keyShortfallCost({ shortfall: 4, cost: cost({ craftCost: 1500 }) });
        expect(plan).toMatchObject({ cheaper: 'buy', total: 4000, saves: 2000 });
        // The bench time belongs to a route nobody is being sent down
        expect(plan.craftSeconds).toBeNull();
    });

    test('a tie goes to buying, since only one route also costs an afternoon', () => {
        expect(keyShortfallCost({ shortfall: 3, cost: cost({ craftCost: 1000 }) }).cheaper).toBe('buy');
    });

    test('the bid basis is carried through rather than assumed', () => {
        const plan = keyShortfallCost({ shortfall: 2, cost: cost({ pricingMode: 'bid', buyPrice: 400 }) });
        expect(plan).toMatchObject({ priceBasis: 'bid', cheaper: 'buy', total: 800 });
    });

    test('an unpriceable recipe is unpriced, never a free craft', () => {
        const plan = keyShortfallCost({ shortfall: 5, cost: cost({ craftCost: null }) });
        expect(plan.craftTotal).toBeNull();
        expect(plan.cheaper).toBe('buy');
        expect(plan.saves).toBeNull();
    });

    test('an empty market leaves crafting as the only route', () => {
        const plan = keyShortfallCost({ shortfall: 5, cost: cost({ buyPrice: null }) });
        expect(plan.buyTotal).toBeNull();
        expect(plan).toMatchObject({ cheaper: 'craft', total: 3000 });
    });

    test('neither side priced says so instead of picking a winner', () => {
        const plan = keyShortfallCost({ shortfall: 5, cost: cost({ buyPrice: null, craftCost: null }) });
        expect(plan).toMatchObject({ shortfall: 5, cheaper: null, total: null, buyTotal: null, craftTotal: null });
        // A costing that never arrived is the same three-state answer
        expect(keyShortfallCost({ shortfall: 5, cost: null })).toMatchObject({ cheaper: null, total: null });
    });

    test('the craft basis takes the craft route even when buying is cheaper', () => {
        const plan = keyShortfallCost({
            shortfall: 4,
            cost: cost({ basis: 'craft', cheaper: 'craft', buyPrice: 500, craftCost: 900 }),
        });

        expect(plan.costBasis).toBe('craft');
        expect(plan.cheaper).toBe('craft');
        expect(plan.total).toBe(3600);
        // Not "saving 1600": the route taken is the dearer one, and the card
        // words it as a stated preference rather than a bargain
        expect(plan.saves).toBeNull();
    });

    test('the craft basis still reports a saving when the craft really is cheaper', () => {
        const plan = keyShortfallCost({
            shortfall: 4,
            cost: cost({ basis: 'craft', cheaper: 'craft' }),
        });

        expect(plan.cheaper).toBe('craft');
        expect(plan.saves).toBe(1600);
    });

    test('a craft-basis costing that fell back to buying is priced as a buy', () => {
        const plan = keyShortfallCost({
            shortfall: 3,
            cost: cost({ basis: 'craft', cheaper: 'buy', craftCost: null }),
        });

        expect(plan.costBasis).toBe('craft');
        expect(plan.cheaper).toBe('buy');
        expect(plan.craftTotal).toBeNull();
        expect(plan.total).toBe(3000);
    });

    test('a stated route with no price behind it falls back to the comparison', () => {
        const plan = keyShortfallCost({
            shortfall: 3,
            cost: cost({ basis: 'craft', cheaper: 'craft', craftCost: null }),
        });

        // 'craft' with a null craft cost would put a null total on the line
        expect(plan.cheaper).toBe('buy');
        expect(plan.total).toBe(3000);
    });

    test('the market basis is unchanged: the cheaper of the two wins', () => {
        expect(keyShortfallCost({ shortfall: 2, cost: cost() })).toMatchObject({
            costBasis: 'market',
            cheaper: 'craft',
            total: 1200,
            saves: 800,
        });
    });
});

describe('the key plan on the built model', () => {
    const dungeon = { actionHrid: '/actions/combat/chimerical_den', name: 'Chimerical Den', tier: 2 };

    test('the shortfall is priced both ways from the costing the caller passed in', () => {
        const model = buildReadiness({
            dungeon,
            runsPlanned: 10,
            keys: keyReadiness({ itemHrid: '/items/chimerical_entry_key', held: 4, runsPlanned: 10 }),
            keyCost: { pricingMode: 'ask', buyPrice: 1000, craftCost: 600, craftSeconds: 20 },
            members: [],
        });
        expect(model.keys.shortfall).toBe(6);
        expect(model.keyPlan).toMatchObject({ shortfall: 6, buyTotal: 6000, craftTotal: 3600, cheaper: 'craft' });
    });

    test('enough keys held leaves nothing to price', () => {
        const model = buildReadiness({
            dungeon,
            runsPlanned: 2,
            keys: keyReadiness({ itemHrid: '/items/chimerical_entry_key', held: 4, runsPlanned: 2 }),
            keyCost: { pricingMode: 'ask', buyPrice: 1000, craftCost: 600 },
            members: [],
        });
        expect(model.keyPlan).toBeNull();
    });
});

describe('who is short of keys, and by how much', () => {
    /** A member row with only the field this reads set */
    const member = (name, keysHeld) => memberReadiness({ name, keysHeld });

    test('short members come back worst first, and members at the count are left out', () => {
        const rows = keyShortfalls({
            members: [member('bun', 12), member('ash', 15), member('cove', 5)],
            runsPlanned: 15,
        });

        expect(rows).toEqual([
            { name: 'cove', has: 5, needs: 15, short: 10 },
            { name: 'bun', has: 12, needs: 15, short: 3 },
        ]);
    });

    test('a member above the count is left out too', () => {
        const rows = keyShortfalls({ members: [member('ash', 40)], runsPlanned: 15 });
        expect(rows).toEqual([]);
    });

    test('a member nobody has heard a key count for is unknown, not zero, and sorts last', () => {
        const rows = keyShortfalls({ members: [member('ghost', null), member('bun', 12)], runsPlanned: 15 });

        expect(rows.map((row) => row.name)).toEqual(['bun', 'ghost']);
        expect(rows[1]).toEqual({ name: 'ghost', has: null, needs: 15, short: null });
    });

    test('the run count is what multiplies the requirement', () => {
        const members = [member('bun', 12)];
        expect(keyShortfalls({ members, runsPlanned: 15 })[0]).toMatchObject({ needs: 15, short: 3 });
        expect(keyShortfalls({ members, runsPlanned: 40 })[0]).toMatchObject({ needs: 40, short: 28 });
        // One run wants one key, so a member holding twelve is not short
        expect(keyShortfalls({ members, runsPlanned: 1 })).toEqual([]);
    });

    test('the line reads as something to paste into party chat', () => {
        expect(formatKeyShortfall({ name: 'bun', has: 12, needs: 15, short: 3 })).toBe(
            'bun needs 3 more keys (has 12 of 15)'
        );
        expect(formatKeyShortfall({ name: 'bun', has: 14, needs: 15, short: 1 })).toBe(
            'bun needs 1 more key (has 14 of 15)'
        );
        expect(formatKeyShortfall({ name: 'ghost', has: null, needs: 15, short: null })).toBe(
            'ghost key count unknown (needs 15)'
        );
    });

    test('the joined text is one line per member', () => {
        const rows = keyShortfalls({
            members: [member('bun', 12), member('cove', 5), member('ghost', null)],
            runsPlanned: 15,
        });
        expect(formatKeyShortfalls(rows)).toBe(
            'cove needs 10 more keys (has 5 of 15)\n' +
                'bun needs 3 more keys (has 12 of 15)\n' +
                'ghost key count unknown (needs 15)'
        );
        expect(formatKeyShortfalls([])).toBe('');
    });

    test('the built model carries the list the card draws', () => {
        const model = buildReadiness({
            dungeon: { actionHrid: '/actions/combat/chimerical_den', name: 'Chimerical Den', tier: 2 },
            runsPlanned: 15,
            members: [member('bun', 12), member('ash', 15)],
        });
        expect(model.keyShortfalls).toEqual([{ name: 'bun', has: 12, needs: 15, short: 3 }]);
    });
});
