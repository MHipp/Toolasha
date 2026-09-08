/**
 * Labyrinth Level Finder
 *
 * The highest room level a character still clears at a given rate, found by
 * binary search over simulated fights.
 *
 * This is the same question the labyrinth panel's Recommend button asks, and it
 * is deliberately answered over the same window and against the same bar. The
 * two used to disagree: this search ran a fixed 20–300 at a fixed 95%, which
 * stopped short of what a high-level character can clear, wasted probes below
 * the floor for a low-level one, and measured against a bar nothing else in the
 * script uses. The window now comes from the character — every room level the
 * automation table could send them to — and the bar from the shared setting.
 */

import config from '../../core/config.js';
import { runLabyrinthSimulation } from './combat-sim-runner.js';
import { SKIP_THRESHOLD_RANGE } from '../combat/labyrinth-clear-rate.js';

/** Hours to simulate per probe: ~50-100+ encounters depending on fight time */
const DEFAULT_SIM_HOURS = 2;
/** No probe decides on fewer fights than this, however lopsided they look */
const DECISION_MIN_TRIALS = 40;
/** A level genuinely on the bar never decides; this is where it gives up */
const DECISION_MAX_TRIALS = 4000;
/** The lowest room the labyrinth has */
const MIN_ROOM_LEVEL = 1;

/**
 * The room levels worth searching for a character at this level.
 *
 * Room level is `effectiveLevel + skip - 1` and the skip threshold runs
 * ±SKIP_THRESHOLD_RANGE, so those two ends are every room the game could send
 * them to — nothing outside it is reachable, and everything inside it is.
 *
 * @param {number} referenceLevel - The character's effective combat level
 * @returns {{minLevel: number, maxLevel: number}}
 */
export function searchWindowFor(referenceLevel) {
    const anchor = Number.isFinite(referenceLevel) && referenceLevel > 0 ? Math.floor(referenceLevel) : null;
    if (anchor === null) {
        // Nothing to anchor to. Searching the full positive range is slower but
        // is at least not wrong, and beats inventing a level for the character.
        return { minLevel: MIN_ROOM_LEVEL, maxLevel: SKIP_THRESHOLD_RANGE };
    }
    return {
        minLevel: Math.max(MIN_ROOM_LEVEL, anchor - SKIP_THRESHOLD_RANGE),
        maxLevel: Math.max(MIN_ROOM_LEVEL, anchor + SKIP_THRESHOLD_RANGE - 1),
    };
}

/**
 * The clear-rate bar, as a ratio. The panel's Target Win % setting, so Find Max
 * and Recommend aim at the same thing unless the caller says otherwise.
 * @returns {number} 0-1
 */
export function defaultThreshold() {
    const pct = Math.min(
        100,
        Math.max(1, Math.floor(Number(config.getSettingValue('labyrinthRecommendTargetRate', 70)) || 70))
    );
    return pct / 100;
}

/**
 * Find the highest room level where win rate >= threshold.
 *
 * @param {Object} params
 * @param {Object} params.gameData - Game data payload
 * @param {Array<Object>} params.playerDTOs - Player DTOs
 * @param {string} params.zoneHrid - Zone HRID for SimResult context
 * @param {string} params.monsterHrid - Labyrinth monster HRID
 * @param {string[]} params.crates - Crate item HRIDs
 * @param {Object} params.communityBuffs - Community buff config
 * @param {Object} [params.labyrinthCombatBuffs] - Labyrinth-only combat buffs
 * @param {number} [params.threshold] - Win rate bar (0-1); defaults to the
 *   labyrinthRecommendTargetRate setting
 * @param {number} [params.referenceLevel] - The character's effective combat
 *   level, which sets the search window when minLevel/maxLevel are not given
 * @param {number} [params.minLevel] - Lowest room level to search
 * @param {number} [params.maxLevel] - Highest room level to search
 * @param {number} [params.simHours=2] - Hours to simulate per level
 * @param {number} [params.maxTrials] - Fights a single probe may run before it
 *   gives up deciding. Defaults to DECISION_MAX_TRIALS; a caller with its own
 *   fight budget (the Upgrade tab's Max fights) passes the tighter of the two
 * @param {Function} [params.abortSignal] - Polled between probes; a true stops
 *   the search where it stands and returns what it had
 * @param {Function} [onProgress] - Progress callback ({ level, winRate, step, totalSteps })
 * @returns {Promise<Object>} { maxLevel, winRate, steps, threshold, minLevel,
 *   maxSearched, cleared, atCeiling, aborted } — `cleared` is false when nothing
 *   in the window met the bar, in which case `maxLevel` is 0 rather than a level
 */
export async function findMaxLabyrinthLevel(params, onProgress) {
    const {
        gameData,
        playerDTOs,
        zoneHrid,
        monsterHrid,
        crates,
        communityBuffs,
        labyrinthCombatBuffs,
        threshold = defaultThreshold(),
        referenceLevel = null,
        simHours = DEFAULT_SIM_HOURS,
        maxTrials = DECISION_MAX_TRIALS,
        abortSignal = null,
    } = params;
    const probeMaxTrials = Math.max(DECISION_MIN_TRIALS, Math.floor(Number(maxTrials) || DECISION_MAX_TRIALS));

    const window = searchWindowFor(referenceLevel);
    const minLevel = Math.max(MIN_ROOM_LEVEL, Math.floor(Number(params.minLevel) || window.minLevel));
    const maxLevel = Math.max(minLevel, Math.floor(Number(params.maxLevel) || window.maxLevel));

    let low = minLevel;
    let high = maxLevel;
    let bestLevel = 0;
    let bestWinRate = 0;
    let bestAvgFightSeconds = 0;
    let step = 0;
    const totalSteps = Math.ceil(Math.log2(maxLevel - minLevel + 1)) + 1;

    let aborted = false;
    while (low <= high) {
        // Polled before the probe rather than after it: a search that has been
        // cancelled should not pay for one more simulation to notice.
        if (abortSignal?.()) {
            aborted = true;
            break;
        }
        const mid = Math.floor((low + high) / 2);
        step++;

        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs,
            zoneHrid,
            monsterHrid,
            roomLevel: mid,
            crates,
            hours: simHours,
            // A probe only has to place this level on one side of the bar, not
            // measure it. A level clearing 90% against a 50% bar is settled in
            // a few dozen fights; pinning that 90% to a point would take nearly
            // two thousand. Only a level sitting on the bar runs to the cap,
            // and there the search is indifferent to which way it falls.
            precision: { decideAgainst: threshold, minTrials: DECISION_MIN_TRIALS, maxTrials: probeMaxTrials },
            communityBuffs,
            labyrinthCombatBuffs,
            // Build the monster with its full tier-gated kit (stun, defence shred,
            // self-buffs), same as the tile badges and calibration replay — a
            // bare auto-attacker over-predicts the max clearable level.
            fullAbilities: true,
        });

        const attempts = simResult.labyAttemptCount || 1;
        const encounters = simResult.encounters || 0;
        const winRate = encounters / attempts;

        if (onProgress) {
            onProgress({ level: mid, winRate, step, totalSteps, encounters, attempts });
        }

        if (winRate >= threshold) {
            bestLevel = mid;
            bestWinRate = winRate;
            // Kept so the caller can quote a throughput at the level it lands
            // on. The search itself is indifferent to it — the objective is
            // still the highest level that clears at the bar.
            bestAvgFightSeconds = attempts > 0 ? simResult.simulatedTime / 1e9 / attempts : 0;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return {
        maxLevel: bestLevel,
        winRate: bestWinRate,
        avgFightSeconds: bestAvgFightSeconds,
        steps: step,
        threshold,
        minLevel,
        maxSearched: maxLevel,
        // Nothing in the window met the bar. Distinct from "level 0", which is
        // not a room — the caller has to say so rather than do arithmetic on it.
        cleared: bestLevel > 0,
        // Still clearing at the top of the window, so the true answer is at
        // least this and possibly higher
        atCeiling: bestLevel === maxLevel,
        // Cut short. Whatever `maxLevel` holds is a level that did clear, but
        // the search never ruled out the levels above it, so the caller must
        // not present it as the answer.
        aborted,
    };
}
