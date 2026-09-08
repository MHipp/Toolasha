/** @vitest-environment happy-dom
 *
 * Getting back to yourself in the Sim Editor.
 *
 * The Configure tab is easy to fill with strangers: every "+ Import" adds a
 * player and nothing removes them but clicking each × in turn. The two reset
 * buttons are the way back, and what is worth asserting about them is that they
 * read *live* data rather than restoring `_originalDTOs` — that snapshot is
 * whatever was loaded last, which after an import is the strangers themselves.
 *
 * The community-buff ceiling lives here too, because the editor's input is one
 * of the two places that has to agree with the game's Lv20 cap; the other is
 * `MAX_COMMUNITY_BUFF_LEVEL` in upgrade-advisor.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    charId: 'me',
    buildHold: null,
    characterData: { character: { id: 'me', name: 'Milkman' } },
    selfDTO: null,
    allPlayers: null,
    /** What the game says the house is now: Map of room hrid → {level} */
    houseRooms: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getCurrentCharacterId: () => game.charId,
        getInitClientData: () => ({ itemDetailMap: {}, abilityDetailMap: {} }),
        getItemDetails: () => null,
        getHouseRooms: () => game.houseRooms,
    },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({ itemDetailMap: {}, abilityDetailMap: {}, houseRoomDetailMap: {} }),
    buildAllPlayerDTOs: async () => {
        // A build left open, so a test can land a character switch inside one
        if (game.buildHold) await game.buildHold;
        return game.allPlayers;
    },
    buildPlayerDTO: () => (game.selfDTO ? structuredClone(game.selfDTO) : null),
    parseShykaiImport: () => null,
    // The real one returns false for a name no snapshot answers to, which is
    // what the remembered-selection restore leans on
    applyLoadoutSnapshotToDTO: (dto, name) => {
        bridge.applied.push(name);
        return bridge.snapshots.some((snap) => snap.name === name);
    },
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: (buffs) => buffs,
}));

// This bundle's own (direct-import) copy of the store. In the packaged build it
// is never fed by the websocket, so it answers empty — the bug this guards.
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [], resolveEquipment: () => [] },
}));

// Per-character settings, in memory: the loadout the editor last simmed with
// lives here, and nothing in this suite is about IndexedDB.
const settings = vi.hoisted(() => ({ values: new Map(), hold: null }));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, storeName, defaultValue = null) => {
        // A read left open, so a test can land a character switch inside one
        if (settings.hold) await settings.hold;
        return settings.values.has(base) ? settings.values.get(base) : defaultValue;
    },
    writeScoped: async (base, value) => {
        settings.values.set(base, value);
    },
}));

// The fed store lives behind the bundle bridge; the picker must read it there.
const bridge = vi.hoisted(() => ({ snapshots: [], applied: [] }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({ getAllSnapshots: () => bridge.snapshots, resolveEquipment: () => [] }),
}));

const { SimEditor } = await import('./sim-editor.js');

const emptyDTO = (hrid) => ({
    hrid,
    equipment: {},
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    houseRooms: {},
    communityBuffLevels: {},
    attackLevel: 1,
    meleeLevel: 1,
    rangedLevel: 1,
    magicLevel: 1,
    defenseLevel: 1,
    staminaLevel: 1,
    intelligenceLevel: 1,
});

/** An editor with two imported strangers loaded and nothing of the player's own */
function editorWithStrangers() {
    const el = document.createElement('div');
    const editor = new SimEditor({ editorEl: el });
    editor.importPlayers([emptyDTO('x'), emptyDTO('y')], ['Stranger A', 'Stranger B']);
    return { el, editor };
}

beforeEach(() => {
    bridge.snapshots = [];
    bridge.applied = [];
    settings.values.clear();
    settings.hold = null;
    game.charId = 'me';
    game.buildHold = null;
    game.characterData = { character: { id: 'me', name: 'Milkman' } };
    game.selfDTO = { ...emptyDTO('player1'), attackLevel: 90, debuffOnLevelGap: 0.3 };
    game.houseRooms = null;
    game.allPlayers = {
        players: [
            { ...emptyDTO('player1'), attackLevel: 90 },
            { ...emptyDTO('player2'), attackLevel: 70 },
        ],
        playerInfo: [
            { hrid: 'player1', name: 'Milkman' },
            { hrid: 'player2', name: 'Partner' },
        ],
        selfHrid: 'player1',
        missingMembers: [],
    };
});

describe('house rooms follow the game', () => {
    test('a room built after the panel opened is read at the next run', () => {
        const { editor } = editorWithStrangers();
        game.selfDTO.houseRooms = { '/house_rooms/dojo': 2, '/house_rooms/garden': 8 };
        editor.resetToSelf();
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo']).toBe(2);

        // The House tab builds Dojo 3 while the panel is open
        game.houseRooms = new Map([
            ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 3 }],
            ['/house_rooms/garden', { houseRoomHrid: '/house_rooms/garden', level: 8 }],
        ]);
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo']).toBe(3);
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/garden']).toBe(8);
    });

    test('a room the user edited by hand is theirs, whatever the game says', () => {
        const { editor } = editorWithStrangers();
        game.selfDTO.houseRooms = { '/house_rooms/dojo': 2 };
        editor.resetToSelf();
        // Hand-edited in the editor to a hypothetical 5
        editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo'] = 5;

        game.houseRooms = new Map([['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 3 }]]);
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo']).toBe(5);
    });

    test("a character simmed from their profile keeps their house, not this player's", () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        const stranger = emptyDTO('player1');
        stranger.houseRooms = { '/house_rooms/dojo': 5, '/house_rooms/garden': 3 };
        editor.openWithExternalDTO(stranger, 'Venaam');

        // This player's own house says otherwise
        game.houseRooms = new Map([
            ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 2 }],
            ['/house_rooms/garden', { houseRoomHrid: '/house_rooms/garden', level: 8 }],
        ]);

        const rooms = editor.getEditedDTOs().player1.houseRooms;
        expect(rooms['/house_rooms/dojo']).toBe(5);
        expect(rooms['/house_rooms/garden']).toBe(3);
    });
});

describe('reset to me', () => {
    test('replaces every imported player with the live character', () => {
        const { editor } = editorWithStrangers();
        expect(editor.getPlayerInfo()).toHaveLength(2);

        expect(editor.resetToSelf()).toBe(true);

        expect(editor.getPlayerInfo()).toEqual([{ hrid: 'player1', name: 'Milkman' }]);
        expect(Object.keys(editor.getEditedDTOs())).toEqual(['player1']);
        expect(editor.getSelfHrid()).toBe('player1');
    });

    test('reads the character now, not the snapshot the import left behind', () => {
        const { editor } = editorWithStrangers();
        // A level-up between opening the panel and pressing the button
        game.selfDTO.attackLevel = 99;

        editor.resetToSelf();

        expect(editor.getEditedDTOs().player1.attackLevel).toBe(99);
    });

    test('a solo character carries no level-gap debuff', () => {
        const { editor } = editorWithStrangers();

        editor.resetToSelf();

        expect(editor.getEditedDTOs().player1.debuffOnLevelGap).toBe(0);
    });

    test('the loadout dropdown goes back to current gear', () => {
        const { editor } = editorWithStrangers();
        editor._selectedLoadoutName = 'Bruteforce';

        editor.resetToSelf();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('says so rather than blanking when there is no character to read', () => {
        const { el, editor } = editorWithStrangers();
        game.selfDTO = null;

        expect(editor.resetToSelf()).toBe(false);

        el.querySelector('[data-reset-players="self"]').click();
        expect(el.textContent).toContain('No character data available');
    });
});

describe('reset to party', () => {
    test('loads this character and the party members alongside them', async () => {
        const { editor } = editorWithStrangers();

        await editor.resetToParty();

        expect(editor.getPlayerInfo().map((p) => p.name)).toEqual(['Milkman', 'Partner']);
        expect(editor.getSelfHrid()).toBe('player1');
        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('a member whose profile was never shared is named, not invented', async () => {
        const { el, editor } = editorWithStrangers();
        game.allPlayers.missingMembers = ['Ghost'];

        await editor.resetToParty();

        expect(el.textContent).toContain('Ghost');
        expect(el.textContent).toContain('shared profile');
        expect(editor.getMissingMembers()).toEqual(['Ghost']);
    });
});

describe('equipment an import could not place', () => {
    /**
     * The parse fails closed on an item the game's own sheet cannot resolve rather
     * than guessing its slot from the export's raw location string. Left to a
     * console warning, a dropped main hand reads on screen as a character who
     * simply fights unarmed.
     */
    const SKIPPED = [
        {
            slot: 1,
            itemHrid: '/items/unknown_blade',
            itemName: 'Unknown Blade',
            itemLocationHrid: '/item_locations/two_hand',
        },
    ];

    test('is named in the editor, not only in the console', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        editor.importPlayers([emptyDTO('x')], ['Stranger A'], SKIPPED);

        expect(el.textContent).toContain('Unknown Blade');
        expect(el.textContent).toContain('Not equipped from the import');
    });

    test('says nothing when every piece resolved', () => {
        const { el } = editorWithStrangers();
        expect(el.textContent).not.toContain('Not equipped from the import');
    });

    /**
     * An import appends its players to whoever is already loaded, so the players
     * the first import brought in are still in the party after a second one. A
     * second import that placed everything must not therefore clear the note
     * about the first import's dropped gear — that is the hole back, silent
     * again, with the affected character still being simmed.
     */
    test("a second import does not clear the first import's note", () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('x')], ['Stranger A'], SKIPPED);

        editor.importPlayers([emptyDTO('y')], ['Stranger B'], []);

        expect(el.textContent).toContain('Unknown Blade');
    });

    test('the note does not survive a reset to the live character', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('x')], ['Stranger A'], SKIPPED);

        editor.resetToSelf();

        expect(el.textContent).not.toContain('Not equipped from the import');
    });
});

describe('the reset buttons', () => {
    test('both sit beside the player chips', () => {
        const { el } = editorWithStrangers();

        expect(el.querySelector('[data-reset-players="self"]')).toBeTruthy();
        expect(el.querySelector('[data-reset-players="party"]')).toBeTruthy();
    });

    test('Reset to Party is disabled, with a reason, when there is no party', () => {
        const { el } = editorWithStrangers();

        const party = el.querySelector('[data-reset-players="party"]');
        expect(party.disabled).toBe(true);
        expect(party.getAttribute('title')).toContain('not in a party');
    });

    test('a party of one is not a party — that is what Reset to Me already does', () => {
        game.characterData.partyInfo = { partySlotMap: { 1: { characterID: 'me' } } };
        const { el, editor } = editorWithStrangers();

        expect(editor.hasPartyData()).toBe(false);
        expect(el.querySelector('[data-reset-players="party"]').disabled).toBe(true);
    });

    test('two filled slots enable it', () => {
        game.characterData.partyInfo = { partySlotMap: { 1: { characterID: 'me' }, 2: { characterID: 'them' } } };
        const { el, editor } = editorWithStrangers();

        expect(editor.hasPartyData()).toBe(true);
        expect(el.querySelector('[data-reset-players="party"]').disabled).toBe(false);
    });

    test('an emptied player list still offers the way back', () => {
        const { el, editor } = editorWithStrangers();
        el.querySelectorAll('[data-remove-player]').forEach((x) => x.click());

        expect(el.textContent).toContain('No players loaded');
        expect(el.querySelector('[data-reset-players="self"]')).toBeTruthy();

        el.querySelector('[data-reset-players="self"]').click();
        expect(editor.getPlayerInfo()).toEqual([{ hrid: 'player1', name: 'Milkman' }]);
    });
});

describe('community buff levels stop where the game does', () => {
    test('the input offers 20, which is what a maxed buff reads in game', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div'), skillingMode: true });

        const html = editor._renderCommunityBuffsSection({ communityBuffLevels: { experience: 12 } });

        expect(html).toContain('max="20"');
        expect(html).not.toContain('max="30"');
    });

    test('a typed level above the cap is clamped to it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el, skillingMode: true });
        el.innerHTML = '<input type="number" data-community-buff="experience" value="30">';
        const dto = { communityBuffLevels: {} };

        editor._wireEditorEvents(el, dto);
        const input = el.querySelector('[data-community-buff]');
        input.dispatchEvent(new Event('change'));

        expect(dto.communityBuffLevels.experience).toBe(20);
        expect(input.value).toBe('20');
    });
});

describe('loadout picker reads the fed store, not this bundle', () => {
    test('renders the dropdown from the bridge store even when this bundle owns an empty copy', () => {
        // The direct import (mocked empty above) is the packaged bundle's own,
        // never-fed copy; a naive read of it hides the picker. The picker must
        // list what the bridge store — the one the websocket feeds — actually has.
        bridge.snapshots = [
            { name: 'Bruteforce', actionTypeHrid: '/action_types/combat' },
            { name: 'Everything', actionTypeHrid: null },
        ];
        const { el } = editorWithStrangers();

        const select = el.querySelector('#mwi-csim-loadout-select');
        expect(select).toBeTruthy();
        expect(select.textContent).toContain('Bruteforce');
        expect(select.textContent).toContain('Everything (All Skills)');
    });

    test('a non-combat loadout is filtered out of the combat picker', () => {
        bridge.snapshots = [{ name: 'Milking', actionTypeHrid: '/action_types/milking' }];
        const { el } = editorWithStrangers();

        // Only a skilling loadout exists, so there is nothing combat to pick.
        expect(el.querySelector('#mwi-csim-loadout-select')).toBeFalsy();
    });

    test('no picker when the fed store has no loadouts at all', () => {
        const { el } = editorWithStrangers();
        expect(el.querySelector('#mwi-csim-loadout-select')).toBeFalsy();
    });
});

/**
 * The Loadout dropdown reset to "Current Gear" every time the panel opened, so a
 * character who sims one build reselected it on every run. The selection is
 * remembered per character and re-applied through the same path a manual pick
 * takes — and only for this character's own DTO.
 */
describe('the editor is built for one character', () => {
    test('a switch inside the DTO build leaves the editor unbuilt rather than holding the wrong gear', async () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        let release;
        game.buildHold = new Promise((resolve) => {
            release = resolve;
        });
        const building = editor.initEditor();
        game.charId = 'iron';
        game.buildHold = null;
        release();
        await building;

        // Adopting would have left the departing character's gear, levels and
        // house in the panel, with nothing to rebuild it — and a sim run from
        // there reports another character's numbers as a measurement
        expect(editor._editorInitialized).toBe(false);
        expect(editor._editedDTOs).toBeNull();

        // and the next build, for whoever is current, still works
        await editor.initEditor();
        expect(editor._editorInitialized).toBe(true);
    });

    test('a build with no character logged in either side is still adopted', async () => {
        // The guard compares the id, it does not require one: a pre-login
        // build must not be refused for having none
        game.charId = null;
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        await editor.initEditor();

        expect(editor._editorInitialized).toBe(true);
    });
});

describe('the loadout selection is remembered', () => {
    const openEditor = async (options = {}) => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el, ...options });
        await editor.initEditor();
        return { el, editor };
    };

    test('picking one stores it, and the next opening applies it', async () => {
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const first = await openEditor();
        const select = first.el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        const { el, editor } = await openEditor();

        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');
        expect(bridge.applied).toContain('Bruteforce');
        expect(el.querySelector('#mwi-csim-loadout-select').value).toBe('Bruteforce');
    });

    test('a loadout that no longer exists falls back to current gear, silently', async () => {
        settings.values.set('simEditorLoadoutName', 'Deleted');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];

        const { editor } = await openEditor();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('going back to Current Gear is remembered too', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();
        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = '';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(settings.values.get('simEditorLoadoutName')).toBe('');
    });

    test('an imported or profile-simmed stranger keeps their own gear', async () => {
        // `_selfHrid` is null for an external DTO, which is what says the stored
        // loadout is not theirs to wear
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.openWithExternalDTO(emptyDTO('them'), 'Stranger');

        await editor._restoreLoadoutMemory();

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(bridge.applied).toEqual([]);
    });

    test('a switch inside the read leaves the arriving character’s editor alone', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor({ restoreLoadout: false });

        let release;
        settings.hold = new Promise((resolve) => {
            release = resolve;
        });
        const restoring = editor._restoreLoadoutMemory();
        game.charId = 'iron';
        settings.hold = null;
        release();
        await restoring;

        // Applying it would have simmed the arriving character in the departing
        // one's gear, and stored that name as the arriving character's memory
        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(bridge.applied).toEqual([]);
    });

    test('the lab editor drives the dropdown itself and is left out', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];

        const { editor } = await openEditor({ labMode: true });

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(bridge.applied).toEqual([]);
    });

    test('Reset to Current forgets it, so the next opening is current gear', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const { editor } = await openEditor();

        editor.resetToSelf();
        await Promise.resolve();

        expect(settings.values.get('simEditorLoadoutName')).toBe('');
    });
});

describe('achievements section', () => {
    const damage = { typeHrid: '/buff_types/damage', ratioBoost: 0.02 };
    const wisdom = { typeHrid: '/buff_types/wisdom', flatBoost: 0.05 };

    test('lists the detected achievement buffs, all ticked by default', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });

        const html = editor._renderAchievementsSection({ achievementCombatBuffs: [damage, wisdom] });

        expect(html).toContain('data-achievement-buff="/buff_types/damage"');
        expect(html).toContain('Damage +2%');
        expect(html).toContain('data-achievement-buff="/buff_types/wisdom"');
        expect(html).toMatch(/data-achievement-buff="\/buff_types\/damage" checked/);
        expect(html).toContain('2 active');
    });

    test('a toggled-off buff renders unchecked and drops the active count', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });

        const html = editor._renderAchievementsSection({
            achievementCombatBuffs: [damage, wisdom],
            achievementBuffsOff: ['/buff_types/damage'],
        });

        expect(html).not.toMatch(/data-achievement-buff="\/buff_types\/damage" checked/);
        expect(html).toMatch(/data-achievement-buff="\/buff_types\/wisdom" checked/);
        expect(html).toContain('1 active');
    });

    test('a player with no achievement buffs shows no section', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        expect(editor._renderAchievementsSection({ achievementCombatBuffs: [] })).toBe('');
    });

    test('a derived import captions itself as derived from achievements', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({
            achievementCombatBuffs: [damage, wisdom],
            achievementBuffsOff: ['/buff_types/damage'],
            achievementBuffsDerived: true,
        });
        expect(html).toContain('Derived from their completed achievements — adjust if needed.');
    });

    test('a manual import (no derivation) keeps the "set manually" caption', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({
            achievementCombatBuffs: [damage, wisdom],
            achievementBuffsOff: ['/buff_types/damage', '/buff_types/wisdom'],
            achievementBuffsManual: true,
        });
        expect(html).toContain('Not in shared profiles — set manually.');
    });

    test('your own character keeps the live-detected caption', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({ achievementCombatBuffs: [damage, wisdom] });
        expect(html).toContain('From your completed achievements. Untick to sim without one.');
    });

    test('the skilling tab hides it', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div'), skillingMode: true });
        expect(editor._renderAchievementsSection({ achievementCombatBuffs: [damage] })).toBe('');
    });

    test('unticking excludes the buff; re-ticking restores it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        el.innerHTML =
            '<input type="checkbox" data-achievement-buff="/buff_types/damage" checked>' +
            '<input type="checkbox" data-achievement-buff="/buff_types/wisdom" checked>';
        const dto = { achievementBuffsOff: [] };

        editor._wireEditorEvents(el, dto);
        const dmg = el.querySelector('[data-achievement-buff="/buff_types/damage"]');
        dmg.checked = false;
        dmg.dispatchEvent(new Event('change'));

        expect(dto.achievementBuffsOff).toEqual(['/buff_types/damage']);

        dmg.checked = true;
        dmg.dispatchEvent(new Event('change'));
        expect(dto.achievementBuffsOff).toEqual([]);
    });
});

describe('scrolls section', () => {
    test('offers the combat scrolls and pre-checks the ones the player carries', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });

        const html = editor._renderScrollsSection({ scrollBuffs: ['/buff_types/damage'] });

        // DPS/loot scrolls and the two dual-purpose ones (wisdom, rare find)
        expect(html).toContain('data-scroll-buff="/buff_types/damage"');
        expect(html).toContain('data-scroll-buff="/buff_types/attack_speed"');
        expect(html).toContain('data-scroll-buff="/buff_types/critical_rate"');
        expect(html).toContain('data-scroll-buff="/buff_types/wisdom"');
        expect(html).toContain('data-scroll-buff="/buff_types/rare_find"');
        // damage is carried, attack speed is not
        expect(html).toMatch(/data-scroll-buff="\/buff_types\/damage" checked/);
        expect(html).not.toMatch(/data-scroll-buff="\/buff_types\/attack_speed" checked/);
        expect(html).toContain('1 active');
    });

    test('the skilling tab hides it — its scroll picker lives elsewhere', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div'), skillingMode: true });
        expect(editor._renderScrollsSection({ scrollBuffs: [] })).toBe('');
    });

    test('ticking a scroll adds it to the DTO; unticking removes it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        el.innerHTML =
            '<input type="checkbox" data-scroll-buff="/buff_types/rare_find">' +
            '<input type="checkbox" data-scroll-buff="/buff_types/wisdom" checked>';
        const dto = { scrollBuffs: ['/buff_types/wisdom'] };

        editor._wireEditorEvents(el, dto);
        const rareFind = el.querySelector('[data-scroll-buff="/buff_types/rare_find"]');
        rareFind.checked = true;
        rareFind.dispatchEvent(new Event('change'));

        expect(dto.scrollBuffs).toContain('/buff_types/rare_find');
        expect(dto.scrollBuffs).toContain('/buff_types/wisdom');

        const wisdom = el.querySelector('[data-scroll-buff="/buff_types/wisdom"]');
        wisdom.checked = false;
        wisdom.dispatchEvent(new Event('change'));

        expect(dto.scrollBuffs).toEqual(['/buff_types/rare_find']);
    });
});
