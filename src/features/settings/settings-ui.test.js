/** @vitest-environment happy-dom
 *
 * What the settings page is *for*, tested at the level somebody opening it sees.
 *
 * Three things here are not arithmetic and cannot be checked any other way:
 *
 * **What leads the page.** Presets are the answer to "make this script do the
 * thing I play", and they used to sit below several hundred switches with a
 * dedicated Iron Cow card in the slot a first-time reader looks at.
 *
 * **That a mode is not a preset.** Essentials and Combat are one-shots: they
 * flip switches and are then over. Iron Cow stays on, owns its settings while
 * it does, and composes with the one-shots — so its chip is pressed in, the
 * others never are, and no bulk write may move it.
 *
 * **Who a copy goes to.** "Copy Settings to IC Characters" writes a whole
 * settings map into other characters' storage. Sending it to the wrong slot is
 * silent and unrecoverable, so the target list is worth pinning.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settingsMap: {},
    written: [],
    store: new Map(),
    characterId: 'char-1',
    characterName: 'Main',
    gameMode: 'standard',
    knownCharacters: [],
    synced: [],
    syncResult: { success: true, count: 0 },
    /** Which panels the utility buttons asked to open or close */
    toggled: [],
    /** What the pointer looks like to auto-detection */
    coarsePointer: false,
    /** Held open to keep `loadSettings` in flight while the test moves the DOM */
    loadGate: null,
    /** What `askChoice` answers, for the flows that confirm first */
    choiceAnswer: null,
    /** What `importEverything` reports back to the restore flow */
    importResult: { restored: {}, expected: {}, failed: [], complete: true },
    /** How many times the panel emptied config's settings map */
    cacheClears: 0,
    /** Times the command palette's own `open()` was called */
    paletteOpened: 0,
    /** What `overlayTabButton.isLauncherHidden()` currently answers */
    launcherHidden: false,
    /** Times `overlayTabButton.showLauncher()` was called */
    launcherShowCalls: 0,
}));

/** Controllable stand-in for the census singleton the export button drives. */
const censusMock = vi.hoisted(() => ({
    initialized: true,
    rosterSize: 0,
    wavesSeen: 0,
    downloadResult: false,
    loadCalls: 0,
    flushCalls: 0,
}));

vi.mock('../../utils/mobile.js', () => ({
    hasCoarsePointer: () => mocks.coarsePointer,
    isMobileMode: () => mocks.coarsePointer,
    detectedModeLabel: () => (mocks.coarsePointer ? 'mobile' : 'desktop'),
}));

/** The smallest schema that still has an Iron Cow, a market pair and a non-market pair. */
const schema = {
    ironCow: {
        title: 'Iron Cow Mode',
        icon: '🐄',
        settings: {
            ironCow_enabled: {
                id: 'ironCow_enabled',
                label: 'Iron Cow Mode',
                type: 'checkbox',
                default: false,
                hidden: true,
                help: 'Disable all market and profit features for a no-marketplace playthrough.',
            },
        },
    },
    general: {
        title: 'General',
        icon: '⚙️',
        settings: {
            actionBar_enabled: { id: 'actionBar_enabled', label: 'Action bar', type: 'checkbox', default: true },
            combatSim: { id: 'combatSim', label: 'Combat simulator', type: 'checkbox', default: true },
            spawnCensus: { id: 'spawnCensus', label: 'Spawn Census', type: 'checkbox', default: false },
            spawnCensusExport: {
                id: 'spawnCensusExport',
                label: 'Spawn Census: Export the recorded data',
                type: 'button',
                buttonLabel: 'Export census',
            },
            mobileMode: {
                id: 'mobileMode',
                label: 'Mobile mode',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto-detect' },
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                ],
            },
        },
    },
    enhanceBench: {
        title: 'Enhancement Bench',
        icon: '🔧',
        settings: {
            enhanceSim_autoDetect: {
                id: 'enhanceSim_autoDetect',
                label: 'Auto-detect bench',
                type: 'checkbox',
                default: false,
            },
            enhanceSim_resetProDefaults: {
                id: 'enhanceSim_resetProDefaults',
                label: 'Reset the bench below',
                type: 'button',
                buttonLabel: 'Reset to pro defaults',
            },
            enhanceSim_enhancingLevel: {
                id: 'enhanceSim_enhancingLevel',
                label: 'Enhancing skill level',
                type: 'number',
                default: 140,
                min: 1,
                max: 200,
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_enhancer: {
                id: 'enhanceSim_gear_enhancer',
                label: 'Enhancer tool',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'celestial', level: 15 },
                tiers: [
                    { value: 'holy', label: 'Holy' },
                    { value: 'celestial', label: 'Celestial' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_gloves: {
                id: 'enhanceSim_gear_gloves',
                label: 'Gloves slot',
                type: 'enhanceGear',
                default: { enabled: true, level: 12 },
                disabledBy: 'enhanceSim_autoDetect',
            },
        },
    },
    market: {
        title: 'Market',
        icon: '💰',
        settings: {
            itemTooltip_profit: {
                id: 'itemTooltip_profit',
                label: 'Profit in tooltips',
                type: 'checkbox',
                default: true,
            },
            networth: {
                id: 'networth',
                label: 'Net worth',
                type: 'checkbox',
                default: true,
                help: 'Total value of your stash, counted across every character.',
            },
        },
    },
};

vi.mock('../../core/settings-schema.js', () => ({
    settingsGroups: schema,
    getSettingDefinition: (id) => {
        for (const group of Object.values(schema)) {
            if (group.settings[id]) return group.settings[id];
        }
        return null;
    },
    // whats-new (pulled in transitively) reads this on load.
    getAllSettingIds: () => Object.values(schema).flatMap((group) => Object.keys(group.settings)),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        get settingsMap() {
            return mocks.settingsMap;
        },
        getSetting: (id) => mocks.settingsMap[id]?.isTrue ?? false,
        getSettingValue: (id, fallback = null) => mocks.settingsMap[id]?.value ?? fallback,
        setSetting: (id, value) => {
            mocks.written.push([id, value]);
            if (mocks.settingsMap[id]) mocks.settingsMap[id].isTrue = value;
        },
        setSettingValue: (id, value) => {
            mocks.written.push([id, value]);
            if (mocks.settingsMap[id]) mocks.settingsMap[id].value = value;
        },
        clearSettingsCache: () => {
            mocks.cacheClears += 1;
        },
        getKnownCharacters: async () => mocks.knownCharacters,
        syncSettingsToAllCharacters: async (ids) => {
            mocks.synced.push(ids);
            return { ...mocks.syncResult, count: mocks.syncResult.count || ids.length };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => mocks.characterId,
        getCurrentCharacterName: () => mocks.characterName,
        getCurrentCharacterGameMode: () => mocks.gameMode,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => (mocks.store.has(key) ? mocks.store.get(key) : fallback),
        set: async (key, value) => {
            mocks.store.set(key, value);
            return true;
        },
        getJSON: async (key, _store, fallback = null) => (mocks.store.has(key) ? mocks.store.get(key) : fallback),
        setJSON: async (key, value) => {
            mocks.store.set(key, value);
            return true;
        },
        delete: async (key) => {
            mocks.store.delete(key);
            return true;
        },
    },
}));

vi.mock('../../core/settings-storage.js', () => ({
    default: {
        loadSettings: async () => {
            if (mocks.loadGate) await mocks.loadGate;
            return mocks.settingsMap;
        },
        setSetting: async () => {},
        exportSettings: async () => '{}',
        importSettings: async () => null,
        resetToDefaults: async () => {},
    },
}));

// Everything below is a neighbour the panel merely holds a button for
vi.mock('../../api/marketplace.js', () => ({ default: { clearCacheAndRefetch: async () => true } }));
vi.mock('../combat/scroll-simulator-ui.js', () => ({ default: { openDefaultsPopup: () => {} } }));
vi.mock('../combat/spawn-census.js', () => ({
    default: {
        get initialized() {
            return censusMock.initialized;
        },
        rosters: {
            get size() {
                return censusMock.rosterSize;
            },
        },
        load: async () => {
            censusMock.loadCalls += 1;
        },
        flush: async () => {
            censusMock.flushCalls += 1;
        },
        summary: () => ({ wavesSeen: censusMock.wavesSeen }),
        downloadExport: () => censusMock.downloadResult,
    },
}));
vi.mock('../dev/pformance-panel.js', () => ({
    default: { show: () => {}, toggle: () => mocks.toggled.push('pformance') },
}));
vi.mock('../inventory/treasure-tracker.js', () => ({
    default: { show: () => {}, toggle: () => mocks.toggled.push('treasure') },
}));
vi.mock('../ui/overlay-panel.js', () => ({ default: { toggle: () => {} } }));
vi.mock('../ui/command-palette.js', () => ({
    default: {
        open: () => {
            mocks.paletteOpened += 1;
        },
    },
}));
vi.mock('../ui/overlay-tab-button.js', () => ({
    default: {
        isLauncherHidden: async () => mocks.launcherHidden,
        showLauncher: async () => {
            mocks.launcherHidden = false;
            mocks.launcherShowCalls += 1;
        },
    },
}));
vi.mock('../sync/sync-manager.js', () => ({
    default: { initialize: async () => {}, describeStatus: async () => 'Not linked.' },
}));
vi.mock('./custom-price-overrides.js', () => ({
    getCustomPriceOverrides: () => ({}),
    getCustomPriceOverridesAsync: async () => ({}),
    setCustomPriceOverride: async () => {},
    removeCustomPriceOverride: async () => {},
    initCustomPriceOverrides: async () => {},
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getDetectedGearSettings: () => ({}),
    getEnhancingParams: () => ({}),
}));
vi.mock('../../utils/full-backup.js', () => ({
    exportEverythingJSON: async () => '{}',
    importEverything: async () => mocks.importResult,
}));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => mocks.choiceAnswer }));

const { default: settingsUI, SEARCH_DEBOUNCE_MS } = await import('./settings-ui.js');
const { IRON_COW_SETTINGS } = await import('./iron-cow-mode.js');
const { CHARACTER_MODES_KEY } = await import('./character-modes.js');

/** The market settings this cut-down schema shares with the real Iron Cow list. */
const LOCKED_IDS = ['itemTooltip_profit', 'networth'].filter((id) => IRON_COW_SETTINGS.has(id));

/**
 * Draw the panel into the document, the way the tab injection does.
 * @returns {HTMLElement} The card holding everything
 */
function drawPanel() {
    const panel = settingsUI.createTabPanel();
    panel.style.display = 'block';
    document.body.appendChild(panel);
    settingsUI.applyDisabledByState();
    return panel.querySelector('#toolasha-settings-content');
}

/**
 * Type into the search box and let the debounce elapse.
 * @param {string} text - What the box now contains
 * @returns {Promise<void>} Resolves once the filter has run
 */
async function typeSearch(text) {
    const search = document.querySelector('.toolasha-search-input');
    search.value = text;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
}

/** @returns {HTMLElement|null} The Iron Cow chip */
function chip() {
    return document.querySelector('.toolasha-mode-chip[data-mode-id="ironCow"]');
}

/**
 * @param {string} id - A setting id
 * @returns {HTMLElement|null} Its row
 */
function row(id) {
    return document.querySelector(`.toolasha-setting[data-setting-id="${id}"]`);
}

/**
 * @param {string} presetId - An id from SETTING_PRESETS
 * @returns {HTMLElement|null} Its button
 */
function presetButton(presetId) {
    return document.querySelector(`[data-preset-id="${presetId}"]`);
}

/** Let the click handlers' promises settle. @returns {Promise<void>} */
async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    mocks.written = [];
    mocks.store = new Map();
    mocks.characterId = 'char-1';
    mocks.characterName = 'Main';
    mocks.gameMode = 'standard';
    mocks.knownCharacters = [];
    mocks.synced = [];
    mocks.syncResult = { success: true, count: 0 };
    mocks.toggled = [];
    mocks.coarsePointer = false;
    mocks.loadGate = null;
    mocks.cacheClears = 0;
    mocks.paletteOpened = 0;
    mocks.launcherHidden = false;
    mocks.launcherShowCalls = 0;
    mocks.settingsMap = {};
    censusMock.initialized = true;
    censusMock.rosterSize = 0;
    censusMock.wavesSeen = 0;
    censusMock.downloadResult = false;
    censusMock.loadCalls = 0;
    censusMock.flushCalls = 0;
    for (const group of Object.values(schema)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            mocks.settingsMap[id] = { id, type: 'checkbox', isTrue: definition.default ?? false };
        }
    }

    settingsUI.currentSettings = mocks.settingsMap;
    settingsUI.collapsedGroups = new Set();
    settingsUI.restoreButton = null;

    globalThis.alert = vi.fn();
    globalThis.confirm = vi.fn(() => true);
    document.body.replaceChildren();
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('what leads the page', () => {
    test('the presets block sits above the first group of settings', () => {
        const card = drawPanel();
        const blocks = [...card.children];
        const presets = card.querySelector('.toolasha-preset-buttons');
        const firstGroup = card.querySelector('.toolasha-settings-group');

        expect(presets).not.toBe(null);
        expect(blocks.indexOf(presets)).toBeLessThan(blocks.indexOf(firstGroup));
        // Only the search box gets to come first
        expect(blocks[0].className).toContain('toolasha-search-container');
        expect(blocks[1]).toBe(presets);
    });

    test('the presets block still says what it is', () => {
        const presets = drawPanel().querySelector('.toolasha-preset-buttons');
        expect(presets.textContent).toContain('Presets');
        expect(presets.textContent).toContain('Restore undoes the last one');
        expect(presetButton('essentials')).not.toBe(null);
        expect(presetButton('everything')).not.toBe(null);
    });

    test('the dedicated Iron Cow card is gone', () => {
        drawPanel();
        expect(document.getElementById('toolasha-iron-cow-toggle')).toBe(null);
        expect(typeof settingsUI.addIronCowToggle).toBe('undefined');
    });
});

describe('the Iron Cow chip', () => {
    test('it lives in the presets row, and one-shots have no pressed state', () => {
        drawPanel();
        const row = document.querySelector('.toolasha-preset-buttons .toolasha-utility-buttons');

        expect(row.contains(chip())).toBe(true);
        expect(chip().dataset.presetKind).toBe('mode');
        expect(chip().textContent).toContain('Iron Cow Mode');

        for (const button of row.querySelectorAll('[data-preset-id]')) {
            expect(button.dataset.presetKind).toBe('oneShot');
            expect(button.getAttribute('aria-pressed')).toBe(null);
        }
    });

    test('it carries the setting id, so the search and the palette can jump to it', () => {
        drawPanel();
        // The schema entry is hidden, so there is no row — the chip is the control
        expect(row('ironCow_enabled')).toBe(null);
        expect(chip().dataset.settingId).toBe('ironCow_enabled');
        expect(document.querySelector('[data-setting-id="ironCow_enabled"]')).toBe(chip());
    });

    test('searching for it points at the chip, since there is no row to find', async () => {
        const card = drawPanel();

        await typeSearch('iron cow');

        expect(chip().dataset.searchMatch).toBe('true');
        expect(chip().style.outline).toContain('2px');
        // Every ordinary group has been filtered away — the chip is all there is
        for (const group of card.querySelectorAll('.toolasha-settings-group')) {
            if (group.dataset.group === 'ironCow') continue;
            expect(group.style.display).toBe('none');
        }

        await typeSearch('action');
        expect(chip().dataset.searchMatch).toBe('false');
        expect(chip().style.outline).toBe('');
    });

    test('it is drawn pressed when the mode is already on', () => {
        mocks.settingsMap.ironCow_enabled.isTrue = true;
        drawPanel();

        expect(chip().getAttribute('aria-pressed')).toBe('true');
        expect(chip().dataset.active).toBe('true');
    });

    test('clicking it turns the mode on and locks the settings it owns', async () => {
        drawPanel();
        expect(chip().dataset.active).toBe('false');

        chip().click();
        await settle();

        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().getAttribute('aria-pressed')).toBe('true');
        for (const id of LOCKED_IDS) {
            expect(mocks.settingsMap[id].isTrue, id).toBe(false);
            expect(row(id).dataset.ironCowLocked, id).toBe('true');
            expect(row(id).style.pointerEvents, id).toBe('none');
        }
        // Nothing outside the mode's own list was touched
        expect(mocks.settingsMap.actionBar_enabled.isTrue).toBe(true);
    });

    test('clicking it again turns the mode off and gives the settings back', async () => {
        drawPanel();
        chip().click();
        await settle();
        chip().click();
        await settle();

        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(false);
        expect(chip().dataset.active).toBe('false');
        for (const id of LOCKED_IDS) {
            expect(mocks.settingsMap[id].isTrue, id).toBe(true);
            expect(row(id).dataset.ironCowLocked, id).toBe(undefined);
        }
    });
});

describe('a mode stacks with a preset', () => {
    test('applying a one-shot leaves the mode on and its chip pressed', async () => {
        drawPanel();
        chip().click();
        await settle();
        mocks.written = [];

        presetButton('essentials').click();
        await settle();

        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().getAttribute('aria-pressed')).toBe('true');
        // And the settings the mode owns are still locked in the panel
        for (const id of LOCKED_IDS) {
            expect(row(id).dataset.ironCowLocked, id).toBe('true');
        }
    });

    test('the preset still does its own job while the mode is on', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        drawPanel();
        chip().click();
        await settle();

        presetButton('combat').click();
        await settle();

        expect(mocks.settingsMap.combatSim.isTrue).toBe(true);
        expect(document.getElementById('combatSim').checked).toBe(true);
    });

    // Pinning today's division of labour rather than wishing for another one:
    // a bulk write owns the *values*, the mode owns the *panel*. A preset that
    // lists a market setting does write it, and the row stays locked and greyed
    // until the mode is next applied, which forces it off again.
    test('a market preset is immediately re-forced off by the mode, rows stay locked', async () => {
        drawPanel();
        chip().click();
        await settle();

        presetButton('market').click();
        await settle();

        // The preset wrote true, and the mode's reapply put it straight back
        // off — Iron Cow wins now, not on its next enable
        expect(mocks.settingsMap.itemTooltip_profit.isTrue).toBe(false);
        expect(row('itemTooltip_profit').dataset.ironCowLocked).toBe('true');
        expect(chip().getAttribute('aria-pressed')).toBe('true');
    });

    test('All Off and Restore both leave the mode where it was', async () => {
        drawPanel();
        chip().click();
        await settle();
        mocks.written = [];

        await settingsUI.handleAllOff();
        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().getAttribute('aria-pressed')).toBe('true');

        await settingsUI.handleRestore();
        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().dataset.active).toBe('true');
    });
});

describe('copying settings to the iron cows', () => {
    beforeEach(() => {
        mocks.knownCharacters = [
            { id: 'char-1', name: 'Main' },
            { id: 'char-2', name: 'Bessie' },
            { id: 'char-3', name: 'Daisy' },
            { id: 'char-4', name: 'Alt' },
        ];
    });

    /** @returns {HTMLElement} The copy dialog's confirm button */
    function copyButton() {
        const dialog = document.querySelector('.toolasha-copy-settings-dialog');
        return [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Copy Settings');
    }

    test('the button is offered beside the copy-to-everyone one', () => {
        const card = drawPanel();
        const buttons = [...card.querySelectorAll('.toolasha-utility-button')].map((b) => b.textContent);
        expect(buttons).toContain('Copy Settings to All Characters');
        expect(buttons).toContain('Copy Settings to IC Characters');
    });

    test('it offers only the characters recorded as iron cows', async () => {
        mocks.store.set(CHARACTER_MODES_KEY, {
            'char-1': 'standard',
            'char-2': 'ironcow',
            'char-3': 'legacy_ironcow',
            'char-4': 'standard',
        });
        drawPanel();

        await settingsUI.handleSyncIronCow();

        const names = [...document.querySelectorAll('.toolasha-copy-settings-dialog span')].map((s) => s.textContent);
        expect(names).toContain('Bessie');
        expect(names).toContain('Daisy');
        expect(names).not.toContain('Alt');
        expect(names).not.toContain('Main');

        copyButton().click();
        await settle();
        expect(mocks.synced).toEqual([['char-2', 'char-3']]);
    });

    test('a character whose mode was never recorded is skipped and named', async () => {
        mocks.store.set(CHARACTER_MODES_KEY, { 'char-2': 'ironcow' });
        drawPanel();

        await settingsUI.handleSyncIronCow();
        expect(document.querySelector('.toolasha-copy-settings-note').textContent).toContain('Daisy');

        copyButton().click();
        await settle();

        expect(mocks.synced).toEqual([['char-2']]);
        const said = globalThis.alert.mock.calls.at(-1)[0];
        expect(said).toContain('1 iron cow character');
        expect(said).toContain('Daisy');
        expect(said).toContain('Alt');
    });

    test('no known iron cow says so rather than copying to everyone', async () => {
        drawPanel();
        await settingsUI.handleSyncIronCow();

        expect(document.querySelector('.toolasha-copy-settings-dialog')).toBe(null);
        expect(mocks.synced).toEqual([]);
        expect(globalThis.alert.mock.calls.at(-1)[0]).toContain('No character is known to be an iron cow yet');
    });

    test('the copy-to-everyone button is unchanged: everyone but you, counted', async () => {
        drawPanel();
        await settingsUI.handleSync();

        copyButton().click();
        await settle();

        expect(mocks.synced).toEqual([['char-2', 'char-3', 'char-4']]);
        expect(globalThis.alert.mock.calls.at(-1)[0]).toBe('Settings copied to 3 characters!');
    });
});

describe('the buttons that open a panel', () => {
    /**
     * @param {string} label - The button's text
     * @returns {HTMLElement} The utility button with that label
     */
    function utilityButton(label) {
        drawPanel();
        return [...document.querySelectorAll('.toolasha-utility-button')].find((b) => b.textContent === label);
    }

    test('Treasure closes the panel it opened, on the second press', () => {
        // It only ever called show(), so the second press raised a panel that
        // was already up — and on a phone the panel's own ✕ is the first thing
        // a too-narrow header pushes off the screen
        const button = utilityButton('Treasure');
        button.click();
        button.click();

        expect(mocks.toggled).toEqual(['treasure', 'treasure']);
    });

    test('PFormance does too', () => {
        utilityButton('PFormance').click();

        expect(mocks.toggled).toEqual(['pformance']);
    });
});

describe('opening the command palette on a phone', () => {
    test('the button is absent on desktop, where Ctrl/Cmd+K already works', () => {
        mocks.coarsePointer = false;
        drawPanel();

        expect(
            [...document.querySelectorAll('.toolasha-utility-button')].find((b) => b.textContent === 'Command Palette')
        ).toBeUndefined();
    });

    test('on a phone, the button opens the palette', () => {
        mocks.coarsePointer = true;
        drawPanel();

        const button = [...document.querySelectorAll('.toolasha-utility-button')].find(
            (b) => b.textContent === 'Command Palette'
        );
        expect(button).toBeTruthy();

        button.click();

        expect(mocks.paletteOpened).toBe(1);
    });
});

describe('getting the overlay button back', () => {
    /** @returns {HTMLElement|undefined} The recovery button, once drawn */
    function launcherButton() {
        return [...document.querySelectorAll('.toolasha-utility-button')].find(
            (b) => b.textContent === 'Show the overlay button' || b.textContent === 'Overlay button is already shown'
        );
    }

    test('is absent on desktop — there is no launcher there to recover', () => {
        mocks.coarsePointer = false;
        drawPanel();

        expect(launcherButton()).toBeUndefined();
    });

    test('on a phone with the launcher hidden, offers to bring it back', async () => {
        mocks.coarsePointer = true;
        mocks.launcherHidden = true;
        drawPanel();
        await settle();

        const button = launcherButton();
        expect(button.textContent).toBe('Show the overlay button');
        expect(button.disabled).toBe(false);
    });

    test('clicking it clears the flag, asks the launcher back, and relabels itself', async () => {
        mocks.coarsePointer = true;
        mocks.launcherHidden = true;
        drawPanel();
        await settle();

        launcherButton().click();
        await settle();

        expect(mocks.launcherShowCalls).toBe(1);
        const button = launcherButton();
        expect(button.textContent).toBe('Overlay button is already shown');
        expect(button.disabled).toBe(true);
    });

    test('with the flag unset, reports the button as already shown rather than being missing', async () => {
        mocks.coarsePointer = true;
        mocks.launcherHidden = false;
        drawPanel();
        await settle();

        const button = launcherButton();
        expect(button).toBeTruthy();
        expect(button.textContent).toBe('Overlay button is already shown');
        expect(button.disabled).toBe(true);
    });

    test("never writes a synced setting — only calls overlay-tab-button.js's own API", async () => {
        mocks.coarsePointer = true;
        mocks.launcherHidden = true;
        drawPanel();
        await settle();

        launcherButton().click();
        await settle();

        expect(mocks.written).toEqual([]);
        expect(mocks.store.size).toBe(0);
    });

    test('tearing the panel down removes the control along with everything else', async () => {
        mocks.coarsePointer = true;
        mocks.launcherHidden = true;
        drawPanel();
        await settle();
        expect(launcherButton()).toBeTruthy();

        settingsUI.cleanup();

        expect(launcherButton()).toBeUndefined();
    });
});

describe('what auto-detection is currently deciding', () => {
    /** @returns {HTMLOptionElement} The mobile mode select's auto option */
    function autoOption() {
        drawPanel();
        return document.querySelector('#mobileMode option[value="auto"]');
    }

    test('a touchscreen is said to be one', () => {
        mocks.coarsePointer = true;

        expect(autoOption().textContent).toContain('mobile');
    });

    test('and so is a cursor', () => {
        // Without this the setting reads "Auto-detect" on the one machine where
        // the detection is wrong, and looks exactly as correct as it does on
        // every machine where it is right
        expect(autoOption().textContent).toContain('desktop');
    });

    test('the schema label is kept, not replaced', () => {
        expect(autoOption().textContent).toContain('Auto-detect');
    });

    test('the other options are left alone', () => {
        drawPanel();

        expect(document.querySelector('#mobileMode option[value="on"]').textContent.trim()).toBe('On');
    });
});

describe('collapse all and expand all', () => {
    test('one press folds every group, the other opens them, and both are remembered', () => {
        const panel = drawPanel();
        const groups = [...panel.querySelectorAll('.toolasha-settings-group')];
        expect(groups.length).toBeGreaterThan(0);

        panel.querySelector('.toolasha-collapse-all').click();
        expect(groups.every((g) => g.classList.contains('collapsed'))).toBe(true);
        expect(settingsUI.collapsedGroups.size).toBe(groups.length);

        panel.querySelector('.toolasha-expand-all').click();
        expect(groups.some((g) => g.classList.contains('collapsed'))).toBe(false);
        expect(settingsUI.collapsedGroups.size).toBe(0);
    });
});

describe('the search box', () => {
    test('it is the first thing in the panel, ahead of everything else', () => {
        const card = drawPanel();
        expect(card.children[0].querySelector('.toolasha-search-input')).not.toBe(null);
    });

    test('typing narrows to the rows whose label matches', async () => {
        drawPanel();

        await typeSearch('net worth');

        expect(row('networth').style.display).toBe('flex');
        expect(row('actionBar_enabled').style.display).toBe('none');
        expect(row('itemTooltip_profit').style.display).toBe('none');
    });

    test('the match is case-insensitive and a substring, not a whole word', async () => {
        drawPanel();

        await typeSearch('OMBAT SIM');

        expect(row('combatSim').style.display).toBe('flex');
        expect(row('networth').style.display).toBe('none');
    });

    test('help text counts as searchable, not just the label', async () => {
        drawPanel();

        // "stash" appears only in the Net worth help line
        await typeSearch('stash');

        expect(row('networth').style.display).toBe('flex');
        expect(row('itemTooltip_profit').style.display).toBe('none');
    });

    test('a section heading matches, and takes its whole section with it', async () => {
        const card = drawPanel();

        await typeSearch('market');

        const market = card.querySelector('.toolasha-settings-group[data-group="market"]');
        expect(market.style.display).toBe('block');
        expect(row('networth').style.display).toBe('flex');
        expect(row('itemTooltip_profit').style.display).toBe('flex');
        expect(card.querySelector('.toolasha-settings-group[data-group="general"]').style.display).toBe('none');
    });

    test('a section with nothing matching is hidden, the one with a match stays up', async () => {
        const card = drawPanel();

        await typeSearch('net worth');

        expect(card.querySelector('.toolasha-settings-group[data-group="market"]').style.display).toBe('block');
        expect(card.querySelector('.toolasha-settings-group[data-group="general"]').style.display).toBe('none');
    });

    test('clearing puts every row and group back', async () => {
        const card = drawPanel();
        await typeSearch('net worth');
        expect(row('actionBar_enabled').style.display).toBe('none');

        card.querySelector('.toolasha-search-clear').click();

        for (const setting of card.querySelectorAll('.toolasha-setting')) {
            expect(setting.style.display).toBe('flex');
        }
        for (const group of card.querySelectorAll('.toolasha-settings-group')) {
            expect(group.style.display).toBe('block');
        }
        expect(card.querySelector('.toolasha-search-input').value).toBe('');
    });

    test('filtering only touches display — a toggle keeps the value it had', async () => {
        const card = drawPanel();
        const box = card.querySelector('#actionBar_enabled');
        const before = box.checked;

        await typeSearch('net worth');
        await typeSearch('');

        // The same element, not a redrawn one, still carrying its state
        expect(card.querySelector('#actionBar_enabled')).toBe(box);
        expect(box.checked).toBe(before);
    });

    test('Escape empties the box and restores the panel', async () => {
        const card = drawPanel();
        const search = card.querySelector('.toolasha-search-input');
        await typeSearch('net worth');
        expect(row('actionBar_enabled').style.display).toBe('none');

        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

        expect(search.value).toBe('');
        expect(row('actionBar_enabled').style.display).toBe('flex');
    });

    test('keys typed in the box never reach the game', () => {
        const card = drawPanel();
        const search = card.querySelector('.toolasha-search-input');
        const heard = [];
        document.addEventListener('keydown', (e) => heard.push(e.key));

        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

        expect(heard).toEqual([]);
    });

    test('a burst of keystrokes filters once, at the end', async () => {
        drawPanel();
        const search = document.querySelector('.toolasha-search-input');
        const applied = vi.spyOn(settingsUI, 'applySettingsFilter');

        for (const text of ['n', 'ne', 'net', 'net ', 'net w']) {
            search.value = text;
            search.dispatchEvent(new Event('input', { bubbles: true }));
        }
        expect(applied).not.toHaveBeenCalled();

        await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
        expect(applied).toHaveBeenCalledTimes(1);
        expect(row('networth').style.display).toBe('flex');
        applied.mockRestore();
    });
});

describe('injecting the tab into a panel React may take away', () => {
    /**
     * The game's settings panel, as the selectors expect to find it.
     * @returns {{host: HTMLElement, tabs: HTMLElement, panels: HTMLElement}}
     */
    function gameSettingsPanel() {
        const host = document.createElement('div');
        host.className = 'SettingsPanel_tabsComponentContainer__abc';
        const tabs = document.createElement('div');
        tabs.className = 'MuiTabs-flexContainer';
        const panels = document.createElement('div');
        panels.className = 'TabsComponent_tabPanelsContainer__def';
        host.append(tabs, panels);
        document.body.appendChild(host);
        return { host, tabs, panels };
    }

    test('the tab lands in the live panel', async () => {
        const { tabs, panels } = gameSettingsPanel();

        await settingsUI.injectSettingsTab();

        expect(tabs.querySelector('#toolasha-settings-tab')).not.toBeNull();
        expect(panels.children.length).toBeGreaterThan(0);
    });

    test('a remount while the settings load is in flight is not appended into', async () => {
        // The containers are captured before the await; React can replace the
        // whole panel while storage answers, and appending into the orphans
        // loses the tab until some later mutation happens to trigger another pass
        const first = gameSettingsPanel();

        let release;
        mocks.loadGate = new Promise((resolve) => {
            release = resolve;
        });

        const injecting = settingsUI.injectSettingsTab();

        first.host.remove();
        const second = gameSettingsPanel();

        release();
        await injecting;

        expect(first.tabs.querySelector('#toolasha-settings-tab')).toBeNull();
        expect(second.tabs.querySelector('#toolasha-settings-tab')).toBeNull();

        // And the next pass, against the live panel, works
        mocks.loadGate = null;
        await settingsUI.injectSettingsTab();

        expect(second.tabs.querySelector('#toolasha-settings-tab')).not.toBeNull();
    });
});

describe("switching tabs only touches this panel's own tab list", () => {
    /**
     * The game's settings panel, with one existing (non-Toolasha) tab already
     * selected, plus a matching panel so the click handler's index lookup
     * resolves.
     * @returns {{tabs: HTMLElement, panels: HTMLElement, existingTab: HTMLElement}}
     */
    function gameSettingsPanelWithExistingTab() {
        const host = document.createElement('div');
        host.className = 'SettingsPanel_tabsComponentContainer__abc';
        const tabs = document.createElement('div');
        tabs.className = 'MuiTabs-flexContainer';
        tabs.setAttribute('role', 'tablist');

        const existingTab = document.createElement('button');
        existingTab.setAttribute('role', 'tab');
        existingTab.setAttribute('aria-selected', 'true');
        existingTab.setAttribute('tabindex', '0');
        existingTab.classList.add('Mui-selected');
        existingTab.textContent = 'Inventory';
        tabs.appendChild(existingTab);

        const panels = document.createElement('div');
        panels.className = 'TabsComponent_tabPanelsContainer__def';
        const existingPanel = document.createElement('div');
        existingPanel.className = 'TabPanel_tabPanel__existing';
        panels.appendChild(existingPanel);

        host.append(tabs, panels);
        document.body.appendChild(host);
        return { tabs, panels, existingTab };
    }

    /** An unrelated MUI tab bar elsewhere on the page (e.g. a chat channel bar). */
    function unrelatedTabBar() {
        const bar = document.createElement('div');
        bar.className = 'MuiTabs-flexContainer';
        bar.setAttribute('role', 'tablist');

        const selectedTab = document.createElement('button');
        selectedTab.setAttribute('role', 'tab');
        selectedTab.setAttribute('aria-selected', 'true');
        selectedTab.setAttribute('tabindex', '0');
        selectedTab.classList.add('Mui-selected');
        selectedTab.textContent = 'General';
        bar.appendChild(selectedTab);

        document.body.appendChild(bar);
        return { bar, selectedTab };
    }

    test('clicking the Toolasha tab leaves other tab bars alone', async () => {
        const { tabs, existingTab } = gameSettingsPanelWithExistingTab();
        const { selectedTab } = unrelatedTabBar();

        await settingsUI.injectSettingsTab();

        const toolashaTab = tabs.querySelector('#toolasha-settings-tab');
        expect(toolashaTab).not.toBeNull();

        toolashaTab.click();

        // The settings panel's own tabs moved correctly.
        expect(toolashaTab.getAttribute('aria-selected')).toBe('true');
        expect(toolashaTab.classList.contains('Mui-selected')).toBe(true);
        expect(existingTab.getAttribute('aria-selected')).toBe('false');
        expect(existingTab.getAttribute('tabindex')).toBe('-1');
        expect(existingTab.classList.contains('Mui-selected')).toBe(false);

        // An unrelated tab bar elsewhere in the document (chat channels, the
        // top-right panel, ...) is untouched: its React state never changed,
        // so if this code stripped its class the tab would stay unpainted.
        expect(selectedTab.getAttribute('aria-selected')).toBe('true');
        expect(selectedTab.getAttribute('tabindex')).toBe('0');
        expect(selectedTab.classList.contains('Mui-selected')).toBe(true);
    });
});

describe('tearing the panel down leaves the settings alone', () => {
    // `cleanupDOM` runs on `character_initialized`, which a plain reconnect or
    // re-login to the same character fires with no switch events behind it —
    // nothing reloads config afterwards. Emptying the map there left every read
    // on the shipped default and every write in the queue that only a load
    // drains: switches moved, nothing was stored, a refresh showed none of it.
    test('cleanupDOM does not empty the config cache', () => {
        settingsUI.cleanupDOM();

        expect(mocks.cacheClears).toBe(0);
    });

    test('the full shutdown does not empty it either', () => {
        settingsUI.cleanup();

        expect(mocks.cacheClears).toBe(0);
    });
});

describe('restoring a backup says whether it worked', () => {
    /**
     * Drive `handleFullRestore` end to end: the file input it builds is
     * detached, so it is caught on the way out of `createElement` and handed a
     * file the way a picker would.
     * @param {Object} payload - The backup file's contents
     * @returns {Promise<void>}
     */
    async function restore(payload) {
        const created = [];
        const realCreate = document.createElement.bind(document);
        const spy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
            const element = realCreate(tag);
            if (tag === 'input') created.push(element);
            return element;
        });

        settingsUI.handleFullRestore();
        spy.mockRestore();

        const input = created.at(-1);
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ text: async () => JSON.stringify(payload) }],
        });
        input.dispatchEvent(new Event('change'));
        // Let the handler's awaits settle
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    beforeEach(() => {
        mocks.choiceAnswer = 'restore';
        mocks.importResult = { restored: {}, expected: {}, failed: [], complete: true };
        globalThis.alert = vi.fn();
    });

    afterEach(() => {
        mocks.choiceAnswer = null;
    });

    test('a store that took nothing is named, and the restore is not called done', async () => {
        // "Restored 0 entries across 1 stores" used to be the success message
        // for a restore that wrote nothing at all
        mocks.importResult = {
            restored: { xpHistory: 0 },
            expected: { xpHistory: 40 },
            failed: [{ store: 'xpHistory', expected: 40, written: 0 }],
            complete: false,
        };

        await restore({ formatVersion: 1, stores: { xpHistory: {} } });

        const said = globalThis.alert.mock.calls.at(-1)[0];
        expect(said).toContain('did not finish');
        expect(said).toContain('xpHistory (0/40)');
        expect(said).not.toContain('Reload');
    });

    test('a clean restore asks for a reload, and says what a delayed one costs', async () => {
        mocks.importResult = {
            restored: { settings: 12 },
            expected: { settings: 12 },
            failed: [],
            complete: true,
        };

        await restore({ formatVersion: 1, stores: { settings: {} } });

        const said = globalThis.alert.mock.calls.at(-1)[0];
        expect(said).toContain('Restored 12 entries');
        expect(said).toContain('changes made before reloading will not be kept');
    });
});

describe('the pro-defaults reset button', () => {
    /** @returns {HTMLElement} The reset button the schema's `button` row renders */
    function resetButton() {
        return document.querySelector('.toolasha-setting-action-btn[data-setting-id="enhanceSim_resetProDefaults"]');
    }

    /** @param {string} id @returns {{enabled: HTMLInputElement, tier: HTMLSelectElement|null, level: HTMLInputElement}} */
    function gearInputs(id) {
        return {
            enabled: document.getElementById(`${id}_enabled`),
            tier: document.getElementById(`${id}_tier`),
            level: document.getElementById(`${id}_level`),
        };
    }

    test('a button row renders a real button and stores nothing', () => {
        drawPanel();
        const button = resetButton();
        expect(button).not.toBe(null);
        expect(button.textContent.trim()).toBe('Reset to pro defaults');
        // Nothing was written just by drawing it
        expect(mocks.written.filter(([id]) => id === 'enhanceSim_resetProDefaults')).toEqual([]);
    });

    test('pressing it writes every governed default through the same stores a hand edit uses', async () => {
        drawPanel();
        document.getElementById('enhanceSim_enhancingLevel').value = '5';

        resetButton().click();
        await settle();

        expect(mocks.written).toContainEqual(['enhanceSim_enhancingLevel', 140]);
        expect(mocks.written).toContainEqual([
            'enhanceSim_gear_enhancer',
            { enabled: true, tier: 'celestial', level: 15 },
        ]);
        expect(mocks.written).toContainEqual(['enhanceSim_gear_gloves', { enabled: true, level: 12 }]);
        // The setting the button does not govern is untouched
        expect(mocks.written.map(([id]) => id)).not.toContain('enhanceSim_autoDetect');
        // And the visible inputs now show what was stored
        expect(document.getElementById('enhanceSim_enhancingLevel').value).toBe('140');
        const enhancer = gearInputs('enhanceSim_gear_enhancer');
        expect(enhancer.enabled.checked).toBe(true);
        expect(enhancer.tier.value).toBe('celestial');
        expect(enhancer.level.value).toBe('15');
    });

    test('a gear row a hand edit disabled comes back clickable, not greyed with its box checked', async () => {
        drawPanel();
        const enhancer = gearInputs('enhanceSim_gear_enhancer');

        // Uncheck through the real change path, which greys tier and level out
        enhancer.enabled.checked = false;
        enhancer.enabled.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(enhancer.tier.style.cssText).toContain('pointer-events');

        resetButton().click();
        await settle();

        expect(enhancer.enabled.checked).toBe(true);
        expect(enhancer.tier.style.cssText).not.toContain('pointer-events');
        expect(enhancer.level.style.cssText).not.toContain('pointer-events');
    });

    test('while auto-detect is on, the detected display is left alone and the saved values take the defaults', async () => {
        drawPanel();
        mocks.settingsMap['enhanceSim_autoDetect'].isTrue = true;

        // The screen is showing detected values, and the saved map holds what
        // toggling auto-detect off will put back
        const enhancer = gearInputs('enhanceSim_gear_enhancer');
        enhancer.enabled.checked = false;
        enhancer.tier.value = 'holy';
        enhancer.level.value = '3';
        settingsUI._enhanceSimSavedValues = {
            enhanceSim_gear_enhancer: { enabled: false, tier: 'holy', level: '1' },
            enhanceSim_enhancingLevel: '7',
        };

        resetButton().click();
        await settle();

        // Stored values reset all the same
        expect(mocks.written).toContainEqual([
            'enhanceSim_gear_enhancer',
            { enabled: true, tier: 'celestial', level: 15 },
        ]);
        // The detected display did not get clobbered
        expect(enhancer.enabled.checked).toBe(false);
        expect(enhancer.tier.value).toBe('holy');
        expect(enhancer.level.value).toBe('3');
        // But what toggling auto-detect off restores is now the defaults
        expect(settingsUI._enhanceSimSavedValues['enhanceSim_gear_enhancer']).toEqual({
            enabled: true,
            tier: 'celestial',
            level: '15',
        });
        expect(settingsUI._enhanceSimSavedValues['enhanceSim_enhancingLevel']).toBe('140');

        settingsUI._enhanceSimSavedValues = null;
    });
});

describe('editing a gear row', () => {
    test('a tierless row stores no tier key, so it can ever match its schema default again', async () => {
        drawPanel();
        const level = document.getElementById('enhanceSim_gear_gloves_level');
        level.value = '12';
        level.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const stored = mocks.written.findLast(([id]) => id === 'enhanceSim_gear_gloves')[1];
        expect(stored).toEqual({ enabled: true, level: 12 });
        expect('tier' in stored).toBe(false);
    });

    test('a tiered row still stores its tier', async () => {
        drawPanel();
        const tier = document.getElementById('enhanceSim_gear_enhancer_tier');
        tier.value = 'holy';
        tier.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const stored = mocks.written.findLast(([id]) => id === 'enhanceSim_gear_enhancer')[1];
        expect(stored).toEqual({ enabled: true, tier: 'holy', level: 15 });
    });
});

describe('the spawn census export button', () => {
    /** @returns {HTMLElement} The export button the schema's `button` row renders */
    function exportButton() {
        return document.querySelector('.toolasha-setting-action-btn[data-setting-id="spawnCensusExport"]');
    }

    test('renders enabled regardless of the checkbox, since off-but-collected data is still worth exporting', () => {
        mocks.settingsMap['spawnCensus'].isTrue = true;
        drawPanel();
        expect(row('spawnCensusExport').style.pointerEvents).toBe('');
        expect(row('spawnCensusExport').style.opacity).toBe('');

        mocks.settingsMap['spawnCensus'].isTrue = false;
        settingsUI.applyDisabledByState();
        expect(row('spawnCensusExport').style.pointerEvents).toBe('');
        expect(row('spawnCensusExport').style.opacity).toBe('');
    });

    test('clicking flushes and downloads, and reports how many waves went out', async () => {
        censusMock.wavesSeen = 42;
        censusMock.downloadResult = true;
        drawPanel();

        exportButton().click();
        await settle();

        expect(censusMock.flushCalls).toBe(1);
        expect(exportButton().textContent).toContain('42');
    });

    test('an empty census reports nothing recorded rather than downloading an empty file', async () => {
        censusMock.wavesSeen = 0;
        drawPanel();

        exportButton().click();
        await settle();

        expect(exportButton().textContent).toBe('Nothing recorded yet');
    });

    test('when this session never loaded the census, memory is hydrated from storage before checking', async () => {
        censusMock.initialized = false;
        censusMock.rosterSize = 0;
        censusMock.wavesSeen = 5;
        censusMock.downloadResult = true;
        drawPanel();

        exportButton().click();
        await settle();

        expect(censusMock.loadCalls).toBe(1);
    });

    test('asks the census to load whatever its state, since load() is idempotent', async () => {
        // The button used to skip the read whenever memory held anything, which
        // was the only thing standing between a second press and a doubled
        // count - and it was still true for a press that arrived while the first
        // read was in flight. The census now refuses the second read itself
        // (spawn-census.test.js proves it), so the button simply always asks.
        censusMock.initialized = true;
        censusMock.rosterSize = 3;
        censusMock.wavesSeen = 5;
        censusMock.downloadResult = true;
        drawPanel();

        exportButton().click();
        await settle();
        exportButton().click();
        await settle();

        expect(censusMock.loadCalls).toBe(2);
    });
});
