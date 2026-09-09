/**
 * Enhancement Calculator Worker Manager
 * Manages a worker pool for parallel enhancement calculations
 */

import WorkerPool, { createIdlePoolReaper } from './worker-pool.js';
import { BASE_SUCCESS_RATES, BLESSED_TEA_BASE_CHANCE, buildEnhancementMarkov } from './enhancement-calculator.js';
import { MIN_ACTION_TIME_SECONDS } from './profit-constants.js';
import { createMatrixMath } from './matrix-inverse.js';

// Worker pool instance
let workerPool = null;
const idleReaper = createIdlePoolReaper(
    () => terminateWorkerPool(),
    undefined,
    () => Boolean(workerPool) && (workerPool.getStats().busyWorkers > 0 || workerPool.getStats().queuedTasks > 0)
);

// Worker script as inline string — this is the sole source of the worker code.
// The chain itself is NOT written here: a blob worker cannot import a module, so the real
// buildEnhancementMarkov is serialised in below. A hand-copied chain in this string is exactly
// how the worker drifted from the calculator and lost the success-chance clamp.
const WORKER_SCRIPT = `
// The matrix helper the chain needs, serialised in the same way the chain
// itself is — this used to importScripts ~600 KB of unminified math.js per
// worker for one 20x20 inverse.
const math = (${createMatrixMath.toString()})();

// Cache for enhancement calculation results
const calculationCache = new Map();

const BASE_SUCCESS_RATES = ${JSON.stringify(BASE_SUCCESS_RATES)};
const DEFAULT_BLESSED_TEA_CHANCE = ${BLESSED_TEA_BASE_CHANCE};
// The game's floor on an action's duration. Serialised in for the same reason the base rates
// are: the worker cannot import it, and a hand-written copy of the formula that omits it is
// exactly how this script drifted from the calculator before.
const MIN_ACTION_TIME_SECONDS = ${MIN_ACTION_TIME_SECONDS};
const buildEnhancementMarkov = ${buildEnhancementMarkov.toString()};

function getCacheKey(params) {
    const {enhancingLevel,toolBonus,itemLevel,targetLevel,protectFrom,blessedTea,guzzlingBonus,blessedTeaBonus,speedBonus} = params;
    return \`\${enhancingLevel}|\${toolBonus}|\${itemLevel}|\${targetLevel}|\${protectFrom}|\${blessedTea}|\${guzzlingBonus}|\${blessedTeaBonus}|\${speedBonus}\`;
}

function calculateSuccessMultiplier(params) {
    const { enhancingLevel, toolBonus, itemLevel } = params;
    let totalBonus;
    if (enhancingLevel >= itemLevel) {
        const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
        totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
    } else {
        totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
    }
    return totalBonus;
}

function calculateEnhancement(params) {
    const {enhancingLevel,toolBonus,speedBonus=0,itemLevel,targetLevel,protectFrom=0,blessedTea=false,guzzlingBonus=1.0,blessedTeaBonus=DEFAULT_BLESSED_TEA_CHANCE} = params;

    if (targetLevel < 1 || targetLevel > 20) throw new Error('Target level must be between 1 and 20');
    if (protectFrom < 0 || protectFrom > targetLevel) throw new Error('Protection level must be between 0 and target level');

    const successMultiplier = calculateSuccessMultiplier({enhancingLevel,toolBonus,itemLevel});
    const markov = buildEnhancementMarkov(math, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        successMultiplier,
        targetLevel,
        protectFrom,
        blessedTea,
        guzzlingBonus,
        blessedTeaBonus,
    });

    const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));
    const I = math.identity(targetLevel);
    const M = math.inv(math.subtract(I, Q));

    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        attempts += M.get([0, i]);
    }

    let protects = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            const timesAtLevel = M.get([0, i]);
            const failureChance = markov.get([i, i - 1]);
            protects += timesAtLevel * failureChance;
        }
    }

    const baseActionTime = 12;
    let speedMultiplier;
    if (enhancingLevel > itemLevel) {
        speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
    } else {
        speedMultiplier = 1 + speedBonus / 100;
    }

    const perActionTime = Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
    const totalTime = perActionTime * attempts;

    return {
        attempts,
        attemptsRounded: Math.round(attempts),
        protectionCount: protects,
        perActionTime,
        totalTime,
        successMultiplier,
        successRates: BASE_SUCCESS_RATES.slice(0, targetLevel).map((base, i) => ({
            level: i + 1,
            baseRate: base,
            actualRate: Math.min(100, base * successMultiplier)
        }))
    };
}

self.onmessage = function (e) {
    const { taskId, data } = e.data;
    try {
        const { action, params } = data;
        if (action === 'calculate') {
            const cacheKey = getCacheKey(params);
            let result = calculationCache.get(cacheKey);
            if (!result) {
                result = calculateEnhancement(params);
                calculationCache.set(cacheKey, result);
                if (calculationCache.size > 1000) {
                    const firstKey = calculationCache.keys().next().value;
                    calculationCache.delete(firstKey);
                }
            }
            self.postMessage({taskId,result});
        } else if (action === 'clearCache') {
            calculationCache.clear();
            self.postMessage({taskId,result: { success: true, message: 'Cache cleared' }});
        } else {
            throw new Error(\`Unknown action: \${action}\`);
        }
    } catch (error) {
        self.postMessage({taskId,error: error.message || String(error)});
    }
};
`;

/**
 * Get or create the worker pool instance
 */
async function getWorkerPool() {
    idleReaper.touch();

    if (workerPool) {
        return workerPool;
    }

    try {
        // Create worker blob from inline script
        const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });

        // Initialize worker pool with 2-4 workers
        workerPool = new WorkerPool(blob);
        await workerPool.initialize();

        return workerPool;
    } catch (error) {
        throw error;
    }
}

/**
 * Calculate enhancement path using worker pool
 * @param {Object} params - Enhancement parameters
 * @returns {Promise<Object>} Enhancement calculation results
 */
export async function calculateEnhancementAsync(params) {
    const pool = await getWorkerPool();

    return pool.execute({
        action: 'calculate',
        params,
    });
}

/**
 * Calculate multiple enhancements in parallel
 * @param {Array<Object>} paramsArray - Array of enhancement parameters
 * @returns {Promise<Array<Object>>} Array of enhancement results
 */
export async function calculateEnhancementBatch(paramsArray) {
    const pool = await getWorkerPool();

    const tasks = paramsArray.map((params) => ({
        action: 'calculate',
        params,
    }));

    return pool.executeAll(tasks);
}

/**
 * Clear the worker cache
 */
export async function clearEnhancementCache() {
    if (!workerPool) {
        return;
    }

    const pool = await getWorkerPool();
    return pool.execute({
        action: 'clearCache',
    });
}

/**
 * Get worker pool statistics
 */
export function getWorkerStats() {
    return workerPool ? workerPool.getStats() : null;
}

/**
 * Terminate the worker pool
 */
export function terminateWorkerPool() {
    idleReaper.cancel();
    if (workerPool) {
        workerPool.terminate();
        workerPool = null;
    }
}
