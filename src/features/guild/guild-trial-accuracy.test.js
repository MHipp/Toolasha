/**
 * The attribution-accuracy arithmetic.
 *
 * Three things are worth pinning here and none of them are drawing: that a name
 * on one side of the join only is counted rather than scored, that a metric the
 * game never reported does not enter its median as a perfect score, and that the
 * archive fold stays additive so a cycle written before it existed still reads.
 */

import { describe, test, expect } from 'vitest';

import {
    ACCURACY_METRICS,
    OUTLIER_THRESHOLD_PCT,
    archivedAccuracyTrend,
    compactAccuracySummary,
    deltaPct,
    joinTrialStats,
    measuredOnlyNames,
    summarizeTrialAccuracy,
    summarizeWeekAccuracy,
    traceGapAccuracyPairing,
} from './guild-trial-accuracy.js';

/** A pair where every name matches and the measurement is exactly right */
function perfectPair() {
    const reported = {
        Alice: { damage: 1000, healing: 200, taken: 300 },
        Bob: { damage: 500, healing: 0, taken: 100 },
    };
    return { reported, measured: JSON.parse(JSON.stringify(reported)) };
}

describe('deltaPct', () => {
    test('measures against the game figure', () => {
        expect(deltaPct(110, 100)).toBeCloseTo(10);
        expect(deltaPct(90, 100)).toBeCloseTo(-10);
    });

    test('a measured figure the game never reported is infinitely wrong', () => {
        expect(deltaPct(50, 0)).toBe(Infinity);
    });

    test('measuring nothing where nothing was reported is exactly right', () => {
        expect(deltaPct(0, 0)).toBe(0);
    });
});

describe('joinTrialStats', () => {
    test('orders by reported damage so the biggest contributors read first', () => {
        const rows = joinTrialStats(perfectPair());
        expect(rows.map((row) => row.name)).toEqual(['Alice', 'Bob']);
    });

    test('marks a reported name with no measured row unmatched, not zero-scored', () => {
        const rows = joinTrialStats({
            reported: { Alice: { damage: 100 }, Renamed: { damage: 100 } },
            measured: { Alice: { damage: 100 } },
        });
        const renamed = rows.find((row) => row.name === 'Renamed');
        expect(renamed.matched).toBe(false);
        // The cell still fills in — the row is in the table — but nothing is
        // entitled to read the -100% off it as a measurement failure
        expect(renamed.damage.deltaPct).toBe(-100);
        expect(rows.find((row) => row.name === 'Alice').matched).toBe(true);
    });

    test('a measured row of all zeroes still counts as matched', () => {
        const rows = joinTrialStats({
            reported: { Alice: { damage: 100 } },
            measured: { Alice: { damage: 0, healing: 0, taken: 0 } },
        });
        expect(rows[0].matched).toBe(true);
    });

    test('no reported side is no rows at all', () => {
        expect(joinTrialStats({ measured: { Alice: { damage: 1 } } })).toEqual([]);
        expect(joinTrialStats()).toEqual([]);
    });
});

describe('the compared rows say what they compare', () => {
    // The export carries a bare `deltaPct` and no card beside it. `taken`
    // compares our post-mitigation figure against the game's
    // `premitigatedDamageTaken` — 5,018,969 against 11,609,469 on a real trial,
    // −88% to −34% per member, every row, every trial — and a reader landing on
    // that cold concludes the accounting is broken
    test('every cell names what its two sides measure', () => {
        const rows = joinTrialStats(perfectPair());
        for (const row of rows) {
            for (const { key } of ACCURACY_METRICS) {
                expect(typeof row[key].basis.measured).toBe('string');
                expect(typeof row[key].basis.reported).toBe('string');
            }
        }
        expect(rows[0].taken.basis.reported).toMatch(/premitigatedDamageTaken/);
        expect(rows[0].taken.basis.measured).toMatch(/post-mitigation/);
    });

    test('the two metrics that are not like-for-like are marked, and damage is not', () => {
        const rows = joinTrialStats(perfectPair());
        expect(rows[0].damage.expectedDivergence).toBeNull();
        expect(rows[0].taken.expectedDivergence).toMatchObject({ direction: 'low' });
        expect(rows[0].taken.expectedDivergence.reason).toMatch(/mitigation/);
        expect(rows[0].healing.expectedDivergence).toMatchObject({ direction: 'either' });
    });

    test('a marked cell is still an honest number', () => {
        // Presentation only: nothing is silenced, clamped or rounded toward
        // agreement, and an unannotated row would read the same figures
        const rows = joinTrialStats({
            reported: { Alice: { damage: 1000, healing: 200, taken: 11_609_469 } },
            measured: { Alice: { damage: 1000, healing: 206, taken: 5_018_969 } },
        });
        expect(rows[0].taken.measured).toBe(5_018_969);
        expect(rows[0].taken.reported).toBe(11_609_469);
        expect(rows[0].taken.deltaPct).toBeCloseTo(-56.77, 2);
        expect(rows[0].healing.deltaPct).toBeCloseTo(3, 5);
        expect(rows[0].damage.deltaPct).toBe(0);
    });
});

describe('measuredOnlyNames', () => {
    test('names the measurement found that the game never mentioned', () => {
        expect(measuredOnlyNames({ Alice: {} }, { Alice: {}, Ghost: {} })).toEqual(['Ghost']);
    });

    test('tolerates either side missing', () => {
        expect(measuredOnlyNames(null, null)).toEqual([]);
        expect(measuredOnlyNames(null, { Ghost: {} })).toEqual(['Ghost']);
    });
});

describe('summarizeTrialAccuracy', () => {
    test('a perfect measurement is zero everywhere with nobody listed', () => {
        const accuracy = summarizeTrialAccuracy(perfectPair());
        for (const { key } of ACCURACY_METRICS) {
            expect(accuracy.metrics[key].median).toBe(0);
            expect(accuracy.totals[key].deltaPct).toBe(0);
        }
        expect(accuracy.outliers).toEqual([]);
        expect(accuracy.unmatched).toBe(0);
    });

    test('a metric the game reported nothing for is excluded, not scored perfect', () => {
        // Bob has no reported healing at all. Counting his row as a flawless 0%
        // would halve Alice's healing median by averaging it with a figure
        // nothing measured
        const accuracy = summarizeTrialAccuracy({
            reported: {
                Alice: { damage: 1000, healing: 100, taken: 0 },
                Bob: { damage: 1000, healing: 0, taken: 0 },
            },
            measured: {
                Alice: { damage: 1000, healing: 140, taken: 0 },
                Bob: { damage: 1000, healing: 0, taken: 0 },
            },
        });
        expect(accuracy.metrics.healing.players).toBe(1);
        expect(accuracy.metrics.healing.missing).toBe(1);
        expect(accuracy.metrics.healing.median).toBeCloseTo(40);
        // Nobody reported anything taken, so the metric has no denominator
        expect(accuracy.metrics.taken.players).toBe(0);
        expect(accuracy.metrics.taken.median).toBeNull();
        expect(accuracy.metrics.taken.worst).toBeNull();
    });

    test('unmatched names are counted and kept out of the medians and totals', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: {
                Alice: { damage: 1000, healing: 0, taken: 0 },
                Renamed: { damage: 1000, healing: 0, taken: 0 },
            },
            measured: { Alice: { damage: 1000, healing: 0, taken: 0 } },
        });
        expect(accuracy.players).toBe(2);
        expect(accuracy.matched).toBe(1);
        expect(accuracy.unmatched).toBe(1);
        expect(accuracy.unmatchedNames).toEqual(['Renamed']);
        // The one matched player was measured exactly; the unmatched name does
        // not drag the party total to -50%
        expect(accuracy.metrics.damage.median).toBe(0);
        expect(accuracy.totals.damage.reported).toBe(1000);
        expect(accuracy.totals.damage.deltaPct).toBe(0);
        expect(accuracy.outliers).toEqual([]);
    });

    test('a join that matched nobody has no total to report, rather than a perfect one', () => {
        // Every reported name unmatched — the whole-week rename case, or a
        // stream that never resolved display names. The totals are summed over
        // matched rows only, so both sides come to 0, and `deltaPct(0, 0)` is
        // 0 by the "measured nothing where nothing was reported" rule. That
        // rule is right per player and manufactures a perfect score over an
        // empty set: the ledger card headlines the trial "+0.0%" in green.
        const accuracy = summarizeTrialAccuracy({
            reported: {
                AliceOld: { damage: 1000, healing: 500, taken: 200 },
                BobOld: { damage: 800, healing: 0, taken: 300 },
            },
            measured: { AliceNew: { damage: 990, healing: 480, taken: 210 } },
        });

        expect(accuracy.matched).toBe(0);
        for (const { key } of ACCURACY_METRICS) {
            expect(accuracy.totals[key].deltaPct).toBeNull();
        }
    });

    test('a name only the measurement knows is counted from the other end', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: { Alice: { damage: 100 } },
            measured: { Alice: { damage: 100 }, Ghost: { damage: 50 } },
        });
        expect(accuracy.measuredOnly).toBe(1);
        expect(accuracy.players).toBe(1);
    });

    test('lists a player past the threshold, worst metric first', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: {
                Alice: { damage: 1000, healing: 100, taken: 100 },
                Bob: { damage: 1000, healing: 100, taken: 100 },
            },
            measured: {
                // 2% off on damage — inside the band, not news
                Alice: { damage: 1020, healing: 100, taken: 100 },
                // 60% off on healing, 5% on damage: healing is the one named
                Bob: { damage: 1050, healing: 160, taken: 100 },
            },
        });
        expect(accuracy.outliers).toHaveLength(1);
        expect(accuracy.outliers[0].name).toBe('Bob');
        expect(accuracy.outliers[0].worstMetric).toBe('healing');
        expect(accuracy.outliers[0].worstDeltaPct).toBeCloseTo(60);
        expect(accuracy.threshold).toBe(OUTLIER_THRESHOLD_PCT);
    });

    test('the threshold is a listing rule, not a verdict on the medians', () => {
        const pair = {
            reported: { Alice: { damage: 1000, healing: 0, taken: 0 } },
            measured: { Alice: { damage: 1100, healing: 0, taken: 0 } },
        };
        expect(summarizeTrialAccuracy({ ...pair, threshold: 5 }).outliers).toHaveLength(1);
        expect(summarizeTrialAccuracy({ ...pair, threshold: 50 }).outliers).toHaveLength(0);
        expect(summarizeTrialAccuracy({ ...pair, threshold: 50 }).metrics.damage.median).toBeCloseTo(10);
    });

    test('the worst delta keeps its sign', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: { Alice: { damage: 1000 }, Bob: { damage: 1000 } },
            measured: { Alice: { damage: 1100 }, Bob: { damage: 700 } },
        });
        expect(accuracy.metrics.damage.worst).toBeCloseTo(-30);
        expect(accuracy.metrics.damage.median).toBeCloseTo(20);
    });

    test('an empty pair summarizes to nothing rather than throwing', () => {
        const accuracy = summarizeTrialAccuracy({});
        expect(accuracy.players).toBe(0);
        expect(accuracy.metrics.damage.median).toBeNull();
        // Not 0: no matched rows is nothing to report, the same as the
        // wholesale-rename case above. A 0 here draws as a green "+0.0%".
        expect(accuracy.totals.damage.deltaPct).toBeNull();
    });
});

describe('summarizeWeekAccuracy', () => {
    test('one entry per encounter, oldest first', () => {
        const week = summarizeWeekAccuracy({
            later: { reported: { A: { damage: 1 } }, measured: { A: { damage: 1 } }, at: 200 },
            earlier: { reported: { A: { damage: 1 } }, measured: { A: { damage: 1 } }, at: 100 },
        });
        expect(week.map((entry) => entry.encounter)).toEqual(['earlier', 'later']);
    });

    test('tolerates a missing or junk blob', () => {
        expect(summarizeWeekAccuracy(null)).toEqual([]);
        expect(summarizeWeekAccuracy({ broken: null })).toEqual([]);
    });

    test('a trial whose stats arrived unwatched is a roster, not an accuracy entry', () => {
        // `measured: null` is the damage module's marker for a trial nobody
        // watched — server totals with no measurement beside them. A "0 of N
        // matched" line for it would read as the attribution failing, so it is
        // skipped; an empty `{}` still summarizes, because a watched trial
        // that measured nobody is exactly that claim.
        const week = summarizeWeekAccuracy({
            badger: { reported: { Ada: { damage: 1 } }, measured: null, at: 5 },
            hedgehog: { reported: { Ada: { damage: 1 } }, measured: {}, at: 6 },
        });
        expect(week.map((entry) => entry.encounter)).toEqual(['hedgehog']);
    });
});

describe('compactAccuracySummary', () => {
    test('keeps the medians and the counts and drops the per-player table', () => {
        const compact = compactAccuracySummary({
            elite: {
                at: 5,
                reported: { Alice: { damage: 1000 }, Renamed: { damage: 1000 } },
                measured: { Alice: { damage: 1200 } },
            },
        });
        expect(Object.keys(compact)).toEqual(['elite']);
        expect(compact.elite).toEqual({
            quality: { traced: false },
            at: 5,
            players: 2,
            matched: 1,
            unmatched: 1,
            measuredOnly: 0,
            metrics: {
                damage: { median: 20, worst: 20, players: 1 },
                healing: { median: null, worst: null, players: 0 },
                taken: { median: null, worst: null, players: 0 },
            },
        });
        expect(JSON.stringify(compact)).not.toContain('Alice');
    });

    test('an unreported metric survives the round trip as null, not zero', () => {
        const compact = compactAccuracySummary({
            elite: { at: 1, reported: { A: { damage: 100 } }, measured: { A: { damage: 100 } } },
        });
        expect(compact.elite.metrics.healing.median).toBeNull();
    });
});

describe('the archived trace quality', () => {
    /** A trace status as `guildTrialTrace.status()` returns one */
    const status = (extra = {}) => ({
        running: true,
        traceId: 'trace-1',
        eventCount: 400,
        gapsOver5s: 2,
        maxGapMs: 41_000,
        startedMidFight: false,
        resumedAcrossReloads: false,
        ...extra,
    });

    /** One week of pairs, the smallest that summarizes */
    const trials = { elite: { at: 5, reported: { A: { damage: 100 } }, measured: { A: { damage: 120 } } } };

    test('stamps the trace’s condition on every encounter when a trace was running', () => {
        const compact = compactAccuracySummary(trials, {
            trace: status({ resumedAcrossReloads: true, startedMidFight: true }),
        });
        expect(compact.elite.quality).toEqual({
            traced: true,
            gapsOver5s: 2,
            maxGapMs: 41_000,
            startedMidFight: true,
            resumedAcrossReloads: true,
        });
        // The accuracy figures are untouched by the addition
        expect(compact.elite.metrics.damage.median).toBe(20);
    });

    test('an untraced week says only that, never a clean-looking zero', () => {
        for (const trace of [null, undefined, {}, { traceId: null, gapsOver5s: 0 }]) {
            const compact = compactAccuracySummary(trials, { trace });
            expect(compact.elite.quality).toEqual({ traced: false });
        }
    });

    test('keeps "we could not tell" apart from "it started cleanly"', () => {
        const unknown = compactAccuracySummary(trials, { trace: status({ startedMidFight: null }) });
        expect(unknown.elite.quality.startedMidFight).toBeNull();
        const clean = compactAccuracySummary(trials, { trace: status() });
        expect(clean.elite.quality.startedMidFight).toBe(false);
    });

    test('a gap that was never measured is null, not zero', () => {
        const compact = compactAccuracySummary(trials, { trace: status({ maxGapMs: null }) });
        expect(compact.elite.quality.maxGapMs).toBeNull();
        expect(compact.elite.quality.traced).toBe(true);
    });

    test('the trend folds a cycle to its worst reading and counts the traced trials', () => {
        const entry = {
            weekStart: 1,
            accuracy: {
                one: {
                    metrics: { damage: { median: 2, worst: 9, players: 5 } },
                    quality: {
                        traced: true,
                        gapsOver5s: 1,
                        maxGapMs: 8000,
                        startedMidFight: false,
                        resumedAcrossReloads: false,
                    },
                },
                two: {
                    metrics: { damage: { median: 6, worst: 9, players: 5 } },
                    quality: {
                        traced: true,
                        gapsOver5s: 4,
                        maxGapMs: 60_000,
                        startedMidFight: true,
                        resumedAcrossReloads: true,
                    },
                },
                three: { metrics: { damage: { median: 6, worst: 9, players: 5 } } },
            },
        };
        const [folded] = archivedAccuracyTrend([entry]);
        expect(folded.quality).toEqual({
            traced: true,
            tracedTrials: 2,
            gapsOver5s: 4,
            maxGapMs: 60_000,
            startedMidFight: true,
            resumedAcrossReloads: true,
        });
        // The trial with no quality key still counts towards the accuracy fold
        expect(folded.trials).toBe(3);
    });

    test('an unknown start beats a clean one in the fold', () => {
        const quality = (startedMidFight) => ({
            traced: true,
            gapsOver5s: 0,
            maxGapMs: 0,
            startedMidFight,
            resumedAcrossReloads: false,
        });
        const [folded] = archivedAccuracyTrend([
            { weekStart: 1, accuracy: { one: { quality: quality(false) }, two: { quality: quality(null) } } },
        ]);
        expect(folded.quality.startedMidFight).toBeNull();
    });

    test('an archive written before the fields existed reads exactly as it did', () => {
        const [folded] = archivedAccuracyTrend([
            {
                weekStart: 1,
                accuracy: { one: { metrics: { damage: { median: 3, worst: 9, players: 5 } }, unmatched: 2 } },
            },
        ]);
        expect(folded.hasAccuracy).toBe(true);
        expect(folded.trials).toBe(1);
        expect(folded.unmatched).toBe(2);
        expect(folded.metrics.damage.median).toBe(3);
        // No quality was recorded, and none is invented
        expect(folded.quality).toEqual({
            traced: false,
            tracedTrials: 0,
            gapsOver5s: null,
            maxGapMs: null,
            startedMidFight: null,
            resumedAcrossReloads: false,
        });
    });

    test('a cycle with no accuracy at all still carries the untraced shape', () => {
        const [folded] = archivedAccuracyTrend([{ weekStart: 1, tiles: {} }]);
        expect(folded.hasAccuracy).toBe(false);
        expect(folded.quality.traced).toBe(false);
        expect(folded.quality.tracedTrials).toBe(0);
    });
});

describe('archivedAccuracyTrend', () => {
    /** An archive entry as `archiveCycle` writes one, with accuracy folded in */
    function cycle(weekStart, damageMedian, extra = {}) {
        return {
            archivedAt: weekStart + 1,
            reason: 'a new cycle is scheduled',
            weekStart,
            tiles: {},
            accuracy: {
                elite: {
                    at: weekStart,
                    players: 10,
                    matched: 10,
                    unmatched: 0,
                    measuredOnly: 0,
                    metrics: {
                        damage: { median: damageMedian, worst: damageMedian * 2, players: 10 },
                        healing: { median: null, worst: null, players: 0 },
                        taken: { median: null, worst: null, players: 0 },
                    },
                },
            },
            ...extra,
        };
    }

    test('one point per archived cycle, in the order they were archived', () => {
        const trend = archivedAccuracyTrend([cycle(100, 3), cycle(200, 5)]);
        expect(trend.map((entry) => entry.weekStart)).toEqual([100, 200]);
        expect(trend.map((entry) => entry.metrics.damage.median)).toEqual([3, 5]);
        expect(trend.every((entry) => entry.hasAccuracy)).toBe(true);
    });

    test('an old archive with no accuracy key says so rather than reading as perfect', () => {
        const old = { archivedAt: 5, reason: 'a new cycle is scheduled', weekStart: 4, tiles: { a: {} } };
        const trend = archivedAccuracyTrend([old, cycle(100, 3)]);
        expect(trend[0].hasAccuracy).toBe(false);
        expect(trend[0].trials).toBe(0);
        expect(trend[0].metrics).toEqual({});
        expect(trend[0].weekStart).toBe(4);
        expect(trend[1].hasAccuracy).toBe(true);
    });

    test('an entry whose accuracy is present but empty is treated as absent', () => {
        expect(archivedAccuracyTrend([{ weekStart: 1, accuracy: {} }])[0].hasAccuracy).toBe(false);
    });

    test("a cycle's figure is the middle of its trials' medians, and its worst the widest", () => {
        const entry = {
            weekStart: 1,
            accuracy: {
                one: { metrics: { damage: { median: 2, worst: 9, players: 5 } }, unmatched: 1 },
                two: { metrics: { damage: { median: 6, worst: -20, players: 5 } }, unmatched: 2 },
            },
        };
        const [folded] = archivedAccuracyTrend([entry]);
        expect(folded.trials).toBe(2);
        expect(folded.metrics.damage.median).toBe(4);
        expect(folded.metrics.damage.worst).toBe(-20);
        expect(folded.metrics.damage.players).toBe(10);
        expect(folded.unmatched).toBe(3);
    });

    test('tolerates no history at all', () => {
        expect(archivedAccuracyTrend(null)).toEqual([]);
        expect(archivedAccuracyTrend([null])).toEqual([]);
    });
});

describe('pairing trace gaps against accuracy across the archive', () => {
    /** A trend entry with an accuracy figure and a traced quality */
    const cycle = (damageMedian, gapsOver5s) => ({
        hasAccuracy: true,
        metrics: { damage: { median: damageMedian } },
        quality: { traced: true, gapsOver5s },
    });

    test('refuses below the minimum rather than pairing an anecdote', () => {
        const verdict = traceGapAccuracyPairing([cycle(2, 0), cycle(9, 3)]);
        expect(verdict.verdict).toBe('insufficient');
        expect(verdict.usable).toBe(2);
        expect(verdict.minCycles).toBe(3);
    });

    test('refuses when every usable cycle sits on one side of the split', () => {
        const verdict = traceGapAccuracyPairing([cycle(2, 0), cycle(3, 0), cycle(4, 0)]);
        expect(verdict.verdict).toBe('insufficient');
        expect(verdict.clean).toBe(3);
        expect(verdict.gappy).toBe(0);
    });

    test('pairs median absolute damage deltas per side once both are represented', () => {
        const verdict = traceGapAccuracyPairing([cycle(-2, 0), cycle(4, 0), cycle(-9, 3), cycle(11, 1)]);
        expect(verdict.verdict).toBe('paired');
        expect(verdict.clean).toEqual({ cycles: 2, medianAbsDelta: 3 });
        expect(verdict.gappy).toEqual({ cycles: 2, medianAbsDelta: 10 });
    });

    test('a cycle without accuracy, without a trace, or without a gap count cannot vote', () => {
        const verdict = traceGapAccuracyPairing([
            { hasAccuracy: false, metrics: { damage: { median: 1 } }, quality: { traced: true, gapsOver5s: 0 } },
            { hasAccuracy: true, metrics: { damage: { median: 1 } }, quality: { traced: false, gapsOver5s: null } },
            { hasAccuracy: true, metrics: { damage: { median: 1 } }, quality: { traced: true, gapsOver5s: null } },
            null,
            cycle(2, 0),
            cycle(3, 2),
            cycle(5, 0),
        ]);
        expect(verdict.verdict).toBe('paired');
        expect(verdict.clean.cycles).toBe(2);
        expect(verdict.gappy.cycles).toBe(1);
    });
});
