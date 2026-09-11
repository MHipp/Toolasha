/** @vitest-environment happy-dom
 *
 * Where the Lab Sim panel opens, and what its Upgrade tab offers.
 *
 * The panel used to hardcode `top:60px; right:60px` on every build and throw
 * away the result of both its resize grips, so a panel you dragged somewhere
 * useful was back in the top-right corner on the next reload. The first half of
 * this file is about the geometry store now doing that remembering.
 *
 * The second half is about the Upgrade tab, which used to be a single Mode
 * dropdown whose entries were the cross-product of "which kind of upgrade" and
 * "which fights" — with most of the cross missing. It is now a set of
 * checkboxes plus a target scope, and what is worth asserting is that the two
 * controls are actually independent and that a combination the analysis cannot
 * run is visibly unavailable rather than quietly ignored.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
// The real module — never mocked in this file, unlike combat-sim-ui.test.js,
// so a `guild shrine guild-allowed cap` test spies on individual exports
// rather than replacing the whole module.
import * as upgradeAdvisor from './upgrade-advisor.js';

const geometry = vi.hoisted(() => ({ saved: null, wasOpen: false, restoreCalls: [], saveCalls: [], openCalls: [] }));
const game = vi.hoisted(() => ({
    monsters: [],
    /** Monster hrid → room level the skip thresholds resolve to */
    skipLevels: {},
    /** Monster hrid → room level a Recommend run picked out */
    recommendedLevels: {},
    players: [],
    /** What `buildGameDataPayload` reports about the character's house */
    houseRoomDetailMap: {},
    /** The room levels every labyrinth loadout's DTO carries */
    houseRooms: {},
    /** Ability hrid → display name, for the target grid's labels */
    abilityDetailMap: {},
    /** Monster hrid → the loadout id the labyrinth has assigned it */
    loadoutByMonster: {},
    /** Loadout id → the name the game shows for it */
    loadoutNames: {},
    /** Loadout id → the abilities that loadout casts */
    loadoutAbilities: {},
    /** buffHrid → level, on every labyrinth loadout's DTO */
    guildShrineLevels: {},
    /** What `getGuildBuffDetailMap` reports */
    guildBuffDetailMap: {},
    /** What `dataManager.characterData.characterInfo` holds */
    characterInfo: null,
    /** The character's equipped labyrinth crates, or null before data loads */
    characterLabyrinth: null,
    /** Fallback crate hrids, mirroring characterData.characterSetting */
    characterSetting: null,
    /** What the Configure editor reports, or null when it has none */
    editedDTOs: null,
    /** Who is logged in; a test moves it mid-run to stage a character switch */
    characterId: 'me',
    /** Whether the opt-in "remember upgrade results" setting is on */
    rememberUpgradeResults: false,
}));
const sim = vi.hoisted(() => ({
    cancelled: 0,
    calls: [],
    onCall: null,
}));
/**
 * Every key the panel wrote, so a persisted choice can be asserted on.
 * `pending`: key → an in-flight promise a test controls, for staging a read
 * that resolves after a character switch rather than before it.
 */
const storage = vi.hoisted(() => ({ written: {}, values: {}, pending: {} }));
const rowActions = vi.hoisted(() => ({ wired: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSetting: (key) => (key === 'combatSim_rememberUpgradeResults' ? game.rememberUpgradeResults : false),
        getSettingValue: (_key, fallback) => fallback,
        setSetting: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            if (key in storage.pending) return storage.pending[key];
            return key in storage.values ? storage.values[key] : fallback;
        },
        set: async (key, value) => {
            storage.written[key] = value;
        },
        delete: async (key) => {
            delete storage.written[key];
            return true;
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: {} }),
        getItemDetails: () => null,
        getSkills: () => [],
        getInventory: () => [],
        // The scoped-storage helpers key on the character; without these the
        // panel's own restore throws before it can read anything back
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        characterItems: [],
        characterEquipment: new Map(),
        get characterData() {
            return {
                characterAbilities: [],
                characterInfo: game.characterInfo,
                characterLabyrinth: game.characterLabyrinth,
                characterSetting: game.characterSetting,
            };
        },
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

// The store itself lives in IndexedDB. What matters here is that the panel asks
// it, and hands it back what a drag or a resize produced — so the mock applies a
// geometry the way the real one does and records what it is told.
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async (panel, panelKey, min) => {
        geometry.restoreCalls.push({ panelKey, min });
        const saved = geometry.saved;
        if (!saved || !panel) return;
        if (saved.width) panel.style.width = `${saved.width}px`;
        if (saved.height) panel.style.height = `${saved.height}px`;
        if (saved.left !== undefined) {
            panel.style.left = `${saved.left}px`;
            panel.style.top = `${saved.top}px`;
            panel.style.right = 'auto';
        }
    },
    saveGeometry: async (panelKey, values) => {
        geometry.saveCalls.push({ panelKey, values });
    },
    saveOpenState: async (panelKey, open) => {
        geometry.openCalls.push({ panelKey, open });
    },
    wasOpen: async (panelKey) => (geometry.wasOpen ? panelKey === 'labSimPanel' : false),
    reopenIfLeftOpen: async (panelKey, reopen) => {
        if (geometry.wasOpen) reopen();
    },
    markPanelInteracted: () => {},
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({
        itemDetailMap: {},
        actionDetailMap: { '/actions/combat/fly': {} },
        houseRoomDetailMap: game.houseRoomDetailMap,
        abilityDetailMap: game.abilityDetailMap,
    }),
    buildAllPlayerDTOs: async () => ({ players: game.players, selfHrid: game.players[0]?.hrid }),
    getCombatZones: () => [],
    getCommunityBuffs: () => ({}),
    getLabyrinthMonsters: () => game.monsters,
    getGuildBuffDetailMap: () => game.guildBuffDetailMap,
    guildBuffMaxLevel: (detail) => {
        const levels = Object.keys(detail?.levelCosts || {}).map(Number);
        return levels.length ? Math.max(...levels) : 0;
    },
}));

vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (params) => {
        sim.calls.push(params);
        sim.onCall?.(sim.calls.length);
        return { labyAttemptCount: 100, encounters: 70, deaths: {}, simulatedTime: 3 * 3600 * 1e9 };
    },
    // The Stop buttons take the preempt-shaped path: they stop the run, not the
    // warm workers behind it
    cancelActiveSimulations: () => {
        sim.cancelled++;
    },
    cancelSimulation: () => {
        sim.cancelled++;
    },
    getMaxWorkers: () => 2,
}));

vi.mock('./sim-editor.js', () => ({
    SimEditor: class {
        isInitialized() {
            return true;
        }
        initEditor() {}
        reset() {}
        getPlayerInfo() {
            return [{ name: 'Tester' }];
        }
        getEditedDTOs() {
            return game.editedDTOs;
        }
        getSelfHrid() {
            return game.players[0]?.hrid ?? null;
        }
    },
}));

// The upgrade-row handoff buttons come from the combat sim panel, which brings
// two module-scope inventory panels with it. This file is about where the lab
// panel opens, so it borrows the vocabulary and none of the furniture.
//
// The stand-in emits a marker button per row rather than nothing, because what
// is worth asserting is that the lab table renders *whatever the shared builder
// hands it* — a button added over there (Save for this, Watch, Market) has to
// turn up here without this file being told about it.
vi.mock('./combat-sim-ui.js', () => ({
    default: {
        upgradeRowPurchase: () => null,
        upgradeRowActionsHtml: (result) =>
            `<button data-shared-action="${result?.candidate?.description || ''}">buttons</button>`,
        wireUpgradeRowActions: (container) => {
            rowActions.wired.push(container);
        },
    },
}));

// A labyrinth fight only exists for the panel when a room level resolves and a
// loadout can be built for it, so both live here and the tests choose which
// monsters have one.
//
// The skilling half of the same module is a stand-in of the real arithmetic's
// *shape* rather than its numbers: a buff array in, one metric per buff type
// out, and a clear rate and an XP award that each move with exactly one of them.
// That is enough for the thing worth asserting — that a community buff level
// reaches the room at all, and lands on the metric it belongs to.
vi.mock('../combat/labyrinth-clear-rate.js', () => ({
    // The level finder reads the skip window off this module, and a missing
    // named export makes its search window NaN — which silently searches nothing
    SKIP_THRESHOLD_RANGE: 60,
    default: {
        getLabyrinthCombatBuffs: () => [],
        getCombatSkipRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getCombatRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getRecommendedCombatRoomLevel: (hrid) => game.recommendedLevels[hrid] || 0,
        getLabyrinthLoadoutId: (monsterHrid) => game.loadoutByMonster[monsterHrid] ?? null,
        buildLabyrinthPlayerDTO: (loadoutId) => ({
            equipment: {},
            abilities: (game.loadoutAbilities[loadoutId] || []).map((ability) => ({ ...ability })),
            houseRooms: { ...game.houseRooms },
            guildShrineLevels: { ...game.guildShrineLevels },
        }),
        getPlayerEffectiveCombatLevel: () => 100,
        estimateCombatXpPerHour: () => 0,
        getTargetRoomLevel: () => 0,
        getSkillingMetricsFromOverrides: (_skillId, _actionTypeHrid, overrides) => {
            const fields = {
                '/buff_types/efficiency': 'efficiencyBonus',
                '/buff_types/action_speed': 'actionSpeedBonus',
                '/buff_types/gathering': 'gatheringBonus',
                '/buff_types/wisdom': 'experienceBonus',
            };
            const metrics = {
                skillLevelBonus: 0,
                efficiencyBonus: 0,
                actionSpeedBonus: 0,
                successBonus: 0,
                doubleProgressBonus: 0,
                gatheringBonus: 0,
                experienceBonus: 0,
            };
            const sources = [
                overrides?.equipmentBuffs,
                overrides?.communityBuffs,
                overrides?.houseBuffs,
                overrides?.crateBuffs,
            ];
            for (const buffs of sources) {
                for (const buff of buffs || []) {
                    const field = fields[buff?.typeHrid];
                    if (field) metrics[field] += (buff.flatBoost || 0) + (buff.ratioBoost || 0);
                }
            }
            return metrics;
        },
        computeSkillingClearWithParams: (metrics, baseLevel, roomLevel) => ({
            clearChance: Math.min(1, 0.5 + metrics.efficiencyBonus + metrics.gatheringBonus),
            xpPerRoom: roomLevel * 50 * (1 + metrics.experienceBonus),
            baseLevel,
            effectiveLevel: baseLevel,
            successChance: 0.8,
            attempts: 10,
        }),
        computeEnhancingClearWithParams: (metrics, baseLevel, roomLevel) => ({
            clearChance: Math.min(1, 0.5 + metrics.actionSpeedBonus),
            xpPerRoom: roomLevel * 50 * (1 + metrics.experienceBonus),
            baseLevel,
            effectiveLevel: baseLevel,
            successChance: 0.8,
            attempts: 10,
        }),
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        get: () => null,
        get snapshots() {
            return Object.fromEntries(Object.entries(game.loadoutNames).map(([id, name]) => [id, { name }]));
        },
        // Every named loadout, tagged with the action type the Skilling tab
        // filters them by — the shape the loadout table reads
        getAllSnapshots: () =>
            Object.values(game.loadoutNames).map((name) => ({ name, actionTypeHrid: '/action_types/woodcutting' })),
    },
}));

const { default: ui, describeAllFightsPlan, describeArchetypes } = await import('./lab-sim-ui.js');
const { estimateLabUpgradeSims } = await import('./lab-sim-upgrade-modes.js');

/** A pointer event happy-dom will hand to the drag helper's listeners. */
function pointer(type, x, y) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0 });
    return event;
}

/**
 * Let the panel's storage-backed restore finish before asserting on it.
 *
 * Generous rather than exact: the restore reads several keys in sequence and
 * each read is two awaits deep (scoped key, then the legacy one), so the number
 * of ticks it takes grows every time a remembered control is added. Eight was
 * enough until the signature-swap key made it nine, and the failure that caused
 * was a restore landing *after* the test body — a control quietly reset to its
 * stored value half way through an assertion.
 */
async function settle() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('the Lab Sim panel remembers where it was left', () => {
    beforeEach(() => {
        geometry.saved = null;
        geometry.wasOpen = false;
        geometry.restoreCalls = [];
        geometry.saveCalls = [];
        geometry.openCalls = [];
        game.monsters = [];
        game.skipLevels = {};
    });

    afterEach(() => {
        ui.destroy();
    });

    test('with nothing saved it opens at its designed corner', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.right).toBe('60px');
        expect(ui.panel.style.top).toBe('60px');
        // The viewport-clamped `min(900px, 96vw)` from the stylesheet still
        // governs the size — nothing has overwritten it with a pixel figure
        expect(ui.panel.style.width).not.toMatch(/px/);
    });

    test('a saved geometry wins over the corner it would otherwise open at', async () => {
        geometry.saved = { left: 120, top: 40, width: 640, height: 480 };

        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.left).toBe('120px');
        expect(ui.panel.style.top).toBe('40px');
        expect(ui.panel.style.width).toBe('640px');
        expect(ui.panel.style.height).toBe('480px');
        // Anchoring by the left edge from here on, or a window resize moves it
        expect(ui.panel.style.right).toBe('auto');
    });

    test('it asks the store under its own key, with its own floor size', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(geometry.restoreCalls[0]).toMatchObject({
            panelKey: 'labSimPanel',
            min: { width: 400, height: 300 },
        });
    });

    test('dropping it somewhere writes that somewhere down', async () => {
        ui.buildPanel();
        await Promise.resolve();

        const header = ui.panel.firstChild;
        header.dispatchEvent(pointer('pointerdown', 200, 100));
        document.dispatchEvent(pointer('pointermove', 260, 180));
        document.dispatchEvent(pointer('pointerup', 260, 180));

        expect(geometry.saveCalls).toHaveLength(1);
        expect(geometry.saveCalls[0].panelKey).toBe('labSimPanel');
        expect(geometry.saveCalls[0].values).toMatchObject({ left: 60, top: 80 });
    });

    test('a click on the header that never moved is not a move worth saving', async () => {
        ui.buildPanel();
        await Promise.resolve();

        const header = ui.panel.firstChild;
        header.dispatchEvent(pointer('pointerdown', 200, 100));
        document.dispatchEvent(pointer('pointerup', 200, 100));

        expect(geometry.saveCalls).toHaveLength(0);
    });

    test('a panel left closed stays closed on the next load', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.display).toBe('none');
    });

    test('but a panel left open comes back up', async () => {
        // A refresh mid-analysis used to lose the panel entirely, which is what
        // reversed the original "a simulator opens when asked" choice
        geometry.wasOpen = true;

        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.display).toBe('flex');
        // Restoring a panel is not itself an opening worth recording
        expect(geometry.openCalls).toEqual([]);
    });

    test('opening and closing it by hand is what gets remembered', async () => {
        ui.buildPanel();
        await Promise.resolve();

        ui.toggle();
        ui.toggle();

        expect(geometry.openCalls).toEqual([
            { panelKey: 'labSimPanel', open: true },
            { panelKey: 'labSimPanel', open: false },
        ]);
    });
});

describe('the Upgrade tab asks two questions instead of one', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [
            { hrid: '/monsters/gobo_chief', name: 'Gobo Chief' },
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/gobo_chief': 110, '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
    });

    afterEach(() => {
        ui.destroy();
    });

    const boxes = () => [...ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')];
    const box = (key) => ui.panel.querySelector(`[data-lab-upgrade-dimension="${key}"]`);
    const scope = () => ui.panel.querySelector('#mwi-labsim-upgrade-scope');

    const setScope = (value) => {
        scope().value = value;
        scope().dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const check = (key, checked) => {
        box(key).checked = checked;
        box(key).dispatchEvent(new window.Event('change', { bubbles: true }));
    };

    test('the single Mode dropdown is gone, replaced by one checkbox per candidate set', () => {
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-mode')).toBeNull();
        expect(boxes().map((b) => b.getAttribute('data-lab-upgrade-dimension'))).toEqual([
            'equipment',
            'ability_level',
            'ability_swap',
            'house',
            'labyrinth_buff',
            'community_buff',
            'combat_level',
            'guild_shrine',
        ]);
    });

    test('several sets can be checked at once', () => {
        check('ability_level', true);
        check('guild_shrine', true);
        // Token Buffs opens checked, so it is in every selection that has not
        // been asked to leave it out
        expect(ui._getUpgradeDimensions()).toEqual(['equipment', 'ability_level', 'labyrinth_buff', 'guild_shrine']);
    });

    test('the target scope is its own control, with all targets among the options', () => {
        expect([...scope().options].map((o) => o.value)).toEqual(['current', 'all', 'selected']);
        // Opens where the old dropdown opened: the Configure tab's fight
        expect(scope().value).toBe('current');
    });

    test('choosing a subset lists every fight that resolves to a room level', () => {
        setScope('selected');

        const list = ui.panel.querySelector('#mwi-labsim-target-list');
        expect(list.style.display).toBe('flex');
        expect([...list.querySelectorAll('[data-lab-target]')].map((b) => b.getAttribute('data-lab-target'))).toEqual([
            '/monsters/gobo_chief',
            '/monsters/mimic',
            '/monsters/eye_watcher',
        ]);
        expect(list.textContent).toContain('Gobo Chief');
        expect(list.textContent).toContain('L130');
    });

    test('a fight with no resolvable room level is not offered as a target', () => {
        game.skipLevels = { '/monsters/mimic': 130 };
        ui._populateUpgradeTargets();

        const offered = [...ui.panel.querySelectorAll('[data-lab-target]')].map((b) =>
            b.getAttribute('data-lab-target')
        );
        expect(offered).toEqual(['/monsters/mimic']);
    });

    test('the subset picker only shows for the subset scope', () => {
        setScope('all');
        expect(ui.panel.querySelector('#mwi-labsim-target-list').style.display).toBe('none');
        setScope('selected');
        expect(ui.panel.querySelector('#mwi-labsim-target-list').style.display).toBe('flex');
    });

    test('the skip-level rule only appears once the labyrinth fight list is in play', () => {
        const label = ui.panel.querySelector('#mwi-labsim-allfights-useskip-label');
        expect(label.style.display).toBe('none');
        setScope('all');
        expect(label.style.display).toBe('flex');
    });

    test('scope and sets are independent — the old exclusive "— All Fights" modes are gone', () => {
        check('equipment', true);
        check('labyrinth_buff', false);
        check('guild_shrine', true);
        setScope('all');

        const plan = ui._planFromControls();
        expect(plan).toMatchObject({ kind: 'allFights', modes: ['equipment', 'guild_shrine'] });
        expect(plan.monsterHrids).toHaveLength(3);
    });

    test('a subset of the fights runs only those fights', () => {
        setScope('selected');
        const mimic = ui.panel.querySelector('[data-lab-target="/monsters/mimic"]');
        mimic.checked = true;
        mimic.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(ui._planFromControls()).toMatchObject({ kind: 'allFights', monsterHrids: ['/monsters/mimic'] });
    });

    test('ability swaps are offered across several fights, with no refusal left on the label', () => {
        // They used to be disabled here, on the grounds that a hundred-odd
        // candidates times a labyrinth is thousands of sims. The size is now
        // handled by shortening each sim and saying the count up front.
        setScope('all');

        expect(box('ability_swap').disabled).toBe(false);
        const label = ui.panel.querySelector('[data-lab-mode-label="ability_swap"]');
        expect(label.title).not.toMatch(/single target|one fight at a time/);
        expect(ui.panel.querySelector('[data-lab-mode-chip="ability_swap"]').style.opacity).toBe('1');
    });

    test('and they reach the multi-fight analysis instead of being dropped from the plan', () => {
        check('ability_swap', true);
        check('labyrinth_buff', false);
        setScope('all');

        expect(ui._planFromControls()).toMatchObject({
            kind: 'allFights',
            modes: ['equipment', 'ability_swap'],
            dropped: [],
        });
    });

    test('the Crit Aura switch is gone, superseded by the guide-based aura swaps', () => {
        // It was a hand-built one-off candidate for one ability. Ability Swaps
        // now offers whichever aura the loadout's archetype actually calls for,
        // both sides of the OR, ranked with everything else and priced the same
        expect(ui.panel.querySelector('#mwi-labsim-crit-aura')).toBeNull();
        expect(ui.panel.querySelector('#mwi-labsim-crit-aura-label')).toBeNull();
    });

    test('Aura only sits inside the Ability Swaps chip and hides with it', () => {
        const group = ui.panel.querySelector('[data-lab-mode-options="ability_swap"]');
        expect(ui.panel.querySelector('[data-lab-mode-chip="ability_swap"]').contains(group)).toBe(true);

        check('ability_swap', false);
        expect(group.style.display).toBe('none');
        check('ability_swap', true);
        expect(group.style.display).toBe('inline-flex');
    });

    test('and means nothing while Ability Swaps is unchecked', () => {
        ui.panel.querySelector('#mwi-labsim-swap-aura-only').checked = true;
        check('ability_swap', false);
        expect(ui._getAuraSwapsOnly()).toBe(false);

        check('ability_swap', true);
        expect(ui._getAuraSwapsOnly()).toBe(true);
    });

    test('the choice is written down like its neighbours, box state and all', async () => {
        check('ability_swap', true);
        const signature = ui.panel.querySelector('#mwi-labsim-swap-aura-only');
        signature.checked = true;
        signature.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(storage.written['labSimSwapAuraOnly_me']).toBe(true);

        // Unchecking the set must not save a false over the tick — it would be
        // lost the moment Ability Swaps was checked again
        check('ability_swap', false);
        await settle();
        expect(storage.written['labSimSwapAuraOnly_me']).toBe(true);
    });

    test('the size of a swap run across every fight is said before it starts', () => {
        check('ability_swap', true);
        setScope('all');

        const estimate = estimateLabUpgradeSims(ui._getUpgradeDimensions(), ui._upgradeTargetCount());
        // The count and the fights it covers, before the first simulation and
        // while Stop still costs nothing. Not flagged heavy any more: the build
        // guide narrowed swaps from every style-compatible ability to one
        // archetype's set, which is what took this run under the warning bar
        expect(estimate.heavy).toBe(false);
        expect(estimate.text).toMatch(/about [\d,]+ simulations \(3 fights\)/);
    });

    test('and what the analysis actually planned replaces the estimate', () => {
        const text = describeAllFightsPlan({
            candidates: 284,
            fights: 12,
            sims: 1043,
            requestedHours: 10,
            trialScale: 0.48,
            reduced: true,
        });

        expect(text).toContain('284 upgrades across 12 fights');
        expect(text).toContain('1,043 simulations');
        // Bounded trials, never sampled fights — the sentence has to say which
        expect(text).toContain('48% of the 10h');
        expect(text).toContain('every fight is still simulated');
    });

    test('a run small enough to leave the trials alone does not claim it shortened them', () => {
        const text = describeAllFightsPlan({
            candidates: 30,
            fights: 3,
            sims: 64,
            requestedHours: 10,
            trialScale: 1,
            reduced: false,
        });

        expect(text).toContain('64 simulations');
        expect(text).not.toContain('%');
    });

    test('the finished run says which loadout resolved to which archetype', () => {
        // Pooling merges everything into one table, so without this nothing says
        // which loadouts got the guide's narrow question and which fell back to
        // being offered every ability in the game
        const text = describeArchetypes([
            { loadoutName: 'Fire Lab', archetype: 'fire', label: 'Fire' },
            { loadoutName: 'Wark Lab', archetype: 'wark', label: 'Wark' },
            { loadoutName: 'Old Setup', archetype: null, label: null },
        ]);

        expect(text).toContain('Fire Lab → Fire');
        expect(text).toContain('Wark Lab → Wark');
        expect(text).toContain('Old Setup → no archetype (all abilities offered)');
    });

    test('and says nothing at all when swaps were not part of the run', () => {
        expect(describeArchetypes([])).toBe('');
        expect(describeArchetypes(null)).toBe('');
    });

    test('an archetype with no label still names itself rather than going blank', () => {
        expect(describeArchetypes([{ loadoutName: 'Lab', archetype: 'wark', label: null }])).toContain('Lab → wark');
    });

    test('the per-ability Target Lv rule is disabled where it cannot be honoured', () => {
        const levelType = ui.panel.querySelector('#mwi-labsim-upgrade-level-type');
        check('ability_level', true);
        expect(levelType.disabled).toBe(false);

        setScope('all');

        expect(levelType.disabled).toBe(true);
        expect(levelType.value).toBe('increment');
        expect(levelType.title).toMatch(/uniform/);
    });

    test('the options for a set only show while that set is checked', () => {
        const levelGroup = ui.panel.querySelector('#mwi-labsim-upgrade-level-group');
        expect(levelGroup.style.display).toBe('none');
        check('ability_level', true);
        expect(levelGroup.style.display).toBe('inline-flex');
        check('ability_level', false);
        expect(levelGroup.style.display).toBe('none');
    });

    test('combat levels borrow the boost box, and get a number to work with', () => {
        const levelGroup = ui.panel.querySelector('#mwi-labsim-upgrade-level-group');
        const levelInput = ui.panel.querySelector('#mwi-labsim-upgrade-target-level');
        levelInput.value = '';

        check('combat_level', true);

        expect(levelGroup.style.display).toBe('inline-flex');
        expect(levelInput.value).toBe('5');
    });

    test('nothing checked is refused rather than run empty', () => {
        for (const b of boxes()) if (b.checked) check(b.getAttribute('data-lab-upgrade-dimension'), false);
        expect(ui._planFromControls().kind).toBe('none');
    });

    test('house rooms are offered for every scope now, not just the Configure fight', () => {
        for (const value of ['current', 'all', 'selected']) {
            setScope(value);
            expect(box('house').disabled).toBe(false);
            expect(ui.panel.querySelector('[data-lab-mode-chip="house"]').style.opacity).toBe('1');
        }
    });

    test('and a whole-run selection carries them into the analysis rather than dropping them', () => {
        check('equipment', false);
        check('labyrinth_buff', false);
        check('house', true);
        setScope('all');

        expect(ui._planFromControls()).toMatchObject({ kind: 'allFights', modes: ['house'], dropped: [] });
    });

    test('token buffs ride into a whole run beside them, out of the same checkbox row', () => {
        check('equipment', false);
        check('house', true);
        setScope('all');

        expect(ui._planFromControls()).toMatchObject({
            kind: 'allFights',
            modes: ['house', 'labyrinth_buff'],
            dropped: [],
        });
    });

    test('community buffs are the one set a whole run refuses, and the label says why', () => {
        setScope('all');
        expect(box('community_buff').disabled).toBe(true);
        expect(ui.panel.querySelector('[data-lab-mode-label="community_buff"]').title).toMatch(/expected attempts/);
        expect(ui.panel.querySelector('[data-lab-mode-chip="community_buff"]').style.opacity).toBe('0.45');

        // …and the refusal does not follow the set back to the scope where it
        // is offered
        setScope('current');
        expect(box('community_buff').disabled).toBe(false);
        expect(ui.panel.querySelector('[data-lab-mode-label="community_buff"]').title).toMatch(
            /^The server-wide community buffs/
        );
    });
});

/**
 * The one thing about a house room that used to be silently wrong.
 *
 * A room level is not held in a loadout, and the applier both labyrinth
 * analyses build each candidate's character with had no branch for one — so a
 * house candidate was installed as a piece of equipment in a slot named after
 * the room, the simulation ran the *unchanged* character, and the row came back
 * a confident +0.00%. The panel worked around it with a pass of its own, which
 * is why the dimension was Configure-fight only.
 *
 * The branch exists, the workaround is gone, and what is worth asserting is the
 * thing the workaround existed to guarantee: that the raised level reaches the
 * character the simulation is handed — through the shared path, in both scopes.
 * The advisor is deliberately *not* mocked here; only the simulator is.
 */
describe('a house room level reaches the character the simulation is handed', () => {
    const DAIRY = '/house_rooms/dairy_barn';
    const GARDEN = '/house_rooms/garden';

    const houseRoomsSimmed = () => sim.calls.map((call) => call.playerDTOs[0].houseRooms);

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        sim.calls = [];
        game.monsters = [
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
        game.houseRooms = { [DAIRY]: 4, [GARDEN]: 2 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: { ...game.houseRooms } }];
        // Two rooms the combat engine reads, so both are candidates
        game.houseRoomDetailMap = {
            [DAIRY]: { name: 'Dairy Barn', actionBuffs: [{ typeHrid: '/buff_types/armor' }] },
            [GARDEN]: { name: 'Garden', actionBuffs: [{ typeHrid: '/buff_types/damage' }] },
            // A skilling-only room, which must never appear
            '/house_rooms/brewery': { name: 'Brewery', actionBuffs: [{ typeHrid: '/buff_types/efficiency' }] },
        };

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        // After the restore rather than before it, or the restore's own default
        // lands last. This suite is about the room, not the level it is fought at.
        await ui._restoreUpgradeSelection();
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
    });

    afterEach(() => {
        game.houseRooms = {};
        game.houseRoomDetailMap = {};
        game.players = [];
        ui.destroy();
    });

    const checkOnlyHouse = () => {
        for (const b of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            b.checked = b.getAttribute('data-lab-upgrade-dimension') === 'house';
            b.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
    };

    test('the Configure fight sims each room one level up, and nothing else moved', async () => {
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        // A baseline plus one run per combat-relevant room
        expect(sim.calls).toHaveLength(3);
        expect(houseRoomsSimmed()[0]).toEqual({ [DAIRY]: 4, [GARDEN]: 2 });
        expect(houseRoomsSimmed()).toContainEqual({ [DAIRY]: 5, [GARDEN]: 2 });
        expect(houseRoomsSimmed()).toContainEqual({ [DAIRY]: 4, [GARDEN]: 3 });
        // The Brewery buffs a skill, not a fight
        expect(JSON.stringify(houseRoomsSimmed())).not.toContain('brewery');
    });

    test('a second click landing before the editor resolves does not start a concurrent run', async () => {
        // Regression: the Run button is not hidden until after `await
        // buildAllPlayerDTOs()` resolves (reached here because game.editedDTOs
        // is unset), so a second call landing in that window used to start a
        // fully independent second analysis — sharing _upgradeAborted with the
        // first and racing it to write resultsEl/saveUpgradeResults.
        checkOnlyHouse();

        const first = ui._onUpgradeAnalyze();
        const second = ui._onUpgradeAnalyze();
        await Promise.all([first, second]);

        // One baseline plus one run per combat-relevant room — not doubled
        expect(sim.calls).toHaveLength(3);
    });

    test('Stop terminates the workers, not just the loop between sims', () => {
        // The analysis polls its abort flag BETWEEN simulations, so setting the
        // flag alone ends nothing already running. With Uncapped ticked the
        // in-flight sim has a million-hour budget and no trial cap, so Stop
        // appeared dead: it had been honoured, and was waiting on a sim that was
        // never going to finish. The Single Sim and Skilling Stop buttons have
        // always terminated the running workers; this one did not.
        sim.cancelled = 0;

        ui.panel.querySelector('#mwi-labsim-upgrade-stop').dispatchEvent(new Event('click'));

        expect(ui._upgradeAborted).toBe(true);
        expect(sim.cancelled, 'Stop must terminate the running workers').toBe(1);
    });

    test('an analysis finishing after a character switch does not overwrite the arriving character’s remembered run', async () => {
        // The analysis runs for minutes. The remembered set is per character
        // and has no undo, so a run filed under whoever arrived mid-analysis
        // deletes the analysis they were keeping.
        game.rememberUpgradeResults = true;
        checkOnlyHouse();
        sim.onCall = (n) => {
            if (n === 1) game.characterId = 'alt';
        };
        try {
            await ui._onUpgradeAnalyze();
        } finally {
            sim.onCall = null;
            game.characterId = 'me';
            game.rememberUpgradeResults = false;
        }

        expect(storage.written['labSimUpgradeResults-fullkit_alt']).toBeUndefined();
    });

    test('an analysis that stays on one character still remembers its run', async () => {
        // The other half of the guard: it must refuse the switch and nothing else
        game.rememberUpgradeResults = true;
        checkOnlyHouse();
        try {
            await ui._onUpgradeAnalyze();
        } finally {
            game.rememberUpgradeResults = false;
        }

        expect(storage.written['labSimUpgradeResults-fullkit_me']).toBeTruthy();
    });

    test('the panel’s own character is never the one that gets the level', async () => {
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        expect(game.players[0].houseRooms).toEqual({ [DAIRY]: 4, [GARDEN]: 2 });
    });

    test('across every fight the same room level is installed into each of them', async () => {
        checkOnlyHouse();
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = 'all';
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));

        await ui._onUpgradeAnalyze();

        // Two fights' baselines, then each room against each fight — a room
        // level is the character's, so every fight is one it reaches
        const raised = houseRoomsSimmed().filter((rooms) => rooms[DAIRY] === 5);
        expect(raised).toHaveLength(2);
        const levels = sim.calls.filter((call) => call.playerDTOs[0].houseRooms[DAIRY] === 5).map((c) => c.roomLevel);
        expect(levels.sort()).toEqual([130, 150]);
    });

    test('a skilling room stays out even when it carries the global buffs every room grants', async () => {
        // The real game gives every room a global wisdom and rare-find buff, and
        // both are buff types the combat engine reads — which is how the ten
        // skilling rooms ended up in a table that ranks nothing but win rate
        game.houseRoomDetailMap['/house_rooms/brewery'] = {
            name: 'Brewery',
            globalBuffs: [{ typeHrid: '/buff_types/wisdom' }, { typeHrid: '/buff_types/rare_find' }],
            actionBuffs: [{ typeHrid: '/buff_types/efficiency' }],
        };
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        expect(JSON.stringify(houseRoomsSimmed())).not.toContain('brewery');
    });

    test('the Lv box buys several levels in one row instead of stepping one at a time', async () => {
        checkOnlyHouse();
        ui.panel.querySelector('#mwi-labsim-house-target-level').value = '7';

        await ui._onUpgradeAnalyze();

        expect(houseRoomsSimmed()).toContainEqual({ [DAIRY]: 7, [GARDEN]: 2 });
        expect(houseRoomsSimmed()).toContainEqual({ [DAIRY]: 4, [GARDEN]: 7 });
    });

    test('and the per-room Targets grid only offers the rooms this table can rank', () => {
        game.houseRoomDetailMap['/house_rooms/brewery'] = {
            name: 'Brewery',
            globalBuffs: [{ typeHrid: '/buff_types/wisdom' }],
        };
        ui._buildLabHouseTargets();

        const offered = [...ui.panel.querySelectorAll('[data-lab-house-target]')].map(
            (input) => input.dataset.labHouseTarget
        );
        expect(offered.sort()).toEqual([DAIRY, GARDEN]);
    });

    test('a house with every combat room maxed says so rather than reading as no upgrades', async () => {
        game.houseRooms = { [DAIRY]: 8, [GARDEN]: 8 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: { ...game.houseRooms } }];
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        expect(ui.panel.querySelector('#mwi-labsim-status').textContent).toMatch(
            /all 2 combat house rooms are already maxed/
        );
    });
});

/**
 * Which level the Configure fight is analysed at.
 *
 * It used to be the Configure tab's Level box and nothing else, which meant the
 * most-used analysis in the panel ran at 100 — the number the box opens on, and
 * the one number in it that carries no intent. The source is now a choice with
 * the level it comes to shown beside it.
 */
describe('the Configure fight is analysed at a level that was chosen', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        sim.calls = [];
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = { '/monsters/mimic': 130 };
        game.recommendedLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];
        game.houseRoomDetailMap = {};

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._restoreUpgradeSelection();
        ui._maxLevelByMonster = {};
        storage.written = {};
    });

    afterEach(() => {
        game.recommendedLevels = {};
        game.players = [];
        ui._maxLevelByMonster = {};
        ui.destroy();
    });

    const source = () => ui.panel.querySelector('#mwi-labsim-level-source');
    const setSource = (value) => {
        source().value = value;
        source().dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const setScope = (value) => {
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = value;
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const readout = () => ui.panel.querySelector('#mwi-labsim-level-source-resolved').textContent;

    test('a switch mid-save does not split one selection across two characters', async () => {
        // Each key used to be resolved after the previous write's await, and a
        // non-immediate `storage.set` resolves only when its debounce fires —
        // long enough for a switch to land between two of them and leave the
        // arriving character holding half of the departing character's
        // selection, a combination neither of them ever chose.
        setScope('all');
        storage.written = {};
        const saving = ui._saveUpgradeSelection();
        game.characterId = 'alt';
        try {
            await saving;
        } finally {
            game.characterId = 'me';
        }

        expect(Object.keys(storage.written).sort()).toEqual([
            'labSimShrineCapToGuild_me',
            'labSimSwapAuraOnly_me',
            'labSimUpgradeDimensions_me',
            'labSimUpgradeLevelSource_me',
            'labSimUpgradeRoomLevels_me',
            'labSimUpgradeScope_me',
            'labSimUpgradeTargetFloor_me',
        ]);
    });

    test('a switch mid-restore does not restore half of one character over half of another', async () => {
        storage.values = {
            labSimUpgradeScope_me: { mode: 'all', monsters: [] },
            labSimUpgradeLevelSource_me: 'skip',
            labSimUpgradeScope_alt: { mode: 'current', monsters: [] },
            labSimUpgradeLevelSource_alt: 'configure',
        };
        try {
            const restoring = ui._restoreUpgradeSelection();
            game.characterId = 'alt';
            await restoring;
        } finally {
            game.characterId = 'me';
            storage.values = {};
        }

        // Both halves are this character's, not one of each
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-scope').value).toBe('all');
        expect(source().value).toBe('skip');
    });

    test('the choice sits beside Targets, with all three levels a fight has', () => {
        expect([...source().options].map((o) => o.value)).toEqual(['sim_max', 'skip', 'configure']);
        expect(source().closest('#mwi-labsim-upgrade-scope')).toBeNull();
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-scope').parentElement).toBe(
            source().closest('label').parentElement
        );
    });

    test('and only for the scope it means anything to', () => {
        const label = ui.panel.querySelector('#mwi-labsim-level-source-label');
        expect(label.style.display).toBe('inline-flex');
        setScope('all');
        expect(label.style.display).toBe('none');
        setScope('current');
        expect(label.style.display).toBe('inline-flex');
    });

    test('a Level box left on its default means Sim max — nobody asked for 100', async () => {
        await ui._restoreUpgradeSelection();
        expect(source().value).toBe('sim_max');
    });

    test('a Level box that was typed into means the number that was typed', async () => {
        ui.panel.querySelector('#mwi-labsim-level').value = '232';
        await ui._restoreUpgradeSelection();
        expect(source().value).toBe('configure');
    });

    test('the resolved level is on screen before Analyze is pressed', () => {
        setSource('skip');
        expect(readout()).toBe('= L130');
        expect(ui.panel.querySelector('#mwi-labsim-level-source-resolved').title).toContain('Skip level (L130)');
    });

    test('a sim max nothing has searched for yet says so rather than a number', () => {
        setSource('sim_max');
        expect(readout()).toMatch(/not simmed yet/);
    });

    test('and reads as a level once a Find Max has produced one', () => {
        ui._maxLevelByMonster['/monsters/mimic'] = 232;
        setSource('sim_max');
        expect(readout()).toBe('= L232');
    });

    test('a Recommend result wins over the threshold currently configured', () => {
        game.recommendedLevels['/monsters/mimic'] = 141;
        setSource('skip');
        expect(readout()).toBe('= L141');
    });

    test('the analysis actually runs at the level the source resolved to', async () => {
        ui.panel.querySelector('#mwi-labsim-level').value = '100';
        setSource('skip');

        await ui._onUpgradeAnalyze();

        expect(sim.calls.length).toBeGreaterThan(0);
        for (const call of sim.calls) expect(call.roomLevel).toBe(130);
    });

    test('a cached sim max is used without searching for it again', async () => {
        ui._maxLevelByMonster['/monsters/mimic'] = 232;
        setSource('sim_max');

        await ui._onUpgradeAnalyze();

        for (const call of sim.calls) expect(call.roomLevel).toBe(232);
    });

    test('and the Configure box is still exactly what Configure value means', async () => {
        ui.panel.querySelector('#mwi-labsim-level').value = '175';
        setSource('configure');

        await ui._onUpgradeAnalyze();

        for (const call of sim.calls) expect(call.roomLevel).toBe(175);
    });

    test('a source with nothing behind it falls through rather than analysing level 0', () => {
        game.skipLevels = {};
        ui.panel.querySelector('#mwi-labsim-level').value = '150';
        setSource('skip');

        expect(readout()).toBe('= L150');
        expect(ui._resolveTargetLevel('/monsters/mimic')).toMatchObject({ usedSource: 'configure', fellBack: true });
    });

    test('the choice survives being made — it is written down like its neighbours', async () => {
        setSource('skip');
        await settle();
        expect(storage.written['labSimUpgradeLevelSource_me']).toBe('skip');
    });

    test('the Level box allows any room level the finder can hand it, down to 1', () => {
        // The labyrinth level finder's window can resolve below 20, and the
        // Configure source writes into this box programmatically — bypassing
        // the browser's own min clamp, which only applies to typing and the
        // spinner. A min of 20 was therefore never a real floor, just a
        // misleading one for anybody who did type into the box by hand.
        expect(ui.panel.querySelector('#mwi-labsim-level').min).toBe('1');
    });
});

describe('a single-target result can be read against the last one', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        ui.buildPanel();
        await settle();
        ui._switchTab('maxlevel');
    });

    afterEach(() => {
        ui.destroy();
    });

    /** Run a fixed-level fight and record it the way `_onSimulate` does. */
    const simulate = async (roomLevel, { attempts = 1000, encounters = 700, deaths = 30, ownerId = 'me' } = {}) => {
        const simResult = {
            labyAttemptCount: attempts,
            encounters,
            deaths: { p1: deaths },
            simulatedTime: 3 * 3600 * 1e9,
        };
        ui._displaySimResults(simResult, '/monsters/mimic', roomLevel, 3, Date.now(), 'p1');
        await ui._recordSingleTargetRun(simResult, {
            monsterHrid: '/monsters/mimic',
            roomLevel,
            hours: 3,
            crates: [],
            playerHrid: 'p1',
            ownerId,
        });
    };

    const comparison = () => ui.panel.querySelector('#mwi-labsim-comparison');

    test('the first run has nothing to be read against, so no table is drawn', async () => {
        await simulate(130);

        expect(ui._comparison.runs).toHaveLength(1);
        expect(comparison().textContent).toBe('');
    });

    test('the second run brings up the comparison, with the first pinned as the baseline', async () => {
        await simulate(130, { encounters: 700 });
        await simulate(130, { encounters: 820 });

        const text = comparison().textContent;
        expect(text).toContain('Comparison (2 runs)');
        expect(text).toContain('★');
        expect(ui._comparison.baselineId).toBe(ui._comparison.runs[0].id);
        // 70% → 82% is the delta the table exists to show
        expect(text).toContain('+12.00%');
    });

    test('the table survives the run after it, still measuring from the pinned baseline', async () => {
        await simulate(130, { encounters: 700 });
        await simulate(130, { encounters: 820 });
        await simulate(130, { encounters: 650 });

        const text = comparison().textContent;
        expect(text).toContain('Comparison (3 runs)');
        expect(text).toContain('+12.00%');
        expect(text).toContain('-5.00%');
    });

    test('a run can be forgotten from the table', async () => {
        await simulate(130);
        await simulate(140);
        const doomed = ui._comparison.runs[1].id;

        comparison()
            .querySelector(`[data-labsim-cmp-delete="${doomed}"]`)
            .dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        expect(ui._comparison.runs.map((e) => e.id)).not.toContain(doomed);
        // One run left is not a comparison
        expect(comparison().textContent).toBe('');
    });

    test('and the lot can be cleared at once', async () => {
        await simulate(130);
        await simulate(140);
        await simulate(150);

        comparison()
            .querySelector('#mwi-labsim-cmp-clear')
            .dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        expect(ui._comparison.runs).toEqual([]);
        expect(comparison().textContent).toBe('');
    });

    test('pinning a different baseline re-reads every row against it', async () => {
        await simulate(130, { encounters: 700 });
        await simulate(130, { encounters: 820 });

        const select = comparison().querySelector('#mwi-labsim-cmp-baseline');
        select.value = ui._comparison.runs[1].id;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(ui._comparison.baselineId).toBe(ui._comparison.runs[1].id);
        // Read the other way round now: 82% → 70% is a loss
        expect(comparison().textContent).toContain('-12.00%');
    });

    test('a run that finished after a character switch is not recorded against the arriving character', async () => {
        // The run measured the character it started under. Joining the arriving
        // character's table it reads as their own "before" and skews every
        // delta the table draws.
        await simulate(130);
        game.characterId = 'alt';
        try {
            await simulate(160);
        } finally {
            game.characterId = 'me';
        }

        // Still the main's own single run, not an alt table holding the 160
        expect(ui._comparison.runs).toHaveLength(1);
        expect(ui._comparison.runs[0].settings.roomLevel).toBe(130);
        expect(storage.written['labSimComparisonRuns_alt']).toBeUndefined();
    });

    test('a Find Max result is a different question, so it does not join the table', async () => {
        await simulate(130);
        await simulate(140);

        ui._displayFindMaxResults(
            { cleared: true, maxLevel: 145, winRate: 0.72, threshold: 0.7, steps: 6, minLevel: 20, maxSearched: 200 },
            '/monsters/mimic',
            Date.now()
        );

        expect(ui._comparison.runs).toHaveLength(2);
        expect(ui.panel.querySelector('#mwi-labsim-comparison')).toBeNull();
    });
});

describe('a labyrinth fight is never a task fight', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];
        sim.calls = [];
        ui.buildPanel();
        await settle();
    });

    afterEach(() => {
        ui.destroy();
        game.players = [];
    });

    test('the Task Fight option is gone from the Configure tab', () => {
        // A labyrinth monster is not your combat task, so the taskDamage the box
        // applied pays nothing — the only thing ticking it could do was produce
        // a wrong number
        expect(ui.panel.querySelector('#mwi-labsim-taskfight')).toBeNull();
        expect(ui.panel.textContent).not.toContain('Task Fight');
    });

    test('and the simulation is told so outright rather than by an absent box', async () => {
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._onSimulate();

        expect(sim.calls).toHaveLength(1);
        expect(sim.calls[0].isTaskFight).toBe(false);
    });

    test('nothing recorded from the panel carries the flag either', async () => {
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._onSimulate();

        expect(ui._comparison.runs).toHaveLength(1);
        expect(ui._comparison.runs[0].settings).not.toHaveProperty('taskFight');
    });
});

describe('the upgrade table reads like the combat sim’s', () => {
    /** One gold row and one token row, the shape `_renderUpgradeResults` takes. */
    const analysis = () => ({
        baseline: { winRate: 0.4962 },
        results: [
            {
                candidate: {
                    type: 'cross_slot',
                    description:
                        'Royal Nature Robe Top +7 + Royal Nature Robe Bottoms +7 → ' +
                        'Royal Fire Robe Top +7 + Royal Fire Robe Bottoms +7',
                },
                costType: 'gold',
                cost: 8879530,
                winRate: 0.5136,
                winRateDelta: 0.0174,
                metricType: 'winRate',
                costDetail: null,
            },
            {
                candidate: { type: 'labyrinth_buff', description: 'Fireball Lv48 → Lv53' },
                costType: 'token',
                tokenCost: 120,
                winRate: 0.52,
                winRateDelta: 0.02,
                metricType: 'winRate',
            },
        ],
    });

    let host;
    let container;

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [];
        game.skipLevels = {};
        rowActions.wired = [];
        ui.buildPanel();
        await settle();

        host = document.createElement('div');
        container = document.createElement('div');
        host.appendChild(container);
        document.body.appendChild(host);
    });

    afterEach(() => {
        host.remove();
        ui.destroy();
    });

    test('every row carries whatever the shared builder emits, in both tables', () => {
        ui._renderUpgradeResults(analysis(), container);

        const emitted = [...container.querySelectorAll('[data-shared-action]')].map((b) =>
            b.getAttribute('data-shared-action')
        );
        expect(emitted).toContain('Fireball Lv48 → Lv53');
        expect(emitted.some((d) => d.startsWith('Royal Nature Robe Top +7'))).toBe(true);
    });

    test('and they are given their behaviour once the strings are in the document', () => {
        ui._renderUpgradeResults(analysis(), container);

        expect(rowActions.wired).toContain(container);
    });

    test('re-sorting rebuilds the rows, so it wires them again', () => {
        ui._renderUpgradeResults(analysis(), container);
        const before = rowActions.wired.length;

        container.querySelector('th[data-sort-key="cost"]').dispatchEvent(new window.Event('click', { bubbles: true }));

        expect(rowActions.wired.length).toBeGreaterThan(before);
    });

    test('a long upgrade name wraps instead of running off the panel on one line', () => {
        ui._renderUpgradeResults(analysis(), container);

        const nameCells = [...container.querySelectorAll('td')].filter((td) =>
            td.textContent.includes('Royal Fire Robe Top')
        );
        expect(nameCells.length).toBeGreaterThan(0);
        for (const cell of nameCells) {
            expect(cell.getAttribute('style')).toContain('white-space:normal');
        }
    });

    test('the measured columns still never wrap — only the name does', () => {
        ui._renderUpgradeResults(analysis(), container);

        const costCell = container.querySelector('tr[data-gold-row="0"] td:nth-child(2)');
        expect(costCell.getAttribute('style')).toContain('white-space:nowrap');
    });

    test('the remembered-run banner Clear button forgets the saved run and removes itself', async () => {
        ui._restoredUpgradeAt = Date.now();
        ui._restoredUpgradeMeta = { characterName: 'Millennium44' };
        ui._renderUpgradeResults(analysis(), container);

        const clearBtn = container.querySelector('[data-clear-remembered-upgrade]');
        expect(clearBtn).toBeTruthy();
        expect(container.textContent).toContain('Showing results remembered from');

        clearBtn.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(ui._restoredUpgradeAt).toBeNull();
        expect(ui._restoredUpgradeMeta).toBeNull();
        expect(container.querySelector('[data-clear-remembered-upgrade]')).toBeNull();
        expect(container.textContent).not.toContain('Showing results remembered from');
        // The table itself is untouched — Clear forgets the saved copy, not
        // what is already on screen
        expect(container.textContent).toContain('Fireball');
    });
});

describe('the skilling crate dropdowns follow the equipped crates', () => {
    beforeEach(() => {
        game.characterLabyrinth = null;
        game.characterSetting = null;
    });
    afterEach(() => {
        ui.destroy();
        game.characterLabyrinth = null;
        game.characterSetting = null;
    });

    test('default to what the character has equipped, not a hardcoded Expert', async () => {
        game.characterLabyrinth = {
            teaCrateItemHrid: '/items/advanced_tea_crate',
            coffeeCrateItemHrid: '/items/basic_coffee_crate',
            foodCrateItemHrid: '',
        };
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.querySelector('#mwi-labsim-skilling-tea').value).toBe('/items/advanced_tea_crate');
        expect(ui.panel.querySelector('#mwi-labsim-skilling-coffee').value).toBe('/items/basic_coffee_crate');
        // No food crate equipped reads as None, not the old hardcoded Expert
        expect(ui.panel.querySelector('#mwi-labsim-skilling-food').value).toBe('');
    });

    test('a manual pick opts out, so a later read does not drag it back', async () => {
        game.characterLabyrinth = { teaCrateItemHrid: '/items/advanced_tea_crate' };
        ui.buildPanel();
        await Promise.resolve();

        const tea = ui.panel.querySelector('#mwi-labsim-skilling-tea');
        tea.value = '/items/expert_tea_crate';
        tea.dispatchEvent(new Event('change'));
        ui._getSkillingCrates(); // re-reads, and would re-sync if not opted out

        expect(tea.value).toBe('/items/expert_tea_crate');
    });

    test('the row breakdown spells out the room and success working', () => {
        const clearRate = { getSkipThreshold: () => 67, getEffectiveLevel: () => 108 };
        const row = {
            skillName: 'Alchemy',
            skillHrid: '/skills/alchemy',
            roomLevel: 174,
            baseLevel: 106,
            effectiveLevel: 112,
            skillLevelBonus: 6,
            levelDelta: -62,
            levelBonus: -0.62,
            successBonus: 0.05,
            successChance: 0.34,
            doubleChance: 0.1,
            workPower: 120,
            progressPerSuccess: 120,
            targetProgress: 1740,
            attempts: 27,
            clearChance: 0.296,
        };
        const text = ui._skillingRowBreakdown(row, true, clearRate, 'Expert tea · Expert coffee');

        expect(text).toContain('Room 174 — the hardest room you still fight');
        expect(text).toContain('trigger 67:'); // explains the − 1 in words
        expect(text).toContain('Effective level 112 = base 106 + 6 buffs');
        expect(text).toContain('Level gap: 112 − 174 = -62');
        expect(text).toContain('34.0%'); // success chance
        expect(text).toContain('Clear 29.6%');
        expect(text).toContain('Crates: Expert tea · Expert coffee');
    });

    test('tearing the panel down forgets the manual pick, so the next character is read afresh', async () => {
        // destroy() runs on a character switch — the feature is disabled and
        // re-initialised around it. An opt-out that outlives the panel leaves
        // the arriving character's dropdowns on the markup's hardcoded Expert.
        game.characterLabyrinth = { teaCrateItemHrid: '/items/advanced_tea_crate' };
        ui.buildPanel();
        await Promise.resolve();
        const tea = ui.panel.querySelector('#mwi-labsim-skilling-tea');
        tea.value = '/items/expert_tea_crate';
        tea.dispatchEvent(new Event('change'));
        expect(ui._skillingCratesUserSet).toBe(true);

        ui.destroy();

        expect(ui._skillingCratesUserSet).toBe(false);
        expect(ui._combatCratesUserSet).toBe(false);

        // The arriving character's crates, not the departing one's pick
        game.characterLabyrinth = { teaCrateItemHrid: '/items/basic_tea_crate' };
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.querySelector('#mwi-labsim-skilling-tea').value).toBe('/items/basic_tea_crate');
    });

    test('tearing the panel down forgets what the departing character could clear', async () => {
        // `_maxLevelByMonster` is the highest room level the sim found this
        // character clearing, and it is only ever computed for a monster that is
        // missing from it — so one that outlives the panel is handed to the
        // arriving character's fight setup as their own `simMaxLevel`. The rest
        // are readings of the same build that are redrawn, not re-derived.
        ui._maxLevelByMonster = { '/monsters/cyclops': 260 };
        ui._allFightsResult = { rows: [{ monsterHrid: '/monsters/cyclops' }] };
        ui._upgradePlayerName = 'Departing';
        ui._houseScanNote = '3 rooms';
        ui._restoredUpgradeAt = 1000;
        ui._restoredUpgradeMeta = { characterName: 'Departing' };

        ui.destroy();

        expect(ui._maxLevelByMonster).toEqual({});
        expect(ui._allFightsResult).toBeNull();
        expect(ui._upgradePlayerName).toBeNull();
        expect(ui._houseScanNote).toBeNull();
        expect(ui._restoredUpgradeAt).toBeNull();
        expect(ui._restoredUpgradeMeta).toBeNull();
    });

    test('combat crate dropdowns also default to the equipped crates', async () => {
        game.characterLabyrinth = {
            teaCrateItemHrid: '/items/advanced_tea_crate',
            coffeeCrateItemHrid: '/items/advanced_coffee_crate',
            foodCrateItemHrid: '/items/basic_food_crate',
        };
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.querySelector('#mwi-labsim-coffee').value).toBe('/items/advanced_coffee_crate');
        expect(ui.panel.querySelector('#mwi-labsim-food').value).toBe('/items/basic_food_crate');
    });
});

describe('a skilling run only weighs what the skill being run can feel', () => {
    const ITEMS = {
        '/items/holy_chisel': {
            name: 'Holy Chisel',
            equipmentDetail: { type: '/equipment_types/crafting_tool', noncombatStats: { craftingSpeed: 0.3 } },
        },
        '/items/holy_pot': {
            name: 'Holy Pot',
            equipmentDetail: { type: '/equipment_types/cooking_tool', noncombatStats: { cookingSpeed: 0.3 } },
        },
        '/items/philosophers_necklace': {
            name: "Philosopher's Necklace",
            equipmentDetail: { type: '/equipment_types/neck', noncombatStats: { skillingEfficiency: 0.02 } },
        },
        '/items/combat_necklace': {
            name: 'Combat Necklace',
            equipmentDetail: { type: '/equipment_types/neck', combatStats: { stabAccuracy: 0.1 } },
        },
    };
    const gameData = { itemDetailMap: ITEMS };
    const worn = {
        '/equipment_types/crafting_tool': { hrid: '/items/holy_chisel', enhancementLevel: 5 },
        '/equipment_types/cooking_tool': { hrid: '/items/holy_pot', enhancementLevel: 3 },
        '/equipment_types/neck': { hrid: '/items/combat_necklace', enhancementLevel: 0 },
    };

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
    });

    afterEach(() => {
        ui.destroy();
    });

    test('another skill’s tool is taken out of the kit a single-skill run weighs', () => {
        // The complaint: a Cooking run spending a room evaluation on "Holy
        // Chisel +5 → +7", which is a crafting tool and cannot move a cooking
        // room by any amount
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/cooking', gameData);

        expect(scoped['/skills/cooking']['/equipment_types/crafting_tool']).toBeUndefined();
        expect(scoped['/skills/cooking']['/equipment_types/cooking_tool']).toBeDefined();
    });

    test('and put back for the skill it belongs to', () => {
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/crafting', gameData);

        expect(scoped['/skills/crafting']['/equipment_types/crafting_tool']).toBeDefined();
        expect(scoped['/skills/crafting']['/equipment_types/cooking_tool']).toBeUndefined();
    });

    test('a piece with no skilling stats at all is left alone, so a swap into it is still priced', () => {
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/cooking', gameData);

        expect(scoped['/skills/cooking']['/equipment_types/neck']?.hrid).toBe('/items/combat_necklace');
    });

    test('the kit is materialised even where no loadout is assigned, or the base kit leaks back in', () => {
        // The analysis falls back to the character's base equipment when the map
        // has no entry for a skill — which is the unscoped kit all over again
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/cooking', gameData);

        expect(scoped['/skills/cooking']).toBeDefined();
    });

    test('every skill keeps its own kit when the run is over all of them', () => {
        const map = { '/skills/crafting': worn };

        expect(ui._scopeSkillEquipmentMap(map, { equipment: worn }, null, gameData)).toBe(map);
    });
});

describe('what one more level of a community buff is worth to a skilling room', () => {
    const gameData = { itemDetailMap: {}, houseRoomDetailMap: {}, labyrinthCrateDetailMap: {} };
    const player = () => ({
        cookingLevel: 100,
        foragingLevel: 100,
        equipment: {},
        houseRooms: {},
        tokenUpgrades: {},
        communityBuffLevels: { productionEfficiency: 5, enhancingSpeed: 0, gatheringQuantity: 3, experience: 4 },
    });

    /** Run the pass for one skill and hand back what it appended. */
    const run = async (targetSkill, dto = player()) => {
        const analysisResult = { baseline: { clearRate: 0, xpPerRoom: 0 }, results: [] };
        await ui._runSkillingCommunityPass({
            dto,
            roomLevel: { '/skills/cooking': 100, '/skills/foraging': 100 },
            crateHrids: [],
            skillEquipmentMap: {},
            targetSkill,
            gameData,
            analysisResult,
        });
        return analysisResult;
    };

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
        ui._skillingAborted = false;
    });

    afterEach(() => {
        ui.destroy();
    });

    test('the efficiency buff moves a production room’s clear rate', async () => {
        const { results } = await run('/skills/cooking');
        const row = results.find((r) => r.candidate.buffKey === 'productionEfficiency');

        expect(row.costType).toBe('community');
        expect(row.clearRateDelta).toBeGreaterThan(0);
    });

    test('the Experience buff moves what the room pays rather than how often it clears', async () => {
        const { results } = await run('/skills/cooking');
        const row = results.find((r) => r.candidate.buffKey === 'experience');

        expect(row.metricType).toBe('xpPerRoom');
        expect(row.xpPerRoomDelta).toBeGreaterThan(0);
        expect(row.clearRateDelta).toBeCloseTo(0, 10);
    });

    test('and its current level is part of the baseline it is measured from', async () => {
        // Not a fresh question: the level has been on the DTO all along and was
        // dropped on the way into the buff array, so the XP baseline every row
        // is read against was the one with the buff switched off
        const withBuff = await run('/skills/cooking');
        const without = await run('/skills/cooking', { ...player(), communityBuffLevels: { experience: 0 } });

        expect(withBuff.baseline.xpPerRoom).toBeGreaterThan(without.baseline.xpPerRoom);
    });

    test('a Cooking run is never offered the gathering buff', async () => {
        const { results } = await run('/skills/cooking');

        expect(results.map((r) => r.candidate.buffKey)).not.toContain('gatheringQuantity');
    });

    test('a Foraging run is, and it moves the room', async () => {
        const { results } = await run('/skills/foraging');
        const row = results.find((r) => r.candidate.buffKey === 'gatheringQuantity');

        expect(row.clearRateDelta).toBeGreaterThan(0);
    });

    test('a buff already at the cap has no next level to donate for', async () => {
        const maxed = { ...player(), communityBuffLevels: { productionEfficiency: 20, experience: 4 } };
        const { results } = await run('/skills/cooking', maxed);

        expect(results.map((r) => r.candidate.buffKey)).toEqual(['experience']);
    });

    test('a Stop click lands between candidates rather than at the end of the run', async () => {
        ui._skillingAborted = true;
        const { results } = await run('/skills/cooking');

        expect(results).toEqual([]);
    });
});

describe('the skilling upgrade tables give a community buff one of its own', () => {
    const analysis = () => ({
        baseline: { clearRate: 0.62, xpPerRoom: 5000 },
        results: [
            {
                candidate: { type: 'community_buff', buffKey: 'experience', description: 'Experience Lv4 → Lv5' },
                costType: 'community',
                cost: null,
                cowbellCost: 20,
                clearRate: 0.62,
                clearRateDelta: 0,
                xpPerRoom: 5125,
                xpPerRoomDelta: 125,
                metricType: 'xpPerRoom',
            },
            {
                candidate: { type: 'skilling_gear', description: 'Holy Pot +5 (cooking)', skillKey: '/skills/cooking' },
                costType: 'gold',
                cost: 1000,
                clearRate: 0.65,
                clearRateDelta: 0.03,
                metricType: 'clearRate',
            },
        ],
    });

    let container;

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
        ui.destroy();
    });

    test('the row is drawn, in a table of its own rather than among the gear', () => {
        ui._renderSkillingUpgradeResults(analysis(), container);

        expect(container.textContent).toContain('Community Buffs');
        expect(container.textContent).toContain('Experience Lv4 → Lv5');
    });

    test('with the XP it buys, since a wisdom level buys no clears', () => {
        ui._renderSkillingUpgradeResults(analysis(), container);

        expect(container.textContent).toContain('+125.0');
    });

    test('and the cowbell rate rather than a gold price it has not got', () => {
        // A community buff level is the whole server's donated minutes; the only
        // price the game names is the cowbells per minute of uptime
        ui._renderSkillingUpgradeResults(analysis(), container);

        expect(container.textContent).toContain('20/min');
        expect(container.textContent).toContain('Lv20 (max)');
    });

    test('a run with no community rows draws no community table', () => {
        const result = analysis();
        result.results = result.results.filter((r) => r.costType !== 'community');

        ui._renderSkillingUpgradeResults(result, container);

        expect(container.textContent).not.toContain('Community Buffs');
    });
});

describe('a Skilling gear row unfolds into what it is buying', () => {
    /** A gold row with a breakdown behind it, as the analysis now hands one over */
    const geared = (over = {}) => ({
        baseline: { clearRate: 0.62 },
        results: [
            {
                candidate: {
                    type: over.type || 'skilling_gear',
                    description: over.description || "Plate Body +3 → Lumberjack's Top +5 (woodcutting)",
                    skillKey: '/skills/woodcutting',
                    currentLevel: 3,
                    upgradeLevel: 5,
                    ...(over.candidate || {}),
                },
                costType: 'gold',
                cost: over.cost ?? 40_000_000,
                costDetail:
                    'costDetail' in over
                        ? over.costDetail
                        : {
                              buys: [{ name: "Lumberjack's Top", enhancementLevel: 5, price: 40_000_000 }],
                              credits: [],
                              unpriced: [],
                              gross: 40_000_000,
                              net: 40_000_000,
                          },
                clearRate: 0.68,
                clearRateDelta: 0.06,
                metricType: 'clearRate',
            },
        ],
    });

    let container;

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
        ui.destroy();
    });

    test('the detail is folded away until the row is clicked', () => {
        ui._renderSkillingUpgradeResults(geared(), container);

        const detail = container.querySelector('[data-skilling-gold-detail="0"]');
        expect(detail).not.toBeNull();
        expect(detail.style.display).toBe('none');

        container.querySelector('[data-skilling-gold-row="0"]').click();
        expect(detail.style.display).toBe('table-row');
    });

    test('and names the rate it moved, against the baseline it moved it from', () => {
        ui._renderSkillingUpgradeResults(geared(), container);
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        // The clear-rate equivalent of the combat table's win-rate line
        expect(detail.textContent).toContain('68.00%');
        expect(detail.textContent).toContain('62.00%');
        expect(detail.textContent).toContain('+6.00%');
    });

    test('says what kind of purchase it is, since a piece you do not own is priced at +5', () => {
        ui._renderSkillingUpgradeResults(geared(), container);
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        expect(detail.textContent).toContain('do not own yet');
        expect(detail.textContent).toContain('+5');
        expect(detail.textContent).toContain('woodcutting');
    });

    test('an enhancement of what you already wear says that instead', () => {
        ui._renderSkillingUpgradeResults(
            geared({ type: 'enhancement', description: 'Holy Hatchet +3 → +5' }),
            container
        );
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        expect(detail.textContent).toContain('already wear');
        expect(detail.textContent).toContain('+3 → +5');
        expect(detail.textContent).not.toContain('do not own yet');
    });

    test('itemises the purchase and totals it', () => {
        ui._renderSkillingUpgradeResults(geared(), container);
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        expect(detail.textContent).toContain("Buy Lumberjack's Top +5");
        expect(detail.textContent).toContain('40,000,000');
    });

    test('a dash in the Cost column is explained as no listing, not as free', () => {
        ui._renderSkillingUpgradeResults(
            geared({
                cost: null,
                costDetail: {
                    buys: [{ name: "Lumberjack's Top", enhancementLevel: 5, price: null }],
                    credits: [],
                    unpriced: ["Lumberjack's Top"],
                    gross: null,
                    net: null,
                },
            }),
            container
        );
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        expect(detail.textContent).toContain('no market listing');
        // The measurement survives a missing price — and the sentence is shared
        // with a table ranked on win rate, so it names neither
        expect(detail.textContent).toContain('measured delta is still accurate');
    });

    test('and a cost that looks too high says which gear it is not crediting, and why', () => {
        ui._renderSkillingUpgradeResults(
            geared({
                costDetail: {
                    buys: [{ name: "Lumberjack's Top", enhancementLevel: 5, price: 40_000_000 }],
                    credits: [],
                    unpriced: [],
                    kept: [{ name: 'Plate Body', enhancementLevel: 3, price: 410_000_000 }],
                    keptValue: 410_000_000,
                    gross: 40_000_000,
                    net: 40_000_000,
                },
            }),
            container
        );
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        expect(detail.textContent).toContain('Keeping Plate Body +3');
        expect(detail.textContent).toContain('410,000,000');
        expect(detail.textContent).toContain('combat gear you keep in a loadout');
        // Not the labyrinth armor wording: there is no setting for this one
        expect(detail.textContent).not.toContain('Keep gear the forced armor swaps replace');
    });

    test('a row the analysis could not explain says so rather than drawing an empty box', () => {
        ui._renderSkillingUpgradeResults(geared({ costDetail: null }), container);
        const detail = container.querySelector('[data-skilling-gold-detail="0"]');

        expect(detail.textContent).toContain('No cost breakdown available');
    });
});

/**
 * Choosing the labyrinth tokens a simulation runs under.
 *
 * The Configure tab's Labyrinth Buffs section was a readout: it printed what
 * the live run had bought and nothing could be asked of it. A simulator whose
 * buffs can only be the ones you already own cannot answer "would Damage 8 get
 * me through the Eye Watcher", which is the question people open it with.
 *
 * The arithmetic is asserted in `lab-token-buffs.test.js`. What is worth
 * asserting here is the wiring: that a level typed into the section reaches the
 * simulations, that it is remembered, and — the failure this feature can
 * produce and nothing else can — that the panel says out loud when the run it
 * is reporting is not the live character's.
 */
describe('the labyrinth tokens a simulation runs under can be chosen', () => {
    const openSection = () => ui.panel.querySelector('#mwi-labsim-buffs-header').click();
    const damageInput = () => ui.panel.querySelector('[data-lab-token-buff="labyrinthCombatDamageLevel"]');
    const setDamage = (value) => {
        const input = damageInput();
        input.value = value;
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    /** The damage buff the last simulation was handed, as a ratio. */
    const simmedDamage = () =>
        sim.calls.at(-1)?.labyrinthCombatBuffs?.find((buff) => buff.typeHrid === '/buff_types/damage')?.ratioBoost ?? 0;

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        sim.calls = [];
        storage.written = {};
        game.characterInfo = { labyrinthCombatDamageLevel: 3, labyrinthTorchLevel: 2 };
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];

        ui.buildPanel();
        await settle();
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
    });

    afterEach(() => {
        ui.destroy();
        game.characterInfo = null;
        game.players = [];
    });

    test('with nothing chosen, the sim runs on what the character owns', async () => {
        await ui._onSimulate();

        expect(simmedDamage()).toBeCloseTo(0.03, 10);
    });

    test('a level typed into the section is the level the sim runs at', async () => {
        openSection();
        setDamage(8);

        await ui._onSimulate();

        expect(simmedDamage()).toBeCloseTo(0.08, 10);
    });

    test('and the Upgrade tab’s sims run under it too, not only the Configure one', async () => {
        openSection();
        setDamage(8);
        ui._switchTab('upgrade');

        await ui._onUpgradeAnalyze();

        expect(sim.calls.length).toBeGreaterThan(0);
        expect(simmedDamage()).toBeCloseTo(0.08, 10);
    });

    test('the section only offers the four the combat engine reads', () => {
        openSection();

        expect(damageInput()).not.toBeNull();
        expect(ui.panel.querySelector('[data-lab-token-buff="labyrinthCastSpeedLevel"]')).not.toBeNull();
        // The skilling and utility tokens move numbers no fight simulation has,
        // so they stay a readout rather than becoming an inert box
        expect(ui.panel.querySelector('[data-lab-token-buff="labyrinthTorchLevel"]')).toBeNull();
        expect(ui.panel.querySelector('#mwi-labsim-buffs-body').textContent).toContain('Torch');
    });

    test('each box opens on the live level rather than on nothing', () => {
        openSection();

        expect(damageInput().value).toBe('3');
    });

    test('a chosen level says so on the collapsed header, where it cannot be missed', () => {
        openSection();
        setDamage(8);
        openSection();

        expect(ui.panel.querySelector('#mwi-labsim-buffs-note').textContent).toBe('simulating Damage 3→8');
    });

    test('and a level put back to what is owned stops claiming a difference', () => {
        openSection();
        setDamage(8);
        setDamage(3);

        expect(ui.panel.querySelector('#mwi-labsim-buffs-note').textContent).toBe('');
    });

    test('Reset to live drops every chosen level at once', async () => {
        openSection();
        setDamage(8);
        ui.panel.querySelector('#mwi-labsim-buffs-reset').click();

        await ui._onSimulate();

        expect(simmedDamage()).toBeCloseTo(0.03, 10);
        expect(ui.panel.querySelector('#mwi-labsim-buffs-note').textContent).toBe('');
    });

    test('the choice is remembered per character, beside the rest of this tab', async () => {
        openSection();
        setDamage(8);
        await settle();

        expect(storage.written.labSimTokenBuffLevels_me).toEqual({ labyrinthCombatDamageLevel: 8 });
    });

    test('and the Token Upgrades rows step up from the level being simulated', async () => {
        openSection();
        setDamage(8);
        ui._switchTab('upgrade');
        for (const box of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            box.checked = box.getAttribute('data-lab-upgrade-dimension') === 'labyrinth_buff';
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }

        await ui._onUpgradeAnalyze();

        // Not Lv3→4: the sims already ran at 8, so pricing the fourth level
        // would be charging for a purchase the whole table has assumed
        const results = ui.panel.querySelector('#mwi-labsim-upgrade-results').textContent;
        expect(results).toContain('Combat Damage Lv8→9');
        expect(results).not.toContain('Combat Damage Lv3→4');
    });

    test('a token turned off is a choice, not a blank', async () => {
        openSection();
        setDamage(0);

        await ui._onSimulate();

        expect(simmedDamage()).toBe(0);
        expect(ui.panel.querySelector('#mwi-labsim-buffs-note').textContent).toBe('simulating Damage 3→0');
    });
});

/**
 * `_restoreTokenBuffLevels` has no ownership check on the value it reads back:
 * the read is always scoped to whoever asked (`readScoped` fixes the key
 * before its first await), but the *adoption* into `this._tokenBuffOverrides`
 * and the render that follows happen unconditionally. A storage stall (the
 * read watchdog retrying on a fresh connection) can let a departing
 * character's read resolve after the arriving character's own restore has
 * already run, adopting the departing character's typed-over levels into the
 * arriving character's panel.
 */
describe('a character switch mid-restore does not adopt the departing character’s token levels', () => {
    beforeEach(() => {
        geometry.saved = null;
        geometry.wasOpen = false;
        storage.written = {};
        storage.values = {};
        storage.pending = {};
        game.characterId = 'me';
        game.characterInfo = { labyrinthCombatDamageLevel: 3 };
    });

    afterEach(() => {
        storage.pending = {};
        ui.destroy();
        game.characterId = 'me';
        game.characterInfo = null;
    });

    test('a read that resolves after the switch is not adopted, and does not render', async () => {
        ui.buildPanel();
        await settle();
        // Open the section so a wrongful render would actually show up
        ui.panel.querySelector('#mwi-labsim-buffs-header').click();
        const bodyBefore = ui.panel.querySelector('#mwi-labsim-buffs-body').innerHTML;

        let resolveRead;
        storage.pending['labSimTokenBuffLevels_me'] = new Promise((resolve) => {
            resolveRead = resolve;
        });
        const restore = ui._restoreTokenBuffLevels();

        // The switch: an arriving character's own restore has already claimed
        // `this` by the time this stale read comes back
        game.characterId = 'alt';
        resolveRead({ labyrinthCombatDamageLevel: 8 });
        await restore;

        expect(ui._tokenBuffOverrides).toEqual({});
        expect(ui.panel.querySelector('#mwi-labsim-buffs-note').textContent).toBe('');
        expect(ui.panel.querySelector('#mwi-labsim-buffs-body').innerHTML).toBe(bodyBefore);
    });

    test('a same-character restore still adopts the stored levels', async () => {
        storage.values['labSimTokenBuffLevels_me'] = { labyrinthCombatDamageLevel: 8 };

        ui.buildPanel();
        await settle();
        ui.panel.querySelector('#mwi-labsim-buffs-header').click();

        expect(ui._tokenBuffOverrides).toEqual({ labyrinthCombatDamageLevel: 8 });
        expect(ui.panel.querySelector('[data-lab-token-buff="labyrinthCombatDamageLevel"]').value).toBe('8');
    });

    test('destroy() resets the typed-over token levels, not just the standing choice', async () => {
        ui.buildPanel();
        await settle();
        ui._tokenBuffOverrides = { labyrinthCombatDamageLevel: 8 };

        ui.destroy();

        expect(ui._tokenBuffOverrides).toEqual({});
    });
});

/**
 * Which abilities the target-levels grid offers.
 *
 * With Targets set to every fight, the grid listed one loadout's five abilities
 * — whichever loadout the Configure tab happened to be showing — and there was
 * no way to give a target to any ability in any of the other nine fights. The
 * grid belongs to the target scope, so it is built from the loadouts that scope
 * actually runs.
 */
describe('the ability target grid covers every fight it is being asked about', () => {
    const FIREBALL = '/abilities/fireball';
    const PRECISION = '/abilities/precision';
    const MAIM = '/abilities/maim';

    const openGrid = () => ui.panel.querySelector('#mwi-labsim-ability-targets-toggle').click();
    const grid = () => ui.panel.querySelector('#mwi-labsim-ability-targets');
    const offered = () => [...grid().querySelectorAll('[data-ability-target]')].map((i) => i.dataset.abilityTarget);
    const setScope = (value) => {
        const select = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        select.value = value;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
        game.abilityDetailMap = {
            [FIREBALL]: { name: 'Fireball' },
            [PRECISION]: { name: 'Precision' },
            [MAIM]: { name: 'Maim' },
        };
        // Two fights, two loadouts: one shared ability, one each
        game.loadoutByMonster = { '/monsters/mimic': 'fire', '/monsters/eye_watcher': 'sword' };
        game.loadoutNames = { fire: 'Fire Lab', sword: 'Sword Lab' };
        game.loadoutAbilities = {
            fire: [
                { hrid: FIREBALL, level: 48 },
                { hrid: PRECISION, level: 40 },
            ],
            sword: [
                { hrid: MAIM, level: 30 },
                { hrid: PRECISION, level: 44 },
            ],
        };
        // The Configure loadout, which is all the grid used to show
        game.editedDTOs = { p1: { abilities: [{ hrid: FIREBALL, level: 48 }] } };

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        for (const box of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            box.checked = box.getAttribute('data-lab-upgrade-dimension') === 'ability_level';
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
    });

    afterEach(() => {
        ui.destroy();
        game.abilityDetailMap = {};
        game.loadoutByMonster = {};
        game.loadoutNames = {};
        game.loadoutAbilities = {};
        game.editedDTOs = null;
    });

    test('the Configure fight still offers its own loadout and nothing else', () => {
        openGrid();

        expect(offered()).toEqual([FIREBALL]);
    });

    test('every fight offers the union across their loadouts', () => {
        setScope('all');
        openGrid();

        expect(offered().sort()).toEqual([FIREBALL, MAIM, PRECISION].sort());
    });

    test('an ability two loadouts both cast appears once', () => {
        setScope('all');
        openGrid();

        expect(offered().filter((hrid) => hrid === PRECISION)).toHaveLength(1);
    });

    test('and is labelled with the loadouts holding it, when they are not all of them', () => {
        setScope('all');
        openGrid();

        expect(grid().textContent).toContain('Fireball (48) [Fire Lab]');
        expect(grid().textContent).toContain('Maim (30) [Sword Lab]');
        // Cast by both, so a label would be noise — and its two levels are said
        // as the range they are
        expect(grid().textContent).toContain('Precision (40–44)');
        expect(grid().textContent).not.toContain('Precision (40–44) [');
    });

    test('the target opens off the highest level it is held at, so the boost is a boost everywhere', () => {
        setScope('all');
        openGrid();

        const precision = grid().querySelector(`[data-ability-target="${PRECISION}"]`);
        expect(precision.value).toBe('49');
    });

    test('a chosen subset covers only the loadouts it ticked', () => {
        setScope('selected');
        // The Eye Watcher alone, which is the sword loadout alone
        const watcher = ui.panel.querySelector('[data-lab-target="/monsters/eye_watcher"]');
        watcher.checked = true;
        watcher.dispatchEvent(new window.Event('change', { bubbles: true }));
        openGrid();

        expect(offered().sort()).toEqual([MAIM, PRECISION].sort());
        // One loadout in the set, so its abilities are all shared and unlabelled
        expect(grid().textContent).not.toContain('[Sword Lab]');
    });

    test('widening the scope while the grid is open widens the grid', () => {
        openGrid();
        expect(offered()).toEqual([FIREBALL]);

        setScope('all');

        expect(offered().sort()).toEqual([FIREBALL, MAIM, PRECISION].sort());
    });

    test('and a target already typed survives that rebuild', () => {
        setScope('all');
        openGrid();
        const fireball = grid().querySelector(`[data-ability-target="${FIREBALL}"]`);
        fireball.value = '77';

        setScope('selected');
        const mimic = ui.panel.querySelector('[data-lab-target="/monsters/mimic"]');
        mimic.checked = true;
        mimic.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(grid().querySelector(`[data-ability-target="${FIREBALL}"]`).value).toBe('77');
    });

    test('what the grid holds is what the analysis is handed, keyed by ability', () => {
        setScope('all');
        openGrid();

        expect(ui._getAbilityTargets('#mwi-labsim-ability-targets')).toMatchObject({
            [FIREBALL]: 53,
            [MAIM]: 35,
            [PRECISION]: 49,
        });
    });
});

/**
 * The Guild Shrine include used to carry a single Lv spinner while the House
 * include next to it had both a spinner and a per-room grid. Same complaint,
 * same answer: one absolute level across shrines sitting at different levels is
 * a no-op for the ones already past it.
 */
describe('guild shrine targets are asked for one shrine at a time', () => {
    const FORCE = '/guild_buffs/force_combat';
    const AEGIS = '/guild_buffs/aegis_combat';
    const RARITY = '/guild_buffs/rarity_skilling';

    const openGrid = () => ui.panel.querySelector('#mwi-labsim-shrine-targets-toggle').click();
    const grid = () => ui.panel.querySelector('#mwi-labsim-shrine-targets');
    const offered = () =>
        [...grid().querySelectorAll('[data-lab-shrine-target]')].map((i) => i.dataset.labShrineTarget);
    const costs = (top) => Object.fromEntries(Array.from({ length: top }, (_, i) => [i + 1, { guildTokenCost: 10 }]));

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.guildBuffDetailMap = {
            [FORCE]: { shrineHrid: '/guild_shrines/force', isCombat: true, levelCosts: costs(20) },
            [AEGIS]: { shrineHrid: '/guild_shrines/aegis', isCombat: true, levelCosts: costs(8) },
            // Skilling shrines cannot move a win rate, which is all this tab ranks
            [RARITY]: { shrineHrid: '/guild_shrines/rarity', isCombat: false, levelCosts: costs(20) },
        };
        game.editedDTOs = { p1: { guildShrineLevels: { [FORCE]: 4, [AEGIS]: 8 } } };

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        for (const box of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            box.checked = box.getAttribute('data-lab-upgrade-dimension') === 'guild_shrine';
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
    });

    afterEach(() => {
        ui.destroy();
        game.guildBuffDetailMap = {};
        game.editedDTOs = null;
    });

    test('there is a Targets grid at all, the way the House include has one', () => {
        expect(ui.panel.querySelector('#mwi-labsim-shrine-targets-toggle')).not.toBeNull();
        expect(grid().style.display).toBe('none');
    });

    test('it lists each combat shrine with the level it is at', () => {
        openGrid();

        expect(offered().sort()).toEqual([AEGIS, FORCE].sort());
        expect(grid().textContent).toContain('Force (4)');
        expect(grid().textContent).toContain('Aegis (8)');
        expect(grid().textContent).not.toContain('Rarity');
    });

    test('and it states the combat sim grid’s contract: blank steps once, 0 skips', () => {
        openGrid();

        expect(grid().textContent).toContain('blank or ≤ current level evaluates one level up');
        expect(grid().textContent).toContain('0 skips the shrine');
        expect(grid().textContent).toContain('used instead of the Lv box while open');
    });

    test('each box opens one level up, or at the Lv box when one was typed', () => {
        ui.panel.querySelector('#mwi-labsim-shrine-target-level').value = '9';
        openGrid();

        expect(grid().querySelector(`[data-lab-shrine-target="${FORCE}"]`).value).toBe('9');
    });

    test('a shrine at its own cap is offered nothing to buy', () => {
        openGrid();
        const aegis = grid().querySelector(`[data-lab-shrine-target="${AEGIS}"]`);

        expect(aegis.value).toBe('');
        expect(aegis.disabled).toBe(true);
    });

    test('nothing is capped past twenty, whatever the cost table runs to', () => {
        openGrid();

        expect(grid().querySelector(`[data-lab-shrine-target="${FORCE}"]`).getAttribute('max')).toBe('20');
    });

    test('a closed grid is not a set of targets — the Lv box still governs', () => {
        expect(ui._getShrineTargets()).toBeNull();
    });

    test('an open one is read per shrine, clamped at twenty', () => {
        openGrid();
        grid().querySelector(`[data-lab-shrine-target="${FORCE}"]`).value = '40';

        expect(ui._getShrineTargets()).toEqual({ [FORCE]: 20 });
    });

    // The combat sim's grid moved to "blank = one level up, 0 = skip" in
    // 227f26b9 and this one stayed on the old reading, so two grids in the same
    // panel family disagreed about what an empty box meant — clearing one here
    // dropped the shrine instead of stepping it once.
    test('a box emptied by hand asks for one level up, not a skip', () => {
        openGrid();
        grid().querySelector(`[data-lab-shrine-target="${FORCE}"]`).value = '';

        expect(ui._getShrineTargets()).toEqual({ [FORCE]: -1 });
    });

    test('an explicit 0 is what drops the shrine now', () => {
        openGrid();
        grid().querySelector(`[data-lab-shrine-target="${FORCE}"]`).value = '0';

        expect(ui._getShrineTargets()).toEqual({ [FORCE]: 0 });
    });

    test('the boxes accept a 0, which the number input used to refuse', () => {
        openGrid();

        expect(grid().querySelector(`[data-lab-shrine-target="${FORCE}"]`).getAttribute('min')).toBe('0');
    });

    test('a shrine already at its cap stays out of the map rather than sending -1', () => {
        openGrid();

        expect(ui._getShrineTargets()).not.toHaveProperty(AEGIS);
    });

    test('the advisor honours both readings from this grid', () => {
        const dto = { equipment: {}, guildShrineLevels: { [FORCE]: 4, [AEGIS]: 2 } };
        const candidates = ui._extraDimensionCandidates(
            ['guild_shrine'],
            dto,
            { itemDetailMap: {} },
            {
                // Blank on Force, zeroed on Aegis
                guildShrineTargets: { [FORCE]: -1, [AEGIS]: 0 },
            }
        );

        expect(Object.fromEntries(candidates.map((candidate) => [candidate.buffHrid, candidate.upgradeLevel]))).toEqual(
            { [FORCE]: 5 }
        );
    });

    test('the map reaches the candidate generator, one level per shrine', () => {
        const dto = { equipment: {}, guildShrineLevels: { [FORCE]: 4, [AEGIS]: 2 } };
        const candidates = ui._extraDimensionCandidates(
            ['guild_shrine'],
            dto,
            { itemDetailMap: {} },
            {
                guildShrineTargets: { [FORCE]: 9, [AEGIS]: 5 },
            }
        );

        expect(Object.fromEntries(candidates.map((candidate) => [candidate.buffHrid, candidate.upgradeLevel]))).toEqual(
            { [FORCE]: 9, [AEGIS]: 5 }
        );
    });

    test('and a shrine the map leaves out is not bought at the Lv box’s level instead', () => {
        const dto = { equipment: {}, guildShrineLevels: { [FORCE]: 4, [AEGIS]: 2 } };
        const candidates = ui._extraDimensionCandidates(
            ['guild_shrine'],
            dto,
            { itemDetailMap: {} },
            {
                guildShrineTargetLevel: 7,
                guildShrineTargets: { [AEGIS]: 5 },
            }
        );

        expect(candidates.map((candidate) => candidate.buffHrid)).toEqual([AEGIS]);
    });
});

/**
 * The Guild Shrine chip's "Guild-allowed only" checkbox — Lab Sim's port of
 * the Combat Simulator's Upgrade tab option of the same name. Lab Sim never
 * set `guildShrineCapToGuild` before this, so every ranked shrine level was
 * one the guild might not be able to sell; the checkbox defaults on because a
 * level nobody can buy is not an upgrade.
 *
 * `runLabyrinthUpgradeAnalysis` and `runLabyrinthAllFightsAnalysis` are real
 * (this file never mocks `upgrade-advisor.js`), so their `params` argument is
 * captured with a spy rather than inspected through a stand-in — the same
 * object the real advisor entry point receives.
 */
describe('the guild shrine guild-allowed cap', () => {
    const checkOnlyShrine = () => {
        for (const box of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            box.checked = box.getAttribute('data-lab-upgrade-dimension') === 'guild_shrine';
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
    };
    const capBox = () => ui.panel.querySelector('#mwi-labsim-shrine-cap-guild');

    let singleSpy;
    let allSpy;

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], guildShrineLevels: {} }];

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._restoreUpgradeSelection();
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';

        // Stand in for the real analyses so a single Analyze click resolves
        // immediately with nothing to simulate — the params handed to them are
        // what this suite is about, not a full run's results
        singleSpy = vi
            .spyOn(upgradeAdvisor, 'runLabyrinthUpgradeAnalysis')
            .mockResolvedValue({ baseline: null, results: [] });
        allSpy = vi
            .spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis')
            .mockResolvedValue({ baseline: null, results: [] });
    });

    afterEach(() => {
        singleSpy.mockRestore();
        allSpy.mockRestore();
        game.players = [];
        ui.destroy();
    });

    test('renders in the shrine group, checked by default', () => {
        expect(ui.panel.querySelector('[data-lab-mode-options="guild_shrine"]').contains(capBox())).toBe(true);
        expect(capBox().checked).toBe(true);
    });

    test('reaches the single-fight analysis as guildShrineCapToGuild, both ways', async () => {
        checkOnlyShrine();

        await ui._onUpgradeAnalyze();
        expect(singleSpy).toHaveBeenCalledTimes(1);
        expect(singleSpy.mock.calls[0][0].guildShrineCapToGuild).toBe(true);

        capBox().checked = false;
        capBox().dispatchEvent(new window.Event('change', { bubbles: true }));

        await ui._onUpgradeAnalyze();
        expect(singleSpy).toHaveBeenCalledTimes(2);
        expect(singleSpy.mock.calls[1][0].guildShrineCapToGuild).toBe(false);
    });

    test('reaches the single-fight analysis’s extraCandidates options too', async () => {
        // A multi-set selection (guild_shrine plus a second set) routes
        // guild_shrine through `_extraDimensionCandidates` instead of the
        // analysis's own mode, since a single-fight analysis only generates
        // from one mode directly
        for (const box of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            const dim = box.getAttribute('data-lab-upgrade-dimension');
            box.checked = dim === 'guild_shrine' || dim === 'combat_level';
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }

        await ui._onUpgradeAnalyze();

        expect(singleSpy.mock.calls[0][0].extraCandidates).toBeDefined();
    });

    test('reaches the all-fights analysis as guildShrineCapToGuild, both ways', async () => {
        checkOnlyShrine();
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = 'all';
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));

        await ui._onUpgradeAnalyze();
        expect(allSpy).toHaveBeenCalledTimes(1);
        expect(allSpy.mock.calls[0][0].guildShrineCapToGuild).toBe(true);

        capBox().checked = false;
        capBox().dispatchEvent(new window.Event('change', { bubbles: true }));

        await ui._onUpgradeAnalyze();
        expect(allSpy).toHaveBeenCalledTimes(2);
        expect(allSpy.mock.calls[1][0].guildShrineCapToGuild).toBe(false);
    });

    test('and the shrine set being off leaves the flag off too', async () => {
        // Every dimension unchecked — guild_shrine never selected, so the
        // gate that reads guildShrineTargetLevel at the same spot reads this
        // false regardless of the box's own state
        for (const box of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            box.checked = false;
            box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        // The panel refuses an empty selection, so give it one set that is not
        // guild_shrine
        ui.panel.querySelector('[data-lab-upgrade-dimension="combat_level"]').checked = true;
        ui.panel
            .querySelector('[data-lab-upgrade-dimension="combat_level"]')
            .dispatchEvent(new window.Event('change', { bubbles: true }));

        await ui._onUpgradeAnalyze();

        expect(singleSpy.mock.calls[0][0].guildShrineCapToGuild).toBe(false);
    });

    test('reaches generateCandidates via _extraDimensionCandidates, both ways', () => {
        const generateSpy = vi.spyOn(upgradeAdvisor, 'generateCandidates');
        try {
            ui._extraDimensionCandidates(
                ['guild_shrine'],
                { equipment: {}, guildShrineLevels: {} },
                { itemDetailMap: {} },
                {
                    guildShrineCapToGuild: true,
                }
            );
            expect(generateSpy.mock.calls[0][12].guildShrineCapToGuild).toBe(true);

            ui._extraDimensionCandidates(
                ['guild_shrine'],
                { equipment: {}, guildShrineLevels: {} },
                { itemDetailMap: {} },
                {
                    guildShrineCapToGuild: false,
                }
            );
            expect(generateSpy.mock.calls[1][12].guildShrineCapToGuild).toBe(false);
        } finally {
            generateSpy.mockRestore();
        }
    });

    test('unchecking it persists, and a fresh panel restores it unchecked', async () => {
        capBox().checked = false;
        capBox().dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(storage.written['labSimShrineCapToGuild_me']).toBe(false);

        // A fresh panel, the way a reload would build one
        storage.values = { ...storage.written };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');

        expect(capBox().checked).toBe(false);
    });

    test('with no saved value, a fresh panel restores it checked — the default-on guarantee', async () => {
        storage.values = {};
        storage.written = {};
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');

        expect(capBox().checked).toBe(true);
    });
});

describe('remembered-run banner', () => {
    test('names the character when meta is present', () => {
        const html = ui._restoredUpgradeNote(null, { characterName: 'Millennium44' });
        expect(html).toContain('Showing results remembered from a previous session — Millennium44.');
    });

    test('renders the legacy sentence for a payload saved before the name was stored', () => {
        const html = ui._restoredUpgradeNote(null, null);
        expect(html).toContain(
            'Showing results remembered from a previous session. Run a new analysis to refresh them.'
        );
        expect(html).not.toContain('—');
    });

    test('escapes markup in the character name', () => {
        const html = ui._restoredUpgradeNote(null, { characterName: '<img src=x>' });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=x&gt;');
    });
});

describe('the lab Gold/1% table when a swap costs nothing, or pays', () => {
    /** Four gold rows whose only difference is what they cost. */
    const priced = () => ({
        baseline: { winRate: 0.4962 },
        results: [
            {
                candidate: { type: 'tier', description: 'Cheap real upgrade' },
                costType: 'gold',
                cost: 2_000_000,
                winRate: 0.52,
                winRateDelta: 0.02,
                metricType: 'winRate',
                costDetail: null,
            },
            {
                candidate: { type: 'cross_slot', description: 'Cursed Bow +7 → Sundering Crossbow +7' },
                costType: 'gold',
                cost: -17_700_000,
                winRate: 0.5462,
                winRateDelta: 0.05,
                metricType: 'winRate',
                costDetail: null,
            },
            {
                candidate: { type: 'tier', description: 'Feeble refund swap' },
                costType: 'gold',
                cost: -1_000_000,
                winRate: 0.4967,
                winRateDelta: 0.0005,
                metricType: 'winRate',
                costDetail: null,
            },
            {
                candidate: { type: 'drink', description: 'Free upgrade that helps' },
                costType: 'gold',
                cost: 0,
                winRate: 0.5062,
                winRateDelta: 0.01,
                metricType: 'winRate',
                costDetail: null,
            },
            {
                candidate: { type: 'combat_level', description: 'Attack Lv90 → Lv91' },
                costType: 'gold',
                cost: null,
                winRate: 0.5162,
                winRateDelta: 0.02,
                metricType: 'winRate',
                costDetail: null,
            },
        ],
    });

    let host;
    let container;

    /** Where a named gold row sits in the table, by the order it was drawn. */
    const goldOrder = () => {
        const names = [...container.querySelectorAll('tr[data-gold-row]')].map((tr) =>
            tr.querySelector('td').textContent.trim()
        );
        return {
            indexOf: (name) => names.findIndex((text) => text.includes(name)),
            last: names.at(-1) || '',
            length: names.length,
        };
    };
    /** One gold row's cells, found by the name in its first column. */
    const goldRow = (name) => {
        const tr = [...container.querySelectorAll('tr[data-gold-row]')].find((row) =>
            row.querySelector('td').textContent.includes(name)
        );
        return [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    };

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [];
        game.skipLevels = {};
        ui.buildPanel();
        await settle();

        host = document.createElement('div');
        container = document.createElement('div');
        host.appendChild(container);
        document.body.appendChild(host);
    });

    afterEach(() => {
        host.remove();
        ui.destroy();
    });

    test('the biggest credit leads, and the feeblest refund does not jump it', () => {
        // `cost / delta` on a credit makes the row that barely helps the most
        // negative: 1M back for a twentieth of a point reads as −20M/%, ahead of
        // 17.7M back for five points at −3.5M/%
        ui._renderUpgradeResults(priced(), container);

        const order = goldOrder();
        expect(order.indexOf('Cursed Bow +7 → Sundering Crossbow +7')).toBeLessThan(
            order.indexOf('Feeble refund swap')
        );
    });

    test('and both of them lead the things that actually cost money', () => {
        ui._renderUpgradeResults(priced(), container);

        const order = goldOrder();
        expect(order.indexOf('Feeble refund swap')).toBeLessThan(order.indexOf('Free upgrade that helps'));
        expect(order.indexOf('Free upgrade that helps')).toBeLessThan(order.indexOf('Cheap real upgrade'));
    });

    test('a free upgrade that helps is not filed with the ones nobody could price', () => {
        // `cost ? cost / delta : Infinity` sent it to the bottom of the ascending
        // sort, below every purchase and beside the combat level
        ui._renderUpgradeResults(priced(), container);

        const order = goldOrder();
        expect(order.indexOf('Cheap real upgrade')).toBeLessThan(order.indexOf('Attack Lv90'));
        expect(order.last).toContain('Attack Lv90');
    });

    test('the cost cell says what the credit is instead of showing a negative price', () => {
        ui._renderUpgradeResults(priced(), container);

        expect(goldRow('Sundering Crossbow')[1]).toBe('+17.7M back');
        expect(goldRow('Free upgrade that helps')[1]).toBe('free');
        expect(goldRow('Attack Lv90')[1]).toBe('—');
    });

    test('and the value cell says it pays for itself rather than quoting gold per point', () => {
        ui._renderUpgradeResults(priced(), container);

        expect(goldRow('Sundering Crossbow')[4]).toBe('pays for itself');
        expect(goldRow('Free upgrade that helps')[4]).toBe('pays for itself');
        expect(goldRow('Cheap real upgrade')[4]).toBe('1,000,000');
    });
});

describe('the budget plan when a pick pays for itself', () => {
    const fight = (i, winRate, applied = true) => ({
        monsterHrid: `/monsters/m${i}`,
        monsterName: `Monster ${i}`,
        loadoutName: 'Loadout',
        roomLevel: 100,
        winRate,
        winRateDelta: winRate - 0.5,
        applied,
        trials: 1000,
    });
    const analysis = () => ({
        baseline: {
            fights: [fight(0, 0.5), fight(1, 0.5)],
            runClearChance: 0.25,
            expectedAttempts: 4,
        },
        results: [
            {
                candidate: {
                    type: 'cross_slot',
                    slot: '/equipment_types/two_hand',
                    description: 'Cursed Bow +7 → Sundering Crossbow +7',
                },
                costType: 'gold',
                cost: -17_700_000,
                fights: [fight(0, 0.8), fight(1, 0.8)],
                appliedFights: 2,
                expectedAttempts: 2.5,
                attemptsDelta: -1.5,
                attemptsDeltaNoise: 0.1,
                significant: true,
                avgWinDelta: 0.3,
                attemptsSavedPerMillion: Infinity,
                costDetail: null,
            },
        ],
    });

    let host;
    let container;

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [];
        game.skipLevels = {};
        ui.buildPanel();
        await settle();

        host = document.createElement('div');
        container = document.createElement('div');
        host.appendChild(container);
        document.body.appendChild(host);
        ui._allFightsBudget = 500_000_000;
        ui._allFightsBudgetText = '500m';
    });

    afterEach(() => {
        ui._allFightsBudget = 0;
        ui._allFightsBudgetText = '';
        host.remove();
        ui.destroy();
    });

    test('the shopping list says what the swap hands back, not a negative price', () => {
        // formatKMB of a negative reads as a price of −17.7M in a column of
        // prices; the table above the plan already says '+17.7M back'
        ui._renderAllFightsResults(analysis(), container);

        const plan = container.querySelector('#mwi-labsim-budget');
        expect(plan.textContent).toContain('Cursed Bow +7');
        expect(plan.textContent).toContain('+17.7M back');
        expect(plan.textContent).not.toContain('-17.7M');
    });
});

describe('the cost breakdown', () => {
    test('a sweep-priced buy names whose enhancing stats it ran on', () => {
        // Nothing is listed at that enhancement, so half the figure is a
        // simulated path — and the same path costs different money on different
        // benches. Same word the enhancement tooltip's chip uses.
        const html = ui._renderCostBreakdown({
            buys: [{ name: 'Fire Top', enhancementLevel: 7, price: 5_000_000 }],
            credits: [],
            gross: 5_000_000,
            net: 5_000_000,
            enhanceSource: { kind: 'pro', label: 'Pro', detail: 'Pro rates: enhancing 140' },
        });

        expect(html).toContain('Enhance rates: Pro');
        expect(html).toContain('Pro rates: enhancing 140');
    });

    test('a market-quoted buy says nothing about benches', () => {
        const html = ui._renderCostBreakdown({
            buys: [{ name: 'Fire Top', enhancementLevel: 0, price: 5_000_000 }],
            credits: [],
            gross: 5_000_000,
            net: 5_000_000,
            enhanceSource: null,
        });
        expect(html).not.toContain('Enhance rates');
    });
});

/**
 * The Skilling tab remembers which loadout to sim each skill with, per
 * character. It used to read that map once per page and write it back under
 * whoever was current at the moment of the write.
 */
describe('the Skilling tab’s per-character loadout assignments', () => {
    beforeEach(() => {
        game.loadoutNames = { l1: 'Main WC', l2: 'Alt WC' };
        game.characterId = 'me';
        storage.values = {
            labSimSkillingLoadouts_me: { '/skills/woodcutting': 'Main WC' },
            labSimSkillingLoadouts_alt: { '/skills/woodcutting': 'Alt WC' },
        };
        storage.written = {};
        ui.buildPanel();
    });

    afterEach(() => {
        game.characterId = 'me';
        game.loadoutNames = {};
        storage.values = {};
        ui._skillLoadouts = {};
        ui._skillLoadoutsKey = null;
        ui.destroy();
    });

    test('a render after a switch offers the arriving character’s assignments', async () => {
        await ui._renderSkillLoadoutTable();
        expect(ui._skillLoadouts['/skills/woodcutting']).toBe('Main WC');

        game.characterId = 'alt';
        await ui._renderSkillLoadoutTable();

        expect(ui._skillLoadouts['/skills/woodcutting']).toBe('Alt WC');
    });

    test('a change made from a table left on screen across a switch is written back to its own character', async () => {
        await ui._renderSkillLoadoutTable();
        // The panel is sitting on the Skilling tab; nothing re-renders it, so
        // the rows on screen are still the departing character's
        game.characterId = 'alt';
        const select = ui.panel.querySelector('[data-skill-loadout="/skills/woodcutting"]');
        select.value = 'Alt WC';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(storage.written.labSimSkillingLoadouts_alt).toBeUndefined();
        expect(storage.written.labSimSkillingLoadouts_me['/skills/woodcutting']).toBe('Alt WC');
    });
});

/**
 * The Upgrade tab's room-level ranking: the checkbox that turns the second,
 * dearer pass on, the target floor it aims at, and the two columns it adds.
 *
 * Off by default, so an unchanged tab is exactly today's tab.
 */
describe('ranking upgrades by room levels', () => {
    const box = () => ui.panel.querySelector('#mwi-labsim-upgrade-room-levels');
    const floorInput = () => ui.panel.querySelector('#mwi-labsim-upgrade-target-floor');

    let singleSpy;

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = { '/monsters/mimic': 130 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], guildShrineLevels: {} }];

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._restoreUpgradeSelection();
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';

        singleSpy = vi
            .spyOn(upgradeAdvisor, 'runLabyrinthUpgradeAnalysis')
            .mockResolvedValue({ baseline: null, results: [] });
    });

    afterEach(() => {
        singleSpy.mockRestore();
        game.players = [];
        ui.destroy();
    });

    test('is off until it is asked for, and hides the floor box with it', () => {
        expect(box().checked).toBe(false);
        expect(ui.panel.querySelector('#mwi-labsim-target-floor-label').style.display).toBe('none');
    });

    test('reaches the single-fight analysis with the window and the fight cap', async () => {
        await ui._onUpgradeAnalyze();
        expect(singleSpy.mock.calls[0][0].rankByRoomLevels).toBe(false);

        box().checked = true;
        box().dispatchEvent(new window.Event('change', { bubbles: true }));
        expect(ui.panel.querySelector('#mwi-labsim-target-floor-label').style.display).toBe('flex');

        await ui._onUpgradeAnalyze();
        const params = singleSpy.mock.calls[1][0];
        expect(params.rankByRoomLevels).toBe(true);
        // The search window comes from the character, and a probe is bounded by
        // the same Max fights every other sim on this tab is
        expect(params.referenceLevel).toBeGreaterThan(0);
        expect(params.maxTrials).toBe(
            Math.max(1, parseInt(ui.panel.querySelector('#mwi-labsim-upgrade-maxfights').value, 10))
        );
    });

    test('the choice and the target floor are remembered like their neighbours', async () => {
        box().checked = true;
        box().dispatchEvent(new window.Event('change', { bubbles: true }));
        floorInput().value = '7';
        floorInput().dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(storage.written.labSimUpgradeRoomLevels_me).toBe(true);
        expect(storage.written.labSimUpgradeTargetFloor_me).toBe(7);
    });

    test('the table gains a Levels and a Floor column, and +0 is legible', () => {
        const container = ui.panel.querySelector('#mwi-labsim-upgrade-results');
        ui._renderUpgradeResults(
            {
                baseline: { winRate: 0.5, encounters: 50, attempts: 100 },
                roomLevels: {
                    baselineLevel: 120,
                    baselineFloor: 5,
                    baselineCleared: true,
                    measured: 2,
                    aborted: false,
                    shortlistSize: 6,
                    threshold: 0.7,
                    targetFloor: 6,
                },
                results: [
                    {
                        candidate: { description: 'Deep Upgrade' },
                        costType: 'gold',
                        cost: 1e6,
                        winRate: 0.6,
                        winRateDelta: 0.1,
                        metricType: 'winRate',
                        roomLevelDelta: 20,
                        maxRoomLevel: 140,
                        floorReached: 6,
                        roomLevelMeasured: true,
                    },
                    {
                        candidate: { description: 'Flat Upgrade' },
                        costType: 'gold',
                        cost: 5e5,
                        winRate: 0.51,
                        winRateDelta: 0.01,
                        metricType: 'winRate',
                        roomLevelDelta: 0,
                        maxRoomLevel: 120,
                        floorReached: 5,
                        roomLevelMeasured: true,
                    },
                ],
            },
            container
        );

        const html = container.innerHTML;
        expect(html).toContain('Levels');
        expect(html).toContain('Floor');
        expect(html).toContain('+20');
        // The upgrade that changes nothing says so, rather than going blank
        expect(html).toContain('+0');
        // Floor 6's requirement is the top of its band, not its average room
        expect(html).toContain('room level <b>140</b>');
        // Ranked in levels, so the biggest gain is the first row
        expect(html.indexOf('Deep Upgrade')).toBeLessThan(html.indexOf('Flat Upgrade'));
    });

    test('a row nobody searched does not read as a measured zero', () => {
        const container = ui.panel.querySelector('#mwi-labsim-upgrade-results');
        ui._renderUpgradeResults(
            {
                baseline: { winRate: 0.5, encounters: 50, attempts: 100 },
                roomLevels: {
                    baselineLevel: 120,
                    baselineFloor: 5,
                    baselineCleared: true,
                    measured: 1,
                    aborted: false,
                    shortlistSize: 6,
                    threshold: 0.7,
                    targetFloor: 6,
                },
                results: [
                    {
                        candidate: { description: 'Measured Zero' },
                        costType: 'gold',
                        cost: 5e5,
                        winRate: 0.51,
                        winRateDelta: 0.01,
                        metricType: 'winRate',
                        roomLevelDelta: 0,
                        maxRoomLevel: 120,
                        floorReached: 5,
                        roomLevelMeasured: true,
                    },
                    {
                        candidate: { description: 'Never Searched' },
                        costType: 'gold',
                        cost: 4e5,
                        winRate: 0.505,
                        winRateDelta: 0.005,
                        metricType: 'winRate',
                        roomLevelDelta: 0,
                        maxRoomLevel: null,
                        floorReached: null,
                        roomLevelMeasured: false,
                    },
                ],
            },
            container
        );

        /**
         * The Levels cell of the row a description names.
         * @param {string} description - The candidate's description
         * @returns {Element} The cell
         */
        const levelsCell = (description) => {
            const row = [...container.querySelectorAll('tr')].find((tr) => tr.textContent.includes(description));
            expect(row).toBeTruthy();
            // By header rather than by a hard-coded index, so a column added to
            // the table does not silently move this assertion onto another cell
            const headers = [...row.closest('table').querySelectorAll('th')].map((th) => th.textContent);
            const column = headers.findIndex((text) => text.startsWith('Levels'));
            expect(column).toBeGreaterThan(-1);
            return row.querySelectorAll('td')[column];
        };

        const measured = levelsCell('Measured Zero');
        const unmeasured = levelsCell('Never Searched');

        // A measured zero stays a confident, real zero
        expect(measured.textContent.trim()).toBe('+0');
        // "we looked and it does nothing" and "we did not look" are different
        // answers, and the cell itself has to say which
        expect(unmeasured.textContent.trim()).not.toBe('+0');
        expect(unmeasured.textContent.trim()).not.toBe('');

        // Both keep their hover text, and it still says which is which
        expect(measured.getAttribute('title')).toContain('Clears room level 120');
        expect(unmeasured.getAttribute('title')).toContain('Not searched');
    });

    test('the table is untouched when the pass was not run', () => {
        const container = ui.panel.querySelector('#mwi-labsim-upgrade-results');
        ui._renderUpgradeResults(
            {
                baseline: { winRate: 0.5, encounters: 50, attempts: 100 },
                roomLevels: null,
                results: [
                    {
                        candidate: { description: 'Some Upgrade' },
                        costType: 'gold',
                        cost: 1e6,
                        winRate: 0.6,
                        winRateDelta: 0.1,
                        metricType: 'winRate',
                    },
                ],
            },
            container
        );

        expect(container.innerHTML).not.toContain('Levels');
    });
});

/**
 * The Skilling tab's upgrade analysis is the one run behind this panel that is
 * not a worker sim: it is main-thread arithmetic that yields between candidates
 * and stops only when `_skillingAborted` is set. The feature's `disable()`
 * cancels every worker run on a character switch and never reached this one.
 */
describe('a skilling analysis left running by a character switch', () => {
    beforeEach(() => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.characterId = 'me';
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], guildShrineLevels: {} }];
        game.editedDTOs = {
            p1: { hrid: 'p1', equipment: {}, abilities: [], communityBuffLevels: {}, tokenUpgrades: {} },
        };
    });

    afterEach(() => {
        game.characterId = 'me';
        game.editedDTOs = null;
        ui._skillingSortHandler = null;
        ui.destroy();
    });

    test('is stopped by the teardown, and does not draw into the arriving character’s panel', async () => {
        ui.buildPanel();
        await settle();
        ui._switchTab('skilling');
        ui._skillingSortHandler = null;

        let onProgress;
        let abortSignal;
        let finish;
        const spy = vi
            .spyOn(upgradeAdvisor, 'runSkillingUpgradeAnalysis')
            .mockImplementation((_params, progress, options) => {
                onProgress = progress;
                abortSignal = options.abortSignal;
                return new Promise((resolve) => {
                    finish = () =>
                        resolve({
                            baseline: { clearRate: 0.5, xpPerRoom: 10 },
                            results: [
                                {
                                    candidate: { description: 'Cheese Hat +5' },
                                    costType: 'gold',
                                    cost: 1e6,
                                    clearRate: 0.6,
                                    clearRateDelta: 0.1,
                                    xpPerRoom: 11,
                                    xpPerRoomDelta: 1,
                                    metricType: 'clearRate',
                                },
                            ],
                        });
                });
            });

        const run = ui._onSkillingUpgradeAnalyze();
        await settle();
        expect(spy).toHaveBeenCalledTimes(1);

        // The switch: the feature is disabled and re-initialised around it
        ui.destroy();
        game.characterId = 'alt';
        ui.buildPanel();
        await settle();
        ui._switchTab('skilling');

        // Nothing in the worker-cancel path reaches this loop; only the flag does
        expect(abortSignal()).toBe(true);

        // A progress tick re-reads `this.panel`, which is now the arriving
        // character's
        const fill = ui.panel.querySelector('#mwi-labsim-skilling-progress-fill');
        fill.style.width = '';
        onProgress({ current: 3, total: 10, description: 'Cheese Hat +5' });
        expect(fill.style.width).toBe('');

        finish();
        await run;

        // Nothing drawn into the arriving character's table, and — the
        // accumulating half — their own sort handler not replaced by one bound
        // to the container that went away with the previous panel
        expect(ui.panel.querySelector('#mwi-labsim-skilling-results').innerHTML).toBe('');
        expect(ui._skillingSortHandler).toBeNull();

        spy.mockRestore();
    });
});
