// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { random, syncEncounterRng } from './rng.js';
import { hasConverged, isStoppingRule } from './wilson.js';

/** How far apart the decision checkpoints sit — each is 1.5x the last */
const STOP_CHECK_GROWTH = 1.5;
import CombatUtilities from './combat-utilities.js';
import AutoAttackEvent from './events/auto-attack-event.js';
import DamageOverTimeEvent from './events/damage-over-time-event.js';
import CheckBuffExpirationEvent from './events/check-buff-expiration-event.js';
import CombatStartEvent from './events/combat-start-event.js';
import ConsumableTickEvent from './events/consumable-tick-event.js';
import CooldownReadyEvent from './events/cooldown-ready-event.js';
import EnemyRespawnEvent from './events/enemy-respawn-event.js';
import EventQueue from './events/event-queue.js';
import PlayerRespawnEvent from './events/player-respawn-event.js';
import RegenTickEvent from './events/regen-tick-event.js';
import StunExpirationEvent from './events/stun-expiration-event.js';
import BlindExpirationEvent from './events/blind-expiration-event.js';
import SilenceExpirationEvent from './events/silence-expiration-event.js';
import CurseExpirationEvent from './events/curse-expiration-event.js';
import WeakenExpirationEvent from './events/weaken-expiration-event.js';
import FuryExpirationEvent from './events/fury-expiration-event.js';
import EnrageTickEvent from './events/enrage-tick-event.js';
import SimResult from './sim-result.js';
import { getSimWarnings, recordUnknown, resetSimWarnings } from './sim-warnings.js';
import AbilityCastEndEvent from './events/ability-cast-end-event.js';
import AwaitCooldownEvent from './events/await-cooldown-event.js';
import Monster from './monster.js';
import Ability from './ability.js';

// Player-build capture. Off by default and behind a flag so the normal sim path
// pays nothing; the monster-stat-check "player build" diagnostic turns it on to
// read the sim player's resolved stats at the one faithful moment — the first
// combat start, after generatePermanentBuffs() + reset(0) have folded in the
// persistent buffs (teas/community/guild/house) and before any transient combat
// buff accumulates.
let CAPTURE_PLAYER_DETAILS = false;
let CAPTURE_PLAYER_FOLD_BUFFS = null;
let capturedPlayerDetails = null;
/**
 * Start (fresh) or stop capturing the sim player build.
 * @param {boolean} on - Whether to capture
 * @param {Object|null} [foldBuffs] - Per-type TARGET totals, in the engine's
 *   buff shape keyed by a synthetic unique hrid: what the live sheet carries of
 *   each buff type. The snapshot applies only the difference over what the
 *   player already holds (see {@link snapshotPlayerBuild}), so the sim column
 *   carries the same Toughness/Precision/evasion effects your live sheet does
 *   and every stat group compares like for like — without counting a persistent
 *   buff twice.
 */
export function setPlayerDetailsCapture(on, foldBuffs = null) {
    CAPTURE_PLAYER_DETAILS = Boolean(on);
    CAPTURE_PLAYER_FOLD_BUFFS = on && foldBuffs && Object.keys(foldBuffs).length ? foldBuffs : null;
    capturedPlayerDetails = null;
}
/**
 * @returns {{base: Object, buffed: Object|null}|null} The sim player's resolved
 *   combatDetails at fight start, unbuffed and (when fold buffs were supplied)
 *   with them applied.
 */
export function getCapturedPlayerDetails() {
    return capturedPlayerDetails;
}

/**
 * Snapshot a player's resolved build, and — with fold buffs supplied — a second
 * copy with those buffs applied the way the engine applies any buff: written
 * into `combatBuffs`, then `updateCombatDetails()`. That is the whole point of
 * doing it here rather than post-hoc on the main thread; every stat the engine
 * derives (armour, resistances, evasion, accuracy, max hit, max HP) picks the
 * buffs up by the engine's own formula rather than a reimplementation of it.
 *
 * The player is put back as it was afterwards, so the probe fight this runs
 * inside is unchanged. The compared stats are all plain assignments in
 * `updateCombatDetails`, so the extra passes cannot accumulate into them.
 *
 * @param {Object} player - The sim player
 * @returns {{base: Object, buffed: Object|null}}
 */
function snapshotPlayerBuild(player) {
    const base = structuredClone(player.combatDetails);
    if (!CAPTURE_PLAYER_FOLD_BUFFS) return { base, buffed: null };
    const saved = player.combatBuffs;

    // The fold entries are TARGETS: the total ratio/flat boost of each buff type
    // the live sheet carries. The player at this point already holds its
    // permanent buffs (guild, community, house, achievements — `clearBuffs`
    // seeds them), so adding the live totals on top counted every persistent
    // buff twice (max HP +1%, max hit +3% on a live check). Applied as the
    // difference between the target and what the player already has per type,
    // nothing is double-counted and no fight-start map is needed: a persistent
    // buff comes out at zero delta, a transient one at its full strength.
    const held = new Map();
    for (const buff of Object.values(saved || {})) {
        if (!buff?.typeHrid) continue;
        const entry = held.get(buff.typeHrid) || { ratioBoost: 0, flatBoost: 0 };
        entry.ratioBoost += Number(buff.ratioBoost) || 0;
        entry.flatBoost += Number(buff.flatBoost) || 0;
        held.set(buff.typeHrid, entry);
    }
    const applied = {};
    const deltas = {};
    for (const [uniqueHrid, target] of Object.entries(CAPTURE_PLAYER_FOLD_BUFFS)) {
        const have = held.get(target.typeHrid) || { ratioBoost: 0, flatBoost: 0 };
        const ratioBoost = (Number(target.ratioBoost) || 0) - have.ratioBoost;
        const flatBoost = (Number(target.flatBoost) || 0) - have.flatBoost;
        deltas[target.typeHrid] = { ratioBoost, flatBoost, held: have };
        if (Math.abs(ratioBoost) < 1e-9 && Math.abs(flatBoost) < 1e-9) continue;
        applied[uniqueHrid] = { ...target, ratioBoost, flatBoost, ratioBoostLevelBonus: 0, flatBoostLevelBonus: 0 };
    }

    player.combatBuffs = { ...saved, ...applied };
    player.updateCombatDetails();
    const buffed = structuredClone(player.combatDetails);
    player.combatBuffs = saved;
    player.updateCombatDetails();
    return { base, buffed, deltas };
}

const ONE_SECOND = 1e9;
const HOT_TICK_INTERVAL = 5 * ONE_SECOND;
const DOT_TICK_INTERVAL = 3 * ONE_SECOND;
const REGEN_TICK_INTERVAL = 10 * ONE_SECOND;
const ENEMY_RESPAWN_INTERVAL = 3 * ONE_SECOND;
const PLAYER_RESPAWN_INTERVAL = 150 * ONE_SECOND;
const RESTART_INTERVAL = 3 * ONE_SECOND;
const ENRAGE_TICK_INTERVAL = 60 * ONE_SECOND;

class CombatSimulator {
    /**
     * @param {Array} players
     * @param {Object} zone
     * @param {Function} [onProgress] - Optional progress callback receiving { zone, difficultyTier, progress }
     * @param {Labyrinth} [labyrinth] - Optional labyrinth encounter manager (replaces zone encounter logic)
     * @param {boolean} [isTaskFight] - Whether this run stands in for fighting an
     *   active combat task's monster. Only then does `taskDamage` pay, so only
     *   then does the engine apply it (see engine/combat-utilities.js). Default
     *   false: a zone sim, an all-zones sweep, and every upgrade-advisor ranking
     *   are generic fights, and pricing a task badge as if they were is what
     *   floated task gear to the top of the advisor.
     */
    constructor(players, zone, onProgress, labyrinth, isTaskFight = false) {
        this.players = players;
        this.zone = zone;
        this.labyrinth = labyrinth || null;
        this.isTaskFight = Boolean(isTaskFight);
        this.onProgress = onProgress;
        this.eventQueue = new EventQueue();
        this.simResult = new SimResult(zone, players.length);
        // The result times a wave's first hit against the clock; only the
        // simulator holds it
        this.simResult.clock = () => this.simulationTime;
        this.allPlayersDead = false;
        this.encounterIndex = 0;
        this.stopRule = null;
        this.converged = false;

        this.wipeLogs = {
            buffer: new Array(200),
            index: 0,
            count: 0,
            maxSize: 200,
        };
    }

    addToWipeLogs(logEntry) {
        const { buffer, maxSize } = this.wipeLogs;

        buffer[this.wipeLogs.index] = logEntry;
        this.wipeLogs.index = (this.wipeLogs.index + 1) % maxSize;
        this.wipeLogs.count = Math.min(this.wipeLogs.count + 1, maxSize);
    }

    logAndResetWipeLogs() {
        const logs = this.getOrderedWipeLogs();

        logs.forEach((log) => {
            if (log.error) {
                console.log(log.error);
            }
        });

        this.wipeLogs.index = 0;
        this.wipeLogs.count = 0;
    }

    buildCombatLog(source, ability, target, damageDone) {
        try {
            const sourceHrid = source?.hrid || 'UNKNOWN_SOURCE';
            const targetHrid = target?.hrid || 'UNKNOWN_TARGET';

            const afterHp = target?.combatDetails?.currentHitpoints || 0;
            const beforeHp = Math.max(0, afterHp + damageDone);

            const playersHp = this.players.map((p) => ({
                hrid: p.hrid || 'UNKNOWN_PLAYER',
                current: p.combatDetails?.currentHitpoints ?? 0,
                max: p.combatDetails?.maxHitpoints ?? 0,
            }));

            return {
                time: this.simulationTime,
                wave: this.zone.encountersKilled - 1,
                source: sourceHrid,
                ability: ability,
                target: targetHrid,
                damage: damageDone,
                beforeHp: beforeHp,
                afterHp: afterHp,
                playersHp: playersHp,
                isCrit: false,
            };
        } catch (e) {
            return {
                error: `[Log generation error] ${e.message}`,
            };
        }
    }

    generateCombatLog(source, ability, target, attackResult) {
        try {
            const sourceHrid = source?.hrid || 'UNKNOWN_SOURCE';
            const targetHrid = target?.hrid || 'UNKNOWN_TARGET';
            const damage = attackResult?.damageDone || 0;

            const afterHp = target?.combatDetails?.currentHitpoints || 0;
            const beforeHp = Math.max(0, afterHp + damage);

            const playersHp = this.players.map((p) => ({
                hrid: p.hrid || 'UNKNOWN_PLAYER',
                current: p.combatDetails?.currentHitpoints ?? 0,
                max: p.combatDetails?.maxHitpoints ?? 0,
            }));

            return {
                time: this.simulationTime,
                wave: this.zone.encountersKilled - 1,
                source: sourceHrid,
                ability: ability,
                target: targetHrid,
                damage: damage,
                beforeHp: beforeHp,
                afterHp: afterHp,
                playersHp: playersHp,
                isCrit: attackResult?.isCrit || false,
            };
        } catch (e) {
            return {
                error: `[Log generation error] ${e.message}`,
            };
        }
    }

    getOrderedWipeLogs() {
        const { buffer, maxSize, count } = this.wipeLogs;
        const logs = [];

        for (let i = 0; i < count; i++) {
            const idx = (this.wipeLogs.index - count + maxSize + i) % maxSize;
            logs.push(buffer[idx]);
        }

        return logs;
    }

    saveWipeLogsToSimResult(wave) {
        const logs = this.getOrderedWipeLogs();
        this.simResult.addWipeEvent(logs, this.simulationTime, wave);
    }

    /**
     * Run the combat simulation synchronously.
     *
     * A labyrinth run can also stop once its win rate is pinned down closely
     * enough (see stopRule), which is usually long before the time limit and
     * occasionally much later. Time remains the outer bound either way.
     *
     * @param {number} simulationTimeLimit - Simulation time limit in nanoseconds
     * @param {Object} [stopRule] - Labyrinth stopping rule: a hard trial count
     *   (maxTrials), a decision against a bar (decideAgainst), or an interval
     *   width (targetHalfWidth). Ignored outside labyrinth runs.
     * @returns {SimResult}
     */
    simulate(simulationTimeLimit, stopRule = null) {
        resetSimWarnings();
        this.reset();
        this.stopRule = this.labyrinth && isStoppingRule(stopRule) ? stopRule : null;
        this.converged = false;
        // A decision is tested on a growing schedule rather than after every
        // fight. Re-testing a boundary on every new observation crosses it far
        // more often than its nominal confidence implies — the same rate one
        // point under a 70% bar was called "above" 39% of the time when checked
        // each fight, and 19% on this schedule at the same confidence.
        this.nextStopCheck = Number(this.stopRule?.minTrials) || 1;

        let ticks = 0;

        const combatStartEvent = new CombatStartEvent(0);
        this.eventQueue.addEvent(combatStartEvent);

        while (this.simulationTime < simulationTimeLimit && !this.converged) {
            const nextEvent = this.eventQueue.getNextEvent();
            this.processEvent(nextEvent);

            ticks++;
            if (ticks === 50000) {
                ticks = 0;
                if (this.onProgress) {
                    this.onProgress({
                        zone: this.zone.hrid,
                        difficultyTier: this.zone.difficultyTier,
                        progress: Math.min(this.simulationTime / simulationTimeLimit, 1),
                    });
                }
            }
        }

        this.simResult.isDungeon = this.zone.isDungeon;
        if (this.simResult.isDungeon) {
            this.simResult.dungeonsCompleted = this.zone.dungeonsCompleted;
            this.simResult.dungeonsFailed = this.zone.dungeonsFailed;
            if (this.simResult.dungeonsCompleted < 1) {
                this.simResult.maxWaveReached = 0;
                for (let i = 1; i <= this.zone.dungeonSpawnInfo.maxWaves; i++) {
                    const waveName = '#' + i.toString();
                    const idx = this.simResult.timeSpentAlive.findIndex((e) => e.name === waveName);
                    if (idx === -1 || this.simResult.timeSpentAlive[idx].count === 0) {
                        break;
                    }
                    this.simResult.maxWaveReached = i;
                }
            } else {
                this.simResult.maxWaveReached = this.zone.dungeonSpawnInfo.maxWaves;
            }
        }

        // Labyrinth result tracking
        if (this.labyrinth) {
            this.simResult.isLabyrinth = true;
            // Only attempts that actually finished — win, death or timeout —
            // are counted; the fight still in progress when the run stopped is
            // reported separately rather than scored or subtracted. (The old
            // blanket `attemptCount - 1` subtracted a *resolved* win whenever
            // the time cap landed on the killing blow itself, and a 100%-win
            // run then read 251/250 = "100.4% clear".)
            this.simResult.labyAttemptCount = this.labyrinth.resolvedCount;
            this.simResult.labyUnfinishedAttempts = this.labyrinth.attemptCount - this.labyrinth.resolvedCount;
            if (this.simResult.encounters > this.labyrinth.resolvedCount) {
                // Impossible by construction; if it ever prints, the counters have drifted
                console.warn(
                    `[CombatSimulator] Labyrinth wins (${this.simResult.encounters}) exceed resolved attempts (${this.labyrinth.resolvedCount})`
                );
            }
            this.simResult.labyStoppedOnPrecision = this.converged;
            this.simResult.labyrinthMonsterHrid = this.labyrinth.monsterHrid;
            this.simResult.roomLevel = this.labyrinth.roomLevel;
        }

        this.simResult.simulatedTime = this.simulationTime;
        this._collectWarnings();

        for (let i = 0; i < this.players.length; i++) {
            this.simResult.setDropRateMultipliers(this.players[i]);
            this.simResult.setManaUsed(this.players[i]);
        }

        if (this.zone.isDungeon) {
            Object.entries(this.zone.dungeonSpawnInfo.fixedSpawnsMap).forEach(([wave, monsters]) => {
                let waveName = '#' + wave.toString();
                monsters.forEach((monster) => {
                    waveName += ',' + monster.combatMonsterHrid;
                });
                this.simResult.bossSpawns.push(waveName);
            });
        }
        if (this.zone.monsterSpawnInfo.bossSpawns) {
            for (const boss of this.zone.monsterSpawnInfo.bossSpawns) {
                this.simResult.bossSpawns.push(boss.combatMonsterHrid);
            }
        }

        return this.simResult;
    }

    /**
     * Hand the run's skipped-mechanic warnings to the result, so a caller who
     * only ever sees the SimResult still learns the numbers are incomplete.
     */
    _collectWarnings() {
        this.simResult.warnings = getSimWarnings();
    }

    reset() {
        this.tempDungeonCount = 0;
        // Clear-time pairing state (see SimResult.dungeonCleanClearTimeTotal):
        // the timestamp of the last dungeon completion, and whether the run
        // since it was interrupted by a wipe (which drops the pair).
        this.lastDungeonCompletionTime = null;
        this.dungeonPairBroken = true;
        this.simulationTime = 0;
        this.encounterIndex = 0;
        this.eventQueue.clear();
        this.simResult = new SimResult(this.zone, this.players.length);
        this.simResult.clock = () => this.simulationTime;
    }

    processEvent(event) {
        this.simulationTime = event.time;

        switch (event.type) {
            case CombatStartEvent.type:
                this.processCombatStartEvent(event);
                break;
            case PlayerRespawnEvent.type:
                this.processPlayerRespawnEvent(event);
                break;
            case EnemyRespawnEvent.type:
                this.processEnemyRespawnEvent(event);
                break;
            case AutoAttackEvent.type:
                this.processAutoAttackEvent(event);
                break;
            case ConsumableTickEvent.type:
                this.processConsumableTickEvent(event);
                break;
            case DamageOverTimeEvent.type:
                this.processDamageOverTimeTickEvent(event);
                break;
            case CheckBuffExpirationEvent.type:
                this.processCheckBuffExpirationEvent(event);
                break;
            case RegenTickEvent.type:
                this.processRegenTickEvent(event);
                break;
            case StunExpirationEvent.type:
                this.processStunExpirationEvent(event);
                break;
            case BlindExpirationEvent.type:
                this.processBlindExpirationEvent(event);
                break;
            case SilenceExpirationEvent.type:
                this.processSilenceExpirationEvent(event);
                break;
            case CurseExpirationEvent.type:
                this.processCurseExpirationEvent(event);
                break;
            case WeakenExpirationEvent.type:
                this.processWeakenExpirationEvent(event);
                break;
            case FuryExpirationEvent.type:
                this.processFuryExpirationEvent(event);
                break;
            case EnrageTickEvent.type:
                this.processEnrageTickEvent(event);
                break;
            case AbilityCastEndEvent.type:
                this.tryUseAbility(event.source, event.ability);
                break;
            case AwaitCooldownEvent.type:
                this.addNextAttackEvent(event.source);
                break;
            case CooldownReadyEvent.type:
                // Only used to check triggers
                break;
        }

        this.checkTriggers();
    }

    processCombatStartEvent(event) {
        for (let i = 0; i < this.players.length; i++) {
            if (event.time === 0) {
                // First combat start event
                this.players[i].generatePermanentBuffs();
            }
            if (this.labyrinth) {
                // Labyrinth: full reset every encounter (independent fights)
                this.players[i].reset(0);
            } else {
                // A wipe restart deliberately keeps the party's running buffs
                // (reset() only prunes the expired ones), but every one of those
                // players died, and dying swept their expiry checks off the
                // queue. Re-arm them or the survivors of the wipe carry the buff
                // for the rest of the run.
                const wasDown = this.players[i].combatDetails.currentHitpoints <= 0;
                this.players[i].reset(this.simulationTime);
                if (wasDown) {
                    this._rescheduleBuffExpirations(this.players[i]);
                }
            }
        }

        // The one faithful moment to read the sim player's build: persistent buffs
        // folded, no transient combat buff yet. Snapshot once.
        if (CAPTURE_PLAYER_DETAILS && !capturedPlayerDetails && this.players[0]) {
            capturedPlayerDetails = snapshotPlayerBuild(this.players[0]);
        }

        const regenTickEvent = new RegenTickEvent(this.simulationTime + REGEN_TICK_INTERVAL);
        this.eventQueue.addEvent(regenTickEvent);

        this.startNewEncounter();
    }

    processPlayerRespawnEvent(event) {
        const respawningPlayer = this.players.find((player) => player.hrid === event.hrid);
        respawningPlayer.combatDetails.currentHitpoints = respawningPlayer.combatDetails.maxHitpoints;
        respawningPlayer.combatDetails.currentManapoints = respawningPlayer.combatDetails.maxManapoints;
        respawningPlayer.clearBuffs();
        respawningPlayer.clearCCs();
        if (this.allPlayersDead) {
            this.allPlayersDead = false;
            this.startAttacks();
        } else {
            this.addNextAttackEvent(respawningPlayer);
        }
    }

    processEnemyRespawnEvent(_event) {
        this.startNewEncounter();
    }

    /**
     * Rewind both sides to the fight in progress: health where it stands now,
     * and a clock already part-spent.
     *
     * Fractions rather than absolute hitpoints, because the simulated player is
     * built from a loadout that may not be what is equipped — matching the
     * proportion carries over, matching the number would not.
     */
    applyLiveState() {
        const live = this.labyrinth.liveState;

        for (const player of this.players) {
            const details = player.combatDetails;
            details.currentHitpoints = Math.max(1, Math.round(details.maxHitpoints * live.playerHpFraction));
            if (Number.isFinite(live.playerMpFraction)) {
                details.currentManapoints = Math.max(0, Math.round(details.maxManapoints * live.playerMpFraction));
            }
        }

        for (const enemy of this.enemies) {
            const details = enemy.combatDetails;
            details.currentHitpoints = Math.max(1, Math.round(details.maxHitpoints * live.monsterHpFraction));
        }

        // Backdate the encounter's start so the room timer expires after the
        // time this fight has left, not a further two minutes
        if (Number.isFinite(live.elapsedNs)) {
            this.labyrinth.updateEncounterStartTime(this.simulationTime - live.elapsedNs);
        }
    }

    startNewEncounter() {
        // Restart the combat/setup streams so this encounter begins from the same
        // random state in every run sharing the seed (no-op when unseeded)
        syncEncounterRng(this.encounterIndex++);

        // Belt and braces for a wave that is still standing when the next one
        // spawns: this.enemies is about to be overwritten, and checkEncounterEnd
        // only ever looks at this.enemies, so anything the outgoing units still
        // have queued would keep swinging forever with nothing able to retire
        // them. Retire their events with them.
        if (this.enemies) {
            for (const enemy of this.enemies) {
                this.eventQueue.clearEventsForUnit(enemy);
            }
        }

        if (this.allPlayersDead) {
            this.allPlayersDead = false;
            // Only a dungeon has a wave run to fail. Zone.failWave() counts a
            // dungeon failure and resets encountersKilled, which outside a
            // dungeon is the counter to the next boss — a death there used to
            // wipe boss progress the game does not reset (see expected-kills,
            // which models no death reset).
            if (!this.labyrinth && this.zone.isDungeon) {
                this.zone.failWave();
            }
        }

        if (this.labyrinth) {
            // Decided here rather than in the loop: a monster spawning is the
            // one moment when every attempt so far has resolved, so stopping on
            // it leaves no half-fought trial to distort the rate. The attempt
            // just spawned is discarded by the count.
            if (this.stopRule) {
                const attempts = this.labyrinth.attemptCount;
                const decides = Number(this.stopRule.decideAgainst) > 0;
                if (!decides || attempts >= this.nextStopCheck) {
                    if (decides) {
                        this.nextStopCheck = Math.max(attempts + 1, Math.ceil(attempts * STOP_CHECK_GROWTH));
                    }
                    if (hasConverged(this.simResult.encounters, attempts, this.stopRule)) {
                        this.converged = true;
                    }
                }
            }
            this.enemies = this.labyrinth.getMonster();
            this.labyrinth.updateEncounterStartTime(this.simulationTime);
        } else if (!this.zone.isDungeon) {
            this.enemies = this.zone.getRandomEncounter();
        } else {
            this.enemies = this.zone.getNextWave();
            this.simResult.updateTimeSpentAlive(
                '#' + (this.zone.encountersKilled - 1).toString(),
                true,
                this.simulationTime
            );
            const currentDungeonCount = this.zone.dungeonsCompleted;
            if (currentDungeonCount > this.tempDungeonCount) {
                this.tempDungeonCount = currentDungeonCount;
                // Record the completion-to-completion interval only for a clean
                // pair (a preceding completion with no wipe in between). This is
                // the sim's equivalent of the tracker's key→key pair, and it is
                // what "Avg completion time" should divide, rather than total
                // simulated time (which carries wipes and the unfinished tail).
                if (!this.dungeonPairBroken && this.lastDungeonCompletionTime !== null) {
                    this.simResult.dungeonCleanClearTimeTotal += this.simulationTime - this.lastDungeonCompletionTime;
                    this.simResult.dungeonCleanClearCount++;
                }
                this.lastDungeonCompletionTime = this.simulationTime;
                this.dungeonPairBroken = false;
                for (let i = 0; i < this.players.length; i++) {
                    // Clearing the dungeon puts a downed party member back on
                    // their feet — a revive by another name, so it owes the same
                    // re-arming a cast revive does. Their expiry checks went with
                    // them when they died and nothing else prunes a buff.
                    const wasDown = this.players[i].combatDetails.currentHitpoints <= 0;
                    this.players[i].combatDetails.currentHitpoints = this.players[i].combatDetails.maxHitpoints;
                    this.players[i].combatDetails.currentManapoints = this.players[i].combatDetails.maxManapoints;
                    if (wasDown) {
                        this.players[i].removeExpiredBuffs(this.simulationTime);
                        this._rescheduleBuffExpirations(this.players[i]);
                    }
                }
            }
        }

        this.enemies.forEach((enemy) => {
            enemy.reset(this.simulationTime);
            this.simResult.updateTimeSpentAlive(enemy.hrid, true, this.simulationTime);
        });

        // Conditional mode: every encounter restarts from the state of a fight
        // already in progress, rather than from full health with a fresh clock.
        // Applied after the resets above, which would otherwise undo it. Running
        // many encounters this way makes each one an independent replay of the
        // same moment, so the win rate over them is the chance of clearing from
        // there — which is a different question from how the room usually goes.
        if (this.labyrinth?.liveState) this.applyLiveState();

        this.eventQueue.clearEventsOfType(EnrageTickEvent.type);
        const enrageTickEvent = new EnrageTickEvent(this.simulationTime + ENRAGE_TICK_INTERVAL, ENRAGE_TICK_INTERVAL);
        this.eventQueue.addEvent(enrageTickEvent);
        this.enrageBeginTime = this.simulationTime;

        this.eventQueue.clearEventsOfType(AbilityCastEndEvent.type);

        this.checkTriggers();
        this.startAttacks();
    }

    startAttacks() {
        const units = [...this.players];
        if (this.enemies) {
            units.push(...this.enemies);
        }

        for (const unit of units) {
            if (unit.combatDetails.currentHitpoints <= 0) {
                continue;
            }

            this.addNextAttackEvent(unit);
        }
    }

    checkParry(targets) {
        const parryUnits = targets.filter(
            (unit) => unit && unit.combatDetails.currentHitpoints > 0 && unit.combatDetails.combatStats.parry > 0
        );
        if (parryUnits.length <= 0) {
            return undefined;
        }
        const randomIndex = Math.floor(random() * parryUnits.length);
        if (parryUnits[randomIndex].combatDetails.combatStats.parry > random()) {
            return parryUnits[randomIndex];
        }
        return undefined;
    }

    /**
     * One auto attack: the swing, its pierces, and every per-hit side effect
     * the engine models on a swing.
     *
     * **Blaze, bloom and ripple are deliberately absent here.** They are rolled
     * once per *ability cast*, in `tryUseAbility`, and never on an auto attack.
     * This was checked rather than assumed, because a blaze that also fired on
     * autos would be worth several percent of a build's damage, and would show
     * up first against a monster whose resistances dwarf its armour — where an
     * elemental side-channel is the only thing that moves the numbers:
     *
     * - The reference sim this engine is ported from (see
     *   `third-party/mwi-combat-simulator/`) puts the blaze and bloom rolls
     *   inside `tryUseAbility` and nowhere else; its `processAutoAttackEvent`
     *   contains no occurrence of `blaze`, `bloom` or `ripple` on any published
     *   branch. This port matches it, so the absence is parity, not a dropped
     *   port — and the audit that swept this engine against that reference
     *   (`e02a7e5a`) did not flag it either.
     * - Nothing in this repository — no comment, test, fixture or recorded
     *   fight — carries evidence about what the *game* does on an auto attack.
     *   The game's own `abilityDetailMap` has no `/abilities/blaze` entry at
     *   all; `ability.js` synthesises one from `abilityFromCombatStat`, which is
     *   why the stat can only be observed through whatever the sim chooses to
     *   do with it.
     *
     * So the roll is not added here. Adding it would be modelling a mechanic on
     * a guess, and the guess is expensive in the direction that flatters a
     * build. If someone later produces real evidence — a recorded fight where a
     * blaze lands with no ability cast behind it — the roll belongs here,
     * mirroring the ability path exactly: `todoAbilities.push(new
     * Ability('blaze'))` routed through `processAbilityDamageEffect`, which
     * files it under the tally key `'blaze'`. That key is a *counted* source by
     * `isCountedSource` in `labyrinth-replay-check.js`, which is correct for it:
     * that path files a `'miss'` too, so every entry has a counted attempt
     * behind it, unlike a DoT tick or a thorns reflect.
     * `blaze-proc.test.js` pins both halves of the split.
     *
     * Two other asymmetries against the ability path are not bugs either:
     * lifesteal and mana leech are computed inside
     * `CombatUtilities.processAttack` under `if (!abilityEffect)`, i.e.
     * auto-attack-only by construction; and `pierce` here is the
     * `combatStats.pierce` chance, where the ability path uses the effect's own
     * `pierceChance`. Both match the reference sim.
     *
     * @param {Object} event - The AutoAttackEvent being processed
     */
    processAutoAttackEvent(event) {
        const targets = event.source.isPlayer ? this.enemies : this.players;

        if (!targets) {
            return;
        }

        const aliveTargets = targets.filter((unit) => unit && unit.combatDetails.currentHitpoints > 0);

        for (let i = 0; i < aliveTargets.length; i++) {
            let target = aliveTargets[i];
            if (!event.source.isPlayer) {
                // The threat roll has to see the living, not the snapshot taken
                // before the first pierce: rolling against the stale list can
                // pick a player this same attack already killed, hitting a
                // corpse for 0 and counting the death a second time.
                const liveTargets = aliveTargets.filter((unit) => unit.combatDetails.currentHitpoints > 0);
                if (liveTargets.length === 0) {
                    break;
                }
                if (liveTargets.length === 1) {
                    target = liveTargets[0];
                } else {
                    let cumulativeThreat = 0;
                    const cumulativeRanges = [];
                    liveTargets.forEach((player) => {
                        const playerThreat = player.combatDetails.combatStats.threat;
                        cumulativeThreat += playerThreat;
                        cumulativeRanges.push({
                            player: player,
                            rangeStart: cumulativeThreat - playerThreat,
                            rangeEnd: cumulativeThreat,
                        });
                    });
                    const randomValueHit = random() * cumulativeThreat;
                    target = cumulativeRanges.find(
                        (range) => randomValueHit >= range.rangeStart && randomValueHit < range.rangeEnd
                    ).player;
                }
            } else if (!target || target.combatDetails.currentHitpoints <= 0) {
                // Player pierce walks the enemies positionally, so index i is
                // untouched by earlier iterations — but it can still have died
                // to a damage-over-time tick between the two. Nothing to pierce.
                break;
            }
            let source = event.source;

            const parryTarget = this.checkParry(targets);
            if (parryTarget) {
                target = source;
                source = parryTarget;
            }

            // Whether this blow is what put the target down — read before the
            // attack so a corpse can never be credited as a fresh death.
            const targetWasAlive = target.combatDetails.currentHitpoints > 0;

            const attackResult = CombatUtilities.processAttack(source, target, null, this.isTaskFight);
            if (this.zone.isDungeon && target.isPlayer && attackResult.didHit && attackResult.damageDone > 0) {
                const log = this.generateCombatLog(source, 'autoAttack', target, attackResult);
                this.addToWipeLogs(log);
            }

            const mayhem = source.combatDetails.combatStats.mayhem > random();

            if (attackResult.didHit && source.combatDetails.combatStats.curse > 0) {
                const curseExpireTime = 15000000000;
                const currentCurseEvent = this.eventQueue.getByTypeAndSource(CurseExpirationEvent.type, target);
                let currentCurseAmount = 0;
                if (currentCurseEvent) currentCurseAmount = currentCurseEvent.curseAmount;
                this.eventQueue.clearByTypeAndSource(CurseExpirationEvent.type, target);

                const curseExpirationEvent = new CurseExpirationEvent(
                    this.simulationTime + curseExpireTime,
                    currentCurseAmount,
                    target
                );
                const curseBuff = {
                    uniqueHrid: '/buff_uniques/curse',
                    typeHrid: '/buff_types/damage_taken',
                    ratioBoost: 0,
                    ratioBoostLevelBonus: 0,
                    flatBoost: source.combatDetails.combatStats.curse * curseExpirationEvent.curseAmount,
                    flatBoostLevelBonus: 0,
                    startTime: '0001-01-01T00:00:00Z',
                    duration: curseExpireTime,
                };
                target.addBuff(curseBuff, this.simulationTime);
                this.eventQueue.addEvent(curseExpirationEvent);
            }

            if (source.combatDetails.combatStats.fury > 0) {
                this._processFuryUpdate(source, attackResult.didHit);
            }

            if (target.combatDetails.combatStats.weaken > 0) {
                const weakenExpireTime = 15000000000;
                const currentWeakenEvent = this.eventQueue.getByTypeAndSource(WeakenExpirationEvent.type, source);
                let weakenAmount = 0;
                if (currentWeakenEvent) weakenAmount = currentWeakenEvent.weakenAmount;
                this.eventQueue.clearByTypeAndSource(WeakenExpirationEvent.type, source);
                const weakenExpirationEvent = new WeakenExpirationEvent(
                    this.simulationTime + 15000000000,
                    weakenAmount,
                    source
                );
                const weakenBuff = {
                    uniqueHrid: '/buff_uniques/weaken',
                    typeHrid: '/buff_types/damage',
                    ratioBoost: -1 * target.combatDetails.combatStats.weaken * weakenExpirationEvent.weakenAmount,
                    ratioBoostLevelBonus: 0,
                    flatBoost: 0,
                    flatBoostLevelBonus: 0,
                    startTime: '0001-01-01T00:00:00Z',
                    duration: weakenExpireTime,
                };
                source.addBuff(weakenBuff, this.simulationTime);
                this.eventQueue.addEvent(weakenExpirationEvent);
            }

            if (!mayhem || (mayhem && attackResult.didHit) || (mayhem && i === aliveTargets.length - 1)) {
                this.simResult.addAttack(
                    source,
                    target,
                    'autoAttack',
                    attackResult.didHit ? attackResult.damageDone : 'miss',
                    attackResult.didHit && attackResult.isCrit
                );
            }

            if (attackResult.lifeStealHeal > 0) {
                this.simResult.addHitpointsGained(source, 'lifesteal', attackResult.lifeStealHeal);
            }

            if (attackResult.manaLeechMana > 0) {
                this.simResult.addManapointsGained(source, 'manaLeech', attackResult.manaLeechMana);
            }

            if (attackResult.thornDamageDone > 0) {
                this.simResult.addAttack(target, source, attackResult.thornType, attackResult.thornDamageDone);
            }
            if (this.zone.isDungeon && attackResult.thornDamageDone > 0 && source.isPlayer) {
                const log = this.buildCombatLog(target, attackResult.thornType, source, attackResult.thornDamageDone);
                this.addToWipeLogs(log);
            }

            if (target.combatDetails.combatStats.retaliation > 0) {
                this.simResult.addAttack(
                    target,
                    source,
                    'retaliation',
                    attackResult.retaliationDamageDone > 0 ? attackResult.retaliationDamageDone : 'miss'
                );
            }
            if (this.zone.isDungeon && attackResult.retaliationDamageDone > 0 && source.isPlayer) {
                const log = this.buildCombatLog(target, 'retaliation', source, attackResult.retaliationDamageDone);
                this.addToWipeLogs(log);
            }

            if (targetWasAlive && target.combatDetails.currentHitpoints === 0) {
                this.eventQueue.clearEventsForUnit(target);
                this.simResult.addDeath(target);
                if (!target.isPlayer) {
                    this.simResult.updateTimeSpentAlive(target.hrid, false, this.simulationTime);
                }
            }

            // Could die from reflect damage
            if (
                source.combatDetails.currentHitpoints === 0 &&
                (attackResult.thornDamageDone !== 0 || attackResult.retaliationDamageDone !== 0)
            ) {
                this.eventQueue.clearEventsForUnit(source);
                this.simResult.addDeath(source);
                if (!source.isPlayer) {
                    this.simResult.updateTimeSpentAlive(source.hrid, false, this.simulationTime);
                }
                break;
            }

            if (mayhem && !attackResult.didHit) {
                continue;
            }

            if (!attackResult.didHit || parryTarget || source.combatDetails.combatStats.pierce <= random()) {
                break;
            }
        }

        // checkEncounterEnd must run first (side effects); a source dead from thorns/parry must not re-queue
        if (!this.checkEncounterEnd() && event.source.combatDetails.currentHitpoints > 0) {
            this.addNextAttackEvent(event.source);
        }
    }

    checkEncounterEnd() {
        // Labyrinth timeout check
        if (this.labyrinth && this.enemies && this.labyrinth.checkTimeout(this.simulationTime)) {
            // Timeout = loss. Clear everything and immediately restart.
            this.labyrinth.resolvedCount++;
            this.enemies = null;
            this.eventQueue.clear();
            const combatStartEvent = new CombatStartEvent(this.simulationTime);
            this.eventQueue.addEvent(combatStartEvent);
            return true;
        }

        if (this.enemies) {
            const deadEnemies = this.enemies.filter(
                (enemy) => enemy.combatDetails.currentHitpoints <= 0 && enemy.experienceRate === 0
            );
            if (deadEnemies.length > 0) {
                deadEnemies.forEach((enemy) => {
                    // A missing or zero enrageTime means the monster never enrages;
                    // dividing by it would make experienceRate NaN and silently poison
                    // all XP, so treat it as the un-enraged base rate.
                    if (!enemy.enrageTime) {
                        enemy.experienceRate = 1.0;
                        return;
                    }
                    let aliveDuration = this.simulationTime - this.enrageBeginTime;
                    if (aliveDuration > enemy.enrageTime) {
                        aliveDuration = enemy.enrageTime;
                    }
                    enemy.experienceRate = 1.0 + aliveDuration / enemy.enrageTime;
                });
            }
        }

        let encounterEnded = false;

        // Read once, up front: a pass where thorns kill the last monster and the
        // last player in the same blow satisfies both the wave-cleared branch
        // and the wipe branch, and the two must not both do their accounting.
        const allPlayersDown = !this.players.some((player) => player.combatDetails.currentHitpoints > 0);

        if (this.enemies && !this.enemies.some((enemy) => enemy.combatDetails.currentHitpoints > 0)) {
            this.eventQueue.clearEventsOfType(AutoAttackEvent.type);

            if (!this.labyrinth && this.zone.isDungeon && allPlayersDown) {
                // Wipe wins in a dungeon. A dungeon run ends the moment the
                // party is down: the game does not carry a party out of a wave
                // it did not survive, so there is no wave credit, no respawn
                // timer and no experience for it. The wipe branch below does
                // the accounting for this pass, once.
                this.enemies = null;
            } else if (this.labyrinth) {
                // Labyrinth win: immediate restart (no respawn delay)
                this.labyrinth.resolvedCount++;
                this.enemies = null;
                this.simResult.addEncounterEnd();
                this.eventQueue.clear();
                const combatStartEvent = new CombatStartEvent(this.simulationTime);
                this.eventQueue.addEvent(combatStartEvent);
                return true;
            } else {
                const enemyRespawnEvent = new EnemyRespawnEvent(this.simulationTime + ENEMY_RESPAWN_INTERVAL);
                this.eventQueue.addEvent(enemyRespawnEvent);

                // calc exp before clear
                if (this.enemies.some((enemy) => enemy.experienceRate <= 0)) {
                    console.warn('[CombatSimulator] Some enemies have no experience rate');
                }

                const totalExp = this.enemies
                    .map((enemy) => enemy.experience * enemy.experienceRate)
                    .reduce((a, b) => a + b, 0);
                this.players.forEach((player) => {
                    this.simResult.addExperienceGain(player, totalExp / this.players.length);
                });

                this.enemies = null;

                if (this.zone.isDungeon) {
                    this.simResult.updateTimeSpentAlive(
                        '#' + (this.zone.encountersKilled - 1).toString(),
                        false,
                        this.simulationTime
                    );
                }
                this.simResult.addEncounterEnd();

                encounterEnded = true;
            }
        }

        this.players.forEach((player) => {
            if (
                player.combatDetails.currentHitpoints <= 0 &&
                !this.eventQueue.containsEventOfTypeAndHrid(PlayerRespawnEvent.type, player.hrid)
            ) {
                if (!this.zone.isDungeon && !this.labyrinth) {
                    const playerRespawnEvent = new PlayerRespawnEvent(
                        this.simulationTime + PLAYER_RESPAWN_INTERVAL,
                        player.hrid
                    );
                    this.eventQueue.addEvent(playerRespawnEvent);
                }
                this.simResult.addRanOutOfManaCount(player, false, this.simulationTime);
            }
        });

        if (allPlayersDown) {
            if (this.labyrinth) {
                // Labyrinth death = loss. Immediate restart.
                this.labyrinth.resolvedCount++;
                this.enemies = null;
                this.eventQueue.clear();
                const combatStartEvent = new CombatStartEvent(this.simulationTime);
                this.eventQueue.addEvent(combatStartEvent);
                return true;
            } else if (this.zone.isDungeon) {
                // A wipe breaks the clear-time pair: the next completion started
                // from this failed attempt's restart, not from a clean prior
                // completion, so its interval must not enter the average.
                this.dungeonPairBroken = true;
                this.saveWipeLogsToSimResult(this.zone.encountersKilled - 1);
                this.wipeLogs.index = 0;
                this.wipeLogs.count = 0;

                // Clear combat events but preserve buff expiration and cooldown events
                this.eventQueue.clearEventsOfType(AutoAttackEvent.type);
                this.eventQueue.clearEventsOfType(AbilityCastEndEvent.type);
                this.eventQueue.clearEventsOfType(DamageOverTimeEvent.type);
                this.eventQueue.clearEventsOfType(ConsumableTickEvent.type);
                this.eventQueue.clearEventsOfType(RegenTickEvent.type);
                this.eventQueue.clearEventsOfType(EnrageTickEvent.type);
                this.eventQueue.clearEventsOfType(StunExpirationEvent.type);
                this.eventQueue.clearEventsOfType(BlindExpirationEvent.type);
                this.eventQueue.clearEventsOfType(SilenceExpirationEvent.type);
                this.eventQueue.clearEventsOfType(AwaitCooldownEvent.type);
                // A wave cleared moments before the party went down leaves an
                // EnemyRespawnEvent queued. It fires before the restart below,
                // spawning a wave against a dead party and then having that wave
                // overwritten by the restart's own — the overwritten monsters
                // keep attacking from outside this.enemies, one more phantom per
                // wipe. The run restarts from CombatStartEvent; nothing here
                // should still be waiting to respawn.
                this.eventQueue.clearEventsOfType(EnemyRespawnEvent.type);
                this.enemies = null;

                const combatStartEvent = new CombatStartEvent(this.simulationTime + RESTART_INTERVAL);
                this.eventQueue.addEvent(combatStartEvent);
            } else {
                this.eventQueue.clearEventsOfType(AutoAttackEvent.type);
                this.eventQueue.clearEventsOfType(AbilityCastEndEvent.type);
            }
            encounterEnded = true;
            this.allPlayersDead = true;
        }

        return encounterEnded;
    }

    addNextAttackEvent(source) {
        if (source.combatDetails.currentHitpoints <= 0) {
            return;
        }
        // Check both event types via indexed lookups instead of O(n) getMatching
        if (
            this.eventQueue.getByTypeAndSource(AbilityCastEndEvent.type, source) ||
            this.eventQueue.getByTypeAndSource(AutoAttackEvent.type, source)
        ) {
            return;
        }

        let target;
        let friendlies;
        let enemies;
        if (source.isPlayer) {
            target = CombatUtilities.getTarget(this.enemies);
            friendlies = this.players;
            enemies = this.enemies;
        } else {
            target = CombatUtilities.getTarget(this.players);
            friendlies = this.enemies;
            enemies = this.players;
        }

        let usedAbility = false;
        let skipNextAbility = false;

        source.abilities
            .filter((ability) => ability != null)
            .forEach((ability) => {
                if (
                    !usedAbility &&
                    !skipNextAbility &&
                    ability.shouldTrigger(this.simulationTime, source, target, friendlies, enemies)
                ) {
                    if (!this.canUseAbility(source, ability, true)) {
                        skipNextAbility = true;
                    }

                    if (!skipNextAbility) {
                        let castDuration = ability.castDuration;
                        castDuration /= 1 + source.combatDetails.combatStats.castSpeed;
                        const abilityCastEndEvent = new AbilityCastEndEvent(
                            this.simulationTime + castDuration,
                            source,
                            ability
                        );
                        this.eventQueue.addEvent(abilityCastEndEvent);
                        usedAbility = true;
                    }
                }
            });

        if (usedAbility) {
            source.isOutOfMana = false;
            return;
        }

        if (!enemies) {
            return;
        }

        if (!source.isBlinded) {
            const autoAttackEvent = new AutoAttackEvent(
                this.simulationTime + source.combatDetails.combatStats.attackInterval,
                source
            );
            this.eventQueue.addEvent(autoAttackEvent);
        } else {
            source.isOutOfMana = true;
        }
    }

    processConsumableTickEvent(event) {
        if (event.consumable.hitpointRestore > 0) {
            const tickValue = CombatUtilities.calculateTickValue(
                event.consumable.hitpointRestore,
                event.totalTicks,
                event.currentTick
            );
            const hitpointsAdded = event.source.addHitpoints(tickValue);
            this.simResult.addHitpointsGained(event.source, event.consumable.hrid, hitpointsAdded);
        }

        if (event.consumable.manapointRestore > 0) {
            const tickValue = CombatUtilities.calculateTickValue(
                event.consumable.manapointRestore,
                event.totalTicks,
                event.currentTick
            );
            const manapointsAdded = event.source.addManapoints(tickValue);
            this.simResult.addManapointsGained(event.source, event.consumable.hrid, manapointsAdded);

            // when oom check ability trigger
            if (event.source.isOutOfMana) {
                const awaitCooldownEvent = new AwaitCooldownEvent(this.simulationTime, event.source);
                this.eventQueue.addEvent(awaitCooldownEvent);
            }
        }

        if (event.currentTick < event.totalTicks) {
            const consumableTickEvent = new ConsumableTickEvent(
                this.simulationTime + HOT_TICK_INTERVAL,
                event.source,
                event.consumable,
                event.totalTicks,
                event.currentTick + 1
            );
            this.eventQueue.addEvent(consumableTickEvent);
        }
    }

    processDamageOverTimeTickEvent(event) {
        // Read before the tick so a corpse can never be credited as a fresh death:
        // a tick landing on an already-dead unit does 0 damage and must not re-kill it.
        const targetWasAlive = event.target.combatDetails.currentHitpoints > 0;

        const tickDamage = CombatUtilities.calculateTickValue(event.damage, event.totalTicks, event.currentTick);
        const damage = Math.min(tickDamage, event.target.combatDetails.currentHitpoints);

        event.target.combatDetails.currentHitpoints -= damage;
        this.simResult.addAttack(event.sourceRef, event.target, 'damageOverTime', damage);

        // Wipe logs explain a player wipe; gate on a dungeon as the seven other
        // addToWipeLogs sites do, so DoT ticks cannot evict the killing blow.
        if (this.zone.isDungeon && event.target.isPlayer) {
            const log = this.buildCombatLog('', 'damageOverTime', event.target, damage);
            this.addToWipeLogs(log);
        }

        if (event.currentTick < event.totalTicks) {
            const damageOverTimeTickEvent = new DamageOverTimeEvent(
                this.simulationTime + DOT_TICK_INTERVAL,
                event.sourceRef,
                event.target,
                event.damage,
                event.totalTicks,
                event.currentTick + 1,
                event.combatStyleHrid
            );
            this.eventQueue.addEvent(damageOverTimeTickEvent);
        }

        if (targetWasAlive && event.target.combatDetails.currentHitpoints === 0) {
            this.eventQueue.clearEventsForUnit(event.target);
            this.simResult.addDeath(event.target);
            if (!event.target.isPlayer) {
                this.simResult.updateTimeSpentAlive(event.target.hrid, false, this.simulationTime);
            }
        }

        this.checkEncounterEnd();
    }

    processRegenTickEvent(_event) {
        const units = [...this.players];
        // Enemy regen is always 0 in game data — skip enemies

        for (const unit of units) {
            if (unit.combatDetails.currentHitpoints <= 0) {
                continue;
            }

            const hitpointRegen = Math.floor(
                unit.combatDetails.maxHitpoints * unit.combatDetails.combatStats.hpRegenPer10
            );
            const hitpointsAdded = unit.addHitpoints(hitpointRegen);
            this.simResult.addHitpointsGained(unit, 'regen', hitpointsAdded);

            const manapointRegen = Math.floor(
                unit.combatDetails.maxManapoints * unit.combatDetails.combatStats.mpRegenPer10
            );
            const manapointsAdded = unit.addManapoints(manapointRegen);
            this.simResult.addManapointsGained(unit, 'regen', manapointsAdded);

            // when oom check ability trigger
            if (unit.isOutOfMana) {
                const awaitCooldownEvent = new AwaitCooldownEvent(this.simulationTime, unit);
                this.eventQueue.addEvent(awaitCooldownEvent);
            }
        }

        const regenTickEvent = new RegenTickEvent(this.simulationTime + REGEN_TICK_INTERVAL);
        this.eventQueue.addEvent(regenTickEvent);
    }

    processCheckBuffExpirationEvent(event) {
        event.source.removeExpiredBuffs(this.simulationTime);
    }

    processStunExpirationEvent(event) {
        event.source.isStunned = false;
        this.addNextAttackEvent(event.source);
    }

    processBlindExpirationEvent(event) {
        event.source.isBlinded = false;
        this.addNextAttackEvent(event.source);
    }

    processSilenceExpirationEvent(event) {
        event.source.isSilenced = false;
    }

    processCurseExpirationEvent(event) {
        event.source.removeExpiredBuffs(this.simulationTime);
    }

    processWeakenExpirationEvent(event) {
        event.source.removeExpiredBuffs(this.simulationTime);
    }

    processFuryExpirationEvent(event) {
        const source = event.source;
        // The timer was pushed back after this event was queued, which is the
        // normal case — every landed hit refreshes it. Re-arm for the new time
        // rather than expiring stacks the unit still has
        if (source.furyAmount > 0 && source.furyExpireTime > this.simulationTime) {
            const next = new FuryExpirationEvent(source.furyExpireTime, source.furyAmount, source);
            source.furyExpirationEvent = next;
            this.eventQueue.addEvent(next);
            return;
        }
        source.furyAmount = 0;
        source.furyExpireTime = 0;
        source.furyExpirationEvent = null;
        source.updateFuryBuffs(0, 0, 0, 0);
    }

    _processFuryUpdate(source, didHit) {
        const FURY_EXPIRE_TIME = 15000000000;
        const MAX_FURY_STACK = 5;

        const oldAmount = source.furyAmount;
        const newAmount = didHit ? Math.min(oldAmount + 1, MAX_FURY_STACK) : Math.floor(oldAmount / 2);

        source.furyAmount = newAmount;

        if (newAmount > 0) {
            source.furyExpireTime = this.simulationTime + FURY_EXPIRE_TIME;
            // The timer moves on every swing, and rewriting the queue each time
            // meant a scan and a fresh array per attack. The queued event checks
            // the clock when it fires and re-arms itself if the timer has moved,
            // so one event per fury streak is enough.
            //
            // `_heapIndex` goes to −1 when an event leaves the queue, which is
            // how a unit reset that cleared the queue is noticed without anyone
            // having to remember to clear a flag.
            const pending = source.furyExpirationEvent;
            if (!pending || pending._heapIndex < 0) {
                const expiry = new FuryExpirationEvent(source.furyExpireTime, newAmount, source);
                source.furyExpirationEvent = expiry;
                this.eventQueue.addEvent(expiry);
            }
        } else {
            source.furyExpireTime = 0;
        }

        // Only recalculate combat stats if stacks actually changed
        if (newAmount !== oldAmount) {
            source.updateFuryBuffs(
                newAmount,
                source.combatDetails.combatStats.fury,
                this.simulationTime,
                FURY_EXPIRE_TIME
            );
        }
    }

    processEnrageTickEvent(event) {
        if (!this.enemies) return;
        const maxEnrageStack = 10;
        this.enemies
            .filter((enemy) => enemy.combatDetails.currentHitpoints > 0)
            .forEach((enemy) => {
                // A missing or zero enrageTime means the monster never enrages;
                // dividing by it would floor to Infinity and jump straight to max stacks.
                if (!enemy.enrageTime) {
                    return;
                }
                const nowStack = Math.min(maxEnrageStack, Math.floor(event.encounterTime / enemy.enrageTime));

                if (nowStack <= 0) {
                    return;
                }

                const enrageDamageBuff = {
                    uniqueHrid: '/buff_uniques/enrage_damage',
                    typeHrid: '/buff_types/damage',
                    ratioBoost: nowStack * 0.1,
                    ratioBoostLevelBonus: 0,
                    flatBoost: 0,
                    flatBoostLevelBonus: 0,
                    startTime: '0001-01-01T00:00:00Z',
                    duration: ENRAGE_TICK_INTERVAL,
                };
                const enrageAccuracyBuff = {
                    uniqueHrid: '/buff_uniques/enrage_accuracy',
                    typeHrid: '/buff_types/accuracy',
                    ratioBoost: nowStack * 0.1,
                    ratioBoostLevelBonus: 0,
                    flatBoost: 0,
                    flatBoostLevelBonus: 0,
                    startTime: '0001-01-01T00:00:00Z',
                    duration: ENRAGE_TICK_INTERVAL,
                };
                enemy.addBuff(enrageDamageBuff, this.simulationTime);
                enemy.addBuff(enrageAccuracyBuff, this.simulationTime);

                this.simResult.maxEnrageStack = Math.max(this.simResult.maxEnrageStack, nowStack);
            });

        const enrageTickEvent = new EnrageTickEvent(
            this.simulationTime + ENRAGE_TICK_INTERVAL,
            event.encounterTime + ENRAGE_TICK_INTERVAL
        );
        this.eventQueue.addEvent(enrageTickEvent);
    }

    checkTriggers() {
        let triggeredSomething;

        do {
            triggeredSomething = false;

            for (const player of this.players) {
                if (player.combatDetails.currentHitpoints > 0) {
                    if (this.checkTriggersForUnit(player, this.players, this.enemies)) {
                        triggeredSomething = true;
                    }
                }
            }

            if (this.enemies) {
                for (const enemy of this.enemies) {
                    if (enemy.combatDetails.currentHitpoints > 0) {
                        if (this.checkTriggersForUnit(enemy, this.enemies, this.players)) {
                            triggeredSomething = true;
                        }
                    }
                }
            }
        } while (triggeredSomething);
    }

    checkTriggersForUnit(unit, friendlies, enemies) {
        // Still fatal, unlike the unknown-mechanic paths above. This is not the
        // game having grown a feature the engine has not learned — it is the
        // engine's own bookkeeping being wrong, and a corpse that goes on eating
        // and casting poisons every number downstream of it.
        if (unit.combatDetails.currentHitpoints <= 0) {
            throw new Error('Checking triggers for a dead unit');
        }

        let triggeredSomething = false;
        const target = CombatUtilities.getTarget(enemies);

        for (const food of unit.food) {
            if (food && food.shouldTrigger(this.simulationTime, unit, target, friendlies, enemies)) {
                const result = this.tryUseConsumable(unit, food);
                if (result) {
                    triggeredSomething = true;
                }
            }
        }

        for (const drink of unit.drinks) {
            if (drink && drink.shouldTrigger(this.simulationTime, unit, target, friendlies, enemies)) {
                const result = this.tryUseConsumable(unit, drink);
                if (result) {
                    triggeredSomething = true;
                }
            }
        }

        return triggeredSomething;
    }

    tryUseConsumable(source, consumable) {
        if (source.combatDetails.currentHitpoints <= 0) {
            return false;
        }

        consumable.lastUsed = this.simulationTime;
        let consumeCooldown = consumable.cooldownDuration;
        if (source.combatDetails.combatStats.drinkConcentration > 0 && consumable.catagoryHrid.includes('drink')) {
            consumeCooldown = consumeCooldown / (1 + source.combatDetails.combatStats.drinkConcentration);
        } else if (source.combatDetails.combatStats.foodHaste > 0 && consumable.catagoryHrid.includes('food')) {
            consumeCooldown = consumeCooldown / (1 + source.combatDetails.combatStats.foodHaste);
        }
        const cooldownReadyEvent = new CooldownReadyEvent(this.simulationTime + consumeCooldown);
        this.eventQueue.addEvent(cooldownReadyEvent);

        this.simResult.addConsumableUse(source, consumable);

        if (consumable.recoveryDuration === 0) {
            if (consumable.hitpointRestore > 0) {
                const hitpointsAdded = source.addHitpoints(consumable.hitpointRestore);
                this.simResult.addHitpointsGained(source, consumable.hrid, hitpointsAdded);
            }

            if (consumable.manapointRestore > 0) {
                const manapointsAdded = source.addManapoints(consumable.manapointRestore);
                this.simResult.addManapointsGained(source, consumable.hrid, manapointsAdded);

                // when oom check ability trigger
                if (source.isOutOfMana) {
                    const awaitCooldownEvent = new AwaitCooldownEvent(this.simulationTime, source);
                    this.eventQueue.addEvent(awaitCooldownEvent);
                }
            }
        } else {
            const consumableTickEvent = new ConsumableTickEvent(
                this.simulationTime + HOT_TICK_INTERVAL,
                source,
                consumable,
                consumable.recoveryDuration / HOT_TICK_INTERVAL,
                1
            );
            this.eventQueue.addEvent(consumableTickEvent);
        }

        for (const buff of consumable.buffs) {
            // Flat objects, so a spread is the same copy structuredClone makes
            // and fifty times quicker — this one runs on every drink tick
            const currentBuff = { ...buff };
            if (source.combatDetails.combatStats.drinkConcentration > 0 && consumable.catagoryHrid.includes('drink')) {
                currentBuff.ratioBoost *= 1 + source.combatDetails.combatStats.drinkConcentration;
                currentBuff.flatBoost *= 1 + source.combatDetails.combatStats.drinkConcentration;
                currentBuff.duration = currentBuff.duration / (1 + source.combatDetails.combatStats.drinkConcentration);
            }
            source.addBuff(currentBuff, this.simulationTime);
            const checkBuffExpirationEvent = new CheckBuffExpirationEvent(
                this.simulationTime + currentBuff.duration,
                source
            );
            this.eventQueue.addEvent(checkBuffExpirationEvent);
        }

        return true;
    }

    canUseAbility(source, ability, oomCheck) {
        if (source.combatDetails.currentHitpoints <= 0) {
            return false;
        }

        if (source.combatDetails.currentManapoints < ability.manaCost) {
            if (source.isPlayer && oomCheck) {
                this.simResult.addRanOutOfManaCount(source, true, this.simulationTime);
            }
            return false;
        }
        if (source.isPlayer && oomCheck) {
            this.simResult.addRanOutOfManaCount(source, false, this.simulationTime);
        }
        return true;
    }

    tryUseAbility(source, ability) {
        if (!this.canUseAbility(source, ability, true)) {
            return false;
        }

        if (source.isPlayer) {
            if (source.abilityManaCosts.has(ability.hrid)) {
                source.abilityManaCosts.set(ability.hrid, source.abilityManaCosts.get(ability.hrid) + ability.manaCost);
            } else {
                source.abilityManaCosts.set(ability.hrid, ability.manaCost);
            }
        }

        source.combatDetails.currentManapoints -= ability.manaCost;

        ability.lastUsed = this.simulationTime;

        const todoAbilities = [ability];

        if (source.combatDetails.combatStats.blaze > 0 && random() < source.combatDetails.combatStats.blaze) {
            todoAbilities.push(new Ability('blaze'));
        }

        if (source.combatDetails.combatStats.bloom > 0 && random() < source.combatDetails.combatStats.bloom) {
            todoAbilities.push(new Ability('bloom'));
        }

        for (const todoAbility of todoAbilities) {
            for (const abilityEffect of todoAbility.abilityEffects) {
                switch (abilityEffect.effectType) {
                    case '/ability_effect_types/buff':
                        this.processAbilityBuffEffect(source, todoAbility, abilityEffect);
                        break;
                    case '/ability_effect_types/damage':
                        this.processAbilityDamageEffect(source, todoAbility, abilityEffect);
                        break;
                    case '/ability_effect_types/heal':
                        this.processAbilityHealEffect(source, todoAbility, abilityEffect);
                        break;
                    case '/ability_effect_types/spend_hp':
                        this.processAbilitySpendHpEffect(source, todoAbility, abilityEffect);
                        break;
                    case '/ability_effect_types/revive':
                        this.processAbilityReviveEffect(source, todoAbility, abilityEffect);
                        break;
                    case '/ability_effect_types/promote': {
                        this.eventQueue.clearEventsForUnit(source);
                        const promotedMonster = this.processAbilityPromoteEffect(source, todoAbility, abilityEffect);
                        promotedMonster.reset(this.simulationTime);
                        const enemyIndex = this.enemies.indexOf(source);
                        if (enemyIndex !== -1) {
                            this.enemies[enemyIndex] = promotedMonster;
                            this.simResult.updateTimeSpentAlive(source.hrid, false, this.simulationTime);
                            this.simResult.updateTimeSpentAlive(promotedMonster.hrid, true, this.simulationTime);
                        }
                        source = promotedMonster;
                        this.addNextAttackEvent(source);
                        break;
                    }
                    default:
                        // Skipping one effect of one ability costs the damage or
                        // healing that effect would have done; throwing costs
                        // every number in the run
                        recordUnknown('ability effect type', abilityEffect.effectType, todoAbility.hrid);
                        break;
                }
            }
        }

        if (source.combatDetails.combatStats.ripple > 0 && random() < source.combatDetails.combatStats.ripple) {
            const manapointsAdded = source.addManapoints(10);
            this.simResult.addManapointsGained(source, 'ripple', manapointsAdded);
            // Gate and floor both on the haste-scaled cooldown — the same value
            // Ability.shouldTrigger() checks readiness against — rather than the
            // raw cooldownDuration. (Provably output-neutral either way: the
            // floor only ever caps how far lastUsed is pushed back, and once
            // elapsed + 2s clears the scaled cooldown the ability reads as ready
            // regardless of which duration capped it; a mismatched raw floor
            // never flips that boolean. Unified anyway so the two cooldown reads
            // in this method can't drift out of sync by accident.)
            const haste = source.combatDetails.combatStats.abilityHaste;
            for (const ab of source.abilities) {
                if (ab && ab.lastUsed) {
                    const scaledCooldown =
                        haste > 0 ? (ab.cooldownDuration * 100) / (100 + haste) : ab.cooldownDuration;
                    const remainingCooldown = ab.lastUsed + scaledCooldown - this.simulationTime;
                    if (remainingCooldown > 0) {
                        ab.lastUsed = Math.max(ab.lastUsed - ONE_SECOND * 2, this.simulationTime - scaledCooldown);
                    }
                }
            }
        }

        this.addNextAttackEvent(source);

        // Could die from reflect damage
        if (source.combatDetails.currentHitpoints === 0) {
            this.eventQueue.clearEventsForUnit(source);
            this.simResult.addDeath(source);
            if (!source.isPlayer) {
                this.simResult.updateTimeSpentAlive(source.hrid, false, this.simulationTime);
            }
        }

        this.checkEncounterEnd();

        return true;
    }

    /**
     * A special ability's buff can scale with the caster's skill level. Returns a
     * scaled clone when the buff carries that scaling, and the buff unchanged
     * otherwise — so an ordinary buff is added byte-for-byte as before. Both the
     * allAllies and self branches route through this so they can never drift.
     * @param {Object} source - The caster; its combatDetails supply the skill level.
     * @param {Object} ability - The ability applying the buff (isSpecialAbility gate).
     * @param {Object} buff - The buff definition.
     * @returns {Object} The scaled clone, or the original buff when no scaling applies.
     */
    scaledBuff(source, ability, buff) {
        if (!(ability.isSpecialAbility && buff.multiplierForSkillHrid && buff.multiplierPerSkillLevel > 0)) {
            return buff;
        }
        // combatDetails tracks only stamina/intelligence/attack/melee/defense/
        // ranged/magic levels; a buff may still name a combat skill outside that
        // set (e.g. /skills/power, whose level combatDetails folds into melee).
        // An unresolved level is undefined, and undefined * perSkillLevel is NaN,
        // which the multiply below smears onto flatBoost and ratioBoost and
        // silently poisons the buffed stat for the whole fight. No resolvable
        // level means no scaling: return the buff unchanged, exactly as the
        // pre-scaling self branch delivered it.
        const skillLevel = source.combatDetails[buff.multiplierForSkillHrid.split('/')[2] + 'Level'];
        if (!Number.isFinite(skillLevel)) {
            return buff;
        }
        const multiplier = 1.0 + skillLevel * buff.multiplierPerSkillLevel;
        const currentBuff = { ...buff };
        currentBuff.flatBoost *= multiplier;
        currentBuff.ratioBoost *= multiplier;
        return currentBuff;
    }

    processAbilityBuffEffect(source, ability, abilityEffect) {
        if (abilityEffect.targetType === 'allAllies') {
            const targets = source.isPlayer ? this.players : this.enemies;
            for (const target of targets.filter((unit) => unit && unit.combatDetails.currentHitpoints > 0)) {
                for (const buff of abilityEffect.buffs) {
                    target.addBuff(this.scaledBuff(source, ability, buff), this.simulationTime);
                    const checkBuffExpirationEvent = new CheckBuffExpirationEvent(
                        this.simulationTime + buff.duration,
                        target
                    );
                    this.eventQueue.addEvent(checkBuffExpirationEvent);
                }
            }
            return;
        }

        if (abilityEffect.targetType !== 'self') {
            recordUnknown('buff ability target type', abilityEffect.targetType, ability.hrid);
            return;
        }

        for (const buff of abilityEffect.buffs) {
            source.addBuff(this.scaledBuff(source, ability, buff), this.simulationTime);
            const checkBuffExpirationEvent = new CheckBuffExpirationEvent(this.simulationTime + buff.duration, source);
            this.eventQueue.addEvent(checkBuffExpirationEvent);
        }
    }

    processAbilityDamageEffect(source, ability, abilityEffect) {
        let targets;
        switch (abilityEffect.targetType) {
            case 'enemy':
            case 'allEnemies':
                targets = source.isPlayer ? this.enemies : this.players;
                break;
            default:
                recordUnknown('damage ability target type', abilityEffect.targetType, ability.hrid);
                targets = null;
                break;
        }

        if (!targets) {
            return;
        }

        const avoidTarget = [];

        let isSkipParry = false;

        for (let target of targets.filter((unit) => unit && unit.combatDetails.currentHitpoints > 0)) {
            let parryTarget;
            if (!isSkipParry) {
                parryTarget = this.checkParry(targets);
                isSkipParry = true; // parry check only once on first target
            }

            if (parryTarget) {
                const tempTarget = source;
                const tempSource = parryTarget;

                const attackResult = CombatUtilities.processAttack(tempSource, tempTarget, null, this.isTaskFight);

                this.simResult.addAttack(
                    tempSource,
                    tempTarget,
                    'parry',
                    attackResult.didHit ? attackResult.damageDone : 'miss',
                    attackResult.didHit && attackResult.isCrit
                );

                if (attackResult.lifeStealHeal > 0) {
                    this.simResult.addHitpointsGained(tempSource, 'lifesteal', attackResult.lifeStealHeal);
                }

                if (attackResult.manaLeechMana > 0) {
                    this.simResult.addManapointsGained(tempSource, 'manaLeech', attackResult.manaLeechMana);
                }

                if (attackResult.thornDamageDone > 0) {
                    this.simResult.addAttack(
                        tempTarget,
                        tempSource,
                        attackResult.thornType,
                        attackResult.thornDamageDone
                    );
                }
                if (tempTarget.combatDetails.combatStats.retaliation > 0) {
                    this.simResult.addAttack(
                        tempTarget,
                        tempSource,
                        'retaliation',
                        attackResult.retaliationDamageDone > 0 ? attackResult.retaliationDamageDone : 'miss'
                    );
                }

                if (tempTarget.combatDetails.currentHitpoints === 0) {
                    this.eventQueue.clearEventsForUnit(tempTarget);
                    this.simResult.addDeath(tempTarget);
                    if (!tempTarget.isPlayer) {
                        this.simResult.updateTimeSpentAlive(tempTarget.hrid, false, this.simulationTime);
                    }
                }

                // Could die from reflect damage
                if (
                    tempSource.combatDetails.currentHitpoints === 0 &&
                    (attackResult.thornDamageDone !== 0 || attackResult.retaliationDamageDone !== 0)
                ) {
                    this.eventQueue.clearEventsForUnit(tempSource);
                    this.simResult.addDeath(tempSource);
                    if (!tempSource.isPlayer) {
                        this.simResult.updateTimeSpentAlive(tempSource.hrid, false, this.simulationTime);
                    }
                }
            } else {
                targets = targets.filter(
                    (unit) => unit && !avoidTarget.includes(unit.hrid) && unit.combatDetails.currentHitpoints > 0
                );
                if (!source.isPlayer && targets.length > 0 && abilityEffect.targetType === 'enemy') {
                    let cumulativeThreat = 0;
                    const cumulativeRanges = [];
                    targets.forEach((player) => {
                        const playerThreat = player.combatDetails.combatStats.threat;
                        cumulativeThreat += playerThreat;
                        cumulativeRanges.push({
                            player: player,
                            rangeStart: cumulativeThreat - playerThreat,
                            rangeEnd: cumulativeThreat,
                        });
                    });
                    const randomValueHit = random() * cumulativeThreat;
                    target = cumulativeRanges.find(
                        (range) => randomValueHit >= range.rangeStart && randomValueHit < range.rangeEnd
                    ).player;
                    avoidTarget.push(target.hrid);
                }
                if (targets.length <= 0) {
                    break;
                }

                const attackResult = CombatUtilities.processAttack(source, target, abilityEffect, this.isTaskFight);

                if (this.zone.isDungeon && target.isPlayer && attackResult.didHit && attackResult.damageDone > 0) {
                    const log = this.generateCombatLog(source, ability.hrid, target, attackResult);
                    this.addToWipeLogs(log);
                }

                if (attackResult.hpDrain > 0) {
                    this.simResult.addHitpointsGained(source, ability.hrid, attackResult.hpDrain);
                }

                if (attackResult.didHit && abilityEffect.buffs) {
                    for (const buff of abilityEffect.buffs) {
                        target.addBuff(buff, this.simulationTime);
                        const checkBuffExpirationEvent = new CheckBuffExpirationEvent(
                            this.simulationTime + buff.duration,
                            target
                        );
                        this.eventQueue.addEvent(checkBuffExpirationEvent);
                    }
                }

                if (abilityEffect.damageOverTimeRatio > 0 && attackResult.damageDone > 0) {
                    const damageOverTimeEvent = new DamageOverTimeEvent(
                        this.simulationTime + DOT_TICK_INTERVAL,
                        source,
                        target,
                        attackResult.damageDone * abilityEffect.damageOverTimeRatio,
                        abilityEffect.damageOverTimeDuration / DOT_TICK_INTERVAL,
                        1,
                        abilityEffect.combatStyleHrid
                    );
                    this.eventQueue.addEvent(damageOverTimeEvent);
                }

                if (
                    attackResult.didHit &&
                    abilityEffect.stunChance > 0 &&
                    random() < (abilityEffect.stunChance * 100) / (100 + target.combatDetails.combatStats.tenacity)
                ) {
                    target.isStunned = true;
                    target.stunExpireTime = this.simulationTime + abilityEffect.stunDuration;
                    // Clear all 3 event types via indexed lookups instead of O(n) clearMatching
                    this.eventQueue.clearByTypeAndSource(AutoAttackEvent.type, target);
                    this.eventQueue.clearByTypeAndSource(AbilityCastEndEvent.type, target);
                    this.eventQueue.clearByTypeAndSource(StunExpirationEvent.type, target);
                    const stunExpirationEvent = new StunExpirationEvent(target.stunExpireTime, target);
                    this.eventQueue.addEvent(stunExpirationEvent);
                }

                if (
                    attackResult.didHit &&
                    abilityEffect.blindChance > 0 &&
                    random() < (abilityEffect.blindChance * 100) / (100 + target.combatDetails.combatStats.tenacity)
                ) {
                    target.isBlinded = true;
                    target.blindExpireTime = this.simulationTime + abilityEffect.blindDuration;
                    this.eventQueue.clearByTypeAndSource(BlindExpirationEvent.type, target);
                    if (this.eventQueue.clearByTypeAndSource(AutoAttackEvent.type, target)) {
                        this.addNextAttackEvent(target);
                    }
                    const blindExpirationEvent = new BlindExpirationEvent(target.blindExpireTime, target);
                    this.eventQueue.addEvent(blindExpirationEvent);
                }

                if (
                    attackResult.didHit &&
                    abilityEffect.silenceChance > 0 &&
                    random() < (abilityEffect.silenceChance * 100) / (100 + target.combatDetails.combatStats.tenacity)
                ) {
                    target.isSilenced = true;
                    target.silenceExpireTime = this.simulationTime + abilityEffect.silenceDuration;
                    this.eventQueue.clearByTypeAndSource(SilenceExpirationEvent.type, target);
                    if (this.eventQueue.clearByTypeAndSource(AbilityCastEndEvent.type, target)) {
                        this.addNextAttackEvent(target);
                    }
                    const silenceExpirationEvent = new SilenceExpirationEvent(target.silenceExpireTime, target);
                    this.eventQueue.addEvent(silenceExpirationEvent);
                }

                if (attackResult.didHit && source.combatDetails.combatStats.curse > 0) {
                    const curseExpireTime = 15000000000;
                    const currentCurseEvent = this.eventQueue.getByTypeAndSource(CurseExpirationEvent.type, target);
                    let currentCurseAmount = 0;
                    if (currentCurseEvent) currentCurseAmount = currentCurseEvent.curseAmount;
                    this.eventQueue.clearByTypeAndSource(CurseExpirationEvent.type, target);

                    const curseExpirationEvent = new CurseExpirationEvent(
                        this.simulationTime + curseExpireTime,
                        currentCurseAmount,
                        target
                    );
                    const curseBuff = {
                        uniqueHrid: '/buff_uniques/curse',
                        typeHrid: '/buff_types/damage_taken',
                        ratioBoost: 0,
                        ratioBoostLevelBonus: 0,
                        flatBoost: source.combatDetails.combatStats.curse * curseExpirationEvent.curseAmount,
                        flatBoostLevelBonus: 0,
                        startTime: '0001-01-01T00:00:00Z',
                        duration: curseExpireTime,
                    };
                    target.addBuff(curseBuff, this.simulationTime);
                    this.eventQueue.addEvent(curseExpirationEvent);
                }

                if (target.combatDetails.combatStats.weaken > 0) {
                    const weakenExpireTime = 15000000000;
                    const currentWeakenEvent = this.eventQueue.getByTypeAndSource(WeakenExpirationEvent.type, source);
                    let weakenAmount = 0;
                    if (currentWeakenEvent) weakenAmount = currentWeakenEvent.weakenAmount;
                    this.eventQueue.clearByTypeAndSource(WeakenExpirationEvent.type, source);
                    const weakenExpirationEvent = new WeakenExpirationEvent(
                        this.simulationTime + weakenExpireTime,
                        weakenAmount,
                        source
                    );
                    const weakenBuff = {
                        uniqueHrid: '/buff_uniques/weaken',
                        typeHrid: '/buff_types/damage',
                        ratioBoost: -1 * target.combatDetails.combatStats.weaken * weakenExpirationEvent.weakenAmount,
                        ratioBoostLevelBonus: 0,
                        flatBoost: 0,
                        flatBoostLevelBonus: 0,
                        startTime: '0001-01-01T00:00:00Z',
                        duration: weakenExpireTime,
                    };
                    source.addBuff(weakenBuff, this.simulationTime);
                    this.eventQueue.addEvent(weakenExpirationEvent);
                }

                if (source.combatDetails.combatStats.fury > 0) {
                    this._processFuryUpdate(source, attackResult.didHit);
                }

                this.simResult.addAttack(
                    source,
                    target,
                    ability.hrid,
                    attackResult.didHit ? attackResult.damageDone : 'miss',
                    attackResult.didHit && attackResult.isCrit
                );

                if (attackResult.thornDamageDone > 0) {
                    this.simResult.addAttack(target, source, attackResult.thornType, attackResult.thornDamageDone);
                }
                if (this.zone.isDungeon && attackResult.thornDamageDone > 0 && source.isPlayer) {
                    const log = this.buildCombatLog(
                        target,
                        attackResult.thornType,
                        source,
                        attackResult.thornDamageDone
                    );
                    this.addToWipeLogs(log);
                }

                if (target.combatDetails.combatStats.retaliation > 0) {
                    this.simResult.addAttack(
                        target,
                        source,
                        'retaliation',
                        attackResult.retaliationDamageDone > 0 ? attackResult.retaliationDamageDone : 'miss'
                    );
                }
                if (this.zone.isDungeon && attackResult.retaliationDamageDone > 0 && source.isPlayer) {
                    const log = this.buildCombatLog(target, 'retaliation', source, attackResult.retaliationDamageDone);
                    this.addToWipeLogs(log);
                }

                if (target.combatDetails.currentHitpoints === 0) {
                    this.eventQueue.clearEventsForUnit(target);
                    this.simResult.addDeath(target);
                    if (!target.isPlayer) {
                        this.simResult.updateTimeSpentAlive(target.hrid, false, this.simulationTime);
                    }
                }

                if (attackResult.didHit && abilityEffect.pierceChance > random()) {
                    continue;
                }
            }

            if (parryTarget) {
                break;
            }

            if (abilityEffect.targetType === 'enemy') {
                break;
            }
        }
    }

    processAbilityHealEffect(source, ability, abilityEffect) {
        // Checked here rather than inside CombatUtilities.processHeal, which by
        // then is mid-loop over allies with some already healed
        if (abilityEffect.combatStyleHrid !== '/combat_styles/magic') {
            recordUnknown('heal combat style', abilityEffect.combatStyleHrid, ability.hrid);
            return;
        }

        if (abilityEffect.targetType === 'allAllies') {
            const targets = source.isPlayer ? this.players : this.enemies;
            for (const target of targets.filter((unit) => unit && unit.combatDetails.currentHitpoints > 0)) {
                const amountHealed = CombatUtilities.processHeal(source, abilityEffect, target);
                this.simResult.addHitpointsGained(target, ability.hrid, amountHealed);
            }
            return;
        }

        if (abilityEffect.targetType === 'lowestHpAlly') {
            const targets = source.isPlayer ? this.players : this.enemies;
            let healTarget;
            for (const target of targets.filter((unit) => unit && unit.combatDetails.currentHitpoints > 0)) {
                if (!healTarget) {
                    healTarget = target;
                    continue;
                }
                if (
                    target.combatDetails.currentHitpoints / target.combatDetails.maxHitpoints <
                    healTarget.combatDetails.currentHitpoints / healTarget.combatDetails.maxHitpoints
                ) {
                    healTarget = target;
                }
            }

            if (healTarget) {
                const amountHealed = CombatUtilities.processHeal(source, abilityEffect, healTarget);
                this.simResult.addHitpointsGained(healTarget, ability.hrid, amountHealed);
            }
            return;
        }

        if (abilityEffect.targetType !== 'self') {
            recordUnknown('heal ability target type', abilityEffect.targetType, ability.hrid);
            return;
        }

        const amountHealed = CombatUtilities.processHeal(source, abilityEffect, source);
        this.simResult.addHitpointsGained(source, ability.hrid, amountHealed);
    }

    /**
     * Re-arm the buff expiry checks a death threw away.
     *
     * Dying clears every event naming the unit (`clearEventsForUnit`), and that
     * sweep takes the `CheckBuffExpirationEvent`s standing for buffs which were
     * still legitimately running. Nothing else prunes a buff — `removeExpiredBuffs`
     * only ever runs off one of those events — so a revived unit kept whatever it
     * was carrying until the next encounter reset, long past the buff's own
     * duration. Every still-future expiry is re-queued at its own original
     * instant, so a buff neither outlives nor loses its remaining time.
     *
     * Weaker sources are queued too, not just the effective buff: when the
     * strongest source expires first, `removeExpiredBuffs` promotes the next one,
     * and that promotion also needs an event of its own to be checked.
     *
     * @param {Object} unit - The revived unit
     */
    _rescheduleBuffExpirations(unit) {
        const expiries = new Set();
        for (const sources of unit.buffSources.values()) {
            for (const buff of sources) expiries.add(buff.startTime + buff.duration);
        }
        for (const buff of Object.values(unit.combatBuffs)) {
            expiries.add(buff.startTime + buff.duration);
        }
        for (const time of expiries) {
            // A permanent buff carries a string start time and no duration, which
            // is how it falls out here rather than being scheduled to expire
            if (Number.isFinite(time) && time > this.simulationTime) {
                this.eventQueue.addEvent(new CheckBuffExpirationEvent(time, unit));
            }
        }
    }

    processAbilityReviveEffect(source, ability, abilityEffect) {
        if (abilityEffect.targetType !== 'deadAlly') {
            recordUnknown('revive ability target type', abilityEffect.targetType, ability.hrid);
            return;
        }

        // Both checks come before the respawn event is cleared. Bailing out
        // after that point would leave the target dead with nothing scheduled
        // to bring it back — the one state this path can genuinely corrupt.
        if (abilityEffect.combatStyleHrid !== '/combat_styles/magic') {
            recordUnknown('revive combat style', abilityEffect.combatStyleHrid, ability.hrid);
            return;
        }

        const targets = source.isPlayer ? this.players : this.enemies;
        const reviveTarget = targets.find((unit) => unit && unit.combatDetails.currentHitpoints <= 0);

        if (reviveTarget) {
            this.eventQueue.clearByTypeAndHrid(PlayerRespawnEvent.type, reviveTarget.hrid);

            reviveTarget.removeExpiredBuffs(this.simulationTime);
            this._rescheduleBuffExpirations(reviveTarget);

            const amountHealed = CombatUtilities.processRevive(source, abilityEffect, reviveTarget);
            this.simResult.addHitpointsGained(reviveTarget, ability.hrid, amountHealed);

            this.addNextAttackEvent(reviveTarget);

            // A monster back on its feet has not been killed yet: take the
            // recorded death back so the adapter's kill count (and the loot it
            // prices from it) counts the spawn once, when it stays down.
            this.simResult.undoDeath(reviveTarget, this.simulationTime);
        }
    }

    processAbilityPromoteEffect(source, _ability, _abilityEffect) {
        const promotionHrids = ['/monsters/enchanted_rook', '/monsters/enchanted_knight', '/monsters/enchanted_bishop'];
        const randomPromotionIndex = Math.floor(random() * promotionHrids.length);
        return new Monster(promotionHrids[randomPromotionIndex], source.difficultyTier);
    }

    processAbilitySpendHpEffect(source, ability, abilityEffect) {
        if (abilityEffect.targetType !== 'self') {
            recordUnknown('spend hp ability target type', abilityEffect.targetType, ability.hrid);
            return;
        }

        const hpSpent = CombatUtilities.processSpendHp(source, abilityEffect);
        this.simResult.addHitpointsSpent(source, ability.hrid, hpSpent);
    }
}

export default CombatSimulator;
