/**
 * Combat Simulator Runner
 * Runs simulations in parallel Web Workers for maximum speed.
 *
 * For large simulations (>= 20 hours), the time is split across multiple
 * workers (up to 4) running in parallel. Results are merged by summing
 * all additive counters. For small simulations, a single worker is used.
 */

// The ?worker suffix is handled by rollup's workerBundlePlugin at build time
import WORKER_SCRIPT from './combat-sim-worker-entry.js?worker';
import config from '../../core/config.js';
import { isMobileMode } from '../../utils/mobile.js';
import { createIdlePoolReaper } from '../../utils/worker-pool.js';
import { deriveSeed } from './engine/rng.js';

let workerBlobURL = null;
/** Wrappers running a chunk right now. `cancelSimulation` terminates these. */
let activeWorkers = [];
/**
 * Wrappers with nothing to do, kept warm for the next chunk.
 *
 * A worker is not cheap to start: the whole engine bundle is parsed and
 * instantiated, and the first message hands it a structured clone of the game
 * data. The labyrinth live readout replays the fight in progress every four
 * seconds, on the thread that draws the game, and was paying both every time.
 * Each entry is `{ worker, gameData }` - the game-data payload that worker was
 * last given, so a matching chunk can leave it out of the message entirely.
 */
let idleWorkers = [];
let taskIdCounter = 0;
let pendingRejects = []; // Track reject functions to abort on cancel

const MIN_HOURS_PER_WORKER = 20;
const MAX_WORKERS = 4;

/**
 * Idle workers kept at once. Each holds its own clone of the game data, so the
 * pool is capped at the widest single run (MAX_WORKERS) and no wider.
 */
const MAX_IDLE_WORKERS = MAX_WORKERS;

/**
 * How long an unused worker is kept. Long enough to span the live replay's
 * four-second cadence and a user reading one result before asking for the next,
 * short enough that a session that simulated once does not hold a thread and a
 * copy of the game data for the rest of the evening.
 */
const IDLE_WORKER_MS = 60 * 1000;

const idleReaper = createIdlePoolReaper(
    () => terminateIdleWorkers(),
    IDLE_WORKER_MS,
    // A chunk still running is not idle: its worker is not in the idle list,
    // but it will be released into it the moment it finishes.
    () => activeWorkers.length > 0
);

/**
 * @returns {number} Max worker count from setting, or hardware concurrency if 0/unset
 */
export function getMaxWorkers() {
    const setting = config.getSetting('combatSim_maxThreads') || 0;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    // Normally the machine has the last word: more workers than cores is more
    // memory and more contention for no more throughput. Someone who wants the
    // number taken literally can say so.
    if (config.getSetting('combatSim_uncapThreads') && setting > 0) return setting;
    const cap = setting > 0 ? Math.min(setting, cores) : Math.min(MAX_WORKERS, cores);
    // A phone reporting eight logical cores is not offering eight cores' worth
    // of simulation: every worker holds its own clone of the game data, the
    // thermal budget is a fraction of a desktop's, and the game itself is
    // running in the same tab. Two is the honest ceiling there — overridable
    // like everything else via the explicit thread setting + uncap.
    return isMobileMode() ? Math.min(cap, MOBILE_MAX_WORKERS) : cap;
}

/** Worker ceiling under mobile mode — memory and thermals, not core count */
const MOBILE_MAX_WORKERS = 2;

/**
 * How many workers one `runSimulation` will split itself across.
 *
 * A long run is chopped into chunks of hours and simulated in parallel; a short
 * one is a single worker, because splitting an hour four ways costs more in
 * startup than it saves. Callers that want to run several *simulations* at once
 * need this to know how much of the machine each one is already using — four
 * candidates at four workers apiece on a four-worker budget is sixteen workers
 * fighting over four cores, which is slower than doing them in turn.
 *
 * @param {number} hours - Simulated hours for one run
 * @returns {number} Workers that run will use
 */
export function plannedWorkerCount(hours) {
    const maxWorkers = getMaxWorkers();
    return hours >= MIN_HOURS_PER_WORKER * 2 ? Math.min(maxWorkers, Math.floor(hours / MIN_HOURS_PER_WORKER)) : 1;
}

/**
 * Get or create the worker Blob URL (created once, reused).
 * @returns {string}
 */
export function getWorkerURL() {
    if (!workerBlobURL) {
        const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
        workerBlobURL = URL.createObjectURL(blob);
    }
    return workerBlobURL;
}

/**
 * Build extra buffs from community buffs, MooPass, and guild combat buffs.
 * @param {Object} communityBuffs - { mooPass, comExp, comDrop }
 * @param {Array} [guildCombatBuffs] - Pre-computed guild buff objects for /action_types/combat
 * @returns {Array<Object>}
 */
export function buildExtraBuffs(communityBuffs, guildCombatBuffs) {
    const extraBuffs = [];

    if (communityBuffs?.mooPass) {
        extraBuffs.push({
            uniqueHrid: '/buff_uniques/experience_moo_pass_buff',
            typeHrid: '/buff_types/wisdom',
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0.05,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        });
    }

    if (communityBuffs?.comExp > 0) {
        extraBuffs.push({
            uniqueHrid: '/buff_uniques/experience_community_buff',
            typeHrid: '/buff_types/wisdom',
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0.005 * (communityBuffs.comExp - 1) + 0.2,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        });
    }

    if (communityBuffs?.comDrop > 0) {
        extraBuffs.push({
            uniqueHrid: '/buff_uniques/combat_community_buff',
            typeHrid: '/buff_types/combat_drop_quantity',
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0.005 * (communityBuffs.comDrop - 1) + 0.2,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        });
    }

    if (Array.isArray(guildCombatBuffs)) {
        extraBuffs.push(...guildCombatBuffs);
    }

    return extraBuffs;
}

/**
 * Whether two game-data payloads carry the same maps.
 *
 * Reference equality per map, not a deep compare: every payload is assembled
 * from the single `init_client_data` object (see `buildGameDataPayload`), so
 * identical map references mean identical data, and a reload replaces that
 * object wholesale - data-manager assigns a new `initClientData` - which shows
 * up here as a different reference on every map. The compare is fifteen pointer
 * checks, against a structured clone of tens of megabytes.
 *
 * @param {Object|null} a - Payload a worker was last given
 * @param {Object|null} b - Payload about to be sent
 * @returns {boolean} True when b can be left out of the message
 */
function sameGameData(a, b) {
    if (!a || !b) return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    return keysA.every((key) => a[key] === b[key]);
}

/**
 * A worker ready to run this chunk - reused when one is warm, built when not.
 * @param {Object|null} gameData - The chunk's game-data payload
 * @returns {{worker: Worker, gameData: Object|null}} Wrapper, removed from the idle list
 */
function acquireWorker(gameData) {
    const index = idleWorkers.findIndex((wrapper) => sameGameData(wrapper.gameData, gameData));
    if (index >= 0) return idleWorkers.splice(index, 1)[0];

    // Nothing warm holds this game data. Rather than reason about what a run
    // may have derived from the old data inside that worker, an idle one is
    // thrown away and a fresh worker built: the worst case is exactly the
    // previous behaviour, one new worker per chunk.
    const stale = idleWorkers.pop();
    if (stale) stale.worker.terminate();
    return { worker: new Worker(getWorkerURL()), gameData: null };
}

/**
 * Hand a finished worker back to the idle list.
 * @param {{worker: Worker, gameData: Object|null}} wrapper - Wrapper that just finished
 */
function releaseWorker(wrapper) {
    // Detach first: a late message from the run just finished must not reach
    // the handlers of the run that picks this worker up next.
    wrapper.worker.onmessage = null;
    wrapper.worker.onerror = null;

    if (idleWorkers.length >= MAX_IDLE_WORKERS) {
        wrapper.worker.terminate();
        return;
    }
    idleWorkers.push(wrapper);
    idleReaper.touch();
}

/**
 * Terminate every idle worker. Runs in flight are untouched.
 */
export function terminateIdleWorkers() {
    for (const wrapper of idleWorkers) {
        wrapper.worker.terminate();
    }
    idleWorkers = [];
    idleReaper.cancel();
}

/**
 * Run a single simulation chunk in a Worker.
 * @param {Object} message - Worker message payload
 * @param {Function} [onProgress] - Progress callback (0-100 for this chunk)
 * @returns {Promise<Object>} SimResult
 */
export function runWorkerChunk(message, onProgress) {
    return new Promise((resolve, reject) => {
        const wrapper = acquireWorker(message.gameData);
        const worker = wrapper.worker;
        activeWorkers.push(wrapper);
        pendingRejects.push(reject);

        const cleanup = () => {
            activeWorkers = activeWorkers.filter((w) => w !== wrapper);
            pendingRejects = pendingRejects.filter((r) => r !== reject);
        };

        worker.onmessage = (event) => {
            const msg = event.data;
            if (msg.taskId !== message.taskId) return;

            if (msg.type === 'progress') {
                if (onProgress) onProgress(msg.progress);
            } else if (msg.type === 'result') {
                cleanup();
                releaseWorker(wrapper);
                resolve(msg.simResult);
            } else if (msg.type === 'error') {
                // The worker caught this itself and is still healthy - the
                // per-run state lives on the simulator instance it just dropped
                cleanup();
                releaseWorker(wrapper);
                reject(new Error(msg.error));
            }
        };

        worker.onerror = (error) => {
            // An uncaught worker-level failure says nothing about what state the
            // worker is in. It does not go back in the pool.
            worker.terminate();
            cleanup();
            reject(new Error(error.message || 'Worker error'));
        };

        // A warm worker already holds these maps in its engine singleton, and
        // the game data is by far the largest thing in the message -
        // structuredClone copies all of it into the worker on every post.
        // Leaving it out is the whole point of keeping the worker.
        const outbound = wrapper.gameData ? { ...message, gameData: undefined } : message;
        if (!wrapper.gameData) wrapper.gameData = message.gameData || null;
        worker.postMessage(outbound);
    });
}

/**
 * Merge multiple SimResults into one by summing all additive counters.
 * @param {Array<Object>} results - Array of SimResult objects
 * @returns {Object} Merged SimResult
 */
function mergeSimResults(results) {
    if (results.length === 1) return results[0];

    const merged = structuredClone(results[0]);

    // Close chunk 0's still-open OOM window (later chunks are closed in the loop below)
    if (merged.playerRanOutOfManaTime) {
        for (const stat of Object.values(merged.playerRanOutOfManaTime)) {
            if (stat.isOutOfMana) {
                stat.totalTimeForOutOfMana += merged.simulatedTime - stat.startTimeForOutOfMana;
                stat.isOutOfMana = false;
            }
        }
    }

    for (let i = 1; i < results.length; i++) {
        const r = results[i];

        // Encounters
        merged.encounters += r.encounters;

        // A maximum merges as a maximum — summing or keeping chunk 0's value
        // would misreport the peak for any multi-worker run
        merged.maxEnrageStack = Math.max(merged.maxEnrageStack || 0, r.maxEnrageStack || 0);

        // Deaths (per unit hrid)
        for (const [hrid, count] of Object.entries(r.deaths)) {
            merged.deaths[hrid] = (merged.deaths[hrid] || 0) + count;
        }

        // Experience gained (per player → per skill)
        for (const [playerHrid, skills] of Object.entries(r.experienceGained)) {
            if (!merged.experienceGained[playerHrid]) {
                merged.experienceGained[playerHrid] = {};
            }
            for (const [skill, amount] of Object.entries(skills)) {
                merged.experienceGained[playerHrid][skill] = (merged.experienceGained[playerHrid][skill] || 0) + amount;
            }
        }

        // Consumables used (per player → per item)
        for (const [playerHrid, items] of Object.entries(r.consumablesUsed)) {
            if (!merged.consumablesUsed[playerHrid]) {
                merged.consumablesUsed[playerHrid] = {};
            }
            for (const [itemHrid, count] of Object.entries(items)) {
                merged.consumablesUsed[playerHrid][itemHrid] =
                    (merged.consumablesUsed[playerHrid][itemHrid] || 0) + count;
            }
        }

        // Mana used (per player → per ability)
        if (r.manaUsed) {
            if (!merged.manaUsed) merged.manaUsed = {};
            for (const [playerHrid, abilities] of Object.entries(r.manaUsed)) {
                if (!merged.manaUsed[playerHrid]) merged.manaUsed[playerHrid] = {};
                for (const [abilityHrid, amount] of Object.entries(abilities)) {
                    merged.manaUsed[playerHrid][abilityHrid] = (merged.manaUsed[playerHrid][abilityHrid] || 0) + amount;
                }
            }
        }

        // Hitpoints gained/spent (per unit → per source)
        for (const field of ['hitpointsGained', 'manapointsGained', 'hitpointsSpent']) {
            if (r[field]) {
                if (!merged[field]) merged[field] = {};
                for (const [unitHrid, sources] of Object.entries(r[field])) {
                    if (!merged[field][unitHrid]) merged[field][unitHrid] = {};
                    for (const [source, amount] of Object.entries(sources)) {
                        merged[field][unitHrid][source] = (merged[field][unitHrid][source] || 0) + amount;
                    }
                }
            }
        }

        // Attacks (per source → per target → per ability)
        if (r.attacks) {
            if (!merged.attacks) merged.attacks = {};
            for (const [sourceHrid, targets] of Object.entries(r.attacks)) {
                if (!merged.attacks[sourceHrid]) merged.attacks[sourceHrid] = {};
                for (const [targetHrid, abilities] of Object.entries(targets)) {
                    if (!merged.attacks[sourceHrid][targetHrid]) {
                        merged.attacks[sourceHrid][targetHrid] = {};
                    }
                    for (const [abilityName, stats] of Object.entries(abilities)) {
                        if (!merged.attacks[sourceHrid][targetHrid][abilityName]) {
                            merged.attacks[sourceHrid][targetHrid][abilityName] = {};
                        }
                        const mergedStats = merged.attacks[sourceHrid][targetHrid][abilityName];
                        // Keys are damage values or 'miss' (see SimResult.addAttack), not 'hit'
                        for (const [hitKey, count] of Object.entries(stats)) {
                            mergedStats[hitKey] = (mergedStats[hitKey] || 0) + count;
                        }
                    }
                }
            }
        }

        // Landed crits (per source, summed)
        if (r.crits) {
            if (!merged.crits) merged.crits = {};
            for (const [sourceHrid, count] of Object.entries(r.crits)) {
                merged.crits[sourceHrid] = (merged.crits[sourceHrid] || 0) + count;
            }
        }

        // Mana run out (OR across chunks — if any chunk went OOM, mark as true)
        if (r.playerRanOutOfMana) {
            if (!merged.playerRanOutOfMana) merged.playerRanOutOfMana = {};
            for (const [playerHrid, ranOut] of Object.entries(r.playerRanOutOfMana)) {
                merged.playerRanOutOfMana[playerHrid] = merged.playerRanOutOfMana[playerHrid] || ranOut;
            }
        }

        // Mana run out time (sum closed OOM windows; close any still-open window at chunk boundary)
        if (r.playerRanOutOfManaTime) {
            if (!merged.playerRanOutOfManaTime) merged.playerRanOutOfManaTime = {};
            for (const [playerHrid, stat] of Object.entries(r.playerRanOutOfManaTime)) {
                const openWindow = stat.isOutOfMana ? r.simulatedTime - stat.startTimeForOutOfMana : 0;
                const chunkTotal = stat.totalTimeForOutOfMana + openWindow;
                if (!merged.playerRanOutOfManaTime[playerHrid]) {
                    merged.playerRanOutOfManaTime[playerHrid] = {
                        isOutOfMana: false,
                        startTimeForOutOfMana: 0,
                        totalTimeForOutOfMana: 0,
                    };
                }
                merged.playerRanOutOfManaTime[playerHrid].totalTimeForOutOfMana += chunkTotal;
            }
        }

        // Debuff on level gap — constant per player, just take the value from any chunk
        if (r.debuffOnLevelGap) {
            if (!merged.debuffOnLevelGap) merged.debuffOnLevelGap = {};
            for (const [playerHrid, debuff] of Object.entries(r.debuffOnLevelGap)) {
                merged.debuffOnLevelGap[playerHrid] = debuff;
            }
        }

        // Warnings — the union, not the sum: every chunk of the same fight meets
        // the same unknown mechanic, and the reader wants it named once
        if (r.warnings?.length) {
            if (!merged.warnings) merged.warnings = [];
            for (const warning of r.warnings) {
                if (!merged.warnings.includes(warning)) merged.warnings.push(warning);
            }
        }

        // Wipe events — collect up to 20 across all chunks
        if (r.wipeEvents && r.wipeEvents.length > 0) {
            if (!merged.wipeEvents) merged.wipeEvents = [];
            for (const event of r.wipeEvents) {
                if (merged.wipeEvents.length < 20) merged.wipeEvents.push(event);
            }
        }

        // Dungeon stats
        if (r.isDungeon) {
            merged.dungeonsCompleted = (merged.dungeonsCompleted || 0) + (r.dungeonsCompleted || 0);
            merged.dungeonsFailed = (merged.dungeonsFailed || 0) + (r.dungeonsFailed || 0);
            merged.maxWaveReached = Math.max(merged.maxWaveReached || 0, r.maxWaveReached || 0);
            // Clean clear-time pairs are per-chunk; summing both parts keeps the
            // pooled average an interval-weighted mean across chunks. A chunk
            // boundary breaks a pair, as a session boundary does in the tracker.
            merged.dungeonCleanClearTimeTotal =
                (merged.dungeonCleanClearTimeTotal || 0) + (r.dungeonCleanClearTimeTotal || 0);
            merged.dungeonCleanClearCount = (merged.dungeonCleanClearCount || 0) + (r.dungeonCleanClearCount || 0);
        }

        // Simulated time
        merged.simulatedTime = (merged.simulatedTime || 0) + (r.simulatedTime || 0);

        // Total damage dealt per source
        if (r.totalDamageDealt) {
            if (!merged.totalDamageDealt) merged.totalDamageDealt = {};
            for (const [hrid, damage] of Object.entries(r.totalDamageDealt)) {
                merged.totalDamageDealt[hrid] = (merged.totalDamageDealt[hrid] || 0) + damage;
            }
        }

        // Time spent alive
        if (r.timeSpentAlive) {
            if (!merged.timeSpentAlive) merged.timeSpentAlive = [];
            for (const entry of r.timeSpentAlive) {
                const existing = merged.timeSpentAlive.find((e) => e.name === entry.name);
                if (existing) {
                    existing.timeSpentAlive += entry.timeSpentAlive;
                    existing.count += entry.count;
                } else {
                    merged.timeSpentAlive.push({ ...entry });
                }
            }
        }

        // Per-wave first-hit windup, summed the same way
        if (r.waveFirstHit) {
            if (!merged.waveFirstHit) merged.waveFirstHit = [];
            for (const entry of r.waveFirstHit) {
                const existing = merged.waveFirstHit.find((e) => e.name === entry.name);
                if (existing) {
                    existing.total += entry.total;
                    existing.count += entry.count;
                } else {
                    merged.waveFirstHit.push({ ...entry });
                }
            }
        }
    }

    return merged;
}

/**
 * Run a combat simulation, parallelized across multiple Workers when beneficial.
 * @param {Object} params
 * @param {Object} params.gameData - Game data maps from buildGameDataPayload()
 * @param {Array<Object>} params.playerDTOs - Player DTOs from buildAllPlayerDTOs()
 * @param {string} params.zoneHrid - Zone HRID
 * @param {number} params.difficultyTier - Difficulty tier (0+)
 * @param {number} params.hours - Hours to simulate
 * @param {Object} params.communityBuffs - { mooPass, comExp, comDrop }
 * @param {number} [params.seed] - RNG seed. Two runs sharing a seed draw the same
 *   random numbers, so comparing them measures the change instead of sampling
 *   noise. Omit for an independent random sample (the default).
 * @param {boolean} [params.isTaskFight] - Set only when this run stands in for
 *   fighting an active combat task's monster. It is what switches `taskDamage`
 *   on in the engine; left off (the default) task gear measures as inert, which
 *   is the truth for a generic zone sim.
 * @param {Function} [onProgress] - Called with (percent: 0-100)
 * @returns {Promise<Object>} Merged SimResult
 */
export async function runSimulation(params, onProgress, { preempt = true, workers = 0 } = {}) {
    const { gameData, playerDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed, isTaskFight } = params;

    // Guild buffs are not folded in here: the worker reads each player DTO's
    // own guildCombatBuffs, so party members keep their own guild's bonuses
    const extraBuffs = buildExtraBuffs(communityBuffs);
    const ONE_HOUR_NS = 3600 * 1e9;

    // A new run started from the UI replaces whatever was running — that is what
    // makes clicking Simulate twice do the obvious thing. An analysis running
    // its own batch must opt out: preempting here would have each of its
    // simulations kill the one before it, which is not a race so much as a
    // guarantee of failure.
    if (preempt) cancelSimulation();

    // Determine worker count. A caller running a batch of simulations pins this
    // to one: splitting each run across the whole budget makes every candidate
    // pay the worker startup and the game-data clone four times over, and
    // measured against a queue of one-worker runs it is 1.1× to 3.3× slower —
    // worst when the runs are short, never better at any length.
    const plannedWorkers = workers > 0 ? Math.max(1, Math.floor(workers)) : plannedWorkerCount(hours);

    // Split hours across workers. The chunks must sum to exactly `hours`:
    // handing out whole hours and rounding the leftover up gave a half-hour run
    // a full simulated hour, and every rate a caller derived by dividing by the
    // hours it asked for came out low by the same factor.
    const baseHours = Math.floor(hours / plannedWorkers);
    let leftover = hours - baseHours * plannedWorkers;

    const chunks = [];
    for (let i = 0; i < plannedWorkers; i++) {
        let chunkHours = baseHours;
        if (i < plannedWorkers - 1) {
            // Whole hours first, so the chunks stay as even as they can be...
            const extra = Math.min(1, Math.floor(leftover));
            chunkHours += extra;
            leftover -= extra;
        } else {
            // ...and whatever fraction is left rides on the last chunk.
            chunkHours += leftover;
            leftover = 0;
        }
        if (chunkHours > 0) chunks.push(chunkHours);
    }
    if (chunks.length === 0) chunks.push(hours);

    const workerCount = chunks.length;

    // Track per-worker progress
    const workerProgress = new Array(workerCount).fill(0);
    const reportProgress = () => {
        if (!onProgress) return;
        const totalPercent = Math.round(workerProgress.reduce((sum, p) => sum + p, 0) / workerCount);
        onProgress(totalPercent);
    };

    // Launch all workers in parallel
    const promises = chunks.map((chunkHours, i) => {
        const taskId = ++taskIdCounter;
        const message = {
            type: 'start_simulation',
            taskId,
            gameData,
            playerDTOs,
            zoneHrid,
            difficultyTier,
            simulationTimeLimit: chunkHours * ONE_HOUR_NS,
            extraBuffs,
            isTaskFight: Boolean(isTaskFight),
            // Each chunk needs its own stream or all four would replay the same
            // fights, but chunk N must match across compared runs — so the
            // per-chunk seed is derived from (seed, index), not randomized.
            seed: deriveSeed(seed, i),
        };

        return runWorkerChunk(message, (percent) => {
            workerProgress[i] = percent;
            reportProgress();
        });
    });

    const results = await Promise.all(promises);

    if (onProgress) onProgress(100);

    return mergeSimResults(results);
}

/**
 * Build labyrinth crate buff arrays from crate item HRIDs.
 * @param {string[]} crateHrids - Array of crate item HRIDs (e.g., ['/items/expert_coffee_crate'])
 * @param {Object} gameData - Game data containing labyrinthCrateDetailMap
 * @returns {Array<Object>} Buff objects compatible with zoneBuffs
 */
export function buildCrateBuffs(crateHrids, gameData) {
    if (!crateHrids || crateHrids.length === 0) return [];

    const crateMap = gameData.labyrinthCrateDetailMap;
    if (!crateMap) return [];

    let buffs = [];
    for (const hrid of crateHrids) {
        if (crateMap[hrid]) {
            buffs = buffs.concat(crateMap[hrid]);
        }
    }
    return buffs;
}

/**
 * Run a labyrinth simulation.
 * @param {Object} params
 * @param {Object} params.gameData - Game data maps from buildGameDataPayload()
 * @param {Array<Object>} params.playerDTOs - Player DTOs from buildAllPlayerDTOs()
 * @param {string} params.zoneHrid - Zone HRID (used for SimResult context; any combat zone works)
 * @param {string} params.monsterHrid - Labyrinth monster HRID
 * @param {number} params.roomLevel - Room level (scales monster stats)
 * @param {string[]} params.crates - Crate item HRIDs
 * @param {number} params.hours - Hours to simulate
 * @param {Object} params.communityBuffs - { mooPass, comExp, comDrop }
 * @param {number} [params.seed] - RNG seed shared by runs being compared; omit for
 *   an independent random sample (the default).
 * @param {boolean} [params.isTaskFight] - Whether taskDamage applies. Off by
 *   default, and normally correct off here: a labyrinth monster is not a task
 *   monster. Exposed so the lab panel can say otherwise.
 * @param {boolean} [params.fullAbilities] - Build the monster with its full
 *   ability kit. ON by default: a tier-0 subset monster drops its stun/shred/
 *   self-buff kit and the sim over-predicts clears. Pass false only for a
 *   deliberate tier-0 diagnostic.
 * @param {Function} [onProgress] - Called with (percent: 0-100)
 * @returns {Promise<Object>} SimResult with labyrinth fields
 */
export async function runLabyrinthSimulation(params, onProgress) {
    const {
        gameData,
        playerDTOs,
        zoneHrid,
        monsterHrid,
        roomLevel,
        crates,
        hours,
        precision,
        liveState,
        communityBuffs,
        labyrinthCombatBuffs,
        seed,
        isTaskFight,
        fullAbilities,
        zone,
    } = params;

    // Guild buffs are not folded in here: the worker reads each player DTO's
    // own guildCombatBuffs, so party members keep their own guild's bonuses
    const extraBuffs = [...buildExtraBuffs(communityBuffs), ...(labyrinthCombatBuffs || [])];
    const ONE_HOUR_NS = 3600 * 1e9;

    // Unlike runSimulation, labyrinth sims do NOT preempt other runs: each has
    // its own worker, and several background consumers run concurrently (tile
    // badge sims fire on every room switch while skip-recommendation searches
    // are in flight — cancelling here killed the other side's sim mid-run).
    // Explicit Stop buttons still cancel everything via cancelSimulation().
    const taskId = ++taskIdCounter;
    const message = {
        type: 'start_simulation',
        taskId,
        gameData,
        playerDTOs,
        zoneHrid: zone?.hrid || zoneHrid,
        difficultyTier: zone ? Number(zone.tier) || 0 : 0,
        simulationTimeLimit: hours * ONE_HOUR_NS,
        extraBuffs,
        isTaskFight: Boolean(isTaskFight),
        labyrinth: {
            monsterHrid,
            roomLevel,
            // An isolated fight against this one zone monster, at its zone
            // tier, with the player's consumables and zone buffs (see Labyrinth)
            ...(zone ? { zoneFight: true, difficultyTier: Number(zone.tier) || 0 } : {}),
            crates: crates || [],
            // Replays a fight in progress instead of starting each encounter
            // clean, for a conditional "will I clear from here" estimate
            liveState: liveState || null,
            // Full ability kit by default (see Monster): the tier-0 subset
            // drops the stun/shred/self-buff kit and over-predicts clears. The
            // calibration replay verified full-kit reads closer to reality, so
            // an omitted flag means on; only an explicit false opts out.
            fullAbilities: fullAbilities !== false,
        },
        // Time is the ceiling; precision is what usually ends the run
        precision: precision || null,
        seed: deriveSeed(seed, 0),
    };

    const result = await runWorkerChunk(message, onProgress);

    if (onProgress) onProgress(100);

    return result;
}

/** A few fights, not one: one may not exercise every ability in the rotation. */
const BLIND_PROBE_FIGHTS = 5;

/**
 * Run a short blind labyrinth fight and return the buffs the sim applied to the
 * monster on its own — fed the build + level, never the monster's live buffs.
 * Uses the same worker path as a normal sim (no engine on the main thread), with
 * capture turned on for the run.
 *
 * @param {Object} params - Same shape as `runLabyrinthSimulation` params
 * @returns {Promise<Array<{uniqueHrid,typeHrid,ratioBoost,flatBoost}>>}
 */
export async function runBlindBuffProbe(params) {
    const {
        gameData,
        playerDTOs,
        zoneHrid,
        monsterHrid,
        roomLevel,
        crates,
        communityBuffs,
        labyrinthCombatBuffs,
        zone,
    } = params;
    const extraBuffs = [...buildExtraBuffs(communityBuffs), ...(labyrinthCombatBuffs || [])];
    const taskId = ++taskIdCounter;
    const message = {
        type: 'start_simulation',
        taskId,
        gameData,
        playerDTOs,
        zoneHrid: zone?.hrid || zoneHrid,
        difficultyTier: zone ? Number(zone.tier) || 0 : 0,
        // Time is not the stopping rule here — a fixed handful of fights is
        simulationTimeLimit: 3600 * 1e9,
        extraBuffs,
        isTaskFight: false,
        captureBuffs: true,
        labyrinth: {
            monsterHrid,
            roomLevel,
            ...(zone ? { zoneFight: true, difficultyTier: Number(zone.tier) || 0 } : {}),
            crates: crates || [],
            liveState: null,
            // The full kit — self-buffs and debuff abilities are the whole point
            fullAbilities: true,
        },
        precision: { maxTrials: BLIND_PROBE_FIGHTS, minTrials: 1 },
        seed: deriveSeed(1, 0),
    };
    const result = await runWorkerChunk(message);
    return Array.isArray(result?.producedMonsterBuffs) ? result.producedMonsterBuffs : [];
}

/**
 * Run a minimal fight and return the sim player's resolved build at fight start
 * (persistent buffs folded, no transient combat buff) — for the monster-stat-
 * check "player build" diagnostic. Same worker path as a normal sim.
 *
 * With `playerCombatBuffs` the probe also returns a second build with those
 * buffs applied by the engine, so the panel can compare your live mid-fight
 * sheet against a sim player carrying the same effects.
 *
 * @param {Object} params - Same shape as `runLabyrinthSimulation` params, plus
 *   an optional `playerCombatBuffs` map in the engine's buff shape
 * @returns {Promise<{base: Object, buffed: Object|null}|null>} The player's
 *   `combatDetails` unbuffed and (when asked) buffed, or null
 */
export async function runPlayerStatProbe(params) {
    const {
        gameData,
        playerDTOs,
        zoneHrid,
        monsterHrid,
        roomLevel,
        crates,
        communityBuffs,
        labyrinthCombatBuffs,
        zone,
        playerCombatBuffs,
    } = params;
    const extraBuffs = [...buildExtraBuffs(communityBuffs), ...(labyrinthCombatBuffs || [])];
    const taskId = ++taskIdCounter;
    const message = {
        type: 'start_simulation',
        taskId,
        gameData,
        playerDTOs,
        zoneHrid: zone?.hrid || zoneHrid,
        difficultyTier: zone ? Number(zone.tier) || 0 : 0,
        simulationTimeLimit: 3600 * 1e9,
        extraBuffs,
        isTaskFight: false,
        capturePlayerDetails: true,
        playerCombatBuffs: playerCombatBuffs || null,
        labyrinth: {
            monsterHrid,
            roomLevel,
            ...(zone ? { zoneFight: true, difficultyTier: Number(zone.tier) || 0 } : {}),
            crates: crates || [],
            liveState: null,
            fullAbilities: true,
        },
        // One fight is enough — the build is snapshot at its start.
        precision: { maxTrials: 1, minTrials: 1 },
        seed: deriveSeed(1, 0),
    };
    const result = await runWorkerChunk(message);
    return result?.playerCombatDetails || null;
}

/**
 * Terminate all simulation workers and reject pending promises.
 *
 * Idle workers go too. Cancelling is what a Stop button, a character switch and
 * a feature teardown all call, and none of them should leave a thread holding a
 * copy of the game data behind; the next run builds a fresh worker.
 */
export function cancelSimulation() {
    for (const wrapper of activeWorkers) {
        wrapper.worker.terminate();
    }
    activeWorkers = [];
    terminateIdleWorkers();

    const rejects = pendingRejects.slice();
    pendingRejects = [];
    for (const reject of rejects) {
        reject(new Error('Cancelled'));
    }
}
