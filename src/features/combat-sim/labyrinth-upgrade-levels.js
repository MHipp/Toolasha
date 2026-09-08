/**
 * Room levels gained: the Upgrade tab's second ranking pass.
 *
 * The tab's first pass asks every candidate one question at one room level —
 * "how much does this move the win rate here". That is cheap and it orders the
 * table, but it is not the currency labyrinth progression is denominated in.
 * What a player actually buys with an upgrade is *room levels*: how much deeper
 * they can go before the fights stop clearing, and therefore which floor they
 * finish.
 *
 * Measuring that costs a binary search per candidate — ten-odd simulations
 * where the first pass spent one — so it is run on a shortlist rather than on
 * the whole table. The first pass picks the shortlist; this pass measures it.
 */

import { labyrinthFloorForLevel } from '../combat/labyrinth-formulas.js';

/**
 * How many candidates get the expensive search.
 *
 * A search is ~11 simulations over the character's reachable window, against
 * the ~1 the first pass spends per candidate, so this multiplies the tab's cost
 * by roughly `size × 11` sims on top of a table that is usually 50-100 rows.
 * Six plus the baseline is about one extra candidate pass in wall-clock terms,
 * and is enough rows that the answer — which upgrade to buy next — is inside
 * the measured set rather than just below it.
 */
export const ROOM_LEVEL_SHORTLIST_SIZE = 6;

/**
 * The candidates worth paying a full level search for.
 *
 * Only rows ranked on the win rate, and only ones that moved it upward: a
 * candidate that did not win more fights at the level it was tested at cannot
 * push the highest cleared level up either, and a row ranked on experience
 * (the community buffs) never touches whether a room is cleared at all.
 *
 * @param {Array<Object>} results - Rows from `runLabyrinthUpgradeAnalysis`
 * @param {number} [size=ROOM_LEVEL_SHORTLIST_SIZE] - How many to keep
 * @returns {Array<Object>} The kept rows, best first
 */
export function shortlistForRoomLevels(results, size = ROOM_LEVEL_SHORTLIST_SIZE) {
    const keep = Math.max(0, Math.floor(Number(size) || 0));
    return (Array.isArray(results) ? results : [])
        .filter((r) => r && r.metricType === 'winRate' && (r.winRateDelta || 0) > 0)
        .sort((a, b) => (b.winRateDelta || 0) - (a.winRateDelta || 0))
        .slice(0, keep);
}

/**
 * Measure how many room levels the shortlisted upgrades buy, and annotate the
 * rows in place.
 *
 * Every row comes back with a `roomLevelDelta`, including the ones that were
 * never searched: "this changes nothing" is the honest answer for most upgrades
 * and has to be legible as `+0` rather than as a blank. `roomLevelMeasured`
 * separates a measured zero from an unsearched one, so a caller can say which
 * is which without either of them going missing.
 *
 * @param {Array<Object>} results - Rows from `runLabyrinthUpgradeAnalysis`,
 *   mutated in place and re-sorted by levels gained
 * @param {Object} options
 * @param {function(Object|null): Promise<Object|null>} options.measure - Runs
 *   the level search for one row, or for the unmodified character when passed
 *   null. Resolves to a `findMaxLabyrinthLevel` result
 * @param {number} [options.shortlistSize=ROOM_LEVEL_SHORTLIST_SIZE]
 * @param {Function} [options.abortSignal] - Polled before every search
 * @param {Function} [options.onProgress] - `({ current, total, description })`
 * @returns {Promise<Object>} `{ baselineLevel, baselineFloor, baselineCleared,
 *   measured, aborted, shortlistSize }`
 */
export async function measureRoomLevelGains(results, options = {}) {
    const { measure, shortlistSize = ROOM_LEVEL_SHORTLIST_SIZE, abortSignal, onProgress } = options;
    const rows = Array.isArray(results) ? results : [];
    for (const row of rows) {
        row.roomLevelDelta = 0;
        row.maxRoomLevel = null;
        row.floorReached = null;
        row.roomLevelMeasured = false;
    }

    const summary = {
        baselineLevel: 0,
        baselineFloor: 0,
        baselineCleared: false,
        measured: 0,
        aborted: false,
        shortlistSize: Math.max(0, Math.floor(Number(shortlistSize) || 0)),
    };
    if (typeof measure !== 'function') return summary;

    const shortlist = shortlistForRoomLevels(rows, summary.shortlistSize);
    const total = shortlist.length + 1;

    if (abortSignal?.()) {
        summary.aborted = true;
        return summary;
    }
    onProgress?.({ current: 0, total, description: 'Finding the deepest room this loadout clears…' });
    const baseline = await measure(null);
    if (baseline?.aborted || abortSignal?.()) summary.aborted = true;
    summary.baselineLevel = Math.max(0, Math.floor(Number(baseline?.maxLevel) || 0));
    summary.baselineFloor = labyrinthFloorForLevel(summary.baselineLevel);
    summary.baselineCleared = Boolean(baseline?.cleared) && !baseline?.aborted;

    // Without a baseline there is no delta to report, and a search that cleared
    // nothing is not a level of zero to subtract from — every row stays
    // unmeasured rather than being handed arithmetic on a non-answer.
    if (!summary.baselineCleared) return summary;

    for (const row of shortlist) {
        if (summary.aborted || abortSignal?.()) {
            summary.aborted = true;
            break;
        }
        onProgress?.({
            current: summary.measured + 1,
            total,
            description: row.candidate?.description || 'Upgrade',
        });
        const found = await measure(row);
        // A cut-short search stopped above some level it never ruled out, so its
        // number is a lower bound, not a measurement — the row keeps its +0. A
        // search that finished is kept even when the cancel landed just after
        // it: the measurement was paid for and is as good as any other.
        if (found?.cleared && !found?.aborted) {
            const level = Math.max(0, Math.floor(Number(found.maxLevel) || 0));
            row.maxRoomLevel = level;
            row.floorReached = labyrinthFloorForLevel(level);
            row.roomLevelDelta = level - summary.baselineLevel;
            row.roomLevelMeasured = true;
            summary.measured++;
        }
        if (found?.aborted || abortSignal?.()) {
            summary.aborted = true;
            break;
        }
    }

    // Levels gained is the ranking the tab was asked for, so the rows come back
    // in it. Ties keep the order the win-rate pass left them in.
    rows.sort((a, b) => (b.roomLevelDelta || 0) - (a.roomLevelDelta || 0));
    return summary;
}
