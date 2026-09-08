/**
 * Dungeon pace
 *
 * This run's average wave time against the stored average for the same
 * dungeon, as one signed figure — "am I ahead of myself or behind".
 *
 * The comparison is per wave rather than per run because a run in progress has
 * no duration yet, and projecting one would be a guess stacked on a guess. The
 * wave average is a thing both sides genuinely have: the live run measures its
 * waves directly, and a stored run's duration divided by the dungeon's wave
 * count is its wave average — every saved run finished, or it would not have
 * been saved.
 *
 * Stored runs recorded from chat carry no tier, so the history is matched on
 * dungeon name, and a run whose tier *is* stated only counts when it matches.
 * No history means no chip — a pace against nothing is not a pace.
 */

/** Below this many completed waves the live average is one wave's luck */
export const MIN_WAVES_FOR_PACE = 3;

/**
 * How far a stored run's own avgWaveTime may exceed its duration-derived wave
 * time before it is treated as corrupt and the duration is trusted instead. A
 * real avgWaveTime sits just under duration/maxWaves (the run total also
 * carries inter-wave gaps), never multiples above it — a run recorded while
 * per-wave timing was anchored to the constant run-start clocked every wave as
 * the cumulative elapsed since the run began, leaving avgWaveTime tens of times
 * too large. The run total was always right, so its per-wave figure heals those.
 */
export const STATED_AVG_SANITY_RATIO = 3;

/**
 * The key a stored run's reset marker is filed under.
 *
 * Built exactly as the chat annotations build theirs - team and dungeon
 * together - so a reset of one team's average for a dungeon leaves another
 * team's alone. Keying off each run rather than off the live run is what lets
 * a mixed list be filtered honestly: every run is judged by its own marker.
 *
 * @param {Object} run - A stored run
 * @returns {string} `teamKey::dungeonName`
 */
export function averageBaselineKey(run) {
    return `${run?.teamKey ?? ''}::${run?.dungeonName ?? ''}`;
}

/**
 * The `dungeonTrackerAverageWindow` setting as a window size.
 *
 * 0 - the shipped default - means every run there has ever been, which is the
 * lifetime average these figures have always been. The same reading the chat
 * annotations take, so the two surfaces cannot disagree about what the setting
 * says.
 *
 * @param {*} raw - The setting's value
 * @returns {number} A positive window, or 0 for "all runs"
 */
export function normalizeAverageWindow(raw) {
    const size = Math.floor(Number(raw));
    return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * A stored run's timestamp in epoch milliseconds, or NaN when it has none.
 *
 * @param {Object} run - A stored run
 * @returns {number}
 */
function runTimeMs(run) {
    return new Date(run?.timestamp).getTime();
}

/**
 * Narrow a run list to what the average is allowed to cover.
 *
 * Two limits, and they compose the way the chat annotations compose them: the
 * marker floors the list, the window then caps how far back it reaches. Input
 * order is preserved - callers sort for their own display and must not be
 * reordered underneath.
 *
 * With no window and no marker this hands back the list it was given, so the
 * default configuration averages exactly what it always did.
 *
 * @param {Array<Object>} runs - Stored runs
 * @param {Object} [limits] - How far the average may look
 * @param {number} [limits.windowSize] - Runs to look back over, 0 for all
 * @param {Object|null} [limits.baselines] - `teamKey::dungeonName` -> epoch ms
 *   the average starts after
 * @returns {Array<Object>} The runs that survive both limits
 */
export function limitToAverageWindow(runs, { windowSize = 0, baselines = null } = {}) {
    const list = Array.isArray(runs) ? runs : [];
    const markers = baselines && typeof baselines === 'object' ? baselines : null;

    // A run at or before its own marker is one the user asked to leave behind,
    // however far the window would otherwise reach. A run with no readable
    // timestamp cannot be placed against a marker, so it stays.
    const kept = markers
        ? list.filter((run) => {
              const at = Number(markers[averageBaselineKey(run)]) || 0;
              if (!(at > 0)) return true;
              const ts = runTimeMs(run);
              return !Number.isFinite(ts) || ts > at;
          })
        : list;

    if (!(windowSize > 0)) return kept;

    // The N most recent by timestamp, handed back in the caller's order. A run
    // with no timestamp has no place in that ordering: it is left in rather
    // than silently dropped, and does not consume one of the N slots.
    const dated = kept.map((run, index) => ({ index, ts: runTimeMs(run) })).filter((e) => Number.isFinite(e.ts));
    if (dated.length <= windowSize) return kept;
    dated.sort((a, b) => b.ts - a.ts || b.index - a.index);
    const inWindow = new Set(dated.slice(0, windowSize).map((e) => e.index));
    return kept.filter((run, index) => inWindow.has(index) || !Number.isFinite(runTimeMs(run)));
}

/**
 * The stored runs of one dungeon, already narrowed by the average's limits.
 *
 * Dungeon and tier first, then the window - so "the last N runs" counts runs
 * of *this* dungeon, as the chat line's window does, rather than the last N
 * runs of anything.
 *
 * @param {Array<Object>} runs - Stored runs, already narrowed to the character
 * @param {Object} current - The live run's identity and the average's limits
 * @returns {Array<Object>} Matching runs, in the order they arrived
 */
function runsForAverage(runs, { dungeonName, tier, windowSize, baselines }) {
    const matching = [];
    for (const run of runs || []) {
        if (!run || run.dungeonName !== dungeonName) continue;
        if (tier !== null && tier !== undefined && run.tier !== null && run.tier !== undefined && run.tier !== tier) {
            continue;
        }
        matching.push(run);
    }
    return limitToAverageWindow(matching, { windowSize, baselines });
}

/**
 * A stored run's average wave time.
 *
 * @param {Object} run - A stored run
 * @param {number} maxWaves - The dungeon's wave count, from the live run
 * @returns {number|null} Milliseconds per wave, or null when the run cannot say
 */
export function runAvgWaveMs(run, maxWaves) {
    if (!run) return null;

    const duration = Number(run.duration ?? run.totalTime);
    const fromDuration =
        Number.isFinite(duration) && duration > 0 && Number.isFinite(maxWaves) && maxWaves > 0
            ? duration / maxWaves
            : null;

    const stated = Number(run.avgWaveTime);
    if (Number.isFinite(stated) && stated > 0) {
        // Trust the run total over a stated average that dwarfs it — that
        // average is the corrupt cumulative-timing artefact, not this run.
        if (fromDuration !== null && stated > fromDuration * STATED_AVG_SANITY_RATIO) {
            return fromDuration;
        }
        return stated;
    }

    return fromDuration;
}

/**
 * The stored average wave time for a dungeon.
 *
 * @param {Array<Object>} runs - Stored runs, already narrowed to the character
 * @param {Object} current - The live run's identity
 * @param {string|null} current.dungeonName - Which dungeon
 * @param {number|null} current.tier - Its tier, where known
 * @param {number|null} current.maxWaves - Its wave count
 * @param {number} [current.windowSize] - Runs to look back over, 0 for all
 * @param {Object|null} [current.baselines] - Reset markers, as stored
 * @returns {number|null} Milliseconds per wave, or null without usable history
 */
export function historyAvgWaveMs(runs, { dungeonName, tier, maxWaves, windowSize = 0, baselines = null } = {}) {
    // 'Unknown' is what a run gets when nothing named it, and matching on it
    // would average unrelated dungeons together
    if (!dungeonName || dungeonName === 'Unknown') return null;

    const perWave = [];
    for (const run of runsForAverage(runs, { dungeonName, tier, windowSize, baselines })) {
        const avg = runAvgWaveMs(run, maxWaves);
        if (avg !== null) perWave.push(avg);
    }

    if (!perWave.length) return null;
    return perWave.reduce((sum, value) => sum + value, 0) / perWave.length;
}

/**
 * How far a stored run's summed wave times may stray from its own duration
 * before its per-wave data is treated as corrupt and left out of the split
 * profile. Real waves are the full cycle, gap included, so they sum to
 * roughly the run's duration; the old cumulative-from-start artefact summed
 * to many times it. Generous, because a chat-validated duration and tracked
 * waves can legitimately differ at the run's edges.
 */
export const PROFILE_SUM_TOLERANCE = 0.5;

/**
 * Whether a stored run's per-wave times can align with a split profile: one
 * entry per wave, all real, and consistent with the run's own duration.
 *
 * @param {Object} run - A stored run
 * @param {number} maxWaves - The dungeon's wave count
 * @returns {boolean}
 */
function saneWaveTimes(run, maxWaves) {
    const times = run?.waveTimes;
    if (!Array.isArray(times) || times.length === 0) return false;
    // Every entry must be wave k for profile[k] to mean anything, so a run
    // that missed a wave (a restore mid-run) cannot contribute
    if (times.length !== maxWaves) return false;
    if (!times.every((t) => Number.isFinite(t) && t > 0)) return false;

    const duration = Number(run.duration ?? run.totalTime);
    if (Number.isFinite(duration) && duration > 0) {
        const sum = times.reduce((total, t) => total + t, 0);
        if (Math.abs(sum - duration) > duration * PROFILE_SUM_TOLERANCE) return false;
    }
    return true;
}

/**
 * The stored history's average cumulative time at each wave — the "split"
 * a live run is measured against.
 *
 * A whole-run wave average cannot judge a run in progress: waves get harder
 * through a dungeon, so the average of the easy waves done so far reads as a
 * big lead over the whole-run figure (+50% at wave 10) that evaporates by the
 * end. Cumulative-at-the-same-wave is apples to apples at every point.
 *
 * @param {Array<Object>} runs - Stored runs, already narrowed to the character
 * @param {Object} current - The live run's identity
 * @param {string|null} current.dungeonName - Which dungeon
 * @param {number|null} current.tier - Its tier, where known
 * @param {number|null} current.maxWaves - Its wave count
 * @param {number} [current.windowSize] - Runs to look back over, 0 for all
 * @param {Object|null} [current.baselines] - Reset markers, as stored
 * @returns {Array<number>|null} `profile[k]` is the mean milliseconds elapsed
 *   after wave k (1-based; index 0 is unused). Null without any run whose
 *   per-wave times are usable — chat-backfilled runs carry none.
 */
export function historyCumulativeProfile(runs, { dungeonName, tier, maxWaves, windowSize = 0, baselines = null } = {}) {
    if (!dungeonName || dungeonName === 'Unknown') return null;
    if (!Number.isFinite(maxWaves) || maxWaves <= 0) return null;

    const cumulatives = [];
    // The window counts runs, not usable runs: it is applied first, and a run
    // inside it whose per-wave times are unusable contributes nothing - the
    // same as any other run the profile cannot read.
    for (const run of runsForAverage(runs, { dungeonName, tier, windowSize, baselines })) {
        if (!saneWaveTimes(run, maxWaves)) continue;

        let elapsed = 0;
        cumulatives.push(run.waveTimes.map((t) => (elapsed += t)));
    }
    if (!cumulatives.length) return null;

    const profile = new Array(maxWaves + 1).fill(0);
    for (let k = 1; k <= maxWaves; k++) {
        profile[k] = cumulatives.reduce((sum, c) => sum + c[k - 1], 0) / cumulatives.length;
    }
    return profile;
}

/**
 * Split-time pace: the live run's cumulative time so far against the stored
 * cumulative at the same wave. Positive is ahead, as with `pacePercent`.
 *
 * @param {Array<number>|null} liveWaveTimes - The live run's completed wave times
 * @param {Array<number>|null} profile - From `historyCumulativeProfile`
 * @returns {number|null} Whole percent, or null without a profile, with too
 *   few waves to judge, or past the profile's last wave
 */
export function splitPacePercent(liveWaveTimes, profile) {
    if (!Array.isArray(liveWaveTimes) || !Array.isArray(profile)) return null;
    const n = liveWaveTimes.length;
    if (n < MIN_WAVES_FOR_PACE || n >= profile.length) return null;

    const live = liveWaveTimes.reduce((sum, t) => sum + t, 0);
    const history = profile[n];
    if (!Number.isFinite(live) || live <= 0) return null;
    if (!Number.isFinite(history) || history <= 0) return null;

    return Math.round(((history - live) / history) * 100);
}

/**
 * How far ahead of the stored average this run is.
 *
 * Positive is faster: the sign answers "am I winning", not "is the number
 * bigger", because a *shorter* wave time is the good direction.
 *
 * @param {number|null} currentAvgWaveMs - The live run's wave average
 * @param {number|null} historyMs - From `historyAvgWaveMs`
 * @param {number} wavesCompleted - How many waves back the live average
 * @returns {number|null} Whole percent, or null when either side is missing or
 *   the run is too young to have a pace
 */
export function pacePercent(currentAvgWaveMs, historyMs, wavesCompleted) {
    if (!Number.isFinite(currentAvgWaveMs) || currentAvgWaveMs <= 0) return null;
    if (!Number.isFinite(historyMs) || historyMs <= 0) return null;
    if (!Number.isFinite(wavesCompleted) || wavesCompleted < MIN_WAVES_FOR_PACE) return null;

    return Math.round(((historyMs - currentAvgWaveMs) / historyMs) * 100);
}

/**
 * The chip itself.
 *
 * @param {number|null} percent - From `pacePercent`
 * @returns {{text: string, tone: 'good'|'bad'|'dim'}|null} Null renders nothing
 */
export function paceChip(percent) {
    if (percent === null || percent === undefined) return null;

    if (percent > 0) return { text: `pace +${percent}% vs your avg`, tone: 'good' };
    if (percent < 0) return { text: `pace −${Math.abs(percent)}% vs your avg`, tone: 'bad' };
    return { text: 'pace even with your avg', tone: 'dim' };
}

/**
 * Recovering a party run's true start from the chat log.
 *
 * A run the tracker picked up at wave 48 has no start of its own, but in a
 * party the server timestamps every "Key counts" message, and the newest one
 * still in chat is normally this run's start — the same message that ended the
 * previous run. "Normally" is the problem: the player may have idled between
 * runs, switched dungeons, or left the tab open overnight, in which case the
 * newest message is hours old and belongs to something else entirely. These
 * two checks are what stands between that and a fabricated run in history.
 */

/**
 * How much longer than the longest clean run you have on record for this dungeon
 * and tier a recovered start may imply, when there are too few clean runs for the
 * median bound below. A run is bounded from above by the party's worst night, and
 * your own worst night is the only figure available that knows anything about this
 * dungeon; 1.5× leaves room for a party slower than any you have recorded without
 * admitting an anchor a whole run too early (which, at any wave, implies at least
 * ~2× the run).
 */
export const RECOVERY_DURATION_SLACK = 1.5;

/**
 * How much longer than your median run for this dungeon and tier a recovered
 * start may imply. 2× matches `RECOVERY_WAVE_TOLERANCE`: the two checks then
 * refuse the same thing — a run at twice its usual pace — from the whole-run and
 * the per-wave side, rather than one quietly admitting what the other refuses.
 */
export const RECOVERY_MEDIAN_SLACK = 2;

/**
 * How many clean runs the median needs before it is a statistic rather than one
 * or two nights. Below this the max-based bound stands in: it is the behaviour
 * this had before, and with three runs the median is barely more robust anyway.
 */
export const RECOVERY_MIN_MEDIAN_SAMPLE = 5;

/**
 * The bound with no history to derive one from. The longest dungeon in the game
 * is 65 waves at roughly half a minute each — a little over half an hour — so
 * 45 minutes admits a slow party of a dungeon you have never finished while
 * still refusing a chat log left open across a lunch break.
 */
export const RECOVERY_FALLBACK_MAX_MS = 45 * 60 * 1000;

/**
 * How far the implied elapsed time may sit either side of the stored cumulative
 * at the wave reached. Run-to-run variance on the same dungeon and tier is
 * large — party composition and drop rolls swing a run by tens of percent — so
 * a tight band would throw away honest recoveries; 2× is generous enough that a
 * real run has to be twice or half its usual pace to be refused. It is still
 * decisive against the failure this guards: an anchor one run too early implies
 * roughly a whole extra run's time on top of the waves actually done, which is
 * 2.3× at the last quarter of a dungeon and far more earlier on.
 */
export const RECOVERY_WAVE_TOLERANCE = 2;

/**
 * Whether a stored run's duration is circular evidence for this bound.
 *
 * A recovered run's own duration was measured from the anchor this bound let
 * through, so feeding it back in is a ratchet: one over-long recovery raises the
 * ceiling, the raised ceiling admits a longer one, and the bound only ever
 * widens. Such a run may never vote on how long a run of this dungeon can be.
 *
 * @param {Object} run - A stored run
 * @returns {boolean}
 */
function isRecoveredRun(run) {
    return run.startRecovered === true;
}

/**
 * The longest a run of this dungeon may plausibly have taken, from history.
 *
 * Derived from the median of the clean runs rather than their maximum: the
 * maximum is one night, and one night that ran long — or one duration inflated
 * by any of the mishaps this file already heals — sets the ceiling for every
 * recovery after it. The median moves only when most of your runs do.
 *
 * Server-timestamped runs are the sample where there are any. A wall-clocked
 * (`validated: false`) run is a worse witness, but it is only fallen back to
 * when there is no better one, and the alternative is not a stricter bound — it
 * is no bound at all and the caller's 45-minute `RECOVERY_FALLBACK_MAX_MS`,
 * which is looser than anything this history supports. The same runs' wave times
 * already stand behind the per-wave check in `assessRecoveredStart`, which does
 * not ask whether they were validated either.
 *
 * @param {Array<Object>} runs - Stored runs, already narrowed to the character
 * @param {Object} current - The live run's identity
 * @param {string|null} current.dungeonName - Which dungeon
 * @param {number|null} current.tier - Its tier, where known
 * @returns {number|null} Milliseconds, or null without usable history
 */
export function plausibleMaxRunMs(runs, { dungeonName, tier } = {}) {
    if (!dungeonName || dungeonName === 'Unknown') return null;

    const serverTimed = [];
    const wallClocked = [];
    for (const run of runs || []) {
        if (!run || run.dungeonName !== dungeonName) continue;
        if (tier !== null && tier !== undefined && run.tier !== null && run.tier !== undefined && run.tier !== tier) {
            continue;
        }
        if (isRecoveredRun(run)) continue;
        const duration = Number(run.duration ?? run.totalTime);
        if (!Number.isFinite(duration) || duration <= 0) continue;
        (run.validated === false ? wallClocked : serverTimed).push(duration);
    }

    const durations = serverTimed.length ? serverTimed : wallClocked;
    if (!durations.length) return null;

    durations.sort((a, b) => a - b);
    if (durations.length < RECOVERY_MIN_MEDIAN_SAMPLE) {
        // Too few to call a median; the old max-based bound stands in, over this
        // sample only — no bound at all would hand the caller its 45-minute
        // fallback, which is looser than anything this history supports.
        return durations[durations.length - 1] * RECOVERY_DURATION_SLACK;
    }

    const middle = Math.floor(durations.length / 2);
    const median = durations.length % 2 === 1 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    return median * RECOVERY_MEDIAN_SLACK;
}

/**
 * Whether a chat anchor can be believed as this run's start.
 *
 * @param {Object} candidate - The anchor under test
 * @param {number} candidate.impliedElapsedMs - Now minus the anchor
 * @param {number} candidate.currentWave - The wave the run is on (1-based)
 * @param {number|null} candidate.maxWaves - The dungeon's wave count
 * @param {Array<Object>} candidate.runs - Stored runs, narrowed to the character
 * @param {string|null} candidate.dungeonName - Which dungeon
 * @param {number|null} candidate.tier - Its tier, where known
 * @returns {{credible: boolean, reason: string}} Why, for the log
 */
export function assessRecoveredStart({ impliedElapsedMs, currentWave, maxWaves, runs, dungeonName, tier } = {}) {
    if (!Number.isFinite(impliedElapsedMs) || impliedElapsedMs <= 0) {
        return { credible: false, reason: 'anchor is not in the past' };
    }

    // 1. Plausibility — could this dungeon have taken that long at all?
    const bound = plausibleMaxRunMs(runs, { dungeonName, tier }) ?? RECOVERY_FALLBACK_MAX_MS;
    if (impliedElapsedMs > bound) {
        return {
            credible: false,
            reason: `implied ${Math.round(impliedElapsedMs / 1000)}s is beyond the plausible ${Math.round(bound / 1000)}s for this dungeon`,
        };
    }

    // 2. Wave consistency — does that long match the waves actually done?
    // The run is *inside* currentWave, so the waves finished are currentWave - 1
    // and the stored cumulative at that wave is what the elapsed should resemble.
    const profile = historyCumulativeProfile(runs, { dungeonName, tier, maxWaves });
    const wavesDone = Number(currentWave) - 1;
    const expected =
        Array.isArray(profile) && Number.isFinite(wavesDone) && wavesDone >= 1 && wavesDone < profile.length
            ? profile[wavesDone]
            : null;

    if (expected !== null && expected > 0) {
        if (impliedElapsedMs > expected * RECOVERY_WAVE_TOLERANCE) {
            return {
                credible: false,
                reason: `implied ${Math.round(impliedElapsedMs / 1000)}s is more than ${RECOVERY_WAVE_TOLERANCE}× the ${Math.round(expected / 1000)}s your history reaches wave ${wavesDone} in`,
            };
        }
        if (impliedElapsedMs < expected / RECOVERY_WAVE_TOLERANCE) {
            return {
                credible: false,
                reason: `implied ${Math.round(impliedElapsedMs / 1000)}s is under 1/${RECOVERY_WAVE_TOLERANCE} of the ${Math.round(expected / 1000)}s your history reaches wave ${wavesDone} in`,
            };
        }
        return { credible: true, reason: 'plausible and consistent with the waves completed' };
    }

    return { credible: true, reason: 'plausible; no per-wave history to check it against' };
}
