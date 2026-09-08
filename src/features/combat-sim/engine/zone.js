// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { randomSpawn } from './rng.js';
import { getGameData } from './game-data.js';
import Monster from './monster.js';

/**
 * Chance a dungeon wave is drawn from any one table below the highest it has
 * reached. Measured, not documented — see the note in `getNextWave`.
 */
const LOWER_TABLE_RATE = 1 / 7;

class Zone {
    constructor(hrid, difficultyTier) {
        this.hrid = hrid;
        this.difficultyTier = difficultyTier;

        const actionDetailMap = getGameData().actionDetailMap;
        const gameZone = actionDetailMap[this.hrid];
        this.monsterSpawnInfo = gameZone.combatZoneInfo.fightInfo;
        this.dungeonSpawnInfo = gameZone.combatZoneInfo.dungeonInfo;
        this.encountersKilled = 1;
        this.buffs = gameZone.buffs;
        this.isDungeon = gameZone.combatZoneInfo.isDungeon;
        this.dungeonsCompleted = 0;
        this.dungeonsFailed = 0;
        this.finalWave = false;

        // Read, never written: monsterSpawnInfo is a live reference into the
        // shared actionDetailMap, so assigning here rewrote the game data every
        // other reader sees. The zone's own value wins, 10 is the fallback —
        // the same default utils/combat-drop-model.js and utils/expected-kills.js
        // apply to the fight's real battlesPerBoss.
        this.battlesPerBoss = this.monsterSpawnInfo?.battlesPerBoss || 10;
    }

    getRandomEncounter() {
        if (!this.monsterSpawnInfo) {
            return [];
        }

        if (this.monsterSpawnInfo.bossSpawns && this.encountersKilled === this.battlesPerBoss) {
            this.encountersKilled = 1;
            return this.monsterSpawnInfo.bossSpawns.map(
                (monster) => new Monster(monster.combatMonsterHrid, monster.difficultyTier + this.difficultyTier)
            );
        }

        if (!this.monsterSpawnInfo.randomSpawnInfo || !this.monsterSpawnInfo.randomSpawnInfo.spawns) {
            this.encountersKilled++;
            return [];
        }

        const totalWeight = this.monsterSpawnInfo.randomSpawnInfo.spawns.reduce((prev, cur) => prev + cur.rate, 0);

        const encounterHrids = [];
        let totalStrength = 0;

        outer: for (let i = 0; i < this.monsterSpawnInfo.randomSpawnInfo.maxSpawnCount; i++) {
            const randomWeight = totalWeight * randomSpawn();
            let cumulativeWeight = 0;

            for (const spawn of this.monsterSpawnInfo.randomSpawnInfo.spawns) {
                cumulativeWeight += spawn.rate;
                if (randomWeight <= cumulativeWeight) {
                    totalStrength += spawn.strength;

                    if (totalStrength <= this.monsterSpawnInfo.randomSpawnInfo.maxTotalStrength) {
                        encounterHrids.push({ hrid: spawn.combatMonsterHrid, difficultyTier: spawn.difficultyTier });
                    } else {
                        break outer;
                    }
                    break;
                }
            }
        }
        this.encountersKilled++;
        return encounterHrids.map((hrid) => new Monster(hrid.hrid, hrid.difficultyTier + this.difficultyTier));
    }

    failWave() {
        this.dungeonsFailed++;
        this.encountersKilled = 1;
    }

    getNextWave() {
        if (this.encountersKilled > this.dungeonSpawnInfo.maxWaves) {
            this.dungeonsCompleted++;
            this.encountersKilled = 1;
        }

        const waveNum = this.encountersKilled;
        const fixedSpawns = this.dungeonSpawnInfo.fixedSpawnsMap[waveNum.toString()];

        if (fixedSpawns) {
            this.encountersKilled++;
            return fixedSpawns.map(
                (monster) => new Monster(monster.combatMonsterHrid, monster.difficultyTier + this.difficultyTier)
            );
        }

        // Random spawn path.
        //
        // The map's keys gate which tables a wave may draw from, and a wave is
        // drawn whole from exactly ONE of them. Measured against the tables as
        // read from the live game client, over 3078 ordinary (non-fixed) dungeon
        // waves in four dungeons: Chimerical Den (keys 0/10/30) 2609 waves, from
        // a 2471-wave solo spawn census plus a 138-wave party-of-2 recording;
        // Pirate Cove (keys 0/20/40) 268 census waves, solo; Enchanted Fortress
        // (keys 0/20/40) 106 census waves, solo; and Sinister Circus (keys
        // 0/15/40) 95 waves, solo. No monster ever appears below its own key's
        // wave. That is not itself a rule about the random draw below: in every
        // one of these dungeons, every non-zero randomSpawnInfoMap key is also a
        // fixedSpawnsMap key, so the fixed-roster check above (line ~92) always
        // wins the tie on wave === key and the random path here never runs that
        // wave at all. A key-20 table is eligible starting wave 20, but the
        // earliest it is ever actually drawn from is wave 21 -- and not one
        // roster mixes species the way a pooled union of the eligible tables
        // would.
        //
        // The table is NOT always the highest eligible one. 384 of those 3078
        // waves are complete, well-formed draws from a strictly lower table, so
        // a highest-only reading gives them probability zero: 127 and 203 of the
        // census's Chimerical bands 10 and 30, 7 and 16 of the party
        // recording's, 6 and 12 of Pirate Cove bands 20 and 40, 8 of Enchanted
        // Fortress band 40, and 5 of Sinister Circus band 40. That much is not a
        // fit, it is arithmetic.
        //
        // How much weight each lower table carries is a fit. The likelihood is
        // exact per roster -- the probability the draw loop below produces that
        // multiset from a given table, overflow termination included -- so a
        // lower draw that could equally have come from the current table simply
        // contributes no evidence either way instead of false confidence. It
        // also catches draws that no species list would flag: three Pirate Cove
        // waves end early on a strength cap the band's own table could not have
        // produced, which pins them to table 0 even though every species in them
        // is shared.
        //
        // Fitting per band per dungeon puts a constant weight on each eligible
        // LOWER table: 0.143 (Chimerical band 10), 0.125 (Pirate band 20), 0.099
        // (Enchanted band 20), 0.136 (Sinister band 15), and on the
        // two-lower-table bands 0.120/0.140 (Chimerical 30), 0.105/0.130 (Pirate
        // 40), 0.080/0.220 (Enchanted 40), 0.205/0.165 (Sinister 40), quoted
        // two-steps-below first. The share per table does not shrink as more
        // become eligible, so the tables do not split a fixed budget: pooled, a
        // fixed per-table weight beats a normalized share (s = 0.198) by
        // dLL = +24.23 on the same single parameter, odds of 3.3e10:1
        // (dAIC = dBIC = 48.5), and it wins in each dungeon separately (+19.70
        // Chimerical, +1.48 Pirate, +1.50 Enchanted, +1.93 Sinister) and in every
        // leave-one-dungeon-out subset (+4.6 to +22.9). Dropping Chimerical
        // entirely still leaves w = 0.130 [0.101, 0.163] on the other three
        // dungeons' 469 waves, so the rule is no longer one dungeon's finding. A
        // free weight per band per dungeon buys only dLL = +3.46 for eleven more
        // parameters (chi2 = 6.91, df 11, p = 0.81), so one parameter is adequate.
        //
        // So: each eligible lower table is drawn with LOWER_TABLE_RATE, the
        // current one takes the remainder. The pooled estimate is 0.1335 with a
        // 95% profile interval of [0.1226, 0.1448]. 1/7 = 0.1429 is still inside
        // it, at a cost of 1.32 log-likelihood (chi2 = 2.65, p = 0.10), and 0.15
        // (p = 0.004) and 1/6 are excluded outright. 1/7 is kept because the
        // choice inside the interval does not matter: on the quantity the
        // simulator actually predicts, mean wave hitpoints, 1/7 and the estimate
        // are indistinguishable -- summed over the eight multi-table bands the
        // squared standardized error is 6.0 for either (1/8 gives 8.2, and the
        // highest-only engine 292.8), and across a whole dungeon they differ by
        // 0.4% of random-wave HP where the engine's current error is +5.8%
        // (Chimerical), +5.3% (Enchanted) and +6.6% (Pirate). Note that 1/8 sits
        // as comfortably inside the interval as 1/7 does (p = 0.13 against
        // p = 0.10), so 1/7 is not the constant the data picks out; it is one
        // admissible round number whose predictions are already at the noise
        // floor. If a later census pushes the interval below 0.1429, move the
        // constant to the estimate rather than defending the fraction.
        //
        // Against the recordings this moves the modelled mean wave HP from +9.7%
        // to -1.0% (Chimerical band 30, census, n = 984), +3.4% to +0.3%
        // (Chimerical band 10, n = 992), +12.6% to -0.1% (Pirate band 40,
        // n = 100), +2.7% to -0.5% (Pirate band 20, n = 80), +13.4% to +2.2%
        // (Enchanted band 40) and +16.1% to +6.1% (Sinister band 40), at the cost
        // of +0.6% to -1.5% in Enchanted band 20 and +0.7% to -1.3% in Sinister
        // band 15 -- both regressions smaller than those bands' own sampling
        // error (+-2.4% and +-1.8%). The two Chimerical gains are 12 and 7 times
        // their sampling error (+-0.7% and +-0.4%).
        //
        // The distance question stays settled: the weight does NOT taper, and
        // the raw counts that suggest otherwise are a detectability artefact.
        // Chimerical band 30 shows 119 waves uniquely attributable to table 0
        // against 91 to table 10, which looks like a lean towards the further
        // table -- but a table-0 draw there is uniquely attributable 91.6% of the
        // time and a table-10 draw only 58.2%, and dividing by that inverts the
        // comparison to 0.124 +- 0.011 two steps below against 0.149 +- 0.016 one
        // step below. The full likelihood, which does that correction exactly,
        // agrees: letting the weight depend on distance gives 0.1411 one step
        // below and 0.1213 two steps, dLL = +1.19 for the extra parameter
        // (chi2 = 2.39, df 1, p = 0.12). Same direction as the 2431-wave fit and
        // still not significant; Sinister Circus alone runs the other way, and
        // Pirate Cove -- the one dungeon added since -- is flat (ratio 0.85,
        // p = 0.67). Flat it is.
        //
        // Two residuals remain, neither of which any table-choice rule can
        // explain. With only ONE table eligible, both large band-0 samples are
        // now exact on the means -- Chimerical (495 waves: -0.0% monsters, -0.2%
        // HP) and Pirate Cove (88 waves: +0.8%, +0.3%) -- which retires the 2-3%
        // band-0 gap as a claim about the draw loop's arithmetic; but Enchanted
        // band 0 is still +3.2% on monsters and Sinister band 0 still -2.4%, both
        // on 24-32 waves and both within 1.5 sigma, and neither dataset grew.
        // The species-composition hint inside band 0 did NOT replicate: against
        // equal rates Chimerical band 0 gives chi2 = 20.9 on 13 species
        // (Monte-Carlo p = 0.050, sea_snail +24%) and Enchanted band 0
        // chi2 = 15.9 on 7 (p = 0.021, abyssal_imp +86%), but Pirate Cove's fresh
        // 88 waves are flat (chi2 = 3.3 on 6, p = 0.66), so it stays a hint. And
        // Sinister band 40 is still +6.1% on HP after the fix -- the one band
        // that is, on 32 waves. Something in the draw loop itself may still be
        // slightly wrong. See zone.test.js.
        const randomSpawnInfoMap = this.dungeonSpawnInfo.randomSpawnInfoMap;

        if (!randomSpawnInfoMap || typeof randomSpawnInfoMap !== 'object') {
            this.encountersKilled++;
            return [];
        }

        const waveKeys = Object.keys(randomSpawnInfoMap)
            .map(Number)
            .sort((a, b) => a - b);

        if (waveKeys.length === 0) {
            this.encountersKilled++;
            return [];
        }

        // >= makes a key-K table eligible from wave K on, but wave K itself is
        // always caught by the fixedSpawnsMap check above in every live
        // dungeon -- see the note above and zone.test.js's "every random spawn
        // table's key is a fixed wave" describe block.
        const eligibleKeys = waveKeys.filter((key) => waveNum >= key);

        let monsterSpawns = null;

        if (eligibleKeys.length > 0) {
            let chosenKey = eligibleKeys[eligibleKeys.length - 1];
            const lowerCount = eligibleKeys.length - 1;

            if (lowerCount > 0) {
                // The rate is capped at an equal share of every eligible table.
                // Uncapped, seven eligible lower tables claim 7 x 1/7 = exactly
                // 1 of the roll (1/7 * 7 === 1 in doubles), so the current
                // table -- the wave's own band -- would stop being drawn at all
                // and the last lower table would absorb its share. The cap
                // degrades that to a uniform draw over all eligible tables
                // instead. It never binds below seven lower tables, so it
                // cannot move any dungeon in the game today: the deepest has
                // three tables.
                const rate = Math.min(LOWER_TABLE_RATE, 1 / eligibleKeys.length);
                const roll = randomSpawn();
                if (roll < rate * lowerCount) {
                    const index = Math.min(Math.floor(roll / rate), lowerCount - 1);
                    chosenKey = eligibleKeys[index];
                }
            }

            monsterSpawns = randomSpawnInfoMap[chosenKey];
        }

        // Fallback to first available spawn info if no range matched
        if (!monsterSpawns || !monsterSpawns.spawns) {
            monsterSpawns = randomSpawnInfoMap[waveKeys[0]];
        }

        // Final safety — if still broken, skip wave instead of crashing
        if (!monsterSpawns?.spawns) {
            this.encountersKilled++;
            return [];
        }

        const totalWeight = monsterSpawns.spawns.reduce((prev, cur) => prev + cur.rate, 0);

        const encounterHrids = [];
        let totalStrength = 0;

        outer: for (let i = 0; i < monsterSpawns.maxSpawnCount; i++) {
            const randomWeight = totalWeight * randomSpawn();
            let cumulativeWeight = 0;

            for (const spawn of monsterSpawns.spawns) {
                cumulativeWeight += spawn.rate;
                if (randomWeight <= cumulativeWeight) {
                    totalStrength += spawn.strength;

                    if (totalStrength <= monsterSpawns.maxTotalStrength) {
                        encounterHrids.push({
                            hrid: spawn.combatMonsterHrid,
                            difficultyTier: spawn.difficultyTier,
                        });
                    } else {
                        break outer;
                    }
                    break;
                }
            }
        }
        this.encountersKilled++;
        return encounterHrids.map((hrid) => new Monster(hrid.hrid, hrid.difficultyTier + this.difficultyTier));
    }
}

export default Zone;
