/**
 * Labyrinth Combat Sim Cache
 *
 * Everything between a combat room and the simulator: the cache key a room's
 * sim is filed under, the stopping rule it runs to, the run itself, and the
 * mirror of the results in the 'labyrinth' store that keeps a reload from
 * starting over.
 *
 * Mixed into LabyrinthClearRate — the methods here read the loadout, crate
 * and gear accessors that live on the singleton alongside them.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { buildGameDataPayload, buildPlayerDTO, getCommunityBuffs } from '../combat-sim/combat-sim-adapter.js';
import {
    runLabyrinthSimulation,
    runBlindBuffProbe,
    runPlayerStatProbe,
    cancelSimulation,
} from '../combat-sim/combat-sim-runner.js';
import {
    extractMonsterAttacks,
    extractPlayerAttacks,
    summarizeSimAttacks,
    compareIncoming,
} from './labyrinth-uptime-harness.js';
import { wilsonInterval, decidedAgainst } from '../combat-sim/engine/wilson.js';
import loadoutSnapshot from './loadout-snapshot.js';
import labFightRecorder from './labyrinth-fight-recorder.js';
import { setSimConfigSource } from './labyrinth-accuracy-export.js';
import { deriveObserved, predictedFromSim, compareLab } from './labyrinth-replay-check.js';
import { roomXpPerHour } from './labyrinth-formulas.js';
import { DISCARD_LEGACY } from './labyrinth-outcomes.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { scriptVersion } from '../../utils/script-version.js';

/**
 * The zone a probe fight nominally happens in when the real one is not a zone.
 * The engine needs a Zone to construct a SimResult; the labyrinth has always
 * borrowed this one, and a guild trial borrows it for the same reason — the
 * monster comes from the labyrinth block, not from the zone's spawn table.
 */
const TRIAL_PROBE_ZONE = '/actions/combat/fly';

/**
 * What a tile says when the build it was simmed under is not the build now.
 *
 * The wording is deliberately narrow, and pinned by a test: it names exactly
 * what {@link FINGERPRINT_SPEC} checks and nothing beyond it. Under v1 that was
 * gear alone and the marker said "gear changed"; v2 added the combat skill
 * levels and v3 the ability kit and house rooms, so the check is now a build
 * check and the marker says so. Buffs and consumables are still outside it, and
 * the tooltip says which way that cuts rather than leaving it to be assumed.
 */
export const GEAR_CHANGED_MARK = 'build changed since this was computed';

/** The longer form, for the marker's own tooltip */
export const GEAR_CHANGED_DETAIL =
    'This result was simulated against a different build. Equipment and enhancement levels, combat skill ' +
    'levels, the ability kit and house rooms are compared — buffs and consumables are not, so a change to ' +
    'those is not detected here. Press Recompute to sim the rooms again.';

/**
 * Whether a cached result should be marked as computed under different gear.
 *
 * Three cases are deliberately *not* a mark, and each of them used to be the
 * obvious wrong answer:
 *
 *   - **The snapshots have not landed.** `loadoutSnapshot` fills itself from
 *     storage and gives up after a five-second deadline (`whenReady`), and
 *     until then the fingerprint is computed over an empty snapshot set — which
 *     matches nothing, so every tile on the floor would be marked stale at
 *     once, in the first seconds after a reload, when nothing has changed at
 *     all. A staleness mark that fires on every tile is not information.
 *   - **The entry predates the stored fingerprint.** Old cache records carry no
 *     fingerprint, and "unknown" is not "different"; they show their age only,
 *     exactly as they did before.
 *   - **There is no current fingerprint to compare against.** Same reasoning as
 *     the first: silence beats a guess.
 *
 * @param {string|null|undefined} stored - The fingerprint saved with the entry
 * @param {string|null|undefined} current - The fingerprint of the gear worn now
 * @param {boolean} snapshotsReady - Whether the loadout snapshot store has filled
 * @returns {boolean} Whether to mark the tile
 */
export function gearChangedSince(stored, current, snapshotsReady) {
    if (!snapshotsReady) return false;
    if (!stored || !current) return false;
    return stored !== current;
}

/**
 * The monster's ability hrids that deal no damage — its self-buffs and debuffs.
 * The uptime harness counts their casts but must not credit them incoming
 * damage: they take a turn but land no hit, and queueing one lets the next real
 * swing pay off its slot (Toughness and a guardian aura showing a damage share).
 * @param {Object} gameData - `{combatMonsterDetailMap, abilityDetailMap}`
 * @param {string} monsterHrid
 * @returns {Set<string>}
 */
function nonDamagingAbilities(gameData, monsterHrid) {
    const set = new Set();
    const monster = gameData?.combatMonsterDetailMap?.[monsterHrid];
    const abilityMap = gameData?.abilityDetailMap || {};
    for (const entry of monster?.abilities || []) {
        const hrid = entry?.abilityHrid;
        const def = hrid && abilityMap[hrid];
        if (!def) continue;
        const dealsDamage = (def.abilityEffects || []).some((e) => e.effectType === '/ability_effect_types/damage');
        if (!dealsDamage) set.add(hrid);
    }
    return set;
}

/**
 * The PLAYER's equipped ability hrids that deal no damage — heals (Rejuvenate),
 * self-buffs and auras. The outgoing uptime harness counts their casts but must
 * not queue them for a damage payoff: a heal rings no monster damage counter,
 * so a queued slot for it would swallow the next real swing's damage. Read off
 * the same ability list the sim's player is built from, so both sides of the
 * comparison agree on what the player can cast.
 * @param {Object} gameData - `{abilityDetailMap}`
 * @param {Object} dto - A player DTO (`abilities: [{hrid, level}|null]`)
 * @returns {Set<string>}
 */
function nonDamagingPlayerAbilities(gameData, dto) {
    const set = new Set();
    const abilityMap = gameData?.abilityDetailMap || {};
    for (const entry of dto?.abilities || []) {
        const hrid = entry?.hrid;
        const def = hrid && abilityMap[hrid];
        if (!def) continue;
        const dealsDamage = (def.abilityEffects || []).some((e) => e.effectType === '/ability_effect_types/damage');
        if (!dealsDamage) set.add(hrid);
    }
    return set;
}

/** Clear chances are pinned to this many percentage points either side by default */
export const DEFAULT_SIM_PRECISION_PCT = 1;
/** No room stops before this many trials, however lopsided the early ones look */
const MIN_SIM_TRIALS = 100;
/** Backstop for a rate near a coin toss, which never converges cheaply */
const MAX_SIM_TRIALS = 20000;
/**
 * Simulated-hours budget for an uncapped run — high enough that time never binds
 * before the trial cap does, so a slow, timeout-heavy room (a hard combat tile
 * whose fights each burn the two-minute limit) runs on to its precision target
 * instead of stopping at a wide "(capped)" band. The `MAX_SIM_TRIALS` backstop
 * still bounds it, so "uncapped" means "not stopped by the clock", not "forever".
 */
const UNCAPPED_SIM_HOURS = 100000;
/**
 * The safety backstop an uncapped run still stops at: 100× `MAX_SIM_TRIALS`,
 * i.e. two million fights. "Uncapped" means "not stopped by the ordinary cap
 * or by the clock" — it does not mean a pathological setup (a room whose rate
 * sits on a coin toss at a precision of ±0.1pp) may run literally forever, and
 * a browser tab that never gives an answer is worse than a wide one. Nothing
 * realistic reaches it: ±0.1pp on a 50% room needs roughly a million fights,
 * so the backstop sits beyond the tightest precision the input allows.
 */
export const UNCAPPED_MAX_SIM_TRIALS = MAX_SIM_TRIALS * 100;
/** Persisted mirror of combatCache, in the 'labyrinth' store */
const COMBAT_CACHE_STORAGE_KEY = 'labyrinthCombatSimCache';
const COMBAT_CACHE_STORE = 'labyrinth';
/**
 * Bumped when the stored shape changes — or when the simulator behind the
 * stored results does.
 *
 * A cached result is a claim about a fight, and the cache key encodes the room,
 * the gear and the stopping rule but nothing about the engine that ran it. An
 * engine fix therefore left week-old results from the *previous* simulator
 * being served as current for the whole TTL. Bumping this discards them in one
 * go, and every entry now also carries the script version it was computed under
 * (below), so a release that changes the engine drops its predecessor's results
 * without needing this constant touched at all.
 */
export const COMBAT_CACHE_STORAGE_VERSION = 2;
/** A cached sim result older than this is dropped on load rather than trusted */
const COMBAT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Newest entries kept when the persisted set is written back out */
const COMBAT_CACHE_MAX_ENTRIES = 200;
/** Quiet time after a sim result before the persisted mirror is rebuilt and written */
const COMBAT_CACHE_FLUSH_MS = 1000;
const DECISION_MIN_TRIALS = 40;
/** A room sitting exactly on the bar never decides; this is where it gives up */
const DECISION_MAX_TRIALS = 4000;
/**
 * How many times a table badge whose sim could not run is tried again, and how
 * long between tries — the floor-map tile path's own retry rule, so the two
 * badge paths give the inputs the same window to arrive.
 */
const MAX_BADGE_SIM_RETRIES = 3;
const BADGE_SIM_RETRY_MS = 2500;
/** A recorded room needs at least this many fights before a replay is worth a sim */
const MIN_REPLAY_FIGHTS = 3;
/** At most this many rooms are replayed at once, so a Replay press is bounded */
const MAX_REPLAY_GROUPS = 3;

/**
 * How tightly a room's clear chance has to be pinned down before its sim
 * stops, in percentage points either side.
 *
 * This replaced a fixed span of simulated hours, which bought trials at a
 * rate set by fight length and so measured a five-second room twenty times
 * more finely than one running the full timeout — the slow rooms being
 * exactly the marginal ones where the decision is closest.
 * @returns {number}
 */
export function getSimPrecisionPct() {
    const raw = Number(config.getSettingValue('labyrinthSimPrecision', DEFAULT_SIM_PRECISION_PCT));
    return Math.min(10, Math.max(0.1, raw || DEFAULT_SIM_PRECISION_PCT));
}

/**
 * Ceiling on a single room's sim, in simulated hours. Precision normally
 * ends the run long before this; it exists so a room whose rate sits near a
 * coin toss cannot run forever.
 * @returns {number}
 */
export function getSimHours() {
    const raw = Number(config.getSettingValue('labyrinthRecommendSimHours', 3));
    return Math.min(100, Math.max(1, Math.floor(raw) || 3));
}

/**
 * The stopping rule handed to the engine.
 * @returns {{targetHalfWidth: number, minTrials: number, maxTrials: number}}
 */
export function getSimStopRule() {
    return resolveSimStopRule();
}

/**
 * A precision in percentage points, clamped to what the inputs allow, or the
 * configured one when nothing usable was passed.
 * @param {number|null|undefined} precisionPct
 * @returns {number}
 */
export function clampPrecisionPct(precisionPct) {
    const raw = Number(precisionPct);
    if (!(raw > 0)) return getSimPrecisionPct();
    return Math.min(10, Math.max(0.1, raw));
}

/**
 * The stopping rule for one measurement sim.
 *
 * `uncapped` lifts the ordinary `MAX_SIM_TRIALS` ceiling — the thing that
 * makes a wide result report "(capped)" — to the `UNCAPPED_MAX_SIM_TRIALS`
 * backstop, so the run ends when the precision target is met rather than when
 * the fight budget runs out. It never lifts it to infinity; see the constant.
 *
 * @param {{uncapped?: boolean, precisionPct?: number}} [options]
 * @returns {{targetHalfWidth: number, minTrials: number, maxTrials: number}}
 */
export function resolveSimStopRule({ uncapped = false, precisionPct = null } = {}) {
    return {
        targetHalfWidth: clampPrecisionPct(precisionPct) / 100,
        minTrials: MIN_SIM_TRIALS,
        maxTrials: uncapped ? UNCAPPED_MAX_SIM_TRIALS : MAX_SIM_TRIALS,
    };
}

/**
 * The stopping rule for a decision sim — "is this room above or below the
 * bar", which is far cheaper than measuring its rate. Uncapped raises the
 * give-up point by the same factor, so a room sitting exactly on the bar in an
 * uncapped automation run gets a real attempt at deciding before it gives up.
 * @param {{uncapped?: boolean, decideAgainst: number}} options
 * @returns {{decideAgainst: number, minTrials: number, maxTrials: number}}
 */
export function resolveDecisionStopRule({ uncapped = false, decideAgainst }) {
    return {
        decideAgainst,
        minTrials: DECISION_MIN_TRIALS,
        maxTrials: uncapped ? DECISION_MAX_TRIALS * 100 : DECISION_MAX_TRIALS,
    };
}

/**
 * The simulated-hours ceiling for a run. An uncapped run lifts it high enough
 * that the clock never binds before the trial backstop does.
 * @param {boolean} [uncapped]
 * @returns {number}
 */
export function resolveSimHours(uncapped = false) {
    return uncapped ? UNCAPPED_SIM_HOURS : getSimHours();
}

/**
 * The precision the Automation tab's own sims run to, in percentage points.
 *
 * Its own knob, because the per-room table and the floor map are asking
 * different questions: the map wants an answer about the room you are standing
 * in front of now, the table wants a plan, and a plan is worth waiting longer
 * for. Unset (0) means "whatever the map is using", which is what every
 * automation sim did before this existed — so an untouched install keeps its
 * cached results, which are keyed on the precision they were run at.
 * @returns {number}
 */
export function getAutomationSimPrecisionPct() {
    return clampPrecisionPct(config.getSettingValue('labyrinthAutomationSimPrecision', 0));
}

/**
 * Whether the Automation tab's sims ignore the fight ceiling and run to their
 * precision target (bounded by the backstop above).
 * @returns {boolean}
 */
export function getAutomationUncapped() {
    return config.getSetting('labyrinthAutomationUncapped') === true;
}

/**
 * The options every automation-side sim is run with — the per-room table's
 * badges and the Recommend search alike.
 * @returns {{precisionPct: number, uncapped: boolean}}
 */
export function automationSimOptions() {
    return { precisionPct: getAutomationSimPrecisionPct(), uncapped: getAutomationUncapped() };
}

// Registered rather than imported from the export module: that direction would
// put this module's whole sim/marketplace graph under a small pure one. Read at
// export time, so the file carries the settings then in force.
setSimConfigSource(() => ({ stopRule: getSimStopRule(), hours: getSimHours() }));

/** Prototype methods mixed into LabyrinthClearRate */
export const simCacheMethods = {
    /**
     * Get crate HRIDs as an array for the combat sim
     */
    getCrateHrids() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        return [
            labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ].filter(Boolean);
    },

    /**
     * Build cache key for a combat sim result
     */
    buildCombatCacheKey(monsterHrid, roomLevel, decideAgainst = null, precisionPct = null) {
        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const crateHrids = this.getCrateHrids();
        // Results from the two stopping rules must not share a slot. A decided
        // one is deliberately coarse — forty fights can leave ±12 points — and
        // a tile badge reading it would present that as a measurement.
        // The precision is part of the slot, so the Automation tab's own
        // precision files its results separately from the map's when the two
        // differ, and in the same slot when they don't.
        const mode = decideAgainst === null ? `${clampPrecisionPct(precisionPct)}pp` : `dec${decideAgainst}`;
        // The full-ability toggle changes the fight entirely, so its two states
        // must not share a cache slot — flipping it re-sims rather than serving a
        // result computed under the other rule.
        const abilities = this.labyrinthFullAbilities() ? ':fullabil' : '';
        // The labyrinth token combat upgrades (damage/attack speed/cast speed/
        // crit) are read live off characterInfo and folded into the sim as
        // extra buffs, but nothing else marks a result as theirs: buying a
        // level changes no gear, no loadout and no crate, so without this the
        // key an old result was cached under stays valid forever and a badge
        // kept quoting the pre-upgrade clear chance until an unrelated cache
        // wipe (a gear swap, a version bump) happened to clear it.
        const upgrades = this.getLabyrinthCombatBuffs()
            .map((buff) => `${buff.typeHrid}=${buff.ratioBoost || 0}|${buff.flatBoost || 0}`)
            .join(',');
        return `${monsterHrid}:${roomLevel}:${loadoutId}:${mode}:${crateHrids.join(',')}${abilities}:${upgrades}`;
    },

    /**
     * Whether combat sims build the monster with its full ability kit rather
     * than only the tier-0 subset. Always on now: a tier-0 monster drops its
     * stun/debuff kit and the sim over-predicts clears (see Monster), and the
     * full-ability build was verified to read closer to reality, so the testing
     * toggle graduated into permanent behavior.
     * @returns {boolean}
     */
    labyrinthFullAbilities() {
        return true;
    },

    /**
     * Run one blind sim fight for a monster and return the buffs the sim applied
     * to it on its own — fed the current build, crates and community buffs, but
     * never the monster's live buffs. For the monster-stat-check "does the sim
     * even produce these effects" diagnostic.
     * @param {string} monsterHrid
     * @param {number} roomLevel
     * @returns {{produced: Array, ran: boolean, error?: string}}
     */
    async blindBuffProbe(monsterHrid, roomLevel, context = null) {
        const setup = this.probeSetup(monsterHrid, context);
        if (!setup) return { produced: [], ran: false };
        try {
            const produced = await runBlindBuffProbe({
                gameData: buildGameDataPayload(),
                playerDTOs: [setup.dto],
                zoneHrid: setup.zoneHrid,
                monsterHrid,
                roomLevel,
                crates: setup.crates,
                communityBuffs: getCommunityBuffs(),
                labyrinthCombatBuffs: setup.labyrinthCombatBuffs,
                zone: setup.zone,
            });
            return { produced, ran: true };
        } catch (error) {
            console.error('[LabyrinthSimCache] Blind buff probe failed:', error);
            return { produced: [], ran: false };
        }
    },

    /**
     * Decompose the fight's damage per ability in BOTH directions, real (from a
     * tick capture) vs sim, to localise a timing/uptime gap. Runs one normal sim
     * (many fights, for a good histogram) with the current build, reads its
     * per-ability attack tallies for both the monster→player and player→monster
     * pairs, and compares shares against the captured fight — incoming verifies
     * the sim's model of the monster, outgoing its model of YOUR rotation and
     * per-cast damage, from the same capture and the same sim run.
     * @param {string} monsterHrid
     * @param {number} roomLevel
     * @param {Array<Object>} ticks - A tick capture's `ticks`
     * @returns {Promise<{comparison: Object, real: Object, sim: Object,
     *   outgoing: {comparison: Object, real: Object, sim: Object}}|null>}
     */
    async uptimeHarness(monsterHrid, roomLevel, ticks, context = null) {
        const setup = this.probeSetup(monsterHrid, context);
        if (!setup) return null;
        const dto = setup.dto;
        const playerHrid = dto.hrid || 'player1';
        const gameData = buildGameDataPayload();
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [dto],
            zoneHrid: setup.zoneHrid,
            monsterHrid,
            roomLevel,
            crates: setup.crates,
            hours: this.getSimHours(),
            precision: this.getSimStopRule(),
            communityBuffs: getCommunityBuffs(),
            labyrinthCombatBuffs: setup.labyrinthCombatBuffs,
            fullAbilities: this.labyrinthFullAbilities(),
            zone: setup.zone,
        });
        const real = extractMonsterAttacks(ticks, { nonDamaging: nonDamagingAbilities(gameData, monsterHrid) });
        const sim = summarizeSimAttacks(simResult?.attacks?.[monsterHrid]?.[playerHrid]);
        // The outgoing direction, from the SAME capture and the SAME sim run —
        // the attack tallies already hold the player→monster pair.
        const outReal = extractPlayerAttacks(ticks, { nonDamaging: nonDamagingPlayerAbilities(gameData, dto) });
        const outSim = summarizeSimAttacks(simResult?.attacks?.[playerHrid]?.[monsterHrid]);
        return {
            comparison: compareIncoming(real, sim),
            real,
            sim,
            outgoing: { comparison: compareIncoming(outReal, outSim), real: outReal, sim: outSim },
        };
    },

    /**
     * What a diagnostic probe fights with: the labyrinth setup (the lab loadout
     * chosen for this monster, lab token buffs, crates) when the monster is a
     * labyrinth room's, or — on a regular zone's monster — the character as
     * they stand right now (equipped gear, consumables, abilities), in that
     * zone, at the unit's tier, with none of the lab extras.
     *
     * Built for the lab and opened on a zone unit, the probes used to run the
     * lab build against the zone monster and then report the player "built
     * differently" (stamina 165 vs 150 from the lab level buff, no food, the
     * lab loadout's armor) — a comparison against the wrong player entirely.
     *
     * @param {string} monsterHrid
     * @param {{zone?: {hrid: string, tier: number}, trial?: {tier: number}}|null} context -
     *   A zone fight, a guild trial, or null for the labyrinth
     * @returns {{dto: Object, zoneHrid: string, crates: Array, labyrinthCombatBuffs: Array, zone: Object|null}|null}
     */
    probeSetup(monsterHrid, context = null) {
        const trialTier = Number(context?.trial?.tier) || 0;
        if (trialTier > 0) {
            const dto = buildPlayerDTO();
            if (!dto) return null;
            // A guild trial replaces food and drinks with a flat regeneration
            // (the in-game guide, transcribed in guild-trials-math.js), so a
            // probe that fed the character their pantry would build a player
            // the trial never sees. The rest is the character as they stand:
            // no lab loadout, no crates, no lab token buffs.
            const dry = {
                ...dto,
                food: (dto.food || []).map(() => null),
                drinks: (dto.drinks || []).map(() => null),
            };
            return {
                dto: dry,
                zoneHrid: TRIAL_PROBE_ZONE,
                crates: [],
                labyrinthCombatBuffs: [],
                zone: { hrid: TRIAL_PROBE_ZONE, tier: 0 },
            };
        }
        const zone = context?.zone?.hrid ? { hrid: context.zone.hrid, tier: Number(context.zone.tier) || 0 } : null;
        if (zone) {
            const dto = buildPlayerDTO();
            if (!dto) return null;
            return { dto, zoneHrid: zone.hrid, crates: [], labyrinthCombatBuffs: [], zone };
        }
        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const dto = this.buildLabyrinthPlayerDTO(loadoutId);
        if (!dto) return null;
        return {
            dto,
            zoneHrid: '/actions/combat/fly',
            crates: this.getCrateHrids(),
            labyrinthCombatBuffs: this.getLabyrinthCombatBuffs(),
            zone: null,
        };
    },

    /**
     * Which player a probe for this monster would be built from, in words a
     * panel can print and an export can carry. Mirrors `probeSetup` exactly —
     * same context, same branch — so the label can never claim one build while
     * the probe ran another.
     * @param {string} monsterHrid
     * @param {{zone?: {hrid: string, tier: number}, trial?: {tier: number}}|null} context
     * @returns {{source: 'zone'|'labyrinth'|'trial', zoneHrid: string|null, zoneName: string|null,
     *   tier: number, loadoutName: string|null}}
     */
    probeSource(monsterHrid, context = null) {
        const trialTier = Number(context?.trial?.tier) || 0;
        if (trialTier > 0) {
            return { source: 'trial', zoneHrid: null, zoneName: null, tier: trialTier, loadoutName: null };
        }
        const zone = context?.zone?.hrid ? { hrid: context.zone.hrid, tier: Number(context.zone.tier) || 0 } : null;
        if (zone) {
            const name = dataManager.getInitClientData()?.actionDetailMap?.[zone.hrid]?.name || null;
            return { source: 'zone', zoneHrid: zone.hrid, zoneName: name, tier: zone.tier, loadoutName: null };
        }
        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const snapshot = loadoutSnapshot.snapshots?.[loadoutId];
        return {
            source: 'labyrinth',
            zoneHrid: null,
            zoneName: null,
            tier: 0,
            loadoutName: snapshot?.name || (loadoutId != null ? `Loadout #${loadoutId}` : null),
        };
    },

    /**
     * Build the sim's player for the current loadout and return its resolved
     * combatDetails at fight start — for the "player build" stat check. Room
     * level does not affect the player, but a monster is needed to run the fight.
     * @param {string} monsterHrid
     * @param {number} roomLevel
     * @param {Object|null} context - The probe context (zone, or null for the lab)
     * @param {Object|null} [playerCombatBuffs] - Combat buffs to fold onto the
     *   sim player before its stats resolve, so the panel can compare your
     *   live buffed sheet against a sim carrying the same effects
     * @returns {Promise<{base: Object, buffed: Object|null}|null>}
     */
    async simPlayerDetails(monsterHrid, roomLevel, context = null, playerCombatBuffs = null) {
        const setup = this.probeSetup(monsterHrid, context);
        if (!setup) return null;
        try {
            return await runPlayerStatProbe({
                playerCombatBuffs,
                gameData: buildGameDataPayload(),
                playerDTOs: [setup.dto],
                zoneHrid: setup.zoneHrid,
                monsterHrid,
                roomLevel,
                crates: setup.crates,
                communityBuffs: getCommunityBuffs(),
                labyrinthCombatBuffs: setup.labyrinthCombatBuffs,
                zone: setup.zone,
            });
        } catch (error) {
            console.error('[LabyrinthSimCache] Player stat probe failed:', error);
            return null;
        }
    },

    // The sim-config accessors are module functions above (exports read them
    // too); mixed in unchanged so `this.getSimStopRule()` callers keep working.
    getSimPrecisionPct,
    getSimHours,
    getSimStopRule,
    getAutomationSimPrecisionPct,
    getAutomationUncapped,
    automationSimOptions,

    /**
     * Stop whatever is being simulated right now, everywhere on this screen.
     *
     * Two levels, because a batch is not one sim: the worker running the
     * current fight is terminated (its promise rejects with 'Cancelled', which
     * `computeCombatClear` turns into a `cancelled` result), and the flag left
     * behind stops the *loop* that would otherwise start the next room. An
     * uncapped run can occupy a core for minutes, and cancelling only the
     * fight in flight would have the batch march straight into the next one.
     *
     * Nothing cached is touched: results computed before the stop stay valid
     * and stay on screen, which is the whole point of stopping rather than
     * reloading.
     */
    cancelRunningSims() {
        this._simCancelRequested = true;
        this.simQueue = [];
        // A pending badge retry is part of the batch being stopped: leaving it
        // armed would have the queue start up again seconds after the Stop
        if (this._simRetryTimer) {
            clearTimeout(this._simRetryTimer);
            this._simRetryTimer = null;
        }
        // The full teardown, not the warm-pool-preserving one: this is the path
        // a character switch takes (labyrinth-clear-rate's teardown calls it),
        // and a worker kept warm across a switch holds the departing
        // character's game data.
        cancelSimulation();
    },

    /**
     * Open a fresh cancellation scope for a batch about to start.
     */
    beginSimBatch() {
        this._simCancelRequested = false;
    },

    /**
     * The teardown epoch an async batch belongs to.
     *
     * Cancellation stops work from *starting*; this fences work already in
     * flight. Every sim loop captures this before its first `await` and
     * re-reads it afterwards: a loop whose epoch no longer matches is running
     * against a feature that has been torn down under it — a character switch
     * mid-sim — and must not write anything back. That covers the state a
     * `finally` would otherwise restore (`simRunning`, `tileCalcRunning`), the
     * cache flush and badge-retry timers it would re-arm after `disable()`
     * cancelled them, and any badge it would draw onto the arriving
     * character's board.
     * @returns {number} Current epoch
     */
    simEpoch() {
        return this._simEpoch || 0;
    },

    /**
     * Invalidate every batch in flight. Called from `disable()`, after
     * `cancelRunningSims` — cancelling makes the in-flight sim reject promptly,
     * and this makes what it unwinds into a no-op.
     * @returns {number} The new epoch
     */
    endSimEpoch() {
        this._simEpoch = this.simEpoch() + 1;
        return this._simEpoch;
    },

    /**
     * Whether the batch in progress has been cancelled.
     * @returns {boolean}
     */
    simCancelled() {
        return this._simCancelRequested === true;
    },

    /**
     * Throw away every recorded fight, so the calibration replay starts fresh.
     *
     * Separate from `resetOutcomes` (the clear-chance tallies): the two are shown
     * together under the Accuracy tab, and the Reset button clears both so the
     * whole record can be restarted — which is also what its label has always
     * promised. Clears every fingerprint, not just the current gear's.
     */
    clearRecordedFights() {
        labFightRecorder.clearRecording();
    },

    /**
     * Re-simulate the rooms the recorder captured and compare the real damage
     * rates against the sim's.
     *
     * The accuracy record asks whether the clear chance is right; this asks why
     * it is wrong, by measuring your damage rate and the monster's from the
     * recorded fights and putting each beside the same rate a fresh sim produces
     * for that monster at that room level. The comparison itself is pure and
     * lives in labyrinth-replay-check; this feeds it the sim, run with the loadout
     * you are wearing now — which is why it pools only the fights fought in that
     * same gear, by fingerprint.
     *
     * @returns {Promise<{groups: Array<Object>, pool: Object,
     *   config: {stopRule: Object, hours: number, seedPolicy: string}}>}
     */
    async replayRecordedFights() {
        const fingerprint = this._snapshotContentFingerprint();
        const attempts = labFightRecorder.recordedAttempts(fingerprint);
        const observed = deriveObserved(attempts);
        // The most-fought rooms first, and only those with enough fights to be
        // worth a sim — a couple bound the sim cost and answer the question
        const worth = observed.filter((group) => group.fights >= MIN_REPLAY_FIGHTS).slice(0, MAX_REPLAY_GROUPS);

        const groups = [];
        for (const group of worth) {
            try {
                const loadoutId = this.getLabyrinthLoadoutId(group.monsterHrid);
                const dto = this.buildLabyrinthPlayerDTO(loadoutId);
                if (!dto) continue;

                const simResult = await runLabyrinthSimulation({
                    gameData: buildGameDataPayload(),
                    playerDTOs: [dto],
                    zoneHrid: '/actions/combat/fly',
                    monsterHrid: group.monsterHrid,
                    roomLevel: group.roomLevel,
                    crates: this.getCrateHrids(),
                    hours: this.getSimHours(),
                    precision: this.getSimStopRule(),
                    communityBuffs: getCommunityBuffs(),
                    labyrinthCombatBuffs: this.getLabyrinthCombatBuffs(),
                    fullAbilities: this.labyrinthFullAbilities(),
                });

                const predicted = predictedFromSim(simResult, {
                    playerHrid: dto.hrid || 'player1',
                    monsterHrid: group.monsterHrid,
                });
                if (!predicted) continue;

                groups.push(compareLab(group, predicted));
            } catch (error) {
                console.error('[LabyrinthSimCache] Replaying a recorded room failed:', error);
            }
        }

        // What the pool holds for this gear, so the panel can say "12 fights over
        // 3 monsters, none with enough yet" when nothing cleared the bar
        const status = labFightRecorder.recordingStatus(fingerprint);
        // The rule the sims above ran under, for the export the result rides in.
        // Unseeded: these runs take no fixed seed, so only the distribution —
        // not the exact trial sequence — reproduces.
        return {
            groups,
            pool: status,
            config: { stopRule: this.getSimStopRule(), hours: this.getSimHours(), seedPolicy: 'unseeded' },
        };
    },

    /**
     * Experience per hour a combat room at this level would pay, from a win
     * rate and an average fight length.
     *
     * The same arithmetic computeCombatClear does, exposed so a caller holding
     * a sim result of its own (Lab Sim's Find Max) can quote a throughput
     * without re-deriving the award or forgetting the walk to the room.
     *
     * @param {number} roomLevel - The room's level
     * @param {number} avgFightSeconds - Mean length of one attempt, win or lose
     * @param {number} clearChance - 0-1
     * @returns {number} Experience per hour, 0 when the room never clears
     */
    estimateCombatXpPerHour(roomLevel, avgFightSeconds, clearChance) {
        if (!(roomLevel > 0) || !(clearChance > 0) || !(avgFightSeconds > 0)) return 0;
        const xpPerRoom = roomLevel * 50 * (1 + this.getCombatExperienceBonus());
        return roomXpPerHour(xpPerRoom, avgFightSeconds / clearChance, clearChance);
    },

    /**
     * A measured sim result already in the cache, or null.
     *
     * The precision is part of the cache key, so a caller has to ask under the
     * precision its own sims run at: the Automation table sims and stores at
     * `labyrinthAutomationSimPrecision` and looked up under the map's
     * `labyrinthSimPrecision`, which missed on every row whenever the two
     * differed. Left unset it means the map's, which is what the floor-map and
     * forecast callers want.
     * @param {string} monsterHrid
     * @param {number} roomLevel
     * @param {number|null} [precisionPct]
     * @returns {Object|null}
     */
    getCachedCombatResult(monsterHrid, roomLevel, precisionPct = null) {
        return this.combatCache.get(this.buildCombatCacheKey(monsterHrid, roomLevel, null, precisionPct)) || null;
    },

    // -------------------------------------------------------------------------
    // Persisted combat cache
    //
    // combatCache itself is only ever a plain Map — nothing here changes that,
    // or the invalidation that already governs it. This is a mirror written to
    // the 'labyrinth' store so the Map does not start empty on every reload; on
    // the way back in, an entry is trusted only if it is both fresh enough and
    // still under the gear it was simmed with, the same two questions the
    // in-memory cache is already subject to (TTL is new — nothing in-memory
    // lives long enough to need one; the gear check mirrors
    // _invalidateIfInputsChanged's own clear exactly).
    // -------------------------------------------------------------------------

    /**
     * Bring persisted combat sim results in from storage, once per session.
     *
     * Unlike `loadOutcomes`, this does not lazily load on first read:
     * `getCachedCombatResult` is called synchronously from render paths that
     * cannot await a database read, so whatever survives the reload has to
     * already be in the Map by the time those paths run. Called from
     * `initialize()`, after the gear fingerprint baseline is seeded, so the
     * gear check below has something current to compare against.
     */
    async _loadCombatCache() {
        if (this._combatCacheLoaded) return;
        this._combatCacheLoaded = true;
        try {
            const stored = await readScoped(COMBAT_CACHE_STORAGE_KEY, COMBAT_CACHE_STORE, null, DISCARD_LEGACY);
            if (!stored || stored.version !== COMBAT_CACHE_STORAGE_VERSION || !Array.isArray(stored.entries)) {
                return;
            }

            const now = Date.now();
            const currentFingerprint = this._snapshotContentFingerprint();
            const version = scriptVersion();
            for (const entry of stored.entries) {
                if (!entry?.key || !entry.result) continue;

                // A result is only as current as the simulator that produced
                // it: a build whose engine changed must not serve its
                // predecessor's numbers back as its own
                if ((entry.scriptVersion ?? null) !== version) continue;

                const age = now - Number(entry.computedAt);
                if (!Number.isFinite(age) || age > COMBAT_CACHE_TTL_MS) continue;

                // Same rule _invalidateIfInputsChanged already applies in
                // memory: gear the entry was simmed under and gear worn now
                // have to match, since the cache key alone doesn't encode it
                if (entry.snapshotFingerprint !== currentFingerprint) continue;

                const result = {
                    ...entry.result,
                    computedAt: entry.computedAt,
                    fromPersistedCache: true,
                    // Carried on the result itself, not only in the meta map,
                    // because the render path has the result and nothing else.
                    // A load-time match is not a forever match: gear can change
                    // in the same session the entry was read back in.
                    snapshotFingerprint: entry.snapshotFingerprint ?? null,
                };
                this.combatCache.set(entry.key, result);
                this._combatCacheMeta.set(entry.key, {
                    computedAt: entry.computedAt,
                    snapshotFingerprint: entry.snapshotFingerprint,
                    scriptVersion: entry.scriptVersion ?? null,
                });
            }
        } catch (error) {
            console.error('[LabyrinthClearRate] Loading cached combat sims failed:', error);
        }
    },

    /**
     * Note that a combat sim result is ready to be mirrored to storage.
     *
     * A search sims a room at a time and used to rebuild and hand the whole
     * list — up to `COMBAT_CACHE_MAX_ENTRIES` results — to the store after every
     * one of them; `storage.set` debounced the actual writes, but the list was
     * serialised per result regardless. Now the entry only marks the mirror
     * dirty, and `_flushCombatCache` builds the list once per quiet window
     * (`COMBAT_CACHE_FLUSH_MS` after the last result) or when a sim queue
     * drains, whichever comes first.
     * @param {string} cacheKey - As built by buildCombatCacheKey
     * @param {Object} _result - The sim result just cached (already sitting in
     *   combatCache under cacheKey by the time this runs; read from there
     *   rather than trusted directly, so a stripped/re-persisted entry and a
     *   freshly-simmed one build their record the same way)
     */
    _persistCombatCacheEntry(cacheKey, _result) {
        const snapshotFingerprint = this._snapshotContentFingerprint();
        this._combatCacheMeta.set(cacheKey, {
            computedAt: Date.now(),
            snapshotFingerprint,
            scriptVersion: scriptVersion(),
        });
        // Stamped on the result too, so the render path — which is handed a
        // result and has no key to look a meta record up by — can tell a sim
        // run under this gear from one run under the gear before it. Additive:
        // an entry that never gets here simply has no fingerprint, and shows
        // its age alone, which is what every entry did before.
        const cached = this.combatCache.get(cacheKey);
        if (cached) cached.snapshotFingerprint = snapshotFingerprint;

        this._combatCacheDirty = true;
        if (this._combatCacheFlushTimer) return;
        this._combatCacheFlushTimer = setTimeout(() => {
            this._combatCacheFlushTimer = null;
            this._flushCombatCache();
        }, COMBAT_CACHE_FLUSH_MS);
    },

    /**
     * Write combatCache's contents out to the 'labyrinth' store, capped to the
     * most recent `COMBAT_CACHE_MAX_ENTRIES`, if anything changed since the
     * last write.
     *
     * Built from memory rather than read-modify-written from storage:
     * `_combatCacheMeta` plus `combatCache` are already the full in-memory
     * state, loaded entries included, so a fresh read is never needed and
     * there is nothing for two quick sims to race over.
     *
     * Not awaited by callers — `storage.set` is itself debounced, so the write
     * lands a few seconds after the flush.
     * @returns {boolean} Whether a write was issued
     */
    _flushCombatCache() {
        if (this._combatCacheFlushTimer) {
            clearTimeout(this._combatCacheFlushTimer);
            this._combatCacheFlushTimer = null;
        }
        if (!this._combatCacheDirty) return false;
        this._combatCacheDirty = false;

        const entries = [];
        for (const [key, meta] of this._combatCacheMeta) {
            const cached = this.combatCache.get(key);
            if (!cached || !meta) continue;
            // A loaded entry carries fromPersistedCache/computedAt for display;
            // strip them back out so a re-persisted entry doesn't claim to have
            // been computed at the moment it was merely re-written
            const {
                computedAt: _computedAt,
                fromPersistedCache: _fromPersistedCache,
                // The fingerprint has its own field on the record below; keeping
                // a second copy inside `result` would make the two disagreeable
                snapshotFingerprint: _snapshotFingerprint,
                ...bare
            } = cached;
            entries.push({
                key,
                result: bare,
                computedAt: meta.computedAt,
                snapshotFingerprint: meta.snapshotFingerprint,
                // The simulator this result came out of. Null outside the
                // userscript sandbox, which is itself a cohort — see
                // script-version.js.
                scriptVersion: meta.scriptVersion ?? null,
            });
        }
        entries.sort((a, b) => b.computedAt - a.computedAt);
        if (entries.length > COMBAT_CACHE_MAX_ENTRIES) {
            const dropped = entries.splice(COMBAT_CACHE_MAX_ENTRIES);
            for (const entry of dropped) this._combatCacheMeta.delete(entry.key);
        }

        writeScoped(COMBAT_CACHE_STORAGE_KEY, { version: COMBAT_CACHE_STORAGE_VERSION, entries }, COMBAT_CACHE_STORE);
        return true;
    },

    /**
     * Empty the persisted mirror. Called only for a gear change, which is the
     * one event that makes a stored sim untrue.
     *
     * The other sites that touch the in-memory Map deliberately leave this
     * alone — and, since this rewrite, mostly leave the Map alone too. Clearing
     * the Map without clearing the meta is not a no-op for storage:
     * `_persistCombatCacheEntry` rebuilds the stored list from the entries
     * still in the Map, so an emptied Map quietly wrote an empty file on the
     * next sim. A search run and a precision change both used to do that, and
     * neither had any reason to.
     */
    _clearPersistedCombatCache() {
        this._combatCacheMeta.clear();
        // A flush still pending would rebuild the list from whatever the Map
        // holds and write it over the empty file
        if (this._combatCacheFlushTimer) {
            clearTimeout(this._combatCacheFlushTimer);
            this._combatCacheFlushTimer = null;
        }
        this._combatCacheDirty = false;
        writeScoped(
            COMBAT_CACHE_STORAGE_KEY,
            { version: COMBAT_CACHE_STORAGE_VERSION, entries: [] },
            COMBAT_CACHE_STORE
        );
    },

    /**
     * Throw away every cached combat sim and simulate the visible rooms again.
     *
     * The manual answer to a stale result: the cache key does not encode gear, so
     * a loadout change the game never surfaced as `loadouts_updated` (a plain
     * equip) leaves a sim cached under gear you no longer wear, and even
     * "Calculate Labyrinth" reuses it — `computeCombatClear` returns early on a
     * cache hit. Emptying both layers first forces a real re-sim.
     *
     * The invalidation baseline is re-anchored to the current gear afterwards, so
     * the very next input-change check does not see a difference and clear what
     * this just computed.
     *
     * @returns {Promise<void>}
     */
    async recomputeCombatSims(uncapped = false) {
        this.combatCache.clear();
        this._clearPersistedCombatCache();
        this._snapshotFingerprint = this._snapshotContentFingerprint();
        await this.runTileCalculation({ auto: false, uncapped: uncapped === true });
    },

    /**
     * Which rooms hold a sim computed under gear that is no longer worn.
     *
     * The same question `_markGearChanged` asks per tile, asked over the whole
     * cache instead — and with the same three abstentions, because they are the
     * reason that mark is trustworthy: snapshots that have not landed yet make
     * every entry look stale, an entry with no stored fingerprint is unknown
     * rather than different, and no current fingerprint is nothing to compare
     * against. All three answer "none", not "all".
     *
     * Counted in rooms rather than entries because that is the unit a player
     * thinks in and the unit the palette reports. One room can hold several
     * entries — a precision run and a decision-bar run, different crates,
     * different upgrades — and "12 stale rooms queued" for what is four rooms
     * on the floor would be a number that matches nothing on screen. The first
     * two colon-separated fields of a cache key are the monster and the room
     * level, and hrids carry `/` rather than `:`, so the room identity splits
     * off cleanly.
     *
     * @returns {string[]} `monsterHrid:roomLevel` per stale room, no duplicates
     */
    staleCombatCacheRooms() {
        const ready = loadoutSnapshot.snapshotsReady === true;
        if (!ready) return [];

        let current = null;
        try {
            current = this._snapshotContentFingerprint();
        } catch (error) {
            console.error('[LabyrinthClearRate] Reading the current gear fingerprint failed:', error);
            return [];
        }

        const rooms = new Set();
        for (const [cacheKey, meta] of this._combatCacheMeta) {
            if (!gearChangedSince(meta?.snapshotFingerprint, current, ready)) continue;
            const [monsterHrid, roomLevel] = String(cacheKey).split(':');
            rooms.add(`${monsterHrid}:${roomLevel}`);
        }
        return [...rooms];
    },

    /**
     * Re-sim the rooms whose cached results were computed under other gear —
     * and only if there are any.
     *
     * The count is taken before anything is dropped, because dropping is what
     * destroys the evidence: `recomputeCombatSims` empties both layers wholesale
     * (the cache key does not encode gear, so a partial drop would leave the
     * *un*stale entries to be reused under a fingerprint baseline that has since
     * moved), and after it there is nothing left to count.
     *
     * Nothing stale means nothing happens. A caller with a report to make wants
     * to say so rather than spend a minute of simulation proving the cache was
     * already right.
     *
     * @param {boolean} [uncapped] - Sim without the trial cap, as the button's toggle does
     * @returns {Promise<number>} How many rooms were queued; `0` when none were stale
     */
    async recomputeStaleCombatSims(uncapped = false) {
        const stale = this.staleCombatCacheRooms();
        if (!stale.length) return 0;
        await this.recomputeCombatSims(uncapped);
        return stale.length;
    },

    /**
     * Run combat sim for a monster room and return clear stats
     */
    async computeCombatClear(monsterHrid, roomLevel, options = {}) {
        // A bar means the caller only needs to know which side of it this room
        // falls on, which is a far cheaper question than what its rate is
        const rawBar = Number(options.decideAgainst);
        const bar = Number.isFinite(rawBar) && rawBar > 0 && rawBar < 1 ? rawBar : null;

        const uncapped = options.uncapped === true;
        const precisionPct = clampPrecisionPct(options.precisionPct);

        const cacheKey = this.buildCombatCacheKey(monsterHrid, roomLevel, bar, precisionPct);
        const cached = this.combatCache.get(cacheKey);
        // A cached result answers the question unless this run was asked to be
        // uncapped and the cached one stopped on the fight ceiling instead of
        // on precision — that wide "(capped)" band is exactly what the caller
        // ticked Uncapped to get rid of, so serving it back would make the
        // toggle do nothing.
        if (cached && !(uncapped && cached.hitTarget === false)) return cached;

        // A measured result already in hand answers a decision for free, as
        // long as its interval clears the bar — no reason to simulate again
        if (bar !== null) {
            const measured = this.combatCache.get(this.buildCombatCacheKey(monsterHrid, roomLevel, null, precisionPct));
            if (
                measured?.trials > 0 &&
                decidedAgainst(Math.round(measured.clearChance * measured.trials), measured.trials, bar)
            ) {
                return measured;
            }
        }

        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const dto = this.buildLabyrinthPlayerDTO(loadoutId);
        if (!dto) return { clearChance: 0, expectedSeconds: Infinity, failed: true };

        const gameData = buildGameDataPayload();
        // Null when the client's data sheet has not arrived yet. Handing that
        // to the worker throws inside it, which comes back as a failed run and
        // reads on a badge as a 0% clear — the same "not simmable yet" the
        // null DTO above bails on, so it bails the same way.
        if (!gameData) return { clearChance: 0, expectedSeconds: Infinity, failed: true };

        const crateHrids = this.getCrateHrids();
        const labyrinthCombatBuffs = this.getLabyrinthCombatBuffs();

        try {
            const simResult = await runLabyrinthSimulation({
                gameData,
                playerDTOs: [dto],
                zoneHrid: '/actions/combat/fly',
                monsterHrid,
                roomLevel,
                crates: crateHrids,
                // An uncapped run lifts the simulated-hours ceiling and the
                // fight ceiling alike, so a slow room runs to its precision
                // target rather than stopping wide
                hours: resolveSimHours(uncapped),
                precision:
                    bar === null
                        ? resolveSimStopRule({ uncapped, precisionPct })
                        : resolveDecisionStopRule({ uncapped, decideAgainst: bar }),
                // The character's own, the way the Lab Sim panel passes them.
                // Neither of the two the engine models — wisdom and combat drop
                // quantity — moves a win rate, so the hardcoded zeroes this
                // replaces produced the same clear chance. They are still the
                // wrong thing to tell a simulator: the sim result is cached and
                // read back by anything that wants a figure off it, and a run
                // labelled "no buffs" is one balance patch away from being read
                // as one.
                communityBuffs: getCommunityBuffs(),
                labyrinthCombatBuffs,
                // Testing lever: build the monster with its full ability kit
                // instead of only the tier-0 subset the labyrinth would drop
                fullAbilities: this.labyrinthFullAbilities(),
            });

            const attempts = simResult.labyAttemptCount || 1;
            const wins = simResult.encounters || 0;
            const winRate = wins / attempts;
            const totalTime = simResult.simulatedTime / 1e9;
            const avgTime = totalTime / attempts;

            const gameDataLocal = dataManager.getInitClientData();
            const monsterDetail = gameDataLocal?.combatMonsterDetailMap?.[monsterHrid];
            const monsterName = monsterDetail?.name || monsterHrid.replace('/monsters/', '').replace(/_/g, ' ');

            const snapshot = loadoutSnapshot.snapshots[loadoutId];
            const loadoutName = snapshot?.name || `Loadout #${loadoutId}`;

            // Failure reason: deaths mean defense is the problem, otherwise the
            // fights are timing out on the 2-minute limit (insufficient damage)
            const failures = Math.max(0, attempts - wins);
            const deaths = Math.max(0, Number(simResult.deaths?.[dto.hrid || 'player1'] || 0));
            const failedByDeath = Math.min(failures, deaths);
            const failedByTimeout = failures - failedByDeath;
            const failureReason =
                failures > 0 && winRate < 1
                    ? failedByDeath > failedByTimeout
                        ? 'Insufficient Defense'
                        : 'Insufficient Damage'
                    : '';

            // How sure the figure is, which is the point of stopping on
            // precision rather than on a clock: a rate is only as good as the
            // number of fights behind it, and that number now varies by room
            const interval = wilsonInterval(wins, attempts);

            // A labyrinth room pays on completion, not per swing, so its
            // experience is a property of the room rather than of the fight —
            // the same level-based award a skilling room gives. An earlier
            // version totalled the experience the simulated fights earned,
            // which credited losing attempts for damage they dealt and paid out
            // for rooms that were never cleared.
            const xpPerClear = roomLevel * 50 * (1 + this.getCombatExperienceBonus());
            const expectedSeconds = winRate > 0 ? avgTime / winRate : Infinity;

            const result = {
                clearChance: winRate,
                expectedSeconds,
                type: 'combat',
                winRate,
                avgFightSeconds: avgTime,
                monsterName,
                monsterHrid,
                loadoutName,
                roomLevel,
                failureReason,
                trials: attempts,
                halfWidth: interval.halfWidth,
                hitTarget: !!simResult.labyStoppedOnPrecision,
                // What clearing the room is worth, and what that works out to per
                // hour once the attempts you lose on the way — and the walk to
                // the room before each of them — are paid for. A room you never
                // clear earns nothing however long you fight it, which is
                // exactly what an unreachable room is worth.
                xpPerRoom: xpPerClear,
                xpPerHour: roomXpPerHour(xpPerClear, expectedSeconds, winRate),
            };

            // Don't cache 0% results: right after page load the loadout
            // snapshots may not be loaded yet, so a 0% can come from simming
            // with the wrong gear. Leaving it uncached lets a retry correct it.
            if (winRate > 0) {
                this.combatCache.set(cacheKey, result);
                this._persistCombatCacheEntry(cacheKey, result);
            }
            return result;
        } catch (error) {
            if (error?.message === 'Cancelled') {
                // Explicit user Stop — flag it so searches abort instead of
                // treating the kill as a genuine 0% result
                return { clearChance: 0, expectedSeconds: Infinity, failed: true, cancelled: true };
            }
            console.error('[LabyrinthClearRate] Combat sim failed:', error);
            return { clearChance: 0, expectedSeconds: Infinity, failed: true };
        }
    },

    queueCombatSim(monsterHrid, roomLevel, badge, attempt = 0) {
        this.simQueue.push({ monsterHrid, roomLevel, badge, attempt });
    },

    async processSimQueue() {
        if (this.simRunning) return;
        this.simRunning = true;
        this.beginSimBatch();
        const epoch = this.simEpoch();
        // The Automation tab's own precision and cap, not the floor map's —
        // this queue is what fills the per-room table's cached badges
        const simOptions = this.automationSimOptions();
        /** Rooms whose inputs were not ready, to be tried again shortly */
        const retry = [];
        try {
            while (this.simQueue.length > 0) {
                if (this.simCancelled() || this.simEpoch() !== epoch) break;
                const { monsterHrid, roomLevel, badge, attempt = 0 } = this.simQueue.shift();
                if (!badge.isConnected) continue;
                const result = await this.computeCombatClear(monsterHrid, roomLevel, simOptions);
                if (result?.cancelled || this.simEpoch() !== epoch) break;
                if (!badge.isConnected) continue;

                // A failed run is not a 0% clear. It means the sim's inputs were
                // not ready — loadout snapshots still loading, no client data
                // yet — and drawing it puts a confident "0% 999s" on a room that
                // is perfectly clearable. The floor-map tile path has always
                // skipped failed results and retried; this one drew them, which
                // is where the intermittent 0% combat badges came from. Leave the
                // '...' placeholder standing and come back to it.
                if (!result || result.failed) {
                    if (attempt < MAX_BADGE_SIM_RETRIES) {
                        retry.push({ monsterHrid, roomLevel, badge, attempt: attempt + 1 });
                    }
                    continue;
                }

                this.updateBadge(badge, result, roomLevel);
            }
        } finally {
            // Only the live batch owns this state. A loop torn down mid-flight
            // would otherwise clear a flag the *next* character's loop had
            // already claimed, flush an emptied cache map over that character's
            // persisted entries, and re-arm the retry timer `disable()` had just
            // cancelled — a queue restarting itself seconds after teardown.
            if (this.simEpoch() === epoch) {
                this.simRunning = false;
                // The queue draining is the end of a search; land its results now
                // rather than a flush window later
                this._flushCombatCache();
                this.refreshAutomationRunningState?.();
                if (retry.length > 0 && !this.simCancelled()) this._scheduleSimRetry(retry);
            }
        }
    },

    /**
     * Re-queue rooms whose sim inputs were not ready, after a pause — the same
     * bounded, spaced retry the floor-map tile path runs (three attempts,
     * 2500ms apart), which is long enough for the snapshot store to arrive.
     * @param {Array<{monsterHrid: string, roomLevel: number, badge: Element, attempt: number}>} entries
     * @private
     */
    _scheduleSimRetry(entries) {
        if (this._simRetryTimer) clearTimeout(this._simRetryTimer);
        this._simRetryTimer = setTimeout(() => {
            this._simRetryTimer = null;
            let queued = 0;
            for (const entry of entries) {
                // A badge the table's own rerender discarded needs no answer
                if (!entry.badge?.isConnected) continue;
                this.queueCombatSim(entry.monsterHrid, entry.roomLevel, entry.badge, entry.attempt);
                queued++;
            }
            if (queued > 0) this.processSimQueue();
        }, BADGE_SIM_RETRY_MS);
    },
};
