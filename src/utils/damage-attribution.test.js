import { describe, test, expect } from 'vitest';
import {
    newAttributionState,
    noteActions,
    findCaster,
    findActors,
    attributeTick,
    foldEvents,
    isDamagingAction,
    foldEnemies,
} from './damage-attribution.js';

const monster = (cHP, dmgCounter = 0, critCounter = 0) => ({ cHP, dmgCounter, critCounter });
const tick = (mMap, pMap) => ({ mMap, pMap });

describe('findCaster', () => {
    test('is whoever’s mana went down', () => {
        // The payload never says who hit, and only the caster's mana falls
        const state = newAttributionState();
        findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state);

        expect(findCaster({ 0: { cMP: 100 }, 1: { cMP: 70 } }, state)).toBe('1');
    });

    test('solo needs no mana at all', () => {
        // Otherwise an auto-attacking character never registers a hit
        const state = newAttributionState();
        expect(findCaster({ 0: { cMP: 100 } }, state)).toBe('0');
    });

    test('a party with nobody spending credits nobody rather than a guess', () => {
        const state = newAttributionState();
        findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state);
        expect(findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state)).toBeNull();
    });

    test('mana going up is not a cast', () => {
        const state = newAttributionState();
        findCaster({ 0: { cMP: 50 }, 1: { cMP: 50 } }, state);
        expect(findCaster({ 0: { cMP: 80 }, 1: { cMP: 80 } }, state)).toBeNull();
    });
});

describe('attributeTick', () => {
    function started(hp = 1000) {
        const state = newAttributionState();
        attributeTick(tick({ 0: monster(hp) }, { 0: { cMP: 100 } }), state);
        return state;
    }

    test('a rising damage counter with lost health is a hit', () => {
        const state = started();
        const events = attributeTick(tick({ 0: monster(600, 1) }, { 0: { cMP: 90 } }), state);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '0', monsterIndex: '0', amount: 400, isMiss: false });
    });

    test('health falling with no counter rise is a bleed, counted as its own class', () => {
        // Real damage, and it used to vanish: the per-player tables disagreed
        // with the party total by exactly the damage-over-time volume. Filed
        // under `dot` rather than under whatever ability happened to be
        // mid-cast, and carrying no swing of its own
        const state = started();
        const events = attributeTick(tick({ 0: monster(900, 0) }, { 0: { cMP: 100 } }), state);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '0', amount: 100, isDot: true, action: 'dot' });
    });

    test('a counter rise with no health lost is a miss', () => {
        // The one case a health diff can never express on its own
        const state = started();
        const [event] = attributeTick(tick({ 0: monster(1000, 1) }, { 0: { cMP: 90 } }), state);

        expect(event.isMiss).toBe(true);
        expect(event.amount).toBe(0);
    });

    test('a rising crit counter marks the hit', () => {
        const state = started();
        const [event] = attributeTick(tick({ 0: monster(500, 1, 1) }, { 0: { cMP: 90 } }), state);
        expect(event.isCrit).toBe(true);
    });

    test('a monster seen for the first time is not hit for its whole bar', () => {
        const state = newAttributionState();
        expect(attributeTick(tick({ 0: monster(1000, 5) }, { 0: { cMP: 100 } }), state)).toEqual([]);
    });

    test('the hit carries what the player was preparing', () => {
        const state = started();
        noteActions(state, { 0: { preparingAbilityHrid: '/abilities/smack' } });

        const [event] = attributeTick(tick({ 0: monster(500, 1) }, { 0: { cMP: 90 } }), state);
        expect(event.action).toBe('/abilities/smack');
    });

    test('an auto-attack is labelled as one', () => {
        const state = started();
        noteActions(state, { 0: { isPreparingAutoAttack: true } });

        expect(attributeTick(tick({ 0: monster(500, 1) }, { 0: { cMP: 90 } }), state)[0].action).toBe('auto');
    });

    test('several monsters hit in one tick each get an event', () => {
        const state = newAttributionState();
        attributeTick(tick({ 0: monster(100), 1: monster(100) }, { 0: { cMP: 100 } }), state);

        const events = attributeTick(tick({ 0: monster(90, 1), 1: monster(40, 1) }, { 0: { cMP: 90 } }), state);
        expect(events.map((event) => event.amount).sort((a, b) => a - b)).toEqual([10, 60]);
    });

    test('nothing at all is nothing, not a crash', () => {
        expect(attributeTick(null, newAttributionState())).toEqual([]);
    });
});

describe('foldEvents', () => {
    const hit = (over) => ({ playerIndex: '0', amount: 100, action: 'auto', isCrit: false, isMiss: false, ...over });

    test('sums damage, hits and crits per player', () => {
        const tally = foldEvents({}, [hit({}), hit({ isCrit: true }), hit({ playerIndex: '1', amount: 50 })]);

        expect(tally['0']).toMatchObject({ damage: 200, hits: 2, crits: 1 });
        expect(tally['1']).toMatchObject({ damage: 50, hits: 1 });
    });

    test('a miss is a swing that happened, so it counts even when filtered out', () => {
        // Dropping it would flatter the hit rate of whatever was cast
        const tally = foldEvents({}, [hit({ isMiss: true, action: 'idle' })]);
        expect(tally['0'].misses).toBe(1);
        expect(tally['0'].hits).toBe(0);
    });

    test('the non-damaging filter drops damage credited while idle', () => {
        const tally = foldEvents({}, [hit({ action: 'idle' })]);
        expect(tally['0'].damage).toBe(0);
    });

    test('and can be turned off', () => {
        const tally = foldEvents({}, [hit({ action: 'idle' })], { filterNonDamaging: false });
        expect(tally['0'].damage).toBe(100);
    });

    test('a heal is not damage of the other sign', () => {
        const tally = foldEvents({}, [hit({ isHeal: true, amount: 300 })]);
        expect(tally['0'].damage).toBe(0);
    });

    test('damage is broken down by what was cast', () => {
        const tally = foldEvents({}, [hit({ action: '/abilities/smack' }), hit({ action: 'auto', amount: 40 })]);

        expect(tally['0'].byAbility['/abilities/smack'].damage).toBe(100);
        expect(tally['0'].byAbility.auto.damage).toBe(40);
    });

    test('folding twice accumulates rather than replacing', () => {
        const tally = foldEvents({}, [hit({})]);
        foldEvents(tally, [hit({})]);
        expect(tally['0'].damage).toBe(200);
    });
});

describe('isDamagingAction', () => {
    test('idle is not an attack', () => {
        expect(isDamagingAction('idle')).toBe(false);
    });

    test('an auto-attack and a named ability are', () => {
        expect(isDamagingAction('auto')).toBe(true);
        expect(isDamagingAction('/abilities/smack')).toBe(true);
    });

    test('the caller can name more', () => {
        expect(isDamagingAction('/abilities/heal', new Set(['/abilities/heal']))).toBe(false);
    });
});

describe('foldEnemies', () => {
    const nameOf = (index) => ({ 0: 'Rat', 1: 'Wolf' })[index] || null;

    test('damage lands against the monster that took it', () => {
        const tally = foldEnemies(
            {},
            [
                { monsterIndex: '0', amount: 100, isCrit: false, isMiss: false },
                { monsterIndex: '1', amount: 40, isCrit: true, isMiss: false },
                { monsterIndex: '0', amount: 60, isCrit: false, isMiss: false },
            ],
            nameOf
        );

        expect(tally.Rat).toMatchObject({ damage: 160, hits: 2, crits: 0 });
        expect(tally.Wolf).toMatchObject({ damage: 40, hits: 1, crits: 1 });
    });

    test('a kill is counted and is not also a hit', () => {
        // A death is not a swing; counting it as one adds a phantom hit
        const tally = foldEnemies({}, [{ monsterIndex: '0', isKill: true }], nameOf);

        expect(tally.Rat).toMatchObject({ kills: 1, hits: 0, damage: 0 });
    });

    test('a bleed kill still counts, though no counter moved', () => {
        // The killing blow can land on a tick with no hit at all, and those are
        // the long fights — exactly the ones worth measuring
        const tally = foldEnemies({}, [{ monsterIndex: '1', isKill: true }], nameOf);

        expect(tally.Wolf.kills).toBe(1);
    });

    test('a monster it cannot name is left out rather than lumped together', () => {
        // The index is a slot in this fight; without a name behind it the
        // damage belongs to nobody in particular
        const tally = foldEnemies({}, [{ monsterIndex: '9', amount: 500, isMiss: false }], nameOf);

        expect(Object.keys(tally)).toHaveLength(0);
    });

    test('misses count as swings against the monster', () => {
        const tally = foldEnemies({}, [{ monsterIndex: '0', amount: 0, isMiss: true }], nameOf);

        expect(tally.Rat).toMatchObject({ misses: 1, hits: 0, damage: 0 });
    });
});

describe('kills in a tick', () => {
    test('a monster reaching zero emits a kill', () => {
        const state = newAttributionState();
        attributeTick({ mMap: { 0: { cHP: 100, dmgCounter: 0 } }, pMap: { 0: { cMP: 50 } } }, state);
        const events = attributeTick({ mMap: { 0: { cHP: 0, dmgCounter: 1 } }, pMap: { 0: { cMP: 40 } } }, state);

        expect(events.filter((event) => event.isKill)).toHaveLength(1);
    });

    test('a monster already dead is not killed twice', () => {
        // It stays in the payload at zero health until the battle turns over
        const state = newAttributionState();
        attributeTick({ mMap: { 0: { cHP: 0, dmgCounter: 1 } }, pMap: { 0: { cMP: 50 } } }, state);
        const events = attributeTick({ mMap: { 0: { cHP: 0, dmgCounter: 1 } }, pMap: { 0: { cMP: 50 } } }, state);

        expect(events.filter((event) => event.isKill)).toHaveLength(0);
    });

    test('a kill event does not reach the player tally', () => {
        const tally = foldEvents({}, [{ playerIndex: '0', monsterIndex: '0', isKill: true }]);
        expect(tally['0']).toBeUndefined();
    });
});

describe('foldEvents, split by enemy', () => {
    const nameOf = (index) => ({ 0: 'Rat', 1: 'Wolf' })[index] || null;

    test('a player carries what they did to each monster', () => {
        const tally = foldEvents(
            {},
            [
                { playerIndex: '0', monsterIndex: '0', amount: 100, action: 'auto', isMiss: false },
                { playerIndex: '0', monsterIndex: '1', amount: 40, action: 'auto', isMiss: false },
            ],
            { nameOf }
        );

        expect(tally['0'].byEnemy.Rat).toMatchObject({ damage: 100, hits: 1 });
        expect(tally['0'].byEnemy.Wolf).toMatchObject({ damage: 40, hits: 1 });
    });

    test('two players fighting different monsters are not merged', () => {
        // One kiting while another burns the boss is two fights; a party-wide
        // enemy total averages them into neither
        const tally = foldEvents(
            {},
            [
                { playerIndex: '0', monsterIndex: '0', amount: 100, action: 'auto', isMiss: false },
                { playerIndex: '1', monsterIndex: '1', amount: 900, action: 'auto', isMiss: false },
            ],
            { nameOf }
        );

        expect(tally['0'].byEnemy.Wolf).toBeUndefined();
        expect(tally['1'].byEnemy.Rat).toBeUndefined();
    });

    test('the split names the ability used against each monster', () => {
        const tally = foldEvents(
            {},
            [{ playerIndex: '0', monsterIndex: '0', amount: 100, action: '/abilities/cleave', isMiss: false }],
            { nameOf }
        );

        expect(tally['0'].byEnemy.Rat.byAbility['/abilities/cleave'].damage).toBe(100);
    });

    test('without a name resolver the player tally is unchanged', () => {
        // The split is extra; a caller that cannot name monsters still gets its
        // players, abilities and totals
        const tally = foldEvents({}, [
            { playerIndex: '0', monsterIndex: '0', amount: 100, action: 'auto', isMiss: false },
        ]);

        expect(tally['0'].damage).toBe(100);
        expect(tally['0'].byEnemy).toEqual({});
    });
});

describe('the acting ability, tick by tick', () => {
    /**
     * A tick where the player casts (mana falls) and one monster takes a hit.
     * @param {number} mana - The player's mana after this tick
     * @param {number} health - The monster's health after this tick
     * @param {number} counter - Its damage counter after this tick
     * @param {Object} preparing - What the player is preparing, in tick spelling
     * @returns {Object}
     */
    const tick = (mana, health, counter, preparing = {}) => ({
        pMap: { 0: { cMP: mana, ...preparing } },
        mMap: { 0: { cHP: health, dmgCounter: counter } },
    });

    test('a tick payload names the ability under its own spelling', () => {
        // `new_battle` writes preparingAbilityHrid; a tick abbreviates it to
        // abilityHrid. Reading only the long one leaves the label frozen at
        // whatever was being prepared when the fight began.
        const state = newAttributionState();
        noteActions(state, { 0: { abilityHrid: '/abilities/cleave' } });

        expect(state.actions['0']).toBe('/abilities/cleave');
    });

    test('an auto-attack is recognised under its own spelling too', () => {
        const state = newAttributionState();
        noteActions(state, { 0: { isAutoAtk: true } });

        expect(state.actions['0']).toBe('auto');
    });

    test('a hit is credited to what was prepared before it, not after', () => {
        // The ability that lands on this tick was cast before the payload
        // arrived; by now the player has started the next one. Reading the
        // label from this tick would credit every hit to its successor.
        const state = newAttributionState();

        noteActions(state, { 0: { abilityHrid: '/abilities/first' } });
        attributeTick(tick(100, 1000, 0), state);

        // The hit lands while the player has moved on to the second ability
        const events = attributeTick(tick(90, 800, 1, { abilityHrid: '/abilities/second' }), state);

        expect(events[0].action).toBe('/abilities/first');
    });

    test('the label changes as the fight goes on', () => {
        // Frozen at the first ability, one ability takes the whole fight —
        // which is the shape of the bug this catches
        const state = newAttributionState();

        noteActions(state, { 0: { abilityHrid: '/abilities/first' } });
        attributeTick(tick(100, 1000, 0), state);

        const first = attributeTick(tick(90, 800, 1), state);
        noteActions(state, { 0: { abilityHrid: '/abilities/second' } });
        const second = attributeTick(tick(80, 600, 2), state);

        expect(first[0].action).toBe('/abilities/first');
        expect(second[0].action).toBe('/abilities/second');
    });
});

describe('the presence rung, and the party-of-one rung below it', () => {
    test('a spectated tick credits the only unit in it — that is whose action it is', () => {
        // From the guild trial capture: the boss lost 1,405 health on a tick
        // whose only `pMap` entry was being hit at the time. This used to be
        // refused as "the delta showed one person, not one person acting" —
        // and the party recording proved that reading wrong: the server groups
        // each tick by actor, the boss's own hit counter rose in the same
        // breath, and health a boss loses while striking somebody is that
        // somebody's reflect
        const state = newAttributionState();
        const tick = (hp, dmg) => ({
            pMap: { 1: { cHP: 2612, mHP: 2612, cMP: 2180 } },
            mMap: { 0: { cHP: hp, dmgCounter: dmg } },
        });

        attributeTick(tick(454_807, 301), state, { soloFallback: false });
        noteActions(state, tick(454_807, 301).pMap);
        const events = attributeTick(tick(453_402, 302), state, { soloFallback: false });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '1', amount: 1_405 });
    });

    test('a lone player with nothing changed about them owns the tick too', () => {
        // Their DoT ticking is why the server put them in the delta at all
        const state = newAttributionState();
        const before = { pMap: { 2: { cHP: 900, cMP: 400 } }, mMap: { 0: { cHP: 5_000, dmgCounter: 7 } } };
        attributeTick(before, state, { soloFallback: false });
        noteActions(state, before.pMap);

        const events = attributeTick(
            { pMap: { 2: { cHP: 900, cMP: 400 } }, mMap: { 0: { cHP: 4_800, dmgCounter: 8 } } },
            state,
            { soloFallback: false }
        );

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '2', amount: 200 });
    });

    test('two mana drops on one tick separate nobody', () => {
        // Synchronized builds cast on the same tick; "whoever iterated last"
        // is key order, not attribution — the tick falls through
        const state = newAttributionState();
        findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state);

        expect(findCaster({ 0: { cMP: 80 }, 1: { cMP: 70 } }, state)).toBeNull();
    });

    test('this client’s own solo fight still credits its one character', () => {
        const state = newAttributionState();
        const tick = (hp, dmg) => ({ pMap: { 0: { cHP: 100, cMP: 50 } }, mMap: { 0: { cHP: hp, dmgCounter: dmg } } });

        attributeTick(tick(1000, 0), state);
        noteActions(state, tick(1000, 0).pMap);
        const events = attributeTick(tick(900, 1), state);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '0', amount: 100 });
    });
});

describe('damage over time and reflect', () => {
    const bleedState = () => {
        const state = newAttributionState();
        attributeTick(tick({ 0: monster(1000, 3) }, { 0: { cMP: 100 } }), state);
        return state;
    };

    test('un-countered health loss is credited, apart from the hit counts', () => {
        const state = bleedState();
        const tally = foldEvents({}, attributeTick(tick({ 0: monster(880, 3) }, { 0: { cMP: 100 } }), state));

        expect(tally['0'].damage).toBe(120);
        expect(tally['0'].dotDamage).toBe(120);
        // A bleed is not a swing: nothing here is a hit, a crit or a miss
        expect(tally['0'].hits).toBe(0);
        expect(tally['0'].crits).toBe(0);
        expect(tally['0'].misses).toBe(0);
        // Counted on its own, so the swing/tick MIX is recoverable — the damage
        // subtotal alone cannot say how many ticks made it up
        expect(tally['0'].dotTicks).toBe(1);
    });

    test('a hit on the same run still counts as a hit and only as a hit', () => {
        const state = bleedState();
        const events = [
            ...attributeTick(tick({ 0: monster(880, 3) }, { 0: { cMP: 100 } }), state),
            ...attributeTick(tick({ 0: monster(600, 4) }, { 0: { cMP: 90 } }), state),
        ];
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0'].hits).toBe(1);
        expect(tally['0'].damage).toBe(400);
        expect(tally['0'].dotDamage).toBe(120);
        expect(tally['0'].dotTicks).toBe(1);
    });

    test('health rising with no counter is not damage', () => {
        const state = bleedState();
        expect(attributeTick(tick({ 0: monster(1000, 3) }, { 0: { cMP: 100 } }), state)).toEqual([]);
    });

    test('the per-enemy tally carries it too, without a swing', () => {
        const state = bleedState();
        const events = attributeTick(tick({ 0: monster(880, 3) }, { 0: { cMP: 100 } }), state);
        const enemies = foldEnemies({}, events, () => 'Trial Badger');

        expect(enemies['Trial Badger'].damage).toBe(120);
        expect(enemies['Trial Badger'].dotDamage).toBe(120);
        expect(enemies['Trial Badger'].hits).toBe(0);
    });
});

describe('a collision too big to adjudicate', () => {
    /** n players, all present, none of them separable by counter or mana */
    const crowd = (count) => Object.fromEntries([...Array(count)].map((_, index) => [index, { cHP: 100, cMP: 50 }]));

    const seeded = (count) => {
        const state = newAttributionState();
        state.lastSwing = '0';
        attributeTick({ pMap: crowd(count), mMap: { 0: monster(10_000, 1) } }, state);
        return state;
    };

    test('a small one still falls to the last swinger', () => {
        const state = seeded(3);
        const { actors, shared } = findActors(crowd(3), state, { soloFallback: false });

        expect(shared).toBe(false);
        expect(actors).toEqual(['0']);
    });

    test('a big one is split equally between everybody present', () => {
        const state = seeded(20);
        const { actors, shared } = findActors(crowd(20), state, { soloFallback: false });

        expect(shared).toBe(true);
        expect(actors).toHaveLength(20);
    });

    test('the split sums to exactly the tick’s damage', () => {
        const state = seeded(7);
        const events = attributeTick({ pMap: crowd(7), mMap: { 0: monster(9_300, 2) } }, state, {
            soloFallback: false,
        });

        expect(events).toHaveLength(7);
        expect(events.reduce((sum, event) => sum + event.amount, 0)).toBeCloseTo(700, 9);

        const tally = foldEvents({}, events, { filterNonDamaging: false });
        const total = Object.values(tally).reduce((sum, row) => sum + row.damage, 0);
        expect(total).toBeCloseTo(700, 9);
        // Seven fractional swings are one swing, so a hit count still means what it says
        const hits = Object.values(tally).reduce((sum, row) => sum + row.hits, 0);
        expect(hits).toBeCloseTo(1, 9);
    });

    test('a shared tick answers no single caster', () => {
        const state = seeded(20);
        expect(findCaster(crowd(20), state, { soloFallback: false })).toBeNull();
    });

    test('a lone counter rise in a crowd is split, not credited', () => {
        // Deliberately reversed, like the mana rung above it, and for a reason
        // outside this module: the server used to stream `atkCounter` for the
        // viewer's own unit alone, so a lone rise meant "the one player we can
        // see acted". It now streams counters for every present player, so a
        // lone rise in a full snapshot means one of a whole roster ticked over
        // first. On a 150,642-tick trial, crediting the riser moved 1,332 ticks
        // and 100,379 damage onto one name. The tick falls to the equal split.
        const state = newAttributionState();
        const before = { ...crowd(20), 5: { cHP: 100, cMP: 50, atkCounter: 7 } };
        attributeTick({ pMap: before, mMap: { 0: monster(10_000, 1) } }, state);
        const swinging = { ...crowd(20), 5: { cHP: 100, cMP: 50, atkCounter: 8 } };

        const { actors, shared } = findActors(swinging, state, { soloFallback: false });
        expect(shared).toBe(true);
        expect(actors).toHaveLength(20);
    });

    test('a counter still names one person in a small collision', () => {
        // The rung's original and still-valid purpose: with a couple of units
        // in play a lone counter rise really is the swinger, and the gate must
        // not touch that case
        const state = newAttributionState();
        const before = { ...crowd(3), 2: { cHP: 100, cMP: 50, atkCounter: 7 } };
        attributeTick({ pMap: before, mMap: { 0: monster(10_000, 1) } }, state);
        const swinging = { ...crowd(3), 2: { cHP: 100, cMP: 50, atkCounter: 8 } };

        expect(findActors(swinging, state, { soloFallback: false })).toEqual({ actors: ['2'], shared: false });
    });

    test('the counter gate moves with the threshold the caller passes', () => {
        // The bound is the equal split's own, not a second number
        const state = newAttributionState();
        const before = { ...crowd(20), 5: { cHP: 100, cMP: 50, atkCounter: 7 } };
        attributeTick({ pMap: before, mMap: { 0: monster(10_000, 1) } }, state);
        const swinging = { ...crowd(20), 5: { cHP: 100, cMP: 50, atkCounter: 8 } };

        expect(findActors(swinging, state, { soloFallback: false, collisionThreshold: 50 })).toEqual({
            actors: ['5'],
            shared: false,
        });
    });

    test('a lone player in a tick is still theirs, counter or not', () => {
        // The presence rung sits below the gated one and reads this tick's own
        // payload, so a solo tick is unaffected by the crowd rule
        const state = newAttributionState();
        attributeTick({ pMap: { 4: { cHP: 100, cMP: 50, atkCounter: 2 } }, mMap: { 0: monster(10_000, 1) } }, state);

        expect(findActors({ 4: { cHP: 100, cMP: 50, atkCounter: 3 } }, state, { soloFallback: false })).toEqual({
            actors: ['4'],
            shared: false,
        });
    });

    test('two counters rising in a crowd are split, as they always were', () => {
        const state = newAttributionState();
        const before = {
            ...crowd(20),
            5: { cHP: 100, cMP: 50, atkCounter: 7 },
            9: { cHP: 100, cMP: 50, atkCounter: 4 },
        };
        attributeTick({ pMap: before, mMap: { 0: monster(10_000, 1) } }, state);
        const swinging = {
            ...crowd(20),
            5: { cHP: 100, cMP: 50, atkCounter: 8 },
            9: { cHP: 100, cMP: 50, atkCounter: 5 },
        };

        const { actors, shared } = findActors(swinging, state, { soloFallback: false });
        expect(shared).toBe(true);
        expect(actors).toHaveLength(20);
    });

    test('the gated split still sums to exactly the tick’s damage', () => {
        // Conservation across the path the gate now routes a lone riser down
        const state = newAttributionState();
        const before = { ...crowd(20), 5: { cHP: 100, cMP: 50, atkCounter: 7 } };
        attributeTick({ pMap: before, mMap: { 0: monster(10_000, 1) } }, state);
        const swinging = { ...crowd(20), 5: { cHP: 100, cMP: 50, atkCounter: 8 } };

        const events = attributeTick({ pMap: swinging, mMap: { 0: monster(9_100, 2) } }, state, {
            soloFallback: false,
        });

        expect(events).toHaveLength(20);
        expect(events.reduce((sum, event) => sum + event.amount, 0)).toBeCloseTo(900, 9);

        const tally = foldEvents({}, events, { filterNonDamaging: false });
        const total = Object.values(tally).reduce((sum, row) => sum + row.damage, 0);
        expect(total).toBeCloseTo(900, 9);
    });

    test('and the ungated small-collision path conserves it too', () => {
        const state = newAttributionState();
        const before = { ...crowd(3), 2: { cHP: 100, cMP: 50, atkCounter: 7 } };
        attributeTick({ pMap: before, mMap: { 0: monster(10_000, 1) } }, state);
        const swinging = { ...crowd(3), 2: { cHP: 100, cMP: 50, atkCounter: 8 } };

        const events = attributeTick({ pMap: swinging, mMap: { 0: monster(9_100, 2) } }, state, {
            soloFallback: false,
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '2', amount: 900 });
    });

    test('a lone mana drop still names one person in a party small enough to adjudicate', () => {
        const state = seeded(3);
        const casting = { ...crowd(3), 2: { cHP: 100, cMP: 10 } };

        expect(findActors(casting, state, { soloFallback: false })).toEqual({ actors: ['2'], shared: false });
    });

    test('a lone mana drop in a crowd is coincidence, not attribution', () => {
        // Deliberately reversed from what this file used to assert. In a
        // twenty-player trial most of the roster auto-attacks and never spends
        // mana, so the single member whose mana moved is the only one who
        // *could* leave a trace — not the only one who acted. KikiMeter's field
        // hardening capped the rung at the same threshold after measuring the
        // bias it produces. The tick falls through to the equal split instead.
        const state = seeded(20);
        const casting = { ...crowd(20), 5: { cHP: 100, cMP: 10 } };

        const { actors, shared } = findActors(casting, state, { soloFallback: false });
        expect(shared).toBe(true);
        expect(actors).toHaveLength(20);
    });

    test('the gate moves with the threshold the caller passes', () => {
        const state = seeded(20);
        const casting = { ...crowd(20), 5: { cHP: 100, cMP: 10 } };

        expect(findActors(casting, state, { soloFallback: false, collisionThreshold: 50 })).toEqual({
            actors: ['5'],
            shared: false,
        });
    });
});

describe('a monster respawning into a slot', () => {
    const unit = (cHP, mHP, dmgCounter) => ({ cHP, mHP, dmgCounter, critCounter: 0 });

    test('a changed maximum re-baselines the slot and registers nothing', () => {
        const state = newAttributionState();
        attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(200, 1000, 4) } }, state);

        // A different monster in the same slot: full bar, fresh counters
        const events = attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(2000, 2000, 0) } }, state);

        expect(events).toEqual([]);
        expect(state.monstersHP['0']).toBe(2000);
        expect(state.monstersMaxHP['0']).toBe(2000);
    });

    test('a residual-health respawn registers nothing either', () => {
        // The dangerous shape: the slot still had health, so the diff would
        // have been counted as real damage rather than ignored as a heal
        const state = newAttributionState();
        attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(900, 1000, 4) } }, state);
        const events = attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(400, 500, 9) } }, state);

        expect(events).toEqual([]);
    });

    test('the tick after the re-baseline counts normally', () => {
        const state = newAttributionState();
        attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(200, 1000, 4) } }, state);
        attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(2000, 2000, 0) } }, state);
        const events = attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(1700, 2000, 1) } }, state);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ amount: 300, isDot: false });
    });

    test('the same maximum throughout is one monster and counts as one', () => {
        const state = newAttributionState();
        attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(1000, 1000, 0) } }, state);
        const events = attributeTick({ pMap: { 0: { cMP: 50 } }, mMap: { 0: unit(940, 1000, 1) } }, state);

        expect(events).toHaveLength(1);
        expect(events[0].amount).toBe(60);
    });
});
