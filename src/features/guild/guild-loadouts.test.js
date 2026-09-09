/**
 * Loadout snapshots.
 *
 * The two things worth asserting: that a payload with no stat sheet on it
 * produces nothing at all — `battle_unit_fetched` arrives at the end of every
 * combat session carrying loot totals, and a record written from one would
 * replace a real sheet with an empty one dated now — and that the record keeps
 * the moment each sighting happened, because that is the whole honesty of the
 * feature.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    store: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => game.clientData },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));

const {
    buildLoadoutRows,
    STAT_ROWS,
    describeLoadoutAge,
    extractLoadout,
    extractPartyLoadouts,
    foldLoadout,
    guildLoadoutsStorageKey,
    isMonsterUnit,
    loadLoadouts,
    loadoutList,
    mergeLoadoutEntries,
    mergeLoadoutRecords,
    MAX_LOADOUTS,
    pruneCharacterOnlyLoadouts,
    purgeMonsterLoadouts,
    isItemName,
    readAbilities,
    saveLoadouts,
} = await import('./guild-loadouts.js');

const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A unit as `battle_unit_fetched` carries one.
 * @param {Object} overrides - Fields to override
 * @returns {Object} The message
 */
function unitMessage(overrides = {}) {
    return {
        unit: {
            character: { id: 'char-1', name: 'Tib' },
            combatDetails: {
                combatLevel: 150,
                maxHitpoints: 4120,
                totalArmor: 62,
                magicEvasionRating: 1240,
                combatStats: { combatRareFind: 0.12, criticalRate: 0.05, curse: 0 },
            },
            combatAbilities: [{ abilityHrid: '/abilities/fireball', level: 40 }],
            ...overrides,
        },
    };
}

describe('buildLoadoutRows', () => {
    test('keeps a flat rating of zero and drops a ratio of zero', () => {
        const rows = buildLoadoutRows({ totalArmor: 0 }, { curse: 0, criticalRate: 0.05 });
        const labels = rows.map((entry) => entry.label);

        expect(labels).toContain('Armor');
        expect(labels).not.toContain('Curse');
        expect(rows.find((entry) => entry.label === 'Crit rate').value).toBe('5.0%');
    });

    test('absent fields are absent rather than nought', () => {
        expect(buildLoadoutRows({}, {})).toEqual([]);
    });

    test('a flat rating is not a ratio — the live sheet, to the digit', () => {
        // Straight off `Toolasha.debug.exportTrialData()`: this player's rows
        // read "Tenacity 16579%" and "Threat 23922%", because every `combatStats`
        // entry was assumed to be a ratio. Two of them are ratings.
        const rows = buildLoadoutRows(
            {},
            {
                tenacity: 165.79080000000002,
                threat: 239.21999999999997,
                criticalRate: 0.20972800000000003,
                castSpeed: 0.1155,
                hpRegenPer10: 0.07166299999999999,
                combatRareFind: 0.632,
            }
        );
        const value = (label) => rows.find((entry) => entry.label === label)?.value;

        expect(value('Tenacity')).toBe('166');
        expect(value('Threat')).toBe('239');
        expect(value('Crit rate')).toBe('21%');
        expect(value('Cast speed')).toBe('12%');
        expect(value('HP regen /10s')).toBe('7.2%');
        expect(value('Rare find')).toBe('63%');
    });

    test('no row on the sheet reads as a hundredfold of itself', () => {
        // The audit, rather than the two rows that were caught: every ratio row
        // drawn from a plausible ratio stays under 1,000%, and every flat row
        // drawn from a plausible rating is not marked as a percentage at all
        const stats = Object.fromEntries(STAT_ROWS.map(({ key, percent }) => [key, percent ? 0.25 : 250]));
        for (const row of buildLoadoutRows({}, stats)) {
            const shown = Number(row.value.replace(/[%,]/g, ''));
            expect(shown).toBeLessThanOrEqual(1000);
        }
    });
});

describe('readAbilities', () => {
    test('names abilities through client data, and falls back to the hrid', () => {
        game.clientData = { abilityDetailMap: { '/abilities/fireball': { name: 'Fireball' } } };
        expect(readAbilities([{ abilityHrid: '/abilities/fireball', level: 40 }])).toEqual([
            { hrid: '/abilities/fireball', level: 40, label: 'Fireball' },
        ]);

        game.clientData = {};
        expect(readAbilities([{ abilityHrid: '/abilities/frost_surge' }])[0]).toMatchObject({
            label: 'frost surge',
            level: null,
        });
    });

    test('tolerates anything that is not a list', () => {
        expect(readAbilities(null)).toEqual([]);
        expect(readAbilities([{}, { abilityHrid: '' }])).toEqual([]);
    });
});

describe('extractLoadout', () => {
    beforeEach(() => {
        game.clientData = {};
    });

    test('reads a stat sheet off a fetched unit', () => {
        const loadout = extractLoadout(unitMessage(), { at: now });

        expect(loadout.name).toBe('Tib');
        expect(loadout.characterId).toBe('char-1');
        expect(loadout.level).toBe(150);
        expect(loadout.abilities).toHaveLength(1);
        expect(loadout.rows.map((entry) => entry.label)).toContain('Magic evasion');
        expect(loadout.stats.combatRareFind).toBeCloseTo(0.12);
        expect(loadout.at).toBe(now);
    });

    test('says whether the payload itself spoke about abilities', () => {
        // A `combatAbilities` array — even an empty one — is an authoritative
        // statement of the kit; a payload without it says nothing about it
        expect(extractLoadout(unitMessage()).abilitiesAuthoritative).toBe(true);
        expect(extractLoadout(unitMessage({ combatAbilities: [] })).abilitiesAuthoritative).toBe(true);
        expect(extractLoadout(unitMessage({ combatAbilities: undefined })).abilitiesAuthoritative).toBe(false);
    });

    test('the end-of-session message carries no sheet and produces nothing', () => {
        const message = { unit: { character: { name: 'Tib' }, totalLootMap: { 0: { itemHrid: '/items/coin' } } } };
        expect(extractLoadout(message)).toBeNull();
    });

    test('a monster is not a guild member', () => {
        expect(
            extractLoadout({ unit: { name: 'Chimerical Beast', combatDetails: { maxHitpoints: 900_000 } } })
        ).toBeNull();
    });

    test('an explicit player without a character object still counts', () => {
        const loadout = extractLoadout({
            unit: { name: 'Moo', isPlayer: true, combatDetails: { maxHitpoints: 900 } },
        });
        expect(loadout?.name).toBe('Moo');
    });

    test('nonsense in, null out', () => {
        expect(extractLoadout(null)).toBeNull();
        expect(extractLoadout({})).toBeNull();
        expect(extractLoadout({ unit: {} })).toBeNull();
    });
});

describe('the boss is not a guild member', () => {
    // Reported live: clicking the boss in the trial fight view fires
    // `battle_unit_fetched` exactly as clicking a member does, and the sheet was
    // filed under the roster — "Seen loadouts (4): Trial Chameleon Lv.110". In
    // the estimated damage split that is a 618,000-health monster's auto-attack
    // shared out as if it were somebody's build
    test('a trial boss is refused even when it arrives as a character', () => {
        const boss = {
            unit: {
                character: { name: 'Trial Chameleon' },
                combatDetails: { combatLevel: 110, maxHitpoints: 618_000, combatStats: { rangedDamage: 462 } },
            },
        };

        expect(isMonsterUnit(boss.unit)).toBe(true);
        expect(extractLoadout(boss)).toBeNull();
    });

    test('an hrid under /monsters/ is enough on its own', () => {
        expect(isMonsterUnit({ name: 'Something', combatMonsterHrid: '/monsters/chameleon' })).toBe(true);
        expect(isMonsterUnit({ name: 'Tib', hrid: '/characters/tib' })).toBe(false);
    });

    test('the five encounters are refused by name', () => {
        for (const name of ['Chameleon', 'Badger', 'Jellyfish', 'Hedgehog', 'Swarm']) {
            expect(isMonsterUnit({ name })).toBe(true);
        }
    });

    test('a member whose name merely contains one of them is not a monster', () => {
        // "Swarmy" is a person; the encounter list is matched as whole words
        expect(isMonsterUnit({ name: 'Swarmy' })).toBe(false);
        expect(isMonsterUnit({ name: 'Trialene' })).toBe(false);
    });

    test('what is already on disk is purged rather than filtered forever', () => {
        const record = {
            players: {
                tib: { name: 'Tib', at: 2 },
                'trial chameleon': { name: 'Trial Chameleon', at: 3 },
            },
        };

        const { record: cleaned, purged } = purgeMonsterLoadouts(record);
        expect(purged).toEqual(['Trial Chameleon']);
        expect(Object.keys(cleaned.players)).toEqual(['tib']);

        // Nothing to purge is the same object back, so no needless write
        expect(purgeMonsterLoadouts(cleaned).record).toBe(cleaned);
        expect(purgeMonsterLoadouts(null).purged).toEqual([]);
    });

    test('and is not listed even before the purge lands', () => {
        const list = loadoutList({ players: { a: { name: 'Tib', at: 2 }, b: { name: 'Trial Chameleon', at: 3 } } });
        expect(list.map((entry) => entry.name)).toEqual(['Tib']);
    });
});

describe('extractPartyLoadouts', () => {
    test('every player in a battle, and nothing else', () => {
        const loadouts = extractPartyLoadouts(
            {
                players: [
                    { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
                    { character: { name: 'Moo' } },
                ],
            },
            { at: now }
        );

        expect(loadouts).toHaveLength(1);
        expect(loadouts[0]).toMatchObject({ name: 'Tib', source: 'new_battle' });
    });
});

describe('foldLoadout', () => {
    test('the newest sighting wins, even when it is thinner', () => {
        const fat = { name: 'Tib', at: now, rows: [1, 2, 3], source: 'battle_unit_fetched' };
        const thin = { name: 'Tib', at: now + 1000, rows: [1], source: 'popup' };

        const record = foldLoadout(foldLoadout(null, fat), thin);
        expect(record.players.tib.source).toBe('popup');
    });

    test('an older sighting does not overwrite a newer one', () => {
        const newer = { name: 'Tib', at: now + 1000, rows: [1] };
        const older = { name: 'Tib', at: now, rows: [1, 2] };

        const record = foldLoadout(foldLoadout(null, newer), older);
        expect(record.players.tib.at).toBe(now + 1000);
    });

    test('the oldest sightings fall off the end', () => {
        let record = null;
        for (let index = 0; index < MAX_LOADOUTS + 5; index += 1) {
            record = foldLoadout(record, { name: `Player${index}`, at: now + index, rows: [1] });
        }

        expect(Object.keys(record.players)).toHaveLength(MAX_LOADOUTS);
        expect(record.players.player0).toBeUndefined();
    });

    test('a snapshot without a name changes nothing', () => {
        const record = foldLoadout({ players: { tib: { name: 'Tib', at: now } }, updatedAt: now }, null);
        expect(Object.keys(record.players)).toEqual(['tib']);
    });

    describe('the ability kit survives sightings that never looked at it', () => {
        const kit = [{ hrid: '/abilities/fireball', level: 40, label: 'Fireball' }];
        const socketSighting = {
            name: 'Tib',
            at: now,
            rows: [1, 2, 3],
            abilities: kit,
            abilitiesAuthoritative: true,
            source: 'battle_unit_fetched',
        };

        test('a popup scrape keeps the captured kit, its flag and its date', () => {
            const scrape = { name: 'Tib', at: now + 1000, rows: [1], abilities: [], source: 'popup' };
            const record = foldLoadout(foldLoadout(null, socketSighting), scrape);

            const stored = record.players.tib;
            // The stats are still newest-wins…
            expect(stored.source).toBe('popup');
            expect(stored.at).toBe(now + 1000);
            // …but the kit is the one the socket actually read, dated to then
            expect(stored.abilities).toEqual(kit);
            expect(stored.abilitiesAuthoritative).toBe(true);
            expect(stored.abilitiesAt).toBe(now);
        });

        test('a stat-only socket payload preserves the kit too', () => {
            const statOnly = {
                name: 'Tib',
                at: now + 1000,
                rows: [1],
                abilities: [],
                abilitiesAuthoritative: false,
                source: 'battle_unit_fetched',
            };
            const record = foldLoadout(foldLoadout(null, socketSighting), statOnly);

            expect(record.players.tib.abilities).toEqual(kit);
            expect(record.players.tib.abilitiesAuthoritative).toBe(true);
        });

        test('an authoritative empty array is a genuine empty kit and overwrites', () => {
            const unequipped = {
                name: 'Tib',
                at: now + 1000,
                rows: [1],
                abilities: [],
                abilitiesAuthoritative: true,
                source: 'battle_unit_fetched',
            };
            const record = foldLoadout(foldLoadout(null, socketSighting), unequipped);

            expect(record.players.tib.abilities).toEqual([]);
            expect(record.players.tib.abilitiesAuthoritative).toBe(true);
            expect(record.players.tib.abilitiesAt).toBe(now + 1000);
        });

        test('a newer authoritative kit replaces an older one, stamped to its own moment', () => {
            const newer = { ...socketSighting, at: now + 5000, abilities: [{ hrid: '/abilities/frost_surge' }] };
            const record = foldLoadout(foldLoadout(null, socketSighting), newer);

            expect(record.players.tib.abilities).toEqual([{ hrid: '/abilities/frost_surge' }]);
            expect(record.players.tib.abilitiesAt).toBe(now + 5000);
        });

        test('a record stored before the flag existed is treated as non-authoritative', () => {
            const legacy = { players: { tib: { name: 'Tib', at: now, abilities: kit } }, updatedAt: now };
            const scrape = { name: 'Tib', at: now + 1000, rows: [1], abilities: [], source: 'popup' };

            // No stored flag, so newest-wins stands exactly as it did before
            const record = foldLoadout(legacy, scrape);
            expect(record.players.tib.abilities).toEqual([]);
            expect(record.players.tib.abilitiesAuthoritative).toBe(false);
        });
    });
});

describe('loadoutList', () => {
    test('most recently seen first', () => {
        const record = { players: { a: { name: 'A', at: 1 }, b: { name: 'B', at: 2 } } };
        expect(loadoutList(record).map((entry) => entry.name)).toEqual(['B', 'A']);
    });

    test('an empty record is an empty list, not a crash', () => {
        expect(loadoutList(null)).toEqual([]);
        expect(loadoutList({ players: 'nonsense' })).toEqual([]);
    });
});

describe('the list is not rebuilt per tick', () => {
    beforeEach(() => {
        game.store = {};
        game.clientData = {};
    });

    test('the same record gives back the same list, however often it is asked', () => {
        // `guild-trial-damage.js` asks for this on every `guild_battle_updated`
        // message, and a real trial carries 150,642 of them in an hour. The
        // record changes only when a stat sheet is captured
        const record = { players: { a: { name: 'A', at: 1 }, b: { name: 'B', at: 2 } } };

        const first = loadoutList(record);
        expect(loadoutList(record)).toBe(first);
        expect(loadoutList(record)).toBe(first);
        expect(first.map((entry) => entry.name)).toEqual(['B', 'A']);
    });

    test('a capture that changes the record is a different list', () => {
        // Every path that writes the capture's record replaces the object, so
        // identity is the invalidation — `foldLoadout` is the one a sighting
        // takes
        const record = { players: { a: { name: 'A', at: 1 } } };
        const first = loadoutList(record);

        const folded = foldLoadout(record, { name: 'B', at: 2, rows: [], stats: {} });
        const second = loadoutList(folded);

        expect(second).not.toBe(first);
        expect(second.map((entry) => entry.name)).toEqual(['B', 'A']);
    });

    test('the game data arriving mid-session rebuilds it', () => {
        // A list built before `combatMonsterDetailMap` landed judged its
        // entries without it; the same record must not keep that answer once
        // the game can say "Salamander is a monster"
        const record = { players: { s: { name: 'Salamander', at: 1 }, t: { name: 'Tib', at: 2 } } };
        expect(loadoutList(record).map((entry) => entry.name)).toEqual(['Tib', 'Salamander']);

        game.clientData = { combatMonsterDetailMap: { '/monsters/salamander': { name: 'Salamander' } } };
        expect(loadoutList(record).map((entry) => entry.name)).toEqual(['Tib']);
    });

    test('a name already judged is not parsed again', () => {
        // The name half of `isMonsterUnit` was a regex `replace`, a regex
        // `test`, and then a fresh `split` per combat encounter — five regex
        // passes for an answer that cannot change while the game data holds
        const split = vi.spyOn(String.prototype, 'split');
        try {
            expect(isMonsterUnit({ name: 'Giant Mantis' })).toBe(false);
            expect(split.mock.calls.length).toBeGreaterThan(0);

            split.mockClear();
            expect(isMonsterUnit({ name: 'Giant Mantis' })).toBe(false);
            expect(split.mock.calls.length).toBe(0);
        } finally {
            split.mockRestore();
        }
    });
});

describe('describeLoadoutAge', () => {
    test('says when, and says so even when it cannot', () => {
        expect(describeLoadoutAge(now - 60_000, now)).toMatch(/^seen /);
        expect(describeLoadoutAge(null)).toMatch(/unknown/);
    });
});

describe('storage', () => {
    beforeEach(() => {
        game.store = {};
    });

    test('round-trips under the viewing character’s key', async () => {
        const record = foldLoadout(null, { name: 'Tib', at: now, rows: [1] });
        await saveLoadouts('char-1', record);

        expect(game.store[guildLoadoutsStorageKey('char-1')]).toBeDefined();
        expect((await loadLoadouts('char-1')).players.tib.name).toBe('Tib');
    });

    test('an empty record is not written over a real one', async () => {
        await saveLoadouts('char-1', foldLoadout(null, { name: 'Tib', at: now, rows: [1] }));
        await saveLoadouts('char-1', { players: {}, updatedAt: 0 });

        expect((await loadLoadouts('char-1')).players.tib).toBeDefined();
    });

    test('an alt reads its own record, not this one’s', async () => {
        await saveLoadouts('char-1', foldLoadout(null, { name: 'Tib', at: now, rows: [1] }));
        expect(await loadLoadouts('char-2')).toEqual({ players: {}, updatedAt: 0 });
    });

    test('each guild keeps its own key, once the guild is known', async () => {
        // The reported leak: the character changed guild and "Seen loadouts"
        // still listed the previous guild's people 18 hours later — one
        // character-wide bucket cannot tell two guilds' sightings apart
        expect(guildLoadoutsStorageKey('char-1')).toBe('guildLoadouts_char-1');
        expect(guildLoadoutsStorageKey('char-1', 'Testmaxxing')).toBe('guildLoadouts_char-1_Testmaxxing');

        await saveLoadouts('char-1', foldLoadout(null, { name: 'Cream', at: now, rows: [1] }), 'OldGuild');
        await saveLoadouts('char-1', foldLoadout(null, { name: 'Rick', at: now, rows: [1] }), 'NewGuild');

        expect((await loadLoadouts('char-1', 'OldGuild')).players.cream).toBeDefined();
        expect((await loadLoadouts('char-1', 'NewGuild')).players.cream).toBeUndefined();
        expect((await loadLoadouts('char-1', 'NewGuild')).players.rick).toBeDefined();
    });
});

describe('the game’s own monster list', () => {
    beforeEach(() => {
        game.store = {};
        game.clientData = {
            combatMonsterDetailMap: {
                '/monsters/salamander': { name: 'Salamander' },
                '/monsters/giant_scorpion': { name: 'Giant Scorpion' },
                '/monsters/shadow_archer': { name: 'Shadow Archer' },
            },
        };
    });

    test('a zone monster’s Battle Info sheet is refused, name only', () => {
        // Not a trial encounter and not carrying a `/monsters/` hrid — the
        // popup scrape has neither. Only the game data says what it is
        expect(isMonsterUnit({ name: 'Giant Scorpion' })).toBe(true);
        expect(isMonsterUnit({ name: 'shadow archer' })).toBe(true);
        expect(isMonsterUnit({ name: 'Tib' })).toBe(false);
    });

    test('a monster payload never becomes a loadout', () => {
        const monster = {
            unit: {
                isPlayer: true,
                name: 'Salamander',
                combatDetails: { combatLevel: 90, maxHitpoints: 5000, combatStats: {} },
                combatAbilities: [],
            },
        };
        expect(extractLoadout(monster, { at: now })).toBeNull();
    });

    test('stored monster sheets are purged, whatever they are called', () => {
        const record = {
            players: {
                salamander: { name: 'Salamander', at: now, rows: [] },
                'giant scorpion': { name: 'Giant Scorpion', at: now, rows: [] },
                tib: { name: 'Tib', at: now, rows: [] },
            },
            updatedAt: now,
        };
        const { record: cleaned, purged } = purgeMonsterLoadouts(record);

        expect(purged.sort()).toEqual(['Giant Scorpion', 'Salamander']);
        expect(Object.keys(cleaned.players)).toEqual(['tib']);
    });

    test('with no game data loaded the older name checks still stand', () => {
        game.clientData = {};
        expect(isMonsterUnit({ name: 'Trial Chameleon' })).toBe(true);
        expect(isMonsterUnit({ name: 'Salamander' })).toBe(false);
    });
});

describe('the character-only key stops being a mixing bowl', () => {
    beforeEach(() => {
        game.store = {};
        game.clientData = {};
    });

    test('what the guild key holds is dropped from the character-only key', async () => {
        await saveLoadouts('char-1', {
            players: {
                tib: { name: 'Tib', at: now, rows: [] },
                legacy: { name: 'Legacy', at: now - 1, rows: [] },
            },
            updatedAt: now,
        });

        const dropped = await pruneCharacterOnlyLoadouts('char-1', {
            players: { tib: { name: 'Tib', at: now, rows: [] } },
        });

        expect(dropped).toEqual(['Tib']);
        const left = await loadLoadouts('char-1');
        expect(left.players.tib).toBeUndefined();
        expect(left.players.legacy).toBeDefined();
    });

    test('a character-only record the guild key has never seen is left alone', async () => {
        await saveLoadouts('char-1', { players: { legacy: { name: 'Legacy', at: now, rows: [] } }, updatedAt: now });
        expect(await pruneCharacterOnlyLoadouts('char-1', { players: {} })).toEqual([]);
        expect((await loadLoadouts('char-1')).players.legacy).toBeDefined();
    });

    test('pruning may empty the record, which the ordinary save refuses to write', async () => {
        await saveLoadouts('char-1', { players: { tib: { name: 'Tib', at: now, rows: [] } }, updatedAt: now });
        await pruneCharacterOnlyLoadouts('char-1', { players: { tib: { name: 'Tib', at: now, rows: [] } } });

        expect((await loadLoadouts('char-1')).players).toEqual({});
    });
});

describe('merging two devices loadout records', () => {
    const sighting = (name, at, extra = {}) => ({
        name,
        characterId: null,
        level: 100,
        rows: [],
        abilities: [],
        abilitiesAuthoritative: false,
        stats: {},
        source: 'battle_unit_fetched',
        at,
        ...extra,
    });

    test('the union keeps both devices halves of the roster', () => {
        const local = { players: { alice: sighting('Alice', 1000) }, updatedAt: 1000 };
        const incoming = { players: { bob: sighting('Bob', 2000) }, updatedAt: 2000 };

        const merged = mergeLoadoutRecords(local, incoming);

        expect(Object.keys(merged.players).sort()).toEqual(['alice', 'bob']);
        expect(merged.updatedAt).toBe(2000);
    });

    test('the same player resolves to the later sighting, in either direction', () => {
        const older = { players: { alice: sighting('Alice', 1000, { level: 100 }) } };
        const newer = { players: { alice: sighting('Alice', 5000, { level: 120 }) } };

        expect(mergeLoadoutRecords(older, newer).players.alice.level).toBe(120);
        expect(mergeLoadoutRecords(newer, older).players.alice.level).toBe(120);
    });

    test('a fresher stat-only sighting does not demote an authoritative kit', () => {
        const kit = [{ hrid: '/abilities/fierce_aura', level: 200, label: 'Fierce Aura' }];
        const authoritative = {
            players: {
                alice: sighting('Alice', 1000, { abilities: kit, abilitiesAuthoritative: true, abilitiesAt: 1000 }),
            },
        };
        const statOnly = { players: { alice: sighting('Alice', 9000, { abilities: [] }) } };

        for (const merged of [
            mergeLoadoutRecords(authoritative, statOnly),
            mergeLoadoutRecords(statOnly, authoritative),
        ]) {
            // The newer sheet, and the only kit anybody actually read
            expect(merged.players.alice.at).toBe(9000);
            expect(merged.players.alice.abilities).toEqual(kit);
            expect(merged.players.alice.abilitiesAuthoritative).toBe(true);
            expect(merged.players.alice.abilitiesAt).toBe(1000);
        }
    });

    test('an authoritative empty kit read later does replace an older one', () => {
        const old = {
            players: {
                alice: sighting('Alice', 1000, {
                    abilities: [{ hrid: '/abilities/fierce_aura', level: 200 }],
                    abilitiesAuthoritative: true,
                    abilitiesAt: 1000,
                }),
            },
        };
        const fresh = {
            players: {
                alice: sighting('Alice', 4000, { abilities: [], abilitiesAuthoritative: true, abilitiesAt: 4000 }),
            },
        };

        expect(mergeLoadoutRecords(old, fresh).players.alice.abilities).toEqual([]);
    });

    test('a legacy entry with no abilitiesAt falls back to its sighting time', () => {
        // Records written before `abilitiesAt` existed carry only `at`
        const legacy = {
            players: {
                alice: sighting('Alice', 8000, { abilities: [{ hrid: '/abilities/x' }], abilitiesAuthoritative: true }),
            },
        };
        const newerKit = {
            players: {
                alice: sighting('Alice', 9000, {
                    abilities: [{ hrid: '/abilities/y' }],
                    abilitiesAuthoritative: true,
                    abilitiesAt: 9000,
                }),
            },
        };

        expect(mergeLoadoutRecords(legacy, newerKit).players.alice.abilities).toEqual([{ hrid: '/abilities/y' }]);
        // …and the legacy kit still wins over a stamped kit that is older
        const olderKit = {
            players: {
                alice: sighting('Alice', 500, {
                    abilities: [{ hrid: '/abilities/z' }],
                    abilitiesAuthoritative: true,
                    abilitiesAt: 500,
                }),
            },
        };
        expect(mergeLoadoutRecords(olderKit, legacy).players.alice.abilities).toEqual([{ hrid: '/abilities/x' }]);
    });

    test('an absent side merges to the side that exists', () => {
        expect(mergeLoadoutEntries(null, sighting('Alice', 1)).name).toBe('Alice');
        expect(mergeLoadoutEntries(sighting('Alice', 1), null).name).toBe('Alice');
        expect(mergeLoadoutRecords(null, { players: { a: sighting('A', 1) } }).players.a.name).toBe('A');
        expect(mergeLoadoutRecords({ players: { a: sighting('A', 1) } }, null).players.a.name).toBe('A');
    });

    test('the union is still capped, oldest sightings first', () => {
        const half = (prefix, offset) =>
            Object.fromEntries(
                Array.from({ length: MAX_LOADOUTS }, (_, index) => [
                    `${prefix}${index}`,
                    sighting(`${prefix}${index}`, offset + index),
                ])
            );
        const merged = mergeLoadoutRecords({ players: half('a', 0) }, { players: half('b', 100_000) });

        expect(Object.keys(merged.players)).toHaveLength(MAX_LOADOUTS);
        // The newer half survived
        expect(Object.keys(merged.players).every((key) => key.startsWith('b'))).toBe(true);
    });
});

describe('isItemName', () => {
    test('an item name with its display dressing is recognised', () => {
        game.clientData = { itemDetailMap: { '/items/chance_cape': { name: 'Chance Cape' } } };
        expect(isItemName('Chance Cape ★')).toBe(true);
        expect(isItemName('Chance Cape +7')).toBe(true);
        expect(isItemName('Chance Cape')).toBe(true);
        expect(isItemName('ActualPlayer')).toBe(false);
        expect(isItemName('')).toBe(false);
    });

    test('the purge drops an item filed as a member', () => {
        game.clientData = { itemDetailMap: { '/items/chance_cape': { name: 'Chance Cape' } } };
        const record = {
            players: {
                'chance cape ★': { name: 'Chance Cape ★', rows: [] },
                real: { name: 'Real', rows: [] },
            },
        };
        const { record: cleaned, purged } = purgeMonsterLoadouts(record);
        expect(purged).toEqual(['Chance Cape ★']);
        expect(Object.keys(cleaned.players)).toEqual(['real']);
    });
});
