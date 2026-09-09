/**
 * Multi-Worker Entry for All-Zones Simulation
 *
 * This file is bundled into a string and runs inside a Web Worker.
 * It receives all zones to simulate, creates a pool of child simulation workers,
 * and processes zones via a task queue. Child workers are spawned from a Blob URL
 * created from the simulation worker script passed in the init message.
 *
 * This matches Shykai's architecture: worker-spawned workers get different
 * CPU scheduling from the browser than main-thread-spawned workers.
 *
 * When useEarlyExit is true, only T0 is seeded per zone initially. After each tier
 * completes, a zone_tier_result message is sent to the main thread. The main thread
 * compares XP/hr and profit/hr and responds with zone_tier_decision { skip }. If skip
 * is false, the next tier is enqueued; if true, remaining tiers for that zone are skipped.
 *
 * Two things keep a sweep from stalling:
 *
 * - A pool slot does not retire while work can still arrive. With early exit the
 *   queue holds only the lowest tiers at first; the higher ones are pushed later,
 *   after the main thread's go/skip answer. A slot that left the moment the queue
 *   was momentarily empty never came back, and the last slot standing ground every
 *   remaining tier of every zone one at a time — the "94%, a few seconds left" that
 *   sat there for minutes.
 * - A child that goes quiet is given up on. A sim worker the browser kills for
 *   memory posts neither result nor error, and a slot awaiting it would wait for
 *   ever; after STALL_MS without a message the child is terminated and its zone
 *   recorded as failed (null), and the sweep carries on.
 *
 * Children are pooled, not built per zone/tier. The game data is by far the
 * largest thing in a child's start message, and `postMessage` structured-clones
 * all of it - tens of megabytes of item/action/monster maps - into the child on
 * every send. A sweep of thirty-six zone/tiers on four slots used to pay that
 * thirty-six times over; a child kept between tasks already holds the maps in
 * its engine singleton, so every task after a slot's first sends
 * `gameData: undefined` and the sweep pays the clone once per slot. This
 * mirrors the idle pool `combat-sim-runner.js` keeps on the main thread, and
 * cannot share it: a `Worker` handle does not cross a thread boundary.
 */

/** Silence from a child sim worker before it is presumed dead, in ms */
const STALL_MS = 120_000;

let simWorkerBlobURL = null;
let taskIdCounter = 0;

// Pending early-exit decisions: zoneHrid → resolve function
const pendingDecisions = new Map();

onmessage = async function (event) {
    const { type } = event.data;

    if (type === 'start_all_zones') {
        const { workerScript, gameData, playerDTOs, zones, simulationTimeLimit, extraBuffs, maxWorkers, useEarlyExit } =
            event.data;

        // Create Blob URL for simulation workers from the bundled script string
        const blob = new Blob([workerScript], { type: 'application/javascript' });
        simWorkerBlobURL = URL.createObjectURL(blob);
        const workerURL = simWorkerBlobURL;

        const results = new Array(zones.length);

        // Per-zone progress tracking
        const zoneProgress = new Array(zones.length).fill(0);
        const reportProgress = () => {
            const total = zoneProgress.reduce((sum, p) => sum + p, 0);
            postMessage({ type: 'progress', progress: total / zones.length });
        };

        // zoneInfoMap groups tiers by zone for early exit tracking
        const zoneInfoMap = new Map(); // zoneHrid → { tiers: [{tier, index}], nextIdx }

        // Build initial task queue
        let taskQueue;
        if (useEarlyExit) {
            // Group zones by hrid, sort tiers ascending within each group
            for (let i = 0; i < zones.length; i++) {
                const { zoneHrid, difficultyTier } = zones[i];
                if (!zoneInfoMap.has(zoneHrid)) {
                    zoneInfoMap.set(zoneHrid, { tiers: [], nextIdx: 0 });
                }
                zoneInfoMap.get(zoneHrid).tiers.push({ tier: difficultyTier, index: i });
            }
            for (const info of zoneInfoMap.values()) {
                info.tiers.sort((a, b) => a.tier - b.tier);
            }

            // Seed only the first (lowest) tier per zone
            taskQueue = [];
            for (const [zoneHrid, info] of zoneInfoMap) {
                const first = info.tiers[0];
                taskQueue.push({ zoneHrid, difficultyTier: first.tier, index: first.index });
                info.nextIdx = 1;
            }
        } else {
            taskQueue = [...zones.map((zone, index) => ({ ...zone, index }))];
        }

        const poolSize = Math.min(maxWorkers, taskQueue.length);

        /**
         * Children with nothing to run, each already holding a clone of this
         * sweep's game data. Capped at the slot count - a fifth warm child is a
         * fifth copy of the maps that no slot could ever pick up.
         */
        let idleChildren = [];

        /**
         * A child ready to run a task - a warm one when there is one, a fresh
         * one when there is not.
         * @returns {{worker: Worker, hasData: boolean}} Child, off the idle list
         */
        const acquireChild = () => idleChildren.pop() || { worker: new Worker(workerURL), hasData: false };

        /**
         * Hand a finished child back to the idle list.
         * @param {{worker: Worker, hasData: boolean}} child - Child that just finished
         */
        const releaseChild = (child) => {
            // Detach first: a late message from the task just finished must not
            // reach the handlers of the task that picks this child up next.
            child.worker.onmessage = null;
            child.worker.onerror = null;
            if (idleChildren.length >= poolSize) {
                child.worker.terminate();
                return;
            }
            idleChildren.push(child);
        };

        /** Terminate every warm child. Tasks in flight are untouched. */
        const terminateIdleChildren = () => {
            for (const child of idleChildren) child.worker.terminate();
            idleChildren = [];
        };

        // Tasks in flight — running, or awaiting the main thread's go/skip — which
        // may still push more tasks. Idle slots wait on `wake` rather than leaving
        // while this is above zero.
        let inFlight = 0;
        let wakeWaiters = [];
        const wake = () => {
            const waiters = wakeWaiters;
            wakeWaiters = [];
            for (const resolve of waiters) resolve();
        };
        const waitForWake = () => new Promise((resolve) => wakeWaiters.push(resolve));
        const enqueue = (task) => {
            taskQueue.push(task);
            wake();
        };

        // With early exit, a zone whose tier failed (or was skipped) has its
        // remaining tiers written off as null and counted as done, so the bar
        // reaches 100 and the chain ends cleanly
        const retireZone = (zoneInfo) => {
            for (let i = zoneInfo.nextIdx; i < zoneInfo.tiers.length; i++) {
                results[zoneInfo.tiers[i].index] = null;
                zoneProgress[zoneInfo.tiers[i].index] = 100;
            }
            zoneInfo.nextIdx = zoneInfo.tiers.length;
            reportProgress();
        };

        // Run one zone/tier on a pooled child worker; null when it fails or stalls
        const runTask = (task) => {
            const taskId = ++taskIdCounter;
            return new Promise((resolve, reject) => {
                const child = acquireChild();
                const worker = child.worker;
                let stallTimer = null;
                /**
                 * Finish the task and decide what becomes of the child.
                 * @param {Function} fn - resolve or reject
                 * @param {*} value - Result or error
                 * @param {boolean} healthy - Whether the child may be reused
                 */
                const settle = (fn, value, healthy) => {
                    clearTimeout(stallTimer);
                    // A child that answered - with a result, or with an error it
                    // caught itself - is still healthy: the per-run state lives
                    // on the simulator instance it just dropped. A child that
                    // stalled or failed at the worker level says nothing about
                    // what state it is in, so it is terminated, not pooled.
                    if (healthy) releaseChild(child);
                    else worker.terminate();
                    fn(value);
                };
                const armStall = () => {
                    clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        settle(
                            reject,
                            new Error(
                                `no word from the sim worker for ${Math.round(STALL_MS / 1000)}s — presumed dead`
                            ),
                            false
                        );
                    }, STALL_MS);
                };

                worker.onmessage = (e) => {
                    const msg = e.data;
                    if (msg.taskId !== taskId) return;
                    armStall();

                    if (msg.type === 'progress') {
                        zoneProgress[task.index] = msg.progress;
                        reportProgress();
                    } else if (msg.type === 'result') {
                        settle(resolve, msg.simResult, true);
                    } else if (msg.type === 'error') {
                        settle(reject, new Error(msg.error), true);
                    }
                };

                worker.onerror = (error) => {
                    settle(reject, new Error(error.message || 'Worker error'), false);
                };

                armStall();
                worker.postMessage({
                    type: 'start_simulation',
                    taskId,
                    // A warm child already holds these maps in its engine
                    // singleton, and cloning them again is the cost this pool
                    // exists to avoid. `hasData` is a plain flag, not a compare:
                    // one sweep hands one game-data object to every child it has.
                    gameData: child.hasData ? undefined : gameData,
                    playerDTOs,
                    zoneHrid: task.zoneHrid,
                    difficultyTier: task.difficultyTier,
                    simulationTimeLimit,
                    extraBuffs,
                    // An all-zones sweep is a survey of generic fights,
                    // never one task's monster — so taskDamage stays off
                    // and task gear does not inflate the zone rankings
                    isTaskFight: false,
                });
                child.hasData = true;
            });
        };

        // Each pool slot takes tasks until the queue is empty AND nothing in
        // flight can add to it
        const processQueue = async () => {
            for (;;) {
                if (taskQueue.length === 0) {
                    if (inFlight === 0) return;
                    await waitForWake();
                    continue;
                }
                const task = taskQueue.shift();
                if (!task) continue;
                inFlight++;

                try {
                    let simResult = null;
                    try {
                        simResult = await runTask(task);
                    } catch (error) {
                        console.error(`[MultiWorker] Zone ${task.zoneHrid} T${task.difficultyTier} failed:`, error);
                    }

                    results[task.index] = simResult;
                    zoneProgress[task.index] = 100;
                    reportProgress();

                    if (!useEarlyExit) continue;
                    const zoneInfo = zoneInfoMap.get(task.zoneHrid);
                    if (!zoneInfo || zoneInfo.nextIdx >= zoneInfo.tiers.length) continue;

                    if (!simResult) {
                        // Nothing to compare the next tier against: the zone is done
                        retireZone(zoneInfo);
                        continue;
                    }

                    // Early exit: send tier result to main thread and await go/skip decision
                    postMessage({
                        type: 'zone_tier_result',
                        zoneHrid: task.zoneHrid,
                        tier: task.difficultyTier,
                        index: task.index,
                        simResult,
                    });
                    // A decision that never arrives — the panel closed, the
                    // main thread threw mid-comparison — used to hold this
                    // chain for ever, and with a worker pool one held chain
                    // keeps `inFlight` above zero so the whole sweep never
                    // finishes. Past the stall window, carry on as if told to.
                    const skip = await new Promise((resolve) => {
                        let timer = null;
                        const settle = (value) => {
                            if (timer !== null) clearTimeout(timer);
                            if (pendingDecisions.get(task.zoneHrid) === settle) {
                                pendingDecisions.delete(task.zoneHrid);
                            }
                            resolve(value);
                        };
                        timer = setTimeout(() => {
                            console.warn(
                                `[MultiWorker] No tier decision for ${task.zoneHrid} in ` +
                                    `${Math.round(STALL_MS / 1000)}s — continuing to the next tier`
                            );
                            settle(false);
                        }, STALL_MS);
                        pendingDecisions.set(task.zoneHrid, settle);
                    });

                    if (skip) {
                        retireZone(zoneInfo);
                    } else {
                        // Enqueue the next tier
                        const next = zoneInfo.tiers[zoneInfo.nextIdx];
                        zoneInfo.nextIdx++;
                        enqueue({ zoneHrid: task.zoneHrid, difficultyTier: next.tier, index: next.index });
                    }
                } finally {
                    inFlight--;
                    // Let idle slots re-check: either there is new work, or the
                    // last chain just ended and they can retire
                    wake();
                }
            }
        };

        try {
            await Promise.all(
                Array(poolSize)
                    .fill()
                    .map(() => processQueue())
            );
            postMessage({ type: 'all_zones_result', results });
        } catch (error) {
            postMessage({ type: 'error', error: error.message || String(error) });
        }

        // Clean up. The warm children go first: the main thread terminates this
        // coordinator on the result message, which takes its children with it,
        // but until it does each one is holding a copy of the game data.
        terminateIdleChildren();
        URL.revokeObjectURL(simWorkerBlobURL);
        simWorkerBlobURL = null;
    } else if (type === 'zone_tier_decision') {
        // Main thread responded to an early-exit zone_tier_result
        const { zoneHrid, skip } = event.data;
        const resolve = pendingDecisions.get(zoneHrid);
        if (resolve) {
            pendingDecisions.delete(zoneHrid);
            resolve(skip);
        }
    }
};
