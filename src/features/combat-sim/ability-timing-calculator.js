/**
 * Ability Timing Calculator
 *
 * The character's LIVE effective ability cooldown and cast time.
 *
 * The game's own ability tooltip prints `abilityDetailMap.cooldownDuration` and
 * `castDuration` verbatim — the base numbers, never adjusted for the Ability
 * Haste on your gear or the Cast Speed from your gear, house, buffs and Attack
 * level. This computes what those durations actually are right now.
 *
 * It lives in the sim bundle, not next to the tooltip feature that shows it,
 * because the reconstruction is the engine's: `Player` plus the adapter's DTO
 * builder, both of which drag the whole combat engine behind them. The tooltip
 * feature is in the combat bundle and reaches this through
 * `Toolasha.Sim.abilityTimingCalculator` (simExternalGlobals in
 * rollup.config.js), the same way it already reaches the adapter.
 *
 * Every read is live: the DTO is rebuilt from `dataManager` on each call and the
 * consumable/personal buff maps are read off `characterData`, which the socket
 * now mirrors on every change. Nothing here is cached, so a tea swap or a
 * re-equip shows up on the next hover.
 */

import dataManager from '../../core/data-manager.js';
import { buildGameDataPayload, buildPlayerDTO, getCommunityBuffs } from './combat-sim-adapter.js';
import { buildExtraBuffs } from './combat-sim-runner.js';
import { buildPlayerExtraBuffs } from './engine/extra-buffs.js';
import { setGameData } from './engine/game-data.js';
import Player from './engine/player.js';

const COMBAT_ACTION_TYPE = '/action_types/combat';
const CAST_SPEED_BUFF_TYPE = '/buff_types/cast_speed';

/**
 * The buff-map sources the reconstructed Player does NOT already cover.
 *
 * Equipment and house rooms arrive as combat stats and permanent buffs; the
 * community, MooPass, guild, achievement and scroll buffs arrive through
 * `buildExtraBuffs`/`buildPlayerExtraBuffs`, exactly as a simulated run gets
 * them. Summing any of those from the live maps as well would count them twice.
 * What is left is the temporary stuff no reconstruction models: the drinks
 * currently ticking and the Labyrinth seals currently held.
 */
const LIVE_CAST_SPEED_BUFF_MAPS = ['consumableActionTypeBuffsMap', 'personalActionTypeBuffsMap'];

/**
 * Sum the flat `/buff_types/cast_speed` boost active for combat across the live
 * buff maps the Player reconstruction does not model.
 * @param {Object} characterData - dataManager.characterData
 * @returns {number} Combined flat boost (e.g. 0.12 for Channeling Coffee)
 */
function liveCastSpeedFlatBoost(characterData) {
    let total = 0;
    for (const mapName of LIVE_CAST_SPEED_BUFF_MAPS) {
        const buffs = characterData?.[mapName]?.[COMBAT_ACTION_TYPE];
        if (!Array.isArray(buffs)) continue;
        for (const buff of buffs) {
            if (buff?.typeHrid === CAST_SPEED_BUFF_TYPE) {
                total += buff.flatBoost || 0;
            }
        }
    }
    return total;
}

/**
 * The current character's live combat stats that bear on ability timing.
 *
 * Reconstructs a `Player` from the live DTO — equipment, house rooms, skill
 * levels — and hands it the same extra buffs a simulated run would get, then
 * adds the drink and seal cast-speed boosts that only the live buff maps know
 * about. Attack level needs no special handling: `CombatUnit.updateCombatDetails`
 * already folds `attackLevel / 2000` into castSpeed.
 *
 * Ability Haste is deliberately equipment-only, because that is all the engine
 * models — nothing in `updateCombatDetails` reads a `/buff_types/ability_haste`,
 * so pulling one out of the live maps here would make the tooltip disagree with
 * every simulated figure in the script.
 *
 * @returns {{abilityHaste: number, castSpeed: number, attackLevel: number}|null}
 *   Live stats, or null when the character or game data cannot be read
 */
export function getCurrentAbilityTimingStats() {
    const gameData = buildGameDataPayload();
    if (!gameData) return null;

    const dto = buildPlayerDTO();
    if (!dto) return null;

    try {
        setGameData(gameData);
        const player = Player.createFromDTO(dto);
        // CombatUnit defaults zoneBuffs/extraBuffs to {}, and generatePermanentBuffs()
        // calls .forEach() on them. No zone or labyrinth is in play for a tooltip, so
        // zoneBuffs is empty; extraBuffs carries what a run of the sim would carry.
        player.zoneBuffs = [];
        player.extraBuffs = buildPlayerExtraBuffs(buildExtraBuffs(getCommunityBuffs()), dto);
        player.generatePermanentBuffs();
        // clearBuffs() seeds combatBuffs from permanentBuffs and rebuilds combatDetails
        player.clearBuffs();

        return {
            abilityHaste: player.combatDetails.combatStats.abilityHaste,
            castSpeed: player.combatDetails.combatStats.castSpeed + liveCastSpeedFlatBoost(dataManager.characterData),
            attackLevel: player.attackLevel,
        };
    } catch (error) {
        // A half-built character (mid-switch, missing item definitions) must show
        // the base figure, never a wrong one.
        console.error('[AbilityTimingCalculator] Could not reconstruct the player:', error);
        return null;
    }
}

/**
 * Effective cooldown and cast time for one ability.
 *
 * The two formulas are the engine's own, and must stay that way or the tooltip
 * and the simulator quote different numbers for the same ability: haste from
 * `Ability.shouldTrigger`, cast speed from `CombatSimulator`'s cast scheduling.
 *
 * @param {number} baseCooldownNs - abilityDetailMap.cooldownDuration, nanoseconds
 * @param {number} baseCastDurationNs - abilityDetailMap.castDuration, nanoseconds
 * @param {{abilityHaste: number, castSpeed: number}} stats - Live combat stats
 * @returns {{baseCooldown: number, effectiveCooldown: number, baseCastTime: number,
 *   effectiveCastTime: number}|null} Seconds, or null when a duration is not a number
 */
export function calculateEffectiveAbilityTiming(baseCooldownNs, baseCastDurationNs, stats) {
    if (!Number.isFinite(baseCooldownNs) || !Number.isFinite(baseCastDurationNs) || !stats) return null;

    const baseCooldown = baseCooldownNs / 1e9;
    const baseCastTime = baseCastDurationNs / 1e9;

    const haste = Number.isFinite(stats.abilityHaste) ? stats.abilityHaste : 0;
    const castSpeed = Number.isFinite(stats.castSpeed) ? stats.castSpeed : 0;

    const effectiveCooldown = haste > 0 ? (baseCooldown * 100) / (100 + haste) : baseCooldown;
    // A castSpeed of -1 would divide by zero; the game has no such value, but a
    // base figure beats an Infinity.
    const effectiveCastTime = 1 + castSpeed > 0 ? baseCastTime / (1 + castSpeed) : baseCastTime;

    return { baseCooldown, effectiveCooldown, baseCastTime, effectiveCastTime };
}
