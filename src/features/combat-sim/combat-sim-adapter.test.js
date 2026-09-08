/**
 * Tests for the guild shrine helpers in the combat sim adapter.
 *
 * The server sends resolved guild buffs and never the levels behind them, so
 * every "what would one more level do" answer rests on this arithmetic being the
 * same arithmetic the game does. It is checked against the values a live client
 * dump showed: Force combat damage is 0.003 × level as a ratio boost, Scholar
 * wisdom 0.005 × level as a flat boost.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    clientData: null,
    guildBuffLevels: {},
    characterData: null,
    equippedAbilities: [],
    equipment: new Map(),
    shrineCapturedAt: null,
    shrineHydrated: false,
    personalActionTypeBuffsMap: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.clientData,
        getCharacterGuildBuffLevel: (hrid) => mocks.guildBuffLevels[hrid] || 0,
        getGuildShrineCapturedAt: () => mocks.shrineCapturedAt,
        isGuildShrineHydrated: () => mocks.shrineHydrated,
        getEquippedAbilities: () => mocks.equippedAbilities.map((entry) => ({ ...entry })),
        getCommunityBuffLevel: () => 0,
        getAchievementBuffs: () => [],
        get characterData() {
            return mocks.characterData;
        },
        get characterEquipment() {
            return mocks.equipment;
        },
        get personalActionTypeBuffsMap() {
            return mocks.personalActionTypeBuffsMap;
        },
    },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null, getSettingValue: (_k, d) => d } }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../market/expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/dungeon-level-gap.js', () => ({ partyLevelGaps: () => ({}) }));
// The adapter now reaches profit-helpers for the drop-sale tax, which pulls in
// these market-touching modules at load; stub them so the import graph is inert.
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => ({}) }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const {
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
    synthesizeGuildBuffs,
    applyGuildBuffLevel,
    readGuildShrineLevels,
    readGuildShrineSnapshot,
    buildGuildBuffsFromLevels,
    buildPlayerDTO,
    buildPlayerDTOFromProfile,
    parseShykaiImport,
    taxedDropValue,
    getCurrentCombatZone,
} = await import('./combat-sim-adapter.js');
const { MARKET_TAX, COWBELL_BAG_TAX } = await import('../../utils/profit-constants.js');

const FORCE = {
    hrid: '/guild_buffs/force_combat',
    shrineHrid: '/guild_shrines/force',
    isCombat: true,
    buffs: [
        {
            typeHrid: '/buff_types/damage',
            ratioBoost: 0.003,
            ratioBoostLevelBonus: 0.003,
            flatBoost: 0,
            flatBoostLevelBonus: 0,
        },
    ],
    levelCosts: { 1: { guildTokenCost: 10, creditCosts: [] }, 2: { guildTokenCost: 20, creditCosts: [] } },
};

const SCHOLAR_SKILLING = {
    hrid: '/guild_buffs/scholar_skilling',
    shrineHrid: '/guild_shrines/scholar',
    isCombat: false,
    buffs: [
        {
            typeHrid: '/buff_types/wisdom',
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0.005,
            flatBoostLevelBonus: 0.005,
        },
    ],
    levelCosts: { 1: {}, 2: {}, 3: {} },
};

beforeEach(() => {
    mocks.clientData = {
        guildBuffDetailMap: {
            '/guild_buffs/force_combat': FORCE,
            '/guild_buffs/scholar_skilling': SCHOLAR_SKILLING,
        },
        abilityDetailMap: {
            '/abilities/aura': { isSpecialAbility: true },
            '/abilities/cleave': {},
            '/abilities/toughness': {},
            '/abilities/fireball': {},
        },
        itemDetailMap: {},
    };
    mocks.guildBuffLevels = {};
    mocks.characterData = null;
    mocks.equippedAbilities = [];
    mocks.equipment = new Map();
    mocks.shrineCapturedAt = null;
    mocks.shrineHydrated = false;
    mocks.personalActionTypeBuffsMap = null;
});

describe('guild shrine buff synthesis', () => {
    test('reads the detail map, and survives data not having arrived', () => {
        expect(Object.keys(getGuildBuffDetailMap())).toHaveLength(2);
        mocks.clientData = null;
        expect(getGuildBuffDetailMap()).toEqual({});
    });

    test('max level comes from the level cost table', () => {
        expect(guildBuffMaxLevel(FORCE)).toBe(2);
        expect(guildBuffMaxLevel(SCHOLAR_SKILLING)).toBe(3);
        expect(guildBuffMaxLevel(undefined)).toBe(0);
    });

    test('a level resolves to base + (level − 1) × bonus', () => {
        expect(synthesizeGuildBuffs(FORCE, 1)[0].ratioBoost).toBeCloseTo(0.003, 10);
        expect(synthesizeGuildBuffs(FORCE, 7)[0].ratioBoost).toBeCloseTo(0.021, 10);
        expect(synthesizeGuildBuffs(SCHOLAR_SKILLING, 20)[0].flatBoost).toBeCloseTo(0.1, 10);
    });

    test('level bonuses are zeroed, so a reader that applies them cannot double-count', () => {
        const [buff] = synthesizeGuildBuffs(FORCE, 5);
        expect(buff.ratioBoostLevelBonus).toBe(0);
        expect(buff.flatBoostLevelBonus).toBe(0);
        expect(buff.duration).toBe(0);
    });

    test('level 0 grants nothing at all', () => {
        expect(synthesizeGuildBuffs(FORCE, 0)).toEqual([]);
        expect(synthesizeGuildBuffs(null, 5)).toEqual([]);
    });

    describe('buildGuildBuffsFromLevels — a shared profile guildBuffLevelMap', () => {
        test('keeps every level and synthesizes only the combat shrines', () => {
            const { guildShrineLevels, guildCombatBuffs } = buildGuildBuffsFromLevels({
                '/guild_buffs/force_combat': 2,
                '/guild_buffs/scholar_skilling': 3,
            });

            // Both levels are kept (the editor shows them)…
            expect(guildShrineLevels).toEqual({
                '/guild_buffs/force_combat': 2,
                '/guild_buffs/scholar_skilling': 3,
            });
            // …but only the combat shrine becomes a combat buff.
            expect(guildCombatBuffs).toHaveLength(1);
            expect(guildCombatBuffs[0].typeHrid).toBe('/buff_types/damage');
            expect(guildCombatBuffs[0].ratioBoost).toBeCloseTo(0.006, 10); // 0.003 + (2−1)×0.003
        });

        test('a zero level is kept in the map but grants no buff', () => {
            const { guildShrineLevels, guildCombatBuffs } = buildGuildBuffsFromLevels({
                '/guild_buffs/force_combat': 0,
            });
            expect(guildShrineLevels).toEqual({ '/guild_buffs/force_combat': 0 });
            expect(guildCombatBuffs).toEqual([]);
        });

        test('a missing or empty map is empty, not a crash', () => {
            expect(buildGuildBuffsFromLevels(null)).toEqual({ guildShrineLevels: {}, guildCombatBuffs: [] });
            expect(buildGuildBuffsFromLevels({})).toEqual({ guildShrineLevels: {}, guildCombatBuffs: [] });
        });
    });

    test('applying a level replaces that shrine and leaves the rest of the array alone', () => {
        const current = [
            { typeHrid: '/buff_types/damage', ratioBoost: 0.009, flatBoost: 0 },
            { typeHrid: '/buff_types/attack_speed', ratioBoost: 0.02, flatBoost: 0 },
        ];
        const updated = applyGuildBuffLevel(current, FORCE, 4);

        expect(updated.find((b) => b.typeHrid === '/buff_types/attack_speed')).toEqual(current[1]);
        expect(updated.filter((b) => b.typeHrid === '/buff_types/damage')).toHaveLength(1);
        expect(updated.find((b) => b.typeHrid === '/buff_types/damage').ratioBoost).toBeCloseTo(0.012, 10);
        // The caller's array is theirs
        expect(current[0].ratioBoost).toBe(0.009);
    });

    test('applying to a shrine that grants nothing yet adds it', () => {
        expect(applyGuildBuffLevel([], FORCE, 1)).toHaveLength(1);
        expect(applyGuildBuffLevel([], FORCE, 0)).toEqual([]);
    });

    test('shrine levels are read for every buff, unpurchased ones included', () => {
        mocks.guildBuffLevels = { '/guild_buffs/force_combat': 6 };
        expect(readGuildShrineLevels()).toEqual({
            '/guild_buffs/force_combat': 6,
            '/guild_buffs/scholar_skilling': 0,
        });
    });

    test('the snapshot says how old the reading is, without changing the levels', () => {
        mocks.guildBuffLevels = { '/guild_buffs/force_combat': 6 };
        mocks.shrineCapturedAt = 1_700_000_000_000;
        mocks.shrineHydrated = true;

        const snapshot = readGuildShrineSnapshot();
        expect(snapshot.levels).toEqual(readGuildShrineLevels());
        expect(snapshot.capturedAt).toBe(1_700_000_000_000);
        expect(snapshot.hydrated).toBe(true);
    });
});

describe('buildPlayerDTOFromProfile — a shared profile has no resolved achievement buffs', () => {
    test('offers the manual achievement buff catalog, defaulted off', () => {
        const dto = buildPlayerDTOFromProfile({
            characterID: 'char1',
            profile: { characterSkills: [], wearableItemMap: {} },
        });

        expect(dto.achievementBuffsManual).toBe(true);
        expect(dto.achievementCombatBuffs.map((b) => b.typeHrid)).toEqual([
            '/buff_types/damage',
            '/buff_types/wisdom',
            '/buff_types/rare_find',
        ]);
        // All three start excluded — a shared profile does not say which the
        // subject actually has, so nothing is silently applied.
        expect(dto.achievementBuffsOff).toEqual(
            expect.arrayContaining(['/buff_types/damage', '/buff_types/wisdom', '/buff_types/rare_find'])
        );
        expect(dto.achievementBuffsOff).toHaveLength(3);
    });

    test('missing profile data or client data yields null, not a throw', () => {
        expect(buildPlayerDTOFromProfile(null)).toBeNull();
        expect(buildPlayerDTOFromProfile({})).toBeNull();

        mocks.clientData = null;
        expect(buildPlayerDTOFromProfile({ profile: {} })).toBeNull();
    });
});

describe('buildPlayerDTOFromProfile — a shared profile with a completed achievement tier', () => {
    const ACHIEVEMENT_DETAIL_MAP = {
        '/achievements/novice_1': { tierHrid: '/achievement_tiers/novice' },
        '/achievements/novice_2': { tierHrid: '/achievement_tiers/novice' },
        '/achievements/veteran_1': { tierHrid: '/achievement_tiers/veteran' },
        '/achievements/elite_1': { tierHrid: '/achievement_tiers/elite' },
        '/achievements/elite_2': { tierHrid: '/achievement_tiers/elite' },
    };

    test('pre-checks the buffs earned by a fully completed tier, leaves the rest off', () => {
        mocks.clientData.achievementDetailMap = ACHIEVEMENT_DETAIL_MAP;

        const dto = buildPlayerDTOFromProfile({
            characterID: 'char1',
            profile: {
                characterSkills: [],
                wearableItemMap: {},
                characterAchievements: [
                    { achievementHrid: '/achievements/novice_1', isCompleted: true },
                    { achievementHrid: '/achievements/novice_2', isCompleted: true },
                    { achievementHrid: '/achievements/veteran_1', isCompleted: false },
                ],
            },
        });

        expect(dto.achievementBuffsDerived).toBe(true);
        expect(dto.achievementBuffsManual).toBe(false);
        expect(dto.achievementCombatBuffs.map((b) => b.typeHrid)).toEqual([
            '/buff_types/damage',
            '/buff_types/wisdom',
            '/buff_types/rare_find',
        ]);
        // Novice (wisdom) is complete and pre-checked; veteran (rare find) and
        // elite (damage) are not, so they stay off.
        expect(dto.achievementBuffsOff).toEqual(
            expect.arrayContaining(['/buff_types/damage', '/buff_types/rare_find'])
        );
        expect(dto.achievementBuffsOff).not.toContain('/buff_types/wisdom');
    });

    test('a profile without characterAchievements falls back to the manual, unchecked catalog', () => {
        mocks.clientData.achievementDetailMap = ACHIEVEMENT_DETAIL_MAP;

        const dto = buildPlayerDTOFromProfile({
            characterID: 'char1',
            profile: { characterSkills: [], wearableItemMap: {} },
        });

        expect(dto.achievementBuffsManual).toBe(true);
        expect(dto.achievementBuffsDerived).toBe(false);
        expect(dto.achievementBuffsOff).toHaveLength(3);
    });

    test('characterAchievements present but no achievementDetailMap loaded also falls back to manual', () => {
        const dto = buildPlayerDTOFromProfile({
            characterID: 'char1',
            profile: {
                characterSkills: [],
                wearableItemMap: {},
                characterAchievements: [{ achievementHrid: '/achievements/novice_1', isCompleted: true }],
            },
        });

        expect(dto.achievementBuffsManual).toBe(true);
        expect(dto.achievementBuffsDerived).toBe(false);
        expect(dto.achievementBuffsOff).toHaveLength(3);
    });
});

/**
 * The player DTO's equipped kit.
 *
 * The sim used to read `characterData.combatUnit.combatAbilities` directly,
 * which is the field login writes once and nothing updated afterwards. Reading
 * it is what made a post-labyrinth sim run the kit from hours earlier, so the
 * DTO now goes through the data-manager getter that every ability message feeds.
 */
describe('the abilities a player DTO carries', () => {
    beforeEach(() => {
        mocks.characterData = {
            characterSkills: [],
            // Deliberately stale: this is the login-time kit the lab moved past
            combatUnit: {
                combatAbilities: [
                    { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
                    { abilityHrid: '/abilities/fireball', slotNumber: 2, level: 8 },
                ],
            },
        };
    });

    test('come from the live kit, not the stale field beside it', () => {
        mocks.equippedAbilities = [
            { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
            { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 12 },
            { abilityHrid: '/abilities/toughness', slotNumber: 3, level: 11 },
        ];

        const dto = buildPlayerDTO();

        expect(dto.abilities[0]).toMatchObject({ hrid: '/abilities/aura' });
        expect(
            dto.abilities
                .slice(1)
                .filter(Boolean)
                .map((a) => a.hrid)
        ).toEqual(['/abilities/cleave', '/abilities/toughness']);
        expect(dto.abilities.some((a) => a?.hrid === '/abilities/fireball')).toBe(false);
    });

    test('always fill five slots, special first', () => {
        mocks.equippedAbilities = [{ abilityHrid: '/abilities/cleave', slotNumber: 2, level: 1 }];

        const dto = buildPlayerDTO();
        expect(dto.abilities).toHaveLength(5);
        expect(dto.abilities[0]).toBeNull();
        expect(dto.abilities[1].hrid).toBe('/abilities/cleave');
    });
});

describe('the scrolls a player DTO starts from', () => {
    beforeEach(() => {
        mocks.characterData = { characterSkills: [] };
    });

    test('are the combat scrolls the player has active', () => {
        mocks.personalActionTypeBuffsMap = {
            '/action_types/combat': [
                { typeHrid: '/buff_types/damage', ratioBoost: 0.08 },
                { typeHrid: '/buff_types/wisdom', flatBoost: 0.2 },
                // A non-combat-scroll buff on the combat map is not carried in
                { typeHrid: '/buff_types/gourmet', flatBoost: 0.16 },
            ],
        };

        expect(buildPlayerDTO().scrollBuffs).toEqual(['/buff_types/damage', '/buff_types/wisdom']);
    });

    test('are empty when the player carries none', () => {
        mocks.personalActionTypeBuffsMap = { '/action_types/combat': [] };
        expect(buildPlayerDTO().scrollBuffs).toEqual([]);
    });

    test('are empty when the game never sent a scroll map', () => {
        mocks.personalActionTypeBuffsMap = null;
        expect(buildPlayerDTO().scrollBuffs).toEqual([]);
    });
});

describe('taxedDropValue', () => {
    // The suite's global setup mocks the marketplace-patch gate on, so MARKET_TAX is 5%.
    test('nets the market tax off an ordinary drop', () => {
        expect(taxedDropValue('/items/cheese', 1000)).toBeCloseTo(1000 * (1 - MARKET_TAX), 9);
    });

    test('taxes a cowbell bag at its own higher rate', () => {
        expect(taxedDropValue('/items/bag_of_10_cowbells', 1000)).toBeCloseTo(1000 * (1 - COWBELL_BAG_TAX), 9);
        expect(COWBELL_BAG_TAX).toBeGreaterThan(MARKET_TAX);
    });

    test('leaves coin whole — it is not sold', () => {
        expect(taxedDropValue('/items/coin', 1)).toBe(1);
    });

    test('passes a zero straight through, so an EV fallback still runs and is not re-taxed', () => {
        expect(taxedDropValue('/items/cheese', 0)).toBe(0);
    });
});

/**
 * A DTO built without the client's item sheet is not a player: `itemDetailMap`
 * falls back to `{}`, every equipped piece is dropped for want of a definition,
 * and what comes back describes a naked character. Callers all handle null, and
 * none of them can spot a silently unequipped one — so this reports the absence
 * rather than inventing a player.
 */
describe('a player DTO without the game data', () => {
    test('is null, not an unequipped character', () => {
        mocks.characterData = { characterSkills: [] };
        mocks.clientData = null;

        expect(buildPlayerDTO()).toBeNull();
    });

    test('is still built when the data is there', () => {
        mocks.characterData = { characterSkills: [] };
        mocks.clientData = { itemDetailMap: {}, abilityDetailMap: {} };

        expect(buildPlayerDTO()).not.toBeNull();
    });
});

/**
 * A Shykai import must land its equipment on the same keys the engine reads.
 *
 * The exported format (and the game's raw data) carries each piece under an
 * `itemLocationHrid` like `/item_locations/head`, but the engine's Player keys
 * its equipment slots by `equipmentDetail.type` — `/equipment_types/head`. The
 * `updateCombatDetails` weapon/charm/pouch reads are by exact key, so a piece
 * filed under the location prefix is invisible to them: the weapon's style,
 * damage type and attack interval fall back to unarmed, the charm's focus is
 * lost, and the pouch's extra food/drink slots vanish. This is the one build
 * path that used to diverge — `buildPlayerDTO`/`buildPartyMemberDTO` both key by
 * `equipmentDetail.type` already.
 *
 * (TLA-045) An item missing from `itemDetailMap` used to fall back to translating the raw
 * `itemLocationHrid` prefix into a guessed `/equipment_types/*` key. That guess is not
 * authoritative — the live/self build path already treats an unresolvable item as absent
 * rather than invent a slot for it — so the import path must fail closed the same way: skip
 * the item and warn, never derive a slot from the location string.
 */
describe('the equipment a Shykai import carries', () => {
    beforeEach(() => {
        mocks.clientData = {
            itemDetailMap: {
                '/items/helm': { equipmentDetail: { type: '/equipment_types/head' } },
                '/items/sword': { equipmentDetail: { type: '/equipment_types/main_hand' } },
            },
            abilityDetailMap: {},
        };
    });

    test('is keyed by equipment type, not by item location', () => {
        const payload = JSON.stringify({
            player: {
                attackLevel: 50,
                equipment: [
                    { itemLocationHrid: '/item_locations/head', itemHrid: '/items/helm', enhancementLevel: 3 },
                    { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/sword', enhancementLevel: 5 },
                ],
            },
        });

        const result = parseShykaiImport(payload);
        expect(result).not.toBeNull();
        const dto = result.players[0];
        expect(Object.keys(dto.equipment).sort()).toEqual(['/equipment_types/head', '/equipment_types/main_hand']);
        expect(dto.equipment['/equipment_types/head']).toEqual({ hrid: '/items/helm', enhancementLevel: 3 });
        expect(dto.equipment['/equipment_types/main_hand']).toEqual({ hrid: '/items/sword', enhancementLevel: 5 });
    });

    test('TLA-045: skips (and warns about) an item missing from itemDetailMap instead of guessing its slot', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const payload = JSON.stringify({
            player: {
                attackLevel: 50,
                equipment: [
                    { itemLocationHrid: '/item_locations/head', itemHrid: '/items/helm', enhancementLevel: 3 },
                    { itemLocationHrid: '/item_locations/back', itemHrid: '/items/unknown_cape' },
                ],
            },
        });

        const dto = parseShykaiImport(payload).players[0];

        expect(dto.equipment['/equipment_types/back']).toBeUndefined();
        expect(dto.equipment['/item_locations/back']).toBeUndefined();
        expect(Object.keys(dto.equipment)).toEqual(['/equipment_types/head']);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/items/unknown_cape'));

        warnSpy.mockRestore();
    });
});

/**
 * Guild shrines an import brings with it.
 *
 * Szerra's fork of the export carries `guildCombatBuffLevels`, keyed by the tail
 * of the shrine hrid; everything on this side is keyed by guild-buff hrid. The
 * field was read by nobody, so an imported character fought with every shrine
 * switched off no matter what their guild had bought.
 */
describe('the guild shrines a Shykai import carries', () => {
    beforeEach(() => {
        mocks.clientData = {
            itemDetailMap: {},
            abilityDetailMap: {},
            guildBuffDetailMap: {
                '/guild_buffs/force_combat': FORCE,
                '/guild_buffs/scholar_skilling': SCHOLAR_SKILLING,
            },
        };
    });

    test('become levels and synthesized combat buffs', () => {
        const payload = JSON.stringify({
            player: { attackLevel: 50, equipment: [] },
            guildCombatBuffLevels: { force: 2, tempo: 0 },
        });

        const dto = parseShykaiImport(payload).players[0];
        expect(dto.guildShrineLevels).toEqual({ '/guild_buffs/force_combat': 2 });
        expect(dto.guildCombatBuffs).toHaveLength(1);
        expect(dto.guildCombatBuffs[0].typeHrid).toBe('/buff_types/damage');
        expect(dto.guildCombatBuffs[0].ratioBoost).toBeCloseTo(0.006);
    });

    test('an export without the field leaves no level map at all', () => {
        const payload = JSON.stringify({ player: { attackLevel: 50, equipment: [] } });

        const dto = parseShykaiImport(payload).players[0];
        // Not `{}`: the upgrade advisor reads a missing map as an unknown guild
        // and an empty one as a guildless character
        expect(dto.guildShrineLevels).toBeUndefined();
    });
});

describe('getCurrentCombatZone picks the running action, not the first in the array', () => {
    test('a requeued repeat in front does not mask the lower-ordinal running dungeon', () => {
        // The queue that mis-stamped a dungeon recording as Sorcerer's Tower:
        // the long-running repeat sits first with the highest ordinal, the
        // dungeon actually running has a lower ordinal.
        mocks.clientData.actionDetailMap = {
            '/actions/combat/sorcerers_tower': { combatZoneInfo: { isDungeon: false } },
            '/actions/combat/chimerical_den': { combatZoneInfo: { isDungeon: true } },
        };
        mocks.characterData = {
            characterActions: [
                {
                    actionHrid: '/actions/combat/sorcerers_tower',
                    isDone: false,
                    ordinal: 8589934588,
                    difficultyTier: 0,
                },
                { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 8589934587, difficultyTier: 2 },
            ],
        };

        expect(getCurrentCombatZone()).toEqual({
            zoneHrid: '/actions/combat/chimerical_den',
            difficultyTier: 2,
            isDungeon: true,
        });
    });

    test('a finished action can still name the zone the instant combat ends', () => {
        mocks.clientData.actionDetailMap = {
            '/actions/combat/chimerical_den': { combatZoneInfo: { isDungeon: true } },
        };
        mocks.characterData = {
            characterActions: [
                { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 0, difficultyTier: 1 },
            ],
        };

        expect(getCurrentCombatZone()).toEqual({
            zoneHrid: '/actions/combat/chimerical_den',
            difficultyTier: 1,
            isDungeon: true,
        });
    });

    test('no combat action at all returns null', () => {
        mocks.characterData = {
            characterActions: [{ actionHrid: '/actions/foraging/something', isDone: false, ordinal: 0 }],
        };
        expect(getCurrentCombatZone()).toBeNull();
    });
});
