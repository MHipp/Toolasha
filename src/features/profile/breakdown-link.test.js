/**
 * @vitest-environment happy-dom
 *
 * The breakdown link, end to end.
 *
 * `combat-score.test.js` stubs the Build Score panel out, so it can only prove
 * the click reaches a `toggle()`. What a player reports is the other half: the
 * click lands, the hover states fire, and no panel appears. That failure lives
 * in the seam between the two modules, so this file wires the real panel to the
 * real profile card and asserts the panel is on the page afterwards.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stub = vi.hoisted(() => ({ currentCharacterId: 7, resizeThrows: false, ownScore: null }));

vi.mock('../../utils/floating-panel.js', () => ({
    makeDraggable: () => () => {},
    makeResizable: () => {
        // One panel shell's setup failing is what leaves a phantom behind
        if (stub.resizeThrows) throw new Error('resize handle refused to attach');
        return () => {};
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: () => {},
        getSetting: () => false,
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_ACCENT: '#5b8def',
        Z_FLOATING_PANEL: 1100,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => stub.currentCharacterId, on: () => {}, off: () => {} },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./score-calculator.js', () => ({ calculateCombatScore: () => ({}) }));
vi.mock('../combat/combat-sim-export.js', () => ({ constructExportObject: () => ({}) }));
vi.mock('../combat/milkonomy-export.js', () => ({ constructMilkonomyExport: () => ({}) }));
vi.mock('./character-card-button.js', () => ({
    handleViewCardClick: () => {},
    handleViewCardFromSnapshot: () => {},
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({ buildPlayerDTOFromProfile: () => ({}) }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ terminateWorkerPool: () => {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    clampGeometry: () => null,
    clampPanelToViewport: () => {},
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));

vi.mock('./build-score-row.js', () => ({ readOwnScore: () => stub.ownScore }));

const combatScore = (await import('./combat-score.js')).default;
const { buildScorePanel, resetBuildScorePanel } = await import('./build-score-panel.js');
const { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } =
    await import('../../utils/panel-z-index.js');

/**
 * A scored profile, in the shape `showScorePanel` draws.
 * @param {number} characterId - Whose profile this is
 * @param {string} [name] - The character's name
 * @returns {{profileData: Object, scoreData: Object}}
 */
function profile(characterId, name = 'Someone', overrides = {}) {
    return {
        profileData: { profile: { sharableCharacter: { id: characterId, name } } },
        scoreData: {
            total: 300,
            house: 50,
            ability: 100,
            equipment: 150,
            skillerTotal: 90,
            skillerEquipment: 90,
            equipmentHidden: false,
            hasEquipmentData: true,
            breakdown: { houses: [], abilities: [], equipment: [] },
            skillerBreakdown: { equipment: [] },
            ...overrides,
        },
    };
}

/** Draw a profile card and click its breakdown link */
function openBreakdownFor(characterId, name, overrides) {
    const { profileData, scoreData } = profile(characterId, name, overrides);
    combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));
    clickBreakdown();
}

/** The Build Score window's header text */
const panelTitle = () => openPanel()?.querySelector('span')?.textContent;

/** The Build Score window, if it is on the page */
const openPanel = () => document.querySelector('#toolasha-buildScore-panel');

/** Click the breakdown link on whatever profile card is on screen */
function clickBreakdown() {
    document.querySelector('#mwi-score-breakdown-link').dispatchEvent(new Event('click', { bubbles: true }));
}

beforeEach(() => {
    buildScorePanel.hide({ remember: false });
    resetBuildScorePanel();
    document.body.innerHTML = '';
    stub.currentCharacterId = 7;
    stub.resizeThrows = false;
    stub.ownScore = { total: 300, skillerTotal: 90 };
    combatScore.currentPanel = null;
    resetBuildScorePanel();
});

describe('clicking the breakdown link', () => {
    test('opens a Build Score panel that is actually on the page', () => {
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        clickBreakdown();

        expect(openPanel()).not.toBeNull();
        expect(openPanel().textContent).toContain('Build Score');
    });

    test('clicking again closes it', () => {
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        clickBreakdown();
        clickBreakdown();

        expect(openPanel()).toBeNull();
    });

    test('a panel torn off the page by something else reopens rather than silently closing', () => {
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        clickBreakdown();
        // Removed without going through hide(), so the shell still holds the
        // element it no longer has on the page
        openPanel().remove();
        clickBreakdown();

        expect(openPanel()).not.toBeNull();
    });

    test('a shell that failed to open once is not dead for the rest of the session', () => {
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        stub.resizeThrows = true;
        clickBreakdown();
        expect(openPanel()).toBeNull();

        stub.resizeThrows = false;
        clickBreakdown();

        expect(openPanel()).not.toBeNull();
    });
});

describe('the breakdown for someone else', () => {
    test("another player's profile opens their breakdown, titled with their name", () => {
        openBreakdownFor(99, 'Bartleby');

        expect(openPanel()).not.toBeNull();
        expect(panelTitle()).toBe('Build Score — Bartleby');
        expect(openPanel().textContent).toContain('300.0');
    });

    test('viewing one player then another shows the second one, not the first', () => {
        openBreakdownFor(99, 'Ada');
        expect(panelTitle()).toBe('Build Score — Ada');

        // The panel is left open, as a viewer flicking between two profiles
        // would leave it
        document.querySelector('#mwi-combat-score-panel').remove();
        combatScore.currentPanel = null;
        openBreakdownFor(101, 'Babbage', { total: 12, skillerTotal: 3 });

        expect(panelTitle()).toBe('Build Score — Babbage');
        expect(openPanel().textContent).toContain('12.0');
        expect(openPanel().textContent).not.toContain('300.0');
    });

    test('your own profile after someone else shows your numbers again', () => {
        stub.ownScore = { total: 777, skillerTotal: 11 };
        openBreakdownFor(99, 'Ada');
        expect(panelTitle()).toBe('Build Score — Ada');

        document.querySelector('#mwi-combat-score-panel').remove();
        combatScore.currentPanel = null;
        openBreakdownFor(7, 'Me');

        expect(panelTitle()).toBe('Build Score');
        expect(openPanel().textContent).toContain('777.0');
        expect(openPanel().textContent).not.toContain('300.0');
    });

    test('a profile with hidden equipment says so rather than presenting a total as fact', () => {
        openBreakdownFor(99, 'Cagey', { equipmentHidden: true, hasEquipmentData: false });

        expect(openPanel().textContent).toContain('Equipment is hidden on this profile');
    });

    test('your own profile still opens and closes on the link alone', () => {
        openBreakdownFor(7, 'Me');
        expect(panelTitle()).toBe('Build Score');

        clickBreakdown();

        expect(openPanel()).toBeNull();
    });
});

/**
 * A rival floating panel, registered and raised over everything else — the
 * session briefing panel, in the report this came from.
 * @returns {HTMLElement} The panel, already in front
 */
function panelInFront() {
    const other = document.createElement('div');
    other.style.position = 'fixed';
    other.style.zIndex = '1100';
    document.body.appendChild(other);
    registerFloatingPanel(other);
    bringPanelToFront(other);
    return other;
}

/** @returns {number} The Build Score panel's z-index */
const panelZ = () => parseInt(openPanel().style.zIndex, 10);

describe('a breakdown press on a panel the user cannot see', () => {
    test('a minimized panel is unfolded rather than put away', () => {
        openBreakdownFor(7, 'Me');
        openPanel().querySelector('.toolasha-minimize-btn').click();
        expect(openPanel().dataset.minimized).toBe('true');

        clickBreakdown();

        // Hiding here is what the report was: the panel was already folded to a
        // header strip, so redrawing or closing it both look like a dead link
        expect(openPanel()).not.toBeNull();
        expect(openPanel().dataset.minimized).toBe('false');
    });

    test('a panel buried under another is raised rather than put away', () => {
        openBreakdownFor(7, 'Me');
        const other = panelInFront();
        expect(panelZ()).toBeLessThan(parseInt(other.style.zIndex, 10));

        clickBreakdown();

        expect(openPanel()).not.toBeNull();
        expect(panelZ()).toBeGreaterThan(parseInt(other.style.zIndex, 10));

        unregisterFloatingPanel(other);
        other.remove();
    });

    test('the panel it just had to raise is not closed by that same press', () => {
        openBreakdownFor(7, 'Me');
        const other = panelInFront();

        clickBreakdown();
        expect(openPanel()).not.toBeNull();

        // ...and it is now front-most and expanded, so the next press is the
        // ordinary toggle again
        clickBreakdown();
        expect(openPanel()).toBeNull();

        unregisterFloatingPanel(other);
        other.remove();
    });

    test('a different profile re-points, redraws and raises', () => {
        openBreakdownFor(99, 'Ada');
        const other = panelInFront();
        document.querySelector('#mwi-combat-score-panel').remove();
        combatScore.currentPanel = null;

        openBreakdownFor(101, 'Babbage', { total: 12, skillerTotal: 3 });

        expect(panelTitle()).toBe('Build Score — Babbage');
        expect(openPanel().textContent).toContain('12.0');
        expect(panelZ()).toBeGreaterThan(parseInt(other.style.zIndex, 10));

        unregisterFloatingPanel(other);
        other.remove();
    });
});
