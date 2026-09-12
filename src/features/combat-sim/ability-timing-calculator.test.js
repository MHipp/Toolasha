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
    gameDataError: null,
    dtoError: null,
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
    buildGameDataPayload: () => {
        if (mocks.gameDataError) throw mocks.gameDataError;
        return mocks.gameData;
    },
    buildPlayerDTO: () => {
        if (mocks.dtoError) throw mocks.dtoError;
        return mocks.dto;
    },
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
 * @param {{abilityHaste?: number, castSpeed?: number, attackLevel?: number, drinks?: Array}} stats
 * @returns {Object}
 */
function fakePlayer({ abilityHaste = 0, castSpeed = 0, attackLevel = 1, drinks = [] } = {}) {
    return {
        attackLevel,
        drinks,
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
    mocks.gameDataError = null;
    mocks.dtoError = null;
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

    test('adds the equipped drinks and the live seal cast speed the reconstruction cannot model', () => {
        // Channeling Coffee's cast speed comes from the reconstructed player's own
        // equipped drinks (Consumable's static buff definition), not a live map —
        // see the next test for why.
        mocks.playerFactory = () =>
            fakePlayer({
                castSpeed: 0.1,
                drinks: [{ buffs: [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.12 }] }, null, null],
            });
        mocks.characterData = {
            personalActionTypeBuffsMap: {
                '/action_types/combat': [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.03 }],
            },
        };

        expect(getCurrentAbilityTimingStats().castSpeed).toBeCloseTo(0.25, 10);
    });

    test('the drink boost comes from the equipped drink, not consumableActionTypeBuffsMap', () => {
        // Live capture, 2026-09-11: a character mid-combat with three combat
        // coffees slotted and `isActive: true` had NO `/action_types/combat` key
        // in `consumableActionTypeBuffsMap`, and a later reading found the whole
        // map empty while the same drinks were still active. The server does not
        // fold trigger-gated combat drinks into that map the way it does a
        // skilling tea, so a present-but-irrelevant (or absent) map must not
        // change the answer — only the equipped drink does.
        mocks.playerFactory = () =>
            fakePlayer({
                castSpeed: 0.1,
                drinks: [{ buffs: [{ typeHrid: '/buff_types/cast_speed', flatBoost: 0.12 }] }, null, null],
            });
        mocks.characterData = {
            consumableActionTypeBuffsMap: {},
        };

        expect(getCurrentAbilityTimingStats().castSpeed).toBeCloseTo(0.22, 10);
    });

    test('a drink slot with no relevant buff, or no drink at all, adds nothing', () => {
        mocks.playerFactory = () =>
            fakePlayer({
                castSpeed: 0.1,
                drinks: [{ buffs: [{ typeHrid: '/buff_types/accuracy', flatBoost: 0.1 }] }, null, null],
            });

        expect(getCurrentAbilityTimingStats().castSpeed).toBeCloseTo(0.1, 10);
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

    test('returns null rather than throwing when reading the live character throws', () => {
        // This runs on a hover, off the tooltip observer's dispatch. The DTO builder
        // walks live character data, and a half-written field mid-switch throws out of
        // it — before the fix those two calls sat outside the try and the throw escaped.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        mocks.dtoError = new Error('characterSkills half written');
        expect(() => getCurrentAbilityTimingStats()).not.toThrow();
        expect(getCurrentAbilityTimingStats()).toBeNull();

        mocks.dtoError = null;
        mocks.gameDataError = new Error('initClientData half written');
        expect(() => getCurrentAbilityTimingStats()).not.toThrow();
        expect(getCurrentAbilityTimingStats()).toBeNull();

        spy.mockRestore();
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
