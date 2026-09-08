/**
 * @vitest-environment happy-dom
 *
 * The two things about a palette that are worth testing.
 *
 * **What a query matches.** The whole point is that four letters find the one
 * thing you wanted out of several hundred, and the ordering is what makes the
 * difference between pressing Enter and reading a list.
 *
 * **When the hotkey does not fire.** The game has a chat box. A palette that
 * opens over the message you are halfway through typing is a palette that gets
 * switched off, and nothing about the arithmetic above would catch it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/settings-schema.js', () => ({
    settingsGroups: {
        ui: {
            title: 'UI & Appearance',
            settings: {
                overlayPanel: { id: 'overlayPanel', label: 'Overlay Panel: one floating panel', type: 'checkbox' },
                draggableModals: { id: 'draggableModals', label: 'Draggable modals', type: 'checkbox' },
            },
        },
    },
}));
// `registerFloatingPanel` and friends are here for the PFormance panel, which
// this file opens for real to check what the palette's cleanup does to it.
vi.mock('../../utils/panel-z-index.js', () => ({
    PANEL_Z_CAP: 1199,
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

/** What the palette said when a command had nowhere to land */
const toasts = vi.hoisted(() => ({ said: [], kinds: [] }));
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.kinds.push(options?.kind || 'info');
        return toasts.said.push(message);
    },
}));

const rows = vi.hoisted(() => ({ current: [] }));
vi.mock('../../utils/overlay-rows.js', () => ({ registeredRows: () => rows.current }));

const overlay = vi.hoisted(() => ({
    toggle: vi.fn(),
    listLayouts: vi.fn(async () => []),
    applyNamedLayout: vi.fn(async () => true),
}));
vi.mock('./overlay-panel.js', () => ({ default: overlay }));

// Every other accessor on the bridge stays exactly as it is off-page — several
// unrelated modules (loadout-snapshot's websocket hook, for one) resolve
// through this same file at import time, so only the one accessor under test
// is overridden. Null unless a test asks for an instance.
const philo = vi.hoisted(() => ({ instance: null }));
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, philoCalculator: () => philo.instance };
});

const { registerCommand, unregisterCommand, resetCommands, registeredCommands } =
    await import('../../utils/command-registry.js');

const { default: pformancePanel } = await import('../dev/pformance-panel.js');

const {
    default: palette,
    fuzzyScore,
    filterCommands,
    isTypingTarget,
    isPaletteHotkey,
    verbResult,
    oneLineReason,
    revealSetting,
    openGuildTrials,
    openHealthReport,
} = await import('./command-palette.js');

/**
 * Enough of the game's settings dialog and Toolasha's tab inside it for the
 * palette to walk: the nav link it clicks, the tab it waits for, the search box
 * it fills, and one collapsed group with a setting in it.
 *
 * The search box carries a listener that hides what does not match, because the
 * real panel filters from its own input handler and the thing worth testing is
 * that the filter and the reveal compose rather than undo each other.
 *
 * @returns {Object} The pieces, plus what got clicked
 */
function buildSettingsDom() {
    const clicks = [];

    const link = document.createElement('a');
    link.className = 'NavigationBar_minorNavigationLink__xyz';
    link.textContent = 'Settings';
    link.addEventListener('click', () => clicks.push('nav'));
    document.body.appendChild(link);

    const tab = document.createElement('button');
    tab.id = 'toolasha-settings-tab';
    tab.addEventListener('click', () => clicks.push('tab'));
    document.body.appendChild(tab);

    const search = document.createElement('input');
    search.className = 'toolasha-search-input';
    document.body.appendChild(search);

    const group = document.createElement('div');
    group.className = 'toolasha-settings-group collapsed';
    group.dataset.group = 'ui';
    const content = document.createElement('div');
    content.className = 'toolasha-settings-group-content';
    group.appendChild(content);
    document.body.appendChild(group);

    const rowFor = (id, label) => {
        const row = document.createElement('div');
        row.className = 'toolasha-setting';
        row.dataset.settingId = id;
        row.style.display = 'flex';
        const labelEl = document.createElement('span');
        labelEl.className = 'toolasha-setting-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        row.scrollIntoView = vi.fn();
        content.appendChild(row);
        return row;
    };

    const modals = rowFor('draggableModals', 'Draggable modals');
    const overlayRow = rowFor('overlayPanel', 'Overlay Panel: one floating panel');

    search.addEventListener('input', () => {
        const query = search.value.toLowerCase().trim();
        let visible = 0;
        for (const row of content.querySelectorAll('.toolasha-setting')) {
            const text = row.querySelector('.toolasha-setting-label').textContent.toLowerCase();
            const shown = !query || text.includes(query);
            row.style.display = shown ? 'flex' : 'none';
            if (shown) visible++;
        }
        group.style.display = visible ? 'block' : 'none';
    });

    return { clicks, link, tab, search, group, modals, overlayRow };
}

/**
 * A command in the shape the filter expects.
 * @param {string} label - What it reads as
 * @param {string} [group] - Which section
 * @returns {Object}
 */
function command(label, group = 'Panel') {
    return { label, group, search: `${label} ${group}`.toLowerCase(), run: () => {} };
}

/** The labels currently drawn, top to bottom. @returns {string[]} */
function drawnLabels() {
    return [...document.querySelectorAll('[data-command-label]')].map((row) => row.dataset.commandLabel);
}

/**
 * Type into the palette's box and let it redraw.
 * @param {string} text - What to type
 */
function type(text) {
    palette.input.value = text;
    palette.input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * @param {string} key - Which key
 * @returns {KeyboardEvent}
 */
function press(key) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    palette.input.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    // The palette reads the registry, and in the page the features fill it.
    // Here the test does, so what is on offer is what the test says it is.
    resetCommands();
    registerCommand({ name: 'Overlay', hint: 'The tile overlay', run: () => overlay.toggle() });
    rows.current = [];
    toasts.said = [];
    toasts.kinds = [];
    overlay.toggle.mockClear();
    overlay.listLayouts.mockClear();
    overlay.listLayouts.mockResolvedValue([]);
    overlay.applyNamedLayout.mockClear();
    philo.instance = null;
    document.body.replaceChildren();
});

afterEach(() => {
    palette.cleanup();
});

describe('fuzzyScore', () => {
    test('a whole-query run beats scattered letters', () => {
        expect(fuzzyScore('sim', 'Combat Simulator')).toBeGreaterThan(fuzzyScore('sim', 'Show Item Menu'));
    });

    test('initials find a multi-word name', () => {
        expect(fuzzyScore('cs', 'Combat Simulator')).toBeGreaterThan(0);
        expect(fuzzyScore('cs', 'Consumables')).toBeGreaterThan(0);
        expect(fuzzyScore('cs', 'Combat Simulator')).toBeGreaterThan(fuzzyScore('cs', 'Consumables'));
    });

    test('letters that are not there in order do not match', () => {
        expect(fuzzyScore('zx', 'Combat Simulator')).toBe(-1);
        expect(fuzzyScore('rotalumis', 'Combat Simulator')).toBe(-1);
    });

    test('an empty query matches everything equally', () => {
        expect(fuzzyScore('', 'Anything')).toBe(0);
        expect(fuzzyScore('   ', 'Anything')).toBe(0);
    });

    test('a match at the start beats the same match in the middle', () => {
        expect(fuzzyScore('over', 'Overlay Panel')).toBeGreaterThan(fuzzyScore('over', 'Drop Over Expected'));
    });

    test('spaces in the query are gaps rather than characters to find', () => {
        expect(fuzzyScore('com sim', 'CombatSimulator')).toBeGreaterThan(0);
    });
});

describe('filterCommands', () => {
    const commands = [
        command('Overlay'),
        command('Treasure Tracker'),
        command('Combat Simulator'),
        command('Draggable modals', 'Setting'),
        command('Layout: Dungeon', 'Overlay layout'),
    ];

    test('no query keeps the original order', () => {
        expect(filterCommands(commands, '').map((c) => c.label)).toEqual(commands.map((c) => c.label));
    });

    test('the best match comes first', () => {
        expect(filterCommands(commands, 'treas')[0].label).toBe('Treasure Tracker');
        expect(filterCommands(commands, 'dungeon')[0].label).toBe('Layout: Dungeon');
    });

    test('the group is searchable, so a section can be listed on its own', () => {
        const labels = filterCommands(commands, 'overlay layout').map((c) => c.label);
        expect(labels[0]).toBe('Layout: Dungeon');
    });

    test('nothing matching gives nothing back', () => {
        expect(filterCommands(commands, 'qqqq')).toEqual([]);
    });

    test('the limit is honoured', () => {
        expect(filterCommands(commands, '', 2)).toHaveLength(2);
    });
});

describe('the hotkey', () => {
    test('Ctrl+K and Cmd+K both count, and nothing else does', () => {
        expect(isPaletteHotkey({ ctrlKey: true, key: 'k' })).toBe(true);
        expect(isPaletteHotkey({ metaKey: true, key: 'K' })).toBe(true);
        expect(isPaletteHotkey({ ctrlKey: true, key: 'j' })).toBe(false);
        expect(isPaletteHotkey({ key: 'k' })).toBe(false);
        expect(isPaletteHotkey({ ctrlKey: true, altKey: true, key: 'k' })).toBe(false);
        expect(isPaletteHotkey(null)).toBe(false);
    });
});

describe('isTypingTarget', () => {
    test('inputs, textareas and selects are typing', () => {
        for (const tag of ['input', 'textarea', 'select']) {
            expect(isTypingTarget(document.createElement(tag))).toBe(true);
        }
    });

    test('a contenteditable, and anything inside one, is typing', () => {
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        const inner = document.createElement('span');
        editable.appendChild(inner);
        document.body.appendChild(editable);

        expect(isTypingTarget(editable)).toBe(true);
        expect(isTypingTarget(inner)).toBe(true);
    });

    test('an ordinary element is not', () => {
        expect(isTypingTarget(document.createElement('div'))).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe('the palette in the page', () => {
    test('Ctrl+K opens it, and again closes it', () => {
        palette.initialize();
        expect(palette.isOpen).toBe(false);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        expect(palette.isOpen).toBe(true);

        // The chord fires from inside the palette's own input, which the typing
        // guard would otherwise decline — that exception is the point
        palette.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        expect(palette.isOpen).toBe(false);
    });

    test('it stays shut while the chat box has focus', () => {
        palette.initialize();

        const chat = document.createElement('input');
        document.body.appendChild(chat);
        chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));

        expect(palette.isOpen).toBe(false);
    });

    test('it stays shut while a contenteditable has focus', () => {
        palette.initialize();

        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        document.body.appendChild(editable);
        editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));

        expect(palette.isOpen).toBe(false);
    });

    test('a registered panel command is listed and runs what it registered', async () => {
        philo.instance = { openModal: vi.fn() };
        registerCommand({
            name: 'Philo Gamba',
            hint: 'Enhancing gamba profitability, costed against the market',
            run: () => philo.instance.openModal(),
        });

        palette.initialize();
        palette.open();
        type('philo gamba');
        expect(drawnLabels()[0]).toBe('Philo Gamba');

        press('Enter');
        expect(philo.instance.openModal).toHaveBeenCalled();
    });

    test('a command its feature never registered is not offered', () => {
        // The property the old hand-written list only half kept: a feature
        // that never initialised never registers, so nothing offers it
        philo.instance = null;

        palette.initialize();
        palette.open();
        type('philo');

        expect(drawnLabels()).not.toContain('Philo Gamba');
    });

    test('a command withdrawn by its feature stops being offered', () => {
        registerCommand({ name: 'Trade Ledger', hint: 'x', run: () => {} });

        palette.initialize();
        palette.open();
        type('trade ledger');
        expect(drawnLabels()).toContain('Trade Ledger');
        palette.close();

        unregisterCommand('Trade Ledger');
        palette.open();
        type('trade ledger');
        expect(drawnLabels()).not.toContain('Trade Ledger');
    });

    test('a command whose `when` says no is left out, and asked again next time', () => {
        let configured = false;
        registerCommand({
            name: 'Sync push',
            hint: 'Push settings and data to GitHub now',
            run: () => {},
            when: () => configured,
        });

        palette.initialize();
        palette.open();
        type('sync push');
        expect(drawnLabels()).not.toContain('Sync push');
        palette.close();

        configured = true;
        palette.open();
        type('sync push');
        expect(drawnLabels()).toContain('Sync push');
    });

    test('it lists panels, rows with an onOpen, and settings by label', async () => {
        const opened = vi.fn();
        rows.current = [
            { key: 'dps', name: 'DPS', onOpen: opened },
            { key: 'coins', name: 'Coins' },
        ];

        palette.initialize();
        palette.open();
        await vi.waitFor(() => expect(overlay.listLayouts).toHaveBeenCalled());

        const labels = drawnLabels();
        expect(labels).toContain('Overlay');
        expect(labels).toContain('DPS');
        // No onOpen means nothing to open
        expect(labels).not.toContain('Coins');
        expect(labels).toContain('Draggable modals');
    });

    test('saved layouts arrive as their own entries and can be chosen', async () => {
        overlay.listLayouts.mockResolvedValue(['Dungeon', 'Market']);

        palette.initialize();
        palette.open();
        await vi.waitFor(() => expect(drawnLabels()).toContain('Layout: Dungeon'));

        type('market');
        expect(drawnLabels()[0]).toBe('Layout: Market');

        press('Enter');
        expect(overlay.applyNamedLayout).toHaveBeenCalledWith('Market');
        expect(palette.isOpen).toBe(false);
    });

    test('arrows move the selection and Enter runs it', async () => {
        palette.initialize();
        palette.open();
        type('overlay');

        expect(palette.selected).toBe(0);
        press('ArrowDown');
        expect(palette.selected).toBe(1);
        press('ArrowUp');
        expect(palette.selected).toBe(0);

        press('Enter');
        expect(overlay.toggle).toHaveBeenCalled();
    });

    test('Escape closes it', () => {
        palette.initialize();
        palette.open();
        press('Escape');
        expect(palette.isOpen).toBe(false);
    });

    test('ordinary typing never reaches the game', () => {
        palette.initialize();
        palette.open();
        const event = press('a');
        // Not cancelled — the box still gets the character — but stopped, so the
        // game's own single-key handlers do not see it
        expect(event.defaultPrevented).toBe(false);
        expect(event.cancelBubble).toBe(true);
    });

    test('focus is pulled back when something else takes it', () => {
        palette.initialize();
        palette.open();

        const outside = document.createElement('input');
        document.body.appendChild(outside);
        outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        expect(document.activeElement).toBe(palette.input);
    });

    test('choosing a setting opens settings, filters, expands, scrolls and flashes', async () => {
        const dom = buildSettingsDom();

        palette.initialize();
        palette.open();
        type('draggable');
        expect(drawnLabels()[0]).toBe('Draggable modals');
        press('Enter');

        // The panel is the game's: the way in is the link a player would click,
        // then the tab this script injects into the dialog it opens
        await vi.waitFor(() => expect(dom.clicks).toEqual(['nav', 'tab']));

        // The search is still pre-filled — the filter is what puts one row on
        // screen — and the reveal happens on top of it rather than instead
        await vi.waitFor(() => expect(dom.search.value).toBe('Draggable modals'));
        expect(dom.overlayRow.style.display).toBe('none');
        expect(dom.modals.style.display).toBe('flex');

        await vi.waitFor(() => expect(dom.modals.dataset.toolashaFlash).toBe('on'));
        expect(dom.group.classList.contains('collapsed')).toBe(false);
        expect(dom.modals.scrollIntoView).toHaveBeenCalled();
    });

    test('expanding for one visit is not the same as expanding for good', async () => {
        const dom = buildSettingsDom();
        const collapsedWrites = [];
        // The panel persists its collapsed set from the header's click handler;
        // nothing here clicks a header, so nothing is written down
        dom.group.addEventListener('click', () => collapsedWrites.push('header'));

        await revealSetting('draggableModals');

        expect(dom.group.classList.contains('collapsed')).toBe(false);
        expect(collapsedWrites).toEqual([]);
    });

    test('a setting drawn as a chip rather than a row is still reached', async () => {
        // Iron Cow is a mode: its schema entry is hidden and its control is a
        // chip in the presets block, outside every settings group
        const chip = document.createElement('button');
        chip.className = 'toolasha-mode-chip';
        chip.dataset.settingId = 'ironCow_enabled';
        chip.scrollIntoView = vi.fn();
        document.body.appendChild(chip);

        const revealed = await revealSetting('ironCow_enabled');

        expect(revealed).toBe(chip);
        expect(chip.dataset.toolashaFlash).toBe('on');
        expect(chip.scrollIntoView).toHaveBeenCalled();
    });

    test('a setting that is not on the page reveals nothing rather than throwing', async () => {
        expect(await revealSetting('')).toBe(null);

        // The wait is for a panel the game has not drawn yet; when it never
        // arrives the answer is null, not an exception a few seconds later
        vi.useFakeTimers();
        try {
            const pending = revealSetting('somethingElse');
            await vi.advanceTimersByTimeAsync(4000);
            expect(await pending).toBe(null);
        } finally {
            vi.useRealTimers();
        }
    });

    test('cleanup takes it down and unhooks the chord', () => {
        palette.initialize();
        palette.open();
        palette.cleanup();

        expect(palette.isOpen).toBe(false);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        expect(palette.isOpen).toBe(false);
    });
});

/**
 * The guild trial figures are not a panel — they are drawn into the game's own
 * guild page — so nothing in the script points at them and the reasonable
 * conclusion, reached by an actual player mid-trial, is that they do not exist.
 * This entry is the signpost, and what it does when there is nothing to point at
 * matters as much as what it does when there is.
 */
describe('the Guild Trials entry', () => {
    /**
     * The guild page, as much of it as the walk touches.
     * @param {Object} [options] - `withBlock: false` for a tab that has drawn nothing yet
     * @returns {Object} The pieces, plus what got clicked
     */
    function buildGuildDom({ withBlock = true } = {}) {
        const clicks = [];

        const link = document.createElement('a');
        link.className = 'NavigationBar_minorNavigationLink__xyz';
        link.textContent = 'Guild';
        link.addEventListener('click', () => clicks.push('guild'));
        document.body.appendChild(link);

        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__a';

        // The live guild page has both, in this order, and they are different
        // pages: Trials is the sign-up sheet, In Progress is where the pool bar
        // and the pace figures are
        const tab = (label) => {
            const el = document.createElement('div');
            el.className = 'TabsComponent_tab__b';
            el.textContent = label;
            el.addEventListener('click', () => clicks.push(label.toLowerCase()));
            return el;
        };

        panel.append(tab('Members'), tab('Trials'), tab('In Progress'));

        let block = null;
        if (withBlock) {
            block = document.createElement('div');
            block.className = 'mwi-trial-info';
            block.textContent = 'Trial payout';
            block.scrollIntoView = vi.fn();
            panel.appendChild(block);
        }

        document.body.appendChild(panel);
        return { clicks, panel, block };
    }

    test('is offered, and is not pretending to be a panel', async () => {
        palette.initialize();
        palette.open();
        await vi.waitFor(() => expect(overlay.listLayouts).toHaveBeenCalled());

        expect(drawnLabels()).toContain('Guild Trials');
    });

    test('walks to the guild page, opens the Trials tab and lights up the figures', async () => {
        const dom = buildGuildDom();

        expect(await openGuildTrials()).toBe(true);

        // In Progress, not Trials: the Trials tab cannot produce a reading
        expect(dom.clicks).toEqual(['guild', 'in progress']);
        expect(dom.block.dataset.toolashaFlash).toBe('on');
        expect(dom.block.scrollIntoView).toHaveBeenCalled();
    });

    test('says so when there is nothing drawn yet, rather than leaving you on a page', async () => {
        // Which is the ordinary case: readings are only taken while the tab is
        // open, so a player arriving from the palette has not fed it anything
        const dom = buildGuildDom({ withBlock: false });

        vi.useFakeTimers();
        try {
            const pending = openGuildTrials();
            await vi.advanceTimersByTimeAsync(4000);
            expect(await pending).toBe(false);
        } finally {
            vi.useRealTimers();
        }

        expect(dom.clicks).toEqual(['guild', 'in progress']);
        expect(toasts.said.join(' ')).toContain('No trial figures yet');
        expect(toasts.said.join(' ')).toContain('In Progress tab');
    });

    test('a guild page that never appears is reported, not thrown', async () => {
        vi.useFakeTimers();
        try {
            const pending = openGuildTrials();
            await vi.advanceTimersByTimeAsync(4000);
            expect(await pending).toBe(false);
        } finally {
            vi.useRealTimers();
        }

        expect(toasts.said.join(' ')).toContain('Could not open the guild page');
    });
});

/**
 * The health report is assembled in the entrypoint and published on the page as
 * `window.Toolasha.debug.health`; the palette only invokes it. Both what it does
 * when that global is there and what it does when it is not are worth pinning —
 * a diagnostic entry that throws is worse than one that says "not yet".
 */
describe('the Health report entry', () => {
    afterEach(() => {
        delete window.Toolasha;
    });

    test('is offered regardless of settings', async () => {
        palette.initialize();
        palette.open();
        await vi.waitFor(() => expect(overlay.listLayouts).toHaveBeenCalled());

        expect(drawnLabels()).toContain('Health report');
    });

    test('calls the page-global builder the entrypoint publishes', async () => {
        const health = vi.fn(async () => 'report text');
        window.Toolasha = { debug: { health } };

        expect(await openHealthReport()).toBe(true);
        expect(health).toHaveBeenCalled();
    });

    test('says so when the global is not there yet rather than throwing', async () => {
        delete window.Toolasha;

        expect(await openHealthReport()).toBe(false);
        expect(toasts.said.join(' ')).toContain('not available yet');
    });
});

/**
 * PFormance has no settings gate and, unlike every other panel, no entry of its
 * own in the entrypoint's feature list — nothing else ever calls its
 * `initialize()`. The palette calls it directly (it shares this file's bundle,
 * so a direct import is safe), and this is the entry that regressed: commit
 * 37519cc94 moved `registerCommand({ name: 'PFormance', ... })` into
 * `pformance-panel.js`'s own `initialize()` without adding anything that would
 * ever call it, so the command silently stopped being offered.
 */
describe('the PFormance entry', () => {
    test('is offered regardless of settings', async () => {
        palette.initialize();
        palette.open();
        await vi.waitFor(() => expect(overlay.listLayouts).toHaveBeenCalled());

        expect(drawnLabels()).toContain('PFormance');
    });

    test('initialize() only registers the command; it does not open the panel', () => {
        palette.initialize();
        expect(document.getElementById('toolasha-pformance-panel')).toBeNull();
    });

    test('cleanup withdraws the command', () => {
        palette.initialize();
        expect(registeredCommands().map((c) => c.name)).toContain('PFormance');

        palette.cleanup();
        expect(registeredCommands().map((c) => c.name)).not.toContain('PFormance');
    });

    /**
     * `cleanup()` is the teardown the feature registry runs on every character
     * switch (entrypoint wires the module's `cleanup` in as the registry's
     * `disable`, and `disableAllFeatures` is the cleanup half of a switch), so
     * anything it removes from the page is removed on every switch. Withdrawing
     * the command through `pformancePanel.disable()` also removed the panel
     * itself — including one opened from the settings button, which never goes
     * through the palette at all — so a diagnostic left open vanished the
     * moment the user changed character.
     */
    test('cleanup leaves an open panel on screen — a character switch runs it', () => {
        window.Toolasha = {
            ...(window.Toolasha || {}),
            Core: {
                performanceMonitor: {
                    enabled: false,
                    getAllStats: () => new Map(),
                    getSnapshots: () => new Map(),
                    getSpans: () => [],
                    getMarks: () => [],
                },
            },
        };
        palette.initialize();
        registeredCommands()
            .find((c) => c.name === 'PFormance')
            .run();
        expect(document.getElementById('toolasha-pformance-panel')).not.toBeNull();

        palette.cleanup();

        expect(document.getElementById('toolasha-pformance-panel')).not.toBeNull();
        pformancePanel.hide();
    });
});

/**
 * The pre-`37519cc94` palette held these fifteen entries in a hand-written
 * array; the commit that replaced it with the registry moved each one into the
 * feature that owns it, and the fix here is for the one owner (PFormance's)
 * that nothing ever calls. This list is that original fifteen, unchanged —
 * nothing has been added to it since — and it exists so that a future refactor
 * which repeats the mistake (moving a registration into an `initialize()` that
 * the entrypoint's feature list, or the palette's own setup, does not reach)
 * fails a test instead of just quietly trimming the palette.
 *
 * Everything but the four the palette itself owns (Settings, Guild Trials,
 * Health report, PFormance) is registered by another feature module, so this
 * test does not boot the whole entrypoint to reach them — it stands in for
 * "the feature list initialized this" the same way `beforeEach` already stands
 * in for Overlay above. Only the palette's own four commands are exercised for
 * real, through `palette.initialize()`, and PFormance is exactly the one this
 * would have caught: without the fix in `command-palette.js`, it is missing
 * from `registeredCommands()` and this test fails.
 */
describe('the commands the palette has always had', () => {
    const PRE_REGISTRY_COMMANDS = [
        'Overlay',
        'Goal Planner',
        'Iron Bell Farming',
        'Treasure Tracker',
        'PFormance',
        'Combat Simulator',
        'Enhancement Tracker',
        'Lab Simulator',
        'Guild Trials',
        'Trial Damage',
        'Philo Gamba',
        'Settings',
        'Sync push',
        'Sync pull',
        'Health report',
    ];

    // Registered directly by the palette itself (see `registerOwnCommands` /
    // `OWN_COMMANDS` in command-palette.js) rather than by another feature's
    // `initialize()` — these are exercised for real below, never stood in for.
    const PALETTE_OWNED = ['Settings', 'Guild Trials', 'Health report', 'PFormance'];

    test('every one is still present once the palette and the feature list have run', () => {
        // Stand-ins for the feature-list registrations this file cannot cheaply
        // boot for real (each is a different bundle's module). 'Overlay' is
        // already registered by beforeEach above.
        for (const name of PRE_REGISTRY_COMMANDS) {
            if (PALETTE_OWNED.includes(name)) continue;
            if (registeredCommands().some((c) => c.name === name)) continue;
            registerCommand({ name, hint: '', run: () => {} });
        }

        // The palette's own commands are the real thing, not stand-ins: this is
        // what actually catches an entry that stopped being reachable, and it
        // is what regressed for PFormance.
        palette.initialize();

        const names = registeredCommands().map((c) => c.name);
        for (const name of PRE_REGISTRY_COMMANDS) {
            expect(names).toContain(name);
        }
    });
});

describe('the Guild Trials entry, on a page with both tabs', () => {
    test('falls back to the Trials tab when the game has no In Progress one', async () => {
        // Older clients, and any future rename: the entry should still land
        // somewhere useful rather than nowhere
        const clicks = [];
        const link = document.createElement('a');
        link.className = 'NavigationBar_minorNavigationLink__xyz';
        link.textContent = 'Guild';
        link.addEventListener('click', () => clicks.push('guild'));
        document.body.appendChild(link);

        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__a';
        const trials = document.createElement('div');
        trials.className = 'TabsComponent_tab__b';
        trials.textContent = 'Trials';
        trials.addEventListener('click', () => clicks.push('trials'));
        const block = document.createElement('div');
        block.className = 'mwi-trial-info';
        block.scrollIntoView = vi.fn();
        panel.append(trials, block);
        document.body.appendChild(panel);

        expect(await openGuildTrials()).toBe(true);
        expect(clicks).toEqual(['guild', 'trials']);
    });
});

/**
 * A verb is the half of the registry that has no panel to stand for it, so the
 * toast is not decoration — it is the entire visible result of the keystroke.
 * What these pin is the difference the convention exists to make: that a verb
 * which failed and a verb which quietly did nothing no longer look the same.
 */
describe('running a verb', () => {
    /**
     * Open the palette, pick the one command whose label matches, and wait for
     * it to have reported.
     * @param {string} label - The verb's name
     * @returns {Promise<void>}
     */
    async function pick(label) {
        palette.initialize();
        palette.open();
        type(label);
        expect(drawnLabels()[0]).toBe(label);
        await palette._run(0);
    }

    test('the result string is toasted, under the name of what produced it', async () => {
        registerCommand({
            name: 'Recompute lab sims',
            hint: 'Re-run the stale rooms',
            kind: 'verb',
            run: () => '3 stale rooms queued',
        });

        await pick('Recompute lab sims');
        expect(toasts.said).toEqual(['Recompute lab sims: 3 stale rooms queued']);
        expect(toasts.kinds).toEqual(['info']);
    });

    test('an async verb is awaited rather than left running', async () => {
        let settled = false;
        registerCommand({
            name: 'Snapshot briefing now',
            hint: '',
            kind: 'verb',
            run: async () => {
                await Promise.resolve();
                settled = true;
                return 'snapshot written';
            },
        });

        await pick('Snapshot briefing now');
        expect(settled).toBe(true);
        expect(toasts.said).toEqual(['Snapshot briefing now: snapshot written']);
    });

    test('a verb that throws says so on screen, not only in the console', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        registerCommand({
            name: 'Export trial JSON',
            hint: '',
            kind: 'verb',
            run: () => {
                throw new Error('the store would not open');
            },
        });

        await pick('Export trial JSON');
        expect(toasts.said).toEqual(['Export trial JSON failed: the store would not open']);
        expect(toasts.kinds).toEqual(['error']);
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    test('a rejected promise is the same failure as a thrown one', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        registerCommand({
            name: 'Refresh watchlist prices',
            hint: '',
            kind: 'verb',
            run: async () => {
                throw new Error('the price pool did not answer');
            },
        });

        await pick('Refresh watchlist prices');
        expect(toasts.kinds).toEqual(['error']);
        expect(toasts.said[0]).toBe('Refresh watchlist prices failed: the price pool did not answer');
        logged.mockRestore();
    });

    test('a verb with nothing to do is still listed, and still reports', async () => {
        // The whole point of a string rather than a boolean: a command you can
        // only find on the days it would have worked is one you cannot learn
        registerCommand({ name: 'Recompute lab sims', hint: '', kind: 'verb', run: () => 'nothing stale' });

        palette.initialize();
        palette.open();
        expect(drawnLabels()).toContain('Recompute lab sims');

        await palette._run(drawnLabels().indexOf('Recompute lab sims'));
        expect(toasts.said).toEqual(['Recompute lab sims: nothing stale']);
    });

    test('the palette is closed before the verb is awaited', async () => {
        let openWhileRunning = null;
        registerCommand({
            name: 'Start trial capture',
            hint: '',
            kind: 'verb',
            run: async () => {
                openWhileRunning = palette.isOpen;
                return 'capture started';
            },
        });

        await pick('Start trial capture');
        expect(openWhileRunning).toBe(false);
    });

    test('a panel keeps the old behaviour — not awaited, and no toast', async () => {
        registerCommand({ name: 'Overlay', hint: '', run: () => overlay.toggle() });

        await pick('Overlay');
        expect(overlay.toggle).toHaveBeenCalled();
        expect(toasts.said).toEqual([]);
    });

    test('a verb reads as an Action, not as a Panel', () => {
        registerCommand({ name: 'Snapshot briefing now', hint: '', kind: 'verb', run: () => 'snapshot written' });

        palette.initialize();
        palette.open();
        type('snapshot briefing');
        const row = document.querySelector('[data-command-label="Snapshot briefing now"]');
        expect(row.textContent).toContain('Action');
    });
});

describe('verbResult', () => {
    test('the name is prefixed so a toast still makes sense a moment later', () => {
        expect(verbResult('Recompute lab sims', '3 stale rooms queued')).toBe(
            'Recompute lab sims: 3 stale rooms queued'
        );
    });

    test('a verb that returns nothing is done, not failed', () => {
        expect(verbResult('Snapshot briefing now', undefined)).toBe('Snapshot briefing now: done');
        expect(verbResult('Snapshot briefing now', '   ')).toBe('Snapshot briefing now: done');
        expect(verbResult('Snapshot briefing now', 7)).toBe('Snapshot briefing now: done');
    });
});

describe('oneLineReason', () => {
    test('the message, and only its first line', () => {
        expect(oneLineReason(new Error('the store would not open\n    at foo (bar.js:1)'))).toBe(
            'the store would not open'
        );
    });

    test('a thrown string is a reason too', () => {
        expect(oneLineReason('no guild selected')).toBe('no guild selected');
    });

    test('something thrown with nothing to say still says something', () => {
        expect(oneLineReason(undefined)).toBe('no reason given');
        expect(oneLineReason(new Error(''))).toBe('no reason given');
    });

    test('a long reason is cut rather than allowed to push the toast apart', () => {
        const reason = oneLineReason(new Error('x'.repeat(400)));
        expect(reason.length).toBeLessThanOrEqual(120);
        expect(reason.endsWith('…')).toBe(true);
    });
});
