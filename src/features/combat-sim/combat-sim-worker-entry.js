/**
 * Combat Simulator Worker Entry
 *
 * This file is bundled into a string at build time by the workerBundlePlugin
 * and runs inside a Web Worker. It receives simulation parameters via
 * postMessage and returns results.
 */

import { buildPlayerExtraBuffs } from './engine/extra-buffs.js';
import { setGameData } from './engine/game-data.js';
import { setBuffCapture, getCapturedMonsterBuffs } from './engine/combat-unit.js';
import CombatSimulator, { setPlayerDetailsCapture, getCapturedPlayerDetails } from './engine/combat-simulator.js';
import Labyrinth from './engine/labyrinth.js';
import Player from './engine/player.js';
import { seedSimRng } from './engine/rng.js';
import Zone from './engine/zone.js';

onmessage = function (event) {
    const { type, taskId } = event.data;

    if (type !== 'start_simulation') return;

    try {
        const {
            gameData,
            playerDTOs,
            zoneHrid,
            difficultyTier,
            simulationTimeLimit,
            extraBuffs,
            labyrinth: labyrinthData,
            precision,
            seed,
            isTaskFight,
            captureBuffs,
            capturePlayerDetails,
            playerCombatBuffs,
        } = event.data;

        // Set game data for the engine singleton. A worker reused for a second
        // chunk is sent no game data at all (see the runner's worker pool): it
        // still holds the maps from its first message, and re-cloning tens of
        // megabytes into it per run is the cost the pool exists to avoid. The
        // runner only omits it when the maps are the same objects it already
        // sent this worker, so an absent payload never means stale data.
        if (gameData) setGameData(gameData);

        // Seed this worker's RNG streams. Runs compared against each other pass
        // the same seed so their shared random draws cancel out of the delta;
        // with no seed the engine stays on Math.random().
        seedSimRng(seed);

        // Create Zone (used as fallback even in labyrinth mode for SimResult constructor)
        const zone = new Zone(zoneHrid, difficultyTier);

        // Create Labyrinth if specified
        let labyrinth = null;
        if (labyrinthData) {
            labyrinth = new Labyrinth(
                labyrinthData.monsterHrid,
                labyrinthData.roomLevel,
                labyrinthData.crates || [],
                labyrinthData.liveState || null,
                // Raw, not coerced: labyrinth.js defaults an absent field ON
                // via `!== false`, and `=== true` here turned "not specified"
                // into the stripped tier-0 monster, inverting that default.
                labyrinthData.fullAbilities,
                { zoneFight: labyrinthData.zoneFight === true, difficultyTier: labyrinthData.difficultyTier }
            );
        }

        // Create Players
        const players = playerDTOs.map((dto) => {
            const cloned = structuredClone(dto);
            // The labyrinth allows no food or drink; an isolated zone fight does
            if (labyrinth && !labyrinth.zoneFight) {
                cloned.food = cloned.food.map(() => null);
                cloned.drinks = cloned.drinks.map(() => null);
            }
            const player = Player.createFromDTO(cloned);
            // Labyrinth: crate buffs go to zoneBuffs; a zone fight (isolated or
            // not) uses the zone's own buffs
            player.zoneBuffs = labyrinth && !labyrinth.zoneFight ? labyrinth.buffs : zone.buffs;
            // Guild and achievement buffs come from each player's own DTO — the
            // shared extraBuffs used to carry player 1's, handing their guild's
            // bonuses to every teammate in a party sim
            player.extraBuffs = buildPlayerExtraBuffs(extraBuffs, cloned);
            return player;
        });

        // Create simulator with progress callback
        const combatSimulator = new CombatSimulator(
            players,
            zone,
            (progressData) => {
                postMessage({
                    type: 'progress',
                    taskId,
                    progress: Math.round(progressData.progress * 100),
                });
            },
            labyrinth,
            // Absent (every caller that has not opted in) this is false, and
            // taskDamage sits out the run
            Boolean(isTaskFight)
        );

        // The blind-buff probe turns on capture around the run and reads back the
        // buffs the engine applied to the monster on its own (for the
        // monster-stat-check "does the sim even produce these effects" diagnostic).
        if (captureBuffs) setBuffCapture(true);
        // With a fold map the player-build capture also snapshots the player
        // carrying your live combat buffs, so the panel can compare buffed
        // against buffed instead of showing every self-buff as a gap.
        if (capturePlayerDetails) setPlayerDetailsCapture(true, playerCombatBuffs || null);

        // Run simulation. Capture comes off in a `finally`: a run that throws
        // still posts an `error` and the runner treats that worker as healthy
        // and pools it (see runWorkerChunk), so a capture flag left on is
        // module-level state surviving into somebody else's run — an unbounded
        // buff sink and a build snapshot taken on every later run of the
        // session. These are the only engine globals not reset per message.
        let simResult;
        try {
            simResult = combatSimulator.simulate(simulationTimeLimit, precision);

            if (captureBuffs) {
                simResult.producedMonsterBuffs = getCapturedMonsterBuffs();
            }
            if (capturePlayerDetails) {
                simResult.playerCombatDetails = getCapturedPlayerDetails();
            }
        } finally {
            if (captureBuffs) setBuffCapture(false);
            if (capturePlayerDetails) setPlayerDetailsCapture(false);
        }

        postMessage({
            type: 'result',
            taskId,
            simResult,
        });
    } catch (error) {
        postMessage({
            type: 'error',
            taskId,
            error: error.message || String(error),
        });
    }
};
