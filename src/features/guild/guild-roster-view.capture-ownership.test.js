/** @vitest-environment happy-dom
 *
 * The Guild Roster's half of the loadout capture's reference count.
 *
 * `guildLoadoutCapture` is counted (`owners`) because two features start it and
 * neither owns it. The roster incremented that count in `initialize()` and
 * never gave it back in `cleanup()`, so across a character switch the count
 * only ever went up: the capture was never torn down, and `characterId`,
 * `guildName` and `record` — all resolved once, inside `initialize()` — stayed
 * pointed at the character that had left.
 *
 * The real `guild-loadout-capture.js` is used here on purpose. A mock of it
 * would prove only that a call was made; what is worth pinning down is that
 * the count reaches zero, that the module re-derives whose record it is
 * holding, and that a capture still owned by Guild Trials is *not* stopped.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Whoever the game says is logged in right now */
const world = vi.hoisted(() => ({ characterId: 'char1' }));

/** Live domObserver registrations, by name, so a teardown is observable */
const registrations = vi.hoisted(() => ({ live: [] }));

/** What was read from and written to the loadout store, and under which key */
const store = vi.hoisted(() => ({ loads: [], saves: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => world.characterId, on: () => {}, off: () => {} },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name) => {
            registrations.live.push(name);
            return () => {
                const at = registrations.live.indexOf(name);
                if (at !== -1) registrations.live.splice(at, 1);
            };
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./guild-loadouts.js', () => ({
    describeLoadoutAge: () => '',
    extractLoadout: () => null,
    extractPartyLoadouts: () => [],
    foldLoadout: (record) => record,
    isMonsterUnit: () => false,
    isItemName: () => false,
    loadLoadouts: async (characterId, guildName) => {
        store.loads.push({ characterId, guildName });
        return { players: {}, updatedAt: 0 };
    },
    loadoutKey: (name) => String(name || '').toLowerCase(),
    loadoutList: (record) => Object.values(record?.players || {}),
    pruneCharacterOnlyLoadouts: async () => [],
    purgeMonsterLoadouts: (record) => ({ record, purged: [] }),
    saveLoadouts: async (characterId, record, guildName) => {
        store.saves.push({ characterId, guildName });
    },
}));

// Everything below is the roster panel's own furniture, mocked because none of
// it is what this file is about.
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => true } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));
vi.mock('./guild-member-skills.js', () => ({
    default: { progress: () => ({ logged: 0, total: 0, next: null, stale: 0 }), anyBattleUnits: () => false },
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => 'Milky Way',
        getAllMemberSeries: () => ({}),
        getMemberList: () => [],
        getGuildSeries: () => [],
        getGuildLevelProgress: () => null,
    },
}));

const { default: guildLoadoutCapture } = await import('./guild-loadout-capture.js');
const { default: guildRosterFeature } = await import('./guild-roster-view.js');

describe('the roster gives the loadout capture its owner back', () => {
    beforeEach(() => {
        while (guildLoadoutCapture.owners > 0) guildLoadoutCapture.cleanup();
        world.characterId = 'char1';
        registrations.live = [];
        store.loads = [];
        store.saves = [];
        document.body.innerHTML = '';
    });

    afterEach(() => {
        while (guildLoadoutCapture.owners > 0) guildLoadoutCapture.cleanup();
    });

    test('a start and a teardown of the roster alone leave nothing running', async () => {
        await guildRosterFeature.initialize();
        expect(guildLoadoutCapture.owners).toBe(1);
        expect(guildLoadoutCapture.initialized).toBe(true);

        guildRosterFeature.cleanup();

        expect(guildLoadoutCapture.owners).toBe(0);
        expect(guildLoadoutCapture.initialized).toBe(false);
        expect(registrations.live).toEqual([]);
    });

    test('the count does not creep upwards across character switches', async () => {
        for (let switches = 0; switches < 3; switches++) {
            await guildRosterFeature.initialize();
            guildRosterFeature.cleanup();
        }
        expect(guildLoadoutCapture.owners).toBe(0);
    });

    test('the arriving character does not inherit the departing one’s record key', async () => {
        world.characterId = 'char1';
        await guildRosterFeature.initialize();
        // The guild name arrives on socket traffic after initialize(), exactly
        // as it does in the client
        await guildLoadoutCapture.setGuildName('Milky Way');
        expect(guildLoadoutCapture.characterId).toBe('char1');

        // The switch: every feature is torn down, then rebuilt under the
        // character that has arrived
        guildRosterFeature.cleanup();
        world.characterId = 'char2';
        await guildRosterFeature.initialize();

        expect(guildLoadoutCapture.characterId).toBe('char2');
        expect(guildLoadoutCapture.guildName).toBe(null);

        // And the next guild the socket names is filed under the character who
        // is actually in that guild
        store.saves = [];
        await guildLoadoutCapture.setGuildName('Other Guild');
        expect(store.loads.at(-1)).toEqual({ characterId: 'char2', guildName: 'Other Guild' });
        expect(store.saves.every((save) => save.characterId === 'char2')).toBe(true);
    });

    test('a capture Guild Trials still holds is not stopped by the roster going down', async () => {
        await guildRosterFeature.initialize();
        // Guild Trials starts it too; either being on is reason enough
        await guildLoadoutCapture.initialize();
        expect(guildLoadoutCapture.owners).toBe(2);

        const liveBefore = [...registrations.live];
        guildRosterFeature.cleanup();

        expect(guildLoadoutCapture.owners).toBe(1);
        expect(guildLoadoutCapture.initialized).toBe(true);
        expect(registrations.live).toEqual(liveBefore);
    });
});
