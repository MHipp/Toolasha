/**
 * Tests for SettingsStorage import character matching
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stored = new Map();
/** When set, every read answers "could not be made" and every write is refused */
const outage = { on: false };

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn((key, _area, defaultValue) =>
            Promise.resolve(outage.on ? defaultValue : (stored.get(`json:${key}`) ?? defaultValue))
        ),
        parseJSON: vi.fn((raw, _key, defaultValue) => (raw == null ? defaultValue : raw)),
        setJSON: vi.fn((key, value) => {
            if (outage.on) return Promise.resolve(false);
            stored.set(`json:${key}`, value);
            return Promise.resolve();
        }),
        get: vi.fn((key, _area, defaultValue) =>
            Promise.resolve(outage.on ? defaultValue : (stored.get(key) ?? defaultValue))
        ),
        tryGet: vi.fn((key) => {
            if (outage.on) return Promise.resolve(null);
            const value = stored.get(`json:${key}`) ?? stored.get(key);
            return Promise.resolve(value != null ? { found: true, value } : { found: false, value: null });
        }),
        set: vi.fn((key, value) => {
            if (outage.on) return Promise.resolve(false);
            stored.set(key, value);
            return Promise.resolve();
        }),
        getAll: vi.fn(() => Promise.resolve({})),
    },
}));

vi.mock('./data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'alice',
        getCurrentCharacterName: () => 'Alice',
    },
}));

const { default: settingsStorage } = await import('./settings-storage.js');
const { default: storage } = await import('./storage.js');
// The real config, over the real settings storage: the two-client regression
// below is only a regression end to end, where config decides what it changed
// and storage decides what it writes.
const { default: config } = await import('./config.js');

describe('SettingsStorage.importSettings known-character matching', () => {
    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('skips keys suffixed with another known character id (new object format)', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
        ]);

        const result = await settingsStorage.importSettings(
            JSON.stringify({
                script_settingsMap_alice: { some: 'setting' },
                script_settingsMap_bob: { other: 'setting' },
                globalKey: { shared: true },
            })
        );

        expect(result).toEqual({ imported: 2, skipped: 1 });
        expect(stored.has('json:script_settingsMap_alice')).toBe(true);
        expect(stored.has('json:script_settingsMap_bob')).toBe(false);
        expect(stored.has('json:globalKey')).toBe(true);
    });

    test('recognises known characters listed in the imported payload itself', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                known_character_ids: [
                    { id: 'alice', name: 'Alice' },
                    { id: 'carol', name: 'Carol' },
                ],
                script_settingsMap_carol: { other: 'setting' },
            })
        );

        expect(result.skipped).toBe(1);
        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
    });

    test('handles legacy plain-id known-character arrays in imported payloads', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                known_character_ids: ['alice', 'dave'],
                script_settingsMap_dave: { other: 'setting' },
            })
        );

        expect(result.skipped).toBe(1);
        expect(stored.has('json:script_settingsMap_dave')).toBe(false);
    });
});

describe('one-time rewrites of superseded schema defaults', () => {
    const KEY = 'script_settingsMap_alice';
    const FLAG = `settings_default_rewrites_v1_${KEY}`;

    /** A saved map holding the old defaults, as an existing user's would */
    const oldDefaults = () => ({
        labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: true },
        labyrinthPathUnknownMode: { id: 'labyrinthPathUnknownMode', type: 'select', value: 'clearable' },
    });

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user sitting on the old defaults is moved to the new ones', async () => {
        stored.set(`json:${KEY}`, oldDefaults());

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        // and it is persisted, not just applied in memory
        expect(stored.get(`json:${KEY}`).labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(stored.get(`json:${KEY}`).labyrinthPathUnknownMode.value).toBe('shroud');
    });

    test('a value that was never the old default is left alone', async () => {
        stored.set(`json:${KEY}`, {
            labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: false },
            labyrinthPathUnknownMode: { id: 'labyrinthPathUnknownMode', type: 'select', value: 'avoid' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthPathUnknownMode.value).toBe('avoid');
    });

    test('re-choosing the old value after the rewrite keeps it — this runs once', async () => {
        stored.set(`json:${KEY}`, oldDefaults());
        await settingsStorage.loadSettings();
        expect(stored.get(FLAG)).toBe(true);

        // The user goes back to the old values on purpose
        stored.set(`json:${KEY}`, oldDefaults());
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(true);
        expect(settings.labyrinthPathUnknownMode.value).toBe('clearable');
    });

    test('a fresh install gets the new defaults and is flagged, so it is never revisited', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        expect(stored.get(FLAG)).toBe(true);
    });
});

describe('the marketplace buy-strategy default change is new-installs-only, by design', () => {
    // market_autoFillBuyStrategy's schema default moved from 'outbid' to
    // 'match', but — unlike the labyrinth defaults above — it has no
    // DEFAULT_REWRITES entry, deliberately: an existing user's stored
    // 'outbid' is their chosen strategy, not a stale default to be nudged off.
    // Only a fresh install (nothing stored at all) ever sees 'match'.
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user with outbid stored keeps outbid after load', async () => {
        stored.set(`json:${KEY}`, {
            market_autoFillBuyStrategy: { id: 'market_autoFillBuyStrategy', type: 'select', value: 'outbid' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_autoFillBuyStrategy.value).toBe('outbid');
        // and nothing rewrote the stored value either
        expect(stored.get(`json:${KEY}`).market_autoFillBuyStrategy.value).toBe('outbid');
    });
});

describe('SettingsStorage copy-from-character', () => {
    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('syncing to other characters carries the per-character task lists along', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
        ]);
        stored.set('json:taskProtectedHrids_alice', ['/actions/a']);
        // No auto-reroll list for alice: bob's stays untouched

        const count = await settingsStorage.syncSettingsToAllCharacters({ featureX: { isTrue: true } });

        expect(count).toBe(1);
        expect(stored.get('json:script_settingsMap_bob')).toEqual({ featureX: { isTrue: true } });
        expect(stored.get('json:taskProtectedHrids_bob')).toEqual(['/actions/a']);
        expect(stored.has('json:taskAutoRerollHrids_bob')).toBe(false);
    });

    test('copies a source character map onto the current character', async () => {
        const bobMap = { featureX: { isTrue: true }, mode: { value: 'fast' } };
        stored.set('json:script_settingsMap_bob', bobMap);

        const ok = await settingsStorage.copySettingsFromCharacter('bob');

        expect(ok).toBe(true);
        expect(stored.get('json:script_settingsMap_alice')).toEqual(bobMap);
    });

    test('refuses to copy from self, an unknown id, or an empty map', async () => {
        stored.set('json:script_settingsMap_empty', {});

        expect(await settingsStorage.copySettingsFromCharacter('alice')).toBe(false);
        expect(await settingsStorage.copySettingsFromCharacter('ghost')).toBe(false);
        expect(await settingsStorage.copySettingsFromCharacter('empty')).toBe(false);
        expect(await settingsStorage.copySettingsFromCharacter(null)).toBe(false);
        expect(stored.get('json:script_settingsMap_alice')).toBeUndefined();
    });

    test('a character switch mid-copy does not land the source map on the arriving character', async () => {
        // The destination key used to be asked for after the source read came
        // back, so the map went to whoever was current *then* — the arriving
        // character's settings replaced by a map they never asked for.
        stored.set('json:script_settingsMap_bob', { featureX: { isTrue: true } });
        storage.getJSON.mockImplementationOnce(async (key, _area, defaultValue) => {
            settingsStorage.setCharacterId('carol', 'Carol');
            return stored.get(`json:${key}`) ?? defaultValue;
        });

        expect(await settingsStorage.copySettingsFromCharacter('bob')).toBe(false);
        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
        expect(stored.has('json:script_settingsMap_alice')).toBe(false);
        settingsStorage.setCharacterId('alice', 'Alice');
    });

    test('lists only other characters that actually have settings', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
            { id: 'carol', name: 'Carol' },
        ]);
        stored.set('json:script_settingsMap_bob', { x: { isTrue: true } });
        // carol is known but has no settings map; alice is the current character

        const candidates = await settingsStorage.charactersWithSettings();

        expect(candidates).toEqual([{ id: 'bob', name: 'Bob' }]);
    });
});

describe('a settings store that cannot be read', () => {
    const KEY = 'script_settingsMap_alice';
    /** A saved map with one choice made off the defaults */
    const saved = () => ({
        whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: false },
        ironCow_enabled: { id: 'ironCow_enabled', type: 'checkbox', isTrue: true },
    });

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    test("a readable load is reported as one, and reads the user's values", async () => {
        stored.set(`json:${KEY}`, saved());
        const map = await settingsStorage.loadSettings();
        expect(settingsStorage.lastLoadReadable).toBe(true);
        expect(map.whatsNew_showPopup.isTrue).toBe(false);
        expect(map.ironCow_enabled.isTrue).toBe(true);
    });

    test('reads the character key once, not once for the probe and again to parse it', async () => {
        // loadSettings() used to follow tryGet() (a probe, to tell "absent"
        // from "could not be read") with a second getJSON() of the exact same
        // key just to get it parsed — a redundant IndexedDB round trip on
        // every settings load, on the hot startup path. It now parses the
        // value the probe already read.
        stored.set(`json:${KEY}`, saved());
        storage.getJSON.mockClear();
        storage.tryGet.mockClear();

        const map = await settingsStorage.loadSettings();

        expect(map.ironCow_enabled.isTrue).toBe(true);
        expect(storage.tryGet).toHaveBeenCalledTimes(1);
        expect(storage.getJSON).not.toHaveBeenCalledWith(KEY, expect.anything(), expect.anything());
    });

    test('a load that cannot be made says so, answers defaults, and runs no migration', async () => {
        stored.set(`json:${KEY}`, saved());
        stored.set('json:known_character_ids', [{ id: 'bob', name: 'Bob' }]);
        outage.on = true;

        const map = await settingsStorage.loadSettings();
        expect(settingsStorage.lastLoadReadable).toBe(false);
        expect(map.whatsNew_showPopup.isTrue).toBe(true);
        expect(map.ironCow_enabled.isTrue).toBe(false);

        outage.on = false;
        // Neither the map nor the known-characters list was touched
        expect(stored.get(`json:${KEY}`)).toEqual(saved());
        expect(stored.get('json:known_character_ids')).toEqual([{ id: 'bob', name: 'Bob' }]);
    });

    test('setSetting does not write a map it could not read', async () => {
        stored.set(`json:${KEY}`, saved());
        outage.on = true;
        await settingsStorage.setSetting('whatsNew_newDefaultsOff', true);
        outage.on = false;
        expect(stored.get(`json:${KEY}`)).toEqual(saved());

        // And writes once it can
        await settingsStorage.setSetting('whatsNew_newDefaultsOff', true);
        expect(stored.get(`json:${KEY}`).whatsNew_newDefaultsOff.isTrue).toBe(true);
        expect(stored.get(`json:${KEY}`).ironCow_enabled.isTrue).toBe(true);
    });

    test('setSetting does not file one character’s map under another’s key', async () => {
        // `loadSettings()` reads the key that was current when it started;
        // `saveSettings()` used to ask for the key that is current when it
        // runs. A character switch in that gap wrote the departing character's
        // whole settings map, plus this edit, over the arriving character's.
        stored.set(`json:${KEY}`, saved());
        storage.tryGet.mockImplementationOnce(async (key) => {
            settingsStorage.setCharacterId('carol', 'Carol');
            const value = stored.get(`json:${key}`) ?? stored.get(key);
            return value != null ? { found: true, value } : { found: false, value: null };
        });

        await settingsStorage.setSetting('whatsNew_newDefaultsOff', true);

        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
        expect(stored.get(`json:${KEY}`)).toEqual(saved());
        settingsStorage.setCharacterId('alice', 'Alice');
    });

    describe('saveSettingsKeepingStored', () => {
        test('refuses when the store cannot be read', async () => {
            stored.set(`json:${KEY}`, saved());
            outage.on = true;
            const map = settingsStorage.buildDefaults();
            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(false);
            outage.on = false;
            expect(stored.get(`json:${KEY}`)).toEqual(saved());
        });

        test('keeps every stored entry the session left at its default, and writes the ones it changed', async () => {
            stored.set(`json:${KEY}`, saved());
            const map = settingsStorage.buildDefaults();
            map.whatsNew_newDefaultsOff.isTrue = !map.whatsNew_newDefaultsOff.isTrue;

            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(true);
            const after = stored.get(`json:${KEY}`);
            // The user's choices, which the session never saw, stand
            expect(after.whatsNew_showPopup.isTrue).toBe(false);
            expect(after.ironCow_enabled.isTrue).toBe(true);
            // The session's own change lands
            expect(after.whatsNew_newDefaultsOff.isTrue).toBe(map.whatsNew_newDefaultsOff.isTrue);
            // And the rest of the schema is filled in as a whole-map write would
            expect(Object.keys(after).length).toBe(Object.keys(map).length);
        });

        test('a store with nothing under the key is written whole', async () => {
            const map = settingsStorage.buildDefaults();
            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(true);
            expect(stored.get(`json:${KEY}`)).toEqual(map);
        });
    });
});

describe('the known-characters roster holds one entry per character', () => {
    beforeEach(() => {
        stored.clear();
        outage.on = false;
    });

    test('a numeric game id matches the stored string entry instead of duplicating it', async () => {
        stored.set('json:known_character_ids', [{ id: '30404', name: 'MillenniumTest' }]);

        // The game sends the id as a number; before the type fix this pushed a duplicate
        await settingsStorage.addToKnownCharacters(30404, 'MillenniumTest');

        const list = await settingsStorage.getKnownCharacters();
        expect(list).toEqual([{ id: '30404', name: 'MillenniumTest' }]);
    });

    test('a roster the duplicate bug inflated heals itself on read', async () => {
        stored.set('json:known_character_ids', [
            { id: '30404', name: '30404' },
            ...Array.from({ length: 150 }, () => ({ id: 30404, name: 'MillenniumTest' })),
            ...Array.from({ length: 7 }, () => ({ id: '32030', name: 'MillenniumTestIC' })),
        ]);

        const list = await settingsStorage.getKnownCharacters();

        expect(list).toEqual([
            { id: '30404', name: 'MillenniumTest' },
            { id: '32030', name: 'MillenniumTestIC' },
        ]);
        // Healed roster is written back, so the collapse happens once
        expect(stored.get('json:known_character_ids')).toHaveLength(2);
    });

    test('a real name is never replaced by an id echoed as one', async () => {
        stored.set('json:known_character_ids', [
            { id: '30404', name: 'MillenniumTest' },
            { id: '30404', name: '30404' },
        ]);

        expect(await settingsStorage.getKnownCharacters()).toEqual([{ id: '30404', name: 'MillenniumTest' }]);
    });

    test('a genuinely new character is still added, id stored as a string', async () => {
        await settingsStorage.addToKnownCharacters(99999, 'NewAlt');

        expect(await settingsStorage.getKnownCharacters()).toEqual([{ id: '99999', name: 'NewAlt' }]);
    });
});

describe('a save keeps setting ids this build does not know about', () => {
    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an id absent from the schema survives a whole-map write', async () => {
        // What a sync pull leaves behind: the newer build's id is on disk, and
        // this build's `loadSettings()` has no entry for it, so it is simply
        // not in the map handed to `saveSettings`
        stored.set('json:script_settingsMap_alice', {
            chatCommands: { isTrue: true },
            futureFeature_enabled: { isTrue: false },
        });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } });

        const written = stored.get('json:script_settingsMap_alice');
        expect(written.chatCommands).toEqual({ isTrue: false });
        // Dropping this is how an old build strips settings the player chose on
        // a newer one, and they come back as defaults on the next upgrade
        expect(written.futureFeature_enabled).toEqual({ isTrue: false });
    });

    test('the caller wins for every id it does mention', async () => {
        stored.set('json:script_settingsMap_alice', { chatCommands: { isTrue: true } });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } });

        expect(stored.get('json:script_settingsMap_alice').chatCommands).toEqual({ isTrue: false });
    });

    test('a store that cannot be read still takes the write', async () => {
        // Refusing here would lose the change the player just made, which is
        // worse than losing ids this build cannot show them anyway
        outage.on = true;
        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } });
        outage.on = false;

        expect(storage.setJSON).toHaveBeenCalledWith(
            'script_settingsMap_alice',
            { chatCommands: { isTrue: false } },
            expect.anything(),
            true
        );
    });
});

describe('a saved boolean entry that carries both fields', () => {
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('loads the value the user set, not the stale isTrue beside it', async () => {
        // The shape the old setter wrote when a ticked box was unticked: the new
        // answer went into `.value` and the stale `.isTrue` was left standing.
        stored.set(`json:${KEY}`, {
            whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: true, value: false },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.whatsNew_showPopup.isTrue).toBe(false);
        // And the stray does not come back with it, so nothing reads it again
        expect(Object.hasOwn(map.whatsNew_showPopup, 'value')).toBe(false);
    });

    test('the same heal runs the other way round', async () => {
        stored.set(`json:${KEY}`, {
            whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: false, value: true },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.whatsNew_showPopup.isTrue).toBe(true);
    });

    test('the checkboxWithButton value-only migration still works', async () => {
        stored.set(`json:${KEY}`, {
            simulateScrollEffects: { id: 'simulateScrollEffects', type: 'checkboxWithButton', value: true },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.simulateScrollEffects.isTrue).toBe(true);
        expect(Object.hasOwn(map.simulateScrollEffects, 'value')).toBe(false);
    });

    test('a boolean entry with only isTrue is left alone', async () => {
        stored.set(`json:${KEY}`, {
            whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: false },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.whatsNew_showPopup.isTrue).toBe(false);
    });

    test('a non-boolean setting carrying both fields is untouched by the rule', async () => {
        stored.set(`json:${KEY}`, {
            actionQueue_valueMode: {
                id: 'actionQueue_valueMode',
                type: 'select',
                value: 'estimated_value',
                isTrue: true,
            },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.actionQueue_valueMode.value).toBe('estimated_value');
        // The stray boolean rides along exactly as it did before
        expect(map.actionQueue_valueMode.isTrue).toBe(true);
    });
});

describe('a save carries only what this client changed', () => {
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test("another client's change to an untouched id survives", async () => {
        stored.set(`json:${KEY}`, {
            chatCommands: { isTrue: true },
            xpTracker: { isTrue: true },
        });

        // A stale map: loaded before the other client wrote xpTracker
        const stale = { chatCommands: { isTrue: false }, xpTracker: { isTrue: false } };
        await settingsStorage.saveSettings(stale, ['chatCommands']);

        const written = stored.get(`json:${KEY}`);
        expect(written.chatCommands).toEqual({ isTrue: false });
        expect(written.xpTracker).toEqual({ isTrue: true });
    });

    test('an id the store does not have at all still lands', async () => {
        stored.set(`json:${KEY}`, { chatCommands: { isTrue: true } });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: true }, brandNewSetting: { isTrue: true } }, [
            'chatCommands',
        ]);

        expect(stored.get(`json:${KEY}`).brandNewSetting).toEqual({ isTrue: true });
    });

    test('SAVE_ALL_KEYS writes every setting, as the reset to defaults needs', async () => {
        stored.set(`json:${KEY}`, { chatCommands: { isTrue: true }, xpTracker: { isTrue: true } });

        const defaults = { chatCommands: { isTrue: false }, xpTracker: { isTrue: false } };
        await settingsStorage.saveSettings(defaults, settingsStorage.SAVE_ALL_KEYS);

        expect(stored.get(`json:${KEY}`)).toEqual(defaults);
    });

    test('a scoped save still keeps ids this build does not know', async () => {
        stored.set(`json:${KEY}`, {
            chatCommands: { isTrue: true },
            futureFeature_enabled: { isTrue: false },
        });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } }, ['chatCommands']);

        expect(stored.get(`json:${KEY}`).futureFeature_enabled).toEqual({ isTrue: false });
    });

    test('a store that cannot be read still takes a scoped write', async () => {
        outage.on = true;
        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } }, ['chatCommands']);
        outage.on = false;

        expect(storage.setJSON).toHaveBeenCalledWith(
            'script_settingsMap_alice',
            { chatCommands: { isTrue: false } },
            expect.anything(),
            true
        );
    });
});

describe('two clients on one character', () => {
    const KEY = 'script_settingsMap_alice';
    /** Let the setters' fire-and-forget save reach storage */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
        config._dirtyKeys = new Set();
        config.settingsMap = {};
        config.characterSettingsLoaded = false;
        config.settingChangeCallbacks = {};
        config.settingsLoadedCallbacks = [];
    });

    /**
     * One config singleton stands in for two clients: each "client" is the map
     * and dirty set it loaded, swapped in around its own writes. That is exactly
     * what a second tab holds — its own snapshot of the same store.
     */
    const asClient = (client) => {
        config.settingsMap = client.map;
        config._dirtyKeys = client.dirty;
        config.characterSettingsLoaded = true;
    };
    const loadClient = async () => {
        config.settingsMap = {};
        config._dirtyKeys = new Set();
        config.characterSettingsLoaded = false;
        await config.loadSettings();
        return { map: config.settingsMap, dirty: config._dirtyKeys };
    };

    test("a stale client's save does not revert the setting the other client changed", async () => {
        const a = await loadClient();
        const b = await loadClient();

        asClient(a);
        const xWanted = !config.getSetting('chatCommands');
        config.setSetting('chatCommands', xWanted);
        await settle();

        // B has been holding its map since before A's write, and knows nothing
        // about it — the whole-map save used to put B's stale copy of X back
        asClient(b);
        const yWanted = !config.getSetting('xpTracker');
        config.setSetting('xpTracker', yWanted);
        await settle();

        const written = stored.get(`json:${KEY}`);
        expect(written.chatCommands.isTrue).toBe(xWanted);
        expect(written.xpTracker.isTrue).toBe(yWanted);
    });

    test('a reset to defaults still writes every setting', async () => {
        const a = await loadClient();
        asClient(a);
        config.setSetting('chatCommands', !config.getSetting('chatCommands'));
        await settle();

        await config.resetToDefaults();

        const written = stored.get(`json:${KEY}`);
        const defaults = settingsStorage.buildDefaults();
        expect(Object.keys(written).length).toBe(Object.keys(defaults).length);
        expect(written.chatCommands.isTrue).toBe(defaults.chatCommands.isTrue);
    });
});
