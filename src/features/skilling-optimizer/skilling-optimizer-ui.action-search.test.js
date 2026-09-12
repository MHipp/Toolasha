/** @vitest-environment happy-dom */
/**
 * Coverage for the action picker's search filter.
 *
 * The checklist had no way to narrow it, and its rows carried a plain `display: flex` that the
 * native page's own !important rule on a label's display could beat, packing the rows inline.
 * Both are fixed here, and they interact: filtering has to re-apply the display with
 * `setProperty(..., 'important')`, since a plain assignment drops the priority on every
 * keystroke and hands the row back to the page's rule.
 *
 * Filtering is presentation only — it must never change what is selected, and never touch the
 * All row.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => ({
    actions: [
        { hrid: '/actions/wc/tree', name: 'Tree', requiredLevel: 1, available: true, sortIndex: 1 },
        { hrid: '/actions/wc/birch', name: 'Birch Tree', requiredLevel: 10, available: true, sortIndex: 2 },
        { hrid: '/actions/wc/cedar', name: 'Cedar', requiredLevel: 20, available: true, sortIndex: 3 },
        { hrid: '/actions/wc/purpleheart', name: 'Purpleheart', requiredLevel: 90, available: false, sortIndex: 4 },
    ],
}));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', COLOR_INFO: '#38bdf8', COLOR_PROFIT: '#22c55e', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));
vi.mock('./skilling-optimizer-engine.js', () => ({
    calculateSkillPerformance: () => null,
    getSkillActionsForDisplay: () => engine.actions,
    getItemsForSlot: () => [],
    getSkillDrinkItems: () => [],
    getPlayerSkillLevel: () => 50,
    optimizeSkill: () => null,
    findOptimalTeas: () => null,
    calculateSlotUpgradeCost: () => null,
    SKILL_NAMES: ['Woodcutting'],
    SKILLING_LOCATIONS: [],
    SLOT_DISPLAY_NAMES: {},
    SKILL_TOOL_LOCATION: {},
}));
vi.mock('../../utils/tea-optimizer.js', () => ({
    scoreEquipmentSetup: () => 0,
}));
vi.mock('../../utils/house-roi.js', () => ({
    // The House Rooms board is its own module with its own tests; these files are about the
    // equipment list, and the real board would reach for a house and an action queue they
    // do not stand up.
    rankHouseRoomUpgrades: () => ({ rows: [], excluded: [], skills: [], offBoardRooms: 0 }),
    compareHouseRoiRows: () => 0,
}));
vi.mock('../../utils/loadout-scraper.js', () => ({
    buildEnhancementLevelMap: () => new Map(),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [] },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => null,
    dataManager: null,
}));

const { skillingSimulatorUI: ui } = await import('./skilling-optimizer-ui.js');

/**
 * Open the picker against a throwaway anchor button and hand back its parts.
 * @returns {{popup: HTMLElement, search: HTMLInputElement, rows: Array<HTMLElement>}}
 */
function openPicker() {
    const host = document.createElement('div');
    const anchor = document.createElement('button');
    host.appendChild(anchor);
    document.body.appendChild(host);
    ui._openActionPicker(anchor, () => 'Actions');
    const popup = ui._picker;
    return {
        popup,
        search: popup.querySelector('input[type="text"]'),
        rows: [...popup.querySelectorAll('label')],
    };
}

/**
 * @param {HTMLInputElement} search
 * @param {string} text
 */
function type(search, text) {
    search.value = text;
    search.dispatchEvent(new Event('input'));
}

beforeEach(() => {
    ui.currentSkill = 'Woodcutting';
    ui.currentLevel = 50;
    ui.selectedActionHrids = null;
    ui._closePicker();
    document.body.replaceChildren();
});

describe('action picker search', () => {
    test('every row lays out one per line, at a priority the page cannot beat', () => {
        const { rows } = openPicker();
        for (const row of rows) {
            expect(row.style.getPropertyValue('display')).toBe('flex');
            expect(row.style.getPropertyPriority('display')).toBe('important');
        }
    });

    test('lists actions in the order the engine hands them over, i.e. the game order', () => {
        const { popup } = openPicker();
        const labels = [...popup.querySelectorAll('label')].map((row) => row.textContent);
        expect(labels).toEqual(['All', 'Tree', 'Birch Tree', 'Cedar', 'Purpleheart (lv 90)']);
    });

    test('filters rows by case-insensitive name match', () => {
        const { popup, search } = openPicker();
        type(search, 'tree');

        const visible = [...popup.querySelectorAll('label')]
            .filter((row) => row.style.getPropertyValue('display') !== 'none')
            .map((row) => row.textContent);
        expect(visible).toEqual(['All', 'Tree', 'Birch Tree']);
    });

    test('a level-locked action is filtered on its name, not its level suffix', () => {
        const { popup, search } = openPicker();
        type(search, 'purple');

        const visible = [...popup.querySelectorAll('label')]
            .filter((row) => row.style.getPropertyValue('display') !== 'none')
            .map((row) => row.textContent);
        expect(visible).toEqual(['All', 'Purpleheart (lv 90)']);
    });

    test('a hidden row keeps the !important priority, so clearing the box restores the layout', () => {
        const { popup, search } = openPicker();
        type(search, 'cedar');
        const hidden = [...popup.querySelectorAll('label')].find((row) => row.textContent === 'Tree');
        expect(hidden.style.getPropertyPriority('display')).toBe('important');

        type(search, '');
        expect(hidden.style.getPropertyValue('display')).toBe('flex');
        expect(hidden.style.getPropertyPriority('display')).toBe('important');
    });

    test('filtering leaves the selection alone', () => {
        const { popup, search } = openPicker();
        const cedarRow = [...popup.querySelectorAll('label')].find((row) => row.textContent === 'Cedar');
        cedarRow.querySelector('input[type="checkbox"]').checked = false;
        cedarRow.querySelector('input[type="checkbox"]').dispatchEvent(new Event('change'));
        const selectedBefore = new Set(ui.selectedActionHrids);

        type(search, 'tree');
        type(search, '');

        expect(new Set(ui.selectedActionHrids)).toEqual(selectedBefore);
    });

    test('the All row is never filtered away', () => {
        const { popup, search } = openPicker();
        type(search, 'zzz-no-such-action');

        const allRow = [...popup.querySelectorAll('label')].find((row) => row.textContent === 'All');
        expect(allRow.style.getPropertyValue('display')).toBe('flex');
    });
});
