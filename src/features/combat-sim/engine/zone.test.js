// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Tests for Zone spawn determinism under a seeded RNG.
 * Two sims compared against each other must fight the same monster sequence,
 * or the difference between them is partly just a different set of enemies.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from './game-data.js';
import { clearSimRng, random, randomSpawn, seedSimRng } from './rng.js';
import Zone from './zone.js';

const ZONE_HRID = '/actions/combat/test_zone';

const MONSTERS = ['/monsters/a', '/monsters/b', '/monsters/c', '/monsters/d'];

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
                            maxSpawnCount: 3,
                            maxTotalStrength: 6,
                            spawns: MONSTERS.map((hrid, i) => ({
                                combatMonsterHrid: hrid,
                                difficultyTier: 0,
                                rate: i + 1,
                                strength: 2,
                            })),
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: Object.fromEntries(MONSTERS.map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])),
    });
}

/**
 * Roll a run of encounters and flatten them to monster hrids.
 * @param {number} count - Encounters to draw
 * @returns {string[][]}
 */
function rollEncounters(count) {
    const zone = new Zone(ZONE_HRID, 0);
    return Array.from({ length: count }, () => zone.getRandomEncounter().map((monster) => monster.hrid));
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('Zone spawns with a seeded RNG', () => {
    test('same seed replays the same encounter sequence', () => {
        installGameData();

        seedSimRng(4242);
        const first = rollEncounters(40);

        seedSimRng(4242);
        expect(rollEncounters(40)).toEqual(first);
    });

    test('different seeds give different encounter sequences', () => {
        installGameData();

        seedSimRng(1);
        const first = rollEncounters(40);

        seedSimRng(2);
        expect(rollEncounters(40)).not.toEqual(first);
    });

    test('combat rolls do not shift the spawn sequence', () => {
        installGameData();

        seedSimRng(777);
        const clean = rollEncounters(30);

        // Stand in for a stronger loadout burning a different number of combat
        // rolls between encounters — the spawns must not move
        seedSimRng(777);
        const zone = new Zone(ZONE_HRID, 0);
        const interleaved = [];
        for (let i = 0; i < 30; i++) {
            for (let r = 0; r < i * 3; r++) random();
            interleaved.push(zone.getRandomEncounter().map((monster) => monster.hrid));
        }

        expect(interleaved).toEqual(clean);
    });

    test('a normal zone spends exactly one spawn draw per monster slot', () => {
        // The dungeon table rule spends an extra spawn draw per wave, but only
        // on the dungeon path. A normal zone must walk the spawn stream at the
        // rate it always did, or every seeded comparison against a recorded run
        // shifts by a draw per encounter.
        installGameData();

        seedSimRng(31);
        rollEncounters(20);
        const afterEncounters = randomSpawn();

        seedSimRng(31);
        for (let draw = 0; draw < 20 * 3; draw++) randomSpawn();

        // 3 draws per encounter: maxSpawnCount 3, and 3 x strength 2 exactly
        // fills maxTotalStrength 6, so no wave ends early
        expect(randomSpawn()).toBe(afterEncounters);
    });

    test('unseeded runs stay independent samples', () => {
        installGameData();

        const first = rollEncounters(60);
        const second = rollEncounters(60);
        expect(second).not.toEqual(first);
    });
});

/**
 * How often a boss comes round, and where that number comes from.
 *
 * `monsterSpawnInfo` is a live reference into the shared actionDetailMap, so
 * writing the boss cadence onto it rewrote the game data for every other reader
 * — utils/combat-drop-model.js and utils/expected-kills.js both read the fight's
 * own `battlesPerBoss`, and both saw whatever the last Zone constructed had
 * stamped there.
 */
describe('boss cadence', () => {
    const BOSS_HRID = '/monsters/boss';

    /**
     * Game data whose fight carries an explicit battlesPerBoss.
     * @param {number|undefined} battlesPerBoss - The zone's own cadence, or undefined for none
     * @returns {Object} The fightInfo object the zone will read
     */
    function installBossZone(battlesPerBoss) {
        const fightInfo = {
            bossSpawns: [{ combatMonsterHrid: BOSS_HRID, difficultyTier: 0 }],
            randomSpawnInfo: {
                maxSpawnCount: 1,
                maxTotalStrength: 2,
                spawns: [{ combatMonsterHrid: MONSTERS[0], difficultyTier: 0, rate: 1, strength: 1 }],
            },
        };
        if (battlesPerBoss !== undefined) fightInfo.battlesPerBoss = battlesPerBoss;

        setGameData({
            actionDetailMap: {
                [ZONE_HRID]: {
                    buffs: null,
                    combatZoneInfo: { isDungeon: false, dungeonInfo: null, fightInfo },
                },
            },
            combatMonsterDetailMap: Object.fromEntries(
                [...MONSTERS, BOSS_HRID].map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])
            ),
        });
        return fightInfo;
    }

    /**
     * Which of `count` encounters were the boss.
     * @param {Zone} zone - The zone to roll
     * @param {number} count - Encounters to draw
     * @returns {number[]} 1-based positions of the boss encounters
     */
    function bossAt(zone, count) {
        const at = [];
        for (let i = 1; i <= count; i++) {
            if (zone.getRandomEncounter().some((monster) => monster.hrid === BOSS_HRID)) at.push(i);
        }
        return at;
    }

    test('constructing a zone leaves the shared game data alone', () => {
        const fightInfo = installBossZone(undefined);

        new Zone(ZONE_HRID, 0);

        expect('battlesPerBoss' in fightInfo).toBe(false);
    });

    test('a zone with its own cadence uses it', () => {
        installBossZone(5);
        seedSimRng(5);

        expect(bossAt(new Zone(ZONE_HRID, 0), 12)).toEqual([5, 10]);
    });

    test('and one without falls back to ten, the same default the drop model uses', () => {
        installBossZone(undefined);
        seedSimRng(5);

        expect(bossAt(new Zone(ZONE_HRID, 0), 12)).toEqual([10]);
    });
});

/**
 * Dungeon waves: which table a wave draws from, and what a strength overflow does.
 *
 * These pin the measured reading of `randomSpawnInfoMap`: a key is the earliest
 * wave its table may be drawn from, a wave is drawn whole from exactly one
 * eligible table, each eligible table BELOW the highest one reached is drawn
 * with probability 1/7, and a draw that would break `maxTotalStrength` ends the
 * wave. The 1/7 comes from a maximum-likelihood mixture fit over 3078 ordinary
 * waves of Chimerical Den (2609), Pirate Cove (268), Enchanted Fortress (106)
 * and Sinister Circus (95), against the spawn tables as read from the live game
 * client -- pooled estimate 0.1335, 95% profile interval [0.1226, 0.1448],
 * which still contains 1/7 = 0.1429 (cost 1.32 log-likelihood, p = 0.10) but
 * excludes 0.15 and 1/6. 1/7 is kept over the estimate because the two are
 * indistinguishable on predicted mean wave hitpoints (summed squared
 * standardized error 6.0 either way over the eight multi-table bands, against
 * 292.8 for the highest-only engine) and differ by 0.4% of a dungeon's
 * random-wave HP. The weight is flat across lower tables: a taper with distance
 * below the current key buys dLL = +1.19 for one parameter, p = 0.12, and the
 * raw counts that appear to favour a taper are a detectability artefact (see
 * the note in zone.js). The overflow rule is still an inference. Anything that
 * changes either has to be deliberate rather than incidental.
 */
describe('dungeon waves', () => {
    const DUNGEON_HRID = '/actions/combat/test_dungeon';
    const EARLY = '/monsters/early';
    const MID = '/monsters/mid';
    const LATE = '/monsters/late';
    const FIXED = '/monsters/fixed';
    const CHEAP = '/monsters/cheap';
    const HEAVY = '/monsters/heavy';
    /** Eight interchangeable species, one per table, for the many-table cases. */
    const TABLE_SPECIES = Array.from({ length: 8 }, (_, key) => `/monsters/table_${key}`);

    /**
     * One entry per band, each band a single identifiable species so a wave's
     * roster names the table it was drawn from.
     * @param {string} hrid - The band's only species
     * @param {Object} [over] - Overrides for maxSpawnCount/maxTotalStrength/spawns
     * @returns {Object} A randomSpawnInfoMap entry
     */
    function band(hrid, over = {}) {
        return {
            maxSpawnCount: 1,
            maxTotalStrength: 10,
            spawns: [{ combatMonsterHrid: hrid, difficultyTier: 0, rate: 1, strength: 1 }],
            ...over,
        };
    }

    /**
     * Install a dungeon and return a Zone for it.
     * @param {Object} dungeonInfo - The zone's combatZoneInfo.dungeonInfo
     * @returns {Zone}
     */
    function installDungeon(dungeonInfo) {
        const hrids = [EARLY, MID, LATE, FIXED, CHEAP, HEAVY, ...TABLE_SPECIES];
        setGameData({
            actionDetailMap: {
                [DUNGEON_HRID]: {
                    buffs: null,
                    combatZoneInfo: { isDungeon: true, fightInfo: null, dungeonInfo },
                },
            },
            combatMonsterDetailMap: Object.fromEntries(hrids.map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])),
        });
        return new Zone(DUNGEON_HRID, 0);
    }

    /**
     * The dungeon used for band selection: three tables keyed 0 / 10 / 30, and a
     * fixed roster on every fifth wave, the way the real dungeons are shaped.
     * @returns {Zone}
     */
    function installBandedDungeon() {
        const fixedSpawnsMap = {};
        for (let wave = 5; wave <= 50; wave += 5) {
            fixedSpawnsMap[String(wave)] = [{ combatMonsterHrid: FIXED, difficultyTier: 0 }];
        }
        return installDungeon({
            maxWaves: 50,
            fixedSpawnsMap,
            randomSpawnInfoMap: { 0: band(EARLY), 10: band(MID), 30: band(LATE) },
        });
    }

    /**
     * Roll `count` waves and name the species each one produced.
     * @param {Zone} zone - The dungeon to roll
     * @param {number} count - Waves to draw
     * @returns {string[]} One hrid per wave (waves are single-monster here)
     */
    function waveSpecies(zone, count) {
        return Array.from({ length: count }, () => zone.getNextWave()[0].hrid);
    }

    test('a wave with a fixed roster ignores the random tables', () => {
        seedSimRng(11);
        const species = waveSpecies(installBandedDungeon(), 10);

        expect(species[4]).toBe(FIXED);
        expect(species[9]).toBe(FIXED);
    });

    test('a random wave usually draws from the highest-keyed table it has reached', () => {
        seedSimRng(11);
        const species = waveSpecies(installBandedDungeon(), 50);

        // waves 1-9 -> key 0 only, 10-29 -> usually key 10, 30-50 -> usually key 30
        const bandOf = (wave) => species[wave - 1];
        const ordinary = (from, to) =>
            Array.from({ length: to - from + 1 }, (_, i) => from + i)
                .filter((wave) => wave % 5 !== 0)
                .map(bandOf);
        expect(ordinary(1, 9)).toEqual(Array(8).fill(EARLY));
        const mid = ordinary(11, 29);
        expect(mid.filter((one) => one === MID).length).toBeGreaterThan(mid.length / 2);
        const late = ordinary(31, 49);
        expect(late.filter((one) => one === LATE).length).toBeGreaterThan(late.length / 2);
    });

    test('before a second table is eligible the wave is not a lottery', () => {
        // One eligible table means no choice to make, so every seed agrees.
        for (const seed of [1, 2, 3, 4, 5]) {
            seedSimRng(seed);
            expect(waveSpecies(installBandedDungeon(), 4)).toEqual(Array(4).fill(EARLY));
        }
    });

    test('each eligible lower table takes about a seventh of the waves', () => {
        // Measured, not documented: 384 of 3078 ordinary waves recorded in
        // Chimerical Den, Pirate Cove, Enchanted Fortress and Sinister Circus are
        // clean draws from a strictly lower table, and the per-table share does
        // not shrink as more tables become eligible — which is what rules out the
        // eligible tables sharing one budget between them, by dLL = +24.23
        // (3.3e10:1) on the same single parameter, in every dungeon separately
        // and in every leave-one-dungeon-out subset. Nor does it taper with
        // distance below the current key: dLL = +1.19 for that extra parameter,
        // p = 0.12, with Chimerical band 30's own 1048 waves putting one step
        // below at 0.140 [0.117, 0.164] and two steps at 0.122 [0.103, 0.142].
        // See the note in zone.js.
        seedSimRng(20260903);
        const zone = installBandedDungeon();
        const runs = 400;
        const species = waveSpecies(zone, 50 * runs);

        const share = (waves, hrid) => {
            const drawn = waves.map((wave) => species[wave - 1]);
            return drawn.filter((one) => one === hrid).length / drawn.length;
        };
        const wavesIn = (from, to) => {
            const local = Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((wave) => wave % 5 !== 0);
            return Array.from({ length: runs }, (_, run) => run * 50).flatMap((offset) =>
                local.map((wave) => offset + wave)
            );
        };

        // One lower table eligible: it takes ~1/7, the current one the rest.
        const mid = wavesIn(10, 29);
        expect(share(mid, EARLY)).toBeGreaterThan(0.11);
        expect(share(mid, EARLY)).toBeLessThan(0.17);
        expect(share(mid, LATE)).toBe(0);

        // Two lower tables eligible: each still takes ~1/7, so the current table
        // keeps ~5/7 rather than the ~6/7 a shared budget would leave it.
        const late = wavesIn(30, 49);
        expect(share(late, EARLY)).toBeGreaterThan(0.11);
        expect(share(late, EARLY)).toBeLessThan(0.17);
        expect(share(late, MID)).toBeGreaterThan(0.11);
        expect(share(late, MID)).toBeLessThan(0.17);
        expect(share(late, LATE)).toBeGreaterThan(0.66);
        expect(share(late, LATE)).toBeLessThan(0.77);
    });

    test('three eligible lower tables each still take a seventh, with no boundary bias', () => {
        // The lower table is picked by `floor(roll / rate)`, which partitions
        // the roll into equal-width slices, so the three must come out equal to
        // within sampling error rather than one edge slice being fatter.
        const flat = { 0: band(EARLY), 1: band(MID), 2: band(LATE), 3: band(CHEAP) };
        seedSimRng(4321);
        const zone = installDungeon({ maxWaves: 1000, fixedSpawnsMap: {}, randomSpawnInfoMap: flat });

        const counts = {};
        for (let i = 0; i < 70000; i++) {
            const hrid = zone.getNextWave()[0].hrid;
            if (zone.encountersKilled - 1 >= 4) counts[hrid] = (counts[hrid] || 0) + 1;
        }
        const total = Object.values(counts).reduce((sum, one) => sum + one, 0);

        for (const lower of [EARLY, MID, LATE]) {
            expect(counts[lower] / total).toBeGreaterThan(0.13);
            expect(counts[lower] / total).toBeLessThan(0.155);
        }
        expect(counts[CHEAP] / total).toBeGreaterThan(0.55);
        expect(counts[CHEAP] / total).toBeLessThan(0.59);
    });

    test('seven eligible lower tables do not squeeze the current one out', () => {
        // 1/7 * 7 === 1 exactly in doubles, so an uncapped rate spends the whole
        // roll on the lower tables: the wave's own band is never drawn and the
        // last lower table absorbs its share. No dungeon has eight tables, but a
        // rule that silently deletes the top band if one ever does is not a
        // rule. Capped, the draw degrades to uniform over all eight.
        const tables = {};
        for (let key = 0; key < 8; key++) {
            tables[key] = band(`/monsters/table_${key}`);
        }
        seedSimRng(1);
        const zone = installDungeon({ maxWaves: 1000, fixedSpawnsMap: {}, randomSpawnInfoMap: tables });

        const counts = {};
        for (let i = 0; i < 24000; i++) {
            const hrid = zone.getNextWave()[0].hrid;
            if (zone.encountersKilled - 1 >= 8) counts[hrid] = (counts[hrid] || 0) + 1;
        }
        const total = Object.values(counts).reduce((sum, one) => sum + one, 0);

        // Pre-cap this was 0 of ~20000 waves.
        expect(counts['/monsters/table_7'] / total).toBeGreaterThan(0.1);
        for (let key = 0; key < 8; key++) {
            expect(counts[`/monsters/table_${key}`] / total).toBeGreaterThan(0.1);
            expect(counts[`/monsters/table_${key}`] / total).toBeLessThan(0.15);
        }
    });

    test('the cap leaves six lower tables exactly where they were', () => {
        // 1 / 7 eligible tables === LOWER_TABLE_RATE, so the cap is a no-op at
        // six lower tables and below — every live dungeon, which has three
        // tables at most. Pinned from the pre-cap engine, same seed, same rolls.
        const tables = {};
        for (let key = 0; key < 7; key++) {
            tables[key] = band(`/monsters/table_${key}`);
        }
        seedSimRng(31337);
        const zone = installDungeon({ maxWaves: 1000, fixedSpawnsMap: {}, randomSpawnInfoMap: tables });
        const drawn = Array.from({ length: 60 }, () => zone.getNextWave()[0].hrid.slice(-1)).join('');

        expect(drawn).toBe('113330026100233341563344056442203361152062005421110204056353');
    });

    test('the table choice replays from the seed', () => {
        seedSimRng(99);
        const first = waveSpecies(installBandedDungeon(), 150);

        seedSimRng(99);
        expect(waveSpecies(installBandedDungeon(), 150)).toEqual(first);
    });

    test('no table is drawn from before the wave its key names', () => {
        seedSimRng(11);
        const species = waveSpecies(installBandedDungeon(), 50);

        // Confirmed against 3078 live waves across Chimerical Den, Pirate Cove,
        // Enchanted Fortress and Sinister Circus: a species never appears below
        // its own key's wave, and the top-table species first show up on the wave
        // after that key — a key-20 species is first seen on wave 21 in both
        // Pirate Cove and Enchanted Fortress, never on wave 20.
        expect(species.slice(0, 9)).not.toContain(MID);
        expect(species.slice(0, 9)).not.toContain(LATE);
        expect(species.slice(0, 29)).not.toContain(LATE);
    });

    /**
     * Wave `== key` never draws from that key's random table, because every
     * live dungeon's random keys are also fixed-roster waves and `getNextWave`
     * checks `fixedSpawnsMap` first (zone.js line ~92). `waveNum >= key`
     * (zone.js line ~224) makes the table eligible starting at wave `key`, but
     * eligible is as far as it gets that wave — the fixed roster wins the tie,
     * so the earliest the table can actually be drawn is wave `key + 1`. That
     * is the fact the note above `eligibleKeys` in zone.js leans on, and this
     * is what would fail if a future dungeon shipped a random key with no
     * matching fixed wave.
     *
     * No fixture of real dungeon data lives in this repo, so the key sets
     * below are a compact stand-in, hand-transcribed from the live game
     * client (2026-09-05): every non-zero randomSpawnInfoMap key, and the
     * fixedSpawnsMap keys, for the four dungeons that have random tables at
     * all.
     */
    describe("every random spawn table's key is a fixed wave, so wave == key never draws random", () => {
        const REAL_DUNGEONS = {
            chimerical_den: { maxWaves: 50, randomKeys: [0, 10, 30], fixedStep: 5 },
            enchanted_fortress: { maxWaves: 65, randomKeys: [0, 20, 40], fixedStep: 5 },
            pirate_cove: { maxWaves: 65, randomKeys: [0, 20, 40], fixedStep: 5 },
            sinister_circus: { maxWaves: 60, randomKeys: [0, 15, 40], fixedStep: 5 },
        };

        for (const [name, { maxWaves, randomKeys, fixedStep }] of Object.entries(REAL_DUNGEONS)) {
            test(`${name}: every non-zero random key is a fixedSpawnsMap key`, () => {
                const fixedWaves = new Set();
                for (let wave = fixedStep; wave <= maxWaves; wave += fixedStep) fixedWaves.add(wave);

                for (const key of randomKeys) {
                    if (key === 0) continue;
                    expect(fixedWaves.has(key)).toBe(true);
                }
            });

            test(`${name}: getNextWave at wave == key returns the fixed roster, not a random draw`, () => {
                const fixedSpawnsMap = {};
                for (let wave = fixedStep; wave <= maxWaves; wave += fixedStep) {
                    fixedSpawnsMap[String(wave)] = [{ combatMonsterHrid: FIXED, difficultyTier: 0 }];
                }
                const randomSpawnInfoMap = Object.fromEntries(randomKeys.map((key) => [key, band(EARLY)]));
                const zone = installDungeon({ maxWaves, fixedSpawnsMap, randomSpawnInfoMap });

                seedSimRng(11);
                const species = waveSpecies(zone, maxWaves);

                for (const key of randomKeys) {
                    if (key === 0) continue;
                    expect(species[key - 1]).toBe(FIXED);
                }
            });
        }
    });

    test('the counter wraps at maxWaves and records the clear', () => {
        seedSimRng(11);
        const zone = installBandedDungeon();
        waveSpecies(zone, 50);

        expect(zone.dungeonsCompleted).toBe(0);
        // Wave 1 again: only the key-0 table is eligible, whatever the roll.
        expect(zone.getNextWave()[0].hrid).toBe(EARLY);
        expect(zone.dungeonsCompleted).toBe(1);
    });

    test('a draw that would break maxTotalStrength ends the wave rather than being skipped', () => {
        // A cheap monster fits five times over; a heavy one never fits at all,
        // so every heavy draw is an overflow wherever it lands in the wave.
        const overflowDungeon = () =>
            installDungeon({
                maxWaves: 1000,
                fixedSpawnsMap: {},
                randomSpawnInfoMap: {
                    0: band(CHEAP, {
                        maxSpawnCount: 5,
                        maxTotalStrength: 100,
                        spawns: [
                            { combatMonsterHrid: CHEAP, difficultyTier: 0, rate: 1, strength: 1 },
                            { combatMonsterHrid: HEAVY, difficultyTier: 0, rate: 1, strength: 101 },
                        ],
                    }),
                },
            });

        seedSimRng(1);
        // Draw two was heavy; skipping it would have let draws three to five keep filling the wave.
        expect(
            overflowDungeon()
                .getNextWave()
                .map((monster) => monster.hrid)
        ).toEqual([CHEAP]);

        seedSimRng(1);
        const zone = overflowDungeon();
        const sizes = Array.from({ length: 400 }, () => zone.getNextWave().length);
        // Stopping at the first overflow leaves E[size] = sum of 2^-k for k=1..5, ~0.97;
        // skipping and continuing would keep all five draws and average 2.5.
        const mean = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
        expect(mean).toBeGreaterThan(0.8);
        expect(mean).toBeLessThan(1.2);
        // A heavy first draw ends the wave before anything is added at all.
        expect(sizes.some((size) => size === 0)).toBe(true);
    });
});
