/** @vitest-environment happy-dom */

/**
 * Putting names to a spectated trial's unit indexes.
 *
 * The numbers in here are the capture's own: `pMap["1"]` reading `mHP 2612,
 * mMP 2180`, and a guild whose loadout store holds one member with `Max HP
 * 2,612` and `Max MP 2,180`. What is worth asserting is the discipline rather
 * than the arithmetic — an ambiguous signature must name nobody, because a
 * wrong name on a damage row is acted on.
 */

import { describe, test, expect, afterEach } from 'vitest';

import {
    fightViewBossNames,
    fightViewNames,
    fightViewPartyNames,
    loadoutVitals,
    matchByVitals,
    nameCoverage,
    resolveUnitNames,
    rosterFromBattle,
} from './guild-trial-units.js';
import { NEW_GUILD_BATTLE } from './guild-trial-messages.fixture.js';

/**
 * A captured sheet, as the loadout store holds one.
 * @param {string} name - Whose
 * @param {number} hp - Max HP, as the game displayed it
 * @param {number} mp - Max MP
 * @returns {Object} A snapshot
 */
const sheet = (name, hp, mp) => ({
    name,
    at: 1,
    rows: [
        { label: 'Max HP', value: hp.toLocaleString('en-US') },
        { label: 'Max MP', value: mp.toLocaleString('en-US') },
        { label: 'Armor', value: '339' },
    ],
    // The multiplier the sheet also carries, which must never be matched against
    stats: { maxHitpoints: 932, maxManapoints: 500 },
});

/** The unit the capture actually showed */
const icmeow = { cHP: 2612, mHP: 2612, cMP: 2180, mMP: 2180, isActive: true, leftCombat: false };

afterEach(() => {
    document.body.innerHTML = '';
});

describe('loadoutVitals', () => {
    test('reads the displayed maximums, not the multiplier beside them', () => {
        expect(loadoutVitals(sheet('ICMeow', 2612, 2180))).toEqual({ mHP: 2612, mMP: 2180 });
    });

    test('a sheet without them says so rather than guessing', () => {
        expect(loadoutVitals({ rows: [{ label: 'Armor', value: '339' }] })).toEqual({ mHP: null, mMP: null });
        expect(loadoutVitals(null)).toEqual({ mHP: null, mMP: null });
    });
});

describe('matchByVitals', () => {
    test('one member with that health and mana is an identification', () => {
        const match = matchByVitals(icmeow, [sheet('Cream', 1923, 1923), sheet('ICMeow', 2612, 2180)]);
        expect(match).toMatchObject({ name: 'ICMeow' });
    });

    test('two members in the same gear identify nobody', () => {
        // A near-miss is worse than a blank: a guild acts on the name
        expect(matchByVitals(icmeow, [sheet('ICMeow', 2612, 2180), sheet('Twin', 2612, 2180)])).toBeNull();
    });

    test('the same member captured twice is still one candidate', () => {
        const match = matchByVitals(icmeow, [sheet('ICMeow', 2612, 2180), sheet('icmeow', 2612, 2180)]);
        expect(match).toMatchObject({ name: 'ICMeow' });
    });

    test('health alone is not enough, and neither is nothing', () => {
        expect(matchByVitals({ mHP: 2612 }, [sheet('ICMeow', 2612, 2180)])).toBeNull();
        expect(matchByVitals(icmeow, [])).toBeNull();
        expect(matchByVitals(null, [sheet('ICMeow', 2612, 2180)])).toBeNull();
    });
});

describe('fightViewNames', () => {
    test('reads the party tiles in slot order', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_playersArea__a">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Tib</div></div>' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">ICMeow</div></div>' +
            '</div>' +
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';

        // The boss is in the monsters area and is not a party name
        expect(fightViewNames(document)).toEqual(['Tib', 'ICMeow']);
    });

    test('no fight view is no answer, not an empty party', () => {
        expect(fightViewNames(document)).toEqual([]);
        expect(fightViewNames(null)).toEqual([]);
    });
});

describe('fightViewBossNames', () => {
    test('reads what is being fought, from the monsters area only', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_playersArea__a">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">ICMeow</div></div>' +
            '</div>' +
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';

        // The identity of the stream: a week with two combat trials had the
        // Chameleon fight filed under Hedgehog because nothing read this
        expect(fightViewBossNames(document)).toEqual(['Trial Chameleon']);
    });

    test('no fight view is no answer', () => {
        expect(fightViewBossNames(document)).toEqual([]);
        expect(fightViewBossNames(null)).toEqual([]);
    });
});

describe('resolveUnitNames', () => {
    test('a portrait outranks a build, because it is on screen', () => {
        const names = resolveUnitNames({
            pMap: { 1: icmeow },
            portraits: ['Tib', 'TheirRealName'],
            loadouts: [sheet('ICMeow', 2612, 2180)],
        });

        expect(names['1']).toEqual({ name: 'TheirRealName', source: 'portrait' });
    });

    test('without a portrait the build’s vitals answer', () => {
        const names = resolveUnitNames({ pMap: { 1: icmeow }, loadouts: [sheet('ICMeow', 2612, 2180)] });
        expect(names['1']).toEqual({ name: 'ICMeow', source: 'vitals' });
    });

    test('when neither can say, the placeholder says it is one', () => {
        const names = resolveUnitNames({ pMap: { 1: icmeow, 3: { mHP: 9 } } });
        expect(names['1']).toEqual({ name: 'Player 2', source: 'placeholder' });
        expect(names['3']).toEqual({ name: 'Player 4', source: 'placeholder' });
    });

    test('a name already resolved survives the fight view closing', () => {
        const first = resolveUnitNames({ pMap: { 1: icmeow }, portraits: ['Tib', 'ICMeow'] });
        const later = resolveUnitNames({ pMap: { 1: icmeow }, portraits: [], known: first });

        expect(later['1']).toEqual({ name: 'ICMeow', source: 'portrait' });
    });

    test('a placeholder does not survive it opening', () => {
        const first = resolveUnitNames({ pMap: { 1: icmeow } });
        const later = resolveUnitNames({ pMap: { 1: icmeow }, portraits: ['Tib', 'ICMeow'], known: first });

        expect(later['1']).toEqual({ name: 'ICMeow', source: 'portrait' });
    });

    test('a portrait slot the party does not reach is not borrowed from', () => {
        // Index 4 with two tiles on screen is not tile 0 wrapped around
        const names = resolveUnitNames({ pMap: { 4: icmeow }, portraits: ['Tib', 'Moo'] });
        expect(names['4'].source).toBe('placeholder');
    });
});

describe('one name, one unit', () => {
    test('the watcher’s lone portrait cannot hand their name to another slot', () => {
        // The live regression, from the user's own export: after a refresh
        // dropped the roster, `names` read {0: MillenniumTest (portrait),
        // 2: MillenniumTest (vitals)} — the spectate view draws only the
        // watcher as a CombatUnit, the one-name portrait list was read
        // positionally onto slot 0, and the leaderboard showed the user twice
        // with SarinTest missing entirely.
        const names = resolveUnitNames({
            pMap: { 0: { mHP: 3100, mMP: 900 }, 1: icmeow, 2: { mHP: 5 }, 3: { mHP: 9 } },
            portraits: ['MillenniumTest'],
            loadouts: [sheet('ICMeow', 2612, 2180)],
            own: { slot: '2', name: 'MillenniumTest' },
        });

        expect(names['2']).toMatchObject({ name: 'MillenniumTest', source: 'own' });
        expect(names['1']).toMatchObject({ name: 'ICMeow', source: 'vitals' });
        expect(names['0'].source).toBe('placeholder');
        expect(names['3'].source).toBe('placeholder');
        const wearingIt = Object.values(names).filter((entry) => entry.name === 'MillenniumTest');
        expect(wearingIt).toHaveLength(1);
    });

    test('a stored mislabel of the watcher’s name is dropped, not kept', () => {
        const names = resolveUnitNames({
            pMap: { 0: {}, 2: {} },
            known: { 0: { name: 'MillenniumTest', source: 'portrait' } },
            own: { slot: '2', name: 'MillenniumTest' },
        });

        expect(names['2']).toMatchObject({ name: 'MillenniumTest', source: 'own' });
        expect(names['0'].source).toBe('placeholder');
    });

    test('a duplicate across mixed sources keeps the stronger claim, correcting slots outside the tick', () => {
        // The roster states slot 0; a stale vitals match had put the same name
        // on slot 1 in an earlier tick. The correction is emitted even though
        // slot 1 is not in this tick's pMap, so the stored mislabel heals.
        const names = resolveUnitNames({
            pMap: { 0: {} },
            roster: { 0: { name: 'Tib', characterId: 7 } },
            known: { 1: { name: 'Tib', source: 'vitals' } },
        });

        expect(names['0']).toMatchObject({ name: 'Tib', source: 'roster' });
        expect(names['1']).toMatchObject({ source: 'placeholder' });
    });

    test('the on-screen name set forces the last pairing, and only the last', () => {
        // The players area names everyone — the watcher as a CombatUnit, the
        // rest as MiniUnit lines — without saying where. Set equality plus
        // injectivity forces a single remaining pairing; two remaining are a
        // guess and stay placeholders.
        const forced = resolveUnitNames({
            pMap: { 0: {}, 1: {} },
            roster: { 0: { name: 'Tib' } },
            partyNames: ['Moo', 'Tib'],
        });
        expect(forced['1']).toEqual({ name: 'Moo', source: 'elimination' });

        const ambiguous = resolveUnitNames({
            pMap: { 0: {}, 1: {}, 2: {} },
            roster: { 0: { name: 'Tib' } },
            partyNames: ['Moo', 'Tib', 'Zed'],
        });
        expect(ambiguous['1'].source).toBe('placeholder');
        expect(ambiguous['2'].source).toBe('placeholder');
    });

    test('the party name set reads CombatUnit and MiniUnit lines alike, as a set', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_playersArea__x">' +
            '<div class="CombatUnit_combatUnit__a"><div class="CombatUnit_name__b">MillenniumTest</div></div>' +
            '<div class="MiniUnit_miniUnit__c"><div class="MiniUnit_name__d">SarinTest</div></div>' +
            '<div class="MiniUnit_miniUnit__c"><div class="MiniUnit_name__d">Orven</div></div>' +
            '</div>';

        expect(fightViewPartyNames(document)).toEqual(['MillenniumTest', 'SarinTest', 'Orven']);
        document.body.innerHTML = '';
        expect(fightViewPartyNames(document)).toEqual([]);
    });
});

describe('elimination is bound by the same guard as every other source', () => {
    // The watcher's slot is unknown (`slot: null`), so their name is refused
    // everywhere outside the roster. A vitals match then labels the slot they
    // are actually sitting in with somebody else's name, which leaves their
    // own name unclaimed and one other slot unresolved — the exact shape
    // elimination fires on.
    const misplaced = {
        pMap: { 0: icmeow, 1: { mHP: 5 } },
        loadouts: [sheet('SarinTest', 2612, 2180)],
        partyNames: ['MillenniumTest', 'SarinTest'],
    };

    test('the watcher’s own name is not pinned to a foreign slot', () => {
        const names = resolveUnitNames({ ...misplaced, own: { slot: null, name: 'MillenniumTest' } });

        expect(names['0']).toEqual({ name: 'SarinTest', source: 'vitals' });
        expect(names['1'].source).toBe('placeholder');
        expect(Object.values(names).some((entry) => entry.name === 'MillenniumTest')).toBe(false);
    });

    test('the declined slot is reported as a placeholder, not as a name', () => {
        const names = resolveUnitNames({ ...misplaced, own: { slot: null, name: 'MillenniumTest' } });
        const coverage = nameCoverage(names);

        expect(coverage).toMatchObject({ named: 1, of: 2, placeholders: ['Player 2'] });
        expect(coverage.bySource.elimination).toBeUndefined();
    });

    test('with no watcher supplied the pairing is still forced', () => {
        const names = resolveUnitNames(misplaced);
        expect(names['1']).toEqual({ name: 'MillenniumTest', source: 'elimination' });
    });

    test('a name that is not the watcher’s is still forced onto the last slot', () => {
        const names = resolveUnitNames({
            pMap: { 0: {}, 1: {} },
            roster: { 0: { name: 'Tib' } },
            partyNames: ['Moo', 'Tib'],
            own: { slot: '0', name: 'Tib' },
        });

        expect(names['1']).toEqual({ name: 'Moo', source: 'elimination' });
    });

    test('the watcher’s own name is forced when the unresolved slot is their slot', () => {
        // Their slot is absent from this tick's pMap and held as a stored
        // placeholder, so the `own` rung never runs and elimination is what
        // reaches it — permitted, because the caller states that slot is theirs.
        const names = resolveUnitNames({
            pMap: { 0: {} },
            roster: { 0: { name: 'Tib' } },
            known: { 1: { name: 'Player 2', source: 'placeholder' } },
            partyNames: ['Tib', 'MillenniumTest'],
            own: { slot: '1', name: 'MillenniumTest' },
        });

        expect(names['1']).toEqual({ name: 'MillenniumTest', source: 'elimination' });
    });
});

describe('rosterFromBattle', () => {
    test('slot order is the join, and it is exact', () => {
        const roster = rosterFromBattle(NEW_GUILD_BATTLE);

        expect(Object.keys(roster)).toHaveLength(30);
        // Verified against the recording: a tick's `pMap` key "19" is players[19]
        expect(roster[19]).toEqual({ name: 'Player20', characterId: 900020 });
        expect(roster[0]).toEqual({ name: 'Player01', characterId: 900001 });
    });

    test('a payload with no roster on it gives none, rather than throwing', () => {
        expect(rosterFromBattle({})).toEqual({});
        expect(rosterFromBattle({ players: 'nope' })).toEqual({});
        expect(rosterFromBattle(null)).toEqual({});
    });

    test('a slot with no name is skipped rather than filled with a placeholder', () => {
        const roster = rosterFromBattle({ players: [{ character: { id: 1, name: 'Tib' } }, { character: {} }] });
        expect(Object.keys(roster)).toEqual(['0']);
    });

    test('a slot with an id but no name asks the resolver before giving up on it', () => {
        // Reported: a 48-player trial's own message carried the id but not the
        // name for a chunk of the roster, which is what turned real members
        // into "Player 7", "Player 10", "Player 36" on the damage panel
        const resolveName = (characterId) => (characterId === 42 ? 'Atlan' : null);
        const roster = rosterFromBattle(
            { players: [{ character: { id: 42 } }, { character: { id: 99 } }, { character: { id: 1, name: 'Tib' } }] },
            resolveName
        );

        expect(roster[0]).toEqual({ name: 'Atlan', characterId: 42 });
        // The resolver not knowing this one either is still no placeholder here —
        // a weaker source (vitals, portrait) gets the chance this module cannot
        expect(roster[1]).toBeUndefined();
        // A name the payload already stated is never sent through the resolver
        expect(roster[2]).toEqual({ name: 'Tib', characterId: 1 });
    });

    test('no resolver at all behaves exactly as before', () => {
        const roster = rosterFromBattle({ players: [{ character: { id: 42 } }] });
        expect(roster[0]).toBeUndefined();
    });
});

describe('the roster outranks everything', () => {
    const unit = { mHP: 2612, mMP: 2180 };

    test('a stated name beats a portrait and a build alike', () => {
        const names = resolveUnitNames({
            pMap: { 1: unit },
            roster: { 1: { name: 'Stated', characterId: 7 } },
            portraits: ['Tib', 'Portrait'],
            loadouts: [
                {
                    name: 'Vitals',
                    rows: [
                        { label: 'Max HP', value: '2,612' },
                        { label: 'Max MP', value: '2,180' },
                    ],
                },
            ],
        });

        expect(names['1']).toEqual({ name: 'Stated', source: 'roster', characterId: 7 });
    });

    test('and it restates a slot that had already been resolved', () => {
        // A new battle is a new roster; a slot that changed hands must not keep
        // the name the last one had
        const first = resolveUnitNames({ pMap: { 1: unit }, portraits: ['Tib', 'WasHere'] });
        const later = resolveUnitNames({ pMap: { 1: unit }, roster: { 1: { name: 'NowHere' } }, known: first });

        expect(later['1']).toMatchObject({ name: 'NowHere', source: 'roster' });
    });

    test('a slot the roster does not cover still falls through', () => {
        const names = resolveUnitNames({ pMap: { 4: unit }, roster: { 1: { name: 'Stated' } } });
        expect(names['4'].source).toBe('placeholder');
    });
});

describe('nameCoverage', () => {
    test('counts what was named and lists what was not', () => {
        const coverage = nameCoverage({
            0: { name: 'Tib', source: 'portrait' },
            1: { name: 'ICMeow', source: 'vitals' },
            2: { name: 'Player 3', source: 'placeholder' },
        });

        expect(coverage).toEqual({
            named: 2,
            of: 3,
            placeholders: ['Player 3'],
            bySource: { portrait: 1, vitals: 1, placeholder: 1 },
        });
    });

    test('nothing resolved is nothing claimed', () => {
        expect(nameCoverage(null)).toEqual({ named: 0, of: 0, placeholders: [], bySource: {} });
    });
});
