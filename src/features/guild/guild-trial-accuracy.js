/**
 * How close the tick-by-tick attribution actually got, per trial.
 *
 * `guild-trial-damage.js` measures a guild trial by watching the spectator
 * stream go past and splitting each tick between the players it names. At the
 * end of the fight the game sends its own per-member totals
 * (`guild_trial_stats_updated`), and those two figures are the only pair in the
 * whole feature where a measurement can be checked against an authority. That
 * check used to go one place — the export builder — where nobody reads it.
 *
 * This module is the arithmetic of that check, kept away from both the measuring
 * and the drawing so it can be tested without either.
 *
 * ## Why the three metrics are reported apart
 *
 * Damage is the one the stream is built to attribute: a tick carries an
 * `atkCounter` per player and the split follows it. Healing and damage taken
 * are inferred from health deltas — a heal landing on the same tick as a hit
 * nets out, an over-heal is invisible, and mitigation happens server-side — so
 * they run wider by construction. Averaging the three into one "accuracy" would
 * bury an actually-broken damage split under two figures that are *expected* to
 * be loose. They are summarized separately and the expectation is stated in the
 * UI, so a reader is not invited to file normal imperfection as a bug.
 *
 * ## The join is by name, and says so when a name does not join
 *
 * Neither side of the pair carries a character id by the time it gets here: the
 * game's stats arrive per character id and are resolved to names before storage,
 * the measurement is keyed by the display name the stream spelled. A player who
 * renamed mid-week — or whose name the stream never resolved — appears on one
 * side and not the other. Counting that as a 100% miss would libel the
 * measurement; counting it as 0% would flatter it. It is counted as
 * **unmatched** and shown as a count, and it is kept out of every median.
 */

/**
 * The three metrics the pair holds, and what a reader should expect of each.
 *
 * `expectation` is the line the ledger card draws. `basis` and
 * `expectedDivergence` are the same statement made in a form the **export** can
 * carry: {@link joinTrialStats} copies them into every compared cell, because a
 * bare `deltaPct` in a JSON file has no card beside it to explain itself.
 *
 * That is not a cosmetic worry. A real trial's `taken` rows read −88.20% to
 * −33.51%, every row, every trial, and the party total is 5,018,969 against
 * 11,609,469. Nothing is wrong: the two sides are not the same quantity. Ours
 * is post-mitigation health actually lost; the game's `premitigatedDamageTaken`
 * is the swing before armour and resistances took their cut. Anyone opening the
 * export cold reads a 57% shortfall and files a bug against arithmetic that is
 * doing exactly what it says.
 */
export const ACCURACY_METRICS = [
    {
        key: 'damage',
        label: 'Damage',
        expectation: 'Split from per-player attack counters — the tightest of the three.',
        basis: {
            measured: 'per-tick boss health lost, split by each player’s attack counter',
            reported: 'the game’s own per-member damage total for the trial',
        },
        // The one pair that is genuinely like for like, so a delta here is a
        // fault worth chasing rather than a definition
        expectedDivergence: null,
    },
    {
        key: 'healing',
        label: 'Healing',
        expectation: 'Inferred from health deltas: over-heals are invisible, so this runs wide. Expected.',
        basis: {
            measured: 'per-tick health rises attributed to the caster, revives excluded',
            reported: 'the game’s own per-member healing total for the trial',
        },
        expectedDivergence: {
            direction: 'either',
            reason:
                'Different quantities, not a discrepancy: a heal landing on the same tick as a hit nets out ' +
                'and an over-heal is invisible, while a rise that no single caster owns is left unattributed. ' +
                'Measured against reported has run about +3% party-wide and up to +16% per member.',
        },
    },
    {
        key: 'taken',
        label: 'Taken',
        expectation: 'Inferred the same way, against server-side mitigation. Expected to run wide.',
        basis: {
            measured: 'per-tick health actually lost, per player — post-mitigation, and a floor',
            reported: 'the game’s `premitigatedDamageTaken` — the swing before armour and resistances',
        },
        expectedDivergence: {
            direction: 'low',
            reason:
                'Different quantities, not a discrepancy: mitigation happens server-side and is never on the ' +
                'wire, so the measured side is smaller than the reported one by whatever the party mitigated. ' +
                'A real trial read 5,018,969 against 11,609,469 party-wide, and −88% to −34% per member. The ' +
                'delta is the mitigation, not an error.',
        },
    },
];

/** Metric key to its `{basis, expectedDivergence}`, so a cell can be built without a scan */
const METRIC_BASIS = Object.fromEntries(
    ACCURACY_METRICS.map(({ key, basis, expectedDivergence }) => [key, { basis, expectedDivergence }])
);

/**
 * How far a player's figure has to run before the card names them.
 *
 * Chosen to sit above the noise a spectated stream carries anyway — a tick
 * missed at the join or the tail moves a mid-sized player a few percent — and
 * below anything that would make a leader re-read a scoreboard. It is a
 * threshold for *listing a name*, not a verdict: the medians below it are
 * reported whatever it is set to.
 */
export const OUTLIER_THRESHOLD_PCT = 15;

/**
 * A percentage difference, measured against the game's figure.
 *
 * A game figure of zero has no denominator. Measuring something where the game
 * reported nothing is infinitely wrong and says so; measuring nothing where the
 * game reported nothing is exactly right and reads 0.
 *
 * @param {number} measured - What the stream was split into
 * @param {number} reported - What the game said
 * @returns {number} Signed percent, or `Infinity`
 */
export function deltaPct(measured, reported) {
    if (reported > 0) return ((measured - reported) / reported) * 100;
    return measured > 0 ? Infinity : 0;
}

/** The middle of a list of numbers, or null when there is nothing to take a middle of */
function median(values) {
    const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!list.length) return null;
    const middle = Math.floor(list.length / 2);
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** Whether an object actually holds a row for this name (a zero row still counts) */
function has(map, name) {
    return Boolean(map) && Object.prototype.hasOwnProperty.call(map, name);
}

/**
 * Join the game's reported per-member totals against the live measurement.
 *
 * Both sides are `{name: {damage, healing, taken}}`. Rows are ordered by
 * reported damage, so the biggest contributors read first, and each row says
 * whether the name matched at all — a row with `matched: false` has a measured
 * side that is zeroes because nothing was found, not because nothing happened.
 *
 * Each cell carries `basis` — what its measured and reported sides each count —
 * and `expectedDivergence`, non-null on the two metrics that compare quantities
 * which are not the same quantity. The numbers are untouched by this; it is
 * there so the export reads as what it is instead of as a failure. See
 * {@link ACCURACY_METRICS}.
 *
 * @param {Object} [input] - The pair
 * @param {Object|null} [input.reported] - The game's totals, by name
 * @param {Object|null} [input.measured] - The stream's totals, by name
 * @returns {Array<{name: string, matched: boolean, damage: Object, healing: Object, taken: Object}>} Rows
 */
export function joinTrialStats({ reported, measured } = {}) {
    if (!reported || typeof reported !== 'object') return [];
    const mine = measured && typeof measured === 'object' ? measured : {};
    // Every cell carries what its two sides measure and whether they are
    // expected to disagree. Repetitive in the file, and deliberately so: the
    // export's consumers read a row, not a legend, and two of the three metrics
    // compare quantities that are not the same quantity
    const cell = (key, m, g) => ({ measured: m, reported: g, deltaPct: deltaPct(m, g), ...METRIC_BASIS[key] });

    return Object.entries(reported)
        .map(([name, game]) => {
            const seen = mine[name] || {};
            return {
                name,
                matched: has(mine, name),
                damage: cell('damage', seen.damage || 0, game?.damage || 0),
                healing: cell('healing', seen.healing || 0, game?.healing || 0),
                taken: cell('taken', seen.taken || 0, game?.taken || 0),
            };
        })
        .sort((a, b) => b.damage.reported - a.damage.reported);
}

/**
 * The names the measurement holds that the game's totals never mentioned.
 *
 * The same rename symptom as an unmatched reported name, seen from the other
 * end. It is a count and nothing more — there is no game figure to compare a
 * measured-only player against, so they cannot enter any median either.
 *
 * @param {Object|null} reported - The game's totals, by name
 * @param {Object|null} measured - The stream's totals, by name
 * @returns {string[]} Names present only in the measurement
 */
export function measuredOnlyNames(reported, measured) {
    const theirs = reported && typeof reported === 'object' ? reported : {};
    return Object.keys(measured && typeof measured === 'object' ? measured : {}).filter((name) => !has(theirs, name));
}

/**
 * One trial's accuracy, in full: totals, per-metric spread, and the outliers.
 *
 * Everything here is computed over **matched** rows only, and per metric over
 * the matched rows the game actually reported a figure for. A player the game
 * reported no healing for contributes nothing to the healing median rather than
 * a perfect score — a party of ten with one healer would otherwise read as 90%
 * of players attributed flawlessly.
 *
 * @param {Object} [input] - The pair and the listing threshold
 * @param {Object|null} [input.reported] - The game's totals, by name
 * @param {Object|null} [input.measured] - The stream's totals, by name
 * @param {number} [input.threshold] - Percent past which a player is listed
 * @returns {{rows: Array<Object>, players: number, matched: number, unmatched: number,
 *   unmatchedNames: string[], measuredOnly: number, metrics: Object, totals: Object,
 *   outliers: Array<Object>}} The trial's accuracy
 */
export function summarizeTrialAccuracy({ reported, measured, threshold = OUTLIER_THRESHOLD_PCT } = {}) {
    const rows = joinTrialStats({ reported, measured });
    const matchedRows = rows.filter((row) => row.matched);
    const unmatchedNames = rows.filter((row) => !row.matched).map((row) => row.name);
    const limit = Number.isFinite(threshold) ? Math.abs(threshold) : OUTLIER_THRESHOLD_PCT;

    const metrics = {};
    const totals = {};
    for (const { key } of ACCURACY_METRICS) {
        const scored = matchedRows.filter((row) => row[key].reported > 0);
        const deltas = scored.map((row) => row[key].deltaPct);
        const finite = deltas.filter((value) => Number.isFinite(value));
        // The signed delta whose magnitude is largest — the sign is half the
        // story, since a whole party reading low is a different fault from one
        // player reading high
        let worst = null;
        for (const value of deltas) {
            if (worst === null || Math.abs(value) > Math.abs(worst)) worst = value;
        }

        metrics[key] = {
            median: median(finite.map(Math.abs)),
            worst,
            players: scored.length,
            // Matched, but the game reported nothing for this metric — kept out
            // of the median and counted so the denominator is legible
            missing: matchedRows.length - scored.length,
        };

        const sum = (side) => matchedRows.reduce((total, row) => total + (row[key][side] || 0), 0);
        const measuredTotal = sum('measured');
        const reportedTotal = sum('reported');
        totals[key] = {
            measured: measuredTotal,
            reported: reportedTotal,
            // Summed over matched rows only, so with no matched rows both
            // sides are 0 — and `deltaPct(0, 0)` is 0 by the rule that
            // measuring nothing where nothing was reported is exactly right.
            // That rule is about one player. Over an empty set it manufactures
            // a perfect party score out of a join that found nobody, which the
            // card then headlines in green. Nothing matched is nothing to
            // report.
            deltaPct: matchedRows.length ? deltaPct(measuredTotal, reportedTotal) : null,
        };
    }

    const outliers = matchedRows
        .map((row) => {
            let worstKey = null;
            let worstValue = 0;
            for (const { key } of ACCURACY_METRICS) {
                if (row[key].reported <= 0) continue;
                const value = row[key].deltaPct;
                if (Math.abs(value) < limit) continue;
                if (worstKey === null || Math.abs(value) > Math.abs(worstValue)) {
                    worstKey = key;
                    worstValue = value;
                }
            }
            return worstKey ? { ...row, worstMetric: worstKey, worstDeltaPct: worstValue } : null;
        })
        .filter(Boolean)
        .sort((a, b) => Math.abs(b.worstDeltaPct) - Math.abs(a.worstDeltaPct));

    return {
        rows,
        players: rows.length,
        matched: matchedRows.length,
        unmatched: unmatchedNames.length,
        unmatchedNames,
        measuredOnly: measuredOnlyNames(reported, measured).length,
        metrics,
        totals,
        outliers,
        threshold: limit,
    };
}

/**
 * Every stored trial of a week, summarized.
 *
 * The input is `guildTrialsStats`'s `trials` blob — `{[encounter]: {reported,
 * measured, at}}` — and the output is keyed the same way, so a card can walk
 * encounters without knowing where the pair came from.
 *
 * @param {Object|null} trials - The week's stored pairs, by encounter
 * @param {Object} [options] - Overrides
 * @param {number} [options.threshold] - Percent past which a player is listed
 * @returns {Array<{encounter: string, at: number|null, accuracy: Object}>} One per encounter, newest last
 */
export function summarizeWeekAccuracy(trials, { threshold = OUTLIER_THRESHOLD_PCT } = {}) {
    if (!trials || typeof trials !== 'object') return [];
    return (
        Object.entries(trials)
            .filter(([, pair]) => pair && typeof pair === 'object')
            // `measured: null` is a trial whose server totals arrived with nothing
            // watched beside them — a roster for the attendance ledger, not a
            // measurement, and a "0 of N matched" line for it would read as the
            // attribution failing. An empty `{}` stays: a watched trial that
            // measured nobody is exactly that claim.
            .filter(([, pair]) => pair.measured !== null && pair.measured !== undefined)
            .map(([encounter, pair]) => ({
                encounter,
                at: Number.isFinite(pair.at) ? pair.at : null,
                accuracy: summarizeTrialAccuracy({ reported: pair.reported, measured: pair.measured, threshold }),
            }))
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    );
}

/**
 * How good the trace behind a week's measurement was, small enough to archive.
 *
 * The accuracy figures say how far the attribution landed from the game's own
 * totals. They do not say whether the measurement had a fair chance: a trace
 * with a forty-second hole in it, or one that began halfway through a fight,
 * produces a perfectly confident-looking delta that is really a statement about
 * what the stream missed. Those two facts have to be archived together or the
 * pairing can never be made — the trace itself is thrown away long before a
 * month-old cycle is read back.
 *
 * A trace that was not running is `{traced: false}` and nothing else. Writing
 * `gapsOver5s: 0` for a week nobody recorded would be a claim of a clean trace
 * where there was no trace at all, and the whole point of the field is to tell
 * those apart.
 *
 * @param {Object|null} status - From `guildTrialTrace.status()`
 * @returns {{traced: boolean, gapsOver5s?: number, maxGapMs?: number|null,
 *   startedMidFight?: boolean|null, resumedAcrossReloads?: boolean}}
 */
export function traceQuality(status) {
    if (!status || !status.traceId) return { traced: false };
    return {
        traced: true,
        gapsOver5s: Number(status.gapsOver5s) || 0,
        maxGapMs: Number.isFinite(status.maxGapMs) ? status.maxGapMs : null,
        // Tri-state on purpose: an empty trace has not started anywhere, and
        // "we could not tell" is not "it started cleanly"
        startedMidFight:
            status.startedMidFight === null || status.startedMidFight === undefined
                ? null
                : Boolean(status.startedMidFight),
        resumedAcrossReloads: Boolean(status.resumedAcrossReloads),
    };
}

/**
 * The compact form that goes into the archive.
 *
 * Per metric: the median and worst deltas and how many players stood behind
 * them, plus the match counts. Deliberately **not** the per-player table — an
 * archive entry is carried in the same record as four cycles of tiles and a
 * per-player accuracy table per trial would multiply its size by the party size
 * for a detail nobody reads a month later. The medians are what a trend line
 * needs.
 *
 * `quality` is the trace's condition at the moment of archiving, stamped on
 * every encounter in the cycle because the trace is one recording spanning all
 * of them. It is recorded now and read later: the card that pairs a wide
 * accuracy delta against a gappy trace cannot be built from cycles that never
 * carried the fields, so the recording has to start before the reading exists.
 *
 * @param {Object|null} trials - The week's stored pairs, by encounter
 * @param {Object} [options] - Overrides
 * @param {number} [options.threshold] - Percent past which a player is listed
 * @param {Object|null} [options.trace] - `guildTrialTrace.status()` at archive time
 * @returns {Object} `{[encounter]: {at, players, matched, unmatched, measuredOnly, metrics, quality}}`
 */
export function compactAccuracySummary(trials, { threshold = OUTLIER_THRESHOLD_PCT, trace = null } = {}) {
    const quality = traceQuality(trace);
    const out = {};
    for (const entry of summarizeWeekAccuracy(trials, { threshold })) {
        const { accuracy } = entry;
        const metrics = {};
        for (const { key } of ACCURACY_METRICS) {
            const held = accuracy.metrics[key];
            metrics[key] = {
                median: Number.isFinite(held.median) ? Number(held.median.toFixed(2)) : null,
                worst: Number.isFinite(held.worst) ? Number(held.worst.toFixed(2)) : null,
                players: held.players,
            };
        }
        out[entry.encounter] = {
            at: entry.at,
            players: accuracy.players,
            matched: accuracy.matched,
            unmatched: accuracy.unmatched,
            measuredOnly: accuracy.measuredOnly,
            metrics,
            // The same object per encounter: one trace covers the whole cycle,
            // and copying it beside each trial is what lets a single trial be
            // read back on its own later
            quality: { ...quality },
        };
    }
    return out;
}

/**
 * A cycle's trace quality, folded from the trials that carry it.
 *
 * One trace covers a cycle, so in practice every trial in an entry carries the
 * same object — but an entry can be a merge of records from two devices, or a
 * cycle half of which was archived before the fields existed, so the fold takes
 * the worst reading rather than assuming they agree. Worst is the honest
 * direction: a cycle where any trial was recorded across a reload was recorded
 * across a reload.
 *
 * `tracedTrials` is counted separately from `traced` so a cycle where the trace
 * was switched on halfway is not read as one that was traced throughout.
 *
 * A cycle whose trials predate the field comes back `{traced: false,
 * tracedTrials: 0}` — the same shape a genuinely untraced cycle gets, because
 * that is exactly what can be said about it.
 *
 * @param {Array<Object>} trials - An archive entry's trials
 * @returns {{traced: boolean, tracedTrials: number, gapsOver5s: number|null, maxGapMs: number|null,
 *   startedMidFight: boolean|null, resumedAcrossReloads: boolean}}
 */
function foldTraceQuality(trials) {
    const traced = trials.map((trial) => trial.quality).filter((quality) => quality && quality.traced === true);
    if (!traced.length) {
        return {
            traced: false,
            tracedTrials: 0,
            gapsOver5s: null,
            maxGapMs: null,
            startedMidFight: null,
            resumedAcrossReloads: false,
        };
    }

    /**
     * The largest finite reading of one field, or null when none is finite.
     * @param {string} key - Which field
     * @returns {number|null}
     */
    const worst = (key) => {
        const values = traced.map((quality) => quality[key]).filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
    };

    const midFight = traced.map((quality) => quality.startedMidFight);
    return {
        traced: true,
        tracedTrials: traced.length,
        gapsOver5s: worst('gapsOver5s'),
        maxGapMs: worst('maxGapMs'),
        // True beats unknown beats false: one trial known to have started mid
        // fight is a fact about the cycle, and unknown must not read as clean
        startedMidFight: midFight.some((value) => value === true)
            ? true
            : midFight.every((value) => value === false)
              ? false
              : null,
        resumedAcrossReloads: traced.some((quality) => quality.resumedAcrossReloads === true),
    };
}

/**
 * The trend line, read off the archived cycles.
 *
 * `accuracy` is an additive field on an archive entry: every entry written
 * before this existed has no such key, and there is no way to reconstruct one
 * from the tiles it does carry. Those cycles come back with
 * `hasAccuracy: false` and the card says "no accuracy data" for them rather
 * than drawing a gap in the line as if the attribution had been perfect.
 *
 * A cycle's figure per metric is the median across its trials' medians — the
 * middle of a couple of numbers, which is an average with fewer opinions.
 *
 * @param {Array<Object>|null} history - A record's archived cycles, oldest first
 * @returns {Array<{weekStart: number|null, archivedAt: number|null, reason: string|null,
 *   hasAccuracy: boolean, trials: number, unmatched: number, metrics: Object}>} One per cycle
 */
export function archivedAccuracyTrend(history) {
    return (Array.isArray(history) ? history : []).filter(Boolean).map((entry) => {
        const base = {
            weekStart: Number.isFinite(entry.weekStart) ? entry.weekStart : null,
            archivedAt: Number.isFinite(entry.archivedAt) ? entry.archivedAt : null,
            reason: entry.reason || null,
        };

        const trials = Object.values(entry.accuracy && typeof entry.accuracy === 'object' ? entry.accuracy : {}).filter(
            (trial) => trial && typeof trial === 'object'
        );
        if (!trials.length) {
            // `quality` in its untraced shape rather than absent: a reader that
            // has to check `hasAccuracy` and then check whether the key exists
            // will eventually forget the second check, and a missing object
            // reads as clean
            return { ...base, hasAccuracy: false, trials: 0, unmatched: 0, metrics: {}, quality: foldTraceQuality([]) };
        }

        const metrics = {};
        for (const { key } of ACCURACY_METRICS) {
            const medians = trials.map((trial) => trial.metrics?.[key]?.median).filter(Number.isFinite);
            const worsts = trials.map((trial) => trial.metrics?.[key]?.worst).filter(Number.isFinite);
            let worst = null;
            for (const value of worsts) {
                if (worst === null || Math.abs(value) > Math.abs(worst)) worst = value;
            }
            metrics[key] = {
                median: median(medians),
                worst,
                players: trials.reduce((total, trial) => total + (Number(trial.metrics?.[key]?.players) || 0), 0),
            };
        }

        return {
            ...base,
            hasAccuracy: true,
            trials: trials.length,
            unmatched: trials.reduce((total, trial) => total + (Number(trial.unmatched) || 0), 0),
            metrics,
            quality: foldTraceQuality(trials),
        };
    });
}

/**
 * Whether gappy traces sat alongside wider accuracy deltas, across the archive.
 *
 * A pairing, never a cause: the same week produced both readings, and a week
 * with a broken trace may also have been a week with an unusual roster, a
 * mid-fight join, or a build change — none of which this can distinguish. The
 * verdict therefore only ever says what stood next to what.
 *
 * Refuses below a minimum: with fewer than `minCycles` usable cycles, or with
 * either side of the split empty, there is nothing honest to pair and the
 * result says so instead of manufacturing a comparison from one point. A cycle
 * is usable only when it carries an accuracy figure AND a traced quality with a
 * finite gap count — an untraced week can neither confirm nor refute anything.
 *
 * @param {Array<Object>} trend - From {@link archivedAccuracyTrend}, any order
 * @param {Object} [options] - Overrides
 * @param {number} [options.minCycles] - Fewest usable cycles worth pairing
 * @returns {{verdict: 'insufficient', usable: number, clean: number, gappy: number, minCycles: number}
 *   | {verdict: 'paired', clean: {cycles: number, medianAbsDelta: number},
 *      gappy: {cycles: number, medianAbsDelta: number}}}
 */
export function traceGapAccuracyPairing(trend, { minCycles = 3 } = {}) {
    const usable = (Array.isArray(trend) ? trend : []).filter(
        (cycle) =>
            cycle &&
            cycle.hasAccuracy === true &&
            cycle.quality?.traced === true &&
            Number.isFinite(cycle.metrics?.damage?.median) &&
            Number.isFinite(cycle.quality.gapsOver5s)
    );
    const clean = usable.filter((cycle) => cycle.quality.gapsOver5s === 0);
    const gappy = usable.filter((cycle) => cycle.quality.gapsOver5s > 0);

    if (usable.length < minCycles || !clean.length || !gappy.length) {
        return { verdict: 'insufficient', usable: usable.length, clean: clean.length, gappy: gappy.length, minCycles };
    }

    const side = (cycles) => ({
        cycles: cycles.length,
        medianAbsDelta: median(cycles.map((cycle) => Math.abs(cycle.metrics.damage.median))),
    });
    return { verdict: 'paired', clean: side(clean), gappy: side(gappy) };
}
