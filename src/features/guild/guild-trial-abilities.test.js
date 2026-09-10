/**
 * The trial-abilities session: what resets it, what does not, and what the
 * aura arithmetic is allowed to claim from a partial capture.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

/**
 * What storage answers with, and the last thing written to it.
 *
 * `keys` is the disk as the module actually sees it — one entry per storage
 * key — because which key a session is written to and read back from is
 * itself load-bearing: the guild's name arrives after the module initialises,
 * and a read under the wrong key is a session lost.
 */
const disk = vi.hoisted(() => ({ value: null, saved: null, keys: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key) => (key in disk.keys ? disk.keys[key] : disk.value),
        set: async (key, value) => {
            disk.saved = value;
            disk.keys[key] = value;
        },
        // The ability plan rides in the same store; nothing here is about it
        tryGet: async (key) => ({ found: key in disk.keys, value: disk.keys[key] ?? null }),
    },
}));

/** Which character the tab is showing; the fallback key is built from it */
const game = vi.hoisted(() => ({ characterId: null, items: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: {}, itemDetailMap: game.items }),
        getCurrentCharacterId: () => game.characterId,
    },
}));

const {
    GuildTrialAbilities,
    sessionStorageKey,
    SESSION_MAX_AGE_MS,
    TRIAL_START_GRACE_MS,
    playerKey,
    normalizeRoster,
    mergeStoredSessions,
    dropRenamedPlayerDuplicates,
    captureFor,
    classSheet,
    expectedAuraHrids,
    aggregateAuras,
    auraCoverage,
} = await import('./guild-trial-abilities.js');

const NOW = 1_800_000_000_000;

/** An aura in the shape `isAuraAbility` detects — never a hardcoded list */
const aura = (name) => ({
    name,
    isSpecialAbility: true,
    abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
});

/** A plain attack, and a self-only special, neither of which is an aura */
const attack = (name) => ({ name, isSpecialAbility: false, abilityEffects: [] });
const selfBuff = (name) => ({
    name,
    isSpecialAbility: true,
    abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'self', buffs: [{}] }],
});

const GAME = {
    '/abilities/fierce_aura': aura('Fierce Aura'),
    '/abilities/aqua_aura': aura('Aqua Aura'),
    '/abilities/sweep': attack('Sweep'),
    '/abilities/vampirism': selfBuff('Vampirism'),
};

/** An authoritative loadout snapshot, in the `extractLoadout` shape */
function snap(name, characterId, abilities, over = {}) {
    return {
        name,
        characterId,
        abilities,
        abilitiesAuthoritative: true,
        source: 'battle_unit_fetched',
        at: NOW,
        ...over,
    };
}

/** A session with a roster, ready to capture into */
function session(roster = ['Alice', 'Bob']) {
    const s = new GuildTrialAbilities();
    s.guildName = 'Cats';
    s.setRoster(roster);
    return s;
}

beforeEach(() => {
    disk.value = null;
    disk.saved = null;
    disk.keys = {};
    game.characterId = null;
    game.items = {};
});

describe('the key before the guild name is known', () => {
    test('two characters do not share the fallback key', () => {
        // The same leak the trial record and the recorder were fixed for:
        // everything collected before the name arrives went to
        // `guildTrialAbilities_default`, which both characters read back
        expect(sessionStorageKey(null, 30404)).not.toBe(sessionStorageKey(null, 99));
        // And a guild's own key is still shared, which is the point of it
        expect(sessionStorageKey('Milky Way', 30404)).toBe(sessionStorageKey('Milky Way', 99));
        // No character known at all is still the old shared bucket
        expect(sessionStorageKey(null)).toBe('guildTrialAbilities_default');
    });

    test('an alt does not read back the session captured before the name arrived', async () => {
        game.characterId = 30404;
        const main = new GuildTrialAbilities();
        await main.initialize(null);
        main.setRoster(['Alice', 'Bob']);
        main.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(disk.keys[sessionStorageKey(null, 30404)]).toBeTruthy();

        game.characterId = 99;
        const alt = new GuildTrialAbilities();
        await alt.initialize(null);
        expect(alt.session).toBeNull();

        // …and the main still finds its own on the next load
        game.characterId = 30404;
        const again = new GuildTrialAbilities();
        await again.initialize(null);
        expect(Object.keys(again.session?.players || {})).toEqual(['id:1']);
    });
});

describe('playerKey and roster plumbing', () => {
    test('characterId is the key; name only when there is no id', () => {
        expect(playerKey({ characterId: 7, name: 'Alice' })).toBe('id:7');
        expect(playerKey({ characterId: null, name: ' Alice ' })).toBe('name:alice');
    });

    test('normalizeRoster accepts names and objects and deduplicates', () => {
        expect(normalizeRoster(['Alice', { characterId: 2, name: 'Bob' }, 'Alice', '', null])).toEqual([
            { characterId: null, name: 'Alice' },
            { characterId: 2, name: 'Bob' },
        ]);
    });

    test('captureFor matches by id, by name key, and by name against id-keyed entries', () => {
        const players = {
            'id:1': { characterId: 1, name: 'Alice' },
            'name:bob': { characterId: null, name: 'Bob' },
        };
        expect(captureFor(players, { characterId: 1, name: 'Renamed' })).toBe(players['id:1']);
        expect(captureFor(players, { characterId: null, name: 'BOB' })).toBe(players['name:bob']);
        expect(captureFor(players, { characterId: null, name: 'alice' })).toBe(players['id:1']);
        expect(captureFor(players, { characterId: null, name: 'Cara' })).toBeNull();
    });
});

describe('session reset rules', () => {
    test('a capture past the 65-minute window starts a new session', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(s.session.startedAt).toBe(NOW);

        s.recordCapture(snap('Bob', 2, []), { at: NOW + SESSION_MAX_AGE_MS + 1 });
        expect(s.session.startedAt).toBe(NOW + SESSION_MAX_AGE_MS + 1);
        expect(Object.keys(s.session.players)).toEqual(['id:2']);
    });

    test('a tier change does NOT reset — mixed tiers accumulate on one session', () => {
        const s = session();
        s.setTier(4);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.setTier(5);
        s.recordCapture(snap('Bob', 2, []), { at: NOW + 60_000 });

        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toHaveLength(2);
        expect(s.session.captureTier).toBe(4);
        expect(s.session.capturedTiers).toEqual([4, 5]);
    });

    test('manual recapture throws the captures away', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.recapture(NOW + 1000);
        expect(s.session.players).toEqual({});
        expect(s.session.startedAt).toBe(NOW + 1000);
    });

    test('an explicit trial start resets, but not within the grace window', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });

        s.noteTrialStart(NOW + TRIAL_START_GRACE_MS - 1);
        expect(Object.keys(s.session.players)).toHaveLength(1);

        s.noteTrialStart(NOW + TRIAL_START_GRACE_MS + 1);
        expect(s.session.players).toEqual({});
    });

    test('a trial tick blanks a session from the previous trial, never the live one', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });

        // Per-tier re-fires inside the same trial change nothing
        s.noteTrialActivity(NOW + 30 * 60 * 1000);
        expect(Object.keys(s.session.players)).toHaveLength(1);
        expect(s.session.startedAt).toBe(NOW);

        // The next trial's first tick, a day later, opens onto a blank roster
        const nextTrial = NOW + 24 * 60 * 60 * 1000;
        s.noteTrialActivity(nextTrial);
        expect(s.session.players).toEqual({});
        expect(s.session.startedAt).toBe(nextTrial);
    });

    test('a trial that runs past the hour — skilling hour into combat hour — keeps its session while it ticks', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });

        // Ticks every ten minutes for two and a half hours: a skilling hour and
        // a combat hour back to back, with the session begun at the whistle
        let t = NOW;
        for (let i = 0; i < 15; i++) {
            t += 10 * 60 * 1000;
            s.noteTrialActivity(t);
        }
        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toHaveLength(1);

        // A capture well past the old sixty-five-minute clock lands in the same session
        s.recordCapture(snap('Bob', 2, []), { at: t, now: t });
        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toHaveLength(2);

        // And an explicit "trial start" while it is still ticking is not a new trial
        s.noteTrialStart(t + 1000);
        expect(s.session.startedAt).toBe(NOW);

        // Silence for longer than a trial, then a tick: that is the next one
        s.noteTrialActivity(t + SESSION_MAX_AGE_MS + 1);
        expect(s.session.players).toEqual({});
    });

    test('a trial tick with no session at all is a no-op', () => {
        const s = session();
        s.noteTrialActivity(NOW);
        expect(s.session).toBeNull();
    });

    test('a wrong-guild name drops the session; the same guild keeps it', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.session.guildName = 'Cats';

        s.setGuildName('Cats');
        expect(s.session).not.toBeNull();

        s.setGuildName('Dogs');
        expect(s.session).toBeNull();
    });

    test('a session started before the guild was known still goes on a guild change', () => {
        const s = session();
        s.setGuildName('Cats');
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        // `_start` stamps the guild it knew, which was none
        s.session.guildName = null;

        s.setGuildName('Dogs');
        expect(s.session).toBeNull();
    });

    test('the first name to arrive keeps a session recorded before it', () => {
        const s = session();
        s.setGuildName(null);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.session.guildName = null;

        s.setGuildName('Cats');
        expect(s.session).not.toBeNull();
    });
});

describe('join key and roster changes', () => {
    test('a slot reorder cannot transplant abilities: characterId keys the capture', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        // The roster reorders; Alice's row moves but her capture does not
        s.setRoster(['Bob', 'Alice']);
        const rows = s.participants();
        expect(rows[1].name).toBe('Alice');
        expect(rows[1].capture.abilities).toEqual([{ hrid: '/abilities/fierce_aura', level: 70 }]);
        expect(rows[0].capture).toBeNull();
    });

    test('a re-capture of the same characterId replaces in place', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/sweep', level: 10 }]), { at: NOW });
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/aqua_aura', level: 20 }]), { at: NOW + 1000 });
        expect(Object.keys(s.session.players)).toEqual(['id:1']);
        expect(s.session.players['id:1'].abilities).toEqual([{ hrid: '/abilities/aqua_aura', level: 20 }]);
    });

    test('an id-carrying capture adopts an earlier id-less sighting of the same name', () => {
        const s = session();
        s.recordCapture(snap('Alice', null, [], { abilitiesAuthoritative: false, source: 'popup' }), { at: NOW });
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/sweep', level: 5 }]), { at: NOW + 1000 });
        expect(Object.keys(s.session.players)).toEqual(['id:1']);
    });

    test('a joining participant adds exactly one outstanding capture', () => {
        const s = session(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(s.state(GAME).outstanding.map((row) => row.name)).toEqual(['Bob']);

        s.setRoster(['Alice', 'Bob', 'Cara']);
        expect(s.state(GAME).outstanding.map((row) => row.name)).toEqual(['Bob', 'Cara']);
    });

    test('a departed player keeps the capture and is marked not-current', () => {
        const s = session(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        s.setRoster(['Bob']);
        const view = s.state(GAME);
        expect(view.rosterCount).toBe(1);
        expect(view.capturedCount).toBe(0);
        expect(view.notCurrent.map((player) => player.name)).toEqual(['Alice']);
    });
});

describe('what counts as captured', () => {
    test('an authoritative empty kit is genuinely empty: captured, no auras', () => {
        const s = session(['Alice']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(1);
        expect(view.complete).toBe(true);
        expect(view.auras).toEqual({});
        expect(view.coverage['/abilities/fierce_aura']).toBe('missing');
    });

    test('a stat-only capture stays outstanding', () => {
        const s = session(['Alice']);
        s.recordCapture(snap('Alice', 1, [], { abilitiesAuthoritative: false, source: 'popup' }), { at: NOW });
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(0);
        expect(view.complete).toBe(false);
        expect(view.outstanding).toHaveLength(1);
        expect(view.coverage['/abilities/fierce_aura']).toBe('unknown');
    });

    test('a stat-only sighting never erases an authoritative kit', () => {
        const s = session(['Alice']);
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        s.recordCapture(snap('Alice', 1, [], { abilitiesAuthoritative: false, source: 'popup' }), { at: NOW + 500 });
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(1);
        expect(view.auras['/abilities/fierce_aura'].provider).toBe('Alice');
    });
});

describe('the finished trial survives a reload', () => {
    beforeEach(() => {
        disk.value = null;
        disk.saved = null;
    });

    /** A completed 2/2 session as an earlier page-load persisted it */
    const storedSession = (startedAt) => ({
        startedAt,
        guildName: 'Cats',
        captureTier: 4,
        capturedTiers: [4],
        completedAt: startedAt + 60_000,
        players: {
            'id:1': {
                characterId: 1,
                name: 'Alice',
                capturedAt: startedAt + 30_000,
                capturedTier: 4,
                source: 'battle_unit_fetched',
                abilitiesAuthoritative: true,
                abilities: [{ hrid: '/abilities/fierce_aura', level: 70 }],
            },
            'id:2': {
                characterId: 2,
                name: 'Bob',
                capturedAt: startedAt + 60_000,
                capturedTier: 4,
                source: 'battle_unit_fetched',
                abilitiesAuthoritative: true,
                abilities: [],
            },
        },
        roster: [
            { characterId: 1, name: 'Alice' },
            { characterId: 2, name: 'Bob' },
        ],
    });

    test('a session older than the trial hour is kept, roster and all', async () => {
        // Two hours on: the trial is over, and the completed 8/8 view is
        // exactly what the panel is asked for — until the next trial's first
        // capture starts a fresh session
        disk.value = storedSession(NOW - 2 * 60 * 60_000);

        const s = new GuildTrialAbilities();
        await s.initialize('Cats');

        expect(s.session?.startedAt).toBe(NOW - 2 * 60 * 60_000);
        expect(s.roster.map((member) => member.name)).toEqual(['Alice', 'Bob']);
        const view = s.state(GAME);
        expect(view.capturedCount).toBe(2);
        expect(view.complete).toBe(true);
        expect(view.auras['/abilities/fierce_aura'].provider).toBe('Alice');
    });

    test('a wrong-guild session is still not adopted', async () => {
        disk.value = storedSession(NOW - 10 * 60_000);

        const s = new GuildTrialAbilities();
        await s.initialize('Dogs');

        expect(s.session).toBeNull();
        expect(s.roster).toEqual([]);
    });

    test('the next trial’s first capture still starts a fresh session', async () => {
        disk.value = storedSession(NOW - 2 * 60 * 60_000);

        const s = new GuildTrialAbilities();
        await s.initialize('Cats');
        s.recordCapture(snap('Cara', 3, []), { at: NOW });

        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toEqual(['id:3']);
    });

    test('the roster rides along with every persisted session', () => {
        const s = session(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });

        expect(disk.saved?.roster?.map((member) => member.name)).toEqual(['Alice', 'Bob']);
    });
});

describe('the guild name arrives after the module does', () => {
    const CATS = 'guildTrialAbilities_Cats';

    /** A session on disk, as a page load would have written it */
    const onDisk = (startedAt, players, guildName = 'Cats') => ({
        startedAt,
        guildName,
        captureTier: 4,
        capturedTiers: [4],
        completedAt: null,
        players,
        roster: [
            { characterId: 1, name: 'Alice' },
            { characterId: 2, name: 'Bob' },
        ],
    });

    /** One captured player, as the session stores them */
    const stored = (characterId, name, at) => ({
        characterId,
        name,
        capturedAt: at,
        capturedTier: 4,
        source: 'battle_unit_fetched',
        abilitiesAuthoritative: true,
        abilities: [{ hrid: '/abilities/fierce_aura', level: 70 }],
    });

    test('a capture taken before the name arrived is found again on the next load', async () => {
        // The reported symptom: two players captured, a reload, and the panel
        // back at 0 — the writes went to the guild's key and the read did not
        const first = new GuildTrialAbilities();
        await first.initialize(null);
        first.setRoster(['Alice', 'Bob']);
        await first.setGuildName('Cats');
        first.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(disk.keys[CATS]).toBeTruthy();

        const next = new GuildTrialAbilities();
        await next.initialize(null);
        await next.setGuildName('Cats');

        expect(Object.keys(next.session?.players || {})).toEqual(['id:1']);
        expect(next.state(GAME).capturedCount).toBe(1);
    });

    test('a name arriving over a session in hand merges rather than strands it', async () => {
        disk.keys[CATS] = onDisk(NOW - 5 * 60_000, { 'id:2': stored(2, 'Bob', NOW - 4 * 60_000) });

        const s = new GuildTrialAbilities();
        await s.initialize(null);
        s.setRoster(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        await s.setGuildName('Cats');

        expect(Object.keys(s.session.players).sort()).toEqual(['id:1', 'id:2']);
        expect(s.session.startedAt).toBe(NOW - 5 * 60_000);
        expect(s.state(GAME).complete).toBe(true);
    });

    test('a capture landing while the restore is in flight is not swallowed by it', async () => {
        disk.keys[CATS] = onDisk(NOW - 10 * 60_000, { 'id:1': stored(1, 'Alice', NOW - 9 * 60_000) });

        const s = new GuildTrialAbilities();
        const pending = s.initialize('Cats');
        s.setRoster(['Alice', 'Bob']);
        s.recordCapture(snap('Bob', 2, []), { at: NOW });
        await pending;

        expect(Object.keys(s.session.players).sort()).toEqual(['id:1', 'id:2']);
    });

    test('a stored session from another guild is never merged in', async () => {
        disk.keys[CATS] = onDisk(NOW - 5 * 60_000, { 'id:2': stored(2, 'Bob', NOW - 4 * 60_000) }, 'Dogs');

        const s = new GuildTrialAbilities();
        await s.initialize(null);
        s.setRoster(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        await s.setGuildName('Cats');

        expect(Object.keys(s.session.players)).toEqual(['id:1']);
    });

    test('a previous trial’s stored session does not drag the start backwards', async () => {
        disk.keys[CATS] = onDisk(NOW - 3 * 60 * 60_000, { 'id:2': stored(2, 'Bob', NOW - 3 * 60 * 60_000) });

        const s = new GuildTrialAbilities();
        await s.initialize(null);
        s.setRoster(['Alice', 'Bob']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        await s.setGuildName('Cats');

        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players)).toEqual(['id:1']);
    });
});

describe('when a capture may end a session', () => {
    test('an old sheet folded in mid-trial does not restart the session', () => {
        // The adopt path hands over kits read minutes or an hour apart, all of
        // them arriving now. Only the arrival clock may end a session; the
        // stamp on the kit says when it was read, and nothing more
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW, now: NOW });
        s.recordCapture(snap('Bob', 2, []), { at: NOW + SESSION_MAX_AGE_MS + 1, now: NOW + 1000 });

        expect(s.session.startedAt).toBe(NOW);
        expect(Object.keys(s.session.players).sort()).toEqual(['id:1', 'id:2']);
    });

    test('a genuinely late arrival still starts the next trial’s session', () => {
        const s = session();
        s.recordCapture(snap('Alice', 1, []), { at: NOW, now: NOW });
        s.recordCapture(snap('Bob', 2, []), { at: NOW, now: NOW + SESSION_MAX_AGE_MS + 1 });

        expect(s.session.startedAt).toBe(NOW + SESSION_MAX_AGE_MS + 1);
        expect(Object.keys(s.session.players)).toEqual(['id:2']);
    });
});

describe('aura aggregation', () => {
    const captured = (name, characterId, abilities) => ({
        name,
        characterId,
        abilities,
        abilitiesAuthoritative: true,
    });

    test('expected auras come off the ability data, not a list', () => {
        expect(expectedAuraHrids(GAME).sort()).toEqual(['/abilities/aqua_aura', '/abilities/fierce_aura']);
    });

    test('highest level wins the provider slot; lower copies are redundant, listed once', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 60 }]),
                captured('Bob', 2, [{ hrid: '/abilities/fierce_aura', level: 78 }]),
                captured('Cara', 3, [{ hrid: '/abilities/fierce_aura', level: 40 }]),
            ],
            GAME
        );
        const fierce = auras['/abilities/fierce_aura'];
        expect(fierce.highestLevel).toBe(78);
        expect(fierce.provider).toBe('Bob');
        expect(fierce.duplicateCount).toBe(2);
        expect(fierce.providers.map((provider) => provider.name)).toEqual(['Bob', 'Alice', 'Cara']);
    });

    test('different aura hrids are never duplicates of each other', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 60 }]),
                captured('Bob', 2, [{ hrid: '/abilities/aqua_aura', level: 50 }]),
            ],
            GAME
        );
        expect(auras['/abilities/fierce_aura'].duplicateCount).toBe(0);
        expect(auras['/abilities/aqua_aura'].duplicateCount).toBe(0);
    });

    test('one player equipping the same hrid twice counts once', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [
                    { hrid: '/abilities/fierce_aura', level: 60 },
                    { hrid: '/abilities/fierce_aura', level: 60 },
                ]),
            ],
            GAME
        );
        expect(auras['/abilities/fierce_aura'].providers).toHaveLength(1);
        expect(auras['/abilities/fierce_aura'].duplicateCount).toBe(0);
    });

    test('non-auras and non-authoritative entries contribute nothing', () => {
        const auras = aggregateAuras(
            [
                captured('Alice', 1, [
                    { hrid: '/abilities/sweep', level: 99 },
                    { hrid: '/abilities/vampirism', level: 99 },
                ]),
                { name: 'Bob', characterId: 2, abilities: [{ hrid: '/abilities/fierce_aura', level: 70 }] },
            ],
            GAME
        );
        expect(auras).toEqual({});
    });

    test('missing only at full authoritative coverage; unknown before', () => {
        expect(auraCoverage({}, GAME, false)['/abilities/fierce_aura']).toBe('unknown');
        expect(auraCoverage({}, GAME, true)['/abilities/fierce_aura']).toBe('missing');
        const covered = { '/abilities/fierce_aura': { providers: [{ name: 'Alice' }] } };
        expect(auraCoverage(covered, GAME, false)['/abilities/fierce_aura']).toBe('covered');
    });
});

describe('exportSnapshot', () => {
    let s;
    beforeEach(() => {
        s = session(['Alice', 'Bob']);
        s.setTier(4);
    });

    test('a partial session exports unknownAuras, never missingAuras', () => {
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        const out = s.exportSnapshot(GAME);
        expect(out.complete).toBe(false);
        expect(out.completedAt).toBeNull();
        expect(out.missingAuras).toBeUndefined();
        expect(out.unknownAuras).toEqual(['/abilities/aqua_aura']);
        expect(out.auras['/abilities/fierce_aura'].provider).toBe('Alice');
    });

    test('a complete session names what is provably missing', () => {
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]), { at: NOW });
        s.setTier(5);
        s.recordCapture(snap('Bob', 2, [{ hrid: '/abilities/sweep', level: 50 }]), { at: NOW + 1000 });

        const out = s.exportSnapshot(GAME);
        expect(out.complete).toBe(true);
        expect(out.completedAt).toBe(NOW + 1000);
        expect(out.captureTier).toBe(4);
        expect(out.capturedTiers).toEqual([4, 5]);
        expect(out.missingAuras).toEqual(['/abilities/aqua_aura']);
        expect(out.unknownAuras).toEqual([]);
        expect(out.players['1']).toMatchObject({ name: 'Alice', capturedTier: 4, abilitiesAuthoritative: true });
        expect(out.players['2']).toMatchObject({ name: 'Bob', capturedTier: 5 });
    });

    test('a joiner after completion un-completes the export', () => {
        s.setRoster(['Alice']);
        s.recordCapture(snap('Alice', 1, []), { at: NOW });
        expect(s.exportSnapshot(GAME).complete).toBe(true);

        s.setRoster(['Alice', 'Cara']);
        const out = s.exportSnapshot(GAME);
        expect(out.complete).toBe(false);
        expect(out.completedAt).toBeNull();
        expect(out.missingAuras).toBeUndefined();
    });
});

describe('class tags from the ability stream', () => {
    /** Ability data with a style and an element on it, as `class-inference` reads */
    const STREAM_GAME = {
        ...GAME,
        '/abilities/fireball': {
            name: 'Fireball',
            abilityEffects: [
                {
                    effectType: '/ability_effect_types/damage',
                    combatStyleHrid: '/combat_styles/magic',
                    damageType: '/damage_types/fire',
                },
            ],
        },
        '/abilities/steady_shot': {
            name: 'Steady Shot',
            abilityEffects: [
                {
                    effectType: '/ability_effect_types/damage',
                    combatStyleHrid: '/combat_styles/ranged',
                    damageType: '/damage_types/physical',
                },
            ],
        },
        '/abilities/bloom': {
            name: 'Bloom',
            abilityEffects: [{ effectType: '/ability_effect_types/heal', targetType: 'lowestHpAlly' }],
        },
    };

    test('a member nobody has clicked still earns a tag from what they cast', () => {
        const s = session(['Alice', 'Bob']);
        s.noteTrialStart(NOW);
        s.noteAbilityCast('Alice', '/abilities/fireball');
        s.noteAbilityCast('Alice', '/abilities/fireball');

        const state = s.state(STREAM_GAME);
        const alice = state.participants.find((row) => row.name === 'Alice');

        // No capture at all — the row is still "needs Battle Info"
        expect(alice.captured).toBe(false);
        expect(alice.classTag).toMatchObject({ key: 'fireMage', label: 'Fire Mage' });
        expect(alice.classTag.evidence).toEqual(['/abilities/fireball']);
        // And a member nothing has been seen from stays blank rather than guessed
        expect(state.participants.find((row) => row.name === 'Bob').classTag).toBeNull();
    });

    test('the name key is case-insensitive, as the fight view’s spelling is not guaranteed', () => {
        const s = session(['Alice']);
        s.noteTrialStart(NOW);
        s.noteAbilityCast('alice', '/abilities/steady_shot');

        expect(s.state(STREAM_GAME).participants[0].classTag.key).toBe('ranged');
    });

    test('a healer is named by the heal, not by the damage they also do', () => {
        const s = session(['Alice']);
        s.noteTrialStart(NOW);
        s.noteAbilityCast('Alice', '/abilities/fireball');
        s.noteAbilityCast('Alice', '/abilities/bloom');

        expect(s.state(STREAM_GAME).participants[0].classTag.key).toBe('healer');
    });

    test('a real cast beats a bare threat number — the misclassification this guards against', () => {
        // Every sheet carries a nonzero threat reading; a captured mage with
        // an observed fireball must not be reclassified tank off that alone
        const s = session(['Alice']);
        s.noteTrialStart(NOW);
        s.noteAbilityCast('Alice', '/abilities/fireball');
        s.recordCapture(snap('Alice', 1, [], { stats: { threat: 4, combatStyleHrids: ['/combat_styles/smash'] } }), {
            at: NOW,
        });

        expect(s.state(STREAM_GAME).participants[0].classTag.key).toBe('fireMage');
    });

    test('threat on a captured sheet still tags a tank once nothing else is known', () => {
        const s = session(['Alice']);
        s.noteTrialStart(NOW);
        s.recordCapture(snap('Alice', 1, [], { stats: { threat: 4, combatStyleHrids: ['/combat_styles/smash'] } }), {
            at: NOW,
        });

        expect(s.state(STREAM_GAME).participants[0].classTag.key).toBe('tank');
    });

    test('a mage with an ordinary threat reading is not tank next to a party whose baseline sits near it', () => {
        // The reported scenario: atlan and bilibili both carried a moderate
        // Threat number and a mage kit — "guessed Fire Mage/Water Mage, Battle
        // Info says Tank" was the bug. A roster of several similar mages
        // establishes the baseline every one of them sits near, and the one
        // real tank sits well clear of it.
        const s = session(['Atlan', 'Bilibili', 'Cleric', 'Rogue', 'Tanky']);
        s.noteTrialStart(NOW);
        s.recordCapture(snap('Atlan', 1, [{ hrid: '/abilities/fireball' }], { stats: { threat: 208 } }), { at: NOW });
        s.recordCapture(snap('Bilibili', 2, [{ hrid: '/abilities/fireball' }], { stats: { threat: 195 } }), {
            at: NOW,
        });
        s.recordCapture(snap('Cleric', 3, [{ hrid: '/abilities/fireball' }], { stats: { threat: 220 } }), { at: NOW });
        s.recordCapture(snap('Rogue', 4, [{ hrid: '/abilities/fireball' }], { stats: { threat: 180 } }), { at: NOW });
        // The real tank: threat far above what everyone else's sheet shows,
        // and no damaging ability of their own to say otherwise
        s.recordCapture(snap('Tanky', 5, [], { stats: { threat: 1400 } }), { at: NOW });

        const state = s.state(STREAM_GAME);
        const byName = (name) => state.participants.find((row) => row.name === name).classTag.key;

        expect(byName('Atlan')).toBe('fireMage');
        expect(byName('Bilibili')).toBe('fireMage');
        expect(byName('Tanky')).toBe('tank');
    });

    test('a party threat baseline is what tells apart a blank-kit member near it from one well above it', () => {
        // No captured abilities for either — this exercises the baseline
        // arithmetic in guild-trial-abilities.js itself (rule 3 never fires
        // for either row), not the reordering covered above
        const s = session(['A', 'B', 'C', 'D', 'Tanky']);
        s.noteTrialStart(NOW);
        s.recordCapture(snap('A', 1, [], { stats: { threat: 200 } }), { at: NOW });
        s.recordCapture(snap('B', 2, [], { stats: { threat: 190 } }), { at: NOW });
        s.recordCapture(snap('C', 3, [], { stats: { threat: 210 } }), { at: NOW });
        s.recordCapture(snap('D', 4, [], { stats: { threat: 205 } }), { at: NOW });
        s.recordCapture(snap('Tanky', 5, [], { stats: { threat: 1400 } }), { at: NOW });

        const state = s.state(STREAM_GAME);
        const byName = (name) => state.participants.find((row) => row.name === name).classTag;

        expect(byName('A')).toBeNull();
        expect(byName('Tanky').key).toBe('tank');
    });

    test('the sheet’s own style tags a captured member whose casts were never streamed', () => {
        const s = session(['Alice']);
        s.noteTrialStart(NOW);
        s.recordCapture(
            snap('Alice', 1, [], { stats: { combatStyleHrids: ['/combat_styles/ranged'], damageType: '' } }),
            { at: NOW }
        );

        expect(s.state(STREAM_GAME).participants[0].classTag).toMatchObject({
            key: 'ranged',
            basis: expect.stringContaining('weapon style'),
        });
    });

    test('a new trial forgets the previous hour’s casts', () => {
        const s = session(['Alice']);
        s.noteTrialStart(NOW);
        s.noteAbilityCast('Alice', '/abilities/fireball');
        expect(s.state(STREAM_GAME).participants[0].classTag.key).toBe('fireMage');

        s.noteTrialStart(NOW + SESSION_MAX_AGE_MS + 1000);
        expect(s.state(STREAM_GAME).participants[0].classTag).toBeNull();
    });

    test('a captured player’s cast guess is checked against their Battle Info', () => {
        const s = session(['Alice', 'Bob', 'Cara']);
        s.noteTrialStart(NOW);
        // Alice casts fire and carries fire: agree. Bob casts fire but his
        // sheet is a healer's: disagree. Cara has cast nothing: untested
        s.noteAbilityCast('Alice', '/abilities/fireball');
        s.noteAbilityCast('Bob', '/abilities/fireball');
        s.recordCapture(snap('Alice', 1, [{ hrid: '/abilities/fireball' }]), { at: NOW });
        s.recordCapture(snap('Bob', 2, [{ hrid: '/abilities/bloom' }]), { at: NOW });
        s.recordCapture(snap('Cara', 3, [{ hrid: '/abilities/fireball' }]), { at: NOW });

        const state = s.state(STREAM_GAME);
        const byName = Object.fromEntries(state.participants.map((row) => [row.name, row.classCheck]));
        expect(byName.Alice.agree).toBe(true);
        expect(byName.Bob.agree).toBe(false);
        expect(byName.Bob.guess.key).toBe('fireMage');
        expect(byName.Bob.actual.key).toBe('healer');
        expect(byName.Cara.agree).toBeNull();
        expect(state.classChecks).toEqual({ agree: 1, disagree: 1, untested: 1 });
    });

    test('the captured sheet keeps the weapon passives, and drops a sheet that says nothing', () => {
        const kept = classSheet({ threat: 12, pierce: 0.3, curse: 0, criticalRate: 0.2 });
        expect(kept).toMatchObject({ threat: 12, pierce: 0.3 });
        // A zero passive is no passive, and an unrelated stat is nobody's business
        expect(kept.curse).toBeUndefined();
        expect(kept.criticalRate).toBeUndefined();

        // A passive alone is worth keeping — it is the whole crossbow fix
        expect(classSheet({ pierce: 0.3 })).toMatchObject({ pierce: 0.3 });
        expect(classSheet({ criticalRate: 0.2 })).toBeNull();
    });

    test('the crossbow case: the fetched sheet’s pierce passive outranks the melee kit', () => {
        // The game's own item data says what pierce means — a ranged weapon's
        // passive — and the reported failure was this exact unit: a crossbow
        // in hand, melee abilities slotted, tagged Melee off the kit
        game.items = {
            '/items/test_crossbow': {
                equipmentDetail: {
                    type: '/equipment_types/two_hand',
                    combatStats: {
                        combatStyleHrids: ['/combat_styles/ranged'],
                        damageType: '/damage_types/physical',
                        pierce: 0.3,
                    },
                },
            },
        };
        const MAP = {
            ...STREAM_GAME,
            '/abilities/cleave': {
                name: 'Cleave',
                abilityEffects: [
                    {
                        effectType: '/ability_effect_types/damage',
                        combatStyleHrid: '/combat_styles/slash',
                        damageType: '/damage_types/physical',
                    },
                ],
            },
        };
        const meleeKit = [{ hrid: '/abilities/cleave' }];

        // Never fetched: the kit is all there is, and the old answer stands
        const unfetched = session(['Alice']);
        unfetched.noteTrialStart(NOW);
        unfetched.recordCapture(snap('Alice', 1, meleeKit), { at: NOW });
        expect(unfetched.state(MAP).participants[0].classTag.key).toBe('melee');

        // Fetched: the Battle Info sheet carries the weapon's own passive
        const fetched = session(['Alice']);
        fetched.noteTrialStart(NOW);
        fetched.recordCapture(
            snap('Alice', 1, meleeKit, {
                stats: {
                    pierce: 0.3,
                    threat: 100,
                    combatStyleHrids: ['/combat_styles/ranged'],
                    damageType: '/damage_types/physical',
                },
            }),
            { at: NOW }
        );
        const tag = fetched.state(MAP).participants[0].classTag;
        expect(tag.key).toBe('ranged');
        expect(tag.basis).toContain('pierce');
    });

    test('a cast for a name with no session in hand starts no session', () => {
        const s = new GuildTrialAbilities();
        s.guildName = 'Cats';

        expect(s.noteAbilityCast('Alice', '/abilities/fireball')).toBe(true);
        expect(s.session).toBeNull();
    });

    test('classes() is the same verdicts keyed by lowercased name', () => {
        const s = session(['Alice', 'Bob']);
        s.noteTrialStart(NOW);
        s.noteAbilityCast('Alice', '/abilities/steady_shot');

        expect(s.classes(STREAM_GAME)).toEqual({ alice: expect.objectContaining({ key: 'ranged' }) });
        expect(s.state(STREAM_GAME).classes).toEqual(s.classes(STREAM_GAME));
    });
});

describe('merging two devices stored trial sessions', () => {
    const player = (name, extra = {}) => ({
        characterId: null,
        name,
        capturedAt: null,
        capturedTier: null,
        source: 'battle_unit_fetched',
        classStats: null,
        abilitiesAuthoritative: false,
        abilities: null,
        ...extra,
    });

    const session = (startedAt, players, extra = {}) => ({
        startedAt,
        lastActivityAt: startedAt,
        guildName: 'Some Guild',
        captureTier: null,
        capturedTiers: [],
        completedAt: null,
        players,
        roster: [],
        ...extra,
    });

    test('two devices each clicking half the party keep both halves', () => {
        const local = session(1000, { 'name:alice': player('Alice') }, { roster: ['Alice', 'Bob'] });
        const incoming = session(1200, { 'name:bob': player('Bob') }, { roster: ['Bob', 'Carol'] });

        const merged = mergeStoredSessions(local, incoming);

        expect(Object.keys(merged.players).sort()).toEqual(['name:alice', 'name:bob']);
        // The roster is the join key for every capture, so it is unioned too
        expect(merged.roster.map((member) => member.name).sort()).toEqual(['Alice', 'Bob', 'Carol']);
        expect(merged.startedAt).toBe(1000);
    });

    test('a stat-only sighting never demotes the other device authoritative kit', () => {
        const kit = [{ hrid: '/abilities/fierce_aura', level: 200 }];
        const captured = session(1000, {
            'name:alice': player('Alice', { abilities: kit, abilitiesAuthoritative: true, capturedAt: 1000 }),
        });
        const statOnly = session(1000, { 'name:alice': player('Alice') });

        for (const merged of [mergeStoredSessions(captured, statOnly), mergeStoredSessions(statOnly, captured)]) {
            expect(merged.players['name:alice'].abilitiesAuthoritative).toBe(true);
            expect(merged.players['name:alice'].abilities).toEqual(kit);
        }
    });

    test('sessions further apart than the trial hour are two trials, later wins', () => {
        const last = session(1_000_000, { 'name:alice': player('Alice') });
        const next = session(1_000_000 + SESSION_MAX_AGE_MS + 1, { 'name:bob': player('Bob') });

        expect(Object.keys(mergeStoredSessions(last, next).players)).toEqual(['name:bob']);
        expect(Object.keys(mergeStoredSessions(next, last).players)).toEqual(['name:bob']);
    });

    test('a session with no roster field merges without inventing one', () => {
        // Sessions persisted before the roster rode along carry no `roster`
        const legacy = { ...session(1000, { 'name:alice': player('Alice') }) };
        delete legacy.roster;
        const merged = mergeStoredSessions(legacy, session(1000, { 'name:bob': player('Bob') }, { roster: ['Bob'] }));

        expect(merged.roster.map((member) => member.name)).toEqual(['Bob']);
        expect(Object.keys(merged.players).sort()).toEqual(['name:alice', 'name:bob']);
    });

    test('an absent or startedAt-less side merges to the side that is usable', () => {
        const live = session(1000, { 'name:alice': player('Alice') });

        expect(mergeStoredSessions(null, live)).toBe(live);
        expect(mergeStoredSessions(live, null)).toBe(live);
        expect(mergeStoredSessions(live, { players: {} })).toBe(live);
        expect(mergeStoredSessions(null, null)).toBeNull();
    });

    test('capturedTiers are unioned rather than replaced', () => {
        const local = session(1000, {}, { capturedTiers: [3, 4], captureTier: 3 });
        const incoming = session(1000, {}, { capturedTiers: [4, 5], captureTier: 4 });

        expect(mergeStoredSessions(local, incoming).capturedTiers.sort()).toEqual([3, 4, 5]);
    });
});

describe('re-capture races across a merge', () => {
    const player = (name, extra = {}) => ({
        characterId: null,
        name,
        capturedAt: null,
        capturedTier: null,
        source: 'battle_unit_fetched',
        classStats: null,
        abilitiesAuthoritative: false,
        abilities: null,
        ...extra,
    });

    const session = (startedAt, players, extra = {}) => ({
        startedAt,
        lastActivityAt: startedAt,
        guildName: 'Some Guild',
        captureTier: null,
        capturedTiers: [],
        completedAt: null,
        players,
        roster: [],
        ...extra,
    });

    test('two authoritative captures of the same player: the newer capturedAt wins regardless of merge order', () => {
        const olderKit = [{ hrid: '/abilities/sweep', level: 5 }];
        const newerKit = [{ hrid: '/abilities/fierce_aura', level: 200 }];
        const staleSync = session(1000, {
            'name:alice': player('Alice', { abilities: olderKit, abilitiesAuthoritative: true, capturedAt: 1000 }),
        });
        const correctedLocal = session(1000, {
            'name:alice': player('Alice', { abilities: newerKit, abilitiesAuthoritative: true, capturedAt: 5000 }),
        });

        // Whichever side the more recent capture is passed as, it must win —
        // a pull that lands after a local re-capture must not resurrect the
        // kit that re-capture replaced
        for (const merged of [
            mergeStoredSessions(correctedLocal, staleSync),
            mergeStoredSessions(staleSync, correctedLocal),
        ]) {
            expect(merged.players['name:alice'].abilities).toEqual(newerKit);
            expect(merged.players['name:alice'].capturedAt).toBe(5000);
        }
    });
});

describe('a peer resurrecting a rekeyed player does not double the roster', () => {
    const player = (name, extra = {}) => ({
        characterId: null,
        name,
        capturedAt: null,
        capturedTier: null,
        source: 'battle_unit_fetched',
        classStats: null,
        abilitiesAuthoritative: false,
        abilities: null,
        ...extra,
    });

    const session = (startedAt, players, extra = {}) => ({
        startedAt,
        lastActivityAt: startedAt,
        guildName: 'Some Guild',
        captureTier: null,
        capturedTiers: [],
        completedAt: null,
        players,
        roster: [],
        ...extra,
    });

    test('the raw union still carries both keys (this is the bug, proven before the fix)', () => {
        // What `mergeSessions`'s player loop produces *before* the collapse
        // runs — a plain union of a local id-keyed player with a peer's
        // pre-rekey name-keyed sighting of the same person.
        const rawUnion = {
            'id:42': player('Alice', { characterId: 42 }),
            'name:alice': player('Alice'),
        };

        // Walking this roster the way any consumer does — by key — finds
        // Alice twice, once under each key. That is the double-counted row.
        const aliceRows = Object.entries(rawUnion).filter(([, entry]) => entry.name === 'Alice');
        expect(aliceRows).toHaveLength(2);
    });

    test('mergeSessions collapses a peer copy that never saw the rekey', () => {
        // Local device: recordCapture already rekeyed Alice onto her id and
        // dropped the name-only key.
        const local = session(1000, { 'id:42': player('Alice', { characterId: 42, capturedAt: 1000 }) });
        // Peer's stored copy predates the rekey it has not pulled yet.
        const stored = session(1000, { 'name:alice': player('Alice') });

        for (const merged of [mergeStoredSessions(local, stored), mergeStoredSessions(stored, local)]) {
            const aliceKeys = Object.keys(merged.players).filter((key) => merged.players[key].name === 'Alice');
            expect(aliceKeys).toEqual(['id:42']);
        }
    });

    test('the collapse keeps the counters from whichever side is missing them', () => {
        const kit = [{ hrid: '/abilities/fierce_aura', level: 200 }];
        // The id-keyed entry is freshly rekeyed and has not carried its kit
        // over yet; the resurrected name key still has it.
        const idOnly = session(1000, { 'id:42': player('Alice', { characterId: 42 }) });
        const nameHasTheKit = session(1000, {
            'name:alice': player('Alice', { abilities: kit, abilitiesAuthoritative: true, capturedAt: 900 }),
        });

        for (const merged of [mergeStoredSessions(idOnly, nameHasTheKit), mergeStoredSessions(nameHasTheKit, idOnly)]) {
            expect(Object.keys(merged.players)).toEqual(['id:42']);
            expect(merged.players['id:42'].abilitiesAuthoritative).toBe(true);
            expect(merged.players['id:42'].abilities).toEqual(kit);
            expect(merged.players['id:42'].characterId).toBe(42);
        }
    });

    test('the fold is order-independent', () => {
        const a = session(1000, { 'id:1': player('Alice', { characterId: 1 }) });
        const b = session(1000, { 'name:alice': player('Alice') });

        const ab = mergeStoredSessions(a, b);
        const ba = mergeStoredSessions(b, a);

        expect(Object.keys(ab.players)).toEqual(Object.keys(ba.players));
    });

    test('two different players who merely share a name are never collapsed', () => {
        // No id links these two rows to each other — an id-less "Bob" beside
        // an id-keyed "Bob" who really is a different Bob. Nothing here can
        // tell them apart except identity, so both must survive.
        const players = {
            'id:1': player('Bob', { characterId: 1 }),
            'id:2': player('Bob', { characterId: 2 }),
        };

        expect(dropRenamedPlayerDuplicates(players)).toEqual(players);
    });

    test('similar but not identical names are left alone', () => {
        const players = {
            'id:1': player('Bob', { characterId: 1 }),
            'name:bobby': player('Bobby'),
        };

        expect(dropRenamedPlayerDuplicates(players)).toEqual(players);
    });
});
