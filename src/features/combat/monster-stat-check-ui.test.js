/** @vitest-environment happy-dom */

/**
 * The stat-check panel's persistence and fight-start snapshot.
 *
 * The history is a labelled corpus — one monster in each distinct buff state —
 * so the restore must key entries exactly as they were recorded. An earlier
 * restore rebuilt only monster|room, which collapsed every effect-state
 * snapshot of one room down to the oldest and then persisted the loss.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const stored = vi.hoisted(() => ({ value: null }));
/** Mutable state behind the clear-rate mock, reset per test. */
const clearRate = vi.hoisted(() => ({
    fingerprint: 'fp-now',
    probeResults: [],
    probeCalls: 0,
    playerProbeCalls: [],
    playerProbeResult: null,
    harnessCalls: [],
    harnessResult: null,
}));
/** Mutable state behind the tick-capture mock, reset per test. */
const tickCapture = vi.hoisted(() => ({ file: { ticks: [] }, started: [] }));
/** What the game says it is doing, for the zone/labyrinth/trial decision. */
const world = vi.hoisted(() => ({
    actionHrid: null,
    header: '',
    trialActive: false,
    trialTier: 0,
    participants: null,
    baseHp: 0,
}));

// Real subscribe/unsubscribe bookkeeping, unlike a no-op `vi.fn()`, so a test
// can prove a disable+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'me-id',
        getCurrentCharacterName: () => 'Benny',
        getCurrentActions: () => (world.actionHrid ? [{ actionHrid: world.actionHrid }] : []),
        getInitClientData: () => ({
            actionDetailMap: { '/actions/combat/twilight_zone': { name: 'Twilight Zone' } },
            combatMonsterDetailMap: {
                '/monsters/trial_badger': { combatDetails: { maxHitpoints: world.baseHp } },
            },
        }),
    },
}));
vi.mock('../guild/guild-trial-damage.js', () => ({
    default: {
        get active() {
            return world.trialActive;
        },
        get tier() {
            return world.trialTier;
        },
        get participants() {
            return world.participants;
        },
    },
}));
/** Handlers registered via `webSocketHook.on`, so a test can fire one directly. */
const wsHandlers = vi.hoisted(() => ({}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, fn) => {
            wsHandlers[event] = fn;
        },
        off: (event) => {
            delete wsHandlers[event];
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => stored.value,
        set: async (_k, v) => {
            stored.value = v;
        },
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-minimize.js', () => ({ attachMinimize: () => {} }));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({ buildGameDataPayload: () => ({}) }));
vi.mock('../combat-sim/engine/game-data.js', () => ({ setGameData: () => {} }));
vi.mock('../combat-sim/engine/monster.js', () => ({
    default: class {
        combatDetails = {};
        updateCombatDetails() {}
    },
}));
vi.mock('./labyrinth-clear-rate.js', () => ({
    default: {
        inLabyrinthFight: () => /labyrinth/i.test(world.header),
        probeSource: (_hrid, context) => {
            if (context?.trial?.tier) return { source: 'trial', tier: context.trial.tier };
            if (context?.zone?.hrid) {
                return {
                    source: 'zone',
                    zoneHrid: context.zone.hrid,
                    zoneName: 'Twilight Zone',
                    tier: context.zone.tier,
                };
            }
            return { source: 'labyrinth', loadoutName: 'Lab magic' };
        },
        simPlayerDetails: async (...args) => {
            clearRate.playerProbeCalls.push(args);
            return clearRate.playerProbeResult;
        },
        _snapshotContentFingerprint: () => clearRate.fingerprint,
        blindBuffProbe: async () => {
            const result = clearRate.probeResults[clearRate.probeCalls] ?? { produced: [], ran: true };
            clearRate.probeCalls++;
            return result;
        },
        uptimeHarness: async (...args) => {
            clearRate.harnessCalls.push(args);
            return clearRate.harnessResult;
        },
    },
}));
vi.mock('./labyrinth-tick-capture.js', () => ({
    captureFile: () => tickCapture.file,
    startCapture: (ctx) => tickCapture.started.push(ctx),
}));

const {
    panel,
    default: monsterStatCheck,
    PANEL_TOP_FRACTION,
    PANEL_MAX_HEIGHT_FRACTION,
    PANEL_HEIGHT_BUDGET,
} = await import('./monster-stat-check-ui.js');

/** A recorded snapshot of one monster/level in one buff state */
function snap(buffs, hp = 100) {
    return {
        hrid: '/monsters/cyclops',
        roomLevel: 206,
        combatBuffMap: buffs,
        combatDetails: { maxHitpoints: hp },
    };
}

beforeEach(() => {
    panel.history = new Map();
    panel.fightStartBuffMap = null;
    panel.displayed = null;
    stored.value = null;
    clearRate.fingerprint = 'fp-now';
    clearRate.probeResults = [];
    clearRate.probeCalls = 0;
    clearRate.playerProbeCalls = [];
    clearRate.playerProbeResult = null;
    world.actionHrid = null;
    world.header = '';
    world.trialActive = false;
    world.trialTier = 0;
    world.participants = null;
    world.baseHp = 0;
    panel.playerCheck = null;
    panel.lastPlayerUnit = null;
    panel.foldMode = 'folded';
    clearRate.harnessCalls = [];
    clearRate.harnessResult = null;
    tickCapture.file = { ticks: [] };
    tickCapture.started = [];
});

describe('restoring the persisted history', () => {
    test('distinct buff states of one monster/level all survive a reload', async () => {
        const bare = snap({});
        const buffed = snap({ '/buff_uniques/fierce_aura': { typeHrid: '/buff_types/damage', ratioBoost: 0.2 } });
        stored.value = { entries: [bare, buffed] };

        await panel._loadPersisted();

        // The old restore keyed both as "cyclops|206" and kept only the first
        expect(panel.history.size).toBe(2);
        expect(panel.history.has(panel._recordKey(bare))).toBe(true);
        expect(panel.history.has(panel._recordKey(buffed))).toBe(true);
    });

    test('a restored entry re-recorded in the same state updates in place', async () => {
        const entry = snap({ '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.5 } });
        stored.value = { entries: [entry] };
        await panel._loadPersisted();

        panel.last = snap(entry.combatBuffMap, 120);
        panel._record();

        // Same key — replaced, not duplicated under a second key shape
        expect(panel.history.size).toBe(1);
        expect(panel.history.get(panel._recordKey(entry)).combatDetails.maxHitpoints).toBe(120);
    });

    test('an entry recorded before buff maps existed still restores under a stable key', async () => {
        const legacy = { hrid: '/monsters/cyclops', roomLevel: 206, combatDetails: {} };
        stored.value = { entries: [legacy, snap({})] };

        await panel._loadPersisted();

        // buffSignature(undefined) and buffSignature({}) are both '' — the two
        // collide by design: neither carries an effect state
        expect(panel.history.size).toBe(1);
    });
});

describe('the uptime harness capture gate', () => {
    // _render at the end of the run paths needs the panel built once
    beforeEach(() => panel._ensureBuilt());

    test('a held capture from another build is refused BY NAME, and a fresh one armed with the current fingerprint', async () => {
        panel.displayed = snap({});
        tickCapture.file = {
            ticks: [{}, {}],
            context: { monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp-old' },
        };

        await panel._runUptimeHarness();

        expect(clearRate.harnessCalls).toHaveLength(0);
        expect(panel.displayed.uptime.armed).toBe(true);
        expect(panel.displayed.uptime.message).toContain('different build');
        // The refusal still arms a capture, bound to the current build
        expect(tickCapture.started).toHaveLength(1);
        expect(tickCapture.started[0]).toMatchObject({
            monsterHrid: '/monsters/cyclops',
            roomLevel: 206,
            fingerprint: 'fp-now',
        });
    });

    test('a wrong-monster capture names the monster, not the build', async () => {
        panel.displayed = snap({});
        tickCapture.file = {
            ticks: [{}],
            context: { monsterHrid: '/monsters/dryad', roomLevel: 206, fingerprint: 'fp-now' },
        };

        await panel._runUptimeHarness();

        expect(panel.displayed.uptime.message).toContain('different monster');
        expect(panel.displayed.uptime.message).not.toContain('build');
    });

    test('a legacy capture with no fingerprint still runs, and the section carries the fight counts', async () => {
        panel.displayed = snap({});
        tickCapture.file = { ticks: [{}], context: { monsterHrid: '/monsters/cyclops', roomLevel: 206 } };
        clearRate.harnessResult = {
            comparison: { rows: [] },
            real: { fights: 2, partialFights: 1, captureStartedMidFight: true },
        };

        await panel._runUptimeHarness();

        expect(clearRate.harnessCalls).toHaveLength(1);
        expect(panel.displayed.uptime.fightsLabel).toBe('2 fights (+1 partial excluded) — capture started mid-fight');
    });
});

describe('the blind probe', () => {
    beforeEach(() => panel._ensureBuilt());

    test('runs several probes and unions the produced effects — one quiet run cannot erase an effect', async () => {
        panel.displayed = snap({});
        clearRate.probeResults = [
            {
                ran: true,
                produced: [{ uniqueHrid: '/buff_uniques/toughness', typeHrid: '/buff_types/armor', ratioBoost: 0.4 }],
            },
            {
                ran: true,
                produced: [
                    { uniqueHrid: '/buff_uniques/haste', typeHrid: '/buff_types/attack_speed', ratioBoost: 0.1 },
                ],
            },
            { ran: true, produced: [] },
        ];

        await panel._runBlindSim();

        expect(clearRate.probeCalls).toBe(3);
        const byHrid = Object.fromEntries(panel.displayed.blind.rows.map((r) => [r.uniqueHrid, r.verdict]));
        // The game snapshot is empty, so sim-produced effects grade neutral —
        // not as a defect — and both runs' effects survive the union
        expect(byHrid['/buff_uniques/toughness']).toBe('notInSnapshot');
        expect(byHrid['/buff_uniques/haste']).toBe('notInSnapshot');
    });
});

describe('the fight-start buff snapshot', () => {
    test('your own new_battle entry is kept, a partner’s is not', () => {
        panel.noteBattleStart({
            players: [
                { character: { id: 'friend' }, combatBuffMap: { '/b/theirs': { typeHrid: '/buff_types/damage' } } },
                { character: { id: 'me-id' }, combatBuffMap: { '/b/mine': { typeHrid: '/buff_types/damage' } } },
            ],
        });
        expect(Object.keys(panel.fightStartBuffMap)).toEqual(['/b/mine']);
    });

    test('a payload without a buff map resets the snapshot rather than keeping a stale one', () => {
        panel.fightStartBuffMap = { '/b/old': {} };
        panel.noteBattleStart({ players: [{ character: { id: 'me-id' }, name: 'Benny' }] });
        expect(panel.fightStartBuffMap).toBeNull();
    });
});

describe('teardown forgets the person, not the monsters', () => {
    test('a character switch leaves no live stats, verdict or buff map behind', () => {
        // `disable()` is how a character switch reaches this panel. The monster
        // log is game data and deliberately shared, but these three describe
        // whoever was playing: "Check my build" runs against `lastPlayerUnit`
        // and only asks you to click yourself when it is null, `playerCheck` is
        // the verdict drawn on the panel, and the offense fold subtracts
        // `fightStartBuffMap` from the comparison.
        panel.lastPlayerUnit = { character: { id: 'me-id' }, combatDetails: {} };
        panel.playerCheck = { rows: [{ label: 'Stamina' }] };
        panel.fightStartBuffMap = { '/b/mine': { typeHrid: '/buff_types/damage' } };

        monsterStatCheck.disable();

        expect(panel.lastPlayerUnit).toBeNull();
        expect(panel.playerCheck).toBeNull();
        expect(panel.fightStartBuffMap).toBeNull();
    });
});

describe('disable unregisters the setting-change listener it registered', () => {
    test('a disable+initialize cycle does not accumulate listeners', () => {
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];

        // Every character switch runs disable() then initialize() again
        // (feature-registry.js). If the unregister function onSettingChange
        // hands back is discarded, each cycle leaves one more copy of the
        // same callback on config's per-key list.
        monsterStatCheck.initialize();
        for (let i = 0; i < 3; i++) {
            monsterStatCheck.disable();
            monsterStatCheck.initialize();
        }

        expect(settingListeners.labyrinthMonsterStatCheck).toHaveLength(1);
    });
});

describe('battle_unit_fetched classification', () => {
    // `battle_unit_fetched` fires with `isPlayer: true` both when you click
    // yourself AND when you click a party member or someone else's profile
    // (combat-summary and combat-drop-luck hit the same confusion this week:
    // 6e2a4da8). The player-build check must key off which character it is,
    // not just that it is a player, or "Check my build" silently compares the
    // sim's build of you against whoever's sheet was clicked last.
    beforeEach(() => {
        monsterStatCheck.initialize();
        panel.lastPlayerUnit = null;
    });

    test('a party member’s own sheet (isPlayer, a different character id) is not remembered as yours', () => {
        wsHandlers['battle_unit_fetched']({
            unit: {
                isPlayer: true,
                character: { id: 'friend-id', name: 'Friend' },
                combatDetails: { maxHitpoints: 999999 },
            },
        });
        expect(panel.lastPlayerUnit).toBeNull();
    });

    test('your own sheet (isPlayer, matching character id) is still remembered for the build check', () => {
        wsHandlers['battle_unit_fetched']({
            unit: {
                isPlayer: true,
                character: { id: 'me-id', name: 'Benny' },
                combatDetails: { maxHitpoints: 1000 },
            },
        });
        expect(panel.lastPlayerUnit?.character?.id).toBe('me-id');
    });

    test('an older/trimmed self-click payload with no character field still passes', () => {
        wsHandlers['battle_unit_fetched']({
            unit: { isPlayer: true, combatDetails: { maxHitpoints: 1000 } },
        });
        expect(panel.lastPlayerUnit).not.toBeNull();
    });
});

describe('where the clicked unit was met', () => {
    beforeEach(() => panel._ensureBuilt());

    /** A fetched unit, minimal but shaped like the real payload. */
    function unit(extra = {}) {
        return {
            hrid: '/monsters/vampire',
            name: 'Vampire',
            difficultyTier: 0,
            combatDetails: { combatStats: { combatStyleHrid: '/combat_styles/smash' } },
            combatBuffMap: {},
            ...extra,
        };
    }

    test('a zone monster in a zone resolves to that zone at its tier', () => {
        world.actionHrid = '/actions/combat/twilight_zone';
        panel.showFor(unit({ difficultyTier: 5 }));

        expect(panel.last.zone).toEqual({ hrid: '/actions/combat/twilight_zone', tier: 5 });
        expect(panel.last.trial).toBeNull();
    });

    test('a labyrinth monster resolves to the labyrinth', () => {
        world.header = 'Labyrinth - Room 206';
        world.actionHrid = '/actions/combat/labyrinth';
        panel.showFor(unit());

        expect(panel.last.zone).toBeNull();
        expect(panel.last.trial).toBeNull();
    });

    test('a tiered unit is never a labyrinth monster, even while the header says Labyrinth', () => {
        // A paused lab run leaves the header naming the labyrinth while a zone
        // fight is what is actually on screen.
        world.header = 'Labyrinth - Room 206';
        world.actionHrid = '/actions/combat/twilight_zone';
        panel.showFor(unit({ difficultyTier: 5 }));

        expect(panel.last.zone).toEqual({ hrid: '/actions/combat/twilight_zone', tier: 5 });
    });

    test('a trial boss resolves to the trial, never to the zone or the lab', () => {
        world.trialActive = true;
        world.trialTier = 8;
        world.header = 'Labyrinth - Room 206';
        world.actionHrid = '/actions/combat/twilight_zone';
        panel.showFor(unit({ hrid: '/monsters/trial_badger', name: 'Trial Badger', difficultyTier: 0 }));

        expect(panel.last.trial).toEqual({ tier: 8 });
        expect(panel.last.zone).toBeNull();
    });

    test('a trial boss with no live tier reads it back out of its combat level', () => {
        // T1 is Lv.100 and each tier is ten levels, so Lv.170 is T8.
        panel.showFor(
            unit({
                hrid: '/monsters/trial_badger',
                name: 'Trial Badger',
                combatDetails: { combatLevel: 170, combatStats: { combatStyleHrid: '/combat_styles/slash' } },
            })
        );

        expect(panel.last.trial).toEqual({ tier: 8 });
    });

    test('the trial health ladder is derived; the rest is left unmodelled', () => {
        world.trialActive = true;
        world.trialTier = 1;
        world.participants = 30;
        world.baseHp = 330000;
        panel.showFor(
            unit({
                hrid: '/monsters/trial_badger',
                name: 'Trial Badger',
                combatDetails: { maxHitpoints: 429000, combatStats: { combatStyleHrid: '/combat_styles/slash' } },
            })
        );

        const rows = panel.last.buffed.groups.flatMap((g) => g.rows);
        // 330,000 × 110/110 × 1.30 = 429,000 — the observed T1 sheet
        expect(rows.find((r) => r.key === 'maxHitpoints').sim).toBeCloseTo(429000, 0);
        expect(rows.find((r) => r.key === 'maxHitpoints').verdict).toBe('match');
        // Nothing else has a tier law, so nothing else is claimed
        expect(rows.find((r) => r.key === 'totalArmor').sim).toBeNull();
        expect(panel.last.hasMismatch).toBe(false);
    });

    test('the blind probe and the uptime harness refuse a trial boss instead of inventing one', async () => {
        world.trialActive = true;
        world.trialTier = 3;
        panel.showFor(unit({ hrid: '/monsters/trial_badger', name: 'Trial Badger' }));

        await panel._runBlindSim();
        await panel._runUptimeHarness();

        expect(clearRate.probeCalls).toBe(0);
        expect(clearRate.harnessCalls).toHaveLength(0);
        expect(panel.displayed.blind.notModelled).toBe(true);
        expect(panel.displayed.uptime.notModelled).toBe(true);
    });
});

describe('the player build check', () => {
    beforeEach(() => panel._ensureBuilt());

    /** Your live sheet mid-fight, with a self-buff up. */
    const YOU = {
        isPlayer: true,
        combatDetails: {
            maxHitpoints: 1000,
            totalArmor: 150,
            smashAccuracyRating: 853,
            combatStats: { combatStyleHrid: '/combat_styles/smash' },
        },
        combatBuffMap: {
            '/buff_uniques/toughness': { typeHrid: '/buff_types/armor', ratioBoost: 0.5 },
            '/buff_uniques/mystery_ward': { typeHrid: '/buff_types/mystery', ratioBoost: 0.9 },
        },
    };

    test('the live buff map is handed to the probe as a per-type fold, and the section names the source', async () => {
        world.actionHrid = '/actions/combat/twilight_zone';
        panel.showFor({
            hrid: '/monsters/vampire',
            name: 'Vampire',
            difficultyTier: 5,
            combatDetails: { combatStats: { combatStyleHrid: '/combat_styles/smash' } },
            combatBuffMap: {},
        });
        panel.noteChar(YOU);
        panel.fightStartBuffMap = {};
        clearRate.playerProbeResult = {
            base: { totalArmor: 100, combatStats: {} },
            buffed: { totalArmor: 150, combatStats: {} },
        };

        await panel._runPlayerCheck();

        const [, , context, foldBuffs] = clearRate.playerProbeCalls[0];
        expect(context).toEqual({ zone: { hrid: '/actions/combat/twilight_zone', tier: 5 } });
        expect(foldBuffs['/buff_uniques/toolasha_fold/armor'].ratioBoost).toBeCloseTo(0.5, 6);
        // The buff the engine has no term for is named, not dropped
        expect(panel.playerCheck.fold.notModelled).toEqual(['mystery ward']);
        expect(panel.playerCheck.fold.folded).toEqual(['toughness']);
        expect(panel.playerCheck.source.source).toBe('zone');
    });

    test('folded compares buffed against buffed; raw keeps the gap visible', async () => {
        world.actionHrid = '/actions/combat/twilight_zone';
        panel.showFor({
            hrid: '/monsters/vampire',
            name: 'Vampire',
            difficultyTier: 5,
            combatDetails: { combatStats: { combatStyleHrid: '/combat_styles/smash' } },
            combatBuffMap: {},
        });
        panel.noteChar(YOU);
        panel.fightStartBuffMap = {};
        clearRate.playerProbeResult = {
            base: { totalArmor: 100, combatStats: {} },
            buffed: { totalArmor: 150, combatStats: {} },
        };

        await panel._runPlayerCheck();

        const armorOf = (view) => view.groups.flatMap((g) => g.rows).find((r) => r.key === 'totalArmor');
        expect(armorOf(panel.playerCheck.folded).sim).toBe(150);
        expect(armorOf(panel.playerCheck.folded).verdict).toBe('match');
        expect(armorOf(panel.playerCheck.raw).sim).toBe(100);
        expect(armorOf(panel.playerCheck.raw).deltaPct).toBeCloseTo(50, 5);

        // The toggle picks which one the panel shows and the text carries
        expect(panel._playerView()).toBe(panel.playerCheck.folded);
        panel._toggleFoldMode();
        expect(panel._playerView()).toBe(panel.playerCheck.raw);
        expect(panel._playerBuildText()).toContain('raw sim build');
    });

    test('the labyrinth source names the loadout', async () => {
        world.header = 'Labyrinth - Room 206';
        panel.displayed = snap({});
        panel.noteChar(YOU);
        clearRate.playerProbeResult = { base: { combatStats: {} }, buffed: { combatStats: {} } };

        await panel._runPlayerCheck();

        expect(clearRate.playerProbeCalls[0][2]).toBeNull();
        expect(panel.playerCheck.source).toEqual({ source: 'labyrinth', loadoutName: 'Lab magic' });
    });
});

describe('the panel fits the viewport it is placed in', () => {
    // The only thing about this panel's placement a test without layout can
    // reach, and the thing that was wrong: `top: 8%` with `max-height: 94vh`
    // asks for 102% of the viewport, so the bottom 2% — the `resize: both`
    // corner handle among it — sat off screen on every device. The shared
    // clamp never corrected it because the panel is centred with a
    // `transform`, and `clampPanelToViewport` refuses transformed elements by
    // design. Nothing else catches this: happy-dom lays out nothing, so the
    // rendered geometry is all zeroes.
    test('the top offset plus the height cap leaves room below', () => {
        expect(PANEL_HEIGHT_BUDGET).toBe(PANEL_TOP_FRACTION + PANEL_MAX_HEIGHT_FRACTION);
        expect(PANEL_HEIGHT_BUDGET).toBeLessThan(1);
    });

    test('the panel is still most of the screen tall', () => {
        // The cap is there to keep a full readout scrollbar-free, so shrinking
        // it to satisfy the check above would trade one bug for another
        expect(PANEL_MAX_HEIGHT_FRACTION).toBeGreaterThan(0.8);
        expect(PANEL_TOP_FRACTION).toBeGreaterThan(0);
    });
});
