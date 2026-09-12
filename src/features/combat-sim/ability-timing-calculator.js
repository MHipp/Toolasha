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
 * Every read is live: the DTO is rebuilt from `dataManager` on each call, the
 * Labyrinth-seal boost is read off `characterData.personalActionTypeBuffsMap`
 * (which the socket mirrors on every change), and the combat-drink boost comes
 * from the equipped drinks' own item data. Nothing here is cached, so a tea
 * swap, a seal pickup or a re-equip shows up on the next hover.
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
 * Sum the flat `/buff_types/cast_speed` boost held by the Labyrinth seals
 * currently active for combat — the one live-map source the reconstructed
 * Player does not already cover.
 *
 * Equipment and house rooms arrive as combat stats and permanent buffs; the
 * community, MooPass, guild, achievement and scroll buffs arrive through
 * `buildExtraBuffs`/`buildPlayerExtraBuffs`, exactly as a simulated run gets
 * them. Summing any of those from the live map as well would count them twice.
 * A seal is a persistent per-run bonus — structurally a static "held = active"
 * bonus, the same as a skilling tea — so the server folds it into
 * `personalActionTypeBuffsMap` the same way it does for every non-combat
 * action type.
 *
 * @param {Object} characterData - dataManager.characterData
 * @returns {number} Flat boost from currently-held Labyrinth seals
 */
function liveSealCastSpeedBoost(characterData) {
    const buffs = characterData?.personalActionTypeBuffsMap?.[COMBAT_ACTION_TYPE];
    if (!Array.isArray(buffs)) return 0;

    let total = 0;
    for (const buff of buffs) {
        if (buff?.typeHrid === CAST_SPEED_BUFF_TYPE) total += buff.flatBoost || 0;
    }
    return total;
}

/**
 * Sum the flat `/buff_types/cast_speed` boost from the combat drinks currently
 * equipped.
 *
 * Unlike a seal or a skilling tea, a combat drink is trigger-gated — re-drunk
 * on a cooldown, or on an HP/MP condition — rather than a static "equipped =
 * always on" bonus, so the server does not fold it into
 * `consumableActionTypeBuffsMap` the way it does every other action type.
 * Confirmed live: on a character mid-combat with three combat coffees slotted
 * and `isActive: true`, `consumableActionTypeBuffsMap` carried no
 * `/action_types/combat` key at all, and a later reading found the whole map
 * empty while the same drinks were still active — that key is structurally
 * absent for combat, not a timing gap. Every other reader of that map in this
 * codebase (enhancing, alchemy) is non-combat, which is the same story.
 *
 * `player.drinks` already holds the equipped set for the reconstruction — the
 * same `actionTypeDrinkSlotsMap` combat slots, built moments earlier as
 * `Consumable`s — and each one's `.buffs` is that item's own static buff
 * definition. That definition is the item's base value, not what actually
 * lands on the unit: `CombatSimulator.tryUseConsumable`
 * (`engine/combat-simulator.js`) scales a drink buff's `flatBoost`/`ratioBoost`
 * by `1 + drinkConcentration` at the moment it applies the buff, for any
 * consumable whose `catagoryHrid` includes `'drink'`. Skipping that scaling
 * here understates the figure by exactly the character's drink-concentration
 * bonus — confirmed live: a character with drink concentration active showed
 * Channeling Coffee granting +14.4% cast speed in the fight's own buff map,
 * against the item's base 0.12, and 0.12 × 1.2 = 0.144.
 *
 * @param {Array<{catagoryHrid?: string, buffs?: Array<{typeHrid?: string, flatBoost?: number}>}|null>} drinks -
 *   `player.drinks`
 * @param {number} drinkConcentration - `player.combatDetails.combatStats.drinkConcentration`
 * @returns {number} Flat boost from the equipped combat drinks, concentration-adjusted
 */
function liveDrinkCastSpeedBoost(drinks, drinkConcentration) {
    const multiplier = drinkConcentration > 0 ? 1 + drinkConcentration : 1;
    let total = 0;
    for (const drink of drinks ?? []) {
        if (!drink?.catagoryHrid?.includes('drink')) continue;
        for (const buff of drink?.buffs ?? []) {
            if (buff?.typeHrid === CAST_SPEED_BUFF_TYPE) total += (buff.flatBoost || 0) * multiplier;
        }
    }
    return total;
}

/**
 * The current character's live combat stats that bear on ability timing.
 *
 * Reconstructs a `Player` from the live DTO — equipment, house rooms, skill
 * levels — and hands it the same extra buffs a simulated run would get, then
 * adds the seal cast-speed boost the live personal-buffs map states and the
 * drink cast-speed boost the equipped combat drinks' own item data states.
 * Attack level needs no special handling: `CombatUnit.updateCombatDetails`
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
    try {
        const gameData = buildGameDataPayload();
        if (!gameData) return null;

        // Inside the try with the reconstruction, not before it: the DTO builder walks
        // live character data (skills, equipment, house rooms) and a half-written field
        // mid-switch throws out of it. This runs on a hover, off the tooltip observer's
        // dispatch, and a base figure is the right answer for every one of those.
        const dto = buildPlayerDTO();
        if (!dto) return null;

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
            castSpeed:
                player.combatDetails.combatStats.castSpeed +
                liveSealCastSpeedBoost(dataManager.characterData) +
                liveDrinkCastSpeedBoost(player.drinks, player.combatDetails.combatStats.drinkConcentration),
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
