/** @vitest-environment happy-dom */
/**
 * A character switch runs cleanup() then initialize() again for the feature
 * (see feature-registry.js's disable/reinit cycle). lastOptimizerResult and
 * optimizerLoadout used to survive that cycle untouched:
 *
 * - lastOptimizerResult was computed against the departing character's level
 *   and item availability. _buildPanel() renders it unconditionally whenever
 *   the Optimizer tab is reopened — with no click on "Optimize" needed — so
 *   the new character's panel would show the old character's numbers.
 * - optimizerLoadout is a direct object reference into the departing
 *   character's loadout snapshots. getLoadoutSnapshot() itself already
 *   reloads a fresh, character-scoped snapshot list on switch, but nothing
 *   re-pointed this field at it, so a same-named loadout on the new
 *   character would diff against the old character's gear without any
 *   visible sign anything was wrong.
 *
 * This only needs initialize()/cleanup() to run — not the full panel build —
 * so every dependency below is a minimal stub.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));
vi.mock('./skilling-optimizer-engine.js', () => ({
    calculateSkillPerformance: () => null,
    getSkillActionsForDisplay: () => [],
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
    scoreEquipmentSetup: () => null,
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

const { skillingSimulatorUI, default: skillingOptimizer } = await import('./skilling-optimizer-ui.js');

afterEach(() => {
    skillingOptimizer.cleanup();
    document.body.replaceChildren();
});

describe('character switch: cleanup() resets character-scoped optimizer state', () => {
    test('lastOptimizerResult does not survive cleanup()', () => {
        skillingOptimizer.initialize();
        // As if "Optimize" had been clicked for the departing character
        skillingSimulatorUI.lastOptimizerResult = { slots: {}, playerLevel: 80 };

        skillingOptimizer.cleanup();

        expect(skillingSimulatorUI.lastOptimizerResult).toBeNull();
    });

    test('optimizerLoadout does not survive cleanup()', () => {
        skillingOptimizer.initialize();
        skillingSimulatorUI.optimizerLoadout = { name: 'Default', equipment: [{ itemHrid: '/items/axe' }] };

        skillingOptimizer.cleanup();

        expect(skillingSimulatorUI.optimizerLoadout).toBeNull();
    });

    test('a fresh initialize() after the switch starts with no stale result to render', () => {
        skillingOptimizer.initialize();
        skillingSimulatorUI.lastOptimizerResult = { slots: {}, playerLevel: 80 };
        skillingSimulatorUI.optimizerLoadout = { name: 'Default', equipment: [] };

        // The switch: torn down for the departing character...
        skillingOptimizer.cleanup();
        // ...and stood up again for whoever is now active
        skillingOptimizer.initialize();

        expect(skillingSimulatorUI.lastOptimizerResult).toBeNull();
        expect(skillingSimulatorUI.optimizerLoadout).toBeNull();
    });
});
