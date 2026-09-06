/**
 * Dungeon pace.
 *
 * The comparison only exists where both sides genuinely do: a live wave
 * average with a few waves behind it, and stored runs of the same dungeon.
 * Everything else — no history, an unnamed dungeon, a run one wave old —
 * renders nothing rather than a pace against a guess.
 */

import { describe, test, expect } from 'vitest';
import {
    MIN_WAVES_FOR_PACE,
    runAvgWaveMs,
    historyAvgWaveMs,
    historyCumulativeProfile,
    splitPacePercent,
    pacePercent,
    paceChip,
    plausibleMaxRunMs,
    assessRecoveredStart,
    RECOVERY_DURATION_SLACK,
    RECOVERY_MEDIAN_SLACK,
    RECOVERY_MIN_MEDIAN_SAMPLE,
    RECOVERY_FALLBACK_MAX_MS,
} from './dungeon-pace.js';

const MAX_WAVES = 50;

/** A stored run, as chat backfill writes one: duration and no wave times */
const chatRun = (dungeonName, durationMs, tier = null) => ({ dungeonName, duration: durationMs, tier });

describe('a stored run’s wave average', () => {
    test('a stated average wins over division', () => {
        expect(runAvgWaveMs({ avgWaveTime: 9_000, duration: 600_000 }, MAX_WAVES)).toBe(9_000);
    });

    test('a chat run is its duration over the wave count', () => {
        // Every saved run finished, or it would not have been saved — so the
        // dungeon's wave count is the run's wave count
        expect(runAvgWaveMs(chatRun('Chimerical Den', 500_000), MAX_WAVES)).toBe(10_000);
    });

    test('no duration, or no wave count to divide by, is nothing', () => {
        expect(runAvgWaveMs(chatRun('Chimerical Den', 0), MAX_WAVES)).toBeNull();
        expect(runAvgWaveMs(chatRun('Chimerical Den', 500_000), 0)).toBeNull();
        expect(runAvgWaveMs(null, MAX_WAVES)).toBeNull();
    });

    test('a stated average that dwarfs the run total is the corrupt-timing artefact, so the total wins', () => {
        // A run recorded while per-wave timing was anchored to the constant
        // run-start: its avgWaveTime is the cumulative-elapsed garbage (~800s),
        // tens of times the real ~10s the 500s/50-wave total implies.
        expect(runAvgWaveMs({ avgWaveTime: 826_000, duration: 500_000 }, MAX_WAVES)).toBe(10_000);
    });

    test('a stated average close to the run total is trusted as the real measurement', () => {
        // 9s stated against a 10s duration-derived figure is ordinary variance,
        // not corruption — the more precise stated value stands.
        expect(runAvgWaveMs({ avgWaveTime: 9_000, duration: 500_000 }, MAX_WAVES)).toBe(9_000);
    });

    test('with no run total to sanity-check against, a stated average is taken as given', () => {
        expect(runAvgWaveMs({ avgWaveTime: 826_000 }, MAX_WAVES)).toBe(826_000);
    });
});

describe('the stored average for a dungeon', () => {
    const runs = [
        chatRun('Chimerical Den', 500_000),
        chatRun('Chimerical Den', 600_000),
        chatRun('Sinister Circus', 100_000),
    ];

    test('only the same dungeon’s runs are averaged', () => {
        // (10s + 12s) / 2, and the Circus run never enters it
        expect(historyAvgWaveMs(runs, { dungeonName: 'Chimerical Den', tier: null, maxWaves: MAX_WAVES })).toBe(11_000);
    });

    test('a run whose tier is stated only counts when it matches', () => {
        const tiered = [chatRun('Chimerical Den', 500_000, 1), chatRun('Chimerical Den', 900_000, 2)];
        expect(historyAvgWaveMs(tiered, { dungeonName: 'Chimerical Den', tier: 1, maxWaves: MAX_WAVES })).toBe(10_000);
    });

    test('a run with no stated tier still counts — chat history carries none', () => {
        expect(historyAvgWaveMs(runs, { dungeonName: 'Chimerical Den', tier: 1, maxWaves: MAX_WAVES })).toBe(11_000);
    });

    test('no history is no average', () => {
        expect(historyAvgWaveMs([], { dungeonName: 'Chimerical Den', maxWaves: MAX_WAVES })).toBeNull();
        expect(historyAvgWaveMs(null, { dungeonName: 'Chimerical Den', maxWaves: MAX_WAVES })).toBeNull();
    });

    test('an unnamed dungeon matches nothing', () => {
        // 'Unknown' is what a run gets when nothing named it, and matching on
        // it would average unrelated dungeons together
        expect(
            historyAvgWaveMs([chatRun('Unknown', 500_000)], { dungeonName: 'Unknown', maxWaves: MAX_WAVES })
        ).toBeNull();
        expect(historyAvgWaveMs(runs, { dungeonName: null, maxWaves: MAX_WAVES })).toBeNull();
    });
});

describe('the pace itself', () => {
    test('faster than history is positive', () => {
        // 9.4s waves against a 10s average is 6% ahead
        expect(pacePercent(9_400, 10_000, 10)).toBe(6);
    });

    test('slower than history is negative', () => {
        expect(pacePercent(11_000, 10_000, 10)).toBe(-10);
    });

    test('too few waves is one wave’s luck, not a pace', () => {
        expect(pacePercent(9_400, 10_000, MIN_WAVES_FOR_PACE - 1)).toBeNull();
        expect(pacePercent(9_400, 10_000, MIN_WAVES_FOR_PACE)).toBe(6);
    });

    test('either side missing is no pace', () => {
        expect(pacePercent(null, 10_000, 10)).toBeNull();
        expect(pacePercent(0, 10_000, 10)).toBeNull();
        expect(pacePercent(9_400, null, 10)).toBeNull();
    });
});

describe('the chip', () => {
    test('green ahead, red behind, dim even', () => {
        expect(paceChip(6)).toEqual({ text: 'pace +6% vs your avg', tone: 'good' });
        expect(paceChip(-9)).toEqual({ text: 'pace −9% vs your avg', tone: 'bad' });
        expect(paceChip(0)).toEqual({ text: 'pace even with your avg', tone: 'dim' });
    });

    test('no pace is no chip', () => {
        expect(paceChip(null)).toBeNull();
        expect(paceChip(undefined)).toBeNull();
    });
});

describe('the split-time profile', () => {
    const waves = (ms, n = MAX_WAVES) => Array.from({ length: n }, () => ms);
    /** A run the live tracker recorded: waves that sum to its duration */
    const trackedRun = (dungeonName, waveTimes, tier = null) => ({
        dungeonName,
        tier,
        waveTimes,
        duration: waveTimes.reduce((sum, t) => sum + t, 0),
    });
    const den = { dungeonName: 'Chimerical Den', tier: null, maxWaves: MAX_WAVES };

    test('averages the cumulative time at each wave across usable runs', () => {
        const runs = [trackedRun('Chimerical Den', waves(10_000)), trackedRun('Chimerical Den', waves(12_000))];
        const profile = historyCumulativeProfile(runs, den);
        expect(profile[1]).toBe(11_000);
        expect(profile[10]).toBe(110_000);
        expect(profile[MAX_WAVES]).toBe(550_000);
    });

    test('rejects the old cumulative-from-start artefact, whose waves sum to far more than the run', () => {
        // 50 entries climbing 10s each sum to ~12,750s against a 500s run
        const corrupt = Array.from({ length: MAX_WAVES }, (_, i) => (i + 1) * 10_000);
        const run = { dungeonName: 'Chimerical Den', tier: null, waveTimes: corrupt, duration: 500_000 };
        expect(historyCumulativeProfile([run], den)).toBeNull();
    });

    test('a run missing a wave cannot align with the profile and is left out', () => {
        expect(historyCumulativeProfile([trackedRun('Chimerical Den', waves(10_000, MAX_WAVES - 1))], den)).toBeNull();
    });

    test('chat-backfilled runs carry no waves and contribute nothing', () => {
        expect(historyCumulativeProfile([chatRun('Chimerical Den', 500_000)], den)).toBeNull();
    });

    test('a stated tier keeps that tier and untiered runs, and drops the rest', () => {
        const runs = [
            trackedRun('Chimerical Den', waves(10_000), 2),
            trackedRun('Chimerical Den', waves(30_000), 0),
            trackedRun('Chimerical Den', waves(12_000)),
        ];
        const profile = historyCumulativeProfile(runs, { ...den, tier: 2 });
        expect(profile[1]).toBe(11_000); // the T0 run is excluded
    });

    test('no usable identity is no profile', () => {
        const run = trackedRun('Chimerical Den', waves(10_000));
        expect(historyCumulativeProfile([run], { ...den, dungeonName: 'Unknown' })).toBeNull();
        expect(historyCumulativeProfile([run], { ...den, maxWaves: 0 })).toBeNull();
    });
});

describe('the split-time pace', () => {
    const profile = historyCumulativeProfile(
        [
            {
                dungeonName: 'D',
                tier: null,
                waveTimes: Array.from({ length: MAX_WAVES }, () => 10_000),
                duration: 500_000,
            },
        ],
        { dungeonName: 'D', tier: null, maxWaves: MAX_WAVES }
    );

    test('compares cumulative time so far against the stored cumulative at the same wave', () => {
        // 10 waves at 8s = 80s against a stored 100s at wave 10: 20% ahead
        expect(splitPacePercent(Array(10).fill(8_000), profile)).toBe(20);
    });

    test('matching the profile wave for wave is even, not a lead', () => {
        expect(splitPacePercent(Array(10).fill(10_000), profile)).toBe(0);
    });

    test('a slower run reads behind', () => {
        expect(splitPacePercent(Array(10).fill(12_500), profile)).toBe(-25);
    });

    test('too few waves, no profile, or a wave past the profile is no pace', () => {
        expect(splitPacePercent(Array(MIN_WAVES_FOR_PACE - 1).fill(10_000), profile)).toBeNull();
        expect(splitPacePercent(Array(10).fill(10_000), null)).toBeNull();
        expect(splitPacePercent(Array(MAX_WAVES + 1).fill(10_000), profile)).toBeNull();
    });
});

describe('the recovery plausibility bound', () => {
    const MINUTE = 60_000;
    /** `n` clean runs of `durationMs`, as a party's own chat timestamps record them */
    const clean = (n, durationMs) => Array.from({ length: n }, () => chatRun('D', durationMs));

    test('the median sets it, so one long night cannot', () => {
        const runs = [...clean(RECOVERY_MIN_MEDIAN_SAMPLE, 10 * MINUTE), chatRun('D', 40 * MINUTE)];

        expect(plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null })).toBe(10 * MINUTE * RECOVERY_MEDIAN_SLACK);
    });

    test('a recovered run cannot widen the bound it was itself admitted by', () => {
        // The ratchet: a recovered run banks the duration this bound let through,
        // that duration raised the ceiling, and the raised ceiling then admitted a
        // longer recovery — the bound only ever opened.
        const runs = clean(RECOVERY_MIN_MEDIAN_SAMPLE, 10 * MINUTE);
        const before = plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null });

        runs.push({ ...chatRun('D', 19 * MINUTE), startRecovered: true });

        expect(plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null })).toBe(before);
    });

    test('a run timed by this client’s own clock does not set it either', () => {
        const runs = clean(RECOVERY_MIN_MEDIAN_SAMPLE, 10 * MINUTE);
        const before = plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null });

        runs.push({ ...chatRun('D', 30 * MINUTE), validated: false });

        expect(plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null })).toBe(before);
    });

    test('too few clean runs for a median falls back to the longest of them', () => {
        const runs = [...clean(RECOVERY_MIN_MEDIAN_SAMPLE - 2, 10 * MINUTE), chatRun('D', 12 * MINUTE)];

        expect(plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null })).toBe(12 * MINUTE * RECOVERY_DURATION_SLACK);
    });

    test('nothing clean to derive one from leaves the caller its own ceiling', () => {
        const runs = [{ ...chatRun('D', 30 * MINUTE), startRecovered: true }];

        expect(plausibleMaxRunMs(runs, { dungeonName: 'D', tier: null })).toBeNull();
        expect(
            assessRecoveredStart({
                impliedElapsedMs: RECOVERY_FALLBACK_MAX_MS + 1,
                currentWave: 10,
                maxWaves: MAX_WAVES,
                runs,
                dungeonName: 'D',
                tier: null,
            }).credible
        ).toBe(false);
    });
});
