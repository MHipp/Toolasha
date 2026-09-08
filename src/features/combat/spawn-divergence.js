/**
 * Spawn Divergence
 *
 * Whether the rosters the spawn census recorded still look like draws from the
 * spawn tables the combat simulator was fitted to.
 *
 * The wave-draw rule in `combat-sim/engine/zone.js` is a *fit*: one weight on
 * every eligible lower table, validated at 3.3e10:1 over 3,078 waves. A fit is
 * a statement about the game as it was on the day it was measured. When the
 * game changes a spawn table, nothing in the simulator complains — the clear
 * times simply start drifting, and the drift is small enough that it is noticed
 * weeks later, if at all, and then blamed on the model rather than on the data.
 *
 * The census is already recording exactly what would settle that question. This
 * module turns those counts into a statement the moment they stop agreeing with
 * the tables, which is the difference between "the table changed on Tuesday"
 * and "the simulator has been wrong for a month".
 *
 * ## What is compared, and why it is exact
 *
 * For each (zone, tier) and each *band* — the set of spawn tables a wave is
 * eligible to draw from, which is a function of the wave number alone — the
 * expected probability that a species appears at least once in a wave is
 * computed from the tables themselves, and compared against the fraction of
 * recorded waves in that band that actually contained it.
 *
 * The expectation is a closed form, not a Monte Carlo. The draw loop in
 * `getNextWave` is a Markov chain in (slot index, cumulative strength), because
 * that pair is everything the loop's own control flow depends on: it draws up
 * to `maxSpawnCount` species independently by weight, adds each one's strength,
 * and aborts the *whole* wave the first time the running total would exceed
 * `maxTotalStrength` — without pushing the species that overflowed. So
 * `P(species X never appears)` is a forward sweep over that chain in which the
 * X branch is absorbing, and the state space is at most
 * `maxSpawnCount x maxTotalStrength` — five slots and a few hundred integer
 * strengths in every dungeon in the game. See {@link tableSpawnProbabilities}.
 *
 * A Monte Carlo would have been acceptable and is what the brief allowed for,
 * but it would put sampling noise into the null hypothesis of a test whose
 * whole job is to distinguish 3 sigma from 5. `spawn-divergence.test.js` checks
 * the closed form against the real engine's seeded draws instead, which also
 * catches the one thing a self-contained derivation cannot: this file's copy of
 * {@link LOWER_TABLE_RATE} drifting away from `zone.js`'s (the constant is not
 * exported there, and `zone.js` is not this module's to edit).
 *
 * ## What is deliberately not compared
 *
 * - **Fixed waves.** A wave number that is a key of `fixedSpawnsMap` has a
 *   pinned roster and no random draw at all. Every non-zero `randomSpawnInfoMap`
 *   key is also a fixed wave in every live dungeon, so this also removes the
 *   `wave === key` boundary from the sample rather than reasoning about it.
 * - **Non-dungeon zones.** Their waves are a boss cycle interleaved with random
 *   encounters, and the census does not record which battle of the cycle a
 *   roster came from, so the boss rosters cannot be separated from the rest.
 * - **A census that has evicted rows.** Past the row cap the retained counts mix
 *   full-history counts with counts truncated to zero, and the rows evicted
 *   first are the rare ones — see `MAX_ROSTER_ROWS`. That is not a shorter
 *   window, it is a biased one, and no test run on it means anything.
 */

/**
 * Chance a dungeon wave is drawn from any one table below the highest it has
 * reached.
 *
 * A copy of `combat-sim/engine/zone.js`'s constant of the same name, which is
 * not exported. `spawn-divergence.test.js` pins the two together by checking
 * this module's closed form against the real `Zone`'s draws, so a change there
 * that is not made here fails the suite rather than silently making every
 * expectation wrong.
 */
export const LOWER_TABLE_RATE = 1 / 7;

/**
 * Waves a band needs before any verdict is given for it.
 *
 * From the variance, not from taste. A species appearing with probability p has
 * a per-wave standard deviation of `sqrt(n p (1-p))` waves, so at n = 100 the
 * widest case (p = 0.5) has sigma = 5 waves and the 3-sigma threshold is 15
 * waves — a 30% shift in that species' frequency. That is roughly what
 * a 1.5x change to one row of a spawn table does to a mid-frequency species, and
 * it is the smallest change worth waking anybody up for. Below 100 waves the
 * threshold is a factor-of-two rate change or worse, so a verdict there would be
 * a coin flip dressed as a measurement.
 *
 * 100 also makes the silent-species rule safe on its own terms: a species the
 * tables give p > 0.2 that is never seen in 100 waves has probability
 * 0.8^100 = 2e-10 of being a fluke, which is well past the 5-sigma bar the rule
 * is standing in for.
 */
export const MIN_BAND_WAVES = 100;

/**
 * Per-species floor on `n p (1-p)` before a z-score is quoted for it.
 *
 * The textbook condition for the normal approximation to a binomial, and the
 * reason the report marks rare species `underpowered` instead of scoring them:
 * a 5-sigma claim is a statement about a tail, and the tail is exactly where the
 * approximation fails first. Every species the verdict rules actually depend on
 * clears this comfortably — the silent-species rule needs p > 0.2 at n >= 100,
 * which is n p (1-p) >= 16.
 */
export const MIN_SPECIES_VARIANCE = 10;

/** Beyond this many sigma a band is `drifting`. */
export const DRIFT_SIGMA = 3;

/** Beyond this many sigma a band is `diverged`. */
export const DIVERGE_SIGMA = 5;

/**
 * A table species this likely per wave that is never once observed is a
 * divergence outright, not a drift — no rate change produces it, only the
 * species leaving the table.
 */
export const SILENT_SPECIES_P = 0.2;

/** Verdicts worst-first, so a zone can take the worst of its bands. */
const VERDICT_RANK = { diverged: 3, drifting: 2, consistent: 1, insufficient: 0 };

/**
 * FNV-1a over a string, base-36. Short, stable, and not a security claim.
 *
 * Lives here rather than in `spawn-census.js` because the fingerprint is only
 * interesting to whatever compares two of them, and a divergence check that
 * re-implemented the hash would be comparing its own arithmetic rather than the
 * census's.
 *
 * @param {string} text - Anything
 * @returns {string} A base-36 hash
 */
export function fingerprintOf(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * Guard on the strength chain's state count.
 *
 * Integer strengths against an integer cap keep this in the hundreds; a table
 * with fractional strengths could in principle branch without bound, and an
 * expectation is not worth locking the tab for.
 */
const MAX_CHAIN_STATES = 20000;

/**
 * For each species in one spawn table, the probability a single wave drawn from
 * that table contains it at least once.
 *
 * Mirrors `getNextWave`'s draw loop exactly, including the two things about it
 * that are easy to get wrong:
 *
 * - The overflow does not skip the offending slot, it breaks out of the whole
 *   loop (`break outer`), so a wave that overflows on slot 2 has two monsters
 *   and not four.
 * - The species that overflowed is **not** added. So "X was drawn" and "X
 *   appears in the wave" are different events whenever X's strength would not
 *   have fit, and only the second one is what the census sees.
 *
 * The sweep is run once per species with that species' branch made absorbing,
 * which gives `P(no X)` exactly; `1 - P(no X)` is the answer. Running it per
 * species rather than tracking the seen-set jointly is what keeps the state
 * space to (slot, strength) instead of (slot, strength, subset).
 *
 * @param {Object} table - One `randomSpawnInfoMap` entry: `{spawns, maxSpawnCount, maxTotalStrength}`
 * @returns {Map<string, number>|null} Monster hrid to P(appears at least once), or null if unusable
 */
export function tableSpawnProbabilities(table) {
    const spawns = Array.isArray(table?.spawns) ? table.spawns : null;
    if (!spawns || !spawns.length) return null;

    const slots = Math.floor(Number(table.maxSpawnCount));
    if (!(slots > 0)) return null;

    // Mirrors the engine: `totalStrength <= undefined` is false, so a table with
    // no cap terminates on its very first draw rather than ignoring the cap.
    const capRaw = Number(table.maxTotalStrength);
    const cap = Number.isFinite(capRaw) ? capRaw : -Infinity;

    const weights = spawns.map((spawn) => Math.max(0, Number(spawn.rate) || 0));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (!(totalWeight > 0)) return null;

    const strengths = spawns.map((spawn) => Number(spawn.strength) || 0);
    const hrids = spawns.map((spawn) => spawn.combatMonsterHrid);

    const probabilities = new Map();
    for (let target = 0; target < spawns.length; target++) {
        const hrid = hrids[target];
        // A table may list the same species twice; the second pass would compute
        // the same absorbing chain for a hrid already answered.
        if (hrid === undefined || hrid === null || probabilities.has(hrid)) continue;

        // `live` is the distribution over cumulative strength of the waves that
        // are still drawing and have not produced the target species; `absent`
        // accumulates the ones that have stopped without it.
        let live = new Map([[0, 1]]);
        let absent = 0;

        for (let slot = 0; slot < slots && live.size; slot++) {
            const next = new Map();
            for (const [strength, probability] of live) {
                for (let i = 0; i < spawns.length; i++) {
                    const share = probability * (weights[i] / totalWeight);
                    if (!(share > 0)) continue;
                    const total = strength + strengths[i];
                    if (total > cap) {
                        // Overflow: the wave ends here and this species is not
                        // added, so it is absent whether or not it was the target.
                        absent += share;
                    } else if (hrids[i] === hrid) {
                        // The target fits and is pushed. Absorbing, and not
                        // counted towards `absent`.
                    } else {
                        next.set(total, (next.get(total) || 0) + share);
                    }
                }
            }
            if (next.size > MAX_CHAIN_STATES) return null;
            live = next;
        }

        for (const probability of live.values()) absent += probability;
        probabilities.set(hrid, Math.min(1, Math.max(0, 1 - absent)));
    }

    // Species listed only with rate 0 never appear, but they are still *in* the
    // table, which is what stops them being reported as unknown species.
    for (let i = 0; i < spawns.length; i++) {
        if (hrids[i] !== undefined && hrids[i] !== null && !probabilities.has(hrids[i])) {
            probabilities.set(hrids[i], 0);
        }
    }
    return probabilities;
}

/**
 * The chance each eligible table is the one a wave draws from.
 *
 * The rule from `getNextWave`: every eligible table *below* the highest takes a
 * flat {@link LOWER_TABLE_RATE}, capped at an equal share so seven lower tables
 * cannot claim the whole roll, and the highest eligible table takes whatever is
 * left. An empty eligible set is the engine's own fallback — the lowest key,
 * with certainty.
 *
 * @param {Array<number>} eligibleKeys - Eligible table keys, ascending
 * @param {Array<number>} allKeys - Every table key, ascending, for the fallback
 * @returns {Map<number, number>} Table key to the probability a wave draws from it
 */
export function bandWeights(eligibleKeys, allKeys) {
    const weights = new Map();
    if (!eligibleKeys.length) {
        if (allKeys.length) weights.set(allKeys[0], 1);
        return weights;
    }
    const lowerCount = eligibleKeys.length - 1;
    if (lowerCount <= 0) {
        weights.set(eligibleKeys[0], 1);
        return weights;
    }
    const rate = Math.min(LOWER_TABLE_RATE, 1 / eligibleKeys.length);
    for (let i = 0; i < lowerCount; i++) weights.set(eligibleKeys[i], rate);
    weights.set(eligibleKeys[lowerCount], 1 - rate * lowerCount);
    return weights;
}

/**
 * The expected per-wave species frequencies of one band.
 *
 * A band is a set of eligible tables, so this is the table-choice probabilities
 * of {@link bandWeights} against the within-table probabilities of
 * {@link tableSpawnProbabilities}. Both are exact, so this is too.
 *
 * @param {Object} randomSpawnInfoMap - The dungeon's tables, keyed by wave threshold
 * @param {Array<number>} eligibleKeys - Eligible table keys, ascending
 * @param {Array<number>} allKeys - Every table key, ascending
 * @returns {Map<string, number>|null} Monster hrid to P(in a wave), or null if a table is unusable
 */
export function expectedBandFrequencies(randomSpawnInfoMap, eligibleKeys, allKeys) {
    const expected = new Map();
    for (const [key, weight] of bandWeights(eligibleKeys, allKeys)) {
        const perTable = tableSpawnProbabilities(randomSpawnInfoMap?.[key] ?? randomSpawnInfoMap?.[String(key)]);
        if (!perTable) return null;
        for (const [hrid, probability] of perTable) {
            expected.set(hrid, (expected.get(hrid) || 0) + weight * probability);
        }
    }
    return expected;
}

/**
 * Continuity-corrected z for `observed` successes in `n` Bernoulli trials of
 * probability `p`.
 *
 * The correction (the half-count pulled off the deviation) matters here because
 * the counts are discrete and the thresholds are hard: without it a species one
 * wave over the line reads as over the line, and 3 sigma on a discrete statistic
 * is not a 3-sigma event. Null below the variance floor rather than
 * approximated — see {@link MIN_SPECIES_VARIANCE}.
 *
 * @param {number} observed - Waves containing the species
 * @param {number} n - Waves in the band
 * @param {number} p - Expected probability per wave
 * @returns {number|null} Signed sigma, or null when the approximation does not hold
 */
export function binomialZ(observed, n, p) {
    const variance = n * p * (1 - p);
    if (!(variance >= MIN_SPECIES_VARIANCE)) return null;
    const deviation = observed - n * p;
    const corrected = Math.max(0, Math.abs(deviation) - 0.5);
    return (deviation < 0 ? -corrected : corrected) / Math.sqrt(variance);
}

/** The eligible table keys for a 1-based wave number. */
function eligibleFor(allKeys, wave) {
    return allKeys.filter((key) => wave >= key);
}

/** Sorted numeric keys of a spawn-table map, or an empty array. */
function tableKeys(randomSpawnInfoMap) {
    if (!randomSpawnInfoMap || typeof randomSpawnInfoMap !== 'object') return [];
    return Object.keys(randomSpawnInfoMap)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
}

/**
 * Whether a zone's live tables still hash to what the census recorded them as.
 *
 * Two ways this comes back true, and they mean the same thing for the counts:
 * the census saw more than one fingerprint while collecting (the tables were
 * patched mid-census, so the rows either side are not one experiment), or the
 * tables in the game right now are not the last ones it saw.
 *
 * @param {Object} table - The zone's live spawn tables, as the export carries them
 * @param {Array<string>} recorded - The zone's fingerprints, oldest first
 * @returns {boolean} Whether the tables moved
 */
export function fingerprintMoved(table, recorded) {
    const list = Array.isArray(recorded) ? recorded : [];
    if (list.length > 1) return true;
    if (!list.length || !table) return false;
    return list[0] !== fingerprintOf(JSON.stringify(table));
}

/**
 * Group a zone/tier's random-draw roster rows into bands.
 * @param {Array<Object>} rows - Roster rows for one (zone, tier)
 * @param {Object} tables - The zone's spawn tables
 * @returns {Map<number, {waves: number, seen: Map<string, number>, eligibleKeys: number[]}>}
 */
function bandsOf(rows, tables) {
    const keys = tableKeys(tables?.randomSpawnInfoMap);
    const fixed = tables?.fixedSpawnsMap && typeof tables.fixedSpawnsMap === 'object' ? tables.fixedSpawnsMap : {};
    const bands = new Map();
    if (!keys.length) return bands;

    for (const row of rows) {
        const wave = Number(row.wave);
        if (!Number.isFinite(wave)) continue;
        // A pinned roster is not a draw, and every non-zero table key is one.
        if (fixed[String(wave)]) continue;

        const eligibleKeys = eligibleFor(keys, wave);
        const id = eligibleKeys.length ? eligibleKeys[eligibleKeys.length - 1] : keys[0];
        const band = bands.get(id) || { waves: 0, seen: new Map(), eligibleKeys, id };
        const count = Number(row.count) || 0;
        band.waves += count;
        // Waves *containing* the species, not monsters drawn: a roster with two
        // of one species is one wave that contained it.
        for (const hrid of new Set(row.monsterHrids || [])) {
            band.seen.set(hrid, (band.seen.get(hrid) || 0) + count);
        }
        bands.set(id, band);
    }
    return bands;
}

/**
 * Score one band's species against its expected frequencies.
 * @param {{waves: number, seen: Map<string, number>, eligibleKeys: number[], id: number}} band
 * @param {Map<string, number>} expected - Species to P(in a wave)
 * @returns {Object} The band's report entry
 */
function scoreBand(band, expected) {
    const entry = {
        key: band.id,
        eligibleKeys: [...band.eligibleKeys],
        waves: band.waves,
        verdict: 'insufficient',
        species: [],
        worst: null,
        unknownSpecies: [],
        silentSpecies: [],
    };
    if (band.waves < MIN_BAND_WAVES) return entry;

    const names = new Set([...expected.keys(), ...band.seen.keys()]);
    let verdict = 'consistent';

    for (const hrid of [...names].sort()) {
        const probability = expected.get(hrid);
        const observed = band.seen.get(hrid) || 0;

        if (probability === undefined) {
            // In no eligible table at all. Nothing to score it against: its
            // presence is the finding.
            entry.species.push({ hrid, expected: 0, observed, z: null, status: 'unknown' });
            entry.unknownSpecies.push(hrid);
            verdict = 'diverged';
            continue;
        }

        if (probability >= SILENT_SPECIES_P && observed === 0) {
            entry.species.push({
                hrid,
                expected: probability,
                observed,
                z: null,
                status: 'silent',
                // Exact, not the normal tail: this is the one case where the
                // approximation is hopeless and the closed form is a one-liner.
                pValue: Math.pow(1 - probability, band.waves),
            });
            entry.silentSpecies.push(hrid);
            verdict = 'diverged';
            continue;
        }

        const z = binomialZ(observed, band.waves, probability);
        if (z === null) {
            entry.species.push({ hrid, expected: probability, observed, z: null, status: 'underpowered' });
            continue;
        }

        const magnitude = Math.abs(z);
        const status = magnitude >= DIVERGE_SIGMA ? 'diverged' : magnitude >= DRIFT_SIGMA ? 'drifting' : 'consistent';
        entry.species.push({ hrid, expected: probability, observed, z, status });
        if (status === 'diverged') verdict = 'diverged';
        else if (status === 'drifting' && verdict === 'consistent') verdict = 'drifting';
        if (!entry.worst || magnitude > Math.abs(entry.worst.z))
            entry.worst = { hrid, z, observed, expected: probability };
    }

    entry.verdict = verdict;
    return entry;
}

/**
 * Compare a spawn census against the spawn tables it was recorded under.
 *
 * Pure: everything it needs is in the export file, including the tables and the
 * fingerprints, so the same file analysed a year later gives the same answer.
 *
 * @param {Object} exportFile - `spawnCensus.exportFile()`
 * @returns {{ok: boolean, reason?: string, zones: Array<Object>}} The report
 */
export function analyzeSpawnDivergence(exportFile) {
    if (!exportFile || !Array.isArray(exportFile.rosters)) {
        return { ok: false, reason: 'no census', zones: [] };
    }
    if (exportFile.evictedRows > 0) {
        // Past the cap the counts are not a frequency distribution — the rare
        // rosters were dropped first and the survivors kept full-history counts.
        return { ok: false, reason: 'evicted', zones: [] };
    }
    const tablesByZone = exportFile.spawnTables || {};
    if (!Object.keys(tablesByZone).length) {
        return { ok: false, reason: 'no tables', zones: [] };
    }

    /** @type {Map<string, Array<Object>>} */
    const grouped = new Map();
    for (const row of exportFile.rosters) {
        const id = `${row.zoneHrid} ${row.difficultyTier}`;
        const list = grouped.get(id) || [];
        list.push(row);
        grouped.set(id, list);
    }

    const zones = [];
    for (const [id, rows] of grouped) {
        const [zoneHrid, tierText] = id.split(' ');
        const tables = tablesByZone[zoneHrid];
        if (!tables?.isDungeon || !tables.randomSpawnInfoMap) continue;

        const keys = tableKeys(tables.randomSpawnInfoMap);
        const fingerprintChanged = fingerprintMoved(tables, exportFile.spawnTableFingerprints?.[zoneHrid]);

        const bands = [];
        let waves = 0;
        let verdict = 'insufficient';
        for (const band of bandsOf(rows, tables).values()) {
            const expected = expectedBandFrequencies(tables.randomSpawnInfoMap, band.eligibleKeys, keys);
            if (!expected) continue;
            const entry = scoreBand(band, expected);
            bands.push(entry);
            waves += entry.waves;
            if (VERDICT_RANK[entry.verdict] > VERDICT_RANK[verdict]) verdict = entry.verdict;
        }
        if (!bands.length) continue;

        bands.sort((a, b) => a.key - b.key);
        const scored = bands.filter((band) => band.verdict !== 'insufficient');
        const worst = scored
            .map((band) => band.worst)
            .filter(Boolean)
            .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];

        zones.push({
            zoneHrid,
            difficultyTier: Number(tierText),
            verdict,
            waves,
            scoredWaves: scored.reduce((sum, band) => sum + band.waves, 0),
            fingerprintChanged,
            unknownSpecies: [...new Set(bands.flatMap((band) => band.unknownSpecies))],
            silentSpecies: [...new Set(bands.flatMap((band) => band.silentSpecies))],
            worst: worst || null,
            bands,
        });
    }

    zones.sort((a, b) => b.waves - a.waves);
    return { ok: true, zones };
}

/** `/monsters/dodocamel` reads as `dodocamel`. */
function shortName(hrid) {
    const text = String(hrid ?? '');
    return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * One line per zone/tier, for the census readout.
 *
 * @param {{ok: boolean, reason?: string, zones: Array<Object>}} report - {@link analyzeSpawnDivergence}'s output
 * @param {Function} [nameOf] - Zone hrid to a display name; defaults to the hrid's tail
 * @returns {Array<string>} Human-readable lines, worst first
 */
export function divergenceLines(report, nameOf = shortName) {
    if (!report?.ok) {
        if (report?.reason === 'evicted') {
            return [
                'Spawn divergence: not checked — the census has evicted rows, so its counts are no longer frequencies.',
            ];
        }
        return [];
    }
    const lines = [];
    for (const zone of [...report.zones].sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict])) {
        const label = `${nameOf(zone.zoneHrid)} T${zone.difficultyTier}`;
        const waves = `${zone.scoredWaves.toLocaleString()} waves`;

        if (zone.verdict === 'insufficient') {
            lines.push(
                `${label}: not enough waves yet (${zone.waves.toLocaleString()} of ${MIN_BAND_WAVES} in a band)`
            );
            continue;
        }

        const notes = [];
        if (zone.unknownSpecies.length) {
            notes.push(`${zone.unknownSpecies.map(shortName).join(', ')} is in no eligible table`);
        }
        if (zone.silentSpecies.length) {
            notes.push(`${zone.silentSpecies.map(shortName).join(', ')} never seen but expected`);
        }
        if (zone.worst && Math.abs(zone.worst.z) >= DRIFT_SIGMA) {
            const direction = zone.worst.z > 0 ? 'above' : 'below';
            notes.push(
                `${shortName(zone.worst.hrid)} seen ${Math.abs(zone.worst.z).toFixed(1)}σ ${direction} the table`
            );
        }
        if (zone.fingerprintChanged) notes.push('the spawn tables changed');

        lines.push(
            notes.length
                ? `${label}: ${zone.verdict} — ${notes.join('; ')} (${waves})`
                : `${label}: ${zone.verdict} (${waves})`
        );
    }
    return lines;
}

/**
 * The zone/tiers a notice would be about: diverged, or recorded under tables
 * that have since moved.
 *
 * Split out of the alert so the "what is worth saying" decision stays pure and
 * the alert module is only about delivery.
 *
 * @param {{ok: boolean, zones: Array<Object>}} report - {@link analyzeSpawnDivergence}'s output
 * @returns {Array<Object>} The zone entries worth a notice, worst first
 */
export function alertWorthy(report) {
    if (!report?.ok) return [];
    return report.zones.filter((zone) => zone.verdict === 'diverged' || zone.fingerprintChanged);
}
