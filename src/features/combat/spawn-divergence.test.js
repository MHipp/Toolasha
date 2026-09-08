/**
 * Tests for the spawn-divergence check.
 *
 * The census these run against is generated *by* the real spawn rule — the
 * engine's own `Zone.getNextWave()` under a fixed seed, against synthetic game
 * data — so "consistent" means the closed-form expectation agrees with the code
 * the simulator actually runs, and not merely with a second copy of the same
 * arithmetic written here. That is also what pins this module's copy of
 * `LOWER_TABLE_RATE` to `zone.js`'s: change one without the other and the first
 * test fails.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from '../combat-sim/engine/game-data.js';
import { clearSimRng, seedSimRng } from '../combat-sim/engine/rng.js';
import Zone from '../combat-sim/engine/zone.js';
import {
    analyzeSpawnDivergence,
    bandWeights,
    divergenceLines,
    expectedBandFrequencies,
    fingerprintMoved,
    fingerprintOf,
    tableSpawnProbabilities,
    MIN_BAND_WAVES,
} from './spawn-divergence.js';

const ZONE_HRID = '/actions/combat/test_dungeon';
const MAX_WAVES = 20;

/** Six species, two of which are exclusive to the upper table. */
const LOW = ['/monsters/a', '/monsters/b', '/monsters/c'];
const HIGH = ['/monsters/d', '/monsters/e'];

/**
 * A two-table dungeon: table 0 from wave 1, table 10 from wave 10 on, with
 * wave 10 pinned as a fixed roster the way every live dungeon pins its keys.
 *
 * @param {Object} [overrides] - `{lowRates, highRates}` to bend one table's weights
 * @returns {Object} The zone's `combatZoneInfo`
 */
function dungeonInfo({ lowRates = [3, 2, 1], highRates = [3, 2, 1, 1, 1] } = {}) {
    return {
        isDungeon: true,
        fightInfo: null,
        dungeonInfo: {
            maxWaves: MAX_WAVES,
            fixedSpawnsMap: {
                10: [{ combatMonsterHrid: HIGH[0], difficultyTier: 0 }],
                20: [{ combatMonsterHrid: HIGH[1], difficultyTier: 0 }],
            },
            randomSpawnInfoMap: {
                0: {
                    maxSpawnCount: 4,
                    maxTotalStrength: 130,
                    spawns: LOW.map((hrid, i) => ({
                        combatMonsterHrid: hrid,
                        difficultyTier: 0,
                        rate: lowRates[i],
                        strength: 40 + i * 5,
                    })),
                },
                10: {
                    maxSpawnCount: 4,
                    maxTotalStrength: 150,
                    spawns: [...LOW, ...HIGH].map((hrid, i) => ({
                        combatMonsterHrid: hrid,
                        difficultyTier: 0,
                        rate: highRates[i],
                        strength: 40 + i * 5,
                    })),
                },
            },
        },
    };
}

/**
 * Install synthetic game data for the engine.
 * @param {Object} [overrides] - Passed to {@link dungeonInfo}
 * @returns {Object} The installed `combatZoneInfo`
 */
function installDungeon(overrides) {
    const combatZoneInfo = dungeonInfo(overrides);
    setGameData({
        actionDetailMap: { [ZONE_HRID]: { buffs: null, combatZoneInfo } },
        combatMonsterDetailMap: Object.fromEntries(
            [...LOW, ...HIGH].map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])
        ),
    });
    return combatZoneInfo;
}

/** The spawn-table object the census records and exports, for one zone. */
function tablesOf(combatZoneInfo) {
    return {
        isDungeon: combatZoneInfo.isDungeon === true,
        maxWaves: combatZoneInfo.dungeonInfo?.maxWaves ?? null,
        fixedSpawnsMap: combatZoneInfo.dungeonInfo?.fixedSpawnsMap ?? null,
        randomSpawnInfoMap: combatZoneInfo.dungeonInfo?.randomSpawnInfoMap ?? null,
        randomSpawnInfo: combatZoneInfo.fightInfo?.randomSpawnInfo ?? null,
    };
}

/**
 * Run the real engine for `waves` dungeon waves and tally the rosters the way
 * the census does — sorted species, one row per distinct roster with a count.
 *
 * @param {number} waves - Waves to draw
 * @param {number} [seed] - RNG seed
 * @returns {Map<string, {wave: number, monsterHrids: string[], count: number}>}
 */
function simulateCensus(waves, seed = 20260905) {
    seedSimRng(seed);
    const zone = new Zone(ZONE_HRID, 0);
    const rows = new Map();
    for (let i = 0; i < waves; i++) {
        // `encountersKilled` is the wave about to be drawn, and getNextWave
        // advances it — read it before the draw so the row carries its own wave.
        const wave = zone.encountersKilled > MAX_WAVES ? 1 : zone.encountersKilled;
        const monsterHrids = zone
            .getNextWave()
            .map((monster) => monster.hrid)
            .sort();
        const key = `${wave}|${monsterHrids.join(',')}`;
        const row = rows.get(key) || { wave, monsterHrids, count: 0 };
        row.count++;
        rows.set(key, row);
    }
    return rows;
}

/**
 * A census export file around a simulated tally.
 * @param {Map<string, Object>} rows - {@link simulateCensus}'s output
 * @param {Object} tables - The zone's spawn tables, as exported
 * @param {Object} [extra] - Fields to override on the file
 * @returns {Object} A `spawnCensus.exportFile()`-shaped object
 */
function exportFile(rows, tables, extra = {}) {
    return {
        type: 'toolasha-spawn-census',
        evictedRows: 0,
        spawnTables: { [ZONE_HRID]: tables },
        spawnTableFingerprints: { [ZONE_HRID]: [fingerprintOf(JSON.stringify(tables))] },
        rosters: [...rows.values()].map((row) => ({
            zoneHrid: ZONE_HRID,
            difficultyTier: 0,
            wave: row.wave,
            monsterHrids: row.monsterHrids,
            count: row.count,
        })),
        ...extra,
    };
}

/** The zone entry of a report, or undefined. */
function only(report) {
    return report.zones[0];
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('the closed-form expectation', () => {
    test('matches the engine draws it is meant to describe', () => {
        const info = installDungeon();
        const map = info.dungeonInfo.randomSpawnInfoMap;

        // Band 0: waves 1-9, one eligible table, so no table-choice roll at all.
        const expected = expectedBandFrequencies(map, [0], [0, 10]);
        seedSimRng(97);
        const zone = new Zone(ZONE_HRID, 0);
        const seen = new Map();
        let drawn = 0;
        for (let i = 0; i < 60_000; i++) {
            const wave = zone.encountersKilled > MAX_WAVES ? 1 : zone.encountersKilled;
            const monsters = zone.getNextWave().map((monster) => monster.hrid);
            if (wave >= 10) continue;
            drawn++;
            for (const hrid of new Set(monsters)) seen.set(hrid, (seen.get(hrid) || 0) + 1);
        }

        expect(drawn).toBeGreaterThan(20_000);
        for (const hrid of LOW) {
            const observed = (seen.get(hrid) || 0) / drawn;
            // Three standard errors of the Monte Carlo itself.
            const tolerance = 3 * Math.sqrt((expected.get(hrid) * (1 - expected.get(hrid))) / drawn);
            expect(Math.abs(observed - expected.get(hrid))).toBeLessThan(Math.max(tolerance, 0.005));
        }
    });

    test('and matches it on the band where the lower-table rule fires', () => {
        const info = installDungeon();
        const map = info.dungeonInfo.randomSpawnInfoMap;
        const expected = expectedBandFrequencies(map, [0, 10], [0, 10]);

        seedSimRng(555);
        const zone = new Zone(ZONE_HRID, 0);
        const seen = new Map();
        let drawn = 0;
        for (let i = 0; i < 120_000; i++) {
            const wave = zone.encountersKilled > MAX_WAVES ? 1 : zone.encountersKilled;
            const monsters = zone.getNextWave().map((monster) => monster.hrid);
            // Wave 10 and 20 are fixed rosters, not draws.
            if (wave < 11 || wave === 20) continue;
            drawn++;
            for (const hrid of new Set(monsters)) seen.set(hrid, (seen.get(hrid) || 0) + 1);
        }

        expect(drawn).toBeGreaterThan(20_000);
        for (const hrid of [...LOW, ...HIGH]) {
            const p = expected.get(hrid);
            const observed = (seen.get(hrid) || 0) / drawn;
            const tolerance = 3 * Math.sqrt((p * (1 - p)) / drawn);
            expect(Math.abs(observed - p)).toBeLessThan(Math.max(tolerance, 0.005));
        }
    });

    test('never adds the species that overflowed the strength cap', () => {
        // One slot's worth of budget: the first draw always fits, the second
        // never does, so every wave is exactly one monster and each species
        // appears with exactly its own weight.
        const probabilities = tableSpawnProbabilities({
            maxSpawnCount: 4,
            maxTotalStrength: 10,
            spawns: [
                { combatMonsterHrid: '/monsters/a', rate: 1, strength: 6 },
                { combatMonsterHrid: '/monsters/b', rate: 3, strength: 6 },
            ],
        });
        expect(probabilities.get('/monsters/a')).toBeCloseTo(0.25, 12);
        expect(probabilities.get('/monsters/b')).toBeCloseTo(0.75, 12);
    });

    test('a table with no strength cap draws nothing, the way the engine does', () => {
        const probabilities = tableSpawnProbabilities({
            maxSpawnCount: 3,
            spawns: [{ combatMonsterHrid: '/monsters/a', rate: 1, strength: 1 }],
        });
        expect(probabilities.get('/monsters/a')).toBe(0);
    });

    test('the lower-table weights are flat, capped at an equal share', () => {
        expect([...bandWeights([0], [0])]).toEqual([[0, 1]]);
        const two = bandWeights([0, 10], [0, 10]);
        expect(two.get(0)).toBeCloseTo(1 / 7, 12);
        expect(two.get(10)).toBeCloseTo(6 / 7, 12);
        // Eight eligible tables: 1/7 each would leave the current one nothing.
        const many = bandWeights([0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7]);
        for (const weight of many.values()) expect(weight).toBeCloseTo(1 / 8, 12);
    });

    test('and an empty eligible set falls back to the lowest table, as the engine does', () => {
        expect([...bandWeights([], [5, 15])]).toEqual([[5, 1]]);
    });
});

describe('a census drawn by the spawn rule', () => {
    test('reads as consistent', () => {
        const info = installDungeon();
        const report = analyzeSpawnDivergence(exportFile(simulateCensus(2000), tablesOf(info)));

        expect(report.ok).toBe(true);
        const zone = only(report);
        expect(zone.verdict).toBe('consistent');
        expect(zone.fingerprintChanged).toBe(false);
        expect(zone.unknownSpecies).toEqual([]);
        expect(zone.silentSpecies).toEqual([]);
        expect(divergenceLines(report)).toEqual([
            `test_dungeon T0: consistent (${zone.scoredWaves.toLocaleString()} waves)`,
        ]);
    });

    test('and only fixed waves are left out of the count', () => {
        const info = installDungeon();
        const rows = simulateCensus(2000);
        const report = analyzeSpawnDivergence(exportFile(rows, tablesOf(info)));

        const fixedWaves = [...rows.values()]
            .filter((row) => row.wave === 10 || row.wave === 20)
            .reduce((sum, row) => sum + row.count, 0);
        expect(fixedWaves).toBeGreaterThan(0);
        expect(only(report).waves).toBe(2000 - fixedWaves);
    });
});

describe('a table that has moved under the census', () => {
    test('a doubled rate in one table is caught', () => {
        // Record under the real tables, then compare against tables whose
        // rarest low species has had its rate doubled — which is exactly what a
        // game-side table change looks like from here.
        installDungeon();
        const rows = simulateCensus(4000);
        const moved = dungeonInfo({ lowRates: [3, 2, 4], highRates: [3, 2, 4, 1, 1] });
        const report = analyzeSpawnDivergence(exportFile(rows, tablesOf(moved)));

        const zone = only(report);
        expect(['drifting', 'diverged']).toContain(zone.verdict);
        expect(zone.worst.hrid).toBe(LOW[2]);
        // Observed below what the inflated table predicts.
        expect(zone.worst.z).toBeLessThan(-3);
    });

    test('a small rate change on a short census only reaches drifting', () => {
        installDungeon();
        const rows = simulateCensus(600);
        const nudged = dungeonInfo({ lowRates: [3, 2, 1.6], highRates: [3, 2, 1.6, 1, 1] });
        const report = analyzeSpawnDivergence(exportFile(rows, tablesOf(nudged)));

        expect(only(report).verdict).toBe('drifting');
        expect(divergenceLines(report)[0]).toMatch(/drifting — \w+ seen \d+\.\dσ below the table/);
    });

    test('a species in no eligible table is diverged outright', () => {
        const info = installDungeon();
        const rows = simulateCensus(2000);
        // One wave in band 0 containing a species that only the upper table has.
        rows.set('3|intruder', { wave: 3, monsterHrids: [LOW[0], HIGH[1]], count: 1 });

        const zone = only(analyzeSpawnDivergence(exportFile(rows, tablesOf(info))));
        expect(zone.verdict).toBe('diverged');
        expect(zone.unknownSpecies).toEqual([HIGH[1]]);
        expect(divergenceLines(analyzeSpawnDivergence(exportFile(rows, tablesOf(info))))[0]).toContain(
            'e is in no eligible table'
        );
    });

    test('a table species that never appears at all is diverged', () => {
        const info = installDungeon();
        const rows = simulateCensus(2000);
        // Drop every roster containing one common species: the tables still
        // promise it, and the census has never once seen it.
        for (const [key, row] of rows) {
            if (row.monsterHrids.includes(LOW[0])) rows.delete(key);
        }

        const zone = only(analyzeSpawnDivergence(exportFile(rows, tablesOf(info))));
        expect(zone.verdict).toBe('diverged');
        expect(zone.silentSpecies).toContain(LOW[0]);
    });
});

describe('what it refuses to say', () => {
    test('nothing at all below the minimum sample', () => {
        const info = installDungeon();
        const report = analyzeSpawnDivergence(exportFile(simulateCensus(MIN_BAND_WAVES - 20), tablesOf(info)));

        const zone = only(report);
        expect(zone.verdict).toBe('insufficient');
        expect(zone.scoredWaves).toBe(0);
        expect(divergenceLines(report)[0]).toContain('not enough waves yet');
    });

    test('and a badly wrong table is still not reported below it', () => {
        installDungeon();
        const rows = simulateCensus(60);
        const moved = dungeonInfo({ lowRates: [3, 2, 9], highRates: [3, 2, 9, 1, 1] });
        expect(only(analyzeSpawnDivergence(exportFile(rows, tablesOf(moved)))).verdict).toBe('insufficient');
    });

    test('nothing once the census has evicted rows', () => {
        const info = installDungeon();
        const report = analyzeSpawnDivergence(exportFile(simulateCensus(2000), tablesOf(info), { evictedRows: 7 }));

        expect(report.ok).toBe(false);
        expect(report.reason).toBe('evicted');
        expect(divergenceLines(report)[0]).toContain('evicted rows');
    });

    test('and nothing for a zone whose tables are not loaded', () => {
        const info = installDungeon();
        const rows = simulateCensus(2000);
        const file = exportFile(rows, tablesOf(info));
        file.spawnTables = { '/actions/combat/other': tablesOf(info) };

        expect(analyzeSpawnDivergence(file).zones).toEqual([]);
    });
});

describe('the fingerprint', () => {
    test('a changed table is flagged even while the counts still fit', () => {
        const info = installDungeon();
        const tables = tablesOf(info);
        const file = exportFile(simulateCensus(2000), tables);
        // Same tables, a fingerprint from before they were what they are now.
        file.spawnTableFingerprints = { [ZONE_HRID]: ['deadbeef'] };

        const zone = only(analyzeSpawnDivergence(file));
        expect(zone.fingerprintChanged).toBe(true);
        expect(zone.verdict).toBe('consistent');
        expect(divergenceLines(analyzeSpawnDivergence(file))[0]).toContain('the spawn tables changed');
    });

    test('two fingerprints recorded while collecting is a change on its own', () => {
        const tables = tablesOf(installDungeon());
        expect(fingerprintMoved(tables, [fingerprintOf(JSON.stringify(tables)), 'later'])).toBe(true);
        expect(fingerprintMoved(tables, [fingerprintOf(JSON.stringify(tables))])).toBe(false);
        expect(fingerprintMoved(tables, [])).toBe(false);
    });
});
