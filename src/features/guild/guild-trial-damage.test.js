/** @vitest-environment happy-dom */

/**
 * Per-player damage in a guild combat trial.
 *
 * The arithmetic is `utils/damage-attribution.js`' and is tested there. What is
 * worth asserting here is the thing this module actually adds: the gate. A
 * feature that credits the wrong fights is worse than one that credits none, so
 * most of this file is about battles that must *not* count.
 *
 * A DOM is opted into for the whole file rather than a few tests, because the
 * spectated path reads the fight view's own tiles to work out *which* trial is
 * being watched — and that identification is exactly what the panels get wrong
 * when it is missing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    wsHandlers: {},
    loadouts: [],
    ownName: null,
    ownId: null,
    // The identity read, indirected so a test can make the character change
    // *between* two reads of it — the swap race `_ownIdentity` has to survive.
    // Null means "answer with `ownId`", which is every other test.
    readOwnId: null,
    storedRoster: null,
    storedStats: null,
    casts: [],
    // characterId → name, as `guildXPTracker.memberMeta` would answer it —
    // the whole-guild roster (and its trial sign-ups), kept regardless of
    // whether this trial's own messages ever named the id themselves
    guildMembers: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getCurrentCharacterName: () => game.ownName,
        getCurrentCharacterId: () => (game.readOwnId ? game.readOwnId() : game.ownId),
    },
}));
// The roster persistence reaches IndexedDB through the store; here it is a
// field on the fixture, so a test can seed "a previous session wrote this"
vi.mock('./guild-trials-store.js', () => ({
    loadTrialRoster: async () => game.storedRoster,
    saveTrialRoster: async (entry) => {
        game.storedRoster = entry;
        return true;
    },
    loadTrialStats: async () => game.storedStats || { weekStart: 0, trials: {} },
    saveTrialStats: async (blob) => {
        game.storedStats = blob;
        return true;
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
// The spectated path resolves unit names against the captured builds, which live
// in IndexedDB and are never what a test here is about
vi.mock('./guild-loadout-capture.js', () => ({
    guildLoadoutCapture: { seen: () => game.loadouts, forPlayer: () => null },
    default: { seen: () => game.loadouts, forPlayer: () => null },
}));

// The class accumulator reaches storage through the abilities session; here it
// is a list, so a test can assert what the stream fed it
vi.mock('./guild-trial-abilities.js', () => ({
    default: {
        noteAbilityCast: (name, hrid) => {
            game.casts.push([name, hrid]);
            return true;
        },
    },
}));

// The whole-guild roster this module falls back to for an id its own
// messages never happened to name. Kept as a fixture map rather than the
// real singleton, whose `guild_updated` wiring is not what this file tests.
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getMemberMeta: (characterId) => {
            const name = game.guildMembers[String(characterId)];
            return name ? { name } : null;
        },
    },
}));

const {
    attributionCoverage,
    battleMonsterNames,
    bossHpCeiling,
    compareTrialStats,
    encounterOf,
    encounterOfMonster,
    encounterComponentMap,
    estimateDamageSplit,
    GUILD_BATTLE_MESSAGE,
    guildTrialDamage,
    isTrialBattle,
    MIN_SECONDS,
    liveTrialSplit,
    SPECTATED_TRIAL_NOTE,
    summariseTrialDamage,
    TRIAL_BADGE_WINDOW_MS,
} = await import('./guild-trial-damage.js');

/** The six ticks the wire capture kept, byte for byte */
const { TRIAL_WIRE_DUMP: wireDump } = await import('./guild-trial-wire-dump.fixture.js');

/** And the five message types a later, fuller recording found */
const { END_GUILD_BATTLE, GUILD_BATTLE_TICKS, NEW_GUILD_BATTLE } = await import('./guild-trial-messages.fixture.js');

/**
 * One player in a tick, with the counters attribution reads.
 * @param {number} atk - Attack counter
 * @param {number} hp - Current health
 * @returns {Object} A `pMap` entry
 */
function player(atk, hp = 100) {
    // Auto-attacking rather than idle: a hit credited while nothing is being
    // prepared is a lingering effect, and `foldEvents` drops it by default
    return { atkCounter: atk, cHP: hp, isAutoAtk: true };
}

/**
 * One monster in a tick.
 * @param {number} hp - Current health
 * @param {number} damageCount - Damage counter
 * @returns {Object} An `mMap` entry
 */
function monster(hp, damageCount) {
    return { cHP: hp, dmgCounter: damageCount, critCounter: 0 };
}

describe('encounterOf', () => {
    test('finds the encounter in a card name', () => {
        expect(encounterOf('Trial Chameleon')).toBe('chameleon');
        expect(encounterOf('Jellyfish Lv.170')).toBe('jellyfish');
    });

    test('is null for anything else', () => {
        expect(encounterOf('Milking')).toBeNull();
        expect(encounterOf('')).toBeNull();
        expect(encounterOf(null)).toBeNull();
    });
});

describe('encounterOfMonster — composite trials', () => {
    // Trial Swarm fights four differently named monsters, none of which reduces to
    // 'swarm'. The game's trial→monster listing is what names them.
    const clientData = {
        guildTrialDetailMap: {
            '/guild_trials/swarm': {
                name: 'Trial Swarm',
                monsterHrids: [
                    '/monsters/trial_beetle',
                    '/monsters/trial_dragonfly',
                    '/monsters/trial_wasp',
                    '/monsters/trial_firefly',
                ],
            },
            '/guild_trials/jellyfish': { name: 'Trial Jellyfish', monsterHrids: ['/monsters/trial_jellyfish'] },
        },
        combatMonsterDetailMap: { '/monsters/trial_dragonfly': { name: 'Trial Dragonfly' } },
    };

    test('resolves Swarm from any of its four monsters, by display name or hrid', () => {
        expect(encounterOfMonster('Trial Dragonfly', clientData)).toBe('swarm');
        expect(encounterOfMonster('/monsters/trial_beetle', clientData)).toBe('swarm');
        expect(encounterOfMonster('/monsters/trial_firefly', clientData)).toBe('swarm');
    });

    test('a single-monster trial still resolves by its own name, with no data needed', () => {
        expect(encounterOfMonster('Trial Jellyfish', clientData)).toBe('jellyfish');
        expect(encounterOfMonster('Trial Chameleon')).toBe('chameleon');
    });

    test('a non-trial monster is still null', () => {
        expect(encounterOfMonster('Cow', clientData)).toBeNull();
    });

    test('the component map covers only monsters that do not resolve on their own', () => {
        const map = encounterComponentMap(clientData);
        expect(map.get('trial dragonfly')).toBe('swarm');
        expect(map.get('trial wasp')).toBe('swarm');
        // Trial Jellyfish resolves by its own name, so it is never in the map.
        expect(map.has('trial jellyfish')).toBe(false);
    });
});

describe('isTrialBattle', () => {
    test('a monster that says it is a trial arms the tally on its own', () => {
        const verdict = isTrialBattle({ monsterNames: ['Trial Hedgehog'], trialNames: [] });
        expect(verdict.isTrial).toBe(true);
        expect(verdict.encounter).toBe('hedgehog');
    });

    test('this week’s encounter counts', () => {
        const verdict = isTrialBattle({ monsterNames: ['Chameleon'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(true);
        expect(verdict.encounter).toBe('chameleon');
    });

    test('a different encounter does not', () => {
        const verdict = isTrialBattle({ monsterNames: ['Badger'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(false);
    });

    test('an ordinary zone does not, and says why', () => {
        const verdict = isTrialBattle({ monsterNames: ['Chimerical Beast'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(false);
        expect(verdict.reason).toMatch(/not this week/i);
        // Names what it saw and what it wanted: the reason as it stood could not
        // be acted on from a bug report, which is how a broken gate survived
        expect(verdict.reason).toContain('Chimerical Beast');
        expect(verdict.reason).toContain('chameleon');
    });

    test('an hrid is as good as a name', () => {
        const verdict = isTrialBattle({
            monsterNames: ['/monsters/chameleon'],
            trialNames: ['Trial Chameleon'],
        });
        expect(verdict.isTrial).toBe(true);
        expect(verdict.encounter).toBe('chameleon');
    });

    test('with no combat trial on record nothing but a named trial counts', () => {
        expect(isTrialBattle({ monsterNames: ['Chameleon'], trialNames: [] }).isTrial).toBe(false);
        expect(isTrialBattle({ monsterNames: ['Chameleon'], trialNames: ['Milking'] }).isTrial).toBe(false);
    });
});

describe('battleMonsterNames', () => {
    test('reads the name the payload carries', () => {
        expect(battleMonsterNames({ monsters: [{ name: 'Trial Swarm' }] })).toEqual(['Trial Swarm']);
    });

    test('every spelling, not the first one that exists', () => {
        // The live payload carries both, and the display name is the one that a
        // localised client changes — taking it and stopping threw away the only
        // stable identifier the battle had
        game.clientData = { combatMonsterDetailMap: { '/monsters/chameleon': { name: 'Chameleon' } } };
        const names = battleMonsterNames({
            monsters: [{ hrid: '/monsters/chameleon', name: 'Chamäleon' }],
        });
        expect(names).toContain('/monsters/chameleon');
        expect(names).toContain('Chamäleon');
        expect(names).toContain('Chameleon');
    });

    test('falls back to the hrid, through client data where it has it', () => {
        game.clientData = { combatMonsterDetailMap: { '/monsters/trial_badger': { name: 'Trial Badger' } } };
        expect(battleMonsterNames({ monsters: { 0: { combatMonsterHrid: '/monsters/trial_badger' } } })).toEqual([
            '/monsters/trial_badger',
            'Trial Badger',
        ]);

        game.clientData = {};
        expect(battleMonsterNames({ monsters: { 0: { hrid: '/monsters/trial_badger' } } })).toEqual([
            '/monsters/trial_badger',
        ]);
    });

    test('a fight this client would otherwise not have recognised, from the live export', () => {
        // The reported case: the party was visibly fighting the week's combat
        // trial and the gate reported "the monsters are not this week's trial
        // encounter", with fights: 0. An hrid nobody looked at said otherwise.
        game.clientData = {};
        const names = battleMonsterNames({
            monsters: [{ hrid: '/monsters/trial_chameleon', isPlayer: false }],
        });
        expect(isTrialBattle({ monsterNames: names, trialNames: ['Trial Chameleon'] })).toMatchObject({
            isTrial: true,
            encounter: 'chameleon',
        });
    });
});

describe('bossHpCeiling', () => {
    test('sums every boss’s health bar and counts them', () => {
        const sheets = {
            1: { maxHitpoints: 664125 },
            2: { maxHitpoints: 724500 },
            3: { maxHitpoints: 784875 },
        };
        expect(bossHpCeiling(sheets)).toEqual({ hp: 2173500, fights: 3 });
    });

    test('skips sheets with no usable health', () => {
        const sheets = { 1: { maxHitpoints: 664125 }, 2: { maxHitpoints: null }, 3: {} };
        expect(bossHpCeiling(sheets)).toEqual({ hp: 664125, fights: 1 });
    });

    test('an empty or missing map is a zero ceiling, not a throw', () => {
        expect(bossHpCeiling({})).toEqual({ hp: 0, fights: 0 });
        expect(bossHpCeiling(null)).toEqual({ hp: 0, fights: 0 });
    });

    test('a multi-enemy tier counts its whole wave, not the representative bar', () => {
        // A two-badger tier records both bars as waveHitpoints; the ceiling must
        // use that, or a party total that dropped both reads as over-attributing.
        const sheets = {
            1: { maxHitpoints: 479895, waveHitpoints: 959790 },
            2: { maxHitpoints: 552000, waveHitpoints: 1104000 },
        };
        expect(bossHpCeiling(sheets)).toEqual({ hp: 2063790, fights: 2 });
    });

    test('falls back to the single bar when no wave total was recorded', () => {
        const sheets = { 1: { maxHitpoints: 479895, waveHitpoints: null } };
        expect(bossHpCeiling(sheets)).toEqual({ hp: 479895, fights: 1 });
    });
});

describe('summariseTrialDamage', () => {
    test('shares are of the party’s attributed damage', () => {
        const summary = summariseTrialDamage({
            tally: {
                0: { damage: 750, hits: 10, crits: 2, misses: 0 },
                1: { damage: 250, hits: 5, crits: 0, misses: 5 },
            },
            names: { 0: 'Tib', 1: 'Moo' },
            deaths: { 1: 2 },
            seconds: 100,
        });

        expect(summary.players.map((entry) => entry.name)).toEqual(['Tib', 'Moo']);
        expect(summary.players[0].share).toBeCloseTo(75);
        expect(summary.players[0].dps).toBeCloseTo(7.5);
        expect(summary.players[1].deaths).toBe(2);
        expect(summary.players[1].accuracy).toBeCloseTo(0.5);
        expect(summary.totalDamage).toBe(1000);
    });

    test('a rate needs enough of a fight to divide by', () => {
        const summary = summariseTrialDamage({
            tally: { 0: { damage: 10, hits: 1, crits: 0, misses: 0 } },
            seconds: 1,
        });
        expect(summary.players[0].dps).toBeNull();
        expect(summary.partyDps).toBeNull();
        // The share is still real — it needs no clock
        expect(summary.players[0].share).toBeCloseTo(100);
    });

    test('no swings is not a nought per cent hit rate', () => {
        const summary = summariseTrialDamage({ tally: { 0: { damage: 0, hits: 0, crits: 0, misses: 0 } } });
        expect(summary.players[0].accuracy).toBeNull();
        expect(summary.players[0].critRate).toBeNull();
    });

    test('the per-ability split the tally already keeps is surfaced on the row', () => {
        // `foldEvents` files every attributed event under `byAbility`; the
        // scoreboard's expandable rows read it off the player row in the same
        // shape the run-side tracker uses — biggest first, action named
        const summary = summariseTrialDamage({
            tally: {
                0: {
                    damage: 600,
                    hits: 12,
                    crits: 2,
                    misses: 1,
                    byAbility: {
                        auto: { damage: 200, hits: 8, crits: 1, misses: 1 },
                        '/abilities/fireball': { damage: 400, hits: 4, crits: 1, misses: 0 },
                    },
                },
            },
            names: { 0: 'Tib' },
            seconds: 100,
        });

        expect(summary.players[0].abilities).toEqual([
            { action: '/abilities/fireball', damage: 400, hits: 4, crits: 1, misses: 0 },
            { action: 'auto', damage: 200, hits: 8, crits: 1, misses: 1 },
        ]);
    });

    test('a tally row with no per-ability map carries an empty list, not a crash', () => {
        const summary = summariseTrialDamage({ tally: { 0: { damage: 10, hits: 1, crits: 0, misses: 0 } } });
        expect(summary.players[0].abilities).toEqual([]);
    });
});

describe('attributionCoverage', () => {
    test('three names under a party of seven is partial, and says how partial', () => {
        // The export that prompted this: a spectated Chameleon with seven on the
        // roster, three of whom earned a damage row because the stream carried no
        // other player's counters and only a lone-present tick could be split
        const coverage = attributionCoverage({
            participants: 7,
            roster: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
            players: [
                { name: 'BOOB', damage: 7783 },
                { name: 'RICK', damage: 6933 },
                { name: 'NPD', damage: 5181 },
            ],
            countedNames: [],
        });
        expect(coverage).toEqual({ party: 7, attributed: 3, counterConfirmed: 0, partial: true });
    });

    test('a full party is not partial', () => {
        const coverage = attributionCoverage({
            participants: 2,
            players: [
                { name: 'Tib', damage: 600 },
                { name: 'Moo', damage: 400 },
            ],
            countedNames: ['Tib'],
        });
        expect(coverage.partial).toBe(false);
        expect(coverage.counterConfirmed).toBe(1);
    });

    test('a party of unknown size cannot claim coverage, so it is not partial', () => {
        const coverage = attributionCoverage({
            participants: null,
            roster: {},
            players: [{ name: 'BOOB', damage: 7783 }],
        });
        expect(coverage.party).toBeNull();
        expect(coverage.partial).toBe(false);
    });

    test('the roster stands in when the party size was never stated', () => {
        const coverage = attributionCoverage({
            roster: { 0: {}, 1: {}, 2: {}, 3: {} },
            players: [{ name: 'BOOB', damage: 7783 }],
        });
        expect(coverage.party).toBe(4);
        expect(coverage.partial).toBe(true);
    });

    test('a row with no damage is not counted as attributed', () => {
        const coverage = attributionCoverage({
            participants: 3,
            players: [
                { name: 'BOOB', damage: 7783 },
                { name: 'Ghost', damage: 0 },
            ],
        });
        expect(coverage.attributed).toBe(1);
        expect(coverage.partial).toBe(true);
    });
});

describe('the live tracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        game.clientData = {};
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Chameleon']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    /**
     * Drive one trial fight: two players, one of whom does all the swinging.
     * @param {string} monsterName - What is being fought
     */
    function fight(monsterName) {
        game.wsHandlers.new_battle({
            battleId: 7,
            monsters: [{ name: monsterName }],
            players: [
                { character: { name: 'Tib' }, isPreparingAutoAttack: true },
                { character: { name: 'Moo' }, isPreparingAutoAttack: true },
            ],
        });

        game.wsHandlers.battle_updated({
            battleId: 7,
            pMap: { 0: player(1), 1: player(1) },
            mMap: { 0: monster(1000, 0) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 7,
            pMap: { 0: player(2) },
            mMap: { 0: monster(600, 1) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 7,
            pMap: { 1: player(2) },
            mMap: { 0: monster(400, 2) },
        });
    }

    test('splits a trial fight per player', () => {
        fight('Trial Chameleon');

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.active).toBe(true);
        expect(breakdown.encounter).toBe('chameleon');
        expect(breakdown.totalDamage).toBe(600);

        const byName = Object.fromEntries(breakdown.players.map((entry) => [entry.name, entry.damage]));
        expect(byName).toEqual({ Tib: 400, Moo: 200 });
    });

    test('an ordinary zone is not attributed at all', () => {
        fight('Chimerical Beast');

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.active).toBe(false);
        expect(breakdown.measured).toBe(false);
        expect(breakdown.totalDamage).toBe(0);
    });

    test('the zone after a trial does not inherit the trial’s tally', () => {
        fight('Trial Chameleon');
        const before = guildTrialDamage.breakdown().totalDamage;

        game.wsHandlers.new_battle({
            battleId: 8,
            monsters: [{ name: 'Chimerical Beast' }],
            players: [{ character: { name: 'Tib' }, isPreparingAutoAttack: true }],
        });
        game.wsHandlers.battle_updated({
            battleId: 8,
            pMap: { 0: player(9) },
            mMap: { 0: monster(1_000_000, 0) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 8,
            pMap: { 0: player(10) },
            mMap: { 0: monster(1, 1) },
        });

        expect(guildTrialDamage.breakdown().totalDamage).toBe(before);
    });

    test('a fight already under way when the page loaded counts for nothing', () => {
        game.wsHandlers.battle_updated({
            battleId: 42,
            pMap: { 0: player(1) },
            mMap: { 0: monster(500, 1) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 42,
            pMap: { 0: player(2) },
            mMap: { 0: monster(100, 2) },
        });

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.totalDamage).toBe(0);
        expect(breakdown.reason).toMatch(/already under way/i);
    });

    test('deaths come off the same feed', () => {
        fight('Trial Chameleon');
        game.wsHandlers.battle_updated({ battleId: 7, pMap: { 1: player(2, 0) }, mMap: {} });

        const moo = guildTrialDamage.breakdown().players.find((entry) => entry.name === 'Moo');
        expect(moo.deaths).toBe(1);
    });

    test('a tier is a new fight and adds to the same trial', () => {
        fight('Trial Chameleon');
        const first = guildTrialDamage.breakdown().totalDamage;

        game.wsHandlers.new_battle({
            battleId: 9,
            monsters: [{ name: 'Trial Chameleon' }],
            players: [
                { character: { name: 'Tib' }, isPreparingAutoAttack: true },
                { character: { name: 'Moo' }, isPreparingAutoAttack: true },
            ],
        });
        game.wsHandlers.battle_updated({ battleId: 9, pMap: { 0: player(5) }, mMap: { 0: monster(900, 0) } });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({ battleId: 9, pMap: { 0: player(6) }, mMap: { 0: monster(800, 1) } });

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.totalDamage).toBe(first + 100);
        expect(breakdown.fights).toBe(2);
    });

    test('the week’s trial name arriving mid-fight arms the tally', () => {
        // The record learns this week's combat card when the guild panel is
        // first drawn, which is routinely after the party has started swinging.
        // Deciding only on `new_battle` left that whole fight unattributed.
        guildTrialDamage.setTrialNames([]);
        game.wsHandlers.new_battle({
            battleId: 11,
            monsters: [{ hrid: '/monsters/chameleon', name: 'Chameleon' }],
            players: [{ character: { name: 'Tib' }, isPreparingAutoAttack: true }],
        });
        expect(guildTrialDamage.breakdown().active).toBe(false);

        guildTrialDamage.setTrialNames(['Trial Chameleon']);

        const armed = guildTrialDamage.breakdown();
        expect(armed.active).toBe(true);
        expect(armed.encounter).toBe('chameleon');
        expect(armed.fights).toBe(1);

        game.wsHandlers.battle_updated({ battleId: 11, pMap: { 0: player(5) }, mMap: { 0: monster(900, 0) } });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({ battleId: 11, pMap: { 0: player(6) }, mMap: { 0: monster(800, 1) } });
        expect(guildTrialDamage.breakdown().totalDamage).toBe(100);
    });

    test('what the fight was called is carried into the breakdown', () => {
        fight('Chimerical Beast');
        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.monsterNames).toContain('Chimerical Beast');
        expect(breakdown.trialNames).toEqual(['Trial Chameleon']);
    });

    test('a reading older than the hour a trial runs for is withdrawn', () => {
        fight('Trial Chameleon');
        expect(guildTrialDamage.breakdown().measured).toBe(true);

        vi.advanceTimersByTime(2 * 60 * 60 * 1000);
        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.stale).toBe(true);
        expect(breakdown.measured).toBe(false);
    });

    test('a slot re-dealt to a different player at the next tier is not a revive of the last one', () => {
        // Tib dies in slot 0 at the end of the tier
        game.wsHandlers.new_battle({
            battleId: 20,
            monsters: [{ name: 'Trial Chameleon' }],
            players: [{ character: { name: 'Tib' }, isPreparingAutoAttack: true }],
        });
        game.wsHandlers.battle_updated({
            battleId: 20,
            pMap: { 0: { atkCounter: 1, cHP: 1923, mHP: 1923, isAutoAtk: true } },
            mMap: { 0: monster(1_000_000, 0) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 20,
            pMap: { 0: { atkCounter: 1, cHP: 0, mHP: 1923, isAutoAtk: true } },
            mMap: { 0: monster(999_000, 1) },
        });

        // The next tier's own `new_battle` re-deals slot 0 to a different
        // player, entering full — not the same player coming back from zero
        game.wsHandlers.new_battle({
            battleId: 21,
            monsters: [{ name: 'Trial Chameleon' }],
            players: [{ character: { name: 'Moo' }, isPreparingAutoAttack: true }],
        });
        game.wsHandlers.battle_updated({
            battleId: 21,
            pMap: { 0: { atkCounter: 1, cHP: 1923, mHP: 1923, isAutoAtk: true } },
            mMap: { 0: monster(618_000, 0) },
        });

        const moo = guildTrialDamage.breakdown().support.players.find((entry) => entry.name === 'Moo');
        expect(moo.revives).toBe(0);
        expect(moo.healingReceived).toBe(0);
    });
});

/**
 * The split nobody can measure.
 *
 * The fallback when nobody has watched the fight. The gate above never arms —
 * a trial is not on this client's own battle feed — and until somebody opens the
 * In Progress fight view there is nothing streamed either, so this is what the
 * panels draw. Everything here is about it being *labelled* an estimate and
 * about nobody being quietly dropped from it.
 */
describe('estimateDamageSplit', () => {
    /**
     * A captured sheet.
     * @param {string} name - Whose
     * @param {number} damage - `autoAttackDamage`
     * @param {number} at - When it was captured
     * @returns {Object} A loadout snapshot
     */
    const sheet = (name, damage, at = 1) => ({
        name,
        at,
        // Nanoseconds on the wire, as the recorded sheets show: 3s a swing
        stats: { attackInterval: 3_000_000_000, autoAttackDamage: damage },
    });

    test('shares the members’ own sheets out, biggest first', () => {
        const split = estimateDamageSplit({
            loadouts: [sheet('Moo', 0.3), sheet('Tib', 0.9)],
            members: ['Tib', 'Moo'],
        });

        expect(split.players.map((row) => row.name)).toEqual(['Tib', 'Moo']);
        expect(split.players[0].dps).toBeCloseTo(0.3, 9); // 0.9 over 3s
        expect(split.players[0].share).toBeCloseTo(75, 6);
        expect(split.total).toBeCloseTo(0.4, 9);
    });

    test('a member with no captured build is named, not dropped', () => {
        // A leaderboard that silently omits three people reads as three people
        // who did nothing
        const split = estimateDamageSplit({
            loadouts: [sheet('Tib', 0.9)],
            members: ['Tib', 'Ada', 'Moo'],
        });

        expect(split.players.map((row) => row.name)).toEqual(['Tib']);
        expect(split.unestimated).toEqual(['Ada', 'Moo']);
        expect(split.covered).toBe(1);
        expect(split.of).toBe(3);
    });

    test('with no roster it covers whoever has been seen', () => {
        const split = estimateDamageSplit({ loadouts: [sheet('Tib', 0.9), sheet('Moo', 0.3)] });
        expect(split.of).toBe(2);
        expect(split.unestimated).toEqual([]);
    });

    test('a sheet that cannot say is unestimated rather than zero', () => {
        const split = estimateDamageSplit({
            loadouts: [{ name: 'Tib', stats: { attackInterval: 0, autoAttackDamage: 0.9 } }],
            members: ['Tib'],
        });

        expect(split.players).toEqual([]);
        expect(split.unestimated).toEqual(['Tib']);
        expect(split.total).toBe(0);
    });

    test('the oldest sheet is reported, because a build is a photograph', () => {
        const split = estimateDamageSplit({ loadouts: [sheet('Tib', 0.9, 500), sheet('Moo', 0.3, 200)] });
        expect(split.oldestAt).toBe(200);
    });

    test('nothing at all is an empty split rather than a throw', () => {
        expect(estimateDamageSplit().players).toEqual([]);
        expect(estimateDamageSplit({}).of).toBe(0);
    });
});

describe('the reason a split is never measured', () => {
    test('says the mechanic rather than implying a fight was missed', () => {
        expect(SPECTATED_TRIAL_NOTE).toContain('fight view has been opened');
        // Observed live: the stream keeps flowing while other tabs are
        // browsed, so the note must not claim only an open-view stretch counts
        expect(SPECTATED_TRIAL_NOTE).toContain('keeps flowing');
        expect(SPECTATED_TRIAL_NOTE).not.toContain('simulated');

        const verdict = isTrialBattle({ monsterNames: ['Granite Golem'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(false);
        expect(verdict.reason).toContain('fight view');
        // And still carries what the payload called them, for the next report
        expect(verdict.reason).toContain('Granite Golem');
    });

    test('a guild party during the trial hour is still not a trial fight', () => {
        // The battles a client sees during the hour are its own grinding, guild
        // party or not — counting them would report an evening as the trial
        const verdict = isTrialBattle({
            monsterNames: ['/monsters/magnetic_golem', 'Stalactite Golem'],
            trialNames: ['Trial Chameleon'],
        });
        expect(verdict.isTrial).toBe(false);
    });
});

/**
 * The spectator stream, replayed from the capture that found it.
 *
 * Every tick here is one the game actually sent — six consecutive
 * `guild_battle_updated` messages from a minute of watching a T2 Trial
 * Chameleon, kept verbatim in `guild-trial-wire-dump.fixture.json`. Asserting
 * against invented ticks would test the invention.
 */
describe('the spectated trial fight', () => {
    const at = new Date('2026-08-05T22:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Chameleon']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    /**
     * Replay the capture, a quarter of a second apart as the game sends it.
     * @param {number} [count] - How many of the six ticks to send
     */
    function replay(count = wireDump.length) {
        wireDump.slice(0, count).forEach((tick, index) => {
            vi.setSystemTime(at + index * 250);
            game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        });
    }

    test('the stream is listened to at all', () => {
        expect(typeof game.wsHandlers[GUILD_BATTLE_MESSAGE]).toBe('function');
    });

    test('the boss’s own bar is read to the unit, and is the pool', () => {
        replay();

        const { pool } = guildTrialDamage.breakdown();
        // The last tick of the capture, and 618,000 is the T2 Chameleon pool
        expect(pool).toMatchObject({ current: 453_402, max: 618_000, tier: 2 });
    });

    test('a tick with several enemies sums them into one pool', () => {
        // A two-badger wave: the pool is their combined health, not the first bar,
        // or the clear reads at half the HP it takes to finish the tier
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 9,
            tier: 1,
            pMap: {},
            mMap: { 0: { cHP: 300_000, mHP: 590_640 }, 1: { cHP: 445_376, mHP: 590_640 } },
        });

        const { pool } = guildTrialDamage.breakdown();
        expect(pool.current).toBe(745_376);
        expect(pool.max).toBe(1_181_280);
    });

    test('a tick carrying one monster of the wave does not re-price the pool as that monster', () => {
        // The stream is a *delta* stream: in an hour of Trial Swarm, 42,844 of
        // 58,139 ticks carried exactly one of the four monsters and only 4,237
        // carried all of them. Summing "every monster in this tick" therefore
        // published a pool of whatever subset happened to arrive — a four-monster
        // wave reading as one monster's bar — and the panel's five-second sampler
        // then read every one of those jumps as a boss cleared. See `_readPool`.
        const wave = {
            battleId: 9,
            tier: 1,
            pMap: {},
            mMap: {
                0: { cHP: 300_000, mHP: 300_000 },
                1: { cHP: 200_000, mHP: 200_000 },
                2: { cHP: 100_000, mHP: 100_000 },
                3: { cHP: 50_000, mHP: 50_000 },
            },
        };
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wave);
        // …and then a tick about slot 1 alone, which is what the stream mostly sends
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({ ...wave, mMap: { 1: { cHP: 190_000, mHP: 200_000 } } });

        const { pool } = guildTrialDamage.breakdown();
        expect(pool.max).toBe(650_000);
        expect(pool.current).toBe(640_000);
    });

    test('the fight view is swept once a second, not once a tick', () => {
        // Sixty ticks a second, each sweeping the document twice, for a view
        // that repaints far slower. The portraits are therefore held for a
        // second — the resolution still runs per tick, so a name can still be
        // corrected, but a portrait that appears mid-second waits for it.
        const portraits = (names) =>
            `<div class="BattlePanel_playersArea__a">${names
                .map(
                    (name) =>
                        `<div class="CombatUnit_combatUnit__u"><div class="CombatUnit_name__n">${name}</div></div>`
                )
                .join('')}</div>`;
        const held = document.body.innerHTML;
        document.body.innerHTML = portraits([]);
        const tick = { battleId: 11, tier: 1, pMap: { 0: { cHP: 100, mHP: 100 } }, mMap: {} };
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        expect(guildTrialDamage.breakdown().names['0'].source).toBe('placeholder');

        document.body.innerHTML = portraits(['Sarin']);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        expect(guildTrialDamage.breakdown().names['0'].source).toBe('placeholder');

        vi.setSystemTime(at + 1000);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        expect(guildTrialDamage.breakdown().names['0']).toMatchObject({ name: 'Sarin' });
        document.body.innerHTML = held;
    });

    test('a wave’s monsters are forgotten when the next wave starts', () => {
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 9,
            tier: 1,
            pMap: {},
            mMap: { 0: { cHP: 300_000, mHP: 300_000 }, 1: { cHP: 200_000, mHP: 200_000 } },
        });
        // The next tier is a fresh wave; its first tick names one slot, and the
        // last wave's other slot must not still be in the sum
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 9,
            tier: 2,
            pMap: {},
            mMap: { 0: { cHP: 330_000, mHP: 330_000 } },
        });

        const { pool } = guildTrialDamage.breakdown();
        expect(pool.max).toBe(330_000);
        expect(pool.current).toBe(330_000);
    });

    test('the tier is taken from the payload, not reasoned about', () => {
        replay();
        expect(guildTrialDamage.breakdown().tier).toBe(2);
    });

    test('it arms without a gate, because only a trial produces this message', () => {
        // No `new_battle`, no monster names, no encounter to recognise
        replay();

        const report = guildTrialDamage.breakdown();
        expect(report.active).toBe(true);
        expect(report.source).toBe('spectated');
        expect(report.reason).toBe(SPECTATED_TRIAL_NOTE);
    });

    test('damage taken and healing received fill from the player’s own health', () => {
        replay();

        // 2612 → 2577 → 2612 → 2499 across the capture: 35 then 113 taken, 35 healed.
        // Rows are keyed by identity now — the placeholder, for a slot never
        // named — because a raw index does not survive the per-tier slot re-deal
        const row = guildTrialDamage.breakdown().support.players.find((entry) => entry.name === 'Player 2');
        expect(row.damageTaken).toBe(35 + 113);
        expect(row.healingReceived).toBe(35);
    });

    test('the boss is never a row in the player table', () => {
        replay();

        const report = guildTrialDamage.breakdown();
        for (const row of report.support.players) expect(row.name).not.toBe('Player 1');
        // Its 618,000 health is a pool reading, not somebody's damage taken
        expect(report.support.totals.damageTaken).toBeLessThan(1000);
    });

    test('the lone unit in a tick owns it — the 1,405 is the tank\u2019s reflect', () => {
        // The capture's `pMap` entries carry no `atkCounter`, and the boss lost
        // 1,405 health on a tick whose only player was being *hit*. This module
        // once refused that tick as unattributable; the party recording that
        // calibrated the hybrid rungs proved the refusal wrong — the server
        // groups ticks by actor, the boss's own hit counter rose in the same
        // breath, and health a boss loses while striking somebody is that
        // somebody's thorns. Measured, and credited to the one unit present.
        replay();

        const report = guildTrialDamage.breakdown();
        expect(report.totalDamage).toBe(1_405);
        expect(report.players).toHaveLength(1);
        expect(report.players[0].name).toBe('Player 2');
        expect(report.players[0].measured).toBe(true);
        // Still true, and still exported: no *player-side* counters were seen
        expect(report.splitFromCounters).toBe(false);
    });

    test('what the stream did and did not carry is counted, so a caption can say which', () => {
        replay();

        const { spectator } = guildTrialDamage.breakdown();
        expect(spectator.ticks).toBe(6);
        expect(spectator.playerActionTicks).toBe(0);
        // Five of the six carried the boss; the first had an empty `mMap`
        expect(spectator.bossTicks).toBe(5);
    });

    test('with the players’ counters present the split is made', () => {
        // The same shape with `atkCounter` on the player, which is what the
        // capture would have shown on a tick where somebody swung
        const swing = (atk, dmg, hp) => ({
            type: 'guild_battle_updated',
            battleId: 1,
            tier: 2,
            pMap: { 1: { cHP: 2612, mHP: 2612, cMP: 2180, mMP: 2180, atkCounter: atk, isAutoAtk: true } },
            mMap: { 0: { cHP: hp, mHP: 618_000, dmgCounter: dmg, critCounter: 0 } },
        });

        game.wsHandlers[GUILD_BATTLE_MESSAGE](swing(1, 1, 618_000));
        vi.setSystemTime(at + 250);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](swing(2, 2, 617_000));

        const report = guildTrialDamage.breakdown();
        expect(report.splitFromCounters).toBe(true);
        expect(report.totalDamage).toBe(1000);
        expect(report.players[0].damage).toBe(1000);
    });

    test('a revive at the new tier is not a heal, and the death still counts', () => {
        // The game starts everyone fresh and alive at each tier, so a unit
        // dead at the end of one and full at the start of the next crossed a
        // baseline drop, not a healer
        const tick = (tier, hp) => ({
            type: 'guild_battle_updated',
            battleId: 1,
            tier,
            pMap: { 1: { cHP: hp, mHP: 1923, cMP: 1000, mMP: 1923 } },
            mMap: { 0: { cHP: 500_000, mHP: 618_000 } },
        });

        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(2, 1923));
        vi.setSystemTime(at + 250);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(2, 0));
        vi.setSystemTime(at + 500);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(3, 1923));

        const report = guildTrialDamage.breakdown();
        const row = report.support.players.find((entry) => entry.name === 'Player 2');
        expect(row.healingReceived).toBe(0);
        expect(row.deaths).toBe(1);
    });

    test('a new tier is a new wave, not a 618,000-point heal', () => {
        const tick = (tier, hp) => ({
            type: 'guild_battle_updated',
            battleId: 1,
            tier,
            pMap: {},
            mMap: { 0: { cHP: hp, mHP: 618_000, dmgCounter: 1 } },
        });

        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(2, 10_000));
        vi.setSystemTime(at + 250);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(3, 669_500));

        const report = guildTrialDamage.breakdown();
        // The fresh boss is a first sighting again, so nothing is diffed off it
        expect(report.totalDamage).toBe(0);
        expect(report.tier).toBe(3);
        expect(report.fights).toBe(2);
    });

    test('a member is identified by the health and mana their build states', () => {
        // The capture's player reads mHP 2612 / mMP 2180, and exactly one
        // captured sheet says Max HP 2,612 and Max MP 2,180
        game.loadouts = [
            {
                name: 'ICMeow',
                at: 1,
                rows: [
                    { label: 'Max HP', value: '2,612' },
                    { label: 'Max MP', value: '2,180' },
                ],
            },
            {
                name: 'Cream',
                at: 1,
                rows: [
                    { label: 'Max HP', value: '1,923' },
                    { label: 'Max MP', value: '1,923' },
                ],
            },
        ];
        replay();

        const report = guildTrialDamage.breakdown();
        expect(report.names['1']).toEqual({ name: 'ICMeow', source: 'vitals' });
        expect(report.support.players[0].name).toBe('ICMeow');
        expect(report.nameCoverage).toMatchObject({ named: 1, of: 1 });
    });

    test('a unit nothing can name is a placeholder, and says so', () => {
        replay();

        const report = guildTrialDamage.breakdown();
        expect(report.names['1']).toEqual({ name: 'Player 2', source: 'placeholder' });
        expect(report.nameCoverage.placeholders).toEqual(['Player 2']);
    });

    test('a malformed tick is logged rather than thrown', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => game.wsHandlers[GUILD_BATTLE_MESSAGE](null)).not.toThrow();
        expect(() => game.wsHandlers[GUILD_BATTLE_MESSAGE]({ pMap: 'nonsense' })).not.toThrow();
        spy.mockRestore();
    });
});

describe('the boss’s own sheet', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T22:00:00Z'));
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    /** The popup the fight view opens when the boss is clicked */
    const bossUnit = (level, hp) => ({
        unit: {
            character: { name: 'Trial Chameleon' },
            combatDetails: {
                combatLevel: level,
                maxHitpoints: hp,
                combatStats: { rangedDamage: 462, rangedAccuracy: 971, stabEvasion: 432 },
            },
        },
    });

    test('is kept per tier, from the level it states', () => {
        // Lv.110 is the second rung of the ladder, and 618,000 is its pool
        game.wsHandlers.battle_unit_fetched(bossUnit(110, 618_000));

        const sheets = guildTrialDamage.breakdown().bossSheets;
        expect(sheets[2]).toMatchObject({ name: 'Trial Chameleon', tier: 2, level: 110, maxHitpoints: 618_000 });
        expect(sheets[2].stats.rangedDamage).toBe(462);
    });

    test('two tiers sit side by side, which is what makes them worth keeping', () => {
        game.wsHandlers.battle_unit_fetched(bossUnit(110, 618_000));
        game.wsHandlers.battle_unit_fetched(bossUnit(120, 669_500));

        expect(Object.keys(guildTrialDamage.breakdown().bossSheets).sort()).toEqual(['2', '3']);
    });

    test('the stream’s tier wins over the sheet’s level while it is running', () => {
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wireDump[1]);
        game.wsHandlers.battle_unit_fetched(bossUnit(999, 618_000));

        expect(guildTrialDamage.breakdown().bossSheets[2]).toBeTruthy();
    });

    test('a guild member’s sheet is not a boss sheet', () => {
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'ICMeow' }, combatDetails: { combatLevel: 153, maxHitpoints: 2612 } },
        });
        expect(guildTrialDamage.breakdown().bossSheets).toEqual({});
    });

    test('an ordinary zone monster clicked during the hour is not one either', () => {
        game.wsHandlers.battle_unit_fetched({
            unit: {
                name: 'Granite Golem',
                combatMonsterHrid: '/monsters/granite_golem',
                combatDetails: { combatLevel: 110 },
            },
        });
        expect(guildTrialDamage.breakdown().bossSheets).toEqual({});
    });
});

describe('which trial is being watched', () => {
    const at = new Date('2026-08-05T22:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Chameleon', 'Trial Hedgehog']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('the pool carries no encounter when nothing can name it', () => {
        // Reported: two combat trials this week, both cards barless, and an
        // unnamed pool stood in for both — so a Chameleon fight was reported as
        // "Trial Hedgehog — cleared 0 tiers". Unnamed now means unclaimed
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wireDump[1]);

        const { pool, encounter } = guildTrialDamage.breakdown();
        expect(encounter).toBeNull();
        expect(pool.encounter).toBeNull();
    });

    test('the fight view’s boss tile names it', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wireDump[1]);

        const report = guildTrialDamage.breakdown();
        expect(report.encounter).toBe('chameleon');
        expect(report.bossName).toBe('Trial Chameleon');
        expect(report.pool.encounter).toBe('chameleon');
    });

    test('one click on the boss names it, and outlives the view closing', () => {
        game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { name: 'Trial Chameleon' },
                combatDetails: { combatLevel: 110, maxHitpoints: 618_000 },
            },
        });
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wireDump[1]);

        expect(guildTrialDamage.breakdown().pool.encounter).toBe('chameleon');
    });

    test('a new battle drops the identity rather than carrying it over', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wireDump[1]);
        expect(guildTrialDamage.breakdown().encounter).toBe('chameleon');

        // The view is shut and a different fight starts streaming
        document.body.innerHTML = '';
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({ ...wireDump[1], battleId: 2 });

        expect(guildTrialDamage.breakdown().encounter).toBeNull();
    });

    test('the monsters area is not queried on every tick', () => {
        // `_identifyEncounter` early-returns once the encounter is known, so
        // the expensive case is the ordinary one: background spectating with
        // the fight view shut, where nothing ever sets it and the
        // `[class*="BattlePanel_monstersArea"]` query — an attribute-substring
        // match no browser can index — ran on all 150,642 ticks of a trial
        document.body.innerHTML = '';
        const query = vi.spyOn(document, 'querySelector');
        try {
            const tick = { battleId: 21, tier: 1, pMap: { 0: { cHP: 100, mHP: 100 } }, mMap: {} };
            const monsters = () => query.mock.calls.filter(([sel]) => String(sel).includes('monstersArea')).length;

            for (let index = 0; index < 40; index += 1) game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);

            expect(monsters()).toBe(1);
        } finally {
            query.mockRestore();
        }
    });

    test('a fight view opened mid-fight is still picked up, within a second', () => {
        // The throttle must not cost the identification. The view is shut for
        // the first ticks and opens later in the same wave
        document.body.innerHTML = '';
        const tick = { battleId: 22, tier: 1, pMap: { 0: { cHP: 100, mHP: 100 } }, mMap: {} };
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        expect(guildTrialDamage.breakdown().encounter).toBeNull();

        document.body.innerHTML =
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';

        // Inside the interval the answer is still the held one…
        vi.setSystemTime(at + 999);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        expect(guildTrialDamage.breakdown().encounter).toBeNull();

        // …and a second is the worst case
        vi.setSystemTime(at + 1000);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
        expect(guildTrialDamage.breakdown().encounter).toBe('chameleon');
        expect(guildTrialDamage.breakdown().bossName).toBe('Trial Chameleon');
    });

    test('a wave boundary re-arms the probe rather than making it wait', () => {
        document.body.innerHTML = '';
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({ battleId: 23, tier: 1, pMap: {}, mMap: {} });
        expect(guildTrialDamage.breakdown().encounter).toBeNull();

        document.body.innerHTML =
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';
        // The same instant, so only the re-arm can make this identify
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({ battleId: 23, tier: 2, pMap: {}, mMap: {} });

        expect(guildTrialDamage.breakdown().encounter).toBe('chameleon');
    });

    test('the caches change no attributed number', () => {
        // The point of both of them. The six captured ticks are replayed with
        // the caches doing their job, then replayed again with both defeated
        // per tick, and every figure the module publishes is compared
        document.body.innerHTML =
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>' +
            '<div class="BattlePanel_playersArea__a">' +
            '<div class="CombatUnit_combatUnit__u"><div class="CombatUnit_name__n">Sarin</div></div>' +
            '</div>';
        game.loadouts = [{ name: 'Sarin', at: at - 1000, rows: [], stats: {} }];

        /**
         * Replay the capture, optionally dropping both caches before each tick.
         * @param {boolean} defeat - Whether to force the uncached path
         * @returns {string} The published report
         */
        const run = (defeat) => {
            guildTrialDamage.reset();
            wireDump.forEach((tick, index) => {
                vi.setSystemTime(at + index * 250);
                if (defeat) {
                    guildTrialDamage.encounterProbeAt = 0;
                    guildTrialDamage.fightViewCache = null;
                }
                game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);
            });
            return JSON.stringify(guildTrialDamage.breakdown());
        };

        expect(run(false)).toBe(run(true));
    });

    test('a tier change within one battle keeps it', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';
        game.wsHandlers[GUILD_BATTLE_MESSAGE](wireDump[1]);
        document.body.innerHTML = '';
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({ ...wireDump[1], tier: 3 });

        expect(guildTrialDamage.breakdown().encounter).toBe('chameleon');
    });
});

/**
 * Which slot the watcher is standing in.
 *
 * This used to be read off the stream: `guild_battle_updated` carried
 * `atkCounter` for one unit — the recording client's own — so "the only counted
 * slot" *was* the watcher. The game now sends counters for every present player
 * (57 of 57 slots in the replayed trial, in every tick bucket), so that test is
 * never true again and the derivation had to move to the roster, which states
 * slot → `characterId` and can be matched against the character we are.
 */
describe('the watcher’s own slot', () => {
    const at = new Date('2026-08-03T16:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.ownId = null;
        game.readOwnId = null;
        game.storedRoster = null;
        game.guildMembers = {};
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Badger']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        game.ownId = null;
        game.readOwnId = null;
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    /** A tick where every slot in the roster carries counters, as the game now sends them */
    const everyoneCounts = () => ({
        battleId: 1,
        tier: 1,
        pMap: Object.fromEntries(
            Array.from({ length: 30 }, (unused, index) => [index, { cHP: 1500, mHP: 1554, atkCounter: 3 }])
        ),
        mMap: {},
    });

    test('the roster’s character id finds the watcher, whatever the counters cover', () => {
        game.ownName = 'Player20';
        game.ownId = 900020;
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](everyoneCounts());

        // The old rule's precondition is gone: the whole party is counted
        expect(guildTrialDamage.countedSlots.size).toBe(30);
        // …and the watcher is still found, because the roster says where they are
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: '19', name: 'Player20', characterId: 900020 });
    });

    test('an id the roster does not list leaves the slot unknown', () => {
        // Watching a trial you are not fighting in. Refusing to guess is the
        // whole point: a wrong own slot is somebody else's damage under your name
        game.ownName = 'Spectator';
        game.ownId = 999999;
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](everyoneCounts());

        expect(guildTrialDamage._ownIdentity().slot).toBeNull();
    });

    test('with no roster and no id map, a lone counted slot is not the watcher', () => {
        // The rung that used to answer here read one counted slot as the
        // viewer, from a stream that sent counters for the viewer alone. The
        // game now sends them for every present player and `countedSlots`
        // accumulates over the wave, so one counted slot means one player was
        // ever present — while spectating, whoever was fighting. Neither
        // exact-id source can speak, so the honest answer is null.
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 7,
            tier: 1,
            pMap: { 0: { cHP: 3000, mHP: 3100 }, 2: { cHP: 2600, mHP: 2612, atkCounter: 4 } },
            mMap: {},
        });

        expect(guildTrialDamage.roster).toEqual({});
        expect(guildTrialDamage.slotIds).toEqual({});
        expect(guildTrialDamage.countedSlots.size).toBe(1);
        // The name is still read — it is who is at the keyboard — but it binds
        // to no slot, which is what `allowed()` gates on
        expect(guildTrialDamage._ownIdentity()).toEqual({
            slot: null,
            name: 'MillenniumTest',
            characterId: 900002,
        });
    });

    test('and the watcher’s row reads as a placeholder rather than a name', () => {
        // The cost the maintainer accepted, stated as an assertion: with the
        // rung gone the counted slot is named "Player 3", and `nameCoverage`
        // reports it as a placeholder so the report can say so. A guess would
        // have been a figure to act on; a placeholder is correctable.
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        // Two ticks: `countedSlots` is filled after the naming pass, so the
        // removed rung only ever had something to say from the second tick on
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 7,
            tier: 1,
            pMap: { 0: { cHP: 3000, mHP: 3100 }, 2: { cHP: 2600, mHP: 2612, atkCounter: 4 } },
            mMap: {},
        });
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 7,
            tier: 1,
            pMap: { 0: { cHP: 2990, mHP: 3100 }, 2: { cHP: 2590, mHP: 2612, atkCounter: 5 } },
            mMap: {},
        });

        const report = guildTrialDamage.breakdown();
        expect(report.names['2'].source).toBe('placeholder');
        expect(report.nameCoverage.placeholders).toContain(report.names['2'].name);
        // …and nothing anywhere wears the watcher's name off a guess
        for (const entry of Object.values(report.names)) expect(entry.name).not.toBe('MillenniumTest');
    });

    test('the roster still answers where a lone slot is counted', () => {
        // The removal takes nothing from the exact-id rungs: same one-counted-
        // slot shape, but the game stated who holds it.
        game.ownName = 'Player20';
        game.ownId = 900020;
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 1,
            tier: 1,
            pMap: { 19: { cHP: 1620, mHP: 1620, atkCounter: 4 } },
            mMap: {},
        });

        expect(guildTrialDamage.countedSlots.size).toBe(1);
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: '19', name: 'Player20', characterId: 900020 });
    });

    test('the id map still answers where a lone slot is counted', () => {
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        game.wsHandlers.new_guild_battle({
            type: 'new_guild_battle',
            battleId: 4,
            tier: 1,
            players: [{ character: { id: 900001 } }, { character: { id: 900002 } }, { character: { id: 900003 } }],
            monsters: [],
        });
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 4,
            tier: 1,
            pMap: { 2: { cHP: 1500, mHP: 1554, atkCounter: 3 } },
            mMap: {},
        });

        expect(guildTrialDamage.roster).toEqual({});
        expect(guildTrialDamage.countedSlots).toEqual(new Set(['2']));
        // The counted slot is 2; the id map says the watcher is slot 1, and the
        // id map is what is believed
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: '1', name: 'MillenniumTest', characterId: 900002 });
    });

    test('a character switch with a lone counted slot still binds nobody', () => {
        game.ownName = 'MillenniumTest';
        let reads = 0;
        game.readOwnId = () => (reads++ === 0 ? 900002 : 900003);
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 7,
            tier: 1,
            pMap: { 0: { cHP: 3000, mHP: 3100 }, 2: { cHP: 2600, mHP: 2612, atkCounter: 4 } },
            mMap: {},
        });

        reads = 0;
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: null, name: null, characterId: null });
    });

    test('a character switch mid-resolution binds nobody', () => {
        // The documented race: identity is mutable global state, so it is read
        // before the derivation and verified after it. A switch between the two
        // reads yields no own slot at all — the departing character's name must
        // never be pinned to the arriving character's slot.
        game.ownName = 'Player20';
        let reads = 0;
        game.readOwnId = () => (reads++ === 0 ? 900020 : 900021);
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](everyoneCounts());

        reads = 0;
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: null, name: null, characterId: null });
    });
});

/**
 * The messages a guild trial actually opens and closes with.
 *
 * Replayed from a guildmate's raw recording — 81,725 events across one trial
 * hour — kept verbatim in `guild-trial-messages.fixture.js`. `new_guild_battle`
 * is the message this feature spent three rounds working around the absence of.
 */
/**
 * The slot → character id map, and the row that used to say "Player N".
 *
 * The watcher's own row fell back to a placeholder whenever the tier-opening
 * `new_guild_battle` was missed — a refresh mid-tier, with the next one an hour
 * away — because the only thing that knew which slot was theirs was the named
 * roster, and the named roster is wiped per wave and refilled from exactly that
 * message. It also drops any slot it cannot put a *name* to, though the payload
 * states that slot's `character.id` regardless. The id map keeps those ids.
 *
 * The stakes are one-sided, and every test here is about the wrong half: the
 * `own` rung in `resolveUnitNames` claims its slot ahead of portrait and vitals
 * evidence, so a wrong own slot pins the watcher's name to a guildmate's damage
 * where a missing one merely leaves a correctable placeholder. Exact id match
 * or nothing.
 */
describe('the watcher’s slot from the id map', () => {
    const at = new Date('2026-08-03T16:00:00Z').getTime();

    /** A tier opening whose players carry ids and no names at all — the trimmed payload */
    const idsOnly = (battleId = 1, tier = 1) => ({
        type: 'new_guild_battle',
        battleId,
        tier,
        players: [{ character: { id: 900001 } }, { character: { id: 900002 } }, { character: { id: 900003 } }],
        monsters: [],
    });

    /** A tick of that fight, with everybody counted as the game now sends them */
    const tick = (battleId = 1, tier = 1) => ({
        battleId,
        tier,
        pMap: {
            0: { cHP: 1500, mHP: 1554, atkCounter: 3 },
            1: { cHP: 1500, mHP: 1554, atkCounter: 3 },
            2: { cHP: 1500, mHP: 1554, atkCounter: 3 },
        },
        mMap: {},
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.ownId = null;
        game.readOwnId = null;
        game.storedRoster = null;
        game.guildMembers = {};
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Badger']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        game.ownId = null;
        game.readOwnId = null;
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('an unnamed roster still says which slot is the watcher’s', () => {
        // Nothing can name these slots — the payload trimmed the names and the
        // guild roster is empty — so `rosterFromBattle` gives back nothing at
        // all. The ids it discarded are the whole answer to "which one is me".
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        game.wsHandlers.new_guild_battle(idsOnly());
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick());

        expect(guildTrialDamage.roster).toEqual({});
        expect(guildTrialDamage.slotIds).toEqual({ 0: 900001, 1: 900002, 2: 900003 });
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: '1', name: 'MillenniumTest', characterId: 900002 });
        // …and the name binds, where the row used to read "Player 2"
        expect(guildTrialDamage.breakdown().names['1']).toMatchObject({ name: 'MillenniumTest', source: 'own' });
    });

    test('an id the map does not list yields a placeholder, not a guess', () => {
        // Watching a trial you are not in. Two other slots are counted and
        // unnamed; naming one of them yours would be the whole failure mode
        game.ownName = 'Spectator';
        game.ownId = 999999;
        game.wsHandlers.new_guild_battle(idsOnly());
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick());

        expect(guildTrialDamage._ownIdentity().slot).toBeNull();
        const names = guildTrialDamage.breakdown().names;
        for (const entry of Object.values(names)) expect(entry.name).not.toBe('Spectator');
    });

    test('a previous battle’s map cannot answer for this one', () => {
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        game.wsHandlers.new_guild_battle(idsOnly(1, 1));
        expect(guildTrialDamage._ownIdentity().slot).toBe('1');

        // A different fight starts and states nothing: the slots have re-dealt,
        // so last fight's map describes whoever now holds those indexes
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(2, 1));

        expect(guildTrialDamage.slotIds).toEqual({});
        expect(guildTrialDamage._ownIdentity().slot).toBeNull();
    });

    test('a new tier of the same battle re-deals the map too', () => {
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        game.wsHandlers.new_guild_battle(idsOnly(1, 1));
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick(1, 2));

        // `players[]` is re-stated per tier in an order that is not stable, so
        // the tier boundary voids the map exactly as it voids the roster
        expect(guildTrialDamage.slotIds).toEqual({});
        expect(guildTrialDamage._ownIdentity().slot).toBeNull();
    });

    test('a character switch mid-resolution binds nobody', () => {
        // Identity is mutable global state: read before the walk, verified
        // after it. The departing character's name must never land on the
        // arriving character's slot.
        game.ownName = 'MillenniumTest';
        game.wsHandlers.new_guild_battle(idsOnly());
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick());

        let reads = 0;
        game.readOwnId = () => (reads++ === 0 ? 900002 : 900003);
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: null, name: null, characterId: null });
    });

    test('the named roster still wins where it applies', () => {
        // The map is a second source, not a replacement: the roster answers
        // first and its answer is unchanged by any of this
        game.ownName = 'Player20';
        game.ownId = 900020;
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        expect(Object.keys(guildTrialDamage.roster).length).toBe(30);
        expect(guildTrialDamage._ownIdentity()).toEqual({ slot: '19', name: 'Player20', characterId: 900020 });
    });

    test('the map survives a refresh mid-tier and is adopted', async () => {
        // The case the whole change exists for: `new_guild_battle` fires once
        // per tier, so a refresh has nothing on the wire to wait for
        game.ownName = 'MillenniumTest';
        game.ownId = 900002;
        game.wsHandlers.new_guild_battle(idsOnly());
        expect(game.storedRoster).toMatchObject({ battleId: 1, tier: 1, ownerId: 900002 });
        expect(game.storedRoster.slotIds).toEqual({ 0: 900001, 1: 900002, 2: 900003 });

        // The refresh: a fresh page-load holds none of the in-memory state
        guildTrialDamage.cleanup();
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        await vi.advanceTimersByTimeAsync(0);

        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick());
        expect(guildTrialDamage.breakdown().names['1']).toMatchObject({ name: 'MillenniumTest', source: 'own' });
    });

    test('a stored map another character wrote is refused', async () => {
        // Same battle, same tier, different character at the keyboard. The map
        // is only ever read to answer "which slot is me", and a map recorded by
        // somebody else is refused outright rather than trusted to not match.
        game.storedRoster = {
            battleId: 1,
            tier: 1,
            roster: {},
            slotIds: { 0: 900001, 1: 900002, 2: 900003 },
            ownerId: 900002,
            at: Date.now(),
        };
        game.ownName = 'OtherCharacter';
        game.ownId = 900003;
        guildTrialDamage.cleanup();
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        await vi.advanceTimersByTimeAsync(0);

        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick());

        expect(guildTrialDamage.slotIds).toEqual({});
        expect(guildTrialDamage._ownIdentity().slot).toBeNull();
        const names = guildTrialDamage.breakdown().names;
        for (const entry of Object.values(names)) expect(entry.name).not.toBe('OtherCharacter');
    });
});

describe('the tier-opening message', () => {
    const at = new Date('2026-08-03T16:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        game.guildMembers = {};
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Badger']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('the roster names every unit, in slot order', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](GUILD_BATTLE_TICKS[1]);

        const report = guildTrialDamage.breakdown();
        // Verified against the recording: pMap key "19" is players[19]
        expect(report.names['19']).toMatchObject({ name: 'Player20', source: 'roster' });
        expect(report.names['0']).toMatchObject({ name: 'Player01', source: 'roster' });
        expect(report.nameCoverage.placeholders).toEqual([]);
        expect(report.nameCoverage.of).toBe(30);
    });

    test('a character id comes with each name, so a unit can be known to be you', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        expect(guildTrialDamage.breakdown().roster['19']).toMatchObject({ name: 'Player20' });
        expect(guildTrialDamage.breakdown().roster['0'].characterId).toBe(900001);
    });

    test('a slot the battle names by id only is still named, from the guild roster', () => {
        // Reported live, in a 48-player trial: rows read "Player 7", "Player
        // 10", "Player 36" for real members interleaved with real names
        // elsewhere. The message that opens each tier had carried the id for
        // these slots but not the name; the guild already knows it.
        game.guildMembers = { 900001: 'Atlan', 900002: 'Bilibili' };
        const trimmed = {
            ...NEW_GUILD_BATTLE,
            players: NEW_GUILD_BATTLE.players.map((player, index) =>
                index < 2 ? { ...player, character: { id: player.character.id }, name: undefined } : player
            ),
        };
        game.wsHandlers.new_guild_battle(trimmed);

        const report = guildTrialDamage.breakdown();
        expect(report.names['0']).toMatchObject({ name: 'Atlan', source: 'roster' });
        expect(report.names['1']).toMatchObject({ name: 'Bilibili', source: 'roster' });
        expect(report.nameCoverage.placeholders).toEqual([]);
    });

    test('an id the guild roster does not know either falls through, rather than a wrong guess', () => {
        game.guildMembers = {};
        const trimmed = {
            ...NEW_GUILD_BATTLE,
            players: NEW_GUILD_BATTLE.players.map((player, index) =>
                index === 0 ? { ...player, character: { id: player.character.id }, name: undefined } : player
            ),
        };
        game.wsHandlers.new_guild_battle(trimmed);
        // Slot 0 earns no roster entry, so it is only named once a tick asks
        // `resolveUnitNames` to place it — nothing else can match it here
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            type: 'guild_battle_updated',
            battleId: 1,
            tier: 1,
            pMap: { 0: { cHP: 100, mHP: 100 } },
            mMap: {},
        });

        const report = guildTrialDamage.breakdown();
        expect(report.names['0'].source).toBe('placeholder');
    });

    test('the roster outranks a name already resolved from a build', () => {
        // A viewer who joined mid-tier matched by vitals; the roster then states
        // the answer, and a stated answer is not overruled by an inferred one
        game.loadouts = [
            {
                name: 'SomebodyElse',
                at: 1,
                rows: [
                    { label: 'Max HP', value: '1,620' },
                    { label: 'Max MP', value: '1,929' },
                ],
            },
        ];
        game.wsHandlers[GUILD_BATTLE_MESSAGE](GUILD_BATTLE_TICKS[2]);
        expect(guildTrialDamage.breakdown().names['19'].source).toBe('vitals');

        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](GUILD_BATTLE_TICKS[2]);
        expect(guildTrialDamage.breakdown().names['19']).toMatchObject({ name: 'Player20', source: 'roster' });
    });

    test('a tick’s abilityHrid is filed under the player who cast it', () => {
        game.casts = [];
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        const tick = {
            ...GUILD_BATTLE_TICKS[1],
            pMap: {
                0: { cHP: 100, mHP: 100, abilityHrid: '/abilities/fireball' },
                1: { cHP: 100, mHP: 100, isAutoAtk: true },
            },
        };
        game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);

        // Slot 0 is named by the roster; slot 1 carried no ability, so nothing
        // is filed for it — an auto-attack classifies nobody
        expect(game.casts).toEqual([['Player01', '/abilities/fireball']]);
    });

    test('a slot no source could name files nothing', () => {
        // A placeholder is a slot, not a person, and evidence attached to one
        // would move to somebody else at the next tier's re-deal
        game.casts = [];
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            type: 'guild_battle_updated',
            battleId: 77,
            tier: 1,
            pMap: { 4: { cHP: 100, mHP: 100, abilityHrid: '/abilities/fireball' } },
            mMap: {},
        });

        expect(game.casts).toEqual([]);
    });

    test('a page refresh mid-tier reads the roster back, for the same battle only', async () => {
        // `new_guild_battle` fires once per tier and never again, so a refresh
        // lost every name until the next tier: "Player 2" and "Player 3" on a
        // leaderboard whose roster had been on the wire minutes earlier
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        expect(game.storedRoster).toMatchObject({ battleId: 1 });

        // The refresh: a fresh page-load holds none of the in-memory state
        guildTrialDamage.cleanup();
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        await vi.advanceTimersByTimeAsync(0);

        game.wsHandlers[GUILD_BATTLE_MESSAGE](GUILD_BATTLE_TICKS[2]);
        expect(guildTrialDamage.breakdown().names['19']).toMatchObject({ name: 'Player20', source: 'roster' });
    });

    test('another battle’s stored roster stays unused', async () => {
        game.storedRoster = {
            battleId: 999,
            roster: { 19: { name: 'SomebodyElse', characterId: 1 } },
            at: Date.now(),
        };
        guildTrialDamage.cleanup();
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        await vi.advanceTimersByTimeAsync(0);

        game.wsHandlers[GUILD_BATTLE_MESSAGE](GUILD_BATTLE_TICKS[2]);
        expect(guildTrialDamage.breakdown().names['19'].source).toBe('placeholder');
    });

    test('a stored duplicate of the watcher’s name heals on the next tick', () => {
        // The user's own export, verbatim: names held {0: MillenniumTest
        // (portrait), 2: MillenniumTest (vitals)} with countedSlots ['2'] —
        // the ended-trial summary ranked the user at positions 1 and 3 while
        // SarinTest went missing. The resolver now refuses the watcher's name
        // anywhere but the slot an exact character-id match puts them in, so
        // the next tick corrects the stored mislabel. Nothing here states an
        // id — no roster, no `new_guild_battle` — so that slot is unknown and
        // *both* copies go, leaving placeholders the portrait or vitals may
        // still fill. That is the point of dropping the counted-slot guess: it
        // would have re-pinned the name to slot 2 on nothing but a counter.
        game.ownName = 'MillenniumTest';
        // A wave is under way…
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 7,
            tier: 1,
            pMap: { 0: { cHP: 3000, mHP: 3100 }, 2: { cHP: 2600, mHP: 2612, atkCounter: 4 } },
            mMap: {},
        });
        // …and holds the poisoned state the old build wrote: the watcher's
        // name on two slots at once
        guildTrialDamage.unitNames = {
            0: { name: 'MillenniumTest', source: 'portrait' },
            2: { name: 'MillenniumTest', source: 'vitals' },
        };
        guildTrialDamage.names = { 0: 'MillenniumTest', 2: 'MillenniumTest' };
        guildTrialDamage.countedSlots.add('2');

        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 7,
            tier: 1,
            pMap: { 0: { cHP: 2990, mHP: 3100 }, 2: { cHP: 2590, mHP: 2612, atkCounter: 5 } },
            mMap: {},
        });

        const names = guildTrialDamage.breakdown().names;
        expect(names['2'].source).toBe('placeholder');
        expect(names['0'].name).not.toBe('MillenniumTest');
        // …and the summary the ended-trial report reads from carries the fix:
        // the duplicate is gone, and the name is on nobody rather than on a
        // slot picked out by a counter
        const wearingIt = Object.values(guildTrialDamage.names).filter((name) => name === 'MillenniumTest');
        expect(wearingIt).toHaveLength(0);
    });

    test('the boss sheet arrives without anybody clicking anything', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        const sheet = guildTrialDamage.breakdown().bossSheets[1];
        expect(sheet).toMatchObject({
            name: 'Trial Badger',
            tier: 1,
            hrid: '/monsters/trial_badger',
            maxHitpoints: 429_000,
            source: 'new_guild_battle',
        });
        // Ten minutes, in nanoseconds on the wire
        expect(sheet.enrageTimerMs).toBe(600_000);
        expect(sheet.stats.combatLevel).toBe(100);
    });

    test('a two-enemy wave records both bars as its wave total, keeping one as the sheet', () => {
        // The fixture fields two Trial Badgers; the representative sheet keeps one
        // bar, but the wave total is both, so the ceiling can price the whole kill
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        const sheet = guildTrialDamage.breakdown().bossSheets[1];
        expect(sheet.maxHitpoints).toBe(429_000);
        expect(sheet.waveHitpoints).toBe(858_000);
        expect(sheet.waveCount).toBe(2);
    });

    test('and confirms the participant rule again', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        const report = guildTrialDamage.breakdown();
        expect(report.participants).toBe(30);
        // 330,000 base health with thirty in the trial: 330,000 × 1.30
        expect(report.bossSheets[1].maxHitpoints).toBe(Math.round(330_000 * 1.3));
    });

    test('it identifies the encounter without the fight view being open', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        const report = guildTrialDamage.breakdown();
        expect(report.encounter).toBe('badger');
        expect(report.bossName).toBe('Trial Badger');
    });

    test('it is the tier boundary, so a fresh wave is never read as a heal', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            ...GUILD_BATTLE_TICKS[0],
            mMap: { 0: { cHP: 10_000, mHP: 429_000, dmgCounter: 5 } },
        });

        vi.setSystemTime(at + 200_000);
        game.wsHandlers.new_guild_battle({ ...NEW_GUILD_BATTLE, tier: 2 });
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            ...GUILD_BATTLE_TICKS[0],
            tier: 2,
            mMap: { 0: { cHP: 468_000, mHP: 468_000, dmgCounter: 6 } },
        });

        const report = guildTrialDamage.breakdown();
        expect(report.tier).toBe(2);
        expect(report.totalDamage).toBe(0);
        // And the boundary is stamped, so a tier's duration is exact
        expect(report.tierStarts).toEqual({ 1: at, 2: at + 200_000 });
    });

    test('the end message closes the trial rather than leaving it to go quiet', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        expect(guildTrialDamage.breakdown().active).toBe(true);

        vi.setSystemTime(at + 3_600_000);
        game.wsHandlers.end_guild_battle(END_GUILD_BATTLE);

        const report = guildTrialDamage.breakdown();
        expect(report.active).toBe(false);
        expect(report.endedAt).toBe(at + 3_600_000);
    });

    test('another trial’s ending is not this one’s', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        game.wsHandlers.end_guild_battle({
            type: 'end_guild_battle',
            battleId: 9,
            trialHrid: '/guild_combat/chameleon',
        });

        expect(guildTrialDamage.breakdown().endedAt).toBeNull();
    });

    test('a malformed opening message is logged rather than thrown', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => game.wsHandlers.new_guild_battle(null)).not.toThrow();
        expect(() => game.wsHandlers.new_guild_battle({ players: 'nope', monsters: 7 })).not.toThrow();
        expect(() => game.wsHandlers.end_guild_battle(undefined)).not.toThrow();
        spy.mockRestore();
    });
});

describe('only your own damage is measured', () => {
    const at = new Date('2026-08-03T16:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    test('the slot the game streams counters for is recorded, and it is one', () => {
        // 4,939 of 81,641 ticks carried counters, always on a single entry —
        // index 19, the recording client's own character
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        for (const tick of GUILD_BATTLE_TICKS) game.wsHandlers[GUILD_BATTLE_MESSAGE](tick);

        const report = guildTrialDamage.breakdown();
        expect(report.countedSlots).toEqual(['19']);
        expect(report.countedNames).toEqual(['Player20']);
        expect(report.splitFromCounters).toBe(true);
    });

    test('a row says whether it is the measured one', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);

        const swing = (atk, dmg, hp) => ({
            type: 'guild_battle_updated',
            battleId: 1,
            tier: 1,
            pMap: { 19: { cHP: 1620, mHP: 1620, cMP: 1929, mMP: 1929, atkCounter: atk, isAutoAtk: true } },
            mMap: { 0: { cHP: hp, mHP: 429_000, dmgCounter: dmg, critCounter: 0 } },
        });

        game.wsHandlers[GUILD_BATTLE_MESSAGE](swing(1, 1, 429_000));
        vi.setSystemTime(at + 250);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](swing(2, 2, 428_000));

        const row = guildTrialDamage.breakdown().players.find((entry) => entry.name === 'Player20');
        expect(row.measured).toBe(true);
        expect(row.damage).toBe(1000);
    });
});

describe('the game’s own end-of-trial stats, saved for comparison', () => {
    const at = new Date('2026-08-14T18:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        game.storedStats = null;
        game.guildMembers = {};
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    test('reported totals are named through the roster and exposed for comparison', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        guildTrialDamage.encounter = 'badger';
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 900001,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 1_000_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 50_000,
                },
                {
                    characterId: 900002,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 400_000,
                    healingDone: 20_000,
                    premitigatedDamageTaken: 10_000,
                },
                // A skilling line and an unknown character id are both dropped.
                {
                    characterId: 900001,
                    trialHrid: '/guild_skilling/crafting',
                    damageDealt: 999,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
                {
                    characterId: 111111,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 123,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
            ],
        });

        const report = guildTrialDamage.breakdown();
        expect(report.reported.Player01).toEqual({ damage: 1_000_000, healing: 0, taken: 50_000 });
        expect(report.reported.Player02).toEqual({ damage: 400_000, healing: 20_000, taken: 10_000 });
        expect(Object.keys(report.reported)).toEqual(['Player01', 'Player02']);
    });

    test('an id this trial never happened to name is still named, from the guild roster', () => {
        // No `new_guild_battle` at all this test — a viewer whose tab opened
        // after every tier's opening message had already gone by. The
        // end-of-trial stats carry the id regardless, and the guild roster
        // is what fills in the name `characterNames` never got a chance to.
        game.guildMembers = { 900007: 'Cleric' };
        guildTrialDamage.encounter = 'badger';
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 900007,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 250_000,
                    healingDone: 5_000,
                    premitigatedDamageTaken: 1_000,
                },
            ],
        });

        const report = guildTrialDamage.breakdown();
        expect(report.reported.Cleric).toEqual({ damage: 250_000, healing: 5_000, taken: 1_000 });
    });

    test('a different trial’s stats do not land on this one', () => {
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        guildTrialDamage.encounter = 'hedgehog';
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 900001,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 1,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
            ],
        });
        expect(guildTrialDamage.breakdown().reported).toBe(null);
    });

    test('the other combat trial’s stats are stored as a roster, without a measurement claim', async () => {
        // The other boss fight's members were never in any message this client
        // watched — the guild roster is what names their ids
        game.guildMembers = { 910011: 'Tank', 910012: 'Cleric' };
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        guildTrialDamage.encounter = 'hedgehog';
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 900001,
                    trialHrid: '/guild_combat/hedgehog',
                    damageDealt: 500_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
                {
                    characterId: 910011,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 750_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 2_000,
                },
                {
                    characterId: 910012,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 0,
                    healingDone: 90_000,
                    premitigatedDamageTaken: 0,
                },
                // A skilling line still files nowhere
                {
                    characterId: 910011,
                    trialHrid: '/guild_skilling/crafting',
                    damageDealt: 999,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
            ],
        });

        const report = guildTrialDamage.breakdown();
        // The comparison card's own pair is still only the spectated encounter's
        expect(Object.keys(report.reported)).toEqual(['Player01']);
        // …but the unwatched fight's roster is stored beside it, which is what
        // the attendance ledger reads as participation evidence
        expect(Object.keys(report.storedStats).sort()).toEqual(['badger', 'hedgehog']);
        expect(Object.keys(report.storedStats.badger.reported).sort()).toEqual(['Cleric', 'Tank']);
        expect(report.storedStats.badger.reported.Tank).toEqual({ damage: 750_000, healing: 0, taken: 2_000 });
        // A roster, not a measurement: nothing was watched there, and the
        // entry says so rather than claiming a measurement that found nobody
        expect(report.storedStats.badger.measured).toBe(null);
        expect(report.storedStats.hedgehog.measured).not.toBe(null);
        // …and both reach disk, so a refresh (and the recorder) read them back.
        // The write is fire-and-forget, so let its microtasks settle first
        await vi.advanceTimersByTimeAsync(0);
        expect(Object.keys(game.storedStats.trials).sort()).toEqual(['badger', 'hedgehog']);
        expect(game.storedStats.trials.badger.measured).toBe(null);
    });

    test('with no spectated encounter, two trials’ stats claim no card but both are stored', () => {
        game.guildMembers = { 910011: 'Tank', 910012: 'Cleric' };
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 910011,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 1,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
                {
                    characterId: 910012,
                    trialHrid: '/guild_combat/hedgehog',
                    damageDealt: 2,
                    healingDone: 0,
                    premitigatedDamageTaken: 0,
                },
            ],
        });

        const report = guildTrialDamage.breakdown();
        // Guessing which of the two was watched would pin the measurement to
        // the wrong fight, so neither becomes the session's own pair
        expect(report.reported).toBe(null);
        expect(Object.keys(report.storedStats).sort()).toEqual(['badger', 'hedgehog']);
        expect(report.storedStats.badger.measured).toBe(null);
        expect(report.storedStats.hedgehog.measured).toBe(null);
    });

    test('a lone group on a client that measured nothing is a roster, not a measurement', () => {
        // The cycle's other combat fight ends first, before this client has
        // watched a single tick — no encounter, no spectator stream, no own
        // fight. "There is only one group it can be" is true of the *trial*,
        // but claiming it as this client's own would store `measured: {}` — a
        // watched-and-split-nobody claim the accuracy card draws as the
        // attribution failing — for a fight nobody here saw.
        game.guildMembers = { 910011: 'Tank' };
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 910011,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 750_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 2_000,
                },
            ],
        });

        const report = guildTrialDamage.breakdown();
        expect(report.reported).toBe(null);
        expect(report.storedStats.badger.reported.Tank.damage).toBe(750_000);
        expect(report.storedStats.badger.measured).toBe(null);
    });

    test('a lone group still becomes the session’s own once something was actually measured', () => {
        game.guildMembers = { 910011: 'Tank' };
        // The own-battle gate armed once this session, even though the
        // encounter itself was never identified — the lone group is the trial
        // that measurement belongs to
        guildTrialDamage.fights = 1;
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 910011,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 750_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 2_000,
                },
            ],
        });

        const report = guildTrialDamage.breakdown();
        expect(report.reported).not.toBe(null);
        expect(report.storedStats.badger.measured).not.toBe(null);
    });

    test('a re-statement with nothing watched beside it does not erase the stored measurement', async () => {
        // First: the watched fight's stats land while the session still knows
        // its encounter, so the pair is stored with a measurement claim
        game.guildMembers = { 910011: 'Tank' };
        guildTrialDamage.encounter = 'badger';
        const stats = {
            guildTrialStatList: [
                {
                    characterId: 910011,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 750_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 2_000,
                },
            ],
        };
        game.wsHandlers.guild_trial_stats_updated(stats);
        await vi.advanceTimersByTimeAsync(0);
        const storedMeasured = game.storedStats.trials.badger.measured;
        expect(storedMeasured).not.toBe(null);

        // Then the same trial's rows arrive again after a reset — a websocket
        // re-delivery, or a later message re-stating an earlier fight. The
        // session no longer knows the encounter and measured nothing, so the
        // new entry carries `measured: null` — which must not overwrite the
        // week's only measurement for that fight on disk.
        guildTrialDamage.reset();
        game.wsHandlers.guild_trial_stats_updated(stats);
        await vi.advanceTimersByTimeAsync(0);

        expect(game.storedStats.trials.badger.reported.Tank.damage).toBe(750_000);
        expect(game.storedStats.trials.badger.measured).toEqual(storedMeasured);
    });

    test('a new trial does not inherit the previous one’s reported totals or boss sheets', () => {
        // First trial: Badger, tiers 1 and 2, plus its game-reported totals
        game.wsHandlers.new_guild_battle(NEW_GUILD_BATTLE);
        guildTrialDamage.encounter = 'badger';
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                {
                    characterId: 900001,
                    trialHrid: '/guild_combat/badger',
                    damageDealt: 1_000_000,
                    healingDone: 0,
                    premitigatedDamageTaken: 50_000,
                },
            ],
        });
        game.wsHandlers.new_guild_battle({ ...NEW_GUILD_BATTLE, tier: 2 });
        expect(guildTrialDamage.breakdown().reported).not.toBe(null);
        expect(Object.keys(guildTrialDamage.breakdown().bossSheets).sort()).toEqual(['1', '2']);

        // A different combat trial: a new battle id and a different encounter —
        // the badger's tier 2 sheet was never reached this trial and must not
        // linger to inflate this trial's damage ceiling, and the badger's
        // reported totals are a different trial's answer to a different card
        game.wsHandlers.new_guild_battle({
            ...NEW_GUILD_BATTLE,
            battleId: 2,
            tier: 1,
            monsters: [{ ...NEW_GUILD_BATTLE.monsters[0], hrid: '/monsters/trial_hedgehog', name: 'Trial Hedgehog' }],
        });

        const report = guildTrialDamage.breakdown();
        expect(report.reported).toBe(null);
        expect(Object.keys(report.bossSheets)).toEqual(['1']);
        expect(report.bossSheets[1].name).toBe('Trial Hedgehog');
    });

    test('compareTrialStats pairs measured against reported with a delta', () => {
        const rows = compareTrialStats({
            reported: {
                Player01: { damage: 1000, healing: 0, taken: 100 },
                Player02: { damage: 500, healing: 0, taken: 0 },
            },
            measured: { Player01: { damage: 900, healing: 0, taken: 100 } },
        });
        // Ordered by reported damage, Player01 first.
        expect(rows.map((r) => r.name)).toEqual(['Player01', 'Player02']);
        expect(rows[0].damage.deltaPct).toBeCloseTo(-10);
        expect(rows[0].taken.deltaPct).toBe(0);
        // Player02 was never measured — 0 vs 500 reads as −100%.
        expect(rows[1].damage.deltaPct).toBeCloseTo(-100);
    });
});

describe('personal combat does not leak into a spectated trial', () => {
    const at = new Date('2026-08-14T16:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = 'MillenniumTest';
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        // This week's trial is the Chameleon, so a personal fight against a
        // Chameleon would otherwise be mistaken for the trial by name alone.
        guildTrialDamage.setTrialNames(['Trial Chameleon']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    // A spectated tick — enough to arm the stream and stamp `spectator.lastAt`.
    const guildTick = (hp) => ({
        type: 'guild_battle_updated',
        battleId: 7,
        tier: 2,
        pMap: { 3: { cHP: 1620, mHP: 1620, cMP: 1929, mMP: 1929 } },
        mMap: { 0: { cHP: hp, mHP: 618_000 } },
    });

    test('a member farming while watching In Progress is not folded into the split', () => {
        // Spectating.
        game.wsHandlers[GUILD_BATTLE_MESSAGE](guildTick(618_000));
        vi.setSystemTime(at + 250);
        game.wsHandlers[GUILD_BATTLE_MESSAGE](guildTick(617_000));

        // Meanwhile the client is farming a Chameleon zone — a personal fight
        // whose monster name matches the trial, exactly the case that used to be
        // mistaken for it. Its 50,000 of damage must not reach the trial: with the
        // spectator stream live, `battle_updated` is dropped as personal combat.
        vi.setSystemTime(at + 500);
        game.wsHandlers.new_battle({
            battleId: 999,
            monsters: [{ name: 'Chameleon', currentHitpoints: 100_000, maxHitpoints: 100_000 }],
            players: { 0: { character: { name: 'MillenniumTest' } } },
        });
        vi.setSystemTime(at + 750);
        game.wsHandlers.battle_updated({
            battleId: 999,
            pMap: { 0: { cHP: 3000, mHP: 3000, cMP: 500, mMP: 500, atkCounter: 1, isAutoAtk: true } },
            mMap: { 0: { cHP: 50_000, mHP: 100_000, dmgCounter: 1, critCounter: 0 } },
        });

        const report = guildTrialDamage.breakdown();
        // The personal 50,000 never lands, and the module stays a spectator.
        // The 1,000 the boss lost on the stream does — these ticks carry no
        // monster hit counter, so it is counted as un-countered damage.
        expect(report.totalDamage).toBe(1000);
        expect(report.source).toBe('spectated');
        expect(report.players.some((row) => row.name === 'MillenniumTest')).toBe(false);
    });

    test('once the spectator stream goes quiet, a real solo fight counts again', () => {
        game.wsHandlers[GUILD_BATTLE_MESSAGE](guildTick(618_000));

        // Long after the last spectated tick — the stream has stopped — a genuine
        // solo-participant fight against the trial is measured as before.
        vi.setSystemTime(at + 30_000);
        game.wsHandlers.new_battle({
            battleId: 42,
            monsters: [{ name: 'Chameleon', currentHitpoints: 100_000, maxHitpoints: 100_000 }],
            players: { 0: { character: { name: 'MillenniumTest' } } },
        });
        expect(guildTrialDamage.breakdown().active).toBe(true);
    });
});

describe('per-name history is immutable across wave boundaries', () => {
    // The live regression: at "1 fight watched" NPD ranked with 156.2K; 32
    // seconds and one tier rollover later NPD read 24.3K while Caicedo gained
    // 166K — totals swapped between names, because the trial-long tally was
    // index-keyed and `new_guild_battle` re-deals `players[]` per tier in an
    // order that is not stable. Damage banked under a name must never move.
    const at = new Date('2026-08-03T16:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Chameleon']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    const roster = (tier, names) => ({
        battleId: 9,
        tier,
        players: names.map((name, index) => ({ character: { id: index + 100, name } })),
        monsters: [{ hrid: '/monsters/trial_chameleon', name: 'Trial Chameleon', combatDetails: {} }],
    });
    const tick = (tier, pMap, bossHp, bossDmg, offsetMs) => {
        vi.setSystemTime(at + offsetMs);
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId: 9,
            tier,
            pMap,
            mMap: { 0: { cHP: bossHp, mHP: 650_000, dmgCounter: bossDmg, critCounter: 0 } },
        });
    };
    const totals = () => Object.fromEntries(guildTrialDamage.breakdown().players.map((row) => [row.name, row.damage]));

    test('a tier rollover that re-deals the slots moves no banked damage between names', () => {
        // Tier 3: Rick is slot 0, NPD slot 1
        game.wsHandlers.new_guild_battle(roster(3, ['Rick', 'NPD']));
        tick(3, { 0: { atkCounter: 1 }, 1: { atkCounter: 1 } }, 650_000, 0, 0);
        tick(3, { 1: { atkCounter: 2 } }, 500_000, 1, 250); // NPD 150K
        tick(3, { 0: { atkCounter: 2 } }, 400_000, 2, 500); // Rick 100K

        const before = totals();
        expect(before).toEqual({ NPD: 150_000, Rick: 100_000 });

        // Tier 4: the same two people, the slots REVERSED
        game.wsHandlers.new_guild_battle(roster(4, ['NPD', 'Rick']));
        tick(4, { 0: { atkCounter: 5 }, 1: { atkCounter: 5 } }, 650_000, 0, 750);
        tick(4, { 0: { atkCounter: 6 } }, 620_000, 1, 1000); // NPD (slot 0 now) 30K

        const after = totals();
        expect(after).toEqual({ NPD: 180_000, Rick: 100_000 });
        // The invariant the screenshots broke: banked per-name damage only climbs
        for (const [name, damage] of Object.entries(before)) {
            expect(after[name] ?? 0).toBeGreaterThanOrEqual(damage);
        }
    });

    test('the own-counter slot re-confirms per wave, never carried across a re-deal', () => {
        game.wsHandlers.new_guild_battle(roster(3, ['Rick', 'NPD']));
        tick(3, { 1: { atkCounter: 1 } }, 650_000, 0, 0);
        tick(3, { 1: { atkCounter: 2 } }, 640_000, 1, 250);
        expect(guildTrialDamage.breakdown().countedSlots).toEqual(['1']);

        // The rollover clears the binding outright…
        game.wsHandlers.new_guild_battle(roster(4, ['NPD', 'Rick']));
        expect(guildTrialDamage.breakdown().countedSlots).toEqual([]);

        // …and the new wave's counters re-confirm it at the new slot
        tick(4, { 0: { atkCounter: 7 } }, 650_000, 0, 500);
        tick(4, { 0: { atkCounter: 8 } }, 640_000, 1, 750);
        expect(guildTrialDamage.breakdown().countedSlots).toEqual(['0']);
    });

    test('support figures bank by name across the same boundary', () => {
        game.wsHandlers.new_guild_battle(roster(3, ['Rick', 'NPD']));
        tick(3, { 1: { cHP: 2000, mHP: 2600 } }, 650_000, 0, 0);
        tick(3, { 1: { cHP: 1400, mHP: 2600 } }, 650_000, 0, 250); // NPD takes 600

        game.wsHandlers.new_guild_battle(roster(4, ['NPD', 'Rick']));
        tick(4, { 0: { cHP: 2600, mHP: 2600 } }, 650_000, 0, 500);
        tick(4, { 0: { cHP: 2350, mHP: 2600 } }, 650_000, 0, 750); // NPD takes 250 more

        const rows = guildTrialDamage.breakdown().support.players;
        expect(rows.find((row) => row.name === 'NPD').damageTaken).toBe(850);
        expect(rows.find((row) => row.name === 'Rick')).toBeUndefined();
    });

    test('a new trial (a genuine battle-id rollover) does not inherit the previous one’s banked damage', () => {
        // Tier 3 of one trial: Rick and NPD both swing, banked at the tier
        // rollover exactly as the sibling test above proves
        game.wsHandlers.new_guild_battle(roster(3, ['Rick', 'NPD']));
        tick(3, { 0: { atkCounter: 1 }, 1: { atkCounter: 1 } }, 650_000, 0, 0);
        tick(3, { 1: { atkCounter: 2 } }, 500_000, 1, 250); // NPD 150K
        tick(3, { 0: { atkCounter: 2 } }, 400_000, 2, 500); // Rick 100K
        expect(totals()).toEqual({ NPD: 150_000, Rick: 100_000 });

        // A different combat trial entirely: a new battle id, a fresh tier 1,
        // a different encounter. Rick and NPD's Chameleon damage was banked
        // under a previous trial (`bankedTally`/`bankedDeaths`/`bankedSupport`)
        // and must not linger here — the same stale-carryover pattern
        // `753785712` fixed for `reported`/`bossSheets`, but `bankedTally` and
        // its siblings were never cleared on the same battle-id rollover
        game.wsHandlers.new_guild_battle({
            battleId: 10,
            tier: 1,
            players: [{ character: { id: 200, name: 'Zeta' } }],
            monsters: [{ hrid: '/monsters/trial_hedgehog', name: 'Trial Hedgehog', combatDetails: {} }],
        });

        const report = guildTrialDamage.breakdown();
        expect(report.totalDamage).toBe(0);
        expect(totals()).toEqual({});
    });

    /**
     * The elapsed denominator is the other half of the same carryover. It is
     * accumulated from the gaps between ticks across every tier of a trial (a
     * tier boundary is not a new fight, which is why it has to survive one),
     * and a second trial in the same session used to start from the first
     * trial's total — dividing its own damage by an hour nobody in it fought.
     */
    test('a new trial starts its elapsed denominator from zero', () => {
        game.wsHandlers.new_guild_battle(roster(3, ['Rick', 'NPD']));
        tick(3, { 0: { atkCounter: 1 }, 1: { atkCounter: 1 } }, 650_000, 0, 0);
        tick(3, { 0: { atkCounter: 2 } }, 500_000, 1, 250);
        tick(3, { 1: { atkCounter: 2 } }, 400_000, 2, 500);
        expect(guildTrialDamage.breakdown().seconds).toBeGreaterThan(0);

        game.wsHandlers.new_guild_battle({
            battleId: 10,
            tier: 1,
            players: [{ character: { id: 200, name: 'Zeta' } }],
            monsters: [{ hrid: '/monsters/trial_hedgehog', name: 'Trial Hedgehog', combatDetails: {} }],
        });

        expect(guildTrialDamage.breakdown().seconds).toBe(0);
    });
});

describe('the trial ends and its figures stop moving', () => {
    const at = new Date('2026-08-19T16:00:00Z').getTime();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at);
        game.clientData = {};
        game.loadouts = [];
        game.ownName = null;
        game.storedRoster = null;
        guildTrialDamage.storedRoster = null;
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Chameleon']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    const opening = (battleId = 11) => ({
        battleId,
        tier: 2,
        players: [{ character: { id: 501, name: 'Rick' } }],
        monsters: [{ hrid: '/monsters/trial_chameleon', name: 'Trial Chameleon', combatDetails: {} }],
    });
    const tick = (offsetMs, bossHp, bossDmg, battleId = 11) => {
        vi.setSystemTime(at + offsetMs);
        game.wsHandlers[GUILD_BATTLE_MESSAGE]({
            battleId,
            tier: 2,
            pMap: { 0: { cHP: 2000, mHP: 2000, cMP: 500, mMP: 500, atkCounter: bossDmg } },
            mMap: { 0: { cHP: bossHp, mHP: 650_000, dmgCounter: bossDmg, critCounter: 0 } },
        });
    };
    const endTrial = (offsetMs) => {
        vi.setSystemTime(at + offsetMs);
        game.wsHandlers.end_guild_battle({ battleId: 11, trialHrid: '/guild_combat/chameleon' });
    };

    test('the elapsed denominator freezes at the end and the DPS with it', () => {
        game.wsHandlers.new_guild_battle(opening());
        for (let step = 1; step <= 40; step += 1) tick(step * 250, 650_000 - step * 10_000, step);
        endTrial(11_000);

        const ended = guildTrialDamage.breakdown();
        expect(ended.frozen).toBe(true);
        expect(ended.seconds).toBeGreaterThan(MIN_SECONDS);
        expect(ended.partyDps).toBeGreaterThan(0);

        // An hour of wall clock later, with nothing on the wire
        vi.setSystemTime(at + 60 * 60_000);
        const later = guildTrialDamage.breakdown();
        expect(later.seconds).toBe(ended.seconds);
        expect(later.partyDps).toBe(ended.partyDps);
    });

    test('a tick trailing in after the end does not extend it', () => {
        game.wsHandlers.new_guild_battle(opening());
        for (let step = 1; step <= 40; step += 1) tick(step * 250, 650_000 - step * 10_000, step);
        endTrial(11_000);
        const frozenAt = guildTrialDamage.breakdown().seconds;

        tick(11_200, 240_000, 41);
        expect(guildTrialDamage.breakdown().seconds).toBe(frozenAt);
    });

    test('a new trial stream starts the clock again', () => {
        game.wsHandlers.new_guild_battle(opening());
        for (let step = 1; step <= 40; step += 1) tick(step * 250, 650_000 - step * 10_000, step);
        endTrial(11_000);

        vi.setSystemTime(at + 20_000);
        game.wsHandlers.new_guild_battle(opening(12));
        expect(guildTrialDamage.breakdown().frozen).toBe(false);
    });

    test('a stream that simply stops is called ended after three quiet minutes', () => {
        game.wsHandlers.new_guild_battle(opening());
        for (let step = 1; step <= 40; step += 1) tick(step * 250, 650_000 - step * 10_000, step);

        // Two minutes of quiet is a long wave transition, not an ending
        vi.setSystemTime(at + 10_000 + 2 * 60_000);
        expect(guildTrialDamage.breakdown().staleStream).toBe(false);

        // Three and a half is a trial that ended without saying so
        vi.setSystemTime(at + 10_000 + 3.5 * 60_000);
        const stale = guildTrialDamage.breakdown();
        expect(stale.staleStream).toBe(true);
        expect(stale.frozen).toBe(true);
        expect(stale.active).toBe(false);
        expect(stale.endedAt).toBeTruthy();

        const seconds = stale.seconds;
        vi.setSystemTime(at + 30 * 60_000);
        expect(guildTrialDamage.breakdown().seconds).toBe(seconds);
    });

    test('a personal fight inside the reconciliation window changes nothing', () => {
        game.wsHandlers.new_guild_battle(opening());
        for (let step = 1; step <= 40; step += 1) tick(step * 250, 650_000 - step * 10_000, step);
        endTrial(11_000);
        const before = guildTrialDamage.breakdown();

        // The player goes straight back to farming. The stats message is still
        // eight seconds out, and it is the other half of the comparison.
        vi.setSystemTime(at + 20_000);
        game.wsHandlers.new_battle({
            battleId: 4242,
            monsters: [{ name: 'Chameleon', currentHitpoints: 100_000, maxHitpoints: 100_000 }],
            players: { 0: { character: { name: 'Rick' } } },
        });
        vi.setSystemTime(at + 20_250);
        game.wsHandlers.battle_updated({
            battleId: 4242,
            pMap: { 0: { cHP: 3000, mHP: 3000, cMP: 500, mMP: 500, atkCounter: 1 } },
            mMap: { 0: { cHP: 50_000, mHP: 100_000, dmgCounter: 1, critCounter: 0 } },
        });

        const after = guildTrialDamage.breakdown();
        expect(after.totalDamage).toBe(before.totalDamage);
        expect(after.seconds).toBe(before.seconds);
        expect(after.encounter).toBe(before.encounter);

        // …and the game's own totals still land on the trial they belong to
        vi.setSystemTime(at + 22_000);
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                { characterId: 501, trialHrid: '/guild_combat/chameleon', damageDealt: 400_000, healingDone: 0 },
            ],
        });
        expect(guildTrialDamage.breakdown().reported).toEqual({
            Rick: { damage: 400_000, healing: 0, taken: 0 },
        });
    });

    test('once the totals have landed, the next personal fight is judged normally', () => {
        game.wsHandlers.new_guild_battle(opening());
        tick(250, 640_000, 1);
        endTrial(1000);
        game.wsHandlers.guild_trial_stats_updated({
            guildTrialStatList: [
                { characterId: 501, trialHrid: '/guild_combat/chameleon', damageDealt: 10_000, healingDone: 0 },
            ],
        });

        vi.setSystemTime(at + 20_000);
        game.wsHandlers.new_battle({
            battleId: 4243,
            monsters: [{ name: 'Abyssal Imp' }],
            players: { 0: { character: { name: 'Rick' } } },
        });
        expect(guildTrialDamage.breakdown().reason).toContain('not this week’s trial encounter');
    });
});

describe('the split a live portrait may be badged with', () => {
    const at = 1_800_000_000_000;

    /** A tracker stub with just the two things the accessor consults */
    const tracker = (lastAt, report) => ({ spectator: { lastAt }, breakdown: () => report });

    const measured = {
        measured: true,
        players: [{ name: 'Player01', damage: 100, dps: 10, share: 100 }],
        partyDps: 10,
        seconds: 10,
    };

    test('a stream that ticked a moment ago hands over its rows', () => {
        expect(liveTrialSplit(at, tracker(at - 1000, measured))).toEqual({
            players: measured.players,
            partyDps: 10,
            seconds: 10,
        });
    });

    test('a stream gone quiet answers null rather than last hour’s figures', () => {
        // Not an empty table: a caller that gets rows back should be able to
        // draw them without a second liveness check of its own
        expect(liveTrialSplit(at, tracker(at - TRIAL_BADGE_WINDOW_MS - 1, measured))).toBeNull();
    });

    test('a trial nothing was measured for answers null', () => {
        expect(liveTrialSplit(at, tracker(at - 1000, { measured: false, players: [] }))).toBeNull();
    });

    test('a client that has never spectated answers null', () => {
        expect(liveTrialSplit(at, tracker(0, measured))).toBeNull();
        expect(liveTrialSplit(at, {})).toBeNull();
    });
});
