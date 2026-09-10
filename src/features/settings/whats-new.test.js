/**
 * The first-run dialogs, exercised where the wrong answer costs the most.
 *
 * Two people land in `applyPolicy`'s first-run branch: a fresh install, which
 * gets a preset picker with Defaults as its safe answer, and a returning user
 * whose settings arrived from another build, who gets a picker whose safe answer
 * is "change nothing". The failure that matters is the returning user's config
 * being rewritten when they asked for it to be left alone — including when they
 * dismiss the dialog unread — so that is what these tests pin down.
 *
 * The dialog itself is mocked: `askChoice` returns whatever the test decides,
 * and records the choice list it was handed, so the assertions are about which
 * settings got written and which options were offered, not about pixels.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Window } from 'happy-dom';

// The popup-rendering tests need a DOM. A file-level `@vitest-environment
// happy-dom` directive would put the whole file in a browser-like environment,
// where Vitest's virtual-module mocks (fork-changelog / fork-overview) fail to
// resolve — so the DOM is registered as globals here instead, keeping the file
// in the node environment the first-run tests rely on.
const domWindow = new Window();
globalThis.window = domWindow;
globalThis.document = domWindow.document;

const mocks = vi.hoisted(() => ({
    answer: null,
    lastChoiceOptions: null,
    written: [],
    appliedPresets: [],
    // Setting definitions the mocked schema knows about; only their shape
    // matters — conservativeOverrides forces off the checkboxes that ship on.
    definitions: {},
    // Copy-from-character seams.
    candidates: [],
    copiedFrom: null,
    copySucceeds: true,
    knownCount: 1,
    openSettingsCalls: [],
}));

vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async (options) => {
        mocks.lastChoiceOptions = options;
        return mocks.answer;
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        setSetting: (id, value) => {
            mocks.written.push([id, value]);
        },
        getSetting: () => false,
        getSettingValue: () => 0,
        Z_FLOATING_PANEL: 1000,
        charactersWithSettings: async () => mocks.candidates,
        copySettingsFromCharacter: async (id) => {
            mocks.copiedFrom = id;
            return { success: mocks.copySucceeds };
        },
        getKnownCharacterCount: async () => mocks.knownCount,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char-1',
    },
}));

// The schema is reduced to the definitions a test sets: conservativeOverrides
// (real, pure) reads these to decide which new switches ship on.
vi.mock('../../core/settings-schema.js', () => ({
    getAllSettingIds: () => Object.keys(mocks.definitions),
    getSettingDefinition: (id) => mocks.definitions[id] || null,
}));

// setting-presets is used for real — the returning-user picker must offer the
// genuine SETTING_PRESETS — but applyPreset is spied so a test can see it was
// called (or not) without reaching config/storage.
vi.mock('./setting-presets.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        applyPreset: async (id) => {
            mocks.appliedPresets.push(id);
            return {};
        },
    };
});

// The fork changelog is a build-time virtual module; the first-run tests never
// render the popup, so an empty string is enough to let the import resolve. The
// renderer tests pass their own markdown in directly. Held in a mutable ref
// rather than a fixed string so the "Copy changelog" test can give the popup
// something to copy.
const virtualChangelog = vi.hoisted(() => ({ text: '' }));
vi.mock('virtual:fork-changelog', () => ({
    get default() {
        return virtualChangelog.text;
    },
}));

// The newcomer overview is the other build-time virtual module. A distinctive
// marker lets the popup tests tell "the overview is on screen" from "it isn't".
vi.mock('virtual:fork-overview', () => ({
    default: '### Combat & simulators\n\n- Live DPS overview-marker-text read off your own fights.\n',
}));

// The floating-panel registry reaches into a shared z-index store; the popup
// tests only care that the panel's content is right, so it is stubbed away.
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

// openSettings drives the real game's DOM to switch tabs and scroll a row into
// view — none of which exists here, so the fallback-control test drives this
// mock instead of the real settings panel.
vi.mock('../ui/command-palette.js', () => ({
    openSettings: async (...args) => {
        mocks.openSettingsCalls.push(args);
    },
}));

const { default: whatsNew, renderForkMarkdown, COPY_FROM_CHARACTER, NO_CHANGE } = await import('./whats-new.js');
const { SETTING_PRESETS, DEFAULT_PRESET_ID } = await import('./setting-presets.js');
const { conservativeOverrides } = await import('./whats-new-core.js');

const CURRENT = { fork: 'Toolasha', version: '2.90.0' };

/**
 * A schema where `onById` are checkboxes shipping on (the conservative policy's
 * targets) and `offById` are checkboxes shipping off.
 */
function defineSchema(onIds = [], offIds = []) {
    mocks.definitions = {};
    for (const id of onIds) mocks.definitions[id] = { type: 'checkbox', default: true };
    for (const id of offIds) mocks.definitions[id] = { type: 'checkbox', default: false };
}

beforeEach(() => {
    mocks.answer = null;
    mocks.lastChoiceOptions = null;
    mocks.written = [];
    mocks.appliedPresets = [];
    mocks.candidates = [];
    mocks.copiedFrom = null;
    mocks.copySucceeds = true;
    mocks.knownCount = 1;
    mocks.openSettingsCalls = [];
    whatsNew._pending = null;
    virtualChangelog.text = '';
    delete whatsNew._pickSourceCharacter; // restore the real method if a test replaced it
    delete whatsNew._writeClipboard; // restore the real method if a test replaced it
    defineSchema();
});

describe('the returning-user picker', () => {
    test('keepCurrent applies no preset and holds the conservative policy', async () => {
        defineSchema(['newFeatureA', 'newFeatureB'], ['newTuning']);
        const inherited = ['newFeatureA', 'newFeatureB', 'newTuning'];
        const conservative = conservativeOverrides(inherited, (id) => mocks.definitions[id] || null);
        mocks.answer = 'keepCurrent';

        await whatsNew._offerFirstRunChoice(inherited, CURRENT);

        expect(mocks.appliedPresets).toEqual([]);
        const written = Object.fromEntries(mocks.written);
        expect(written.whatsNew_newDefaultsOff).toBe(true);
        for (const id of conservative) expect(written[id]).toBe(false);
        // Every conservative id was switched off, and nothing else was set true
        expect(mocks.written.filter(([, value]) => value === true).map(([id]) => id)).toEqual([
            'whatsNew_newDefaultsOff',
        ]);
        expect(whatsNew._pending.newIds).toEqual(inherited);
        expect(whatsNew._pending.turnedOff).toEqual(new Set(conservative));
    });

    test('dismissal (null) behaves exactly like keepCurrent', async () => {
        defineSchema(['newFeatureA'], ['newTuning']);
        const inherited = ['newFeatureA', 'newTuning'];
        const conservative = conservativeOverrides(inherited, (id) => mocks.definitions[id] || null);
        mocks.answer = null;

        await whatsNew._offerFirstRunChoice(inherited, CURRENT);

        expect(mocks.appliedPresets).toEqual([]);
        const written = Object.fromEntries(mocks.written);
        expect(written.whatsNew_newDefaultsOff).toBe(true);
        for (const id of conservative) expect(written[id]).toBe(false);
        expect(whatsNew._pending.turnedOff).toEqual(new Set(conservative));
    });

    test('a real preset is applied and the conservative policy is not', async () => {
        defineSchema(['newFeatureA', 'newFeatureB'], []);
        const inherited = ['newFeatureA', 'newFeatureB'];
        mocks.answer = 'combat';

        await whatsNew._offerFirstRunChoice(inherited, CURRENT);

        expect(mocks.appliedPresets).toEqual(['combat']);
        // The user asked for this configuration, so nothing is force-disabled
        // and whatsNew_newDefaultsOff is left untouched
        expect(mocks.written).toEqual([]);
        expect(whatsNew._pending.newIds).toEqual([]);
        expect(whatsNew._pending.turnedOff).toEqual(new Set());
    });

    test('keepCurrent is the first, primary option and every preset follows', async () => {
        mocks.answer = 'keepCurrent';
        await whatsNew._offerFirstRunChoice(['newFeatureA'], CURRENT);

        const choices = mocks.lastChoiceOptions.choices;
        expect(choices[0].value).toBe('keepCurrent');
        expect(choices[0].tone).toBe('primary');

        const values = choices.map((choice) => choice.value);
        for (const preset of SETTING_PRESETS) expect(values).toContain(preset.id);
        // keepCurrent plus every preset, and nothing else
        expect(values).toEqual(['keepCurrent', ...SETTING_PRESETS.map((preset) => preset.id)]);
        // Exactly one primary button, the safe one
        expect(choices.filter((choice) => choice.tone === 'primary').map((choice) => choice.value)).toEqual([
            'keepCurrent',
        ]);
    });
});

describe('the markdown renderer', () => {
    function render(markdown) {
        const root = document.createElement('div');
        renderForkMarkdown(root, markdown);
        return root;
    }

    test('strips markup and decodes entities, leaving no literal ## ** or backticks', () => {
        const root = render(
            '## Unreleased — branch `x`\n' +
                '### Heading &lt;tag&gt;\n' +
                '- A **bold** bullet with `code` and &lt;name&gt;\n'
        );
        const text = root.textContent;
        expect(text).not.toContain('##');
        expect(text).not.toContain('**');
        expect(text).not.toContain('`');
        // &lt; became a real '<', and no escaped entity survived
        expect(text).toContain('<tag>');
        expect(text).toContain('<name>');
        expect(text).not.toContain('&lt;');
        // The "## Unreleased" section heading is skipped entirely
        expect(text).not.toContain('Unreleased');
    });

    test('renders ### headings and - bullets as readable text', () => {
        const root = render('### Combat\n\n- First thing\n- Second thing\n');
        const text = root.textContent;
        expect(text).toContain('Combat');
        expect(text).toContain('First thing');
        expect(text).toContain('Second thing');
        // Bullets are prefixed with a real bullet glyph, not a hyphen
        expect(text).toContain('• First thing');
    });
});

describe('the popup shows the overview only to newcomers', () => {
    const base = { headline: 'x', forkChanged: false, newIds: [], turnedOff: new Set() };

    test('a newcomer popup includes the overview', () => {
        whatsNew._buildPanel({ ...base, isNewcomer: true });
        expect(whatsNew.panel.textContent).toContain('overview-marker-text');
        expect(whatsNew.panel.textContent).toContain('Toolasha — at a glance');
        whatsNew.close();
    });

    test('a plain version update does not include the overview', () => {
        whatsNew._buildPanel({ ...base, isNewcomer: false });
        expect(whatsNew.panel.textContent).not.toContain('overview-marker-text');
        expect(whatsNew.panel.textContent).not.toContain('Toolasha — at a glance');
        whatsNew.close();
    });
});

describe('the fallback control for a non-inline-editable setting', () => {
    const base = { headline: 'x', forkChanged: false, turnedOff: new Set(), isNewcomer: false };

    test('a button type gets a clickable control that closes the dialog and opens settings', async () => {
        mocks.definitions = { spawnCensusExport: { type: 'button', label: 'Export census' } };

        whatsNew._buildPanel({ ...base, newIds: ['spawnCensusExport'] });
        // The header's × and the footer's Close button are also <button>s, so
        // find the row's control by its own text rather than the first match
        const control = [...whatsNew.panel.querySelectorAll('button')].find(
            (button) => button.textContent === 'Open in Settings'
        );
        // The row's control is a real button, not a dead span
        expect(control).toBeTruthy();
        expect(control.textContent).not.toBe('in Settings');

        control.click();

        // Closing happens synchronously, before openSettings is even awaited
        expect(whatsNew.panel).toBeNull();
        expect(mocks.openSettingsCalls).toEqual([['', 'spawnCensusExport']]);
    });
});

describe('the changelog copy button', () => {
    const base = { headline: 'x', forkChanged: false, newIds: [], turnedOff: new Set(), isNewcomer: false };

    test('is not offered when there is no changelog to copy', () => {
        virtualChangelog.text = '';
        whatsNew._buildPanel(base);
        expect(whatsNew.panel.querySelector('.toolasha-whats-new-copy-changelog')).toBeNull();
        whatsNew.close();
    });

    test('copies the raw changelog markdown, and reports success on the button', async () => {
        virtualChangelog.text = '### Combat\n\n- Something changed\n';
        let copied = null;
        whatsNew._writeClipboard = async (text) => {
            copied = text;
            return true;
        };

        whatsNew._buildPanel(base);
        const button = whatsNew.panel.querySelector('.toolasha-whats-new-copy-changelog');
        expect(button).not.toBeNull();
        button.click();
        await Promise.resolve();

        expect(copied).toBe('### Combat\n\n- Something changed');
        expect(button.textContent).toBe('Copied ✓');
        whatsNew.close();
    });

    test('says so when nothing accepted the text', async () => {
        virtualChangelog.text = '- Something changed\n';
        whatsNew._writeClipboard = async () => false;

        whatsNew._buildPanel(base);
        const button = whatsNew.panel.querySelector('.toolasha-whats-new-copy-changelog');
        button.click();
        await Promise.resolve();

        expect(button.textContent).toBe('Copy failed');
        whatsNew.close();
    });
});

describe('reopening the update popup', () => {
    const base = { headline: 'x', forkChanged: false, newIds: [], turnedOff: new Set(), isNewcomer: false };

    test('reopen rebuilds the last shown popup from the cached contents', async () => {
        whatsNew._shownData = { ...base, isNewcomer: true };
        await whatsNew.reopen();
        expect(whatsNew.panel).toBeTruthy();
        expect(whatsNew.panel.textContent).toContain('Toolasha — at a glance'); // the newcomer overview
        whatsNew.close();
        whatsNew._shownData = null;
    });

    test('reopen with nothing cached still opens, so the button is never dead', async () => {
        whatsNew._shownData = null; // and the mocked storage returns no snapshot
        await whatsNew.reopen();
        expect(whatsNew.panel).toBeTruthy();
        whatsNew.close();
    });
});

describe('the fresh-install picker', () => {
    test('Defaults comes first and is primary, No change follows, then the other presets', async () => {
        mocks.answer = DEFAULT_PRESET_ID;
        await whatsNew._offerFirstRunPreset(CURRENT);

        const choices = mocks.lastChoiceOptions.choices;
        const values = choices.map((choice) => choice.value);
        const otherPresets = SETTING_PRESETS.filter((preset) => preset.id !== DEFAULT_PRESET_ID).map((p) => p.id);
        expect(values).toEqual([DEFAULT_PRESET_ID, NO_CHANGE, ...otherPresets]);

        const primary = choices.filter((choice) => choice.tone === 'primary').map((choice) => choice.value);
        expect(primary).toEqual([DEFAULT_PRESET_ID]);

        // Choosing Defaults explicitly applies it
        expect(mocks.appliedPresets).toEqual([DEFAULT_PRESET_ID]);
    });

    test('No change applies nothing and touches no setting', async () => {
        mocks.answer = NO_CHANGE;
        await whatsNew._offerFirstRunPreset(CURRENT);
        expect(mocks.appliedPresets).toEqual([]);
        expect(mocks.written).toEqual([]);
    });

    test('dismissal (null) is No change — never a settings reset', async () => {
        mocks.answer = null;
        await whatsNew._offerFirstRunPreset(CURRENT);
        expect(mocks.appliedPresets).toEqual([]);
        expect(mocks.written).toEqual([]);
    });
});

describe('copy from another character', () => {
    test('the fresh-install picker offers copy after Defaults and No change', async () => {
        mocks.answer = DEFAULT_PRESET_ID;
        await whatsNew._offerFirstRunPreset(CURRENT, true);

        const values = mocks.lastChoiceOptions.choices.map((choice) => choice.value);
        const otherPresets = SETTING_PRESETS.filter((preset) => preset.id !== DEFAULT_PRESET_ID).map((p) => p.id);
        expect(values).toEqual([DEFAULT_PRESET_ID, NO_CHANGE, COPY_FROM_CHARACTER, ...otherPresets]);
    });

    test('the returning-user picker offers copy after keepCurrent, before the presets', async () => {
        mocks.answer = 'keepCurrent';
        await whatsNew._offerFirstRunChoice(['newFeatureA'], CURRENT, true);

        const values = mocks.lastChoiceOptions.choices.map((choice) => choice.value);
        expect(values).toEqual(['keepCurrent', COPY_FROM_CHARACTER, ...SETTING_PRESETS.map((preset) => preset.id)]);
    });

    test('choosing copy in the fresh-install picker copies the picked source, no preset', async () => {
        mocks.candidates = [{ id: 'main', name: 'Main' }];
        mocks.answer = COPY_FROM_CHARACTER;
        whatsNew._pickSourceCharacter = async () => 'main';

        await whatsNew._offerFirstRunPreset(CURRENT, true);

        expect(mocks.copiedFrom).toBe('main');
        expect(mocks.appliedPresets).toEqual([]);
        expect(whatsNew._pending.headline).toContain('Main');
    });

    test('choosing copy in the returning-user picker copies and skips keep/preset', async () => {
        defineSchema(['newFeatureA'], []);
        mocks.candidates = [{ id: 'alt', name: 'Alt' }];
        mocks.answer = COPY_FROM_CHARACTER;
        whatsNew._pickSourceCharacter = async () => 'alt';

        await whatsNew._offerFirstRunChoice(['newFeatureA'], CURRENT, true);

        expect(mocks.copiedFrom).toBe('alt');
        expect(mocks.appliedPresets).toEqual([]);
        expect(mocks.written).toEqual([]); // no conservative policy, no keep writes
        expect(whatsNew._pending.headline).toContain('Alt');
    });

    test('cancelling the pick is No change — no preset, no writes (fresh install)', async () => {
        mocks.candidates = [{ id: 'main', name: 'Main' }];
        mocks.answer = COPY_FROM_CHARACTER;
        whatsNew._pickSourceCharacter = async () => null; // cancelled

        await whatsNew._offerFirstRunPreset(CURRENT, true);

        expect(mocks.copiedFrom).toBeNull();
        expect(mocks.appliedPresets).toEqual([]);
        expect(mocks.written).toEqual([]);
    });

    test('cancelling the pick keeps current settings (returning user)', async () => {
        defineSchema(['newFeatureA'], []);
        mocks.candidates = [{ id: 'main', name: 'Main' }];
        mocks.answer = COPY_FROM_CHARACTER;
        whatsNew._pickSourceCharacter = async () => null;

        await whatsNew._offerFirstRunChoice(['newFeatureA'], CURRENT, true);

        expect(mocks.copiedFrom).toBeNull();
        expect(mocks.appliedPresets).toEqual([]);
        expect(Object.fromEntries(mocks.written).whatsNew_newDefaultsOff).toBe(true);
    });

    test('copy is a no-op leaving settings untouched when no character has settings', async () => {
        mocks.candidates = [];
        mocks.answer = COPY_FROM_CHARACTER;

        await whatsNew._offerFirstRunPreset(CURRENT, true);

        expect(mocks.copiedFrom).toBeNull();
        expect(mocks.appliedPresets).toEqual([]);
        expect(mocks.written).toEqual([]);
    });

    test('the copy-only prompt copies when asked and no-ops on keep', async () => {
        mocks.candidates = [{ id: 'alt', name: 'Alt' }];

        mocks.answer = 'keep';
        await whatsNew._offerCopyOnly(CURRENT);
        expect(mocks.copiedFrom).toBeNull();

        mocks.answer = COPY_FROM_CHARACTER;
        whatsNew._pickSourceCharacter = async () => 'alt';
        await whatsNew._offerCopyOnly(CURRENT);
        expect(mocks.copiedFrom).toBe('alt');
    });

    test('no copy option is offered when there is nothing to copy from', async () => {
        mocks.answer = DEFAULT_PRESET_ID;
        await whatsNew._offerFirstRunPreset(CURRENT, false);
        const values = mocks.lastChoiceOptions.choices.map((choice) => choice.value);
        expect(values).not.toContain(COPY_FROM_CHARACTER);
    });
});

describe('the changelog the popup draws', () => {
    const base = { headline: 'x', forkChanged: false, newIds: [], turnedOff: new Set(), isNewcomer: false };

    /** A slice with one released entry behind a marker and one still unreleased. */
    const MARKED = [
        '## Unreleased — branch `main`',
        '',
        '### Written since the release',
        '',
        'Body.',
        '',
        '<!-- shipped in 3.47.0 -->',
        '',
        '### Went out in 3.47.0',
        '',
        'Body.',
        '',
    ].join('\n');

    test('shows only what is newer than the build the player was running', () => {
        virtualChangelog.text = MARKED;
        whatsNew._buildPanel({ ...base, sinceVersion: '3.47.0' });
        const text = whatsNew.panel.textContent;
        expect(text).toContain('Written since the release');
        expect(text).not.toContain('Went out in 3.47.0');
        whatsNew.close();
    });

    test('shows everything when the stored version predates every marker', () => {
        virtualChangelog.text = MARKED;
        whatsNew._buildPanel({ ...base, sinceVersion: '3.1.0' });
        expect(whatsNew.panel.textContent).toContain('Went out in 3.47.0');
        whatsNew.close();
    });

    test('never draws a marker', () => {
        virtualChangelog.text = MARKED;
        for (const sinceVersion of [null, '3.1.0', '3.47.0']) {
            whatsNew._buildPanel({ ...base, sinceVersion });
            expect(whatsNew.panel.textContent).not.toContain('shipped in');
            whatsNew.close();
        }
    });

    test('an unmarked changelog draws exactly as it does today', () => {
        virtualChangelog.text = '### Combat\n\n- Something changed\n';
        whatsNew._buildPanel({ ...base, sinceVersion: '3.40.0' });
        const filtered = whatsNew.panel.textContent;
        whatsNew.close();
        whatsNew._buildPanel({ ...base, sinceVersion: null });
        expect(whatsNew.panel.textContent).toBe(filtered);
        whatsNew.close();
    });

    test('the copy button copies what is on screen, not the whole slice', async () => {
        virtualChangelog.text = MARKED;
        let copied = null;
        whatsNew._writeClipboard = async (text) => {
            copied = text;
            return true;
        };
        whatsNew._buildPanel({ ...base, sinceVersion: '3.47.0' });
        whatsNew.panel.querySelector('.toolasha-whats-new-copy-changelog').click();
        await Promise.resolve();
        expect(copied).toContain('### Written since the release');
        expect(copied).not.toContain('### Went out in 3.47.0');
        expect(copied).not.toContain('shipped in');
        whatsNew.close();
    });
});
