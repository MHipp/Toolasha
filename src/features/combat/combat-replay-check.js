/**
 * Sim accuracy
 *
 * The recorded fight, replayed against what the simulator said would happen.
 *
 * Everything else in this script that quotes a combat number gets it from the
 * simulator — the upgrade advisor, the food optimiser, the task profit cards.
 * All of them are predictions, and none of them has ever been checked against
 * the thing it predicts. A simulator that is 15% optimistic about your damage
 * will still rank two swords in the right order, so no amount of comparing its
 * own outputs will ever notice; only a real fight can.
 *
 * The recorder already keeps real fights. This reads one back, derives what
 * actually happened from it, runs the sim for the same zone with the current
 * character, and puts the two side by side.
 *
 * ## What the payloads honestly support
 *
 * A recording is `new_battle` plus the `pMap`/`mMap` of every tick, so what can
 * be derived is exactly what the damage trackers already derive:
 *
 * - **Damage dealt**, from the same attribution the Damage panel uses — a hit is
 *   a monster's `dmgCounter` rising, and the size of it is the health that went
 *   with it.
 * - **Damage taken**, likewise from the player's counter rising.
 * - **Fight length**, from the gap between one `new_battle` and the next.
 * - **Experience and loot**, from the running totals `new_battle` carries on each
 *   player — see below.
 *
 * And what it does **not** support, which matters as much:
 *
 * - **No consumables.** Nothing in the feed says a drink was sipped or food
 *   eaten. If the recording was made with different drinks up than the sim is
 *   told about, the gap is that and not the engine.
 * - **Solo only.** In a party the monsters spread their damage across everyone
 *   and the kills are the party's, so neither figure means what the solo sim
 *   means. Party recordings are refused rather than quietly mis-compared.
 *
 * ## Experience and loot, which used to be written off
 *
 * This file used to say experience and drops were "not on the combat feed at
 * all". That was wrong, and wrong in the direction that cost the most: the half
 * of the simulator's output people actually plan around went unchecked because
 * of a sentence nobody re-read.
 *
 * `new_battle` carries each player's `totalSkillExperienceMap` and
 * `totalLootMap` — the running totals for the combat action in progress. The
 * recorder keeps `new_battle` whole, so they are already in every recording ever
 * made, and no extra subscription, no clock and no correlation window is needed:
 * the gains of one fight are the difference between the totals on the battle
 * that opened it and the totals on the battle that closed it. Window attribution
 * is exact by construction, and a checkpoint or a banked segment carries it for
 * free because both are derived from the same ticks.
 *
 * A running total only ever rises. When one falls, the combat action was
 * restarted underneath the recording and the difference is not a gain — that
 * fight's gains are recorded as unknown rather than as a negative number or a
 * spike.
 *
 * **Experience is compared. Loot is not.** The simulator reports
 * `experienceGained` per skill over its run, which is the same quantity the feed
 * reports, so the two go side by side with a band measured the same way as
 * everything else. It reports **no drop table at all** — `SimResult` carries
 * drop-rate *multipliers* and nothing that says which items fell — so there is
 * no predicted count to put beside the observed one. Building one from the
 * game's drop tables would be checking the game's own numbers against
 * themselves, which is a different question, is not what this panel is for, and
 * is already answered properly by the Drop Luck model. So loot is shown as
 * observed rates only, said plainly to be information rather than a comparison.
 *
 * ## The gear is snapshotted, because it used to be guessed
 *
 * A recording used to be stamped with when it was made and nothing else, and the
 * sim ran against whatever was worn at the moment you pressed the button. Change
 * a weapon between recording and checking — or record, go and enhance something,
 * then check — and the deviation was the weapon. The panel said so, which is
 * honest and useless: the caveat covered the whole result.
 *
 * So the loadout is captured when the recording starts, and again at every
 * segment rotation, and kept on the observation. What is captured is exactly
 * what the simulator reads: {@link captureLoadoutSnapshot} takes the adapter's
 * player DTO — the same one the check would otherwise have built fresh — and
 * keeps the parts that describe the character rather than the world. The check
 * then builds a current DTO and lays the snapshot over it, so a legacy
 * observation from before this existed keeps behaving exactly as it did.
 *
 * ## Fight length includes the gap after it
 *
 * A fight is measured from its `new_battle` to the next one, which takes in the
 * three seconds of respawn that follow it. That is deliberate: the sim's clock
 * runs through the respawn too, so its damage-per-second is over wall time and
 * not over time-in-combat. Measuring only the swinging would make the observed
 * rate look higher than predicted for no reason but the definition.
 *
 * **Every rate on both sides divides by that same clock**, and it is worth being
 * explicit because the decomposition is where a mismatch would hide. Observed:
 * the sum of `new_battle`-to-`new_battle` spans, respawns included, over the
 * fights that completed. Predicted: `simulatedTime`, which is the simulator's
 * whole elapsed clock — respawn intervals, player death and walk-back included.
 * Damage per second, swings per second and experience per second are all that
 * one denominator on each side. See {@link OBSERVED_CLOCK} and
 * {@link PREDICTED_CLOCK}, which the row tooltips are written from so the two
 * cannot drift apart in words while agreeing in code.
 *
 * ## What is actually simulated, which is not the recording
 *
 * The zone and the tier, for {@link SIM_HOURS} hours, with the recorded loadout
 * laid over the current character. **Not the waves that were recorded.** The
 * engine draws its own encounters from the zone's spawn table — the same weights,
 * spawn count and strength cap the game uses, plus a boss every tenth encounter —
 * so it is the *planet*, sampled independently, and not a replay of the rooms
 * that were actually fought.
 *
 * That is the right comparison for a rate and the wrong one for a total: two
 * samples of the same zone can draw different wave mixes, and only the observed
 * side's spread is measured, so a zone with very unlike waves in it carries more
 * uncertainty than the band admits. It also means the fight count is not part of
 * the simulation at all — recording twice as long narrows the observed band and
 * changes nothing about what is predicted.
 *
 * ## Beyond sampling noise
 *
 * Six fights is a small sample and a small sample disagrees with everything. So
 * each metric carries a margin: the 95% interval on the mean of the per-fight
 * values, widened in quadrature by a flat allowance for the simulator's own
 * randomness. A deviation inside the margin is reported and not flagged — it is
 * what two samples of the same thing look like. Only what is outside it is worth
 * arguing about, and with fewer than three fights nothing is.
 *
 * ## Saying how many more fights would settle it
 *
 * The band is honest and, on its own, a dead end: "±6.4%, differences inside
 * that band are not findings" tells you the sample is too small and not what
 * would fix it. The spread is already measured, so the answer is arithmetic —
 * the margin falls as one over the square root of the sample, so the fights
 * needed to reach a given band follow from the coefficient of variation this
 * zone actually showed. {@link sampleSizeFor} says it, and the panel offers it
 * as a record target, which is the whole loop closed.
 *
 * The one thing it cannot promise is that the extra fights will look like the
 * ones already counted, and the flat simulator allowance is a floor no sample
 * size gets under — asking for a band tighter than that is refused rather than
 * answered with a number that would never arrive.
 *
 * ## Why the damage figure is taken apart
 *
 * "Your damage is 9% under the prediction" is where the check used to stop, and
 * it is one sentence short of useful: 9% under could be swinging less often,
 * landing a smaller share of swings, or hitting for less when they land, and
 * those are three completely different bugs. Damage per second is the product of
 * exactly those three, and **both sides genuinely carry all three** — the
 * attribution already counts hits and misses off the feed, and the simulator's
 * `attacks` map is a histogram of every swing it made, keyed by the damage it
 * did or by `miss`. So the headline gets decomposed, and each factor gets its
 * own noise band.
 *
 * Only the swings both sides mean the same thing by are counted: auto-attacks
 * and abilities. The simulator also records bleeds, thorns, retaliation and
 * parries through the same map, and none of those is a swing the attribution
 * would see as one — a bleed moves health without moving the hit counter, which
 * is precisely why the attribution ignores it.
 *
 * What is **not** compared, because only one side has it: crits (the simulator's
 * histogram records damage, not whether the roll crit), and the distribution of
 * fight lengths (the simulator reports a total time and an encounter count, so
 * its time-to-kill is a mean and there is nothing to put percentiles against).
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import {
    buildGameDataPayload,
    buildPlayerDTO,
    getCommunityBuffs,
    getCurrentCombatZone,
} from '../combat-sim/combat-sim-adapter.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import combatRecorder, {
    onRecordingCheckpoint,
    onRecordingComplete,
    onRecordingStopped,
    onSessionStart,
    setLoadoutProvider,
    setNoiseProvider,
    setSegmentSummarizer,
} from './combat-recorder.js';
import {
    primeRecordTarget,
    recordControlState,
    recordTarget,
    resetRecordTargetCache,
    setRecordTarget,
    toggleRecording,
    UNIT_LABELS,
} from './combat-record-control.js';
import {
    waveHridsOf,
    nonDamagingByHrid,
    extractWaveIncoming,
    mergeWaveIncoming,
    compareZoneIncoming,
    zoneUptimeMismatches,
} from './zone-uptime-harness.js';
import { describeFights, MIN_REAL_CASTS } from './labyrinth-uptime-harness.js';
import { newAttributionState, noteActions, attributeTick, foldEvents } from '../../utils/damage-attribution.js';
import { newTakenState, attributeIncoming, foldTaken } from '../../utils/damage-taken.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { formatRelativeTime, formatKMB } from '../../utils/formatters.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { scriptVersion } from '../../utils/script-version.js';
import { hashPlayerName } from './labyrinth-accuracy-export.js';

/** Below this many fights the spread of the sample says nothing about the mean */
export const MIN_SAMPLE_FIGHTS = 3;

/** Two-sided 95% normal quantile */
const Z95 = 1.96;

/**
 * The simulator's own sampling noise at {@link SIM_HOURS}, as a percentage.
 *
 * The observed side gets a margin from its own spread; the predicted side cannot,
 * because one run is one number. A flat allowance is cruder than a repeated run
 * and costs nothing, and at half a day of simulated combat the run-to-run spread
 * on damage per second is small.
 */
export const SIM_NOISE_FLOOR_PCT = 2;

/** Long enough that the prediction is steady, short enough to wait for */
export const SIM_HOURS = 12;

/**
 * The denominator every observed rate is over.
 *
 * Written once and quoted in the tooltips, because the one way a decomposition
 * can be wrong without any of its rows being wrong is for the two sides to be
 * dividing by different things.
 */
export const OBSERVED_CLOCK =
    'wall time from each battle to the next, respawn gaps included, over the fights that completed';

/** The denominator every predicted rate is over */
export const PREDICTED_CLOCK =
    "the simulator's whole elapsed clock, respawn gaps and time spent dead included — the same clock";

/**
 * Below this margin the sample is large enough to argue with.
 *
 * Nothing magic about five percent; it is the point at which the noise stops
 * being the largest term in the comparison. A simulator that is five percent out
 * is a simulator worth reporting, so a sample that cannot see five percent is a
 * sample that cannot see anything anybody would act on.
 */
export const NOISE_QUIET_PCT = 5;

/**
 * Observations kept, oldest dropped first.
 *
 * Ten was sized for recordings pressed by hand, each one a sitting. Segment
 * rotation shrank the unit: a long recording now arrives as an observation every
 * four thousand ticks, which is roughly ten minutes of combat, so ten of them is
 * under two hours and a session left running would evict its own beginning
 * before the sample was interesting.
 *
 * Twenty-four is about four hours of continuous recording, which is long enough
 * for the aggregate to be worth the disk and short enough that a rolling window
 * still does its job — gear changed or a zone left behind ages out within a
 * session rather than sitting in the sample for days. It is a cap on kept
 * observations, not on how long you can record: the recording is unbounded, the
 * *window* over it is four hours.
 */
const MAX_OBSERVATIONS = 24;

/**
 * Where past observations live.
 *
 * Scoped per character, and resolved at each read and write since the user
 * switches characters without reloading. The pre-scoping global value is
 * *discarded* rather than adopted: an observation is a record of one
 * character's damage against a zone, and comparing another character's sim to
 * it would flag a difference that is only the difference between two
 * characters.
 */
const STORAGE_KEY = 'combatReplayCheck_observations';

/**
 * Where a recording still in progress is kept, so a refresh does not end it.
 *
 * One observation, rewritten at every fight boundary — the fights so far,
 * summarized exactly as a finished recording's are. Never the raw ticks: those
 * are megabytes and arrive several times a second, and persisting them would
 * turn a recording into a write storm.
 */
const CHECKPOINT_KEY = 'combatReplayCheck_recordingCheckpoint';

/**
 * Where past check results live, so drift is visible rather than remembered.
 *
 * One run of the check is a snapshot and says nothing about whether the
 * simulator is getting worse. A short series of them does: the same zone drifting
 * from within-noise to 8% under over a fortnight is a finding no single run can
 * make. Kept small and old entries dropped — a check from two months ago was run
 * against a different character and a different engine.
 */
const HISTORY_KEY = 'combatReplayCheck_history';

/** How many past checks are kept */
const MAX_HISTORY = 8;

/** Past which age a check result describes a character and an engine that no longer exist */
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Enough to see what a zone pays; a full loot table would bury the comparison above it */
const MAX_DROP_ROWS = 8;

const DISCARD_LEGACY = { migrate: 'discard' };

const ACCENT = '#8fd0ff';

/**
 * Which unit the target box is counting in while it is empty.
 *
 * An empty box has no target and so no unit to read one off, and the toggle
 * still has to say something. Remembered here rather than persisted: it only
 * matters between clearing the box and typing the next number.
 *
 * Reset on a character switch along with the target itself (see `disable`),
 * because the unit is only remembered as a shorthand for the target that was
 * just cleared — leaving it behind means the arriving character's first typed
 * number is counted in a unit they never chose.
 */
const DEFAULT_TARGET_UNIT = 'fights';
let lastTargetUnit = DEFAULT_TARGET_UNIT;

/**
 * The DTO fields that describe the character rather than the world.
 *
 * Community buffs, labyrinth token upgrades and the moo pass are the server's
 * state and are the same for the simulated run as for the recorded one, near
 * enough; equipment, levels, abilities, house rooms, guild shrines and the
 * consumable slots are the character's, and are exactly what changes between
 * recording something and getting round to checking it.
 */
const SNAPSHOT_FIELDS = [
    'equipment',
    'abilities',
    'food',
    'drinks',
    'houseRooms',
    'guildCombatBuffs',
    'guildShrineLevels',
    'achievementCombatBuffs',
];

/** The levels the combat engine reads. Skilling levels do not enter a fight. */
const SNAPSHOT_LEVELS = [
    'staminaLevel',
    'intelligenceLevel',
    'attackLevel',
    'meleeLevel',
    'defenseLevel',
    'rangedLevel',
    'magicLevel',
];

/**
 * What was worn when the recording started.
 *
 * Read off the player DTO rather than off `characterData`, because the DTO is
 * what the simulation consumes: anything the adapter derives, normalizes or
 * renames on the way is already done, and a snapshot taken upstream of it would
 * have to repeat that work and then drift from it.
 *
 * @param {Object} [dto] - The DTO to read; built fresh when not given
 * @returns {Object|null} The snapshot, or null when the character has not loaded
 */
export function captureLoadoutSnapshot(dto = buildPlayerDTO()) {
    if (!dto) return null;

    const snapshot = { capturedAt: Date.now(), levels: {} };
    for (const key of SNAPSHOT_LEVELS) {
        if (Number.isFinite(dto[key])) snapshot.levels[key] = dto[key];
    }
    for (const key of SNAPSHOT_FIELDS) {
        if (dto[key] !== undefined && dto[key] !== null) snapshot[key] = dto[key];
    }
    return snapshot;
}

/**
 * Lay a snapshot over a freshly built DTO.
 *
 * Over rather than instead of: a snapshot carries the character and not the
 * world, so the fields it does not name — community buff levels, token upgrades,
 * the hrid the sim keys results by — come from now, which is where they are
 * correct. A missing snapshot leaves the DTO exactly as it was built, which is
 * how observations recorded before any of this existed keep working.
 *
 * @param {Object} dto - From `buildPlayerDTO`
 * @param {Object} [snapshot] - From `captureLoadoutSnapshot`
 * @returns {Object|null} A new DTO; the argument is not modified
 */
export function applyLoadoutSnapshot(dto, snapshot) {
    if (!dto) return null;
    if (!snapshot) return dto;

    const merged = { ...dto, ...snapshot.levels };
    for (const key of SNAPSHOT_FIELDS) {
        if (snapshot[key] !== undefined && snapshot[key] !== null) merged[key] = snapshot[key];
    }
    return merged;
}

/**
 * What two snapshots have to agree on to count as the same loadout.
 *
 * When it was taken is not part of it: two segments of one recording are taken
 * minutes apart and are the same kit.
 *
 * @param {Object} [snapshot] - From `captureLoadoutSnapshot`
 * @returns {string}
 */
function loadoutSignature(snapshot) {
    if (!snapshot) return 'none';
    const fields = { levels: snapshot.levels };
    for (const key of SNAPSHOT_FIELDS) fields[key] = snapshot[key] ?? null;
    return JSON.stringify(fields);
}

/**
 * A loot map as plain counts.
 *
 * The game keys `totalLootMap` by its own slot key and puts the item inside, so
 * two slots of the same item are two entries and have to be added rather than
 * overwritten.
 *
 * @param {Object} lootMap - The game's `totalLootMap`
 * @returns {Object} Item hrid to count
 */
function lootCounts(lootMap) {
    const counts = {};
    for (const entry of Object.values(lootMap || {})) {
        if (!entry?.itemHrid) continue;
        counts[entry.itemHrid] = (counts[entry.itemHrid] || 0) + (Number(entry.count) || 0);
    }
    return counts;
}

/**
 * The running totals each player carried at one battle.
 *
 * @param {Object} players - `new_battle`'s players, by index
 * @returns {Object} Index to `{xp, loot}`, both as plain totals
 */
function runningTotals(players) {
    const byIndex = {};
    for (const [index, player] of Object.entries(players || {})) {
        if (!player?.totalSkillExperienceMap && !player?.totalLootMap) continue;
        byIndex[index] = {
            xp: { ...(player.totalSkillExperienceMap || {}) },
            loot: lootCounts(player.totalLootMap),
        };
    }
    return byIndex;
}

/**
 * What was gained between two running totals.
 *
 * @param {Object} before - Totals at the start
 * @param {Object} after - Totals at the end
 * @returns {Object|null} The gains, or null when they cannot be known
 */
function gainBetween(before, after) {
    if (!before || !after) return null;

    const gains = {};
    for (const [key, value] of Object.entries(after)) {
        const gain = (Number(value) || 0) - (Number(before[key]) || 0);
        // A running total only ever rises. One that fell means the combat
        // action was restarted underneath the recording, and the difference
        // across that restart is not a gain — it is two different sessions
        if (gain < 0) return null;
        if (gain > 0) gains[key] = gain;
    }
    return gains;
}

/**
 * The gains of one fight, for whoever is being followed.
 *
 * @param {Object} opened - Running totals on the battle that opened the fight
 * @param {Object} closed - Running totals on the battle that closed it
 * @returns {{xp: Object, loot: Object}|null} Null when they cannot be known
 */
function fightGains(opened, closed) {
    const xp = gainBetween(opened?.xp, closed?.xp);
    const loot = gainBetween(opened?.loot, closed?.loot);
    if (xp === null || loot === null) return null;
    return { xp, loot };
}

/**
 * Add one map of totals into another.
 *
 * @param {Object} into - Mutated
 * @param {Object} from - Added
 */
function addInto(into, from) {
    for (const [key, value] of Object.entries(from || {})) {
        into[key] = (into[key] || 0) + value;
    }
}

/**
 * Split a recording into completed fights and tally each one.
 *
 * The battle still in progress when the recording stopped is dropped: its length
 * is unknown, and a fight cut off halfway reads as a fast one. Ticks arriving
 * before the first `new_battle` are dropped for the same reason — there is no
 * battle for them to belong to.
 *
 * @param {Array<Object>} ticks - A recording's ticks, in order
 * @returns {Array<Object>} One entry per completed fight
 */
/**
 * Give the attribution a baseline for every monster the wave opened with.
 *
 * This is the difference between counting the first hit on a monster and not
 * counting it. `mMap` is a delta, so a monster is in a tick because something
 * about it moved — and the first thing that moves about a fresh spawn is being
 * hit. The attribution refuses to score a monster's first sighting, correctly,
 * because there is no previous reading to diff against and treating one as a
 * full-health hit would invent an enormous blow at the start of every fight. But
 * `new_battle` *is* that previous reading: it names the wave and says how much
 * health each of them has before anybody swings.
 *
 * Without this, one swing per monster per fight is silently invisible — the
 * opener, every time — which on a real recording is 15-25% of every swing made
 * and the damage that went with it. It reads as a simulator predicting a swing
 * rate the character never achieves, at a kill rate that nevertheless matches
 * exactly, which is arithmetically impossible and was the tell.
 *
 * @param {Object} attribution - From `newAttributionState`, mutated
 * @param {Object} monsters - `new_battle`'s monsters, by index
 */
function seedWave(attribution, monsters) {
    for (const [index, monster] of Object.entries(monsters || {})) {
        const details = monster?.combatDetails || {};
        // Current before max: a wave can open with something already hurt, and
        // the count of swings is right either way but the damage is not
        const health = Number(
            details.currentHitpoints ?? monster?.currentHitpoints ?? details.maxHitpoints ?? monster?.maxHitpoints
        );
        if (!Number.isFinite(health)) continue;

        attribution.monstersHP[index] = health;
        attribution.dmgCounter[index] = Number(details.dmgCounter ?? monster?.dmgCounter) || 0;
        attribution.critCounter[index] = Number(details.critCounter ?? monster?.critCounter) || 0;
    }
}

export function replayFights(ticks) {
    const attribution = newAttributionState();
    const taken = newTakenState();
    const fights = [];

    let current = null;
    let monsters = {};
    // The running experience and loot totals as they stood at the battle that
    // opened the fight in progress. A fight's gains are the difference between
    // these and the same totals on the battle that closes it.
    let openedWith = {};

    for (const tick of ticks || []) {
        if (tick?.type === 'new_battle') {
            const totals = runningTotals(tick.payload?.players);

            if (current) {
                current.endAt = tick.at;
                current.seconds = Math.max(0, (tick.at - current.startAt) / 1000);
                current.gains = {};
                for (const index of Object.keys(totals)) {
                    const gained = fightGains(openedWith[index], totals[index]);
                    if (gained) current.gains[index] = gained;
                }
                // Endpoint reconciliation, the lab's honesty check ported: the
                // wave's total HP loss plus what it healed back is exactly the
                // gross damage it took, and the attribution's counter-gated
                // figure is systematically under it (bleeds ring no counter,
                // ticks merge at 3 Hz). The signed residual says by how much —
                // read from `attribution.monstersHP` here, before the wave
                // reset below wipes it, while it still holds the last readings.
                const credited = Object.values(current.players).reduce((total, p) => total + (p.damage || 0), 0);
                const startIndices = Object.keys(current.startHP || {});
                if (startIndices.length) {
                    let endpointDealt = current.healedUp;
                    for (const index of startIndices) {
                        const last = attribution.monstersHP[index];
                        endpointDealt +=
                            current.startHP[index] - (Number.isFinite(last) ? last : current.startHP[index]);
                    }
                    current.endpointDealt = endpointDealt;
                    current.unattributedDealt = endpointDealt - credited;
                } else {
                    current.endpointDealt = null;
                    current.unattributedDealt = null;
                }
                fights.push(current);
            }
            openedWith = totals;

            // Monster indices are reused every battle and mean a different
            // monster each time, so the counters they are diffed against are
            // rebuilt rather than carried over
            monsters = {};
            for (const [index, monster] of Object.entries(tick.payload?.monsters || {})) {
                if (monster?.name) monsters[index] = monster.name;
            }
            attribution.monstersHP = {};
            attribution.monstersMaxHP = {};
            attribution.dmgCounter = {};
            attribution.critCounter = {};
            taken.monsters = {};

            // Cleared and then seeded, so the wave's own opening state is what
            // the first tick is diffed against rather than nothing at all
            seedWave(attribution, tick.payload?.monsters);

            // The player is the one thing that *is* continuous across a battle
            // boundary, so `taken.playersHP` and `playersDmg` are deliberately
            // kept: resetting them would throw away the first hit of every fight
            noteActions(attribution, tick.payload?.players);

            current = {
                startAt: tick.at,
                endAt: null,
                seconds: 0,
                partySize: Object.keys(tick.payload?.players || {}).length,
                monsters: Object.values(monsters),
                players: {},
                taken: {},
                kills: 0,
                // Filled in by the battle that closes this one, since that is
                // the first moment the gains of this fight are known
                gains: {},
                // The wave's HP baselines as the snapshot stated them, copied
                // now because attributeTick overwrites the live map every tick.
                // A monster first seen mid-fight joins at its first reading —
                // the same baseline the attribution gives it, so a late join
                // cannot manufacture residual.
                startHP: { ...attribution.monstersHP },
                // Upward HP steps — the wave healing itself — accumulated from
                // the raw diffs, because the attribution's hit gate refuses
                // counterless HP movement in either direction
                healedUp: 0,
            };
            continue;
        }

        if (!current) continue;

        // The heal/spawn pre-pass, before attributeTick moves the baselines
        for (const [index, monster] of Object.entries(tick.payload?.mMap || {})) {
            const health = Number(monster?.currentHitpoints ?? monster?.cHP);
            if (!Number.isFinite(health)) continue;
            const before = attribution.monstersHP[index];
            if (before === undefined) {
                current.startHP[index] = health;
            } else if (health > before) {
                current.healedUp += health - before;
            }
        }

        const events = attributeTick(tick.payload, attribution);
        // Bound per tick rather than read from the outer `monsters`: the wave is
        // replaced at every battle, and a closure over the variable would name
        // this tick's monsters after whichever battle happened to be last
        const wave = monsters;
        foldEvents(current.players, events, {
            filterNonDamaging: true,
            nameOf: (index) => wave[index] || null,
        });
        for (const event of events) {
            if (event.isKill) current.kills += 1;
        }
        foldTaken(current.taken, attributeIncoming(tick.payload, taken));

        // After attributing, never before — see `noteActions`
        noteActions(attribution, tick.payload?.pMap);
    }

    return fights;
}

/**
 * Whose run this is: the party index that dealt the most damage.
 *
 * Solo, this is the only index there is. In a party it is a guess, which is one
 * of the reasons party recordings are not compared.
 *
 * @param {Array<Object>} fights - From `replayFights`
 * @returns {string|null}
 */
export function busiestPlayer(fights) {
    const totals = {};
    for (const fight of fights || []) {
        for (const [index, tally] of Object.entries(fight.players || {})) {
            totals[index] = (totals[index] || 0) + (tally.damage || 0);
        }
    }

    let best = null;
    for (const [index, damage] of Object.entries(totals)) {
        if (best === null || damage > totals[best]) best = index;
    }
    return best;
}

/**
 * What a recording says actually happened.
 *
 * @param {Object} recording - From `combatRecorder.recordingFile()`
 * @param {Object} [context] - `{zoneHrid, difficultyTier, recordedAt, loadout}` to stamp it with
 * @returns {Object|null} An observation, or null when there is no completed fight in it
 */
export function observeRecording(recording, context = {}) {
    const fights = replayFights(recording?.ticks);
    if (!fights.length) return null;

    const playerIndex = busiestPlayer(fights);
    if (playerIndex === null) return null;

    // Per observation rather than per fight. The band on experience needs one
    // number per fight and gets it; the item-by-item breakdown is only ever
    // read as a total, and keeping it per fight would multiply the size of a
    // stored observation by the number of distinct drops in the zone.
    const xpBySkill = {};
    const drops = {};
    let gainsSeconds = 0;
    let gainsFights = 0;
    for (const fight of fights) {
        const gained = fight.gains?.[playerIndex];
        if (!gained) continue;
        addInto(xpBySkill, gained.xp);
        addInto(drops, gained.loot);
        gainsSeconds += fight.seconds;
        gainsFights += 1;
    }

    return {
        recordedAt: context.recordedAt ?? Date.now(),
        zoneHrid: context.zoneHrid ?? null,
        difficultyTier: context.difficultyTier ?? 0,
        truncated: Boolean(recording?.truncated),
        // What was worn while these fights happened, so the check can simulate
        // that character rather than whoever is logged in when it runs
        loadout: context.loadout ?? recording?.loadout ?? null,
        // The largest party seen, since a member joining mid-recording still
        // makes the whole of it a party run
        partySize: Math.max(...fights.map((fight) => fight.partySize || 1)),
        playerIndex,
        // What the feed says was earned over exactly these fights. Absent on
        // every observation recorded before this existed, and absent on any
        // whose battles carried no running totals, which is why the seconds
        // they cover are counted separately from the run's own.
        xpBySkill,
        drops,
        gainsSeconds,
        gainsFights,
        // Only the derived numbers are kept. The raw payloads are the recorder's
        // business and are far too large to keep ten of.
        fights: fights.map((fight) => ({
            seconds: fight.seconds,
            // One number per fight, which is all the noise band needs. The split
            // between skills is a per-observation total.
            xp: fight.gains?.[playerIndex]
                ? Object.values(fight.gains[playerIndex].xp).reduce((total, value) => total + value, 0)
                : null,
            damageDealt: fight.players[playerIndex]?.damage || 0,
            damageTaken: fight.taken[playerIndex]?.damage || 0,
            regen: fight.taken[playerIndex]?.regen || 0,
            hits: fight.players[playerIndex]?.hits || 0,
            misses: fight.players[playerIndex]?.misses || 0,
            deaths: fight.taken[playerIndex]?.deaths || 0,
            kills: fight.kills,
            monsters: fight.monsters,
            // The endpoint reconciliation, null on fights replayed before it
            // existed — a reader tells "absent" from zero
            endpointDealt: fight.endpointDealt ?? null,
            unattributedDealt: fight.unattributedDealt ?? null,
        })),
    };
}

/**
 * Fold several observations of the same zone into one sample.
 *
 * More fights is a narrower margin, and a second recording of the same zone is
 * the cheapest way to get them. Only observations agreeing on the zone and tier
 * are folded — everything else would be measuring two different things.
 *
 * @param {Array<Object>} observations - From `observeRecording`
 * @returns {Object|null}
 */
export function aggregateObservations(observations) {
    const list = (observations || []).filter((entry) => entry?.fights?.length);
    if (!list.length) return null;

    const newest = list.reduce((latest, entry) => (entry.recordedAt > latest.recordedAt ? entry : latest), list[0]);
    const matching = list.filter(
        (entry) => entry.zoneHrid === newest.zoneHrid && entry.difficultyTier === newest.difficultyTier
    );

    const fights = matching.flatMap((entry) => entry.fights);
    const seconds = fights.reduce((total, fight) => total + fight.seconds, 0);
    const damageDealt = fights.reduce((total, fight) => total + fight.damageDealt, 0);
    const damageTaken = fights.reduce((total, fight) => total + fight.damageTaken, 0);
    const kills = fights.reduce((total, fight) => total + fight.kills, 0);
    const deaths = fights.reduce((total, fight) => total + fight.deaths, 0);

    // What damage per second is made of. Counted here rather than derived from
    // the totals later because an observation recorded before hits and misses
    // were kept has neither, and a zero swing count is what says "this sample
    // cannot be decomposed" rather than "this character never swung".
    const hits = fights.reduce((total, fight) => total + (fight.hits || 0), 0);
    const swings = fights.reduce((total, fight) => total + (fight.hits || 0) + (fight.misses || 0), 0);

    // The endpoint reconciliation, over only the fights that carry it — a
    // recording replayed before the residual existed contributes nothing
    // rather than a phantom zero
    const reconciled = fights.filter((fight) => Number.isFinite(fight.endpointDealt));
    const endpointDealt = reconciled.reduce((total, fight) => total + fight.endpointDealt, 0);
    const unattributedDealt = reconciled.reduce((total, fight) => total + (fight.unattributedDealt || 0), 0);

    // Experience and loot are summed over the fights whose gains were known,
    // and divided by *their* seconds rather than the run's: a sample where half
    // the fights straddled a restarted action earned over half the time
    const xpBySkill = {};
    const drops = {};
    let gainsSeconds = 0;
    let gainsFights = 0;
    for (const entry of matching) {
        addInto(xpBySkill, entry.xpBySkill);
        addInto(drops, entry.drops);
        gainsSeconds += Number(entry.gainsSeconds) || 0;
        gainsFights += Number(entry.gainsFights) || 0;
    }
    const xpTotal = Object.values(xpBySkill).reduce((total, value) => total + value, 0);

    // The newest snapshot there is, which is the one the fights nearest to now
    // were fought in. When they disagree the sample straddles a gear change and
    // no single snapshot describes all of it — that is worth saying out loud
    // rather than picking one and going quiet.
    const byNewest = [...matching].sort((left, right) => right.recordedAt - left.recordedAt);
    const loadout = byNewest.find((entry) => entry.loadout)?.loadout ?? null;
    const signatures = new Set(matching.map((entry) => loadoutSignature(entry.loadout)));

    return {
        zoneHrid: newest.zoneHrid,
        difficultyTier: newest.difficultyTier,
        partySize: Math.max(...matching.map((entry) => entry.partySize || 1)),
        truncated: matching.some((entry) => entry.truncated),
        loadout,
        mixedLoadouts: signatures.size > 1,
        recordings: matching.length,
        recordedAt: newest.recordedAt,
        oldestRecordedAt: Math.min(...matching.map((entry) => entry.recordedAt)),
        fights: fights.length,
        seconds,
        damageDealt,
        damageTaken,
        kills,
        deaths,
        hits,
        swings,
        // How much of the waves' endpoint HP loss the attribution credited.
        // Null when no fight carries the reconciliation; the residual folds
        // designed exclusions (bleeds) with 3 Hz merge loss, so it is a
        // data-quality figure, not an error
        endpointDealt: reconciled.length ? endpointDealt : null,
        unattributedDealt: reconciled.length ? unattributedDealt : null,
        dps: seconds > 0 ? damageDealt / seconds : null,
        takenPerSecond: seconds > 0 ? damageTaken / seconds : null,
        secondsPerFight: fights.length ? seconds / fights.length : null,
        swingsPerSecond: seconds > 0 && swings > 0 ? swings / seconds : null,
        hitRate: swings > 0 ? hits / swings : null,
        damagePerHit: hits > 0 ? damageDealt / hits : null,
        xpBySkill,
        drops,
        gainsSeconds,
        gainsFights,
        xpTotal,
        xpPerSecond: gainsSeconds > 0 && xpTotal > 0 ? xpTotal / gainsSeconds : null,
        samples: {
            dps: fights.map((fight) => (fight.seconds > 0 ? fight.damageDealt / fight.seconds : null)),
            takenPerSecond: fights.map((fight) => (fight.seconds > 0 ? fight.damageTaken / fight.seconds : null)),
            secondsPerFight: fights.map((fight) => fight.seconds),
            swingsPerSecond: fights.map((fight) =>
                fight.seconds > 0 && swingsIn(fight) > 0 ? swingsIn(fight) / fight.seconds : null
            ),
            hitRate: fights.map((fight) => (swingsIn(fight) > 0 ? (fight.hits || 0) / swingsIn(fight) : null)),
            damagePerHit: fights.map((fight) => (fight.hits > 0 ? fight.damageDealt / fight.hits : null)),
            // Only the fights whose gains were known. A fight that straddled a
            // restarted combat action has no experience to sample, and folding
            // it in as a zero would drag the mean towards one
            xpPerSecond: fights.map((fight) =>
                Number.isFinite(fight.xp) && fight.seconds > 0 ? fight.xp / fight.seconds : null
            ),
        },
    };
}

/**
 * How many times the player swung in one fight, landing or not.
 *
 * @param {Object} fight - One entry from an observation's `fights`
 * @returns {number}
 */
function swingsIn(fight) {
    return (fight?.hits || 0) + (fight?.misses || 0);
}

/**
 * Whether an entry in the simulator's attack map is a swing.
 *
 * The map records everything that dealt damage through one function, so bleeds,
 * thorns, retaliation and parries sit in it beside the auto-attacks. None of
 * those is a swing the attribution would count as one — a bleed moves health
 * without moving the hit counter, which is exactly why the attribution refuses
 * to credit it — so counting them here would compare two different things and
 * call the difference a simulator bug.
 *
 * @param {string} ability - The key the simulator filed the attack under
 * @returns {boolean}
 */
function isSwing(ability) {
    return ability === 'autoAttack' || ability.startsWith('/abilities/');
}

/**
 * Every swing the simulator made, as a count and a damage total.
 *
 * @param {Object} simResult - From `runSimulation`
 * @param {string} [playerHrid] - Whose swings
 * @returns {{swings: number, hits: number, damage: number}|null} Null when the
 *   result carries no attack detail, which is a run this cannot be decomposed
 */
export function predictedSwings(simResult, playerHrid = 'player1') {
    const byTarget = simResult?.attacks?.[playerHrid];
    if (!byTarget) return null;

    let swings = 0;
    let hits = 0;
    let damage = 0;

    for (const abilities of Object.values(byTarget)) {
        for (const [ability, outcomes] of Object.entries(abilities || {})) {
            if (!isSwing(ability)) continue;

            for (const [outcome, count] of Object.entries(outcomes || {})) {
                const times = Number(count) || 0;
                if (outcome === 'miss') {
                    swings += times;
                    continue;
                }
                // The key is the damage the swing did. Anything that is not a
                // number is an outcome this does not understand, and counting
                // it as a swing of unknown size would move the hit rate for a
                // reason nobody could trace
                const amount = Number(outcome);
                if (!Number.isFinite(amount)) continue;

                swings += times;
                hits += times;
                damage += amount * times;
            }
        }
    }

    return swings > 0 ? { swings, hits, damage } : null;
}

/**
 * The same figures, as the simulator predicts them.
 *
 * Damage taken is the sum of everything the monsters dealt, which is only the
 * player's share when the player is alone — hence the solo restriction.
 *
 * @param {Object} simResult - From `runSimulation`
 * @param {Object} [options] - `{playerHrid}`
 * @returns {Object|null}
 */
export function predictFromSim(simResult, { playerHrid = 'player1' } = {}) {
    const seconds = (simResult?.simulatedTime || 0) / 1e9;
    if (!(seconds > 0)) return null;

    const damageDealt = simResult.totalDamageDealt?.[playerHrid] || 0;
    let damageTaken = 0;
    for (const [hrid, damage] of Object.entries(simResult.totalDamageDealt || {})) {
        if (!hrid.startsWith('player')) damageTaken += damage;
    }

    const encounters = simResult.encounters || 0;
    const swung = predictedSwings(simResult, playerHrid);

    // The simulator names its skills bare — `attack`, `melee` — and the feed
    // names them by hrid. Keyed by hrid here, since that is what the observation
    // carries and what a row has to be labelled from
    const xpBySkill = {};
    for (const [skill, amount] of Object.entries(simResult.experienceGained?.[playerHrid] || {})) {
        if (!(amount > 0)) continue;
        xpBySkill[`/skills/${skill}`] = amount;
    }
    const xpTotal = Object.values(xpBySkill).reduce((total, value) => total + value, 0);

    return {
        seconds,
        damageDealt,
        damageTaken,
        encounters,
        deaths: simResult.deaths?.[playerHrid] || 0,
        dps: damageDealt / seconds,
        takenPerSecond: damageTaken / seconds,
        secondsPerFight: encounters > 0 ? seconds / encounters : null,
        swings: swung?.swings ?? null,
        hits: swung?.hits ?? null,
        swingsPerSecond: swung ? swung.swings / seconds : null,
        hitRate: swung ? swung.hits / swung.swings : null,
        // From the histogram rather than from `totalDamageDealt`, which also
        // carries the bleeds and thorns the swing count deliberately leaves out
        damagePerHit: swung?.hits > 0 ? swung.damage / swung.hits : null,
        xpBySkill,
        xpTotal,
        xpPerSecond: xpTotal > 0 ? xpTotal / seconds : null,
        // Nothing to put here. `SimResult` carries drop-rate multipliers and no
        // drop table, so there is no predicted count for any item — see the
        // module note on why one is not synthesised from the game data
        drops: null,
        warnings: simResult.warnings || [],
    };
}

/**
 * How far the observation sits from the prediction, as a percentage of it.
 *
 * @param {number} observed - What happened
 * @param {number} predicted - What was said would happen
 * @returns {number|null} Positive when the observation is the larger
 */
export function deviationPct(observed, predicted) {
    if (!Number.isFinite(observed) || !Number.isFinite(predicted) || predicted === 0) return null;
    return ((observed - predicted) / predicted) * 100;
}

/**
 * How far apart two samples of the same thing could land by chance.
 *
 * The 95% interval on the mean of the per-fight values, in percent of that mean,
 * widened in quadrature by the simulator's own noise — two independent sources
 * of spread add as squares, not as sums.
 *
 * @param {Array<number>} samples - One value per fight
 * @param {number} [floorPct] - Allowance for the predicted side's own randomness
 * @returns {number|null} Null when there are too few fights to say
 */
export function noiseMargin(samples, floorPct = SIM_NOISE_FLOOR_PCT) {
    const values = (samples || []).filter((value) => Number.isFinite(value));
    if (values.length < MIN_SAMPLE_FIGHTS) return null;

    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    if (!(mean > 0)) return null;

    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
    const standardError = Math.sqrt(variance / values.length);
    const samplePct = ((Z95 * standardError) / mean) * 100;

    return Math.hypot(samplePct, floorPct);
}

/**
 * How many fights it would take to get the band under a given width.
 *
 * The margin is the 95% interval on the mean, so it shrinks as one over the
 * square root of the sample — and how fast, in percent, depends only on how much
 * these fights varied relative to their mean. That ratio is already measured, so
 * the fights needed for any band follow from it directly rather than from a rule
 * of thumb about sample sizes in general.
 *
 * Two honest refusals. Fewer than {@link MIN_SAMPLE_FIGHTS} fights cannot
 * measure the spread, so there is no basis for a projection at all. And the
 * simulator's own allowance is added in quadrature and never shrinks, so a band
 * at or under it is unreachable however long anybody records — which is worth
 * saying rather than answering with a number that would never arrive.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @param {number} [targetPct] - The band wanted
 * @param {number} [floorPct] - The simulator's own allowance
 * @returns {{fights: number, marginPct: number, targetPct: number, requiredFights: number,
 *   needed: number, reachable: boolean, quiet: boolean, text: string}|null}
 */
export function sampleSizeFor(observed, targetPct = NOISE_QUIET_PCT, floorPct = SIM_NOISE_FLOOR_PCT) {
    const values = (observed?.samples?.dps || []).filter((value) => Number.isFinite(value));
    if (values.length < MIN_SAMPLE_FIGHTS) return null;

    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    if (!(mean > 0)) return null;

    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
    // The spread relative to the mean, which is the only thing about this sample
    // that carries over to a larger one
    const variation = Math.sqrt(variance) / mean;
    const marginPct = Math.hypot(((Z95 * Math.sqrt(variance / values.length)) / mean) * 100, floorPct);
    const band = marginPct >= 10 ? marginPct.toFixed(0) : marginPct.toFixed(1);
    const shared = { fights: values.length, marginPct, targetPct };

    if (marginPct <= targetPct) {
        return {
            ...shared,
            requiredFights: values.length,
            needed: 0,
            reachable: true,
            quiet: true,
            text: `±${band}% at ${values.length} fights — already under ±${targetPct}%`,
        };
    }

    // Quadrature again: the sampling term has to fit in what the floor leaves
    const room = targetPct ** 2 - floorPct ** 2;
    if (room <= 0) {
        return {
            ...shared,
            requiredFights: null,
            needed: null,
            reachable: false,
            quiet: false,
            text:
                `±${band}% at ${values.length} fights — ±${targetPct}% is inside the simulator's own ` +
                `±${floorPct}% allowance, so no sample size reaches it`,
        };
    }

    const requiredFights = Math.ceil(((Z95 * variation * 100) / Math.sqrt(room)) ** 2);
    const needed = Math.max(0, requiredFights - values.length);
    return {
        ...shared,
        requiredFights,
        needed,
        reachable: true,
        quiet: false,
        text: `±${band}% at ${values.length} fights — ≈${needed} more for ±${targetPct}%`,
    };
}

/**
 * How much of this sample is noise, said before anybody reads a number off it.
 *
 * Six fights is a small sample and a small sample disagrees with everything, so
 * the fight count on its own invites exactly the wrong reading: "six fights, 12%
 * under, the simulator is 12% out". The margin is what turns that into "six
 * fights, and six fights cannot see 12%".
 *
 * It is measured, not assumed. The rule of thumb — relative standard error is
 * about one over the square root of the sample — is only right when the spread
 * happens to equal the mean, and combat is nothing like that steady: fights
 * against the same wave land within a few percent of each other, so the real
 * margin is usually a fraction of what 1/√n would claim. The per-fight values
 * are kept on every observation, so {@link noiseMargin} uses the actual variance
 * and this reports what it found.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @returns {{fights: number, marginPct: number|null, quiet: boolean, text: string}}
 */
export function noiseSummary(observed) {
    const fights = Number(observed?.fights) || 0;
    const plural = fights === 1 ? '' : 's';
    const marginPct = noiseMargin(observed?.samples?.dps);

    if (marginPct === null) {
        return {
            fights,
            marginPct: null,
            quiet: false,
            text: `${fights} fight${plural} — too few to measure the noise; nothing here is a finding yet`,
        };
    }

    const band = marginPct >= 10 ? marginPct.toFixed(0) : marginPct.toFixed(1);
    const quiet = marginPct < NOISE_QUIET_PCT;
    return {
        fights,
        marginPct,
        quiet,
        text: quiet
            ? `${fights} fight${plural} — ±${band}% noise on this sample; large enough to argue with`
            : `${fights} fight${plural} — ±${band}% noise on this sample; ` +
              'differences inside that band are not findings',
    };
}

/**
 * One metric, observed against predicted.
 *
 * @param {Object} metric - `{key, label, observed, predicted, samples}`
 * @returns {Object} The same, plus `deviationPct`, `marginPct` and `verdict`
 */
export function compareMetric({ key, label, observed, predicted, samples }) {
    const deviation = deviationPct(observed, predicted);
    const margin = noiseMargin(samples);

    let verdict = 'insufficient';
    if (deviation !== null && margin !== null) {
        verdict = Math.abs(deviation) > margin ? 'beyond-noise' : 'within-noise';
    }

    return { key, label, observed, predicted, deviationPct: deviation, marginPct: margin, verdict };
}

/** The metrics compared, in the order they are shown */
const METRICS = [
    { key: 'dps', label: 'Damage dealt / sec' },
    { key: 'takenPerSecond', label: 'Damage taken / sec' },
    { key: 'secondsPerFight', label: 'Seconds per fight' },
];

/**
 * The three factors damage per second is the product of.
 *
 * Swings per second times the share of them that land times what a landing one
 * does *is* damage per second, so a gap in the headline is a gap in at least one
 * of these — and which one it is decides whether the suspect is attack speed,
 * accuracy or the damage roll.
 */
const DECOMPOSITION_METRICS = [
    { key: 'swingsPerSecond', label: 'Swings / sec' },
    { key: 'hitRate', label: 'Share of swings landing' },
    { key: 'damagePerHit', label: 'Damage per landed hit' },
];

/**
 * What each factor points at when it is the one outside its band.
 *
 * Hints and not verdicts: this is what usually turns out to be behind a gap in
 * that factor, ordered by nothing but experience of which is checked first.
 */
const FACTOR_HINTS = {
    swingsPerSecond:
        'Attack speed and rotation — the recorded run swung at a different rate than the engine expects. ' +
        'Haste, the ability triggers and anything that changed the cast order move this and nothing else.',
    hitRate:
        'Accuracy — a different share of swings landed than predicted. Accuracy moves sharply with the gap ' +
        'between your attack level and the zone’s defence, so this is the factor a level or an accuracy ' +
        'affix shifts first.',
    damagePerHit:
        'The damage roll — swings landed as often as predicted and did a different amount when they did. ' +
        'This is the engine’s damage arithmetic rather than the pacing of the fight.',
};

/**
 * The sim's survival claim, checked against what happened.
 *
 * The sim has always predicted deaths and the recorder has always counted
 * them, and nothing compared the two — the number that decides whether a
 * zone is safe to idle was the one output going unchecked. Deaths are rare
 * counts, so the spread is Poisson: about √expected either way, not the
 * percentage band the rate metrics use.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @param {Object} predicted - From `predictFromSim`
 * @returns {{expected:number, observed:number, sigma:number, verdict:string}|null}
 *   Null when either clock is missing
 */
export function deathCheck(observed, predicted) {
    const seconds = Number(observed?.seconds) || 0;
    const predictedSeconds = Number(predicted?.seconds) || 0;
    if (!(seconds > 0) || !(predictedSeconds > 0)) return null;

    const observedDeaths = Number(observed.deaths) || 0;
    const predictedDeaths = Number(predicted.deaths) || 0;
    // The sim's death rate, billed over the hours actually observed
    const expected = (predictedDeaths / predictedSeconds) * seconds;
    const sigma = Math.sqrt(expected);
    // A sim that says "never" has no spread to hide in: one real death against
    // an expectation of zero is beyond noise by itself — and that is the
    // failure that matters even once, because idling trusts the "never".
    const verdict =
        observedDeaths === 0 && expected === 0
            ? 'within-noise'
            : Math.abs(observedDeaths - expected) > 2 * sigma
              ? 'beyond-noise'
              : 'within-noise';
    return { expected, observed: observedDeaths, sigma, verdict };
}

/**
 * The whole comparison.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @param {Object} predicted - From `predictFromSim`
 * @returns {Object|null}
 */
export function compareRun(observed, predicted) {
    if (!observed || !predicted) return null;

    const compare = ({ key, label }) =>
        compareMetric({
            key,
            label,
            observed: observed[key],
            predicted: predicted[key],
            samples: observed.samples?.[key],
        });

    // Both sides or neither. A recording made before hits and misses were kept
    // has no swings to count, and a simulation result with no attack detail has
    // nothing to count them against — either way the honest answer is to draw
    // no decomposition rather than three rows of dashes.
    const decomposable = observed.swings > 0 && predicted.swings > 0;
    const comparableXp = observed.xpPerSecond > 0 && predicted.xpPerSecond > 0;

    return {
        fights: observed.fights,
        recordedAt: observed.recordedAt,
        oldestRecordedAt: observed.oldestRecordedAt,
        recordings: observed.recordings,
        zoneHrid: observed.zoneHrid,
        difficultyTier: observed.difficultyTier,
        observedSeconds: observed.seconds,
        predictedSeconds: predicted.seconds,
        warnings: predicted.warnings || [],
        metrics: METRICS.map(compare),
        decomposition: decomposable ? DECOMPOSITION_METRICS.map(compare) : [],
        // The total is banded like everything else. The split between skills is
        // not: it is decided by the primary and focus training on the snapshot
        // rather than by any roll, so its spread is not a sampling question and
        // a band drawn round it would be a band round nothing.
        experience: comparableXp ? compare({ key: 'xpPerSecond', label: 'Combat XP / sec' }) : null,
        experienceBySkill: comparableXp ? skillSplit(observed, predicted) : [],
        // The survival claim, checked on its own arithmetic (Poisson, not a
        // percentage band) — see deathCheck
        deathCheck: deathCheck(observed, predicted),
        // Observed only. Kept beside the comparison rather than in it, because
        // nothing here is being compared to anything.
        drops: dropRates(observed),
    };
}

/**
 * Experience per skill, on both sides, as rates.
 *
 * No verdict on any row. What this is for is the categorical mismatch a total
 * cannot show: a run whose experience all went to one skill against a prediction
 * that spread it across three is a focus-training difference, and that is
 * visible from the rows themselves without anybody pretending to have banded it.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @param {Object} predicted - From `predictFromSim`
 * @returns {Array<Object>} `{skillHrid, observed, predicted, deviationPct}`
 */
function skillSplit(observed, predicted) {
    const skills = new Set([...Object.keys(observed.xpBySkill || {}), ...Object.keys(predicted.xpBySkill || {})]);
    const rows = [];

    for (const skillHrid of skills) {
        const observedRate =
            observed.gainsSeconds > 0 ? (observed.xpBySkill[skillHrid] || 0) / observed.gainsSeconds : null;
        const predictedRate = predicted.seconds > 0 ? (predicted.xpBySkill[skillHrid] || 0) / predicted.seconds : null;
        rows.push({
            skillHrid,
            observed: observedRate,
            predicted: predictedRate,
            deviationPct: deviationPct(observedRate, predictedRate),
        });
    }

    return rows.sort((left, right) => (right.observed || 0) - (left.observed || 0));
}

/**
 * What fell, per hour, and nothing about what should have.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @returns {Array<{itemHrid: string, count: number, perHour: number}>} Commonest first
 */
export function dropRates(observed) {
    const seconds = Number(observed?.gainsSeconds) || 0;
    if (!(seconds > 0)) return [];

    return Object.entries(observed.drops || {})
        .map(([itemHrid, count]) => ({ itemHrid, count, perHour: (count / seconds) * 3600 }))
        .sort((left, right) => right.count - left.count);
}

/**
 * What to look at first, when something is outside its band.
 *
 * Every one of these is a guess. They are ordered by how often each turns out to
 * be the cause rather than by anything in this sample, and a known difference —
 * no gear snapshot, a sample straddling a gear change — outranks a guess because
 * it is not one. Nothing is offered at all while everything is inside its band:
 * a deviation the sample cannot see does not need explaining.
 *
 * @param {Object} comparison - From `compareRun`
 * @param {Object} observed - From `aggregateObservations`
 * @returns {Array<string>} Empty when there is nothing to explain
 */
export function deviationHints(comparison, observed) {
    const beyond = (metrics) => (metrics || []).filter((metric) => metric.verdict === 'beyond-noise');
    const flagged = beyond(comparison?.metrics);
    const factors = beyond(comparison?.decomposition);
    const xpOff = comparison?.experience?.verdict === 'beyond-noise';
    if (!flagged.length && !factors.length && !xpOff) return [];

    const hints = [];

    // A known difference before any guess: without a snapshot the simulated
    // character is simply not the one that was recorded, and no other hint
    // matters until that is ruled out
    if (!observed?.loadout) {
        hints.push(
            'Gear drift — this recording predates loadout snapshots, so the simulation ran against what is worn ' +
                'now. Anything enhanced, swapped or levelled since the recording is being read as a deviation.'
        );
    } else if (observed.mixedLoadouts) {
        hints.push(
            'Gear drift — these fights were not all fought in the same kit, and only the newest snapshot was ' +
                'simulated. Press Forget and record the zone again in one loadout before reading anything off this.'
        );
    }

    // The most specific thing this check can say, and only when it is specific:
    // one factor outside its band names a suspect, two or three name nothing
    if (factors.length === 1) {
        hints.push(FACTOR_HINTS[factors[0].key] ?? `The gap is in ${factors[0].label.toLowerCase()}.`);
    } else if (comparison?.decomposition?.length && !factors.length && flagged.some((m) => m.key === 'dps')) {
        hints.push(
            'Damage per second is outside its band while swing rate, hit share and damage per hit are each ' +
                'inside theirs — so the gap is spread thinly across all three, or it is in something they do ' +
                'not cover, such as a bleed, a proc or the respawn gap between fights.'
        );
    }

    if (flagged.some((metric) => metric.key === 'dps' || metric.key === 'takenPerSecond')) {
        hints.push(
            'Consumables — the drink and food slots were captured, but nothing on the combat feed says whether ' +
                'they were actually up. A run that emptied its coffee halfway through records as a full loadout ' +
                'and simulates as one.'
        );
    }

    if (xpOff) {
        // Experience earns its own suspect list: it is the one metric with a
        // multiplier stack that the combat numbers do not share
        hints.push(
            'Experience buffs — experience per hour rides on wisdom drinks, house rooms, community buffs and the ' +
                'level gap to the zone. The kit was snapshotted, but whether a wisdom coffee was actually up is ' +
                'not on the feed, and a run brewed differently from the simulated one differs here and nowhere ' +
                'else. Check the per-skill split below before suspecting the engine: experience going to ' +
                'different skills is a focus-training difference, not an accuracy one.'
        );
    }

    if (observed?.deaths > 0) {
        hints.push(
            `Deaths — ${observed.deaths} in this sample. The time spent dead and walking back is on the observed ` +
                'clock, so a sample with deaths in it reads slower than one without.'
        );
    }

    return hints;
}

/**
 * One check, as it will be remembered.
 *
 * @param {Object} comparison - From `compareRun`
 * @param {number} [at] - When it was run
 * @returns {Object|null} Null when the check produced no deviation to record
 */
export function historyEntry(comparison, at = Date.now()) {
    const dps = comparison?.metrics?.find((metric) => metric.key === 'dps');
    if (!dps || dps.deviationPct === null) return null;

    return {
        at,
        zoneHrid: comparison.zoneHrid ?? null,
        difficultyTier: comparison.difficultyTier ?? 0,
        fights: comparison.fights ?? 0,
        deviationPct: dps.deviationPct,
        marginPct: dps.marginPct,
        verdict: dps.verdict,
        // The engine that made the prediction being deviated from. Rows from
        // different engines are not a drift, and without this the history
        // cannot say which rows those are.
        v: scriptVersion(),
    };
}

/**
 * The history, trimmed to what is still worth showing.
 *
 * By age as well as by count: a check from two months ago was run against a
 * different character, a different engine and probably a different zone, and
 * leaving it at the top of the table invites reading a drift that is really
 * three unrelated measurements in a row.
 *
 * @param {Array<Object>} entries - Past entries, in any order
 * @param {number} [now] - The clock
 * @returns {Array<Object>} Oldest first, at most {@link MAX_HISTORY}
 */
export function pruneHistory(entries, now = Date.now()) {
    return (entries || [])
        .filter((entry) => Number.isFinite(entry?.at) && now - entry.at <= HISTORY_MAX_AGE_MS)
        .sort((left, right) => left.at - right.at)
        .slice(-MAX_HISTORY);
}

/**
 * The one line the overlay tile carries.
 *
 * @param {Object} comparison - From `compareRun`
 * @returns {string}
 */
export function summaryLine(comparison) {
    const dps = comparison?.metrics?.find((metric) => metric.key === 'dps');
    if (!dps || dps.deviationPct === null) return 'No sim check yet';

    const fights = comparison.fights;
    const magnitude = Math.abs(dps.deviationPct).toFixed(1);
    const direction = dps.deviationPct < 0 ? 'under' : 'over';

    if (dps.verdict === 'insufficient') {
        return `${fights} fight${fights === 1 ? '' : 's'}: ${magnitude}% ${direction} predicted DPS (too few to judge)`;
    }
    if (dps.verdict === 'within-noise') {
        return `Last ${fights} fights: ${magnitude}% ${direction} predicted DPS (within noise)`;
    }
    return `Last ${fights} fights ran ${magnitude}% ${direction} predicted DPS`;
}

/**
 * The ink a verdict is drawn in.
 *
 * Only a deviation the sample can actually see gets a colour. Within-noise used
 * to be green, which read as "checked, and fine" — but it is not a finding
 * either way: a six-fight sample agreeing with the simulator to within its own
 * twenty percent margin has established nothing at all. Dim is what "the sample
 * cannot tell" looks like, and it is the same dim as too-few-fights because it
 * is the same statement.
 */
function verdictColor(verdict) {
    if (verdict === 'beyond-noise') return ROW_COLORS.bad;
    return ROW_COLORS.dim;
}

/**
 * A metric's value, formatted for what it measures.
 *
 * @param {string} key - Which metric
 * @param {number} value - What it read
 * @returns {string}
 */
function formatMetric(key, value) {
    if (!Number.isFinite(value)) return '—';
    if (key === 'secondsPerFight') return `${value.toFixed(1)}s`;
    if (key === 'hitRate') return `${(value * 100).toFixed(1)}%`;
    if (key === 'swingsPerSecond') return value.toFixed(2);
    // Per hour, because nobody thinks about experience per second
    if (key === 'xpPerSecond') return `${formatKMB(value * 3600, 1)}/h`;
    return formatKMB(value, 1);
}

/**
 * A skill hrid as its name.
 * @param {string} skillHrid - e.g. `/skills/attack`
 * @returns {string}
 */
function skillName(skillHrid) {
    const bare =
        String(skillHrid || '')
            .split('/')
            .pop() || skillHrid;
    return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/**
 * An item hrid as its name, or as itself when the client has not said.
 * @param {string} itemHrid - e.g. `/items/coin`
 * @returns {string}
 */
function itemName(itemHrid) {
    return (
        dataManager.getItemDetails?.(itemHrid)?.name ||
        String(itemHrid || '')
            .split('/')
            .pop() ||
        itemHrid
    );
}

/**
 * The zone's name, or its hrid when the client has not said.
 * @param {string} zoneHrid - The zone
 * @returns {string}
 */
function zoneName(zoneHrid) {
    if (!zoneHrid) return 'Unknown zone';
    return dataManager.getInitClientData()?.actionDetailMap?.[zoneHrid]?.name || zoneHrid;
}

/**
 * What identifies an observation, closely enough to notice it twice.
 *
 * The fight count and the first fight's damage would collide across the segments
 * of one long recording sooner or later; the total is what makes two segments of
 * the same length distinguishable.
 *
 * @param {Object} observation - From `observeRecording`
 * @returns {string}
 */
function observationSignature(observation) {
    const fights = observation?.fights || [];
    const total = fights.reduce((sum, fight) => sum + (fight.damageDealt || 0), 0);
    return `${fights.length}:${fights[0]?.damageDealt}:${total}`;
}

/** Oldest first, the order both lists are kept in */
const oldestFirst = (field) => (a, b) => (Number(a?.[field]) || 0) - (Number(b?.[field]) || 0);

/**
 * The observations on disk, kept through the shared load/save discipline: a
 * read that could not be made keeps what is in memory, and a save folds in
 * what another tab stored rather than overwriting it. An observation's
 * identity is the same signature `remember` dedupes on; the newest
 * MAX_OBSERVATIONS survive the fold.
 */
/**
 * Fold two copies of the observation list together, newest MAX_OBSERVATIONS
 * surviving. An observation's identity is the signature `remember` dedupes on.
 * @param {Array<Object>} stored - The base copy
 * @param {Array<Object>} memory - The copy folded on top
 * @returns {Array<Object>} Union, oldest first
 */
function mergeObservations(stored, memory) {
    return mergeById(observationSignature, oldestFirst('recordedAt'))(stored, memory).slice(-MAX_OBSERVATIONS);
}

/**
 * Fold two copies of the check history together, newest MAX_HISTORY surviving.
 * @param {Array<Object>} stored - The base copy
 * @param {Array<Object>} memory - The copy folded on top
 * @returns {Array<Object>} Union, oldest first
 */
function mergeCheckHistory(stored, memory) {
    return pruneHistory(mergeById((entry) => entry?.at)(stored, memory));
}

const observationRecord = createPersistedRecord({
    base: STORAGE_KEY,
    store: 'settings',
    empty: () => [],
    merge: mergeObservations,
    migrate: 'discard',
    label: 'ReplayCheck',
});

/** The check history, same discipline; a check is identified by when it ran */
const historyRecord = createPersistedRecord({
    base: HISTORY_KEY,
    store: 'settings',
    empty: () => [],
    merge: mergeCheckHistory,
    migrate: 'discard',
    label: 'ReplayCheck',
});

/*
 * Registered so a cross-device sync PULL combines these two records instead of
 * overwriting them. Both only ever gain entries, and both live in the `settings`
 * store, which every sync scope carries — so an unregistered key here is written
 * whole by `importEverything` on the smallest sync a player can configure. That
 * throws away every recording the pulling device observed and every check it ran
 * that the sending device had never seen, silently: a replay check is a claim
 * about the simulator's accuracy, and it is only as good as the runs behind it.
 *
 * The folds are the same pure `(base, fresh)` functions two tabs on one machine
 * already share. Registration runs at import time, long before the earliest pull
 * (the staggered startup pull, 20s+ after load). See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: 'settings',
    base: STORAGE_KEY,
    merge: mergeObservations,
    label: 'Replay check observations',
});
registerSyncMerge({
    store: 'settings',
    base: HISTORY_KEY,
    merge: mergeCheckHistory,
    label: 'Replay check history',
});

class ReplayCheck {
    constructor() {
        this.observations = [];
        this.history = [];
        this.loaded = false;
        this.watching = false;
        this.detach = null;
        this.detachCheckpoint = null;
        this.detachStopped = null;
        this.comparison = null;
        this.running = false;
        this.error = null;
        this.progress = 0;
        // Bumped by `disable()`. `check()` runs a 12-simulated-hour
        // `runSimulation` behind one `await`, which a character switch's
        // synchronous `disable()` has every chance of landing inside of — the
        // switch does not wait for this to unwind. Captured before that await
        // and compared after it, so a superseded check discards its result
        // instead of writing the departing character's numbers, and their
        // storage, as though they were whoever the overlay shows next.
        this.generation = 0;
        // The full SimResult behind the latest comparison, kept so downstream
        // decompositions (the zone uptime harness) can read its per-ability
        // attack histograms without paying for a second simulation.
        this.lastSimResult = null;
        // The per-monster incoming-damage decomposition of that sim against
        // the recording, computed once per check — see decomposeIncoming
        this.uptime = null;
    }

    /**
     * Start keeping observations, the first time anyone asks for one.
     *
     * Called from the row's `render` rather than from an `initialize`, so a check
     * nobody has switched on costs nothing — and so the settings have finished
     * loading by the time the switch is read.
     */
    ensureWatching() {
        if (this.watching) return;
        if (!config.getSetting('replayCheck')) return;
        this.watching = true;

        this.detach = onRecordingComplete((file) => this.ingest(file));
        this.detachCheckpoint = onRecordingCheckpoint((file) => this.checkpoint(file));
        this.detachStopped = onRecordingStopped(() => this.clearCheckpoint());
        this.load();
    }

    /** Read back what previous sessions observed */
    async load() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            // Anything observed before the read landed is folded under what
            // is stored, and a read that could not be made keeps it as it is
            observationRecord.set(this.observations);
            await observationRecord.load();
            this.observations = observationRecord.get();
            // Pruned on the way in as well as on the way out: an install left
            // alone for a month comes back to a table of checks that describe a
            // character it no longer has
            historyRecord.set(this.history);
            await historyRecord.load();
            this.history = pruneHistory(historyRecord.get());
            // Before the in-memory recording, so a session that was interrupted
            // and then restarted keeps both halves in the order they happened
            await this.recover();
            // A recording made before anyone looked at this is still sitting in
            // the recorder, and is the one most likely to be wanted
            await this.ingest(combatRecorder.recordingFile());
        } catch (error) {
            console.error('[ReplayCheck] Reading past observations failed:', error);
        }
    }

    /**
     * What a recording says happened, stamped with where and with what.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     * @returns {Object|null}
     */
    observationFrom(file) {
        if (!file?.ticks?.length) return null;

        const zone = getCurrentCombatZone();
        return observeRecording(file, {
            zoneHrid: zone?.zoneHrid ?? null,
            difficultyTier: zone?.difficultyTier ?? 0,
            loadout: file.loadout ?? null,
        });
    }

    /**
     * Keep an observation, unless it is one already kept.
     *
     * @param {Object} observation - From `observeRecording`
     * @returns {boolean} Whether it was new
     */
    remember(observation) {
        // An observation ingested twice would double every fight in it, and with
        // segments banked as they fill there are far more chances to do it
        const signature = observationSignature(observation);
        if (this.observations.some((entry) => observationSignature(entry) === signature)) return false;

        this.observations = [...this.observations, observation].slice(-MAX_OBSERVATIONS);
        return true;
    }

    /**
     * Derive an observation from a finished recording or a banked segment and keep it.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     */
    async ingest(file) {
        try {
            const observation = this.observationFrom(file);
            if (!observation) return;
            if (!this.remember(observation)) return;
            // The list in memory is right either way; what a full disk costs is
            // the write, and one failed write per segment rather than a stream
            if (storage.isQuotaExceeded()) return;

            await this.saveObservations();
        } catch (error) {
            console.error('[ReplayCheck] Keeping the observation failed:', error);
        }
    }

    /**
     * Write the observations, folding in what another tab stored meanwhile.
     * Skipped when storage cannot be read first.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveObservations() {
        observationRecord.set(this.observations);
        const landed = await observationRecord.save();
        this.observations = observationRecord.get();
        return landed;
    }

    /**
     * Write the check history, same discipline.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveHistory() {
        historyRecord.set(this.history);
        const landed = await historyRecord.save();
        this.history = historyRecord.get();
        return landed;
    }

    /**
     * Write the recording so far somewhere that outlives the tab.
     *
     * Called at fight boundaries only. What is written is the summary — the same
     * per-fight numbers a finished recording yields — and never the ticks, which
     * arrive several times a second and would make this a write storm.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     */
    async checkpoint(file) {
        try {
            // Checked before deriving, not after: on a full disk the derivation
            // is the expensive half and it is thrown away
            if (storage.isQuotaExceeded()) return;

            const observation = this.observationFrom(file);
            // A segment with no completed fight in it is what a rotation leaves
            // behind, and the checkpoint from before the rotation now describes
            // fights that have already been folded in
            if (!observation) {
                await this.clearCheckpoint();
                return;
            }

            await writeScoped(CHECKPOINT_KEY, observation, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Checkpointing the recording failed:', error);
        }
    }

    /**
     * A ticket saying whose observations the work about to suspend is holding.
     * @returns {{generation: number, charId: string|null}} Pass to {@link _stillOurs}
     */
    _owner() {
        return { generation: this.generation, charId: dataManager.getCurrentCharacterId?.() ?? null };
    }

    /**
     * @param {{generation: number, charId: string|null}} owner - From {@link _owner}
     * @returns {boolean} Whether the character it was taken under is still the one in hand
     */
    _stillOurs(owner) {
        return this.generation === owner.generation && (dataManager.getCurrentCharacterId?.() ?? null) === owner.charId;
    }

    /**
     * One character's checkpoint key, built from an id the caller captured.
     * @param {{charId: string|null}} owner - From {@link _owner}
     * @returns {string} The scoped key
     */
    _checkpointKey(owner) {
        return `${CHECKPOINT_KEY}_${owner.charId || 'default'}`;
    }

    /**
     * Forget the in-progress recording, because it is no longer in progress.
     * @param {{charId: string|null}} [owner] - Whose checkpoint; defaults to the
     *   character in hand. `recover()` passes the one it read under, because the
     *   clear is a write of `null` and filing it under whoever happens to be
     *   current destroys a third character's interrupted recording.
     * @returns {Promise<void>}
     */
    async clearCheckpoint(owner = this._owner()) {
        try {
            await storage.set(this._checkpointKey(owner), null, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Clearing the checkpoint failed:', error);
        }
    }

    /**
     * Fold in whatever the last session was recording when it ended.
     *
     * Cleared first and kept second: a checkpoint that cannot be folded in — a
     * half-written record, an observation of a zone this character has since
     * left — is not worth recovering on every load for the rest of time.
     */
    async recover() {
        // Captured before the read. The clear below is a write of `null`, and
        // its key used to be resolved when it ran: a switch inside the read
        // therefore erased the ARRIVING character's interrupted recording, and
        // the fold that follows put the departing character's fights into their
        // observations — which the save then wrote under their key.
        const owner = this._owner();
        try {
            const checkpoint = await readScoped(CHECKPOINT_KEY, 'settings', null, DISCARD_LEGACY);
            if (!this._stillOurs(owner)) return;
            if (!checkpoint?.fights?.length) return;

            await this.clearCheckpoint(owner);
            if (!this._stillOurs(owner)) return;
            if (!this.remember(checkpoint)) return;

            const count = checkpoint.fights.length;
            console.log(
                `[ReplayCheck] Recovered ${count} fight${count === 1 ? '' : 's'} from an interrupted recording`
            );
            if (storage.isQuotaExceeded()) return;
            await this.saveObservations();
        } catch (error) {
            console.error('[ReplayCheck] Recovering the interrupted recording failed:', error);
        }
    }

    /** What has been observed of the most recently recorded zone */
    observed() {
        return aggregateObservations(this.observations);
    }

    /**
     * The band the sample would be at if the recording stopped now.
     *
     * What a `noise` record target is measured against. The fights in the
     * segment being recorded are not observations yet — they become ones when
     * the segment is banked — so the aggregate has to be taken over what is kept
     * plus what is in flight, or a target would only ever be checked every four
     * thousand ticks.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     * @returns {number|null} Percent, or null when there are too few fights
     */
    liveMarginPct(file) {
        const live = this.observationFrom(file);
        const observed = aggregateObservations(live ? [...this.observations, live] : this.observations);
        return noiseMargin(observed?.samples?.dps);
    }

    /**
     * Everything needed to re-run this check somewhere else.
     *
     * The panel can say a run was 15% under and it cannot hand that over. This
     * can: the observations with their per-fight numbers and loadout snapshots,
     * the aggregate they fold into, the comparison as it stands, and the
     * recording's own segments — payloads where they are still held, per-fight
     * summaries where rotation has taken them, and a flag per segment saying
     * which. What is *not* in the file is listed in the file, because a reader
     * cannot tell an absent field from a field that was never captured.
     *
     * @returns {Object}
     */
    exportFile() {
        const observed = this.observed();
        const session = combatRecorder.sessionFile?.() ?? null;
        const host = typeof location !== 'undefined' ? location.hostname || null : null;

        return {
            format: 'toolasha-sim-accuracy',
            version: 1,
            // Which script produced it, against which server — an offline
            // reader cannot reconstruct either from the numbers, and live and
            // test do not share balance
            toolashaVersion: scriptVersion(),
            host,
            isTestServer: host ? host.includes('test.') : null,
            exportedAt: Date.now(),
            simHours: SIM_HOURS,
            simNoiseFloorPct: SIM_NOISE_FLOOR_PCT,
            zone: {
                hrid: observed?.zoneHrid ?? null,
                name: observed?.zoneHrid ? zoneName(observed.zoneHrid) : null,
                difficultyTier: observed?.difficultyTier ?? 0,
            },
            // The clocks, in the file, so an offline re-derivation divides by
            // what this divided by rather than by whatever looks reasonable
            clocks: { observed: OBSERVED_CLOCK, predicted: PREDICTED_CLOCK },
            observations: this.observations,
            aggregate: observed,
            comparison: this.comparison,
            // The per-monster incoming decomposition, when the last check made
            // one. Carries hrids, counters and damage figures only — nothing
            // the sanitized path would need to strip.
            uptime: this.uptime,
            history: pruneHistory(this.history),
            recording: session,
            includes: [
                'per-fight summaries for every observation kept (seconds, damage, hits, misses, kills, xp)',
                'the loadout snapshot each observation was recorded under',
                'the last comparison and the history of past checks',
                'the per-monster incoming-damage decomposition, when the last check produced one',
                session?.ticksComplete
                    ? 'the raw payloads of every segment of the recording still in memory'
                    : 'the raw payloads of the most recent segments; older segments carry their summary only',
            ],
            excludes: [
                'payloads from before this session — a reload ends a recording, and only its summary survives',
                'anything the simulator was run with beyond the loadout snapshot: game data and community buffs ' +
                    'are read live and are not captured here',
                'whether food and drinks were actually up during the recording, which the combat feed never says',
            ],
        };
    }

    /**
     * Keep this check beside the ones before it.
     *
     * A single check says how far off the simulator is today; a short series says
     * whether that is getting worse, which is the only question a single run
     * cannot answer.
     *
     * @param {Object} comparison - From `compareRun`
     */
    async rememberCheck(comparison) {
        try {
            const entry = historyEntry(comparison);
            if (!entry) return;

            this.history = pruneHistory([...this.history, entry]);
            if (storage.isQuotaExceeded()) return;

            await this.saveHistory();
        } catch (error) {
            console.error('[ReplayCheck] Keeping the check result failed:', error);
        }
    }

    /**
     * Run the sim for the observed zone and compare.
     *
     * @returns {Promise<Object|null>} The comparison, or null when it could not be made
     */
    async check() {
        if (this.running) return this.comparison;

        const generation = this.generation;
        const observed = this.observed();
        if (!observed) {
            this.error = 'Nothing recorded yet — press Record during a fight.';
            return null;
        }
        if (observed.partySize > 1) {
            this.error = `Recorded in a party of ${observed.partySize}. Only solo runs can be compared to a solo sim.`;
            return null;
        }
        if (!observed.zoneHrid) {
            this.error = 'The recording is not stamped with a zone, so there is nothing to simulate against it.';
            return null;
        }

        this.running = true;
        this.error = null;
        this.progress = 0;
        try {
            const current = buildPlayerDTO();
            if (!current) {
                this.error = 'The character has not loaded yet.';
                return null;
            }

            // The character as it was when the fights happened, where anything
            // says so. An observation from before snapshots existed carries
            // none, and falls through to the current character exactly as before
            const dto = applyLoadoutSnapshot(current, observed.loadout);

            const simResult = await runSimulation(
                {
                    gameData: buildGameDataPayload(),
                    playerDTOs: [dto],
                    zoneHrid: observed.zoneHrid,
                    difficultyTier: observed.difficultyTier || 0,
                    hours: SIM_HOURS,
                    communityBuffs: getCommunityBuffs(),
                    // Explicit, and explicitly off. `taskDamage` is the one
                    // combat stat that only applies while the monster in front
                    // of you is your active task, and the feed does not say
                    // whether it was — so a replay simulated with it on would
                    // predict damage the recorded run may never have been
                    // entitled to, and blame the difference on the engine.
                    // Relying on the runner's default would leave that decision
                    // somewhere else, where changing it would silently change
                    // what this measures.
                    isTaskFight: false,
                },
                (percent) => {
                    this.progress = percent;
                }
            );

            // A character switch's disable() ran while the simulation was in
            // flight — this run is for a character that has already left, and
            // must not appear as this one's, or be written to its storage.
            if (generation !== this.generation) return null;

            this.lastSimResult = simResult;
            this.comparison = compareRun(observed, predictFromSim(simResult));
            // The incoming-damage decomposition of the same sim against the
            // same recording — pure arithmetic on what is already in hand, so
            // a failure in it must never cost the check itself.
            try {
                this.uptime = this.decomposeIncoming();
            } catch (error) {
                console.error('[ReplayCheck] The incoming-damage decomposition failed:', error);
                this.uptime = null;
            }
            await this.rememberCheck(this.comparison);
            return this.comparison;
        } catch (error) {
            console.error('[ReplayCheck] The check failed:', error);
            this.error = `The simulation failed: ${error.message}`;
            return null;
        } finally {
            this.running = false;
        }
    }

    /**
     * Decompose the recording's incoming damage per monster and per ability
     * against the retained sim — the zone uptime harness, fed from what the
     * check already holds. Costs no simulation: extraction is arithmetic over
     * the recorder's ticks, and the sim side reads the SimResult's own attack
     * histograms.
     *
     * @returns {Object|null} `{real, sections, dotRow, simOnlyHrids}`, or
     *   `{empty}` / `{unusable}` / `{real, mismatches}` naming why there is no
     *   table; null with no sim on hand
     */
    decomposeIncoming() {
        if (!this.lastSimResult) return null;
        const session = combatRecorder.sessionFile();
        const segments = (session?.segments || []).filter((entry) => entry.ticksIncluded && entry.ticks?.length);
        if (!segments.length) return { empty: true };

        const gameData = buildGameDataPayload();
        const hrids = new Set();
        for (const entry of segments) {
            for (const hrid of waveHridsOf(entry.ticks)) hrids.add(hrid);
        }
        const nonDamaging = nonDamagingByHrid(gameData, hrids);
        const real = mergeWaveIncoming(segments.map((entry) => extractWaveIncoming(entry.ticks, { nonDamaging })));
        if (!real.usable) return { unusable: real.reason };

        const mismatches = zoneUptimeMismatches(real, {
            zoneHrid: this.observed()?.zoneHrid || null,
            gameData,
            segmentLoadouts: segments.map((entry) => entry.loadout ?? null),
        });
        if (mismatches.length) return { real, mismatches };

        return { real, ...compareZoneIncoming(real, this.lastSimResult) };
    }

    /**
     * Forget everything observed.
     *
     * Including the history of past checks. It is the more interesting half —
     * a drift over a fortnight is a finding no single run can make — but a
     * button labelled Forget that leaves a table of results on screen reads as
     * a button that did not work.
     */
    async forget() {
        // Three writes, each one meant to lose entries, with two suspensions
        // between them. A switch landing in either handed the rest of them the
        // arriving character's records to empty instead.
        const owner = this._owner();
        this.observations = [];
        this.history = [];
        this.comparison = null;
        this.lastSimResult = null;
        this.uptime = null;
        this.error = null;
        // The one write meant to lose entries
        await observationRecord.clear();
        if (!this._stillOurs(owner)) return;
        await historyRecord.clear();
        if (!this._stillOurs(owner)) return;
        await this.clearCheckpoint(owner);
    }

    disable() {
        this.generation += 1;
        this.detach?.();
        this.detachCheckpoint?.();
        this.detachStopped?.();
        this.detach = null;
        this.detachCheckpoint = null;
        this.detachStopped = null;
        this.watching = false;
        // Observations belong to the character that recorded them, so the next
        // ensureWatching — which is how a character switch arrives here — has
        // to read them again rather than carry these across. The record target
        // is the same character's and goes for the same reason.
        this.observations = [];
        this.history = [];
        observationRecord.reset();
        historyRecord.reset();
        this.comparison = null;
        this.lastSimResult = null;
        this.uptime = null;
        this.loaded = false;
        resetRecordTargetCache();
        // And the unit the empty box counts in, which is the cleared target's
        // unit and nothing else — see DEFAULT_TARGET_UNIT
        lastTargetUnit = DEFAULT_TARGET_UNIT;
    }
}

const replayCheck = new ReplayCheck();

// The recorder cannot build a loadout snapshot — the adapter that assembles one
// lives in another bundle — so it is told how. At module scope because a
// recording can start from the auto-record setting before any panel is drawn,
// and a segment recorded without a snapshot is one that can never gain one.
setLoadoutProvider(() => captureLoadoutSnapshot());

// The same arrangement for the other two things the recorder cannot do itself:
// reduce a segment to per-fight numbers for the file it hands over, and say how
// wide the sample's band is for a recording asked to reach one
setSegmentSummarizer((file) => replayCheck.observationFrom(file));
setNoiseProvider((file) => replayCheck.liveMarginPct(file));

// Features are initialized after settings load, which makes this the first
// moment the switch below can be read — and so the moment to go looking for a
// recording the last session was interrupted in the middle of. Without it,
// recovery would wait for somebody to open a panel, which for a tile that is
// hidden by default may be never.
onSessionStart(() => replayCheck.ensureWatching());

// `disable()`'s own comment describes ensureWatching() as "how a character
// switch arrives here", but nothing actually called disable() on a switch —
// this module lives outside the feature registry (it starts lazily from the
// overlay row's render, not an initialize()), so no character_switching
// handler ever ran it. `ensureWatching()` early-returns once `watching` is
// true, so without this, `watching` stayed true across every switch and the
// arriving character's session start (above) was a no-op: the previous
// character's observations, history, comparison and Sim Accuracy record
// target kept being read as this one's, main and ironcow alts alike.
dataManager.on?.('character_switching', () => replayCheck.disable());

/**
 * The comparison table.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} comparison - From `compareRun`
 */
function drawComparison(body, comparison) {
    const card = panelCard(body, 'Observed vs predicted', ACCENT);
    const rows = [...comparison.metrics, ...(comparison.experience ? [comparison.experience] : [])];

    for (const metric of rows) {
        const deviation =
            metric.deviationPct === null
                ? '—'
                : `${metric.deviationPct >= 0 ? '+' : ''}${metric.deviationPct.toFixed(1)}%`;
        // The deviation and the band it has to clear, side by side, because the
        // deviation alone is the number people quote and it means nothing alone
        const band = metric.marginPct === null ? ', too few fights' : ` ± ${metric.marginPct.toFixed(1)}%`;

        card.appendChild(
            panelLine(
                metric.label,
                `${formatMetric(metric.key, metric.observed)} vs ${formatMetric(metric.key, metric.predicted)}` +
                    `  (${deviation}${band})`,
                verdictColor(metric.verdict),
                `Observed ${formatMetric(metric.key, metric.observed)}, predicted ` +
                    `${formatMetric(metric.key, metric.predicted)}. ` +
                    (metric.verdict === 'beyond-noise'
                        ? `Outside the ±${metric.marginPct.toFixed(1)}% this sample can explain by chance.`
                        : metric.verdict === 'within-noise'
                          ? `Inconclusive: inside the ±${metric.marginPct.toFixed(1)}% this sample can explain by ` +
                            'chance. Record more of the same zone to narrow it.'
                          : `Fewer than ${MIN_SAMPLE_FIGHTS} fights, so the spread says nothing yet.`)
            )
        );
    }

    // The survival claim, only when it has something to say: a row reading
    // "0 vs ~0" on every safe zone would train the eye to skip it
    const deaths = comparison.deathCheck;
    if (deaths && (deaths.observed > 0 || deaths.expected >= 0.05)) {
        const expectedText = deaths.expected < 0.05 ? '~0' : `~${deaths.expected.toFixed(1)}`;
        card.appendChild(
            panelLine(
                'Deaths',
                `${deaths.observed} vs ${expectedText} expected`,
                verdictColor(deaths.verdict),
                `At the sim's death rate this sample should hold about ${deaths.expected.toFixed(2)} deaths ` +
                    `(±${Math.max(deaths.sigma, 0).toFixed(2)}, a rare count's own spread); it held ` +
                    `${deaths.observed}. This is the number idling trusts — a death the sim did not predict ` +
                    'matters even once.'
            )
        );
    }
}

/**
 * What the run was, and everything about it that is not known.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} observed - From `aggregateObservations`
 */
function drawProvenance(body, observed) {
    const card = panelCard(body, 'The recording', ACCENT);
    card.appendChild(panelLine('Zone', zoneName(observed.zoneHrid)));
    card.appendChild(
        panelLine(
            'Fights',
            `${observed.fights} over ${observed.seconds.toFixed(0)}s` +
                (observed.recordings > 1 ? ` (${observed.recordings} recordings)` : '')
        )
    );
    // Beside the fight count, because the fight count on its own is what invites
    // reading a twelve percent deviation off six fights as a twelve percent bug
    const noise = noiseSummary(observed);
    card.appendChild(
        panelLine(
            'Sample',
            noise.text,
            noise.quiet ? ROW_COLORS.good : ROW_COLORS.dim,
            'The 95% margin on the mean of the per-fight rates, from the actual spread of these fights rather ' +
                `than a rule of thumb, widened for the simulator's own randomness. Under ${NOISE_QUIET_PCT}% is ` +
                'a sample worth drawing conclusions from.'
        )
    );
    drawSuggestion(card, observed);
    card.appendChild(panelLine('Recorded', formatRelativeTime(Date.now() - observed.recordedAt) + ' ago'));
    card.appendChild(panelLine('Kills', String(observed.kills)));
    if (observed.deaths) card.appendChild(panelLine('Deaths', String(observed.deaths), ROW_COLORS.bad));
    if (observed.truncated) {
        card.appendChild(panelLine('Truncated', 'a fight outran the tick limit and was dropped', ROW_COLORS.dim));
    }
    // Data quality, not an error: how much of the waves' endpoint HP loss the
    // tick attribution actually credited. The gap folds designed exclusions
    // (bleeds ring no hit counter) with 3 Hz merge loss — but it bounds how
    // far observed DPS under-reads, which is exactly the direction the
    // comparison would otherwise blame on the sim.
    if (Number.isFinite(observed.unattributedDealt) && observed.endpointDealt > 0) {
        const pct = (observed.unattributedDealt / observed.endpointDealt) * 100;
        if (Math.abs(pct) >= 0.05) {
            card.appendChild(
                panelLine(
                    'Unattributed',
                    `${formatKMB(Math.round(observed.unattributedDealt))} of ` +
                        `${formatKMB(Math.round(observed.endpointDealt))} dealt (${pct.toFixed(1)}%)`,
                    Math.abs(pct) >= 10 ? ROW_COLORS.bad : ROW_COLORS.dim,
                    'The waves lost this much more HP than the tick-by-tick attribution credited: bleeds and ' +
                        'other counterless damage, plus hits the 3 Hz feed merged. It is measured from the HP ' +
                        'endpoints, so it bounds how far the observed damage rate under-reads — a deviation ' +
                        'smaller than this is not evidence against the sim.'
                )
            );
        }
    }
    drawSaveButton(card);
}

/**
 * What it would take to make this sample say something, and a button that asks for it.
 *
 * The band on its own is a dead end — "differences inside that band are not
 * findings" names the problem and not the fix. This is the fix, as a number and
 * as one click, because the alternative is guessing at how much longer to
 * record and guessing badly in both directions.
 *
 * @param {HTMLElement} card - Where it goes
 * @param {Object} observed - From `aggregateObservations`
 */
function drawSuggestion(card, observed) {
    const suggestion = sampleSizeFor(observed);
    if (!suggestion || suggestion.quiet) return;

    card.appendChild(
        panelLine(
            'To ±' + NOISE_QUIET_PCT + '%',
            suggestion.reachable ? `≈${suggestion.needed} more fights` : 'unreachable',
            ROW_COLORS.dim,
            suggestion.reachable
                ? `From the spread these ${suggestion.fights} fights actually showed: the margin falls as one ` +
                      `over the square root of the sample, so about ${suggestion.requiredFights} fights of this zone ` +
                      `would put it under ±${NOISE_QUIET_PCT}%. It assumes the next fights look like these ones, and ` +
                      'the rolling window only keeps the most recent few hours of them.'
                : `±${NOISE_QUIET_PCT}% is inside the flat ±${SIM_NOISE_FLOOR_PCT}% allowed for the simulator's ` +
                      'own randomness, which no sample size shrinks.'
        )
    );

    if (!suggestion.reachable || suggestion.needed <= 0) return;

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '2px' });

    const ask = document.createElement('button');
    // The band and not the count. The count is a projection off this sample's
    // spread, which is the one thing about it least likely to survive another
    // hour of recording; the band is the thing actually wanted, and the recorder
    // can now measure it as it goes and stop when it is reached. So the button
    // asks for what was wanted rather than for an estimate of it, and says the
    // estimate as the answer to "how long is that going to take".
    ask.textContent = `Record to ±${NOISE_QUIET_PCT}%`;
    ask.title =
        `Sets the record target to a band. The recording stops itself once the sample's margin is under ` +
        `±${NOISE_QUIET_PCT}%, measured at the end of a fight from the spread of the fights so far — about ` +
        `${suggestion.needed} more at this zone's current spread, but it is the band that decides, not the count.`;
    Object.assign(ask.style, {
        background: 'none',
        border: `1px solid ${ACCENT}`,
        borderRadius: '4px',
        color: ACCENT,
        padding: '2px 8px',
        cursor: 'pointer',
        fontSize: '11px',
    });
    ask.addEventListener('click', async () => {
        await setRecordTarget({ value: NOISE_QUIET_PCT, unit: 'noise' });
        replayCheckPanel.render();
    });

    row.appendChild(ask);
    card.appendChild(row);
}

/**
 * Hand the recording over, which is what somebody comparing notes needs.
 *
 * Beside the recording card rather than in the header, because it is about this
 * recording rather than about the panel. Available whether or not one is
 * running: the interesting file is usually the one that just stopped.
 *
 * @param {HTMLElement} card - Where it goes
 */
function drawSaveButton(card) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '3px' });

    const save = document.createElement('button');
    save.textContent = 'Save recording';
    save.title =
        'Writes one JSON file: these observations with their per-fight numbers and loadout snapshots, the last ' +
        'comparison, and the recording itself — raw payloads for the segments still held, per-fight summaries ' +
        'for the ones rotation has taken. The file lists what it does and does not contain.';
    Object.assign(save.style, {
        background: 'none',
        border: `1px solid ${ROW_COLORS.dim}`,
        borderRadius: '4px',
        color: ROW_COLORS.dim,
        padding: '2px 8px',
        cursor: 'pointer',
        fontSize: '11px',
    });
    save.addEventListener('click', () => {
        downloadExport();
        replayCheckPanel.render();
    });

    const sanitized = document.createElement('button');
    sanitized.textContent = 'Sanitized';
    sanitized.title =
        'The same file with player identities hashed and character ids stripped — use this one when attaching ' +
        'the recording to a public bug report. The kit, the fights and the numbers are untouched.';
    Object.assign(sanitized.style, {
        background: 'none',
        border: `1px solid ${ROW_COLORS.dim}`,
        borderRadius: '4px',
        color: ROW_COLORS.dim,
        padding: '2px 8px',
        marginLeft: '4px',
        cursor: 'pointer',
        fontSize: '11px',
    });
    sanitized.addEventListener('click', () => {
        downloadExport({ sanitized: true });
        replayCheckPanel.render();
    });

    row.appendChild(save);
    row.appendChild(sanitized);
    card.appendChild(row);
}

/**
 * One raw battle unit, stripped of who it is.
 *
 * The recorder's summaries carry no names, but the raw `new_battle` payloads
 * kept in the segments do — a player unit names its character outright. The
 * sanitized export hashes the name (stable, so two files from one character
 * still correlate) and drops the character object and id; everything a re-sim
 * reads — hitpoints, abilities, combatDetails — stays.
 *
 * @param {Object} unit - A player unit from a new_battle payload
 * @returns {Object} The same unit, anonymous
 */
function sanitizeBattleUnit(unit) {
    if (!unit || typeof unit !== 'object') return unit;
    const { character, characterID, ...rest } = unit;
    void character;
    void characterID;
    if (typeof rest.name === 'string' && rest.name) rest.name = hashPlayerName(rest.name);
    return rest;
}

/**
 * The export, fit for a public bug report.
 *
 * @param {Object} file - From `exportFile`
 * @returns {Object} A deep copy with player identities hashed/stripped
 */
export function sanitizeExportFile(file) {
    const clone = JSON.parse(JSON.stringify(file));
    for (const segment of clone.recording?.segments || []) {
        for (const tick of segment?.ticks || []) {
            const players = tick?.type === 'new_battle' ? tick.payload?.players : null;
            if (!players) continue;
            tick.payload.players = Array.isArray(players)
                ? players.map(sanitizeBattleUnit)
                : Object.fromEntries(Object.entries(players).map(([key, unit]) => [key, sanitizeBattleUnit(unit)]));
        }
    }
    clone.sanitized = true;
    return clone;
}

/**
 * Write the export out.
 *
 * @param {Object} [options]
 * @param {boolean} [options.sanitized=false] - Hash/strip player identities first
 * @returns {boolean} Whether a file was written
 */
export function downloadExport({ sanitized = false } = {}) {
    try {
        const file = sanitized ? sanitizeExportFile(replayCheck.exportFile()) : replayCheck.exportFile();
        const name = sanitized ? 'toolasha-sim-accuracy-sanitized' : 'toolasha-sim-accuracy';
        const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return true;
    } catch (error) {
        console.error('[ReplayCheck] Writing the export failed:', error);
        return false;
    }
}

/**
 * The three factors damage per second is the product of, each with its own band.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} comparison - From `compareRun`
 */
function drawDecomposition(body, comparison) {
    if (!comparison.decomposition?.length) return;

    const card = panelCard(body, 'Where the damage difference is', ACCENT);
    for (const metric of comparison.decomposition) {
        const deviation =
            metric.deviationPct === null
                ? '—'
                : `${metric.deviationPct >= 0 ? '+' : ''}${metric.deviationPct.toFixed(1)}%`;
        const band = metric.marginPct === null ? ', too few fights' : ` ± ${metric.marginPct.toFixed(1)}%`;

        card.appendChild(
            panelLine(
                metric.label,
                `${formatMetric(metric.key, metric.observed)} vs ${formatMetric(metric.key, metric.predicted)}` +
                    `  (${deviation}${band})`,
                verdictColor(metric.verdict),
                'Damage per second is these three multiplied together, so a gap in it is a gap in at least one ' +
                    'of them. A swing is an auto-attack or an ability on both sides — bleeds, thorns and ' +
                    'retaliation are counted by neither. ' +
                    (metric.key === 'swingsPerSecond'
                        ? `Both rates are per second of ${OBSERVED_CLOCK} on the observed side and ` +
                          `${PREDICTED_CLOCK} on the predicted one.`
                        : 'Neither is a rate over time, so no clock enters this row.')
            )
        );
    }
    body.appendChild(
        panelNote(
            'A swing that moved the hit counter without moving health is read as a miss, which is the same ' +
                'reading the Damage panel has always used. Crits are not compared: the simulator records what ' +
                'each swing did, not whether the roll crit.'
        )
    );
    body.appendChild(
        panelNote(
            'One swing per monster per fight used to be invisible here: the tick feed only mentions a monster ' +
                'once something about it moves, and for a fresh spawn that is the first hit landing on it, which ' +
                'left nothing to measure it against. The wave is now seeded from the battle message, so the ' +
                'opener counts. A recording checked before this read roughly 15% short on swings and on damage, ' +
                'at a kill rate that matched — which is the shape that gave it away.'
        )
    );
}

/**
 * Where the experience went, on both sides, and what fell.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} comparison - From `compareRun`
 */
/** Verdict glyphs for the uptime rows — the lab card's, unchanged. */
const UPTIME_VERDICT = {
    ok: { glyph: '✓', color: '#6fce7f' },
    'sim-under': { glyph: '⚠', color: '#e56b6b' },
    'sim-over': { glyph: '≠', color: '#e0b64a' },
    'sim-missing': { glyph: '⚠', color: '#e56b6b' },
    'sim-extra': { glyph: '+', color: '#7aa2d0' },
    buff: { glyph: '·', color: 'rgba(255,255,255,0.4)' },
    inconclusive: { glyph: '?', color: 'rgba(255,255,255,0.35)' },
};

/** Hover text for the uptime verdicts that need more than their own name. */
const UPTIME_TITLE = {
    buff: 'non-damaging buff — casts but cannot appear in the damage tally',
    inconclusive: `fewer than ${MIN_REAL_CASTS} real casts — too few to grade`,
};

/** A monster's display name, from live game data. */
function monsterName(monsterHrid) {
    return dataManager.getInitClientData()?.combatMonsterDetailMap?.[monsterHrid]?.name || monsterHrid;
}

/** Why an uptime mismatch code refused, in the panel's words. */
const UPTIME_MISMATCH_TEXT = {
    party: 'the recording is from a party, and only solo runs decompose against a solo sim',
    zone: 'the recording is not stamped with a zone',
    wave: 'the recording contains monsters foreign to the simmed zone',
    build: 'the recording spans more than one loadout',
};

/**
 * The per-monster incoming-damage card — the zone edition of the lab's uptime
 * section. One block per monster seen in the recording, rows graded by the
 * same share/mean verdicts; hover for cast share, means and sample size.
 *
 * @param {Object} body - Panel body
 * @param {Object|null} uptime - From `decomposeIncoming`
 */
function drawUptime(body, uptime) {
    if (!uptime) return;

    const card = panelCard(body, 'Incoming damage by ability', ACCENT);
    if (uptime.empty) {
        card.appendChild(
            panelNote('No tick recording on hand — the decomposition needs the recorder running during the fights.')
        );
        return;
    }
    if (uptime.unusable) {
        card.appendChild(panelNote(`The recording cannot be decomposed: ${uptime.unusable}.`));
        return;
    }
    if (uptime.mismatches) {
        const reasons = uptime.mismatches.map((code) => UPTIME_MISMATCH_TEXT[code] || code).join('; ');
        card.appendChild(panelNote(`Recording and sim do not describe the same fight: ${reasons}.`));
        return;
    }

    const meta = document.createElement('div');
    meta.textContent = describeFights(uptime.real);
    meta.style.cssText = 'font-size:0.68rem; color:rgba(255,255,255,0.45);';
    card.appendChild(meta);

    const num = (value) => (value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}`);
    const pct = (value) => (value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`);

    const drawRow = (wrap, row) => {
        const style = UPTIME_VERDICT[row.verdict] || UPTIME_VERDICT.ok;
        const line = document.createElement('div');
        line.style.cssText =
            'display:grid; grid-template-columns:1.3fr 0.9fr 0.9fr auto; gap:4px; align-items:baseline; font-size:0.74rem; padding:1px 0;';
        const name = document.createElement('span');
        name.textContent = row.ability;
        name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        // Cast share, means and sample size on hover, so the row stays
        // compact. Cast share is '—' for the DoT row, whose ticks are not casts.
        name.title =
            `casts: real ${pct(row.real?.castSharePct)} / sim ${pct(row.sim?.castSharePct)}` +
            `  ·  mean/cast: real ${num(row.real?.meanDmgPerCast ?? row.real?.meanPerTick)} / sim ${num(row.sim?.meanDmgPerCast ?? row.sim?.meanPerTick)}` +
            `  ·  ${row.samples ?? row.real?.ticks ?? 0} real ${row.ability === 'damageOverTime' ? 'ticks' : 'casts'}`;
        const real = document.createElement('span');
        real.textContent = pct(row.real?.dmgSharePct);
        real.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums;';
        const sim = document.createElement('span');
        sim.textContent = pct(row.sim?.dmgSharePct);
        sim.style.cssText = 'text-align:right; font-variant-numeric:tabular-nums; color:rgba(255,255,255,0.75);';
        const verdict = document.createElement('span');
        verdict.textContent = style.glyph;
        verdict.style.cssText = `text-align:right; color:${style.color};`;
        verdict.title = UPTIME_TITLE[row.verdict] || row.verdict;
        line.append(name, real, sim, verdict);
        wrap.appendChild(line);
    };

    for (const section of uptime.sections) {
        const heading = document.createElement('div');
        heading.textContent = `${monsterName(section.monsterHrid)} — ${section.fights} fight${section.fights === 1 ? '' : 's'}`;
        heading.style.cssText = 'margin-top:4px; font-size:0.72rem; font-weight:bold; color:rgba(255,255,255,0.7);';
        card.appendChild(heading);

        const header = document.createElement('div');
        header.style.cssText =
            'display:grid; grid-template-columns:1.3fr 0.9fr 0.9fr auto; gap:4px; font-size:0.64rem; color:rgba(255,255,255,0.4); padding:1px 0;';
        header.innerHTML =
            '<span>ability</span><span style="text-align:right;">real dmg%</span><span style="text-align:right;">sim dmg%</span><span></span>';
        card.appendChild(header);

        for (const row of section.rows) drawRow(card, row);
    }

    if (uptime.dotRow) {
        const heading = document.createElement('div');
        heading.textContent = 'Damage over time — whole wave';
        heading.title = 'A DoT tick names no monster in the feed, so the row covers the wave rather than pretending.';
        heading.style.cssText = 'margin-top:4px; font-size:0.72rem; font-weight:bold; color:rgba(255,255,255,0.7);';
        card.appendChild(heading);
        drawRow(card, uptime.dotRow);
    }

    if (uptime.simOnlyHrids?.length) {
        card.appendChild(
            panelNote(
                `Only the sim's own encounter draws met: ${uptime.simOnlyHrids.map(monsterName).join(', ')} — ` +
                    'not findings, just monsters this recording never fought.'
            )
        );
    }

    const key = document.createElement('div');
    key.style.cssText = 'margin-top:3px; font-size:0.66rem; color:rgba(255,255,255,0.45);';
    key.innerHTML =
        '<span style="color:#e56b6b;">⚠ sim-under</span> = sim gives this ability a smaller share of incoming damage than reality (or lands it for a smaller mean). ' +
        '<span style="color:rgba(255,255,255,0.5);">?</span> = too few real casts to grade. ' +
        'Hover for cast%, means and sample size: a matching cast% with a damage gap is a per-cast magnitude (buff-uptime) question, a cast% gap is cadence.';
    card.appendChild(key);
}

function drawGains(body, comparison) {
    if (comparison.experienceBySkill?.length) {
        const card = panelCard(body, 'Experience by skill', ACCENT);
        for (const row of comparison.experienceBySkill) {
            const deviation =
                row.deviationPct === null
                    ? ''
                    : `  (${row.deviationPct >= 0 ? '+' : ''}${row.deviationPct.toFixed(0)}%)`;
            card.appendChild(
                panelLine(
                    skillName(row.skillHrid),
                    `${formatMetric('xpPerSecond', row.observed)} vs ${formatMetric('xpPerSecond', row.predicted)}` +
                        deviation,
                    ROW_COLORS.dim,
                    'No band on this row: how experience splits between skills is decided by the primary and ' +
                        'focus training on the snapshot rather than by any roll, so the split is not a sampling ' +
                        'question. Experience going to different skills than predicted is a training setting, ' +
                        'not an engine error. Only the total above is banded.'
                )
            );
        }
    }

    if (!comparison.drops?.length) return;

    const card = panelCard(body, 'Drops observed (not compared)', ACCENT);
    for (const drop of comparison.drops.slice(0, MAX_DROP_ROWS)) {
        card.appendChild(
            panelLine(
                itemName(drop.itemHrid),
                `${drop.count} — ${drop.perHour.toFixed(1)}/h`,
                ROW_COLORS.dim,
                'Observed only. The simulator reports drop-rate multipliers and no drop table, so there is no ' +
                    'predicted count to put beside this. The Drop Luck panel models what a session was owed.'
            )
        );
    }
    body.appendChild(
        panelNote(
            'Nothing on this list is being checked against anything. The simulator emits no per-item drop ' +
                'prediction, so the honest thing to show is what fell and how often, and to leave the question ' +
                'of whether that was lucky to the Drop Luck model that answers it properly.'
        )
    );
}

/**
 * The usual suspects, when something is outside its band.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} comparison - From `compareRun`
 * @param {Object} observed - From `aggregateObservations`
 */
function drawHints(body, comparison, observed) {
    const hints = deviationHints(comparison, observed);
    if (!hints.length) return;

    const card = panelCard(body, 'Worth checking first', ROW_COLORS.bad);
    card.appendChild(
        panelNote(
            'Hints, not verdicts. These are ordered by how often each turns out to be behind a gap of this ' +
                'shape, not by any evidence in this sample — nothing below has been measured.'
        )
    );
    for (const hint of hints) {
        const line = panelNote(`• ${hint}`);
        line.style.marginTop = '3px';
        card.appendChild(line);
    }
}

/**
 * The last few checks, so drift is visible rather than remembered.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Array<Object>} history - From `pruneHistory`
 */
function drawHistory(body, history) {
    const entries = pruneHistory(history);
    if (entries.length < 2) return;

    const card = panelCard(body, 'Past checks', ACCENT);
    // Rows from a different script version were predicted by a different
    // engine, and an engine fix between rows reads exactly like drift. The
    // newest row's version is "current" for this table — steadier than the
    // running version, which legacy rows (recorded before versions were
    // stamped) could never match.
    const currentV = [...entries].reverse().find((entry) => entry.v)?.v ?? null;
    const versions = new Set(entries.map((entry) => entry.v ?? 'unknown'));
    // Newest first, because the question is "is this getting worse" and the
    // answer is read by comparing the top row to the ones under it
    for (const entry of [...entries].reverse()) {
        const magnitude = `${entry.deviationPct >= 0 ? '+' : ''}${entry.deviationPct.toFixed(1)}%`;
        const band = Number.isFinite(entry.marginPct) ? ` ± ${entry.marginPct.toFixed(1)}%` : '';
        const cohort = (entry.v ?? null) === currentV ? '' : ` · ${entry.v ? `v${entry.v}` : 'older script'}`;
        card.appendChild(
            panelLine(
                formatRelativeTime(Date.now() - entry.at) + ' ago',
                `${magnitude}${band} on ${entry.fights} fights — ${zoneName(entry.zoneHrid)}${cohort}`,
                verdictColor(entry.verdict),
                'Damage per second against the prediction, as it stood when the check was run. Rows in the same ' +
                    'zone drifting one way over weeks is the one finding a single check cannot make; rows from ' +
                    'different zones are not a trend.'
            )
        );
    }
    if (versions.size > 1) {
        card.appendChild(
            panelNote(
                'These checks were not all run by the same script version — a sim change between rows ' +
                    'reads exactly like drift, so compare rows within one version first.'
            )
        );
    }
}

/** The things that would make the deviation mean nothing */
function drawCaveats(body, observed) {
    if (observed.loadout) {
        body.appendChild(
            panelNote(
                'Simmed against the gear worn when recorded: equipment and enhancement levels, combat levels, ' +
                    'equipped abilities, house rooms and guild shrines were all captured as the recording started, ' +
                    'so enhancing or swapping something since does not show up as a deviation.'
            )
        );
        if (observed.mixedLoadouts) {
            body.appendChild(
                panelNote(
                    'These recordings were not all made with the same loadout. The newest snapshot is the one ' +
                        'simulated, so the older fights in this sample are being compared against kit they were ' +
                        'not fought in.'
                )
            );
        }
        body.appendChild(
            panelNote(
                'The drink and food slots were captured too, and the simulation drinks and eats them: haste, ' +
                    'wisdom and the rest are all in the prediction. Nothing on the combat feed says whether they ' +
                    'were actually up during the recording, so an empty inventory records as a full loadout and ' +
                    'simulates as one. This is the one input the check asserts and cannot verify.'
            )
        );
    } else {
        body.appendChild(
            panelNote(
                'This recording predates loadout snapshots, so gear is read as it is worn now, not as it was ' +
                    `${formatRelativeTime(Date.now() - observed.recordedAt)} ago when the fight was recorded. ` +
                    'Change a weapon, a level or a house room between the two and the deviation is that change.'
            )
        );
        body.appendChild(
            panelNote(
                'Consumables are not on the combat feed at all, so whether the recorded run had the same drinks up ' +
                    'as the simulated one is unknown.'
            )
        );
    }
    body.appendChild(
        panelNote(
            'A fight is measured from one battle to the next, which includes the respawn gap after it — the same ' +
                'clock the simulator runs on. Every rate on both sides is over that clock: observed, ' +
                `${OBSERVED_CLOCK}; predicted, ${PREDICTED_CLOCK}.`
        )
    );
    body.appendChild(
        panelNote(
            `What is simulated is the zone and its tier for ${SIM_HOURS} hours — not the waves that were ` +
                "recorded. The engine draws its own encounters from this zone's spawn table, with a boss every " +
                'tenth one, so it is the planet sampled again rather than a replay of the rooms you fought. Rates ' +
                'are comparable that way; a run that happened to draw an unusual mix of waves is not, and only ' +
                'the observed side has a measured spread to say so.'
        )
    );
    // This used to read "experience and drops are not on the feed at all", which
    // was simply untrue and cost the check the half of the simulator's output
    // people plan around
    if (observed.gainsFights > 0) {
        body.appendChild(
            panelNote(
                'Experience and drops are taken from the running totals each battle carries, over exactly these ' +
                    `fights (${observed.gainsFights} of ${observed.fights} carried them). Experience is compared ` +
                    'to the simulator, which predicts the same quantity; drops are shown but not compared, ' +
                    'because it predicts no drop table to compare them against.'
            )
        );
    } else {
        body.appendChild(
            panelNote(
                'No experience or loot totals were on these battles, so neither is shown. Recordings made before ' +
                    'this was read, and any fight that straddled a restarted combat action, carry none.'
            )
        );
    }
}

/**
 * The Record button, in this panel's chrome.
 *
 * What it says and what it does are {@link recordControlState}'s, so it reads
 * "Recording 240…" whether the recording was started here, from DPs, or by the
 * auto-record setting — and stopping it from here is the same stop. No file is
 * written: a recording started from this panel is read by the ingest that
 * follows it, not handed to anybody.
 *
 * @returns {HTMLElement|null} null when no recorder is reachable
 */
function recordButton() {
    const state = recordControlState();
    if (!state) return null;

    const button = document.createElement('button');
    button.textContent = state.label;
    button.title = state.title;
    Object.assign(button.style, {
        background: state.recording ? 'rgba(248, 113, 113, 0.18)' : 'none',
        border: `1px solid ${state.recording ? ROW_COLORS.bad : ROW_COLORS.dim}`,
        borderRadius: '4px',
        color: state.recording ? ROW_COLORS.bad : ROW_COLORS.dim,
        padding: '5px 10px',
        cursor: 'pointer',
    });
    button.addEventListener('click', () => {
        toggleRecording();
        replayCheckPanel.render();
    });
    return button;
}

/**
 * How much to record, as a box and a unit.
 *
 * An empty box is unlimited, which is what recording has always done and is
 * still the default — this adds a way to say "a hundred fights" without adding a
 * requirement to say anything. The unit toggles rather than opening a dropdown
 * because there are two of them and a `<select>` closes under the pointer every
 * time the panel refreshes.
 *
 * The panel's timed redraw leaves a focused input alone, so typing into this is
 * not interrupted by the two-second refresh happening underneath it.
 *
 * @returns {HTMLElement}
 */
function targetControl() {
    primeRecordTarget();
    const target = recordTarget();
    const unit = target?.unit ?? lastTargetUnit;
    lastTargetUnit = unit;

    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '3px', marginLeft: 'auto' });

    const box = document.createElement('input');
    box.type = 'number';
    box.min = '1';
    box.value = target ? String(target.value) : '';
    box.placeholder = '∞';
    box.title =
        'Stop after this many. Leave it empty to record until you press stop, which is what it has always ' +
        'done. A target is reached at the end of a fight, never in the middle of one, so a recording ' +
        'overshoots by the fight it was in rather than losing it. In ±% the number is a band rather than a ' +
        'count: recording continues until the margin on the sample is under it, and a band inside the ' +
        `simulator's own ±${SIM_NOISE_FLOOR_PCT}% allowance is never reached, so it records until stopped.`;
    Object.assign(box.style, {
        width: '46px',
        background: 'rgba(255, 255, 255, 0.06)',
        border: `1px solid ${ROW_COLORS.dim}`,
        borderRadius: '4px',
        color: '#e8ecf5',
        padding: '4px 5px',
        fontSize: '11px',
    });
    // `change` and not `input`: typing "100" passes through 1 and 10, and each
    // of those would be set as a target the recording could already have met
    box.addEventListener('change', async () => {
        await setRecordTarget({ value: Number(box.value), unit: lastTargetUnit });
        replayCheckPanel.render();
    });

    const toggle = document.createElement('button');
    toggle.textContent = UNIT_LABELS[unit] ?? unit;
    toggle.title =
        'What the number means: fights, minutes, or the noise band to record down to. ' +
        `Switching to ±% with an empty box sets ±${NOISE_QUIET_PCT}%, which is where differences start being ` +
        'findings rather than sampling.';
    Object.assign(toggle.style, {
        background: 'none',
        border: `1px solid ${ROW_COLORS.dim}`,
        borderRadius: '4px',
        color: ROW_COLORS.dim,
        padding: '4px 6px',
        cursor: 'pointer',
        fontSize: '11px',
    });
    toggle.addEventListener('click', async () => {
        const order = Object.keys(UNIT_LABELS);
        lastTargetUnit = order[(order.indexOf(lastTargetUnit) + 1) % order.length];

        // Only when there is a number to re-interpret. Switching the unit on an
        // empty box is choosing what the next number will mean, not setting one
        // — except in ±%, where there is exactly one number anybody wants and
        // making them type it is a step for nothing
        if (Number(box.value) > 0) await setRecordTarget({ value: Number(box.value), unit: lastTargetUnit });
        else if (lastTargetUnit === 'noise') await setRecordTarget({ value: NOISE_QUIET_PCT, unit: 'noise' });
        replayCheckPanel.render();
    });

    wrap.append(box, toggle);
    return wrap;
}

export const replayCheckPanel = createPanel({
    id: 'replayCheck',
    title: 'Sim Accuracy',
    size: { width: 440, height: 460 },
    accent: ACCENT,
    refreshMs: 2000,
    draw: (body) => {
        replayCheck.ensureWatching();

        if (!config.getSetting('replayCheck')) {
            body.appendChild(panelNote('Sim accuracy is switched off in settings.'));
            return;
        }

        const observed = replayCheck.observed();

        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', gap: '6px', alignItems: 'center' });

        const run = document.createElement('button');
        run.textContent = replayCheck.running ? `Simulating… ${replayCheck.progress}%` : `Run ${SIM_HOURS}h check`;
        run.disabled = replayCheck.running || !observed;
        Object.assign(run.style, {
            background: ACCENT,
            color: '#0e1016',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 10px',
            cursor: run.disabled ? 'default' : 'pointer',
            fontWeight: 'bold',
            opacity: run.disabled ? '0.5' : '1',
        });
        run.addEventListener('click', async () => {
            await replayCheck.check();
            replayCheckPanel.render();
        });

        const forget = document.createElement('button');
        forget.textContent = 'Forget';
        Object.assign(forget.style, {
            background: 'none',
            border: `1px solid ${ROW_COLORS.dim}`,
            borderRadius: '4px',
            color: ROW_COLORS.dim,
            padding: '5px 10px',
            cursor: 'pointer',
        });
        forget.addEventListener('click', async () => {
            await replayCheck.forget();
            replayCheckPanel.render();
        });

        controls.append(run, forget);

        // The same button DPs carries, driving the same recorder. Being told to
        // go and press it on another panel is the one thing this panel could
        // never do anything about, and the recording is what it runs on.
        const record = recordButton();
        if (record) {
            controls.appendChild(record);
            // Next to the button it modifies, and only when there is a recorder
            // for it to modify anything about
            controls.appendChild(targetControl());
        }

        body.appendChild(controls);

        if (!observed) {
            body.appendChild(
                panelNote(
                    'Nothing recorded yet. Press Record during a fight — here or on the DPs panel — or switch on ' +
                        '“Auto-record combat on load”, and this fills in when the recording stops.'
                )
            );
            return;
        }

        drawProvenance(body, observed);

        if (replayCheck.error) body.appendChild(panelNote(replayCheck.error));
        if (replayCheck.comparison) {
            drawComparison(body, replayCheck.comparison);
            // Before the caveats and after the headline: the decomposition is
            // what turns "9% under" into something to go and look at
            drawDecomposition(body, replayCheck.comparison);
            drawHints(body, replayCheck.comparison, observed);
            drawGains(body, replayCheck.comparison);
            drawUptime(body, replayCheck.uptime);
            for (const warning of replayCheck.comparison.warnings) {
                body.appendChild(panelNote(`The engine skipped a mechanic in this zone: ${warning}`));
            }
        } else if (!replayCheck.error) {
            body.appendChild(panelNote('Run the check to compare this recording against the simulator.'));
        }

        drawCaveats(body, observed);
        drawHistory(body, replayCheck.history);
    },
});

registerRow({
    key: 'replayCheck',
    name: 'Sim Accuracy',
    empty: 'No sim check yet',
    defaultVisible: false,
    defaultSize: { width: 250, height: 30 },
    onOpen: () => replayCheckPanel.toggle(),
    render: (container) => {
        replayCheck.ensureWatching();
        container.replaceChildren();

        if (!config.getSetting('replayCheck')) return;

        const comparison = replayCheck.comparison;
        if (!comparison) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Sim accuracy';

        const value = document.createElement('span');
        value.textContent = summaryLine(comparison);
        value.style.color = verdictColor(comparison.metrics.find((metric) => metric.key === 'dps')?.verdict);
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        container.title = 'Double-click for the full comparison, its margins and its caveats.';
    },
});

export default replayCheck;

/**
 * Per-wave timing of a dungeon recording, read straight off its raw ticks.
 *
 * The feed's shape decides how this must read it. A dungeon's `new_battle`
 * carries the whole new wave in its payload, every monster at full health:
 * that tick *is* the spawn. The `battle_updated` ticks that follow are
 * deltas, each listing only the monsters that changed, so no later tick shows
 * the whole wave, a tick with no monster changes at all is common, and a
 * monster that died can echo once more at zero. So the wave's roster is taken
 * from the announcement, each member is followed by id to its death, the
 * first hit is the first delta showing a roster member below full, the fight
 * ends when the last roster member reaches zero, and the respawn gap runs
 * from that death to the next announcement. Reading a delta as a snapshot
 * (waiting for "every monster at full") never sees the spawn.
 *
 * @param {Object} recording - From `combatRecorder.recordingFile()` / `sessionFile()`
 * @returns {Array<{wave: number, spawnToFirstHitMs: number|null, spawnToFightEndMs: number|null, newBattleToNextMs: number|null, gapMs: number|null}>}
 */
export function waveTimingFromRecording(recording) {
    const ticks = recording?.ticks || [];
    const hp = (m) => [Number(m?.cHP ?? m?.currentHitpoints), Number(m?.mHP ?? m?.maxHitpoints)];
    const roster = (payload) => payload?.mMap ?? payload?.monsters ?? {};

    const waves = [];
    let current = null;
    for (const tick of ticks) {
        if (tick?.type === 'new_battle') {
            if (current) {
                current.nextNewBattleAt = tick.at;
                waves.push(current);
            }
            const wave = tick.payload?.wave;
            const ids = Object.keys(roster(tick.payload));
            current =
                wave === undefined || ids.length === 0
                    ? null
                    : {
                          wave,
                          spawnAt: tick.at,
                          ids: new Set(ids),
                          alive: new Set(ids),
                          firstHitAt: null,
                          fightEndAt: null,
                          nextNewBattleAt: null,
                      };
            continue;
        }
        if (tick?.type !== 'battle_updated' || !current) continue;
        for (const [id, monster] of Object.entries(roster(tick.payload))) {
            if (!current.ids.has(id)) continue;
            const [health, max] = hp(monster);
            if (!Number.isFinite(health) || !Number.isFinite(max)) continue;
            if (current.firstHitAt === null && health < max) current.firstHitAt = tick.at;
            if (health <= 0 && current.alive.has(id)) {
                current.alive.delete(id);
                if (current.alive.size === 0 && current.fightEndAt === null) current.fightEndAt = tick.at;
            }
        }
    }
    if (current) waves.push(current);

    return waves.map((w) => ({
        wave: w.wave,
        spawnToFirstHitMs: w.firstHitAt !== null ? w.firstHitAt - w.spawnAt : null,
        spawnToFightEndMs: w.fightEndAt !== null ? w.fightEndAt - w.spawnAt : null,
        newBattleToNextMs: w.nextNewBattleAt !== null ? w.nextNewBattleAt - w.spawnAt : null,
        gapMs: w.fightEndAt !== null && w.nextNewBattleAt !== null ? w.nextNewBattleAt - w.fightEndAt : null,
    }));
}

/**
 * Line a dungeon recording up against a simulation of the same dungeon, wave
 * by wave: how long each side took to land its first hit after the wave
 * spawned, how long each side's fight ran, and the damage phase between
 * them. Both sides number waves from 1 — the simulator labels them `#1..#N`
 * and `new_battle.wave` is 1-based (a dungeon's fixed elite waves land on
 * the same numbers as its spawn table) — so wave w is compared to `#w`.
 *
 * Simulation times are nanoseconds and are averaged per wave over every run
 * that reached it; recording times are milliseconds and are averaged over the
 * runs the recording spans.
 *
 * @param {Object} params
 * @param {Object} params.recording - A dungeon recording (see `waveTimingFromRecording`)
 * @param {Object} params.simResult - A completed dungeon simulation result
 * @returns {{rows: Array<Object>, summary: Object}}
 */
export function dungeonWaveTiming({ recording, simResult } = {}) {
    const NS_PER_MS = 1e6;
    const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
    const simPerWave = (list, key) => (label) => {
        const entry = (list || []).find((e) => e.name === label);
        return entry && entry.count > 0 ? entry[key] / entry.count / NS_PER_MS : null;
    };
    const simAlive = simPerWave(simResult?.timeSpentAlive, 'timeSpentAlive');
    const simFirst = simPerWave(simResult?.waveFirstHit, 'total');

    const byWave = new Map();
    for (const w of waveTimingFromRecording(recording)) {
        if (!Number.isInteger(w.wave)) continue;
        const bucket = byWave.get(w.wave) || { wave: w.wave, runs: 0, firstHit: [], fight: [], gap: [] };
        bucket.runs += 1;
        if (Number.isFinite(w.spawnToFirstHitMs)) bucket.firstHit.push(w.spawnToFirstHitMs);
        if (Number.isFinite(w.spawnToFightEndMs)) bucket.fight.push(w.spawnToFightEndMs);
        if (Number.isFinite(w.gapMs)) bucket.gap.push(w.gapMs);
        byWave.set(w.wave, bucket);
    }

    const rows = [...byWave.values()]
        .sort((a, b) => a.wave - b.wave)
        .map((bucket) => {
            const label = `#${bucket.wave}`;
            const realFirst = mean(bucket.firstHit);
            const simFirstHit = simFirst(label);
            const realFight = mean(bucket.fight);
            const simFight = simAlive(label);
            // The damage phase, first hit to last kill, is where a run that starts
            // and respawns on time can still run long
            const realDamage = realFight !== null && realFirst !== null ? realFight - realFirst : null;
            const simDamage = simFight !== null && simFirstHit !== null ? simFight - simFirstHit : null;
            return {
                wave: bucket.wave,
                runs: bucket.runs,
                realFirstHitMs: round(realFirst),
                simFirstHitMs: round(simFirstHit),
                windupDeltaMs: round(simFirstHit !== null && realFirst !== null ? simFirstHit - realFirst : null),
                realFightMs: round(realFight),
                simFightMs: round(simFight),
                fightDeltaMs: round(simFight !== null && realFight !== null ? simFight - realFight : null),
                realDamagePhaseMs: round(realDamage),
                simDamagePhaseMs: round(simDamage),
                damagePhaseDeltaMs: round(simDamage !== null && realDamage !== null ? simDamage - realDamage : null),
                realGapMs: round(mean(bucket.gap)),
            };
        });

    const deltas = (key) => rows.map((r) => r[key]).filter(Number.isFinite);
    const summary = {
        wavesCompared: rows.filter((r) => r.simFightMs !== null && r.realFightMs !== null).length,
        simRuns: simResult?.dungeonsCompleted ?? null,
        meanWindupDeltaMs: round(mean(deltas('windupDeltaMs'))),
        meanFightDeltaMs: round(mean(deltas('fightDeltaMs'))),
        meanDamagePhaseDeltaMs: round(mean(deltas('damagePhaseDeltaMs'))),
        meanRealGapMs: round(mean(deltas('realGapMs'))),
        meanRealFirstHitMs: round(mean(deltas('realFirstHitMs'))),
        meanSimFirstHitMs: round(mean(deltas('simFirstHitMs'))),
    };
    if (typeof console !== 'undefined' && typeof console.table === 'function') {
        console.table(rows);
        console.log('[DungeonWaveTiming]', summary);
    }
    return { rows, summary };
}
