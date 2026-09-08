/** @vitest-environment happy-dom */

/**
 * Catching a loadout as it goes past.
 *
 * The popup scrape is the part that has never been run against a live client, so
 * most of this file is about what it must *refuse*: a modal that is not a unit
 * popup, and a popup that the socket already covered. Reading a settings dialog
 * as a guild member would put a player who does not exist on the roster panel,
 * and it would be persisted.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const game = vi.hoisted(() => ({
    clientData: {},
    store: {},
    characterId: 'char-1',
    characterName: null,
    wsHandlers: {},
    observers: {},
    /** key → promise a `storage.get` of it waits on */
    holds: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterName: () => game.characterName,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            // A read a test can hold open, for the switch-mid-adoption case
            if (game.holds[key]) await game.holds[key];
            return key in game.store ? game.store[key] : fallback;
        },
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, classNames, callback) => {
            for (const name of Array.isArray(classNames) ? classNames : [classNames]) {
                game.observers[name] = callback;
            }
            return () => {};
        },
    },
}));

const { guildLoadoutCapture, readUnitPopup, POPUP_SOCKET_WINDOW_MS } = await import('./guild-loadout-capture.js');
const { guildLoadoutsStorageKey } = await import('./guild-loadouts.js');

/**
 * Build a modal out of runs of text, as the game renders one.
 * @param {Array<string|string[]>} entries - Lines, or label/value pairs
 * @returns {HTMLElement} The modal
 */
function modal(entries) {
    const root = document.createElement('div');
    root.className = 'Modal_modalContent__abc';

    for (const entry of entries) {
        const line = document.createElement('div');
        for (const run of Array.isArray(entry) ? entry : [entry]) {
            const span = document.createElement('span');
            span.textContent = run;
            line.appendChild(span);
        }
        root.appendChild(line);
    }

    document.body.appendChild(root);
    return root;
}

describe('readUnitPopup', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('reads the header and the labelled numbers', () => {
        const popup = modal([
            ['Tib - Lv.150'],
            ['Armor', '62'],
            ['Magic Evasion', '1,240'],
            ['Rare Find', '12.0%'],
            ['HP Regen', '3.0%'],
        ]);

        const loadout = readUnitPopup(popup, 5);
        expect(loadout).toMatchObject({ name: 'Tib', level: 150, source: 'popup', at: 5 });
        // The scrape cannot read the ability icons, and must say so rather
        // than claiming an empty kit
        expect(loadout.abilitiesAuthoritative).toBe(false);
        expect(loadout.rows).toEqual([
            { label: 'Armor', value: '62' },
            { label: 'Magic Evasion', value: '1,240' },
            { label: 'Rare Find', value: '12.0%' },
            { label: 'HP Regen', value: '3.0%' },
        ]);
    });

    test('the name may sit in the run before the level', () => {
        const popup = modal([
            ['Moo'],
            ['Lv.99'],
            ['Armor', '1'],
            ['Parry', '2%'],
            ['Threat', '3%'],
            ['Tenacity', '4%'],
        ]);
        expect(readUnitPopup(popup).name).toBe('Moo');
    });

    test('a modal with a header and no stat sheet is not a unit popup', () => {
        expect(readUnitPopup(modal([['Tib - Lv.150'], ['Close'], ['Battle Info'], ['Stats']]))).toBeNull();
    });

    test('a modal with numbers and no header is not one either', () => {
        expect(
            readUnitPopup(
                modal([
                    ['Coins', '1,240'],
                    ['Fee', '2%'],
                    ['Total', '9'],
                    ['Net', '8'],
                ])
            )
        ).toBeNull();
    });

    test('nothing at all is null rather than a throw', () => {
        expect(readUnitPopup(null)).toBeNull();
        expect(readUnitPopup({})).toBeNull();
    });

    describe('locale-grouped values', () => {
        const asLocale = (value) => {
            localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        test('en-US comma grouping', () => {
            asLocale('en-US');
            const popup = modal([
                ['Tib - Lv.150'],
                ['Armor', '62'],
                ['Magic Evasion', '1,240'],
                ['Rare Find', '12.0%'],
                ['HP Regen', '3.0%'],
            ]);
            expect(readUnitPopup(popup).rows).toContainEqual({ label: 'Magic Evasion', value: '1,240' });
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]+(?:\.\d+)?` reads "1.240" as decimal 1.24, so
            // the value cell no longer matches the whole-string value pattern
            // and the row is dropped from the sheet entirely.
            asLocale('de-DE');
            const popup = modal([
                ['Tib - Lv.150'],
                ['Armor', '62'],
                ['Magic Evasion', '1.240'],
                ['Rare Find', '12,0%'],
                ['HP Regen', '3,0%'],
            ]);
            expect(readUnitPopup(popup).rows).toContainEqual({ label: 'Magic Evasion', value: '1.240' });
        });
    });
});

describe('the capture', () => {
    beforeEach(async () => {
        game.store = {};
        game.characterId = 'char-1';
        game.characterName = null;
        game.clientData = {};
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.record = { players: {}, updatedAt: 0 };
        guildLoadoutCapture.lastSocketAt = 0;
        await guildLoadoutCapture.initialize();
    });

    afterEach(() => {
        guildLoadoutCapture.cleanup();
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    test('a fetched unit is remembered and written down', async () => {
        game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { id: 'char-9', name: 'Tib' },
                combatDetails: { combatLevel: 150, maxHitpoints: 4120, combatStats: { combatRareFind: 0.12 } },
                combatAbilities: [{ abilityHrid: '/abilities/fireball', level: 40 }],
            },
        });

        expect(guildLoadoutCapture.forPlayer('tib')).toMatchObject({ name: 'Tib', level: 150 });

        await vi.advanceTimersByTimeAsync(2000);
        expect(game.store[guildLoadoutsStorageKey('char-1')].players.tib.name).toBe('Tib');
    });

    test('the end-of-session message neither stores nor stands the scrape down', () => {
        game.wsHandlers.battle_unit_fetched({ unit: { character: { name: 'Tib' }, totalLootMap: {} } });
        expect(guildLoadoutCapture.seen()).toEqual([]);

        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Tib')?.source).toBe('popup');
    });

    test('a party assembling records everybody in it', () => {
        game.wsHandlers.new_battle({
            players: [
                { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
                { character: { name: 'Moo' }, combatDetails: { maxHitpoints: 3000, combatStats: {} } },
            ],
        });

        expect(
            guildLoadoutCapture
                .seen()
                .map((entry) => entry.name)
                .sort()
        ).toEqual(['Moo', 'Tib']);
    });

    test('the local player’s own new_battle is skipped, matched by id', () => {
        game.characterName = 'Me';
        game.wsHandlers.new_battle({
            players: [
                { character: { id: 'char-1', name: 'Me' }, combatDetails: { maxHitpoints: 4000, combatStats: {} } },
                { character: { id: 'char-9', name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
            ],
        });

        // The teammate is exactly what the message is for; the local player's
        // own row must wait for their Battle Info to actually be opened
        expect(guildLoadoutCapture.seen().map((entry) => entry.name)).toEqual(['Tib']);
    });

    test('the local player’s own new_battle is skipped by name when the entry carries no id', () => {
        game.characterName = 'Me';
        game.wsHandlers.new_battle({
            players: [
                { character: { name: 'ME' }, combatDetails: { maxHitpoints: 4000, combatStats: {} } },
                { character: { name: 'Moo' }, combatDetails: { maxHitpoints: 3000, combatStats: {} } },
            ],
        });

        expect(guildLoadoutCapture.seen().map((entry) => entry.name)).toEqual(['Moo']);
    });

    test('the local player’s Battle Info still folds, socket and popup alike', () => {
        game.characterName = 'Me';
        game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { id: 'char-1', name: 'Me' },
                combatDetails: { combatLevel: 150, maxHitpoints: 4000, combatStats: {} },
                combatAbilities: [],
            },
        });
        expect(guildLoadoutCapture.forPlayer('Me')?.source).toBe('battle_unit_fetched');

        vi.advanceTimersByTime(POPUP_SOCKET_WINDOW_MS + 1000);
        game.observers.Modal_modalContent(
            modal([['Me - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Me')?.source).toBe('popup');
    });

    test('the scrape stands down when the socket has just answered', () => {
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
        });
        expect(guildLoadoutCapture.forPlayer('Tib').source).toBe('battle_unit_fetched');

        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Tib').source).toBe('battle_unit_fetched');

        // Past the window it is the only source there is, so it takes over
        vi.advanceTimersByTime(POPUP_SOCKET_WINDOW_MS + 1000);
        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );
        expect(guildLoadoutCapture.forPlayer('Tib').source).toBe('popup');
    });

    test('a popup taking over does not erase a kit the socket captured', () => {
        game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { name: 'Tib' },
                combatDetails: { maxHitpoints: 4120, combatStats: {} },
                combatAbilities: [{ abilityHrid: '/abilities/fireball', level: 40 }],
            },
        });
        expect(guildLoadoutCapture.forPlayer('Tib').abilities).toHaveLength(1);

        vi.advanceTimersByTime(POPUP_SOCKET_WINDOW_MS + 1000);
        game.observers.Modal_modalContent(
            modal([['Tib - Lv.150'], ['Armor', '62'], ['Parry', '2%'], ['Threat', '3%'], ['Tenacity', '4%']])
        );

        const stored = guildLoadoutCapture.forPlayer('Tib');
        expect(stored.source).toBe('popup');
        expect(stored.abilities).toHaveLength(1);
        expect(stored.abilitiesAuthoritative).toBe(true);
    });

    test('a recorded loadout is announced, and an unsubscribed listener hears nothing more', () => {
        const heard = [];
        const off = guildLoadoutCapture.onCaptured((event) => heard.push(event));

        game.wsHandlers.battle_unit_fetched({
            unit: {
                character: { id: 'char-9', name: 'Tib' },
                combatDetails: { combatLevel: 150, maxHitpoints: 4120, combatStats: {} },
                combatAbilities: [{ abilityHrid: '/abilities/fireball', level: 40 }],
            },
        });

        expect(heard).toEqual([
            {
                characterId: 'char-9',
                name: 'Tib',
                source: 'battle_unit_fetched',
                abilitiesAuthoritative: true,
                at: Date.now(),
            },
        ]);
        // Announced before the debounced save could possibly have run
        expect(game.store[guildLoadoutsStorageKey('char-1')]).toBeUndefined();

        off();
        game.wsHandlers.new_battle({
            players: [{ character: { name: 'Moo' }, combatDetails: { maxHitpoints: 3000, combatStats: {} } }],
        });
        expect(heard).toHaveLength(1);
    });

    test('a listener that throws is logged and does not silence the rest', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const heard = [];
        guildLoadoutCapture.onCaptured(() => {
            throw new Error('boom');
        });
        guildLoadoutCapture.onCaptured((event) => heard.push(event.name));

        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
        });

        expect(heard).toEqual(['Tib']);
        expect(errors).toHaveBeenCalled();
        expect(guildLoadoutCapture.forPlayer('Tib')).toBeTruthy();
        errors.mockRestore();
    });

    test('an alt does not inherit this character’s sightings', async () => {
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Tib' }, combatDetails: { maxHitpoints: 4120, combatStats: {} } },
        });
        await vi.advanceTimersByTimeAsync(2000);

        game.characterId = 'char-2';
        game.wsHandlers.battle_unit_fetched({
            unit: { character: { name: 'Moo' }, combatDetails: { maxHitpoints: 3000, combatStats: {} } },
        });
        await vi.advanceTimersByTimeAsync(2000);

        expect(guildLoadoutCapture.seen().map((entry) => entry.name)).toEqual(['Moo']);
        expect(game.store[guildLoadoutsStorageKey('char-1')].players.tib).toBeDefined();
        expect(game.store[guildLoadoutsStorageKey('char-2')].players.moo).toBeDefined();
    });

    test('a broken payload is logged rather than thrown', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => game.wsHandlers.battle_unit_fetched(null)).not.toThrow();
        expect(() => game.wsHandlers.new_battle(null)).not.toThrow();
        expect(() => game.observers.Modal_modalContent(null)).not.toThrow();
        errors.mockRestore();
    });
});

describe('two owners', () => {
    afterEach(() => {
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.cleanup();
    });

    test('one feature being switched off does not take the listeners from the other', async () => {
        game.wsHandlers = {};
        await guildLoadoutCapture.initialize();
        await guildLoadoutCapture.initialize();

        guildLoadoutCapture.cleanup();
        expect(typeof game.wsHandlers.battle_unit_fetched).toBe('function');

        guildLoadoutCapture.cleanup();
        expect(game.wsHandlers.battle_unit_fetched).toBeUndefined();
    });

    test('the last cleanup clears the capture listeners with the socket ones', async () => {
        game.wsHandlers = {};
        await guildLoadoutCapture.initialize();
        guildLoadoutCapture.onCaptured(() => {});
        expect(guildLoadoutCapture.listeners.size).toBe(1);

        guildLoadoutCapture.cleanup();
        expect(guildLoadoutCapture.listeners.size).toBe(0);
    });
});

describe('guild scoping', () => {
    beforeEach(async () => {
        game.store = {};
        game.holds = {};
        game.characterId = 'char-1';
        game.clientData = {};
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.record = { players: {}, updatedAt: 0 };
        guildLoadoutCapture.guildName = null;
        guildLoadoutCapture.lastSocketAt = 0;
        // The one piece of the singleton `initialize()` does not recompute. In
        // the game it only ever moves forward, but every test here rewinds the
        // clock to the same instant — so an epoch left by a test that advanced
        // its timers sits in the FUTURE of the next test's sightings, and the
        // adoption rule (`at >= max(startedAt, guildEpochAt)`) then refuses to
        // carry them onto the guild key.
        guildLoadoutCapture.guildEpochAt = 0;
        await guildLoadoutCapture.initialize();
    });

    afterEach(() => {
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.guildName = null;
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    const sheet = (name) => ({
        unit: {
            character: { id: `id-${name}`, name },
            combatDetails: { combatLevel: 150, maxHitpoints: 100, combatStats: {} },
            combatAbilities: [],
        },
    });

    test('the character-only record adopts onto the guild key once, when the guild has none', async () => {
        game.wsHandlers.battle_unit_fetched(sheet('Tib'));
        await guildLoadoutCapture.setGuildName('Testmaxxing');
        await vi.advanceTimersByTimeAsync(2000);

        expect(game.store[guildLoadoutsStorageKey('char-1', 'Testmaxxing')].players.tib).toBeDefined();
    });

    test('a guild with its own record does not inherit another guild’s people', async () => {
        // The reported leak, exactly: Cream and ICMeow, seen in the guild this
        // character left, listed beside the new guild's fighters
        game.store[guildLoadoutsStorageKey('char-1', 'NewGuild')] = {
            players: { rick: { name: 'Rick', rows: [], at: 5 } },
            updatedAt: 5,
        };
        guildLoadoutCapture.record = {
            players: {
                cream: { name: 'Cream', rows: [], at: 1 },
                icmeow: { name: 'ICMeow', rows: [], at: 1 },
            },
            updatedAt: 1,
        };
        await guildLoadoutCapture.setGuildName('NewGuild');

        const names = guildLoadoutCapture.seen().map((player) => player.name);
        expect(names).toContain('Rick');
        expect(names).not.toContain('Cream');
        expect(names).not.toContain('ICMeow');
    });

    test('sightings captured this session survive the adoption — they happened in this guild', async () => {
        game.store[guildLoadoutsStorageKey('char-1', 'NewGuild')] = {
            players: { rick: { name: 'Rick', rows: [], at: 5 } },
            updatedAt: 5,
        };
        game.wsHandlers.battle_unit_fetched(sheet('Fresh'));
        await guildLoadoutCapture.setGuildName('NewGuild');

        const names = guildLoadoutCapture.seen().map((player) => player.name);
        expect(names).toContain('Rick');
        expect(names).toContain('Fresh');
    });

    test('an empty guild key does not inherit the character-only record’s older people', async () => {
        // The reported state: `guildLoadouts_30404` and
        // `guildLoadouts_30404_SuperMoo` byte-identical minutes after the
        // switch, the whole Testmaxxing roster adopted because SuperMoo's key
        // happened to be empty
        guildLoadoutCapture.record = {
            players: {
                sarintest: { name: 'sarintest', rows: [], at: 1 },
                orven: { name: 'orven', rows: [], at: 1 },
            },
            updatedAt: 1,
        };
        game.wsHandlers.battle_unit_fetched(sheet('Fresh'));

        await guildLoadoutCapture.setGuildName('SuperMoo');

        const names = guildLoadoutCapture.seen().map((player) => player.name);
        expect(names).toEqual(['Fresh']);
        expect(names).not.toContain('sarintest');
        expect(names).not.toContain('orven');
    });

    test('the character-only record is left on disk rather than deleted', async () => {
        game.store[guildLoadoutsStorageKey('char-1')] = {
            players: { legacy: { name: 'Legacy', rows: [], at: 1 } },
            updatedAt: 1,
        };
        game.wsHandlers.battle_unit_fetched(sheet('Fresh'));
        await guildLoadoutCapture.setGuildName('SuperMoo');
        await vi.advanceTimersByTimeAsync(2000);

        expect(game.store[guildLoadoutsStorageKey('char-1')].players.legacy).toBeDefined();
    });

    test('whatever the guild key now holds is dropped from the character-only key', async () => {
        game.store[guildLoadoutsStorageKey('char-1')] = {
            players: {
                legacy: { name: 'Legacy', rows: [], at: 1 },
                fresh: { name: 'Fresh', rows: [], at: 1 },
            },
            updatedAt: 1,
        };
        game.wsHandlers.battle_unit_fetched(sheet('Fresh'));
        await guildLoadoutCapture.setGuildName('SuperMoo');
        await vi.advanceTimersByTimeAsync(2000);

        const characterOnly = game.store[guildLoadoutsStorageKey('char-1')].players;
        expect(characterOnly.fresh).toBeUndefined();
        expect(characterOnly.legacy).toBeDefined();
    });

    test('a second guild name inherits nothing seen inside the first', async () => {
        game.wsHandlers.battle_unit_fetched(sheet('Testmaxxer'));
        await guildLoadoutCapture.setGuildName('Testmaxxing');
        await vi.advanceTimersByTimeAsync(2000);

        await guildLoadoutCapture.setGuildName('SuperMoo');
        expect(guildLoadoutCapture.seen()).toEqual([]);
        // …and the guild they left keeps its own, for if they go back
        expect(game.store[guildLoadoutsStorageKey('char-1', 'Testmaxxing')].players.testmaxxer).toBeDefined();
    });

    test('a character switch during the adoption read leaves the arriving character alone', async () => {
        // The old guard compared the guild NAME, and both sides of a first
        // adoption are `null` — so a switch that landed inside the read was
        // invisible to it, and the rest of the adoption ran the DEPARTING
        // character's roster against the arriving character's keys.
        const guildKey = guildLoadoutsStorageKey('char-1', 'Testmaxxing');
        game.store[guildKey] = { players: { tib: { name: 'Tib', rows: [], at: 1 } }, updatedAt: 1 };
        game.store[guildLoadoutsStorageKey('char-2')] = {
            players: {
                moo: { name: 'Moo', rows: [], at: 1 },
                // Also on char-1's guild roster, so the prune would take it
                tib: { name: 'Tib', rows: [], at: 1 },
            },
            updatedAt: 1,
        };

        let release;
        game.holds[guildKey] = new Promise((resolve) => {
            release = resolve;
        });

        const adopting = guildLoadoutCapture.setGuildName('Testmaxxing');
        await Promise.resolve();

        // A snapshot is what tells the capture the character changed
        game.characterId = 'char-2';
        game.wsHandlers.battle_unit_fetched(sheet('Newcomer'));
        await vi.advanceTimersByTimeAsync(0);

        release();
        await adopting;
        await vi.advanceTimersByTimeAsync(2000);

        // char-1's roster must not be filed under char-2's guild key…
        expect(game.store[guildLoadoutsStorageKey('char-2', 'Testmaxxing')]).toBeUndefined();
        // …and char-2's own "Seen loadouts" must not be pruned against it
        expect(game.store[guildLoadoutsStorageKey('char-2')].players.tib).toBeDefined();
    });
});

describe('monsters are never loadouts', () => {
    const monsters = {
        '/monsters/salamander': { name: 'Salamander' },
        '/monsters/frost_sniper': { name: 'Frost Sniper' },
    };

    beforeEach(() => {
        game.store = {};
        game.characterId = 'char-1';
        game.clientData = { combatMonsterDetailMap: monsters };
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.record = { players: {}, updatedAt: 0 };
        guildLoadoutCapture.guildName = null;
        guildLoadoutCapture.lastSocketAt = 0;
    });

    afterEach(() => {
        guildLoadoutCapture.cleanup();
        guildLoadoutCapture.guildName = null;
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    test('a stored entry named after a monster is purged on load', async () => {
        game.store[guildLoadoutsStorageKey('char-1')] = {
            players: {
                salamander: { name: 'Salamander', rows: [{ label: 'Armor', value: '10' }], at: 5 },
                tib: { name: 'Tib', rows: [], at: 5 },
            },
            updatedAt: 5,
        };

        await guildLoadoutCapture.initialize();

        expect(guildLoadoutCapture.seen().map((player) => player.name)).toEqual(['Tib']);
        expect(game.store[guildLoadoutsStorageKey('char-1')].players.salamander).toBeUndefined();
    });

    test('a monster’s Battle Info sheet is not folded in', async () => {
        await guildLoadoutCapture.initialize();

        game.wsHandlers.battle_unit_fetched({
            unit: {
                isPlayer: true,
                name: 'Frost Sniper',
                combatDetails: { combatLevel: 90, maxHitpoints: 5000, combatStats: {} },
                combatAbilities: [],
            },
        });

        expect(guildLoadoutCapture.seen()).toEqual([]);
    });

    test('a monster popup is not scraped as a member', async () => {
        await guildLoadoutCapture.initialize();

        const node = modal([
            'Salamander - Lv.90',
            ['Max HP', '5,000'],
            ['Armor', '120'],
            ['Water resist', '30'],
            ['Stab evasion', '400'],
        ]);
        game.observers.Modal_modalContent(node);

        expect(guildLoadoutCapture.seen()).toEqual([]);
    });
});
