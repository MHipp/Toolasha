/**
 * Tests for the ability timing calculator.
 *
 * The two formulas here are the engine's own — haste from Ability.shouldTrigger,
 * cast speed from the simulator's cast scheduling — so they are pinned against
 * hand-computed figures. The stat gathering is pinned on what it must NOT do:
 * count a buff the reconstructed Player already carries, and answer with a
 * number when the character cannot be read.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    gameData: { abilityDetailMap: {} },
    dto: null,
    characterData: null,
    playerFactory: null,
    extraBuffsSeen: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return mocks.characterData;
        },
    },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => mocks.gameData,
    buildPlayerDTO: () => mocks.dto,
    getCommunityBuffs: () => ({ mooPass: false, comExp: 0, comDrop: 0 }),
}));

vi.mock('./combat-sim-runner.js', () => ({
    buildExtraBuffs: () => [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05, ratioBoost: 0 }],
}));

vi.mock('./engine/extra-buffs.js', () => ({
    buildPlayerExtraBuffs: (shared) => shared,
}));

vi.mock('./engine/game-data.js', () => ({ setGameData: vi.fn() }));

vi.mock('./engine/player.js', () => ({
    default: {
        createFromDTO: () => mocks.playerFactory(),
    },
}));

const { getCurrentAbilityTimingStats, calculateEffectiveAbilityTiming } =
    await import('./ability-timing-calculator.js');

/**
 * A stand-in for the reconstructed Player, with the two lifecycle calls the
 * calculator makes.
 * @param {{abilityHaste?: number, castSpeed?: number, attackLevel?: number}} stats
 * @returns {Object}
 */
function fakePlayer({ abilityHaste = 0, castSpeed = 0, attackLevel = 1 } = {}) {
    return {
        attackLevel,
        combatDetails: { combatStats: { abilityHaste, castSpeed } },
        generatePermanentBuffs() {
            mocks.extraBuffsSeen = this.extraBuffs;
        },
        clearBuffs() {},
    };
}

beforeEach(() => {
    mocks.gameData = { abilityDetailMap: {} };
    mocks.dto = { hrid: 'player1' };
    mocks.characterData = {};
    mocks.extraBuffsSeen = null;
    mocks.playerFactory = () => fakePlayer();
});

describe('calculateEffectiveAbilityTiming', () => {
    test('applies haste to cooldown and cast speed to cast time', () => {
        // 20s cooldown at 25 haste -> 20 * 100 / 125 = 16s
        // 2s cast at 0.25 cast speed -> 2 / 1.25 = 1.6s
        const timing = calculateEffectiveAbilityTiming(20e9, 2e9, { abilityHaste: 25, castSpeed: 0.25 });

        expect(timing.baseCooldown).toBe(20);
        expect(timing.effectiveCooldown).toBeCloseTo(16, 10);
        expect(timing.baseCastTime).toBe(2);
        expect(timing.effectiveCastTime).toBeCloseTo(1.6, 10);
    });

    test('leaves the base cooldown alone when haste is zero or negative', () => {
        expect(calculateEffectiveAbilityTiming(20e9, 0, { abilityHaste: 0, castSpeed: 0 }).effectiveCooldown).toBe(20);
        expect(calculateEffectiveAbilityTiming(20e9, 0, { abilityHaste: -50, castSpeed: 0 }).effectiveCooldown).toBe(
            20
        );
    });

    test('falls back to the base cast time rather than dividing by zero', () => {
        const timing = calculateEffectiveAbilityTiming(0, 2e9, { abilityHaste: 0, castSpeed: -1 });
        expect(timing.effectiveCastTime).toBe(2);
    });

    test('returns null when a duration is missing rather than producing NaN', () => {
        expect(calculateEffectiveAbilityTiming(undefined, 2e9, { abilityHaste: 0, castSpeed: 0 })).toBeNull();
        expect(calculateEffectiveAbilityTiming(20e9, null, { abilityHaste: 0, castSpeed: 0 })).toBeNull();
        expect(calculateEffectiveAbilityTiming(20e9, 2e9, null)).toBeNull();
    });

    test('treats non-numeric stats as absent modifiers, not as NaN', () => {
        const timing = calculateEffectiveAbilityTiming(20e9, 2e9, { abilityHaste: undefined, castSpeed: undefined });
        expect(timing.effectiveCooldown).toBe(20);
        expect(timing.effectiveCastTime).toBe(2);
    });
});

describe('getCurrentAbilityTimingStats', () => {
    test('reads haste and cast speed off the reconstructed player', () => {
        mocks.playerFactory = () => fakePlayer({ abilityHaste: 12, castSpeed: 0.3, attackLevel: 90 });

        expect(getCurrentAbilityTimingStats()).toEqual({ abilityHaste: 12, castSpeed: 0.3, attackLevel: 90 });
    });

    test('adds the live drink and seal cast speed the reconstruction cannot model', () => {
        mocks.playerFactory = () => fakePlayer({ castSpeed: 0.1 });
        mocks.characterData = {
            consumableActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.12 }],
            },
            personalActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.03 }],
            },
        };

        expect(getCurrentAbilityTimingStats().castSpeed).toBeCloseTo(0.25, 10);
    });

    test('does not double-count the buff sources the player reconstruction already carries', () => {
        mocks.playerFactory = () => fakePlayer({ castSpeed: 0.1 });
        // Guild, achievement, community and MooPass buffs reach the player through
        // extraBuffs; re-reading their live maps here would count them twice.
        mocks.characterData = {
            guildActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.5 }],
            },
            achievementActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.5 }],
            },
            communityActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.5 }],
            },
            equipmentActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.5 }],
            },
        };

        expect(getCurrentAbilityTimingStats().castSpeed).toBeCloseTo(0.1, 10);
    });

    test('hands the player the same extra buffs a simulated run would get', () => {
        getCurrentAbilityTimingStats();
        expect(mocks.extraBuffsSeen).toEqual([{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05, ratioBoost: 0 }]);
    });

    test('returns null when game data or the character DTO is unavailable', () => {
        mocks.gameData = null;
        expect(getCurrentAbilityTimingStats()).toBeNull();

        mocks.gameData = { abilityDetailMap: {} };
        mocks.dto = null;
        expect(getCurrentAbilityTimingStats()).toBeNull();
    });

    test('returns null rather than a partial figure when the reconstruction throws', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.playerFactory = () => {
            throw new Error('missing item definition');
        };

        expect(getCurrentAbilityTimingStats()).toBeNull();
        spy.mockRestore();
    });
});
