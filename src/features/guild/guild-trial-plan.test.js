/**
 * The ability plan: what the syntax accepts, what it refuses to guess at, and
 * what the comparison is allowed to call non-compliance.
 *
 * The load-bearing claims are the negative ones — an ability nobody could name
 * is reported rather than dropped, an ambiguous prefix names its candidates
 * rather than picking one, and a player nobody captured is never called
 * off-plan.
 */

import { describe, test, expect, vi } from 'vitest';

/** The plan module's persistence reaches storage; nothing here is about that */
const disk = vi.hoisted(() => ({ keys: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key) => disk.keys[key] ?? null,
        set: async (key, value) => {
            disk.keys[key] = value;
        },
        tryGet: async (key) => ({ found: key in disk.keys, value: disk.keys[key] ?? null }),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'me', getInitClientData: () => ({ abilityDetailMap: {} }) },
}));

const {
    GuildTrialPlan,
    planStorageKey,
    mergePlanRecords,
    normalizeToken,
    buildAbilityIndex,
    resolveAbility,
    splitMinLevel,
    parsePlan,
    matchPlanName,
    verdictFor,
    comparePlan,
    planStatusLine,
} = await import('./guild-trial-plan.js');

/** A game ability map with two auras sharing no prefix and one that does */
const ABILITIES = {
    '/abilities/fierce_aura': { name: 'Fierce Aura' },
    '/abilities/aqua_aura': { name: 'Aqua Aura' },
    '/abilities/vampirism': { name: 'Vampirism' },
    '/abilities/sweep': { name: 'Sweep' },
    '/abilities/smack': { name: 'Smack' },
};

/** A captured participant row as `state().participants` produces one */
function row(name, abilities, captured = true) {
    return { name, captured, capture: { name, abilities } };
}

const parse = (text) => parsePlan(text, ABILITIES, 1000);

describe('parsing a plan', () => {
    test('takes colon, hyphen and en-dash separators alike', () => {
        const plan = parse('Alice: Fierce Aura\nBob - Aqua Aura\nCara – Vampirism');
        expect(plan.lines.map((line) => line.player)).toEqual(['Alice', 'Bob', 'Cara']);
        expect(plan.lines[1].abilities[0]).toMatchObject({ hrid: '/abilities/aqua_aura', name: 'Aqua Aura' });
        expect(plan.parsedAt).toBe(1000);
    });

    test('ignores blank lines and # comments', () => {
        const plan = parse('# the tanks\n\nAlice: Sweep\n   \n#Bob: Sweep');
        expect(plan.lines).toHaveLength(1);
        expect(plan.lines[0].player).toBe('Alice');
    });

    test('matches abilities past case, spacing and punctuation', () => {
        const plan = parse('Alice: fierceaura, AQUA-AURA, /abilities/vampirism, sweep');
        expect(plan.lines[0].abilities.map((ability) => ability.hrid)).toEqual([
            '/abilities/fierce_aura',
            '/abilities/aqua_aura',
            '/abilities/vampirism',
            '/abilities/sweep',
        ]);
        expect(plan.unknownTokens).toEqual([]);
    });

    test('takes the hrid tail, and a prefix only one ability carries', () => {
        const plan = parse('Alice: fierce_aura, vamp');
        expect(plan.lines[0].abilities.map((ability) => ability.name)).toEqual(['Fierce Aura', 'Vampirism']);
    });

    test('an ambiguous prefix is reported with its candidates, never guessed at', () => {
        const plan = parse('Alice: s');
        expect(plan.lines[0].abilities).toEqual([]);
        expect(plan.lines[0].ambiguous).toEqual([{ token: 's', matches: ['Smack', 'Sweep'] }]);
        expect(plan.ambiguousTokens).toHaveLength(1);
    });

    test('an ability nothing matches is reported, not dropped', () => {
        const plan = parse('Alice: Flurry, Sweep');
        expect(plan.lines[0].unknown).toEqual(['Flurry']);
        expect(plan.lines[0].abilities).toHaveLength(1);
        expect(plan.unknownTokens).toEqual(['Flurry']);
    });

    test('two players typoing the same unknown ability in different case count once, not twice', () => {
        const plan = parse('Alice: Flurry\nBob: FLURRY\nCara: flurry');
        // Each line still names its own typo verbatim...
        expect(plan.lines.map((line) => line.unknown[0])).toEqual(['Flurry', 'FLURRY', 'flurry']);
        // ...but the summary is one unrecognised ability, not three
        expect(plan.unknownTokens).toEqual(['Flurry']);
    });

    test('two players naming the same ambiguous prefix in different case count once, not twice', () => {
        const plan = parse('Alice: s\nBob: S');
        expect(plan.ambiguousTokens).toEqual([{ token: 's', matches: ['Smack', 'Sweep'] }]);
    });

    test('a trailing number, with or without @, is a minimum level', () => {
        const plan = parse('Alice: Fierce Aura 200, Vampirism@150, Sweep');
        expect(plan.lines[0].abilities).toEqual([
            { hrid: '/abilities/fierce_aura', name: 'Fierce Aura', minLevel: 200 },
            { hrid: '/abilities/vampirism', name: 'Vampirism', minLevel: 150 },
            { hrid: '/abilities/sweep', name: 'Sweep', minLevel: null },
        ]);
    });

    test('a hyphen inside the player name is not mistaken for the separator', () => {
        const plan = parse('Az-0r: Fierce Aura');
        expect(plan.lines[0].player).toBe('Az-0r');
        expect(plan.lines[0].abilities).toEqual([
            { hrid: '/abilities/fierce_aura', name: 'Fierce Aura', minLevel: null },
        ]);
    });

    test('a hyphen-separator still splits a hyphenated name when it is surrounded by spaces', () => {
        const plan = parse('Bun-Bun - Fierce Aura');
        expect(plan.lines[0].player).toBe('Bun-Bun');
        expect(plan.lines[0].abilities[0]).toMatchObject({ hrid: '/abilities/fierce_aura' });
    });

    test('an ability that resolves whole keeps its digits', () => {
        const index = buildAbilityIndex({ '/abilities/rank_2': { name: 'Rank 2' } });
        expect(splitMinLevel('Rank 2', index)).toEqual({ text: 'Rank 2', minLevel: null });
        expect(normalizeToken(' Fierce-Aura ')).toBe('fierceaura');
        expect(resolveAbility('nothing', buildAbilityIndex(ABILITIES))).toMatchObject({ error: 'unknown' });
    });
});

describe('matching plan names to the roster', () => {
    test('is case-insensitive, and tolerant of a truncated roster name', () => {
        const rows = [row('Alice', []), row('SarinTe…', [])];
        expect(matchPlanName('alice', rows).name).toBe('Alice');
        expect(matchPlanName('SarinTeagan', rows).name).toBe('SarinTe…');
        expect(matchPlanName('Nobody', rows)).toBeNull();
    });
});

describe('comparing a plan against the captures', () => {
    const at = (name, level) => ({ hrid: `/abilities/${name}`, level });

    test('calls a matching kit ok and names the extras without failing them', () => {
        const plan = parse('Alice: Fierce Aura');
        const compare = comparePlan(plan, [row('Alice', [at('fierce_aura', 90), at('sweep', 30)])], ABILITIES);
        expect(compare.verdicts[0]).toMatchObject({ status: 'ok', missing: [], extra: ['Sweep'] });
        expect(compare.summary.onPlan).toBe(1);
    });

    test('names what is planned and not equipped', () => {
        const plan = parse('Alice: Fierce Aura, Vampirism');
        const compare = comparePlan(plan, [row('Alice', [at('fierce_aura', 90)])], ABILITIES);
        expect(compare.verdicts[0]).toMatchObject({ status: 'missing', missing: ['Vampirism'] });
        expect(compare.summary.onPlan).toBe(0);
    });

    test('an equipped ability below its planned level is under-level, not missing', () => {
        const plan = parse('Alice: Vampirism 200');
        const compare = comparePlan(plan, [row('Alice', [at('vampirism', 150)])], ABILITIES);
        expect(compare.verdicts[0]).toMatchObject({
            status: 'underLevel',
            underLevel: [{ name: 'Vampirism', level: 150, required: 200 }],
        });
    });

    test('a missing ability with a level requirement still reads as missing', () => {
        const plan = parse('Alice: Vampirism 200');
        const compare = comparePlan(plan, [row('Alice', [])], ABILITIES);
        expect(compare.verdicts[0]).toMatchObject({ status: 'missing', missing: ['Vampirism 200'] });
    });

    test('a planned player nobody captured is never called off-plan', () => {
        const plan = parse('Alice: Fierce Aura');
        const compare = comparePlan(plan, [{ name: 'Alice', captured: false, capture: null }], ABILITIES);
        expect(compare.verdicts[0].status).toBe('uncaptured');
        expect(compare.summary.onPlan).toBe(0);
        expect(compare.summary.comparedPlayers).toBe(0);
    });

    test('a roster player with no line, and a line for nobody in the trial', () => {
        const plan = parse('Alice: Fierce Aura\nZed: Sweep');
        const compare = comparePlan(plan, [row('Alice', [at('fierce_aura', 90)]), row('Bob', [])], ABILITIES);
        expect(compare.noPlan).toEqual(['Bob']);
        expect(compare.notInTrial).toEqual(['Zed']);
        expect(compare.summary).toMatchObject({ plannedPlayers: 1, noPlanCount: 1, notInTrialCount: 1 });
    });

    test('the status line says the count and the unrecognised tokens', () => {
        const plan = parse('Alice: Fierce Aura, Flurry\nBob: Vampirism\nZed: Sweep');
        const compare = comparePlan(
            plan,
            [row('Alice', [at('fierce_aura', 90)]), row('Bob', []), row('Cara', [])],
            ABILITIES
        );
        const line = planStatusLine(compare);
        expect(line).toContain('1/2 on plan');
        expect(line).toContain('1 with no plan');
        expect(line).toContain('1 not in trial');
        expect(line).toContain('1 unrecognised ability: Flurry');
        expect(planStatusLine(comparePlan(parse(''), []))).toBe('No plan saved.');
    });

    test('verdictFor reads the highest copy of a duplicated ability', () => {
        const plan = parse('Alice: Vampirism 200');
        const verdict = verdictFor(plan.lines[0], [at('vampirism', 150), at('vampirism', 220)], ABILITIES);
        expect(verdict.status).toBe('ok');
    });
});

describe('the plan record', () => {
    test('is keyed per guild and survives a reload', async () => {
        expect(planStorageKey('Cats')).toBe('guildTrialAbilityPlan_Cats');
        expect(planStorageKey(null)).toBe('guildTrialAbilityPlan_default');

        const plan = new GuildTrialPlan();
        await plan.initialize('Cats');
        await plan.setText('Alice: Fierce Aura');
        expect(disk.keys['guildTrialAbilityPlan_Cats'].text).toBe('Alice: Fierce Aura');

        const reloaded = new GuildTrialPlan();
        await reloaded.initialize('Cats');
        expect(reloaded.text()).toBe('Alice: Fierce Aura');
        expect(reloaded.parsed(ABILITIES).lines[0].player).toBe('Alice');

        // Another guild's plan is not this one's
        await reloaded.setGuildName('Dogs');
        expect(reloaded.text()).toBe('');
    });

    test('clearing the box clears the plan rather than resurrecting it', async () => {
        const plan = new GuildTrialPlan();
        await plan.initialize('Wolves');
        await plan.setText('Alice: Sweep');
        await plan.setText('');
        const reloaded = new GuildTrialPlan();
        await reloaded.initialize('Wolves');
        expect(reloaded.text()).toBe('');
    });
});

describe('merging two devices trial plans', () => {
    test('the plan saved later wins, in either direction', () => {
        const mine = { text: 'Alice: Fierce Aura', savedAt: 5000 };
        const theirs = { text: 'Bob: Aqua Aura', savedAt: 1000 };

        expect(mergePlanRecords(mine, theirs)).toBe(mine);
        expect(mergePlanRecords(theirs, mine)).toBe(mine);
    });

    test('a stamped plan beats a stamp-less one, whichever side carries it', () => {
        const stamped = { text: 'Alice: Fierce Aura', savedAt: 5000 };
        const legacy = { text: 'written before savedAt existed' };

        expect(mergePlanRecords(stamped, legacy)).toBe(stamped);
        expect(mergePlanRecords(legacy, stamped)).toBe(stamped);
    });

    test('two stamp-less plans fall back to last-write-wins', () => {
        const local = { text: 'mine' };
        const incoming = { text: 'theirs' };

        expect(mergePlanRecords(local, incoming)).toBe(incoming);
    });

    test('an absent side merges to the side that exists', () => {
        const plan = { text: 'Alice: Fierce Aura', savedAt: 1 };

        expect(mergePlanRecords(null, plan)).toBe(plan);
        expect(mergePlanRecords(plan, null)).toBe(plan);
        expect(mergePlanRecords(null, null)).toBeNull();
    });
});
