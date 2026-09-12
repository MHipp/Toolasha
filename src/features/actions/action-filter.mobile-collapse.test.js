/** @vitest-environment happy-dom */

/**
 * Mobile mode collapses the sort/pricing-mode/craft/refresh row behind one
 * compact toggle, on the same row as the filter input, instead of the three
 * full-width rows the toolbar used to take above the action list. Desktop is
 * untouched: no wrapper, no toggle, the four buttons attach straight to the
 * title bar exactly as before.
 *
 * The open/closed state is device-local (`toolasha_local_` prefix — see
 * `DEVICE_LOCAL_KEY_PREFIXES` in core/settings-storage.js) so a phone and a
 * desktop never fight over one synced value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    device: { mobile: false },
    storageData: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#abc',
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        setSetting: (key, value) => {
            mocks.settings[key] = value;
        },
        setSettingValue: (key, value) => {
            mocks.settings[key] = value;
        },
        getPricingModeLabel: (mode) => mode,
        onSettingChange: vi.fn(() => () => {}),
        onSettingsLoaded: vi.fn(() => () => {}),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn(() => () => {}) },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) =>
            Object.hasOwn(mocks.storageData, key) ? mocks.storageData[key] : fallback,
        set: async (key, value) => {
            mocks.storageData[key] = value;
            return true;
        },
    },
}));

vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => mocks.device.mobile,
    hasCoarsePointer: () => mocks.device.mobile,
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { fetch: vi.fn(async () => true) },
}));

vi.mock('./action-panel-sort.js', () => ({
    default: {
        onSortModeChange: vi.fn(() => () => {}),
        getSortMode: () => 'default',
        setSortMode: vi.fn(),
        sortPanelsByProfit: vi.fn(),
    },
}));

vi.mock('./profit-display.js', () => ({
    displayGatheringProfit: vi.fn(async () => {}),
    displayProductionProfit: vi.fn(async () => {}),
}));

const { default: actionFilter } = await import('./action-filter.js');

/**
 * Build a skill page title bar, mirroring what a filterable skill like
 * Milking renders.
 * @returns {HTMLElement} The title element the toolbar attaches to
 */
function makeTitle() {
    const title = document.createElement('h1');
    title.className = 'GatheringProductionSkillPanel_title__3VihQ';
    const nameDiv = document.createElement('div');
    nameDiv.textContent = 'Milking';
    title.appendChild(nameDiv);
    document.body.appendChild(title);
    return title;
}

/** Flush the microtask queue so a pending storage.get()/set() promise settles. */
async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

const toggle = () => document.querySelector('#mwi-action-controls-toggle');
const wrapper = () => document.querySelector('#mwi-action-controls');
const filterInput = () => document.querySelector('#mwi-action-filter');
const sortBtn = () => document.querySelector('#mwi-action-sort-toggle');
const modeBtn = () => document.querySelector('#mwi-action-profit-mode');
const craftBtn = () => document.querySelector('#mwi-action-craft-toggle');
const refreshBtn = () => document.querySelector('#mwi-action-price-refresh');

describe('ActionFilter mobile collapsible controls row', () => {
    beforeEach(async () => {
        document.body.innerHTML = '';
        mocks.settings = {
            actionPanel_showFilter: true,
            actionPanel_showSort: true,
            actionPanel_showPricingMode: true,
            actionPanel_showCraftToggle: true,
            actionPanel_showProfitPerHour_gathering: true,
            actionPanel_showProfitPerHour_production: true,
        };
        mocks.device = { mobile: false };
        mocks.storageData = {};
        await actionFilter.initialize();
    });

    afterEach(() => {
        actionFilter.cleanup();
    });

    describe('desktop mode', () => {
        it('renders exactly as before — no toggle, no wrapper, buttons attached straight to the title bar', async () => {
            mocks.device.mobile = false;
            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            expect(toggle()).toBeNull();
            expect(wrapper()).toBeNull();
            expect(filterInput()).not.toBeNull();
            expect(sortBtn()).not.toBeNull();
            expect(modeBtn()).not.toBeNull();
            expect(craftBtn()).not.toBeNull();
            expect(refreshBtn()).not.toBeNull();

            // Pin the exact DOM shape of the title bar: input, sort, mode, craft,
            // refresh, as direct siblings — nothing wrapped, nothing inserted.
            const ids = Array.from(title.children).map((el) => el.id);
            expect(ids).toEqual([
                'mwi-action-filter',
                'mwi-action-sort-toggle',
                'mwi-action-profit-mode',
                'mwi-action-craft-toggle',
                'mwi-action-price-refresh',
                '', // the skill name div
            ]);

            // Every button is visible immediately — nothing hidden pending a
            // toggle that does not exist on desktop.
            expect(sortBtn().style.display).not.toBe('none');
            expect(modeBtn().style.display).not.toBe('none');
            expect(craftBtn().style.display).not.toBe('none');
            expect(refreshBtn().style.display).not.toBe('none');
        });
    });

    describe('mobile mode', () => {
        beforeEach(() => {
            mocks.device.mobile = true;
        });

        it('hides the buttons behind a toggle by default, and the filter input stays visible and usable', async () => {
            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            expect(filterInput()).not.toBeNull();
            expect(filterInput().style.display).not.toBe('none');

            expect(toggle()).not.toBeNull();
            expect(wrapper()).not.toBeNull();
            expect(wrapper().style.display).toBe('none');
            expect(toggle().getAttribute('aria-expanded')).toBe('false');

            // The four controls are inside the wrapper, not loose on the title bar.
            expect(wrapper().contains(sortBtn())).toBe(true);
            expect(wrapper().contains(modeBtn())).toBe(true);
            expect(wrapper().contains(craftBtn())).toBe(true);
            expect(wrapper().contains(refreshBtn())).toBe(true);
        });

        it('tapping the toggle reveals the buttons, tapping again hides them', async () => {
            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            expect(wrapper().style.display).toBe('none');

            toggle().click();
            expect(wrapper().style.display).toBe('flex');
            expect(toggle().getAttribute('aria-expanded')).toBe('true');

            toggle().click();
            expect(wrapper().style.display).toBe('none');
            expect(toggle().getAttribute('aria-expanded')).toBe('false');
        });

        it('persists the toggle to the device-local key, not a synced setting', async () => {
            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            toggle().click();
            await flush();

            const keys = Object.keys(mocks.storageData);
            expect(keys.length).toBeGreaterThan(0);
            for (const key of keys) {
                expect(key.startsWith('toolasha_local_')).toBe(true);
            }
            expect(mocks.storageData['toolasha_local_actionFilterControlsExpanded']).toBe(true);
        });

        it('reads the state back from the device-local key on re-render (was left open)', async () => {
            mocks.storageData['toolasha_local_actionFilterControlsExpanded'] = true;

            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            expect(wrapper().style.display).toBe('flex');
            expect(toggle().getAttribute('aria-expanded')).toBe('true');
        });

        it('reads the state back from the device-local key on re-render (was left closed)', async () => {
            mocks.storageData['toolasha_local_actionFilterControlsExpanded'] = false;

            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            expect(wrapper().style.display).toBe('none');
            expect(toggle().getAttribute('aria-expanded')).toBe('false');
        });

        it('a character switch (cleanup) tears the toggle and wrapper down with the rest', async () => {
            const title = makeTitle();
            actionFilter.injectFilterInput(title);
            await flush();

            expect(toggle()).not.toBeNull();
            expect(wrapper()).not.toBeNull();

            actionFilter.cleanup();

            expect(toggle()).toBeNull();
            expect(wrapper()).toBeNull();
            expect(filterInput()).toBeNull();
            expect(sortBtn()).toBeNull();
        });
    });
});
