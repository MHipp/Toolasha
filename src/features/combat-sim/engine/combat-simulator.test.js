// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * A golden run of the whole simulation loop.
 *
 * Every other engine test exercises one mechanic in isolation; nothing ran the
 * loop end to end, so a subtle change anywhere in it — event ordering, a stat
 * formula, an RNG draw added or removed — could shift every simulated number
 * without failing a single test. This pins one seeded run's exact totals.
 *
 * The pinned numbers are NOT asserted to be *correct* — they are whatever the
 * engine produced on the day they were pinned. Their value is purely that they
 * cannot change unnoticed. If an intentional engine change moves them, re-run
 * the test, eyeball that the movement matches the intent, and update the pins
 * deliberately in the same change. If they move when nothing in the engine was
 * meant to change behavior, that is the bug this test exists to catch.
 */

import { describe, test, expect, afterEach } from 'vitest';

import CombatSimulator, { getCapturedPlayerDetails, setPlayerDetailsCapture } from './combat-simulator.js';
import AutoAttackEvent from './events/auto-attack-event.js';
import CombatStartEvent from './events/combat-start-event.js';
import DamageOverTimeEvent from './events/damage-over-time-event.js';
import EnemyRespawnEvent from './events/enemy-respawn-event.js';
import { getGameData, setGameData } from './game-data.js';
import Labyrinth from './labyrinth.js';
import Monster from './monster.js';
import Player from './player.js';
import { clearSimRng, seedSimRng } from './rng.js';
import Zone from './zone.js';

const ONE_SECOND = 1e9;
const ONE_HOUR = 3600 * ONE_SECOND;

const ZONE_HRID = '/actions/combat/golden_meadow';
const RAT_HRID = '/monsters/golden_rat';
const TOAD_HRID = '/monsters/golden_toad';

/**
 * A monster the engine can fight without any ability or consumable machinery:
 * an unarmed smash attacker, like the fixture player.
 * @param {Object} levels - The seven base levels
 * @param {number} experience - Experience the monster is worth
 * @returns {Object} combatMonsterDetailMap entry
 */
function monster(levels, experience) {
    return {
        experience,
        // Enrage never fires inside these short fights, but the enrage-based
        // XP-rate arithmetic divides by it, so it must be a real duration
        enrageTime: 300 * ONE_SECOND,
        abilities: [],
        combatDetails: {
            ...levels,
            attackInterval: 3500000000,
            combatStats: {
                combatStyleHrids: ['/combat_styles/smash'],
                damageType: '/damage_types/physical',
                // Zero on purpose: the engine falls back to the
                // combatDetails.attackInterval above, as it does for the
                // game's own monsters
                attackInterval: 0,
            },
        },
    };
}

/** The minimal game data the loop reads: one zone, two monsters, one combat style. */
function installGameData() {
    setGameData({
        actionDetailMap: {
            [ZONE_HRID]: {
                buffs: null,
                combatZoneInfo: {
                    isDungeon: false,
                    dungeonInfo: null,
                    fightInfo: {
                        bossSpawns: null,
                        randomSpawnInfo: {
                            maxSpawnCount: 2,
                            maxTotalStrength: 2,
                            spawns: [
                                { combatMonsterHrid: RAT_HRID, difficultyTier: 0, rate: 2, strength: 1 },
                                { combatMonsterHrid: TOAD_HRID, difficultyTier: 0, rate: 1, strength: 1 },
                            ],
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: {
            [RAT_HRID]: monster(
                {
                    staminaLevel: 10,
                    intelligenceLevel: 5,
                    attackLevel: 40,
                    meleeLevel: 40,
                    defenseLevel: 30,
                    rangedLevel: 1,
                    magicLevel: 1,
                },
                60
            ),
            [TOAD_HRID]: monster(
                {
                    staminaLevel: 20,
                    intelligenceLevel: 5,
                    attackLevel: 55,
                    meleeLevel: 55,
                    defenseLevel: 40,
                    rangedLevel: 1,
                    magicLevel: 1,
                },
                110
            ),
        },
        combatStyleDetailMap: {
            '/combat_styles/smash': {
                skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 },
            },
        },
    });
}

/**
 * An unarmed, unfed, ability-less player: every swing goes through the full
 * attack pipeline (accuracy, damage roll, threat, XP split) with none of the
 * equipment or consumable machinery in the way.
 * @returns {Player}
 */
function fixturePlayer() {
    const player = Player.createFromDTO({
        hrid: 'player1',
        staminaLevel: 70,
        intelligenceLevel: 40,
        attackLevel: 70,
        meleeLevel: 70,
        defenseLevel: 60,
        rangedLevel: 1,
        magicLevel: 1,
        equipment: {},
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null],
        houseRooms: {},
        debuffOnLevelGap: 0,
    });
    return player;
}

/**
 * One seeded hour in the fixture zone.
 * @param {number} seed - RNG seed
 * @returns {import('./sim-result.js').default}
 */
function goldenRun(seed) {
    installGameData();
    seedSimRng(seed);

    const zone = new Zone(ZONE_HRID, 0);
    const player = fixturePlayer();
    // The worker wires these two on every run; without them the first combat
    // start throws on `extraBuffs.forEach`
    player.zoneBuffs = zone.buffs;
    player.extraBuffs = [];

    const simulator = new CombatSimulator([player], zone);
    return simulator.simulate(ONE_HOUR);
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('golden run: one seeded hour, pinned exactly', () => {
    test('the totals are what they were when this was pinned', () => {
        const result = goldenRun(20260806);

        // Encounters fully cleared in the hour (a wipe ends a fight without
        // counting here — the ten player deaths below are those)
        expect(result.encounters).toBe(34);

        // Kills, per monster, and the player's own deaths
        expect(result.deaths).toEqual({
            '/monsters/golden_rat': 39,
            '/monsters/golden_toad': 29,
            player1: 10,
        });

        // Player XP: an unarmed smash attacker trains melee (0.3 primary +
        // 0.35 style split) and attack (0.35 style split), nothing else
        expect(result.experienceGained.player1).toEqual({
            stamina: 0,
            intelligence: 0,
            attack: 2494.130396668348,
            melee: 4631.956450955504,
            defense: 0,
            ranged: 0,
            magic: 0,
        });

        // Damage dealt by the player, and taken from each monster type
        expect(result.totalDamageDealt).toEqual({
            player1: 16565,
            '/monsters/golden_toad': 6123,
            '/monsters/golden_rat': 3815,
        });

        // The run stops on the first event at or past the hour; with this seed
        // that lands exactly on it
        expect(result.simulatedTime).toBe(3600000000000);
    });

    test('the same seed reproduces the run draw for draw', () => {
        const first = goldenRun(20260806);
        clearSimRng();
        setGameData(null);
        const second = goldenRun(20260806);

        expect(second.encounters).toBe(first.encounters);
        expect(second.deaths).toEqual(first.deaths);
        expect(second.experienceGained).toEqual(first.experienceGained);
        expect(second.totalDamageDealt).toEqual(first.totalDamageDealt);
        expect(second.simulatedTime).toBe(first.simulatedTime);
    });
});

/**
 * Labyrinth attempt accounting.
 *
 * A clear rate is wins over attempts, so the denominator must count exactly
 * the attempts that finished — win, death or timeout — never the fight still
 * in progress when the run stopped, and never one fewer. The old blanket
 * `attemptCount - 1` subtracted a *resolved* win whenever the time cap landed
 * on the killing blow itself, and a 100%-win run then read 251/250 — the
 * "100.4% clear" a room log actually displayed.
 */
describe('labyrinth attempt accounting', () => {
    const LAB_MONSTER = '/monsters/golden_lab_rat';

    /**
     * One seeded, time-capped labyrinth run against a monster with the given
     * levels. Returns both the result and the labyrinth, so tests can check
     * the result's counts against the engine's own spawn counter.
     * @param {number} seed - RNG seed
     * @param {Object} levels - Monster level block (see monster())
     * @param {number} capSeconds - Simulation time cap
     * @returns {{result: Object, labyrinth: Labyrinth}}
     */
    function labyrinthRun(seed, levels, capSeconds) {
        // The golden zone (for SimResult's constructor) plus the lab monster
        setGameData({
            actionDetailMap: {
                [ZONE_HRID]: {
                    buffs: null,
                    combatZoneInfo: {
                        isDungeon: false,
                        dungeonInfo: null,
                        fightInfo: {
                            bossSpawns: null,
                            randomSpawnInfo: { maxSpawnCount: 1, maxTotalStrength: 1, spawns: [] },
                        },
                    },
                },
            },
            combatMonsterDetailMap: { [LAB_MONSTER]: monster(levels, 50) },
            combatStyleDetailMap: {
                '/combat_styles/smash': { skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 } },
            },
        });
        seedSimRng(seed);

        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];

        // Room level 100 = scale factor 1, so the level block is used as-is
        const labyrinth = new Labyrinth(LAB_MONSTER, 100);
        const simulator = new CombatSimulator([player], zone, undefined, labyrinth);
        return { result: simulator.simulate(capSeconds * ONE_SECOND), labyrinth };
    }

    /** The invariants every labyrinth run must satisfy, whatever the seed */
    function expectSoundCounts(result, labyrinth) {
        // Wins can never exceed finished attempts — this is the 100.4% bug
        expect(result.encounters).toBeLessThanOrEqual(result.labyAttemptCount);
        // Every spawn is either finished or the one fight still in progress
        expect(result.labyAttemptCount + result.labyUnfinishedAttempts).toBe(labyrinth.attemptCount);
        expect([0, 1]).toContain(result.labyUnfinishedAttempts);
        if (result.labyAttemptCount > 0) {
            expect(result.encounters / result.labyAttemptCount).toBeLessThanOrEqual(1);
        }
    }

    // Feeble monster: every fight is a quick kill, so the event that crosses
    // the time cap is very often the killing blow itself — the exact case the
    // old subtraction scored as 101%
    const FEEBLE = {
        staminaLevel: 3,
        intelligenceLevel: 1,
        attackLevel: 1,
        meleeLevel: 1,
        defenseLevel: 1,
        rangedLevel: 1,
        magicLevel: 1,
    };

    test('an all-win run keeps every win in the denominator, cap-on-kill included', () => {
        let sawCapLandOnAKill = false;
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const { result, labyrinth } = labyrinthRun(seed, FEEBLE, 60);
            expectSoundCounts(result, labyrinth);
            expect(result.encounters).toBeGreaterThan(0);
            if (result.labyUnfinishedAttempts === 0) {
                // The run stopped on a resolution — under the old accounting
                // this read wins/(wins-1), i.e. more than 100%
                sawCapLandOnAKill = true;
                expect(result.encounters).toBe(result.labyAttemptCount);
            }
        }
        expect(sawCapLandOnAKill).toBe(true);
    });

    test('an all-loss run counts the deaths and claims no wins', () => {
        // A monster that flattens the fixture player every fight
        const { result, labyrinth } = labyrinthRun(
            11,
            {
                staminaLevel: 300,
                intelligenceLevel: 50,
                attackLevel: 500,
                meleeLevel: 500,
                defenseLevel: 300,
                rangedLevel: 1,
                magicLevel: 1,
            },
            300
        );
        expectSoundCounts(result, labyrinth);
        expect(result.encounters).toBe(0);
        expect(result.labyAttemptCount).toBeGreaterThan(0);
    });

    test('fights that hit the 120s room timeout resolve as losses, not phantoms', () => {
        // Both sides too tanky to finish: every fight times out
        const { result, labyrinth } = labyrinthRun(
            7,
            {
                staminaLevel: 5000,
                intelligenceLevel: 50,
                attackLevel: 5,
                meleeLevel: 5,
                defenseLevel: 200,
                rangedLevel: 1,
                magicLevel: 1,
            },
            500
        );
        expectSoundCounts(result, labyrinth);
        expect(result.encounters).toBe(0);
        // 500s of 120s timeouts: four resolve, a fifth may be in flight
        expect(result.labyAttemptCount).toBeGreaterThanOrEqual(3);
    });
});

describe('Labyrinth as an isolated zone fight', () => {
    afterEach(() => {
        clearSimRng();
    });

    test('a zone fight builds the monster at its zone tier; a lab room at tier 0', () => {
        // Only what Monster needs to resolve a tiered spawn
        setGameData({
            combatMonsterDetailMap: {
                '/monsters/vampire': {
                    hrid: '/monsters/vampire',
                    name: 'Vampire',
                    combatDetails: {
                        currentHitpoints: 100,
                        maxHitpoints: 100,
                        staminaLevel: 10,
                        intelligenceLevel: 10,
                        attackLevel: 10,
                        meleeLevel: 10,
                        defenseLevel: 10,
                        rangedLevel: 10,
                        magicLevel: 10,
                        combatStats: {},
                    },
                    abilities: [],
                    dropTable: [],
                    rareDropTable: [],
                    elite: false,
                },
            },
            abilityDetailMap: {},
            itemDetailMap: {},
            combatStyleDetailMap: {},
        });
        const lab = new Labyrinth('/monsters/vampire', 0);
        const zoneFight = new Labyrinth('/monsters/vampire', 0, [], null, true, { zoneFight: true, difficultyTier: 5 });

        expect(lab.zoneFight).toBe(false);
        expect(lab.difficultyTier).toBe(0);
        expect(zoneFight.zoneFight).toBe(true);
        expect(zoneFight.difficultyTier).toBe(5);
        expect(lab.getMonster()[0].difficultyTier).toBe(0);
        expect(zoneFight.getMonster()[0].difficultyTier).toBe(5);
    });
});

describe('player build snapshot folds buffs as per-type targets', () => {
    afterEach(() => {
        setPlayerDetailsCapture(false);
        clearSimRng();
        setGameData(null);
    });

    /** One seeded run with the capture on, returning the snapshot */
    function snapshotWith(foldBuffs, permanentHpRatio) {
        installGameData();
        seedSimRng(1);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        // A persistent buff the sim's build already carries — the guild
        // max-HP buff, say — seeded the way `clearBuffs` seeds them
        player.extraBuffs = permanentHpRatio
            ? [
                  {
                      uniqueHrid: '/buff_uniques/guild_hp',
                      typeHrid: '/buff_types/max_hitpoints',
                      ratioBoost: permanentHpRatio,
                      ratioBoostLevelBonus: 0,
                      flatBoost: 0,
                      flatBoostLevelBonus: 0,
                      startTime: 0,
                      duration: Number.MAX_SAFE_INTEGER,
                  },
              ]
            : [];
        setPlayerDetailsCapture(true, foldBuffs);
        new CombatSimulator([player], zone).simulate(30 * ONE_SECOND);
        return getCapturedPlayerDetails();
    }

    const target = (ratio) => ({
        '/buff_uniques/toolasha_fold/max_hitpoints': {
            uniqueHrid: '/buff_uniques/toolasha_fold/max_hitpoints',
            typeHrid: '/buff_types/max_hitpoints',
            ratioBoost: ratio,
            flatBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoostLevelBonus: 0,
            startTime: 0,
            duration: Number.MAX_SAFE_INTEGER,
        },
    });

    test('a target equal to what the build already holds changes nothing (no double count)', () => {
        const snap = snapshotWith(target(0.1), 0.1);
        expect(snap.buffed.maxHitpoints).toBe(snap.base.maxHitpoints);
        expect(snap.deltas['/buff_types/max_hitpoints'].ratioBoost).toBeCloseTo(0, 9);
    });

    test('a target above what the build holds applies only the difference', () => {
        const held = snapshotWith(target(0.3), 0.1);
        // Ratios of one type add to the base: the build already at +10% ends at
        // +30% total — the delta applied was +20%, not +30% on top of +10%
        // The fixture's unbuffed HP is 10 × (10 + stamina 70) = 800
        expect(held.base.maxHitpoints).toBe(Math.floor(800 * 1.1));
        expect(held.buffed.maxHitpoints).toBe(Math.floor(800 * 1.3));
        expect(held.deltas['/buff_types/max_hitpoints'].ratioBoost).toBeCloseTo(0.2, 9);
    });
});

/**
 * What a pass of checkEncounterEnd leaves behind.
 *
 * The event queue outlives the encounter, so anything still queued when
 * this.enemies is replaced keeps acting from outside the fight — and
 * checkEncounterEnd only ever looks at this.enemies, so nothing can ever
 * retire it. These tests pin the two ways that used to happen.
 */
describe('encounter teardown', () => {
    const DUNGEON_HRID = '/actions/combat/golden_crypt';

    /** A simulator sitting in a two-wave dungeon with the first wave spawned. */
    function dungeonSim() {
        installGameData();
        const gameData = getGameData();
        gameData.actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: null,
                dungeonInfo: {
                    maxWaves: 2,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
        seedSimRng(7);
        const zone = new Zone(DUNGEON_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = 10 * ONE_SECOND;
        player.reset(sim.simulationTime);
        sim.enemies = zone.getNextWave();
        sim.enemies.forEach((enemy) => enemy.reset(sim.simulationTime));
        // startNewEncounter opens the wave's alive window; this fixture spawns
        // the wave by hand, so open it here too
        sim.simResult.updateTimeSpentAlive('#' + (zone.encountersKilled - 1).toString(), true, sim.simulationTime);
        return sim;
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('a wipe moments after a wave was cleared leaves nothing queued to respawn', () => {
        const sim = dungeonSim();

        // The wave dies...
        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        expect(sim.checkEncounterEnd()).toBe(true);
        expect(sim.eventQueue.containsEventOfType(EnemyRespawnEvent.type)).toBe(true);

        // ...and a damage-over-time tick finishes the party before it fires
        sim.simulationTime += ONE_SECOND;
        sim.players.forEach((player) => (player.combatDetails.currentHitpoints = 0));
        expect(sim.checkEncounterEnd()).toBe(true);

        expect(sim.eventQueue.containsEventOfType(EnemyRespawnEvent.type)).toBe(false);
    });

    test('and no phantom attacker survives the restart', () => {
        const sim = dungeonSim();

        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();
        sim.simulationTime += ONE_SECOND;
        sim.players.forEach((player) => (player.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();

        // Drive the queue until the restart has spawned the next wave
        for (let i = 0; i < 50 && !sim.enemies; i++) {
            sim.processEvent(sim.eventQueue.getNextEvent());
        }
        expect(sim.enemies).toBeTruthy();

        const known = new Set([...sim.players, ...sim.enemies]);
        const stray = sim.eventQueue.getMatching((event) => event.source && !known.has(event.source));
        expect(stray).toBeNull();
    });

    test('a pass that both clears the wave and wipes the party counts once, as a wipe', () => {
        // Thorns can kill the last monster and the last player in the same blow.
        // A dungeon run ends when the party is down, so the wave is not credited
        const sim = dungeonSim();

        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        sim.players.forEach((player) => (player.combatDetails.currentHitpoints = 0));

        expect(sim.checkEncounterEnd()).toBe(true);

        // No wave credit, no experience, nothing waiting to respawn
        expect(sim.simResult.encounters).toBe(0);
        expect(sim.simResult.experienceGained.player1).toBeUndefined();
        expect(sim.eventQueue.containsEventOfType(EnemyRespawnEvent.type)).toBe(false);

        // Exactly one restart, and one failure once it runs
        const restarts = sim.eventQueue.minHeap.data.filter((e) => e.type === CombatStartEvent.type);
        expect(restarts).toHaveLength(1);
        expect(sim.allPlayersDead).toBe(true);
        sim.startNewEncounter();
        expect(sim.zone.dungeonsFailed).toBe(1);
        expect(sim.zone.dungeonsCompleted).toBe(0);
    });
});

/**
 * Deaths counted by the auto-attack path.
 *
 * Pierce keeps one attack swinging, and a monster picks its next victim by
 * threat. Rolling that against the list of targets alive when the attack
 * *started* can pick a player this same attack already killed: the corpse takes
 * a second 0-damage hit and is counted dead twice.
 */
describe('pierce does not kill anyone twice', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    /**
     * One monster auto-attack with guaranteed pierce into a two-player party
     * standing at a single hitpoint each.
     * @param {number} seed - RNG seed
     * @returns {CombatSimulator}
     */
    function pierceSwing(seed) {
        installGameData();
        seedSimRng(seed);
        const zone = new Zone(ZONE_HRID, 0);
        const players = ['player1', 'player2'].map((hrid) => {
            const player = fixturePlayer();
            player.hrid = hrid;
            player.zoneBuffs = zone.buffs;
            player.extraBuffs = [];
            return player;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((player) => {
            player.reset(sim.simulationTime);
            player.combatDetails.currentHitpoints = 1;
        });
        sim.enemies = [new Monster(TOAD_HRID, 0)];
        sim.enemies[0].reset(sim.simulationTime);
        // Always pierce, so one swing walks the whole party
        sim.enemies[0].combatDetails.combatStats.pierce = 1;

        sim.processAutoAttackEvent(new AutoAttackEvent(sim.simulationTime, sim.enemies[0]));
        return sim;
    }

    test('a player is counted dead once, however many times the swing pierces', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const sim = pierceSwing(seed);
            for (const player of sim.players) {
                const down = player.combatDetails.currentHitpoints === 0;
                expect(sim.simResult.deaths[player.hrid] ?? 0).toBe(down ? 1 : 0);
            }
            clearSimRng();
            setGameData(null);
        }
    });

    test('and no corpse takes a zero-damage hit', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const sim = pierceSwing(seed);
            const landed = sim.simResult.attacks[TOAD_HRID] ?? {};
            for (const byTarget of Object.values(landed)) {
                expect(byTarget.autoAttack?.[0] ?? 0).toBe(0);
            }
            clearSimRng();
            setGameData(null);
        }
    });
});

/**
 * A revived monster is still one spawn.
 *
 * `simResult.deaths[monsterHrid]` is read as a kill count: the combat adapter
 * prices a run's loot by multiplying it against the drop table, and
 * utils/expected-kills.js models the same quantity as spawns per battle. Loot
 * is a spawn's, not a knockdown's, so a monster raised and killed again must
 * still be one.
 */
describe('revive takes the death back', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    const REVIVE_EFFECT = {
        targetType: 'deadAlly',
        combatStyleHrid: '/combat_styles/magic',
        damageFlat: 100,
        damageRatio: 0,
    };

    test('killed, revived, killed again is one kill for drops', () => {
        installGameData();
        seedSimRng(3);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;

        const healer = new Monster(RAT_HRID, 0);
        const victim = new Monster(TOAD_HRID, 0);
        [healer, victim].forEach((monster) => monster.reset(sim.simulationTime));
        sim.enemies = [healer, victim];
        sim.simResult.updateTimeSpentAlive(victim.hrid, true, sim.simulationTime);

        // First death
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        sim.simResult.updateTimeSpentAlive(victim.hrid, false, sim.simulationTime);

        // Raised
        sim.simulationTime += ONE_SECOND;
        sim.processAbilityReviveEffect(healer, { hrid: '/abilities/revive' }, REVIVE_EFFECT);
        expect(victim.combatDetails.currentHitpoints).toBeGreaterThan(0);
        expect(sim.simResult.deaths[TOAD_HRID] ?? 0).toBe(0);

        // And killed for good
        sim.simulationTime += ONE_SECOND;
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        sim.simResult.updateTimeSpentAlive(victim.hrid, false, sim.simulationTime);

        expect(sim.simResult.deaths[TOAD_HRID]).toBe(1);
        const entry = sim.simResult.timeSpentAlive.find((e) => e.name === TOAD_HRID);
        expect(entry.count).toBe(1);
    });

    /**
     * Dying clears every event that names the unit, expiry checks included, and
     * nothing else prunes a buff. A revived unit whose checks were not re-armed
     * kept a timed buff for the rest of the encounter.
     */
    test('a revived unit keeps its buffs only for what is left of their duration', () => {
        installGameData();
        seedSimRng(3);
        const zone = new Zone(ZONE_HRID, 0);
        const players = ['player1', 'player2'].map((hrid) => {
            const p = fixturePlayer();
            p.hrid = hrid;
            p.zoneBuffs = zone.buffs;
            p.extraBuffs = [];
            return p;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((p) => p.reset(sim.simulationTime));

        const victim = players[1];
        victim.addBuff(
            {
                uniqueHrid: '/buff_uniques/test_aura',
                typeHrid: '/buff_types/damage',
                flatBoost: 0,
                ratioBoost: 0.3,
                duration: 10 * ONE_SECOND,
            },
            sim.simulationTime
        );
        const expiry = sim.simulationTime + 10 * ONE_SECOND;

        // Down, which is what sweeps the buff's own expiry check off the queue
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        sim.eventQueue.clearEventsForUnit(victim);

        sim.simulationTime += ONE_SECOND;
        sim.processAbilityReviveEffect(players[0], { hrid: '/abilities/revive' }, REVIVE_EFFECT);

        const checks = sim.eventQueue.minHeap.data.filter(
            (event) => event.type === 'checkBuffExpiration' && event.source === victim
        );
        expect(checks.map((event) => event.time)).toContain(expiry);

        // And the buff really goes when that check fires
        sim.simulationTime = expiry;
        victim.removeExpiredBuffs(sim.simulationTime);
        expect(victim.combatBuffs['/buff_uniques/test_aura']).toBeUndefined();
    });

    test('but a revived player still shows every time they went down', () => {
        installGameData();
        seedSimRng(3);
        const zone = new Zone(ZONE_HRID, 0);
        const players = ['player1', 'player2'].map((hrid) => {
            const p = fixturePlayer();
            p.hrid = hrid;
            p.zoneBuffs = zone.buffs;
            p.extraBuffs = [];
            return p;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((p) => p.reset(sim.simulationTime));

        players[1].combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(players[1]);

        sim.processAbilityReviveEffect(players[0], { hrid: '/abilities/revive' }, REVIVE_EFFECT);

        expect(sim.simResult.deaths.player2).toBe(1);
    });
});

/**
 * Boss progress in an ordinary zone.
 *
 * Zone.failWave() counts a dungeon failure and resets encountersKilled — which
 * outside a dungeon is the count towards the next boss. Running it on any death
 * wiped boss progress in ordinary zones, a reset the game does not do
 * (utils/expected-kills.js models none either).
 */
describe('dying in an ordinary zone', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('keeps the progress towards the next boss', () => {
        installGameData();
        seedSimRng(11);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();

        zone.getRandomEncounter();
        zone.getRandomEncounter();
        const progress = zone.encountersKilled;
        expect(progress).toBeGreaterThan(1);

        sim.allPlayersDead = true;
        sim.startNewEncounter();

        expect(zone.encountersKilled).toBeGreaterThan(progress);
        expect(zone.dungeonsFailed).toBe(0);
    });
});

/**
 * A monster with a missing or zero enrageTime must not poison XP.
 *
 * checkEncounterEnd divides by enrageTime to compute experienceRate; a
 * degenerate 0/absent value made it NaN, and NaN slips past both the `=== 0`
 * re-check and the `<= 0` warning, silently zeroing every awarded XP total.
 */
describe('a monster with no enrage time', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('yields finite XP instead of NaN', () => {
        installGameData();
        seedSimRng(7);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = 5 * ONE_SECOND;
        sim.enrageBeginTime = 0;
        player.reset(sim.simulationTime);

        const victim = new Monster(TOAD_HRID, 0);
        victim.reset(sim.simulationTime);
        // Degenerate game data: enrageTime absent/zero
        victim.enrageTime = 0;
        victim.combatDetails.currentHitpoints = 0;
        sim.enemies = [victim];

        sim.checkEncounterEnd();

        expect(victim.experienceRate).toBe(1.0);
        const xp = sim.simResult.experienceGained.player1;
        Object.values(xp).forEach((value) => expect(Number.isFinite(value)).toBe(true));
        expect(xp.melee).toBeGreaterThan(0);
    });
});

/**
 * A damage-over-time tick must never re-kill a corpse.
 *
 * Every melee death site reads targetWasAlive before the blow so a zero-damage
 * hit on a downed unit is not credited as a fresh death; the DoT tick lacked
 * that guard. It is currently unreachable (clearEventsForUnit drops queued DoT
 * ticks on death), but one event-ordering change from double-counting a kill —
 * and deaths[monsterHrid] prices a run's loot.
 */
describe('a damage-over-time tick on a corpse', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('does not count a second death on an already-dead unit', () => {
        installGameData();
        seedSimRng(5);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;

        const victim = new Monster(TOAD_HRID, 0);
        victim.reset(sim.simulationTime);
        sim.enemies = [victim];

        // Already down and already counted once
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        expect(sim.simResult.deaths[TOAD_HRID]).toBe(1);

        const tick = new DamageOverTimeEvent(sim.simulationTime, player, victim, 100, 5, 1, '/combat_styles/smash');
        sim.processDamageOverTimeTickEvent(tick);

        expect(sim.simResult.deaths[TOAD_HRID]).toBe(1);
    });
});

/**
 * A damage-over-time tick outside a dungeon must not fill the wipe-log buffer.
 *
 * The other seven addToWipeLogs sites gate on zone.isDungeon; the DoT tick did
 * not, so in a dungeon its per-tick lines evict the damage that explains a wipe
 * from the 200-entry ring buffer. Diagnostic only — no simulated number moves.
 */
describe('a damage-over-time tick outside a dungeon', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('writes no wipe-log line', () => {
        installGameData();
        seedSimRng(6);
        const zone = new Zone(ZONE_HRID, 0);
        expect(zone.isDungeon).toBe(false);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;

        const victim = new Monster(TOAD_HRID, 0);
        victim.reset(sim.simulationTime);
        sim.enemies = [victim];

        const tick = new DamageOverTimeEvent(sim.simulationTime, player, victim, 100, 5, 1, '/combat_styles/smash');
        sim.processDamageOverTimeTickEvent(tick);

        expect(sim.wipeLogs.count).toBe(0);
    });
});

/**
 * "Avg completion time" must match the in-game dungeon tracker's key→key
 * definition: the mean of completion-to-completion intervals over consecutive
 * successful runs. The old `simulatedTime / dungeonsCompleted` divided the whole
 * simulated window (including the unfinished final run, and any wipe time) by
 * only the completed runs, so it read systematically longer than a real clear.
 */
describe('dungeon clean clear-time metric', () => {
    const DUNGEON_HRID = '/actions/combat/golden_crypt';

    function installDungeon(maxWaves = 2) {
        installGameData();
        getGameData().actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: { bossSpawns: null },
                dungeonInfo: {
                    maxWaves,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('averages completion-to-completion intervals, excluding the unfinished tail', () => {
        installDungeon();
        seedSimRng(11);
        const zone = new Zone(DUNGEON_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];

        const result = new CombatSimulator([player], zone).simulate(600 * ONE_SECOND);

        // The fixture player clears these trivial waves every time
        expect(result.isDungeon).toBe(true);
        expect(result.dungeonsFailed).toBe(0);
        expect(result.dungeonsCompleted).toBeGreaterThan(2);

        // With no wipes, every completion after the first forms a clean pair
        expect(result.dungeonCleanClearCount).toBe(result.dungeonsCompleted - 1);
        expect(result.dungeonCleanClearTimeTotal).toBeGreaterThan(0);

        const cleanAvg = result.dungeonCleanClearTimeTotal / result.dungeonCleanClearCount;
        const naiveAvg = result.simulatedTime / result.dungeonsCompleted;

        // The naive average carries the unfinished final run's elapsed time in
        // its numerator without crediting it, so it is strictly larger.
        expect(cleanAvg).toBeLessThan(naiveAvg);

        // Each clean pair is exactly one completion-to-completion interval; they
        // are consistent, so the total is an integer multiple of one cycle.
        const perCycle = result.dungeonCleanClearTimeTotal / result.dungeonCleanClearCount;
        expect(perCycle).toBeGreaterThan(0);
    });

    test('a wipe breaks the clear-time pair', () => {
        installDungeon();
        seedSimRng(3);
        const zone = new Zone(DUNGEON_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = 10 * ONE_SECOND;
        player.reset(sim.simulationTime);
        sim.enemies = zone.getNextWave();
        sim.enemies.forEach((enemy) => enemy.reset(sim.simulationTime));
        // Open the wave's alive window that startNewEncounter would have opened
        sim.simResult.updateTimeSpentAlive('#' + (zone.encountersKilled - 1).toString(), true, sim.simulationTime);

        // Clear the wave, then wipe the party
        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();
        sim.simulationTime += ONE_SECOND;
        sim.players.forEach((p) => (p.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();

        expect(sim.dungeonPairBroken).toBe(true);
    });
});

/**
 * The other two doors a downed player comes back through.
 *
 * A cast revive re-arms the buff expiry checks that dying swept off the queue.
 * Nothing else prunes a buff, so every other path that puts a corpse back on its
 * feet owes the same re-arming: clearing a dungeon heals the whole party
 * (survivors and corpses alike), and a wipe restart resets the party while
 * deliberately keeping its still-running buffs. Both left a timed buff running
 * for the rest of the run — an accuracy or damage aura that never lapses is a
 * free permanent upgrade the player does not have.
 */
describe('a buff does not outlive its duration when a downed player is put back up', () => {
    const DUNGEON_HRID = '/actions/combat/golden_crypt';
    const TEST_BUFF = {
        uniqueHrid: '/buff_uniques/test_aura',
        typeHrid: '/buff_types/damage',
        flatBoost: 0,
        ratioBoost: 0.3,
        duration: 10 * ONE_SECOND,
    };

    /** A two-wave dungeon of fixed rosters — the wave draw is not what is under test. */
    function installDungeon() {
        installGameData();
        getGameData().actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: { bossSpawns: null },
                dungeonInfo: {
                    maxWaves: 2,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
    }

    /**
     * A seeded dungeon sim with `count` players, each buffed and ready to fight.
     * @param {number} count - Party size
     * @returns {{sim: CombatSimulator, zone: Zone, players: Player[]}}
     */
    function buffedParty(count) {
        installDungeon();
        seedSimRng(3);
        const zone = new Zone(DUNGEON_HRID, 0);
        const players = Array.from({ length: count }, (_, i) => {
            const player = fixturePlayer();
            player.hrid = 'player' + (i + 1);
            player.zoneBuffs = zone.buffs;
            player.extraBuffs = [];
            return player;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((player) => player.reset(sim.simulationTime));
        players.forEach((player) => player.addBuff(TEST_BUFF, sim.simulationTime));
        return { sim, zone, players };
    }

    /**
     * The buff-expiry checks standing for one unit.
     * @param {CombatSimulator} sim - The simulator to read
     * @param {Object} unit - The unit the checks must name
     * @returns {number[]} Their event times
     */
    function expiryChecks(sim, unit) {
        return sim.eventQueue.minHeap.data
            .filter((event) => event.type === 'checkBuffExpiration' && event.source === unit)
            .map((event) => event.time);
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('clearing the dungeon re-arms the checks of a party member who died on the way', () => {
        const { sim, zone, players } = buffedParty(2);
        const expiry = sim.simulationTime + TEST_BUFF.duration;

        // One player goes down mid-run; in a dungeon nobody respawns, so they
        // stay down until the clear. Dying is what sweeps their expiry check.
        const victim = players[1];
        victim.combatDetails.currentHitpoints = 0;
        sim.eventQueue.clearEventsForUnit(victim);
        expect(expiryChecks(sim, victim)).toEqual([]);

        // The next wave wraps past maxWaves — the clear that heals the party
        zone.encountersKilled = 3;
        sim.enemies = null;
        sim.simulationTime += ONE_SECOND;
        sim.startNewEncounter();

        expect(zone.dungeonsCompleted).toBe(1);
        expect(victim.combatDetails.currentHitpoints).toBe(victim.combatDetails.maxHitpoints);
        expect(expiryChecks(sim, victim)).toContain(expiry);

        // And the buff really goes when that check fires
        sim.simulationTime = expiry;
        victim.removeExpiredBuffs(sim.simulationTime);
        expect(victim.combatBuffs[TEST_BUFF.uniqueHrid]).toBeUndefined();
    });

    test('a wipe restart re-arms the checks the wipe itself threw away', () => {
        const { sim, players } = buffedParty(1);
        const expiry = sim.simulationTime + TEST_BUFF.duration;

        const victim = players[0];
        victim.combatDetails.currentHitpoints = 0;
        sim.eventQueue.clearEventsForUnit(victim);
        sim.allPlayersDead = true;
        sim.enemies = null;

        // The CombatStartEvent the wipe schedules. reset() keeps the buff by
        // design (it is still inside its duration), so the check must come back.
        sim.simulationTime += ONE_SECOND;
        sim.processCombatStartEvent({ time: sim.simulationTime });

        expect(victim.combatBuffs[TEST_BUFF.uniqueHrid]).toBeDefined();
        expect(expiryChecks(sim, victim)).toContain(expiry);

        sim.simulationTime = expiry;
        victim.removeExpiredBuffs(sim.simulationTime);
        expect(victim.combatBuffs[TEST_BUFF.uniqueHrid]).toBeUndefined();
    });
});
