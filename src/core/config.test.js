/**
 * Tests for Config setting accessors
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

/** The sync-pull restore latch, which refuses writes to a store until a reload */
const storageMock = vi.hoisted(() => ({ restorePending: false }));
vi.mock('./storage.js', () => ({
    default: {
        isRestorePending: (storeName) => storageMock.restorePending && storeName === 'settings',
    },
}));

vi.mock('./websocket.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
    },
}));

const settingsStorageMock = vi.hoisted(() => ({
    lastLoadReadable: true,
    // The real module hangs this off the singleton so it crosses a bundle
    // boundary; the reset-to-defaults path is identified by it
    SAVE_ALL_KEYS: Symbol('settings.saveAllKeys'),
    saveSettings: vi.fn(() => Promise.resolve()),
    saveSettingsKeepingStored: vi.fn(() => Promise.resolve(true)),
    loadSettings: vi.fn(() => Promise.resolve({})),
    buildDefaults: vi.fn(() => ({})),
    setCharacterId: vi.fn(),
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char-1',
    getCurrentCharacterName: () => 'TestChar',
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

vi.mock('./settings-storage.js', () => ({ default: settingsStorageMock }));

vi.mock('./data-manager.js', () => ({ default: dataManagerMock }));

const { default: config } = await import('./config.js');
const { settingsGroups } = await import('./settings-schema.js');

// `config` is a module singleton, so every test in this file shares one
// instance. The reload-window describes below leave `_pendingValues` populated
// (a write taken but not yet stored outranks both the map and the schema in
// getSetting), leave a watchdog timer armed and leave `characterSettingsLoaded`
// set — state that decided the answers of whichever test ran next. Wiping the
// whole of the singleton's cross-test state here means no test inherits it.
beforeEach(() => {
    clearTimeout(config._reloadWatchdog);
    config._reloadWatchdog = null;
    config._pendingWrites = [];
    config._pendingValues = Object.create(null);
    config._loadGeneration = 0;
    config.settingsMap = {};
    config._dirtyKeys = new Set();
    config.settingsOwner = null;
    config.characterSettingsLoaded = false;
    config.settingChangeCallbacks = {};
    config.settingsLoadedCallbacks = [];

    // The hoisted mocks are shared by the whole file too, and the describes
    // below reach into them: one clears the character id (which makes
    // loadSettings return before it ever reaches storage or the loaded
    // callbacks), others `mockReset()` loadSettings (leaving it with no
    // implementation at all) or leave `lastLoadReadable`/`restorePending`
    // flipped. Put every one of them back to the declared default so a test
    // gets the mock it was written against whatever ran before it.
    dataManagerMock.characterId = 'char-1';
    storageMock.restorePending = false;
    settingsStorageMock.lastLoadReadable = true;
    settingsStorageMock.loadSettings.mockReset().mockImplementation(() => Promise.resolve({}));
    settingsStorageMock.saveSettings.mockReset().mockImplementation(() => Promise.resolve());
    settingsStorageMock.saveSettingsKeepingStored.mockReset().mockImplementation(() => Promise.resolve(true));
    settingsStorageMock.buildDefaults.mockReset().mockImplementation(() => ({}));
    settingsStorageMock.setCharacterId.mockReset();
});

describe('Config.getSetting', () => {
    beforeEach(() => {
        config.settingsMap = {
            checkboxOn: { id: 'checkboxOn', isTrue: true },
            checkboxOff: { id: 'checkboxOff', isTrue: false },
            pricingMode: { id: 'pricingMode', value: 'optimistic' },
            goldPerHour: { id: 'goldPerHour', value: 250000 },
            zeroNumber: { id: 'zeroNumber', value: 0 },
        };
    });

    test('returns booleans for checkbox settings', () => {
        expect(config.getSetting('checkboxOn')).toBe(true);
        expect(config.getSetting('checkboxOff')).toBe(false);
    });

    test('returns stored value for select settings instead of false', () => {
        expect(config.getSetting('pricingMode')).toBe('optimistic');
    });

    test('returns stored value for number settings, including 0', () => {
        expect(config.getSetting('goldPerHour')).toBe(250000);
        expect(config.getSetting('zeroNumber')).toBe(0);
    });

    test('returns provided default for unknown settings', () => {
        expect(config.getSetting('doesNotExist')).toBe(false);
        expect(config.getSetting('doesNotExist', 'fallback')).toBe('fallback');
    });

    test('falls back to the schema default for a setting that has not loaded yet', () => {
        // Nothing is in settingsMap for these, so the answer has to come from
        // the flattened schema-default map rather than from stored settings.
        config.settingsMap = {};

        for (const group of Object.values(settingsGroups)) {
            for (const [key, setting] of Object.entries(group.settings || {})) {
                if (setting.default === undefined || setting.default === null) continue;
                expect(config.getSetting(key)).toEqual(setting.default);
            }
        }
    });

    test('a key absent from the schema still returns the caller default', () => {
        config.settingsMap = {};
        expect(config.getSetting('no_such_setting_anywhere', 'sentinel')).toBe('sentinel');
    });
});

describe('Config.setSetting', () => {
    beforeEach(() => {
        config.settingsMap = {
            checkbox: { id: 'checkbox', isTrue: false },
            pricingMode: { id: 'pricingMode', value: 'hybrid' },
        };
        config.settingChangeCallbacks = {};
    });

    test('writes isTrue for checkbox settings', () => {
        config.setSetting('checkbox', true);
        expect(config.settingsMap.checkbox.isTrue).toBe(true);
        expect(config.getSetting('checkbox')).toBe(true);
    });

    test('writes value for select settings so the write round-trips', () => {
        config.setSetting('pricingMode', 'conservative');
        expect(config.settingsMap.pricingMode.value).toBe('conservative');
        expect(config.settingsMap.pricingMode.isTrue).toBeUndefined();
        expect(config.getSetting('pricingMode')).toBe('conservative');
        expect(config.getSettingValue('pricingMode')).toBe('conservative');
    });

    test('fires registered change callbacks', () => {
        const cb = vi.fn();
        config.onSettingChange('pricingMode', cb);
        config.setSetting('pricingMode', 'optimistic');
        expect(cb).toHaveBeenCalledWith('optimistic');
    });
});

/**
 * `setSettingValue` wrote `value` whatever the setting was. On a checkbox that
 * is not the field the setting uses, and nothing complains: `getSettingValue`
 * prefers `value` when it is there, so the write appears to work for the rest of
 * the session. The entry saved is `{isTrue: <stale>, value: <new>}`, and on the
 * next load it is rebuilt from the schema shape without the stray `value` — so
 * the stale `isTrue` answers, and the change is silently undone.
 *
 * This is the Lab Sim "Uncapped" box that could not be unticked: untick, reload,
 * ticked again, every time.
 */
describe('a checkbox written through setSettingValue', () => {
    beforeEach(() => {
        config.settingsMap = {
            uncapped: { id: 'uncapped', type: 'checkbox', isTrue: true },
            pricingMode: { id: 'pricingMode', value: 'hybrid' },
        };
        config.settingChangeCallbacks = {};
        config._pendingValues = {};
    });

    test('lands in isTrue, not in a second field beside it', () => {
        config.setSettingValue('uncapped', false);

        expect(config.settingsMap.uncapped.isTrue).toBe(false);
        expect(config.settingsMap.uncapped.value, 'a stray value field is what survives a reload').toBeUndefined();
        expect(config.getSettingValue('uncapped')).toBe(false);
    });

    test('survives the entry being rebuilt, which is what a reload does', () => {
        config.setSettingValue('uncapped', false);
        const saved = { ...config.settingsMap.uncapped };

        // A reload rebuilds each entry from the schema shape: a checkbox comes
        // back with isTrue and nothing else. Whatever the write left in `value`
        // is gone, so `isTrue` is the only answer left.
        config.settingsMap = { uncapped: { id: 'uncapped', type: 'checkbox', isTrue: saved.isTrue } };

        expect(config.getSettingValue('uncapped')).toBe(false);
    });

    test('an entry already carrying both fields is healed, not added to', () => {
        // What is on disk for anyone who hit this before the fix
        config.settingsMap.uncapped = { id: 'uncapped', type: 'checkbox', isTrue: true, value: false };

        config.setSettingValue('uncapped', false);

        expect(config.settingsMap.uncapped.isTrue).toBe(false);
        expect(config.settingsMap.uncapped.value).toBeUndefined();
    });

    test('and a non-checkbox setting still writes value', () => {
        config.setSettingValue('pricingMode', 'conservative');

        expect(config.settingsMap.pricingMode.value).toBe('conservative');
        expect(config.settingsMap.pricingMode.isTrue).toBeUndefined();
    });
});

describe('Config.onSettingsLoaded', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingsMap = {};
    });

    test('fires after loadSettings repopulates the map, even when the previous map was empty', async () => {
        // The character-switch case: the cache is cleared (previous map empty), so
        // no per-key change callback fires — this channel is the only resync signal.
        const cb = vi.fn();
        config.onSettingsLoaded(cb);

        await config.loadSettings('char-1');

        expect(cb).toHaveBeenCalledTimes(1);
    });

    test('offSettingsLoaded unsubscribes', async () => {
        const cb = vi.fn();
        config.onSettingsLoaded(cb);
        config.offSettingsLoaded(cb);

        await config.loadSettings('char-1');

        expect(cb).not.toHaveBeenCalled();
    });

    test('a throwing callback does not stop the others', async () => {
        const boom = vi.fn(() => {
            throw new Error('nope');
        });
        const after = vi.fn();
        config.onSettingsLoaded(boom);
        config.onSettingsLoaded(after);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await config.loadSettings('char-1');

        expect(after).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

/**
 * Colors are interpolated straight into inline styles, so a name Config does not
 * define does not throw — it renders `color: undefined` and the browser drops the
 * declaration. The only way to catch that is to check the names.
 */
describe('Config — color constants', () => {
    const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|[a-z]+)$/i;

    const colorMembers = [
        'COLOR_PROFIT',
        'COLOR_LOSS',
        'COLOR_WARNING',
        'COLOR_INFO',
        'COLOR_ESSENCE',
        'COLOR_TEXT_PRIMARY',
        'COLOR_TEXT_SECONDARY',
        'COLOR_BORDER',
        'COLOR_GOLD',
        'COLOR_ACCENT',
        'SCRIPT_COLOR_MAIN',
        'SCRIPT_COLOR_TOOLTIP',
        'SCRIPT_COLOR_ALERT',
    ];

    for (const member of colorMembers) {
        test(`${member} is a usable CSS color`, () => {
            expect(CSS_COLOR.test(String(config[member]).trim())).toBe(true);
        });
    }

    test('SCRIPT_COLOR_PRIMARY and SCRIPT_COLOR_SECONDARY are not defined', () => {
        expect(config.SCRIPT_COLOR_PRIMARY).toBeUndefined();
        expect(config.SCRIPT_COLOR_SECONDARY).toBeUndefined();
    });

    test('and nothing under src/ reads them', async () => {
        // A per-object assertion cannot catch a caller reintroducing the name,
        // which is exactly how the six broken call sites survived.
        const { readdirSync, readFileSync, statSync } = await import('fs');
        const { join, resolve, dirname } = await import('path');
        const { fileURLToPath } = await import('url');

        const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const files = [];
        const walk = (dir) => {
            for (const entry of readdirSync(dir)) {
                if (entry === 'node_modules') continue;
                const full = join(dir, entry);
                if (statSync(full).isDirectory()) walk(full);
                else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) files.push(full);
            }
        };
        walk(srcDir);

        const violations = [];
        for (const file of files) {
            const content = readFileSync(file, 'utf8');
            for (const name of ['config.SCRIPT_COLOR_PRIMARY', 'config.SCRIPT_COLOR_SECONDARY']) {
                if (content.includes(name)) violations.push(`${file}: ${name}`);
            }
        }

        expect(violations).toEqual([]);
    });
});

describe('Config and a settings store that cannot be read', () => {
    const userMap = () => ({ checkbox: { id: 'checkbox', type: 'checkbox', isTrue: true } });
    const defaultMap = () => ({ checkbox: { id: 'checkbox', type: 'checkbox', isTrue: false } });

    beforeEach(() => {
        config.settingsMap = {};
        config.settingsOwner = null;
        config.characterSettingsLoaded = false;
        config.settingChangeCallbacks = {};
        config.settingsLoadedCallbacks = [];
        dataManagerMock.characterId = 'char-1';
        settingsStorageMock.lastLoadReadable = true;
        settingsStorageMock.loadSettings
            .mockReset()
            .mockImplementation(async () => (settingsStorageMock.lastLoadReadable ? userMap() : defaultMap()));
        settingsStorageMock.saveSettings.mockClear();
        settingsStorageMock.saveSettingsKeepingStored.mockClear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    test('a readable load is the settings, and saves write the map whole', async () => {
        await config.loadSettings();
        expect(config.characterSettingsLoaded).toBe(true);
        expect(config.getSetting('checkbox')).toBe(true);

        config.setSetting('checkbox', false);
        expect(settingsStorageMock.saveSettings).toHaveBeenCalledTimes(1);
        expect(settingsStorageMock.saveSettingsKeepingStored).not.toHaveBeenCalled();
    });

    test('a load that cannot be made keeps the settings in hand for the same character', async () => {
        await config.loadSettings();
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(true);
        expect(config.characterSettingsLoaded).toBe(true);
    });

    test("but not another character's, which gives way to defaults that do not count as loaded", async () => {
        await config.loadSettings();
        dataManagerMock.characterId = 'char-2';
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(false);
        expect(config.characterSettingsLoaded).toBe(false);
    });

    test('a save from defaults that stood in for unread settings goes through the merge-save, never whole', async () => {
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();
        config.setSetting('checkbox', true);

        expect(settingsStorageMock.saveSettings).not.toHaveBeenCalled();
        expect(settingsStorageMock.saveSettingsKeepingStored).toHaveBeenCalledTimes(1);
        expect(settingsStorageMock.saveSettingsKeepingStored.mock.calls[0][0].checkbox.isTrue).toBe(true);
    });

    test('once the settings are read back, saves write the map whole again', async () => {
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();
        settingsStorageMock.lastLoadReadable = true;
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(true);
        config.setSetting('checkbox', false);
        expect(settingsStorageMock.saveSettings).toHaveBeenCalledTimes(1);
    });

    test('before a character is known, the defaults are never written whole either', async () => {
        dataManagerMock.characterId = null;
        await config.loadSettings();
        config.settingsMap = defaultMap();
        config.setSetting('checkbox', true);
        expect(settingsStorageMock.saveSettings).not.toHaveBeenCalled();
        expect(settingsStorageMock.saveSettingsKeepingStored).toHaveBeenCalledTimes(1);
    });
});

describe('setting-change listener registration', () => {
    beforeEach(() => {
        config.settingsMap = { probe: { isTrue: false } };
        config.settingChangeCallbacks = {};
        settingsStorageMock.saveSettings.mockClear();
        settingsStorageMock.saveSettingsKeepingStored.mockClear();
    });

    // Every other subscribe in core (domObserver.register/onClass, onQuotaExceeded,
    // inventorySort.onModeChange) hands back an unregister function, and at least one
    // caller already assumed this one did too — custom-tabs-ui pushes the return value
    // onto its teardown list, where `undefined` is silently skipped. Its two setting
    // listeners survived every disable(), so a character switch left another pair
    // behind, each firing into a torn-down panel.
    test('onSettingChange hands back an unregister function', () => {
        const cb = vi.fn();
        const unregister = config.onSettingChange('probe', cb);

        expect(typeof unregister).toBe('function');
        unregister();
        config.setSetting('probe', true);

        expect(cb).not.toHaveBeenCalled();
    });

    test('unregistering one listener leaves the others subscribed', () => {
        const kept = vi.fn();
        const unregister = config.onSettingChange('probe', vi.fn());
        config.onSettingChange('probe', kept);

        unregister();
        config.setSetting('probe', true);

        expect(kept).toHaveBeenCalledWith(true);
    });

    test('unregistering twice is harmless', () => {
        const unregister = config.onSettingChange('probe', vi.fn());
        unregister();
        expect(() => unregister()).not.toThrow();
    });

    test('onSettingsLoaded hands back an unregister function too', () => {
        const cb = vi.fn();
        const unregister = config.onSettingsLoaded(cb);
        expect(typeof unregister).toBe('function');
        unregister();
        expect(config.settingsLoadedCallbacks).not.toContain(cb);
    });
});

describe('setting-change listener dispatch', () => {
    beforeEach(() => {
        config.settingsMap = { probe: { isTrue: false }, probeValue: { value: 1 } };
        config.settingChangeCallbacks = {};
        settingsStorageMock.saveSettings.mockClear();
        settingsStorageMock.saveSettingsKeepingStored.mockClear();
    });

    // The loop was unguarded, so one feature's listener throwing took out every
    // listener registered behind it for that key — and the throw escaped setSetting
    // into whichever toggle handler made the change, which then did not finish
    // either. Both dispatch sites in core that fan out to many subscribers
    // (domObserver, webSocketHook) already isolate each one.
    test('a throwing listener does not starve the ones behind it', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        config.onSettingChange('probe', () => {
            throw new Error('boom');
        });
        const second = vi.fn();
        config.onSettingChange('probe', second);

        expect(() => config.setSetting('probe', true)).not.toThrow();

        expect(second).toHaveBeenCalledWith(true);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('setSettingValue isolates its listeners the same way', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        config.onSettingChange('probeValue', () => {
            throw new Error('boom');
        });
        const second = vi.fn();
        config.onSettingChange('probeValue', second);

        expect(() => config.setSettingValue('probeValue', 7)).not.toThrow();

        expect(second).toHaveBeenCalledWith(7);
        spy.mockRestore();
    });

    test('a listener that unregisters another mid-dispatch does not skip it', () => {
        const third = vi.fn();
        const box = {};
        config.onSettingChange('probe', () => box.unregisterSecond());
        box.unregisterSecond = config.onSettingChange('probe', vi.fn());
        config.onSettingChange('probe', third);

        config.setSetting('probe', true);

        expect(third).toHaveBeenCalledWith(true);
    });
});

/**
 * A character switch clears the settings map and only repopulates it a few
 * awaits later. A settings-panel toggle that lands in that window used to be
 * a silent no-op — `settingsMap[key]` was undefined, both setters fell out of
 * their `if`, and the checkbox stayed flipped over a value that was never
 * written or notified.
 */
describe('Config — a write during the settings-reload window', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingChangeCallbacks = {};
        config._pendingWrites = [];
        settingsStorageMock.lastLoadReadable = true;
        settingsStorageMock.saveSettings.mockClear();
        dataManagerMock.characterId = 'char-1';
    });

    test('setSetting lands and notifies once loadSettings repopulates the map', async () => {
        config.clearSettingsCache();
        const cb = vi.fn();
        config.onSettingChange('checkbox', cb);

        config.setSetting('checkbox', true);
        // Taken at once — a feature that paints from this key has to repaint
        // now, not when the load happens to land
        expect(cb).toHaveBeenCalledWith(true);

        settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
        await config.loadSettings();

        expect(config.settingsMap.checkbox.isTrue).toBe(true);
        expect(config.getSetting('checkbox')).toBe(true);
        expect(cb).toHaveBeenCalledWith(true);
    });

    test('setSettingValue lands the same way', async () => {
        config.clearSettingsCache();
        const cb = vi.fn();
        config.onSettingChange('pricingMode', cb);

        config.setSettingValue('pricingMode', 'conservative');

        settingsStorageMock.loadSettings.mockResolvedValueOnce({
            pricingMode: { id: 'pricingMode', value: 'hybrid' },
        });
        await config.loadSettings();

        expect(config.getSetting('pricingMode')).toBe('conservative');
        expect(cb).toHaveBeenCalledWith('conservative');
    });

    test('the settings-loaded channel sees the queued value, not the value that was loaded', async () => {
        config.clearSettingsCache();
        let seen = null;
        config.onSettingsLoaded(() => {
            seen = config.getSetting('checkbox');
        });

        config.setSetting('checkbox', true);
        settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
        await config.loadSettings();

        expect(seen).toBe(true);
    });

    test('the value written reads back at once, rather than the schema default', async () => {
        // The window is only supposed to be the gap between clearSettingsCache()
        // and the loadSettings() that refills the map, but nothing forces that
        // load to happen — settings-ui's destroy() clears the cache on its own,
        // and a character switch that never settles leaves it cleared too. With
        // the map empty, getSetting answers every key from SCHEMA_DEFAULTS, so a
        // toggle the user just turned off read back as the shipped default and
        // the switch looked dead. Reads and writes have to agree for as long as
        // the window lasts, not only after it closes.
        config.clearSettingsCache();

        config.setSetting('watchlist_inventoryDots', false);

        expect(config.getSetting('watchlist_inventoryDots')).toBe(false);
    });

    test('and the change callbacks fire at once, so what the value drives redraws', async () => {
        // A feature that paints from a setting repaints on the change callback.
        // Holding the callback until the load meant the inventory dots stayed
        // drawn after both switches said they were off.
        config.clearSettingsCache();
        const cb = vi.fn();
        config.onSettingChange('watchlist_inventoryDots', cb);

        config.setSetting('watchlist_inventoryDots', false);

        expect(cb).toHaveBeenCalledWith(false);
    });

    test('a non-boolean write reads back at once too', async () => {
        config.clearSettingsCache();

        config.setSettingValue('pricingMode', 'conservative');

        expect(config.getSetting('pricingMode')).toBe('conservative');
        expect(config.getSettingValue('pricingMode')).toBe('conservative');
    });

    test('the queue is emptied, so a later load does not re-apply it', async () => {
        config.clearSettingsCache();
        config.setSetting('checkbox', true);
        settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
        await config.loadSettings();

        settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(false);
    });

    test('the last write for a key wins', async () => {
        config.clearSettingsCache();
        config.setSetting('checkbox', true);
        config.setSetting('checkbox', false);

        settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: true } });
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(false);
    });
});

describe('Config — a held write a restore has latched the store against', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingChangeCallbacks = {};
        config._pendingWrites = [];
        config._pendingValues = Object.create(null);
        settingsStorageMock.lastLoadReadable = true;
        storageMock.restorePending = false;
        dataManagerMock.characterId = 'char-1';
    });

    test('is dropped by name rather than applied to a map that cannot be saved', async () => {
        // A sync pull refuses every write to the settings store until the page
        // reloads, so nothing from before the restore lands on top of it — and
        // a write queued during the reload window is from before it. Replaying
        // it changed the map and the UI and then had the save refused down in
        // storage: a value on screen that was never stored and will not survive
        // the reload the user has already been told to do.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            config.clearSettingsCache();
            config.setSetting('checkbox', true);

            storageMock.restorePending = true;
            settingsStorageMock.saveSettings.mockClear();
            settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
            await config.loadSettings();

            expect(config.getSetting('checkbox')).toBe(false);
            expect(settingsStorageMock.saveSettings).not.toHaveBeenCalled();
            expect(warn.mock.calls.some((call) => String(call[0]).includes('checkbox'))).toBe(true);
            expect(warn.mock.calls.some((call) => String(call[0]).includes('reload'))).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    test('an unlatched store still replays the write as before', async () => {
        config.clearSettingsCache();
        config.setSetting('checkbox', true);

        settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(true);
    });
});

describe('Config — a held write the loaded map has no key for', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingChangeCallbacks = {};
        config._pendingWrites = [];
        config._pendingValues = Object.create(null);
        settingsStorageMock.lastLoadReadable = true;
        dataManagerMock.characterId = 'char-1';
    });

    test('says so rather than dropping it in silence', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            config.clearSettingsCache();
            config.setSetting('goneFromTheSchema', true);
            // Answered while it is held — which is exactly why losing it later
            // has to be audible
            expect(config.getSetting('goneFromTheSchema')).toBe(true);

            settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
            await config.loadSettings();

            expect(config.getSetting('goneFromTheSchema')).toBe(false);
            expect(warn.mock.calls.some((call) => String(call[0]).includes('goneFromTheSchema'))).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });
});

/**
 * Clearing the map is only ever half of a pair, and nothing enforces the other
 * half: the character-switch chain's re-init returns early when a newer switch
 * is in flight, and a `loadSettings()` that rejects leaves the map empty with
 * nothing scheduled to try again. An empty map answers every read with the
 * shipped default and stores no write at all, so it cannot be left standing.
 */
describe('Config — a clear nobody reloads', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingChangeCallbacks = {};
        config._pendingWrites = [];
        config._pendingValues = Object.create(null);
        settingsStorageMock.lastLoadReadable = true;
        settingsStorageMock.loadSettings.mockClear();
        dataManagerMock.characterId = 'char-1';
    });

    test('the map is reloaded on its own when no load follows the clear', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            settingsStorageMock.loadSettings.mockResolvedValue({ checkbox: { id: 'checkbox', isTrue: true } });

            config.clearSettingsCache();
            expect(config.getSetting('checkbox')).toBe(false); // the schema default, not what is stored

            await vi.advanceTimersByTimeAsync(20000);

            expect(settingsStorageMock.loadSettings).toHaveBeenCalled();
            expect(config.getSetting('checkbox')).toBe(true);
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });

    test('a clear the switch chain does reload costs no second load', async () => {
        vi.useFakeTimers();
        try {
            settingsStorageMock.loadSettings.mockResolvedValue({ checkbox: { id: 'checkbox', isTrue: true } });

            config.clearSettingsCache();
            await config.loadSettings();
            settingsStorageMock.loadSettings.mockClear();

            await vi.advanceTimersByTimeAsync(20000);

            expect(settingsStorageMock.loadSettings).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * `settingsOwner` records whose map is in hand, but it cannot arbitrate two
 * loads in flight at once: a switch A→B starts B's load while A's is still
 * outstanding, and the read that settles last used to win. Config then served
 * character A's settings to every reader — features initialize off this map,
 * panels draw from it — while the player was on B.
 */
describe('Config — two settings loads in flight across a character switch', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingChangeCallbacks = {};
        config._pendingWrites = [];
        config._pendingValues = Object.create(null);
        settingsStorageMock.lastLoadReadable = true;
        settingsStorageMock.loadSettings.mockReset();
        settingsStorageMock.saveSettings.mockClear();
        dataManagerMock.characterId = 'char-A';
    });

    test('the departing character’s late read does not overwrite the arriving one’s map', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let releaseA;
            const aRead = new Promise((resolve) => {
                releaseA = () => resolve({ checkbox: { id: 'checkbox', isTrue: true } });
            });
            settingsStorageMock.loadSettings.mockReturnValueOnce(aRead);

            const loadA = config.loadSettings();

            // The switch: the chain empties the map and reloads under B
            dataManagerMock.characterId = 'char-B';
            config.clearSettingsCache();
            settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
            await config.loadSettings();

            // A's read settles second, with the player already on B
            releaseA();
            await loadA;

            expect(config.settingsOwner).toBe('char-B');
            expect(config.getSetting('checkbox')).toBe(false);
        } finally {
            warn.mockRestore();
        }
    });

    test('a write made on the departing character is not replayed onto the arriving one', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // `clearSettingsCache()` fires on `character_switching`, which is
            // before `currentCharacterId` moves — so the reload window this
            // queue exists for routinely spans a switch, and the load that
            // drains it is the arriving character's.
            config.clearSettingsCache();
            config.setSetting('checkbox', true);
            expect(config._pendingWrites).toHaveLength(1);

            dataManagerMock.characterId = 'char-B';
            settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
            await config.loadSettings();

            // char-B never touched this setting
            expect(config.settingsMap.checkbox.isTrue).toBe(false);
            expect(config.getSetting('checkbox')).toBe(false);
        } finally {
            warn.mockRestore();
        }
    });

    test('a discarded load leaves its queued writes for the load that wins', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let releaseA;
            const aRead = new Promise((resolve) => {
                releaseA = () => resolve({ checkbox: { id: 'checkbox', isTrue: true } });
            });
            settingsStorageMock.loadSettings.mockReturnValueOnce(aRead);

            const loadA = config.loadSettings();
            dataManagerMock.characterId = 'char-B';
            config.clearSettingsCache();

            // The player toggles while the map is empty — queued, not stored
            config.setSetting('checkbox', true);
            expect(config._pendingWrites).toHaveLength(1);

            // A's read settles first, and must not drain the queue on B's behalf
            releaseA();
            await loadA;
            expect(config._pendingWrites).toHaveLength(1);

            settingsStorageMock.loadSettings.mockResolvedValueOnce({ checkbox: { id: 'checkbox', isTrue: false } });
            await config.loadSettings();

            expect(config._pendingWrites).toHaveLength(0);
            expect(config.getSetting('checkbox')).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });

    test('a switch with no reload behind it still refills the map on the watchdog', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let releaseA;
            const aRead = new Promise((resolve) => {
                releaseA = () => resolve({ checkbox: { id: 'checkbox', isTrue: true } });
            });
            settingsStorageMock.loadSettings.mockReturnValueOnce(aRead);

            const loadA = config.loadSettings();
            dataManagerMock.characterId = 'char-B';
            config.clearSettingsCache();

            // Nothing reloads for B; A's read comes back and is discarded
            settingsStorageMock.loadSettings.mockResolvedValue({ checkbox: { id: 'checkbox', isTrue: false } });
            releaseA();
            await loadA;
            expect(config.settingsMap).toEqual({});

            await vi.advanceTimersByTimeAsync(20000);

            expect(config.settingsOwner).toBe('char-B');
            expect(config.getSetting('checkbox')).toBe(false);
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });
});

describe('a save carries the keys this client changed', () => {
    beforeEach(() => {
        config.settingsMap = {
            checkboxOn: { id: 'checkboxOn', isTrue: true },
            pricingMode: { id: 'pricingMode', value: 'optimistic' },
            featureBacked: { id: 'featureBacked', isTrue: true },
        };
        config.characterSettingsLoaded = true;
    });

    /** The dirty set handed to the storage layer on the Nth save */
    const dirtyOnCall = (n = 0) => [...settingsStorageMock.saveSettings.mock.calls[n][1]];

    test('setSetting names the key it wrote', () => {
        config.setSetting('checkboxOn', false);
        expect(dirtyOnCall()).toEqual(['checkboxOn']);
    });

    test('setSettingValue names the key it wrote', () => {
        config.setSettingValue('pricingMode', 'pessimistic');
        expect(dirtyOnCall()).toEqual(['pricingMode']);
    });

    test('the feature toggle names the setting it wrote', async () => {
        config.features = { someFeature: { settingKey: 'featureBacked', enabled: true } };
        await config.setFeatureEnabled('someFeature', false);
        expect(dirtyOnCall()).toEqual(['featureBacked']);
        expect(config.settingsMap.featureBacked.isTrue).toBe(false);
    });

    test('the reset to defaults says outright that it writes everything', async () => {
        settingsStorageMock.buildDefaults.mockImplementation(() => ({ checkboxOn: { isTrue: true } }));
        config.setSetting('checkboxOn', false);
        await config.resetToDefaults();

        const last = settingsStorageMock.saveSettings.mock.calls.at(-1);
        expect(last[1]).toBe(settingsStorageMock.SAVE_ALL_KEYS);
    });

    test('a write made while a save is in flight is carried by its own save', async () => {
        let release;
        settingsStorageMock.saveSettings.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

        config.setSetting('checkboxOn', false);
        // Lands during the first save, so clearing on completion must not eat it
        config.setSettingValue('pricingMode', 'pessimistic');
        release();
        await Promise.resolve();

        expect(dirtyOnCall(0)).toEqual(['checkboxOn']);
        expect(dirtyOnCall(1)).toEqual(['pricingMode']);
    });

    test('a failed write leaves its keys dirty for the next save to carry', async () => {
        settingsStorageMock.saveSettings.mockImplementationOnce(() => Promise.reject(new Error('store is gone')));

        await config.saveSettings().catch(() => {});
        config._markDirty('checkboxOn');

        expect([...config._dirtyKeys]).toContain('checkboxOn');
    });

    test('a character switch drops the dirty keys with the map they named', () => {
        config.setSetting('checkboxOn', false);
        config._markDirty('pricingMode');
        config.clearSettingsCache();

        expect([...config._dirtyKeys]).toEqual([]);
    });

    test('a map that was never read back still goes through the careful save', () => {
        config.characterSettingsLoaded = false;
        config.setSetting('checkboxOn', false);

        expect(settingsStorageMock.saveSettings).not.toHaveBeenCalled();
        expect(settingsStorageMock.saveSettingsKeepingStored).toHaveBeenCalled();
    });
});
