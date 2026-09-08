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

const stub = vi.hoisted(() => ({ currentCharacterId: 7, resizeThrows: false }));

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

const combatScore = (await import('./combat-score.js')).default;
const { buildScorePanel, setScoreSource, resetBuildScorePanel } = await import('./build-score-panel.js');

/**
 * A scored profile, in the shape `showScorePanel` draws.
 * @param {number} characterId - Whose profile this is
 * @param {string} [name] - The character's name
 * @returns {{profileData: Object, scoreData: Object}}
 */
function profile(characterId, name = 'Someone') {
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
        },
    };
}

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
    combatScore.currentPanel = null;
    setScoreSource(() => ({ total: 300, skillerTotal: 90 }));
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
