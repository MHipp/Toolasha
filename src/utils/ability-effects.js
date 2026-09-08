/**
 * Ability → effect index: what a cast puts on whom, and for how long.
 *
 * The game states an ability's effects in `initClientData.abilityDetailMap`,
 * but it states them in the shape the combat engine wants: a list of
 * `abilityEffects`, each with a `targetType`, an `effectType`, and — only
 * sometimes — a list of `buffs`. Nothing in that shape answers the question a
 * display asks, which is "this unit is carrying `/buff_uniques/…`; what is it,
 * is it good or bad for them, and how long does it last".
 *
 * So this is the reverse index for that question, built once per client data
 * object and read from there on. Two lookups:
 *
 * - by **ability hrid**, for "what would casting this apply"
 * - by **unique hrid**, for "what is this thing already on the unit" — which is
 *   how the live `combatBuffMap` names its entries, and the only join available
 *   there
 *
 * ## Buff or debuff is decided by the target, not the label
 *
 * `effectType` is `/ability_effect_types/buff` for a self-buff, but a *debuff*
 * arrives as a `/ability_effect_types/damage` effect whose `buffs` land on the
 * unit it hit — the simulator applies them at `processAbilityDamageEffect`, on
 * the target, exactly as it applies a self-buff at `processAbilityBuffEffect`,
 * on the source. So the sign of an effect is its `targetType`: an enemy target
 * makes it a debuff whatever the effect type says, and only an explicit
 * "debuff" in the effect type overrides that.
 *
 * ## Tokens are normalised once
 *
 * A `typeHrid` like `/buff_types/critical_rate` is parsed here into a `token`
 * (`critical_rate`) and a `label` (`CR`), so a strip redrawing every second in
 * combat never splits a string. Same for the ability's sprite `slug`, which is
 * the fragment the game's `abilities_sprite` is addressed by.
 *
 * ## Durations are nanoseconds
 *
 * `buff.duration` is in the engine's own unit — `1e9` is one second, as
 * `combat-simulator.js` declares — and is converted here once. Where the data
 * gives no positive duration the effect is still indexed, with
 * `durationSeconds: null`, because "this exists and its length is unknown" is a
 * different answer from "this does not exist" and a caller can dash one.
 *
 * Adapted from MWITools battleBuffs, CC-BY-NC-SA-4.0, see third-party/mwitools/.
 */

import dataManager from '../core/data-manager.js';

/** The engine's time unit: `combat-simulator.js` declares `ONE_SECOND = 1e9` */
const NANOSECONDS_PER_SECOND = 1e9;

/**
 * Target types that name the caster's enemies.
 *
 * From `combat-simulator.js`, which switches on exactly these strings:
 * `self` and `allAllies` for buffs, `enemy` and `allEnemies` for damage,
 * `lowestHpAlly` for heals and `deadAlly` for revives. Anything unrecognised
 * is treated as friendly, so an unknown target never mislabels a buff as a
 * debuff.
 */
const ENEMY_TARGET_TYPES = new Set(['enemy', 'allEnemies']);

/** Target types that reach more than one unit at once */
const AREA_TARGET_TYPES = new Set(['allEnemies', 'allAllies']);

/** The index built from {@link indexedMap}, or null before the first build */
let index = null;
/** The ability map the current index was built from — compared by identity */
let indexedMap = null;

/**
 * The trailing segment of an hrid, which is the part that names the thing.
 *
 * @param {string} hrid - e.g. `/buff_types/critical_rate`
 * @returns {string} e.g. `critical_rate`, or '' for anything unusable
 */
export function hridSlug(hrid) {
    const text = String(hrid ?? '');
    if (!text) return '';
    return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * A two-or-three character abbreviation for a token, for the tile that has no
 * sprite to draw.
 *
 * Initials for a multi-word token (`critical_rate` → `CR`) and the first three
 * letters for a single word (`damage` → `DAM`), which is the split that keeps
 * abbreviations apart at the width a chip actually has.
 *
 * @param {string} token - A normalised token, from {@link hridSlug}
 * @returns {string} Uppercase, at most three characters; '' for an empty token
 */
export function effectLabel(token) {
    const words = String(token ?? '')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean);
    if (words.length === 0) return '';
    if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
    return words
        .map((word) => word[0])
        .join('')
        .slice(0, 3)
        .toUpperCase();
}

/**
 * Seconds from a nanosecond duration, or null when the data gives none.
 * @param {*} duration - `buff.duration`
 * @returns {number|null}
 */
function durationSeconds(duration) {
    const seconds = Number(duration) / NANOSECONDS_PER_SECOND;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Whether an effect's buffs land on the caster's enemies.
 *
 * The `targetType` decides it, except where the effect type says "debuff"
 * outright — which the live data does not currently use, but which would
 * outrank an inference if it appeared.
 *
 * @param {Object} effect - One entry of `abilityEffects`
 * @param {string} targetType - Its target type, possibly inherited
 * @returns {'buff'|'debuff'}
 */
function effectKind(effect, targetType) {
    if (String(effect?.effectType ?? '').includes('debuff')) return 'debuff';
    return ENEMY_TARGET_TYPES.has(targetType) ? 'debuff' : 'buff';
}

/**
 * Build the index for one ability map.
 * @param {Object} abilityDetailMap - abilityHrid → ability details
 * @returns {{abilities: Map<string, Object>, byUniqueHrid: Map<string, Object>}}
 */
function buildIndex(abilityDetailMap) {
    const abilities = new Map();
    const byUniqueHrid = new Map();

    for (const abilityHrid in abilityDetailMap) {
        const detail = abilityDetailMap[abilityHrid];
        const abilityEffects = detail?.abilityEffects;
        if (!Array.isArray(abilityEffects)) continue;

        // An effect that states no target of its own takes the ability's, when
        // the ability has exactly one opinion about targets. Ordinary data
        // always states it; this only stops a blank field being read as
        // "friendly" on an ability every other effect of which hits enemies.
        const statedEnemyTarget = abilityEffects
            .map((effect) => String(effect?.targetType ?? ''))
            .find((targetType) => ENEMY_TARGET_TYPES.has(targetType));

        const slug = hridSlug(abilityHrid);
        const effects = [];

        for (const effect of abilityEffects) {
            const buffs = effect?.buffs;
            if (!Array.isArray(buffs) || buffs.length === 0) continue;

            const stated = String(effect?.targetType ?? '');
            const targetType = stated || statedEnemyTarget || '';
            const kind = effectKind(effect, targetType);

            for (const buff of buffs) {
                const uniqueHrid = String(buff?.uniqueHrid ?? '');
                if (!uniqueHrid) continue;
                const typeHrid = String(buff?.typeHrid ?? '');
                const token = hridSlug(typeHrid);
                const record = {
                    abilityHrid,
                    slug,
                    uniqueHrid,
                    typeHrid,
                    token,
                    label: effectLabel(token),
                    kind,
                    // 'self' reads as "on whoever cast it", which covers
                    // allAllies too: both put the effect on the caster's side
                    target: kind === 'debuff' ? 'enemy' : 'self',
                    targetType,
                    area: AREA_TARGET_TYPES.has(targetType),
                    durationSeconds: durationSeconds(buff?.duration),
                };
                effects.push(record);
                // First writer wins: two abilities sharing a unique hrid are
                // the same effect, and the later one would only restate it
                if (!byUniqueHrid.has(uniqueHrid)) byUniqueHrid.set(uniqueHrid, record);
            }
        }

        if (effects.length === 0) continue;
        abilities.set(abilityHrid, {
            abilityHrid,
            slug,
            effects,
            selfBuffs: effects.filter((effect) => effect.kind === 'buff'),
            enemyDebuffs: effects.filter((effect) => effect.kind === 'debuff'),
        });
    }

    return { abilities, byUniqueHrid };
}

/**
 * The index, rebuilt only when the ability map it was built from is replaced.
 *
 * Keyed on the map's identity, so a character switch or a reconnect — either of
 * which hands out a fresh `init_client_data` — invalidates it, and a re-read of
 * the same object does not.
 *
 * @param {Object} [abilityDetailMap] - Defaults to the current client data's map
 * @returns {{abilities: Map<string, Object>, byUniqueHrid: Map<string, Object>}|null}
 *   null before any client data has landed
 */
export function getAbilityEffectIndex(abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap) {
    if (!abilityDetailMap) return null;
    if (abilityDetailMap !== indexedMap) {
        index = buildIndex(abilityDetailMap);
        indexedMap = abilityDetailMap;
    }
    return index;
}

/**
 * What one cast of an ability applies.
 *
 * @param {string} abilityHrid - e.g. `/abilities/toughness`
 * @param {Object} [abilityDetailMap] - The map to index (defaults to the live one)
 * @returns {Object|null} `{abilityHrid, slug, effects, selfBuffs, enemyDebuffs}`,
 *   or null for an ability that applies nothing
 */
export function abilityEffects(abilityHrid, abilityDetailMap) {
    return getAbilityEffectIndex(abilityDetailMap)?.abilities.get(abilityHrid) ?? null;
}

/**
 * The effect record behind one entry of a live `combatBuffMap`.
 *
 * The live map names its entries by unique hrid and says nothing about which
 * ability produced them, so this is the only join back to the ability — and to
 * the sprite a chip draws.
 *
 * @param {string} uniqueHrid - e.g. `/buff_uniques/toughness_ability`
 * @param {Object} [abilityDetailMap] - The map to index (defaults to the live one)
 * @returns {Object|null} The effect record, or null when no ability declares it
 */
export function effectForBuff(uniqueHrid, abilityDetailMap) {
    return getAbilityEffectIndex(abilityDetailMap)?.byUniqueHrid.get(uniqueHrid) ?? null;
}

/**
 * The abbreviation that names one effect, rather than the stat it moves.
 *
 * A record's `label` is its `typeHrid`, which is what the stat is called — and
 * several different effects move the same stat, so a display keyed on it draws
 * two chips that read alike without being the same thing. The unique hrid is
 * the effect's own name (`fury_accuracy`, `elemental_affinity_fire_amplify`),
 * so it tells those apart; the type label remains the fallback for a record
 * whose unique hrid abbreviates to nothing.
 *
 * @param {Object|null} record - An effect record from {@link effectForBuff}
 * @returns {string} Uppercase, at most three characters; '' for no record
 */
export function effectSourceLabel(record) {
    return effectLabel(hridSlug(record?.uniqueHrid)) || record?.label || '';
}

/** Forget the cached index — for tests, which hand in maps of their own. */
export function _resetAbilityEffectIndex() {
    index = null;
    indexedMap = null;
}
