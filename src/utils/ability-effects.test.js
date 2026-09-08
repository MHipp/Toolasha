/**
 * The ability → effect index.
 *
 * The classification is what is worth asserting: a debuff arrives as a *damage*
 * effect whose buffs land on the target, so a rule that read `effectType` alone
 * would file every debuff in the game as a buff and draw it green on the wrong
 * unit. The other half is the rebuild — the index is keyed on the map's
 * identity, and a character switch that handed out fresh client data while the
 * index kept the old one would show the departing character's abilities.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const client = vi.hoisted(() => ({ data: null }));

vi.mock('../core/data-manager.js', () => ({
    default: { getInitClientData: () => client.data },
}));

const { getAbilityEffectIndex, abilityEffects, effectForBuff, effectLabel, hridSlug, _resetAbilityEffectIndex } =
    await import('./ability-effects.js');

const SECOND = 1e9;

/** One buff record in the shape `abilityDetailMap` states them */
function buff(uniqueHrid, typeHrid, seconds) {
    return {
        uniqueHrid,
        typeHrid,
        ratioBoost: 0.1,
        ratioBoostLevelBonus: 0,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
        duration: seconds * SECOND,
    };
}

/** An ability map in the game's shape, with the four cases that matter */
function abilityMap() {
    return {
        // A self buff: the effect type says so and the target is the caster
        '/abilities/toughness': {
            abilityEffects: [
                {
                    targetType: 'self',
                    effectType: '/ability_effect_types/buff',
                    buffs: [buff('/buff_uniques/toughness_ability', '/buff_types/armor', 20)],
                },
            ],
        },
        // An enemy debuff: a *damage* effect whose buffs land on the target
        '/abilities/weaken': {
            abilityEffects: [
                {
                    targetType: 'allEnemies',
                    effectType: '/ability_effect_types/damage',
                    buffs: [buff('/buff_uniques/weaken_ability', '/buff_types/damage_taken', 15)],
                },
            ],
        },
        // Both at once, from one cast
        '/abilities/frenzy': {
            abilityEffects: [
                {
                    targetType: 'self',
                    effectType: '/ability_effect_types/buff',
                    buffs: [buff('/buff_uniques/frenzy_haste', '/buff_types/attack_speed', 10)],
                },
                {
                    targetType: 'enemy',
                    effectType: '/ability_effect_types/damage',
                    buffs: [buff('/buff_uniques/frenzy_slow', '/buff_types/critical_rate', 5)],
                },
            ],
        },
        // None: a plain damage ability, with `buffs: null` as the data writes it
        '/abilities/smack': {
            abilityEffects: [{ targetType: 'enemy', effectType: '/ability_effect_types/damage', buffs: null }],
        },
    };
}

beforeEach(() => {
    client.data = null;
    _resetAbilityEffectIndex();
});

describe('token normalisation', () => {
    test('a slug is the trailing segment of an hrid', () => {
        expect(hridSlug('/buff_types/critical_rate')).toBe('critical_rate');
        expect(hridSlug('')).toBe('');
        expect(hridSlug(null)).toBe('');
    });

    test('a label is initials for a phrase and a stem for a word', () => {
        expect(effectLabel('critical_rate')).toBe('CR');
        expect(effectLabel('damage')).toBe('DAM');
        expect(effectLabel('')).toBe('');
    });
});

describe('classification', () => {
    test('an ability with a self buff', () => {
        const entry = abilityEffects('/abilities/toughness', abilityMap());
        expect(entry.effects).toHaveLength(1);
        expect(entry.selfBuffs).toHaveLength(1);
        expect(entry.enemyDebuffs).toHaveLength(0);
        expect(entry.slug).toBe('toughness');
        expect(entry.effects[0]).toMatchObject({
            kind: 'buff',
            target: 'self',
            token: 'armor',
            label: 'ARM',
            durationSeconds: 20,
        });
    });

    test('an ability with an enemy debuff, stated as a damage effect', () => {
        const entry = abilityEffects('/abilities/weaken', abilityMap());
        expect(entry.enemyDebuffs).toHaveLength(1);
        expect(entry.selfBuffs).toHaveLength(0);
        expect(entry.effects[0]).toMatchObject({
            kind: 'debuff',
            target: 'enemy',
            token: 'damage_taken',
            area: true,
            durationSeconds: 15,
        });
    });

    test('an ability with both keeps them apart', () => {
        const entry = abilityEffects('/abilities/frenzy', abilityMap());
        expect(entry.effects).toHaveLength(2);
        expect(entry.selfBuffs.map((effect) => effect.uniqueHrid)).toEqual(['/buff_uniques/frenzy_haste']);
        expect(entry.enemyDebuffs.map((effect) => effect.uniqueHrid)).toEqual(['/buff_uniques/frenzy_slow']);
        // A single-target debuff is not an area one, and a strip that fanned it
        // across every monster would claim it hit units it never touched
        expect(entry.enemyDebuffs[0].area).toBe(false);
    });

    test('an ability with none is not indexed at all', () => {
        expect(abilityEffects('/abilities/smack', abilityMap())).toBeNull();
        expect(getAbilityEffectIndex(abilityMap()).abilities.has('/abilities/smack')).toBe(false);
    });

    test('a buff with no positive duration is still indexed, with none stated', () => {
        const map = {
            '/abilities/mark': {
                abilityEffects: [
                    {
                        targetType: 'enemy',
                        effectType: '/ability_effect_types/damage',
                        buffs: [{ uniqueHrid: '/buff_uniques/mark', typeHrid: '/buff_types/accuracy', duration: 0 }],
                    },
                ],
            },
        };
        expect(abilityEffects('/abilities/mark', map).effects[0].durationSeconds).toBeNull();
    });
});

describe('lookup by unique hrid', () => {
    test('the live buff map joins back to its ability and sprite', () => {
        const record = effectForBuff('/buff_uniques/weaken_ability', abilityMap());
        expect(record).toMatchObject({
            abilityHrid: '/abilities/weaken',
            slug: 'weaken',
            kind: 'debuff',
        });
    });

    test('a unique hrid no ability declares resolves to nothing', () => {
        expect(effectForBuff('/buff_uniques/community_buff', abilityMap())).toBeNull();
    });
});

describe('rebuilding', () => {
    test('the same map object is indexed once', () => {
        const map = abilityMap();
        expect(getAbilityEffectIndex(map)).toBe(getAbilityEffectIndex(map));
    });

    test('a new client data object rebuilds the index', () => {
        client.data = { abilityDetailMap: abilityMap() };
        const first = getAbilityEffectIndex();
        expect(first.abilities.has('/abilities/toughness')).toBe(true);

        // A character switch hands out fresh client data — a different object
        // carrying a different bar
        client.data = {
            abilityDetailMap: {
                '/abilities/berserk': {
                    abilityEffects: [
                        {
                            targetType: 'self',
                            effectType: '/ability_effect_types/buff',
                            buffs: [buff('/buff_uniques/berserk', '/buff_types/damage', 30)],
                        },
                    ],
                },
            },
        };
        const second = getAbilityEffectIndex();
        expect(second).not.toBe(first);
        expect(second.abilities.has('/abilities/toughness')).toBe(false);
        expect(second.abilities.has('/abilities/berserk')).toBe(true);
    });

    test('no client data yet is null rather than an empty index', () => {
        expect(getAbilityEffectIndex()).toBeNull();
        expect(abilityEffects('/abilities/toughness')).toBeNull();
    });
});
