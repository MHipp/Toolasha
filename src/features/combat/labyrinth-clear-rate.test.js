/** @vitest-environment happy-dom */

/**
 * Tests for Labyrinth Clear Rate live-estimate math
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { SUPPLY_HRIDS } from './labyrinth-supplies.js';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';

/** Gear the mocked loadoutSnapshot reports; mutated in place (see setGear) so
 *  every holder of the mocked default export sees updates */
const gear = vi.hoisted(() => ({ snapshots: {}, ready: true, waiters: [], listeners: [] }));

/** Guild shrine data the mocked adapter and data manager report */
const shrines = vi.hoisted(() => ({ detailMap: {}, owned: {} }));

/** Community buff levels the mocked data manager reports, by buff hrid */
const community = vi.hoisted(() => ({ levels: {} }));

/** Backing store for the mocked storage module: `${storeName}:${key}` -> value */
const db = vi.hoisted(() => ({ map: new Map(), unavailable: false, hold: null }));

/** The mocked inventory the supply reader sees */
const bag = vi.hoisted(() => ({ items: null }));

/** What the mocked marketplace client knows */
const market = vi.hoisted(() => ({ loaded: false, prices: {} }));

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        setSetting: vi.fn(),
        getSettingValue: (key, fallback) => (settings.map.has(key) ? settings.map.get(key) : fallback),
        setSettingValue: (key, value) => settings.map.set(key, value),
        Z_NOTIFICATION: 10500,
        Z_FLOATING_PANEL: 10100,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(),
        register: vi.fn(),
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: vi.fn((name, callback) => {
            callback();
            return () => {};
        }),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        getCurrentCharacterId: vi.fn(() => 'me'),
        getCurrentCharacterGameMode: vi.fn(() => 'standard'),
        getSkills: vi.fn(() => []),
        getInitClientData: vi.fn(() => null),
        // The community buff levels the server is running, which the skilling
        // metrics and the combat experience award both read live
        getCommunityBuffLevel: (hrid) => community.levels[hrid] || 0,
        getCharacterGuildBuffLevel: (hrid) => shrines.owned[hrid] || 0,
        getInventory: () => bag.items,
        characterData: null,
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildPlayerDTO: vi.fn(),
    buildGameDataPayload: vi.fn(),
    applyLoadoutSnapshotToDTO: vi.fn(),
    getCommunityBuffs: () => ({ mooPass: false, comExp: 0, comDrop: 0 }),
    getGuildBuffDetailMap: () => shrines.detailMap,
    applyGuildBuffLevel: (buffs, detail, level) => [
        ...buffs.filter((b) => b.typeHrid !== detail.buffs[0].typeHrid),
        { typeHrid: detail.buffs[0].typeHrid, flatBoost: detail.buffs[0].flatBoost * level, ratioBoost: 0 },
    ],
}));
/** Records worker-level cancellation, which is what a Cancel press has to reach */
const cancelSpy = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: vi.fn(),
    runBlindBuffProbe: vi.fn(),
    runPlayerStatProbe: vi.fn(),
    cancelSimulation: cancelSpy.fn,
}));
// The supply planner asks the market what a missing shroud would cost. Importing
// the real client drags in the socket connection state, which is a lot of
// machinery for a note that these suites never assert on.
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => market.loaded, getPrice: (hrid) => market.prices[hrid] || null },
}));
// snapshots/resolveEquipment back the persisted-combat-cache gear fingerprint below;
// the rest of this file never touches loadout-snapshot, so {} was enough before it
vi.mock('./loadout-snapshot.js', () => ({
    default: {
        snapshots: gear.snapshots,
        // The store's load state, which the DTO builder and the cold-start
        // cache seeding both gate on — `gear.ready` is flipped per test
        get snapshotsReady() {
            return gear.ready;
        },
        whenReady: () => (gear.ready ? Promise.resolve(true) : new Promise((resolve) => gear.waiters.push(resolve))),
        onUpdate: (fn) => gear.listeners.push(fn),
        offUpdate: (fn) => {
            gear.listeners = gear.listeners.filter((l) => l !== fn);
        },
        resolveEquipment: (snapshot) => snapshot?.equipment || [],
    },
}));
// The persisted-combat-cache suite drives this store directly; every other
// suite in this file is pure math and never touches it
const dbGet = async (key, storeName = 'settings', defaultValue = null) => {
    const stored = db.map.get(`${storeName}:${key}`);
    return stored === undefined || stored === null ? defaultValue : stored;
};
const dbSet = async (key, value, storeName = 'settings') => {
    if (db.unavailable) return false;
    db.map.set(`${storeName}:${key}`, value);
    return true;
};
/** The probe the persisted-record discipline reads through: null when storage cannot be read */
const dbTryGet = async (key, storeName = 'settings') => {
    // A read left open, so a test can land a character switch inside one
    if (db.hold) await db.hold;
    if (db.unavailable) return null;
    const stored = db.map.get(`${storeName}:${key}`);
    return stored === undefined || stored === null
        ? { found: false, value: null }
        : { found: true, value: structuredClone(stored) };
};

vi.mock('../../core/storage.js', () => ({
    default: {
        get: dbGet,
        getJSON: dbGet,
        tryGet: dbTryGet,
        set: dbSet,
        setJSON: dbSet,
        delete: async (key, storeName = 'settings') => db.map.delete(`${storeName}:${key}`),
        getAllKeys: async () => [],
    },
}));

const { default: labyrinthClearRate } = await import('./labyrinth-clear-rate.js');
const { default: configMock } = await import('../../core/config.js');
const { COMBAT_CACHE_STORAGE_VERSION } = await import('./labyrinth-sim-cache.js');
const { registeredCommands, resetCommands } = await import('../../utils/command-registry.js');

// `db.unavailable` is a switch the storage-failure tests throw and, being module
// state, one they would otherwise leave thrown for whatever runs next — which
// reads as "the write silently did nothing" several suites away. Turned off
// here so it only lasts the test that wanted it.
afterEach(() => {
    db.unavailable = false;
});

describe('normalizeChance', () => {
    test('passes through ratios and converts percent-form values', () => {
        expect(labyrinthClearRate.normalizeChance(0.8)).toBe(0.8);
        expect(labyrinthClearRate.normalizeChance(80)).toBe(0.8);
        expect(labyrinthClearRate.normalizeChance(1)).toBe(1);
        expect(labyrinthClearRate.normalizeChance(0)).toBe(0);
        expect(labyrinthClearRate.normalizeChance(-5)).toBe(0);
        expect(labyrinthClearRate.normalizeChance(undefined)).toBe(0);
    });
});

describe('clear-chance Markov math', () => {
    test('guaranteed success clears exactly when enough attempts remain', () => {
        // Needs 10 successes (100 work / 10 per success) with 100% success rate
        const enough = labyrinthClearRate.computeNonEnhancingClearStats(10, 1, 0, 10, 100);
        expect(enough.clearChance).toBeCloseTo(1, 9);
        expect(enough.expectedAttemptsOnClear).toBeCloseTo(10, 9);

        const tooFew = labyrinthClearRate.computeNonEnhancingClearStats(9, 1, 0, 10, 100);
        expect(tooFew.clearChance).toBe(0);
    });

    test('double progress halves the required attempts', () => {
        // 100% success and 100% double: 10 units in 5 attempts
        const result = labyrinthClearRate.computeNonEnhancingClearStats(5, 1, 1, 10, 100);
        expect(result.clearChance).toBeCloseTo(1, 9);
        expect(result.expectedAttemptsOnClear).toBeCloseTo(5, 9);
    });

    test('enhancing walk reaches the target only with enough attempts', () => {
        const enough = labyrinthClearRate.computeEnhancingClearStats(5, 1, 0, 5, 0);
        expect(enough.clearChance).toBeCloseTo(1, 9);

        const tooFew = labyrinthClearRate.computeEnhancingClearStats(4, 1, 0, 5, 0);
        expect(tooFew.clearChance).toBe(0);
    });

    test('enhancing failures walk the level back down', () => {
        // 50% success from level 0 to 1 in one attempt = 0.5
        const oneShot = labyrinthClearRate.computeEnhancingClearStats(1, 0.5, 0, 1, 0);
        expect(oneShot.clearChance).toBeCloseTo(0.5, 9);
    });
});

describe('computeLiveEstimate', () => {
    const baseMessage = {
        targetLevel: null,
        successRate: 0.8,
        doubleProgressChance: 0.1,
        actionTimeMs: 10000,
        actionCounter: 2,
        currentWorkValue: 30,
        targetWorkValue: 100,
        progressPerAction: 10,
    };

    test('computes a skilling estimate with remaining attempts', () => {
        const estimate = labyrinthClearRate.computeLiveEstimate(baseMessage);
        expect(estimate.isEnhancing).toBe(false);
        expect(estimate.totalAttempts).toBe(12);
        expect(estimate.attemptsLeft).toBe(10);
        expect(estimate.clearChance).toBeGreaterThan(0);
        expect(estimate.clearChance).toBeLessThanOrEqual(1);
    });

    test('percent-form success rates produce the same estimate as ratios', () => {
        const ratioEstimate = labyrinthClearRate.computeLiveEstimate(baseMessage);
        const percentEstimate = labyrinthClearRate.computeLiveEstimate({
            ...baseMessage,
            successRate: 80,
            doubleProgressChance: 10,
        });
        expect(percentEstimate.clearChance).toBeCloseTo(ratioEstimate.clearChance, 9);
    });

    test('detects enhancing rooms from targetLevel', () => {
        const estimate = labyrinthClearRate.computeLiveEstimate({
            ...baseMessage,
            targetLevel: 5,
            currentEnhLevel: 2,
            actionTimeMs: 8000,
        });
        expect(estimate.isEnhancing).toBe(true);
        expect(estimate.currentLevel).toBe(2);
        expect(estimate.targetLevel).toBe(5);
        expect(estimate.totalAttempts).toBe(15);
    });
});

describe('attachSkillingWhatIfs', () => {
    const buildBase = () => ({
        clearChance: 0.6,
        expectedSeconds: 90,
        xpPerRoom: 5000,
    });
    const metrics = { successBonus: 0, efficiencyBonus: 0.1, actionSpeedBonus: 0.05 };
    const params = {
        attempts: 12,
        successChance: 0.8,
        doubleChance: 0.05,
        levelBonus: 0,
        effectiveLevel: 110,
        progressPerSuccess: 121,
        targetProgress: 1000,
        roomLevel: 100,
    };

    test('adds what-if clear chances and XP/hour', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, params);

        expect(result.nextLevelClearChance).toBeGreaterThanOrEqual(0);
        expect(result.nextLevelClearChance).toBeLessThanOrEqual(1);
        expect(result.speedTierClearChance).toBeGreaterThanOrEqual(result.clearChance - 1e-9);
        expect(result.speedDelta).toBeGreaterThanOrEqual(0);
        // Time in the room, plus one second of travel to reach it. Retries
        // happen where you stand, so a room failed four times is still only
        // walked to once. Combat rooms are charged the same way.
        expect(result.xpPerHour).toBeCloseTo((5000 * 3600) / 91, 6);
    });

    test('efficiency tier reflects one fewer required progress unit', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, params);

        // 1000 target / 121 per success = 9 units needed; tier requires ceil(1000/8) = 125 per success
        expect(result.efficiencyDelta).toBeGreaterThan(0);
        expect(result.efficiencyTierClearChance).toBeGreaterThanOrEqual(0);
        expect(result.efficiencyTierClearChance).toBeLessThanOrEqual(1);
    });

    test('marks efficiency as optimal when one success clears the room', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, {
            ...params,
            progressPerSuccess: 1000,
            targetProgress: 1000,
        });
        expect(result.efficiencyDelta).toBeNull();
        expect(result.efficiencyTierClearChance).toBeNull();
    });
});

/**
 * combatCache is a plain Map that used to start empty on every reload. These
 * exercise the mirror written to the 'labyrinth' store — round-tripping
 * through it, dropping what TTL or a gear change make stale, and capping how
 * much of it survives.
 */
describe('persisted combat cache', () => {
    /** Replace the mocked loadoutSnapshot's gear in place, keeping the same object reference */
    function setGear(equipmentSnapshots) {
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        Object.assign(gear.snapshots, equipmentSnapshots);
    }

    const sword = { equipment: [{ itemHrid: '/items/sword', enhancementLevel: 5 }] };
    const axe = { equipment: [{ itemHrid: '/items/axe', enhancementLevel: 0 }] };

    const simResult = (over = {}) => ({
        clearChance: 0.75,
        expectedSeconds: 12,
        type: 'combat',
        winRate: 0.75,
        trials: 500,
        monsterHrid: '/monsters/imp',
        roomLevel: 200,
        ...over,
    });

    beforeEach(() => {
        db.map.clear();
        setGear({ 1: sword });
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;
        labyrinthClearRate._snapshotFingerprint = null;
        // A flush left pending by an earlier test must not fire into this one
        clearTimeout(labyrinthClearRate._combatCacheFlushTimer);
        labyrinthClearRate._combatCacheFlushTimer = null;
        labyrinthClearRate._combatCacheDirty = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('round-trips a fresh sim through storage and back into the Map', async () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);
        // What the end of a search does; a lone entry otherwise lands a second later
        labyrinthClearRate._flushCombatCache();

        // Simulate a reload: the in-memory Map starts empty again
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;

        await labyrinthClearRate._loadCombatCache();

        const loaded = labyrinthClearRate.combatCache.get(key);
        expect(loaded).toMatchObject({ clearChance: 0.75, winRate: 0.75, fromPersistedCache: true });
        expect(Number.isFinite(loaded.computedAt)).toBe(true);
    });

    test('a teardown cancels the pending flush instead of emptying the arriving character’s cache', async () => {
        vi.useFakeTimers();
        const dm = await import('../../core/data-manager.js');
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate.combatCache.set(key, result);
        // Arms the one-second flush timer
        labyrinthClearRate._persistCombatCacheEntry(key, result);

        try {
            // feature-registry tears the feature down on `character_switching`,
            // which empties the map the flush rebuilds its list from...
            labyrinthClearRate.disable();
            dm.default.getCurrentCharacterId.mockReturnValue('iron456');

            // ...and the timer would fire a second later, with the id moved
            vi.advanceTimersByTime(2000);
            await Promise.resolve();

            expect(db.map.has('labyrinth:labyrinthCombatSimCache_iron456')).toBe(false);
        } finally {
            dm.default.getCurrentCharacterId.mockReturnValue('me');
        }
    });

    test('calling _loadCombatCache twice only reads storage once', async () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);
        // What the end of a search does; a lone entry otherwise lands a second later
        labyrinthClearRate._flushCombatCache();
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheLoaded = false;

        await labyrinthClearRate._loadCombatCache();
        expect(labyrinthClearRate.combatCache.has(key)).toBe(true);

        labyrinthClearRate.combatCache.clear();
        await labyrinthClearRate._loadCombatCache(); // guarded — should not re-read
        expect(labyrinthClearRate.combatCache.has(key)).toBe(false);
    });

    test('drops an entry older than the TTL', async () => {
        const key = 'imp:200:1:1pp:';
        const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
            version: COMBAT_CACHE_STORAGE_VERSION,
            entries: [
                {
                    key,
                    result: simResult(),
                    computedAt: eightDaysAgo,
                    snapshotFingerprint: labyrinthClearRate._snapshotContentFingerprint(),
                },
            ],
        });

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.has(key)).toBe(false);
    });

    test('keeps an entry inside the TTL', async () => {
        const key = 'imp:200:1:1pp:';
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
            version: COMBAT_CACHE_STORAGE_VERSION,
            entries: [
                {
                    key,
                    result: simResult(),
                    computedAt: oneHourAgo,
                    snapshotFingerprint: labyrinthClearRate._snapshotContentFingerprint(),
                },
            ],
        });

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.get(key)).toMatchObject({ fromPersistedCache: true });
    });

    test('a gear change clears the persisted store, not just the in-memory Map', () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();

        // Seed the invalidation baseline under the sword, then persist a sim
        labyrinthClearRate._invalidateIfInputsChanged();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);
        // What the end of a search does; a lone entry otherwise lands a second later
        labyrinthClearRate._flushCombatCache();
        expect(db.map.get('labyrinth:labyrinthCombatSimCache_me').entries).toHaveLength(1);

        // Swap gear and re-check — this is the same path a real loadout
        // snapshot rebuild drives
        setGear({ 1: axe });
        const stale = labyrinthClearRate._invalidateIfInputsChanged();

        expect(stale).toBe(true);
        expect(labyrinthClearRate.combatCache.size).toBe(0);
        expect(db.map.get('labyrinth:labyrinthCombatSimCache_me').entries).toHaveLength(0);
    });

    test('a precision-only clear leaves the persisted store alone', () => {
        const key = 'imp:200:1:1pp:';
        const result = simResult();
        labyrinthClearRate._invalidateIfInputsChanged();
        labyrinthClearRate.combatCache.set(key, result);
        labyrinthClearRate._persistCombatCacheEntry(key, result);
        // What the end of a search does; a lone entry otherwise lands a second later
        labyrinthClearRate._flushCombatCache();

        // Mirrors what the precision-input handler does: only the in-memory
        // Map is wiped, because a different mode simply uses a different key
        labyrinthClearRate.combatCache.clear();

        expect(db.map.get('labyrinth:labyrinthCombatSimCache_me').entries).toHaveLength(1);
    });

    test('caps the persisted set to the most recent entries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 1));

        const total = 205;
        for (let i = 0; i < total; i++) {
            const key = `imp:${i}:1:1pp:`;
            const result = simResult({ roomLevel: i });
            labyrinthClearRate.combatCache.set(key, result);
            labyrinthClearRate._persistCombatCacheEntry(key, result);
            // Each second of quiet flushes the entries so far, as a real search would
            vi.advanceTimersByTime(1000);
        }

        const stored = db.map.get('labyrinth:labyrinthCombatSimCache_me');
        expect(stored.entries).toHaveLength(200);
        expect(labyrinthClearRate._combatCacheMeta.size).toBe(200);

        // The newest 200 survive, not an arbitrary 200 — the earliest 5 keys
        // (imp:0 through imp:4) are the ones the cap should have pushed out
        const keys = new Set(stored.entries.map((e) => e.key));
        expect(keys.has('imp:0:1:1pp:')).toBe(false);
        expect(keys.has('imp:4:1:1pp:')).toBe(false);
        expect(keys.has('imp:204:1:1pp:')).toBe(true);
    });

    describe('cache age display', () => {
        beforeEach(() => {
            document.body.innerHTML = '';
        });

        test('cacheAgeLabel reads back a relative age', () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
            const computedAt = Date.now() - 2 * 60 * 60 * 1000;
            expect(labyrinthClearRate.cacheAgeLabel(computedAt)).toBe('cached 2h 0m ago');
        });

        test('a fresh (non-persisted) result gets no age note', () => {
            const el = document.createElement('div');
            labyrinthClearRate._appendCacheAgeNote(el, simResult());
            expect(el.textContent).toBe('');
        });

        test('a persisted result gets a subtle one-line age note', () => {
            const el = document.createElement('div');
            labyrinthClearRate._appendCacheAgeNote(el, {
                ...simResult(),
                fromPersistedCache: true,
                computedAt: Date.now() - 60 * 60 * 1000,
            });
            expect(el.children).toHaveLength(1);
            expect(el.textContent).toContain('cached');
            expect(el.textContent).toContain('ago');
        });
    });
});

const { default: dataManagerMock } = await import('../../core/data-manager.js');

describe('guild buffs in skilling metrics', () => {
    const EFFICIENCY_SHRINE = {
        hrid: '/guild_buffs/force_skilling',
        isCombat: false,
        buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.02, flatBoostLevelBonus: 0.02 }],
    };

    beforeEach(() => {
        shrines.detailMap = { '/guild_buffs/force_skilling': EFFICIENCY_SHRINE };
        shrines.owned = { '/guild_buffs/force_skilling': 2 };
        dataManagerMock.characterData = {
            guildActionTypeBuffsMap: {
                '/action_types/milking': [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.04, ratioBoost: 0 }],
            },
        };
    });

    afterEach(() => {
        dataManagerMock.characterData = null;
    });

    test('the character’s live guild buffs are used when no levels are being explored', () => {
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {});
        expect(metrics.efficiencyBonus).toBeCloseTo(0.04, 10);
    });

    test('a level the character already owns changes nothing — the server’s own numbers stand', () => {
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {
            guildShrineLevels: { '/guild_buffs/force_skilling': 2 },
        });
        expect(metrics.efficiencyBonus).toBeCloseTo(0.04, 10);
    });

    test('a different level rebuilds that shrine, replacing rather than stacking', () => {
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {
            guildShrineLevels: { '/guild_buffs/force_skilling': 3 },
        });
        // 0.02 × 3, in place of the 0.04 the server sent for level 2
        expect(metrics.efficiencyBonus).toBeCloseTo(0.06, 10);
    });

    test('a combat shrine is never applied to a skilling room', () => {
        shrines.detailMap['/guild_buffs/force_combat'] = {
            hrid: '/guild_buffs/force_combat',
            isCombat: true,
            buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 5, flatBoostLevelBonus: 5 }],
        };
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {
            guildShrineLevels: { '/guild_buffs/force_combat': 9 },
        });
        expect(metrics.efficiencyBonus).toBeCloseTo(0.04, 10);
    });
});

describe('equipment experience reaches a labyrinth room', () => {
    beforeEach(() => {
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        gear.snapshots[3] = {
            equipment: [
                { itemHrid: '/items/philosophers_necklace', itemLocationHrid: '/item_locations/neck' },
                { itemHrid: '/items/celestial_shears', itemLocationHrid: '/item_locations/milking_tool' },
            ],
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: {
                '/items/philosophers_necklace': {
                    equipmentDetail: { noncombatStats: { skillingExperience: 0.1 } },
                },
                '/items/celestial_shears': {
                    equipmentDetail: { noncombatStats: { milkingExperience: 0.05, milkingSpeed: 0.2 } },
                },
            },
            enhancementLevelTotalBonusMultiplierTable: {},
        });
    });

    afterEach(() => {
        dataManagerMock.getInitClientData.mockReturnValue(null);
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
    });

    test('wisdom and the skill charm come out as one wisdom buff', () => {
        const buffs = labyrinthClearRate.getLoadoutEquipmentBuffs(3, 'milking');
        const wisdom = buffs.find((b) => b.typeHrid === '/buff_types/wisdom');
        // 0.1 universal + 0.05 skill-specific, additive as everywhere else
        expect(wisdom.flatBoost).toBeCloseTo(0.15, 10);
    });

    test('applyBuff routes it to experienceBonus, so xpPerRoom sees it', () => {
        const metrics = { experienceBonus: 0 };
        for (const buff of labyrinthClearRate.getLoadoutEquipmentBuffs(3, 'milking')) {
            labyrinthClearRate.applyBuff(
                metrics,
                buff.typeHrid,
                (buff.flatBoost || 0) + (buff.ratioBoost || 0),
                '/buff_types/milking_level',
                '/buff_types/milking_success',
                'milking'
            );
        }
        expect(metrics.experienceBonus).toBeCloseTo(0.15, 10);
    });

    test('gear with no experience stat emits no wisdom buff at all', () => {
        gear.snapshots[3] = {
            equipment: [{ itemHrid: '/items/celestial_shears', itemLocationHrid: '/item_locations/milking_tool' }],
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: {
                '/items/celestial_shears': { equipmentDetail: { noncombatStats: { milkingSpeed: 0.2 } } },
            },
            enhancementLevelTotalBonusMultiplierTable: {},
        });
        const buffs = labyrinthClearRate.getLoadoutEquipmentBuffs(3, 'milking');
        expect(buffs.some((b) => b.typeHrid === '/buff_types/wisdom')).toBe(false);
    });
});

describe('the community buffs the server is running reach a labyrinth room', () => {
    // The map the metrics used to read is written once, from the login payload,
    // and never again — while `characterData.communityBuffs`, which is what
    // `getCommunityBuffLevel` reads, is replaced on every donation. So the two
    // are set to *different* levels here: only a reading off the live one can
    // tell them apart.
    beforeEach(() => {
        community.levels = {};
        dataManagerMock.characterData = {
            communityActionTypeBuffsMap: {
                '/action_types/milking': [{ typeHrid: '/buff_types/gathering', flatBoost: 999, ratioBoost: 0 }],
            },
        };
    });

    afterEach(() => {
        community.levels = {};
        dataManagerMock.characterData = null;
        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('a skilling room is scored on the live level, not the one frozen at login', () => {
        community.levels['/community_buff_types/gathering_quantity'] = 5;

        const metrics = labyrinthClearRate.getSkillingMetrics('milking', '/action_types/milking');

        // Gathering Quantity Lv5 is 0.2 + 4 × 0.005 = 0.22, and the stale map's
        // absurd 999 is nowhere in it
        expect(metrics.gatheringBonus).toBeCloseTo(0.22, 10);
    });

    test('a buff that is not running adds nothing', () => {
        const metrics = labyrinthClearRate.getSkillingMetrics('milking', '/action_types/milking');
        expect(metrics.gatheringBonus).toBe(0);
    });

    test('the Experience buff lands on the experience bonus a room’s award is raised by', () => {
        community.levels['/community_buff_types/experience'] = 1;

        const metrics = labyrinthClearRate.getSkillingMetrics('milking', '/action_types/milking');

        expect(metrics.experienceBonus).toBeCloseTo(0.2, 10);
    });

    test('and a fight’s award is raised by the same buff, which it used to ignore', () => {
        community.levels['/community_buff_types/experience'] = 11;

        // 0.2 + 10 × 0.005
        expect(labyrinthClearRate.getCombatExperienceBonus()).toBeCloseTo(0.25, 10);
    });

    test('the game’s own numbers win over the fallbacks when they have loaded', () => {
        community.levels['/community_buff_types/experience'] = 3;
        dataManagerMock.getInitClientData.mockReturnValue({
            communityBuffTypeDetailMap: {
                '/community_buff_types/experience': { buff: { flatBoost: 0.5, flatBoostLevelBonus: 0.1 } },
            },
        });

        expect(labyrinthClearRate.getCombatExperienceBonus()).toBeCloseTo(0.7, 10);
    });

    test('a fight with no buff running is still only its labyrinth upgrade', () => {
        expect(labyrinthClearRate.getCombatExperienceBonus()).toBe(0);
    });
});

describe('the Moo Pass reaches an edited loadout the way it reaches a live one', () => {
    afterEach(() => {
        dataManagerMock.characterData = null;
    });

    test('its wisdom is scored even though nothing in the overrides carries it', () => {
        dataManagerMock.characterData = {
            mooPassActionTypeBuffsMap: {
                '/action_types/milking': [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05, ratioBoost: 0 }],
            },
        };

        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides('milking', '/action_types/milking', {});

        expect(metrics.experienceBonus).toBeCloseTo(0.05, 10);
    });
});

describe('enhancing rooms report what they pay', () => {
    const metrics = {
        skillLevelBonus: 0,
        efficiencyBonus: 0,
        actionSpeedBonus: 0,
        successBonus: 0,
        doubleProgressBonus: 0,
        experienceBonus: 0,
    };

    test('xpPerRoom follows the same level × 50 award every other room type uses', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams({ ...metrics }, 200, 100);
        expect(result.xpPerRoom).toBeCloseTo(100 * 50, 6);
    });

    test('wisdom raises it', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams(
            { ...metrics, experienceBonus: 0.2 },
            200,
            100
        );
        expect(result.xpPerRoom).toBeCloseTo(100 * 50 * 1.2, 6);
    });

    test('a room that clears reports an hourly rate too, so it can be ranked', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams({ ...metrics }, 200, 100);
        expect(result.clearChance).toBeGreaterThan(0);
        expect(result.xpPerHour).toBeGreaterThan(0);
    });
});

describe('official labyrinth skilling formulas', () => {
    const metrics = (over = {}) => ({
        skillLevelBonus: 0,
        efficiencyBonus: 0,
        actionSpeedBonus: 0,
        successBonus: 0,
        doubleProgressBonus: 0,
        gatheringBonus: 0,
        experienceBonus: 0,
        ...over,
    });

    const clear = (over, baseLevel, roomLevel) =>
        labyrinthClearRate.computeSkillingClearWithParams(metrics(over), baseLevel, roomLevel);

    describe('SkillingSuccessRate = MAX(5%, 0.80 × (1 + LevelBonus + Buffs))', () => {
        test('at the room level it is the flat 80%', () => {
            expect(clear({}, 100, 100).successChance).toBeCloseTo(0.8, 10);
        });

        test('every level above the room is worth +0.5%, not +1%', () => {
            // 20 over: 0.80 × (1 + 20 × 0.005) = 0.88
            expect(clear({}, 120, 100).successChance).toBeCloseTo(0.88, 10);
        });

        test('every level below the room costs −1%, twice what a level above pays', () => {
            // 20 under: 0.80 × (1 − 20 × 0.01) = 0.64
            expect(clear({}, 80, 100).successChance).toBeCloseTo(0.64, 10);
        });

        test('buffs add inside the bracket alongside the level bonus', () => {
            // 0.80 × (1 + 20 × 0.005 + 0.25) = 1.08 → capped at 100%
            expect(clear({ successBonus: 0.25 }, 120, 100).successChance).toBeCloseTo(1, 10);
            // 0.80 × (1 − 20 × 0.01 + 0.25) = 0.84
            expect(clear({ successBonus: 0.25 }, 80, 100).successChance).toBeCloseTo(0.84, 10);
        });

        test('the 5% floor holds however far under the room you are', () => {
            // 0.80 × (1 − 200 × 0.01) = −0.80, which is not what the game does
            expect(clear({}, 1, 201).successChance).toBeCloseTo(0.05, 10);
            expect(clear({}, 50, 500).successChance).toBeCloseTo(0.05, 10);
        });

        test('a level bonus that lands just above the floor is not raised to it', () => {
            // 0.80 × (1 − 93 × 0.01) = 0.056, above the 5% floor and left alone
            expect(clear({}, 7, 100).successChance).toBeCloseTo(0.056, 10);
        });
    });

    describe('WorkPower = EffectiveLevel × (1 + Efficiency)', () => {
        test('efficiency multiplies the effective level, and progress is its floor', () => {
            const result = clear({ efficiencyBonus: 0.37 }, 100, 80);
            expect(result.workPower).toBeCloseTo(137, 10);
            expect(result.progressPerSuccess).toBe(137);
        });

        test('a level buff feeds effective level, so it lands inside the product', () => {
            const result = clear({ skillLevelBonus: 15, efficiencyBonus: 0.1 }, 100, 80);
            expect(result.effectiveLevel).toBe(115);
            expect(result.workPower).toBeCloseTo(126.5, 10);
            // Progress per success is whole, so 126.5 spends as 126
            expect(result.progressPerSuccess).toBe(126);
        });

        test('the room asks for RoomLevel × 10 progress', () => {
            expect(clear({}, 100, 80).targetProgress).toBe(800);
        });
    });

    describe('DoubleProgress = Crate + Gathering + Upgrade', () => {
        const applyGathering = (skillId) => {
            const m = { doubleProgressBonus: 0, gatheringBonus: 0, experienceBonus: 0, successBonus: 0 };
            labyrinthClearRate.applyBuff(
                m,
                '/buff_types/gathering',
                0.15,
                `/buff_types/${skillId}_level`,
                `/buff_types/${skillId}_success`,
                skillId
            );
            return m;
        };

        test('the gathering buff counts in the three gathering skills', () => {
            for (const skillId of ['milking', 'foraging', 'woodcutting']) {
                expect(applyGathering(skillId).gatheringBonus).toBeCloseTo(0.15, 10);
            }
        });

        test('it does not count anywhere else — cheesesmithing has no gathering quantity', () => {
            for (const skillId of ['cheesesmithing', 'cooking', 'brewing', 'tailoring']) {
                expect(applyGathering(skillId).gatheringBonus).toBe(0);
            }
        });

        test('the crate and upgrade terms add to the gathering one', () => {
            expect(clear({ doubleProgressBonus: 0.2, gatheringBonus: 0.15 }, 100, 80).doubleChance).toBeCloseTo(
                0.35,
                10
            );
        });
    });

    describe('Experience = RoomLevel × 50', () => {
        test('a skilling room pays its own level, not the character’s', () => {
            expect(clear({}, 250, 80).xpPerRoom).toBeCloseTo(4000, 6);
        });

        test('an enhancing room uses the identical formula', () => {
            const enhancing = labyrinthClearRate.computeEnhancingClearWithParams(metrics(), 250, 80);
            expect(enhancing.xpPerRoom).toBeCloseTo(4000, 6);
        });
    });
});

describe('expected token and box rows', () => {
    /** Collect the rows appendExpectedRows produces */
    function rows(result) {
        const collected = [];
        labyrinthClearRate.appendExpectedRows((label, value, title) => collected.push({ label, value, title }), result);
        return collected;
    }

    afterEach(() => {
        labyrinthClearRate.currentFloor = 0;
    });

    test('a challenge room you always clear is worth the full drop rate', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token, box] = rows({ type: 'combat', clearChance: 1 });
        expect(token.value).toBe('0.20');
        expect(box.value).toBe('0.04');
        expect(box.label).toBe('Combat Box Expected');
    });

    test('a room you clear a quarter of the time is worth a quarter of it', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token, box] = rows({ type: 'skilling', clearChance: 0.25 });
        expect(token.value).toBe('0.05');
        expect(box.value).toBe('0.01');
        expect(box.label).toBe('Skilling Box Expected');
    });

    test('the rates cite the official rule, and the weighting is explained', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token] = rows({ type: 'combat', clearChance: 0.5 });
        expect(token.title).toContain('MIN(Floor × 5%, 50%)');
        expect(token.title).toContain('50% clear chance');
    });

    test('a caller with no clear chance gets the unweighted rate rather than nothing', () => {
        labyrinthClearRate.currentFloor = 4;
        const [token] = rows('combat');
        expect(token.value).toBe('0.20');
    });

    test('a treasure room pays its whole table — no clear is asked of you', () => {
        labyrinthClearRate.currentFloor = 6;
        const [token, skilling, combat] = rows({ type: 'treasure', clearChance: 0.25 });
        expect(token.value).toBe('6.00');
        expect(skilling.label).toBe('Skilling Box Expected');
        expect(skilling.value).toBe('0.30');
        expect(combat.label).toBe('Combat Box Expected');
        expect(combat.value).toBe('0.30');
    });

    test('the floor exit pays tokens, both boxes and a refinement chest', () => {
        labyrinthClearRate.currentFloor = 8;
        const [token, skilling, combat, chest] = rows({ type: 'exit' });
        expect(token.value).toBe('40.00');
        expect(skilling.value).toBe('2.50');
        expect(combat.value).toBe('2.50');
        expect(chest.label).toBe('Refinement Chest Expected');
        expect(chest.value).toBe('2.00');
    });

    test('floor 0 has no rewards to expect', () => {
        labyrinthClearRate.currentFloor = 0;
        expect(rows({ type: 'combat', clearChance: 1 })).toHaveLength(0);
    });
});

describe('effective combat level', () => {
    const skillList = (over = {}) => {
        const levels = { stamina: 100, intelligence: 100, attack: 100, defense: 100, melee: 100, ...over };
        return Object.entries(levels).map(([name, level]) => ({ skillHrid: `/skills/${name}`, level }));
    };

    beforeEach(() => {
        dataManagerMock.getSkills.mockReturnValue(skillList());
        dataManagerMock.characterData = null;
        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    afterEach(() => {
        dataManagerMock.getSkills.mockReturnValue([]);
        dataManagerMock.getInitClientData.mockReturnValue(null);
        dataManagerMock.characterData = null;
    });

    test('falls back to the game’s own formula rather than a hardcoded 100', () => {
        // 0.1 × (100 × 5) + 0.5 × 100 = 100 for this build; make it not-100 so
        // a surviving constant would be visible
        dataManagerMock.getSkills.mockReturnValue(skillList({ melee: 60, attack: 60, defense: 60 }));
        // 0.1 × (100 + 100 + 60 + 60 + 60) + 0.5 × 60 = 38 + 30 = 68
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBe(68);
    });

    test('the server’s figure wins when it is there', () => {
        dataManagerMock.characterData = { combatUnit: { combatDetails: { combatLevel: 137.4 } } };
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBe(137);
    });

    test('no character data at all gives null, not an invented level', () => {
        dataManagerMock.getSkills.mockReturnValue([]);
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBeNull();
    });

    test('a crate’s per-skill levels are weighted by the formula, not averaged', () => {
        dataManagerMock.characterData = {
            characterLabyrinth: { coffeeCrateItemHrid: '/items/crate' },
            combatUnit: { combatDetails: { combatLevel: 100 } },
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            labyrinthCrateDetailMap: {
                '/items/crate': [
                    { typeHrid: '/buff_types/melee_level', flatBoost: 10, ratioBoost: 0 },
                    { typeHrid: '/buff_types/stamina_level', flatBoost: 10, ratioBoost: 0 },
                ],
            },
        });
        // Melee carries the doubled term (0.6 each) and stamina only the flat
        // one (0.1 each): 6 + 1 = 7. Averaging the two +10s gave 10.
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBeCloseTo(107, 6);
    });

    test('a direct combat_level buff still moves it one-for-one', () => {
        dataManagerMock.characterData = {
            characterLabyrinth: { coffeeCrateItemHrid: '/items/crate' },
            combatUnit: { combatDetails: { combatLevel: 100 } },
        };
        dataManagerMock.getInitClientData.mockReturnValue({
            labyrinthCrateDetailMap: {
                '/items/crate': [{ typeHrid: '/buff_types/combat_level', flatBoost: 5, ratioBoost: 0 }],
            },
        });
        expect(labyrinthClearRate.getPlayerEffectiveCombatLevel()).toBeCloseTo(105, 6);
    });
});

describe('the recommend panel’s target win %', () => {
    beforeEach(() => {
        settings.map.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        settings.map.clear();
    });

    test('reading it writes it back, so it survives a reload like the path panel’s does', () => {
        document.body.innerHTML = '<input id="mwi-recommend-target-rate" value="88">';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(88);
        expect(settings.map.get('labyrinthRecommendTargetRate')).toBe(88);
    });

    test('an out-of-range entry is clamped in the field as well as in the answer', () => {
        document.body.innerHTML = '<input id="mwi-recommend-target-rate" value="480">';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(100);
        expect(document.getElementById('mwi-recommend-target-rate').value).toBe('100');
    });

    test('an empty field falls back to the stored setting, not to a constant', () => {
        settings.map.set('labyrinthRecommendTargetRate', 55);
        document.body.innerHTML = '<input id="mwi-recommend-target-rate" value="">';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(55);
    });

    test('with nothing stored at all it uses the schema default', () => {
        document.body.innerHTML = '';
        expect(labyrinthClearRate.getRecommendTargetPct()).toBe(70);
    });
});

describe('a recommend run keeps the combat cache', () => {
    beforeEach(() => {
        db.map.clear();
        settings.map.clear();
        document.body.innerHTML = '';
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate.recommendRunning = false;
    });

    afterEach(() => {
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        document.body.innerHTML = '';
    });

    test('sims read back off disk survive pressing Recommend', async () => {
        const key = 'imp:200:1:1pp:';
        labyrinthClearRate.combatCache.set(key, { clearChance: 0.8, expectedSeconds: 10, type: 'combat' });

        // No room cells in the document, so the run finds nothing to do — the
        // question is only what it destroys on the way in
        await labyrinthClearRate.runRecommendations();

        expect(labyrinthClearRate.combatCache.has(key)).toBe(true);
    });
});

describe('per-character fight outcomes', () => {
    beforeEach(() => {
        db.map.clear();
        db.unavailable = false;
        db.hold = null;
        labyrinthClearRate.forgetOutcomes();
    });

    test('outcomes are written under this character’s key', async () => {
        labyrinthClearRate._outcomes = { '/monsters/imp:200': { wins: 3, fights: 4 } };
        await labyrinthClearRate.saveOutcomes();

        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(true);
        expect(db.map.has('settings:labyrinthFightOutcomes')).toBe(false);
    });

    test('a load reads only this character’s record', async () => {
        db.map.set('settings:labyrinthFightOutcomes_me', {
            version: 2,
            totals: { mine: { wins: 1, fights: 1 } },
        });
        db.map.set('settings:labyrinthFightOutcomes_other', {
            version: 2,
            totals: { theirs: { wins: 9, fights: 9 } },
        });

        await labyrinthClearRate.loadOutcomes();

        expect(labyrinthClearRate._outcomes).toEqual({ mine: { wins: 1, fights: 1 } });
    });

    test('a legacy global record is discarded rather than inherited', async () => {
        // A win rate is a measurement of one character's power against a room.
        // Handing it to another character would poison every verdict from there
        // on, so the pre-scoping value is dropped and counting starts again.
        db.map.set('settings:labyrinthFightOutcomes', {
            version: 2,
            totals: { '/monsters/imp:200': { wins: 40, fights: 40 } },
        });

        await labyrinthClearRate.loadOutcomes();

        expect(labyrinthClearRate._outcomes).toEqual({});
        expect(db.map.has('settings:labyrinthFightOutcomes')).toBe(false);
        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(false);
    });

    test('a load that cannot read storage keeps the totals in memory and retries later', async () => {
        db.map.set('settings:labyrinthFightOutcomes_me', {
            version: 2,
            totals: { theirs: { attempts: 5, clears: 1 } },
        });
        labyrinthClearRate._outcomes = { mine: { attempts: 1, clears: 1 } };
        db.unavailable = true;

        await labyrinthClearRate.loadOutcomes();

        expect(labyrinthClearRate._outcomes).toEqual({ mine: { attempts: 1, clears: 1 } });
        expect(labyrinthClearRate._outcomesLoaded).toBe(false);

        db.unavailable = false;
        await labyrinthClearRate.loadOutcomes();
        expect(Object.keys(labyrinthClearRate._outcomes).sort()).toEqual(['mine', 'theirs']);
        expect(labyrinthClearRate._outcomesLoaded).toBe(true);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        db.map.set('settings:labyrinthFightOutcomes_me', {
            version: 2,
            totals: { theirs: { attempts: 5, clears: 1 } },
        });
        labyrinthClearRate._outcomes = { mine: { attempts: 1, clears: 1 } };
        db.unavailable = true;

        expect(await labyrinthClearRate.saveOutcomes()).toBe(false);

        expect(db.map.get('settings:labyrinthFightOutcomes_me').totals).toEqual({ theirs: { attempts: 5, clears: 1 } });
        expect(labyrinthClearRate._outcomes).toEqual({ mine: { attempts: 1, clears: 1 } });
    });

    test('a save folds in rooms another tab stored, the fuller count of a shared room winning', async () => {
        await labyrinthClearRate.loadOutcomes();
        labyrinthClearRate._outcomes = { shared: { attempts: 2, clears: 1 }, mine: { attempts: 1, clears: 0 } };
        db.map.set('settings:labyrinthFightOutcomes_me', {
            version: 2,
            totals: { shared: { attempts: 6, clears: 3 }, theirs: { attempts: 1, clears: 1 } },
        });

        await labyrinthClearRate.saveOutcomes();

        const written = db.map.get('settings:labyrinthFightOutcomes_me').totals;
        expect(written).toEqual({
            shared: { attempts: 6, clears: 3 },
            mine: { attempts: 1, clears: 0 },
            theirs: { attempts: 1, clears: 1 },
        });
        expect(labyrinthClearRate._outcomes).toEqual(written);
    });

    test('once storage reads again the next save lands everything', async () => {
        db.unavailable = true;
        labyrinthClearRate._outcomes = { mine: { attempts: 1, clears: 0 } };
        await labyrinthClearRate.saveOutcomes();
        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(false);

        db.unavailable = false;
        labyrinthClearRate._outcomes.mine = { attempts: 2, clears: 1 };
        await labyrinthClearRate.saveOutcomes();

        expect(db.map.get('settings:labyrinthFightOutcomes_me').totals).toEqual({ mine: { attempts: 2, clears: 1 } });
    });

    test("a switch during the load keeps the departing character's room out of the arriving character's record", async () => {
        // A room finished on the market cow, still folding when the player
        // moves to the iron cow. `forgetOutcomes()` has emptied the totals for
        // the arriving character; the fold that resumes must not put the
        // departing character's room straight back into them.
        let release;
        db.hold = new Promise((resolve) => {
            release = resolve;
        });
        const recording = labyrinthClearRate.recordRoomResult({
            subjectHrid: '/monsters/imp',
            roomLevel: 200,
            kind: 'combat',
            actions: 10,
            successes: 6,
        });

        labyrinthClearRate.forgetOutcomes();
        db.hold = null;
        release();
        await recording;

        expect(labyrinthClearRate._outcomes).toEqual({});
        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(false);
    });

    test("a switch during the load keeps the departing character's floor out of the arriving character's totals", async () => {
        let release;
        db.hold = new Promise((resolve) => {
            release = resolve;
        });
        const recording = labyrinthClearRate.recordOutcomes({
            startedAt: 1,
            currentFloor: 3,
            roomData: [[{ monsterHrid: '/monsters/imp', recommendedLevel: 200, entryCount: 4, isCleared: true }]],
        });

        labyrinthClearRate.forgetOutcomes();
        db.hold = null;
        release();
        await recording;

        expect(labyrinthClearRate._outcomes).toEqual({});
        expect(labyrinthClearRate._outcomesSeen).toEqual({});
        expect(db.map.has('settings:labyrinthFightOutcomes_me')).toBe(false);
    });

    test('a reset is the one overwrite: it drops what is stored', async () => {
        db.map.set('settings:labyrinthFightOutcomes_me', {
            version: 2,
            totals: { theirs: { attempts: 5, clears: 1 } },
        });

        await labyrinthClearRate.resetOutcomes();

        expect(db.map.get('settings:labyrinthFightOutcomes_me').totals).toEqual({});
    });

    test('a stored document of an older version is dropped rather than merged', async () => {
        db.map.set('settings:labyrinthFightOutcomes_me', { version: 1, totals: { old: { attempts: 9, clears: 9 } } });
        labyrinthClearRate._outcomes = { mine: { attempts: 1, clears: 1 } };

        await labyrinthClearRate.saveOutcomes();

        expect(db.map.get('settings:labyrinthFightOutcomes_me').totals).toEqual({ mine: { attempts: 1, clears: 1 } });
    });

    test('the legacy combat sim cache is discarded too', async () => {
        db.map.set('labyrinth:labyrinthCombatSimCache', {
            version: 1,
            entries: [{ key: 'imp:200:1:1pp:', result: {}, computedAt: Date.now(), snapshotFingerprint: 'x' }],
        });
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.size).toBe(0);
        expect(db.map.has('labyrinth:labyrinthCombatSimCache')).toBe(false);
    });
});

/**
 * The one thing splitting the module into mixins newly makes possible to get
 * wrong: a method group that never reaches the prototype, or two groups that
 * both claim a name and silently overwrite one another. Neither shows up in an
 * arithmetic test — the call just lands on `undefined`, or on the wrong body.
 */
const { outcomeMethods } = await import('./labyrinth-outcomes.js');
const { simCacheMethods } = await import('./labyrinth-sim-cache.js');
const { recommendationMethods } = await import('./labyrinth-recommendation.js');

describe('the mixin groups reach the singleton intact', () => {
    test('every method each group exports is callable on the singleton', () => {
        const groups = { outcomes: outcomeMethods, simCache: simCacheMethods, recommendation: recommendationMethods };

        for (const [name, methods] of Object.entries(groups)) {
            const missing = Object.keys(methods).filter((key) => typeof labyrinthClearRate[key] !== 'function');
            expect(`${name}: ${missing.join(', ')}`).toBe(`${name}: `);
        }
    });

    test('no two groups claim the same method name', () => {
        const groups = [outcomeMethods, simCacheMethods, recommendationMethods];

        const seen = new Set();
        const clashes = [];
        for (const methods of groups) {
            for (const key of Object.keys(methods)) {
                if (seen.has(key)) clashes.push(key);
                seen.add(key);
            }
        }
        expect(clashes).toEqual([]);
    });

    test('the class body keeps its own methods — nothing was assigned over them', () => {
        // A group that grew a name the entry module already defines would win
        // the Object.assign and quietly replace the panel's own version
        const groupKeys = new Set([
            ...Object.keys(outcomeMethods),
            ...Object.keys(simCacheMethods),
            ...Object.keys(recommendationMethods),
        ]);
        for (const key of ['initialize', 'disable', 'injectOverlays', 'computeSkillingClear', 'buildResult']) {
            expect(typeof labyrinthClearRate[key]).toBe('function');
            expect(groupKeys.has(key)).toBe(false);
        }
    });
});

/**
 * The planners used to answer as though the shop were free: a floor could be
 * told it needed thirteen shrouds while two sat in the bag, with nothing said.
 * These drive the real planner methods over a fixture grid and read the status
 * line they leave behind.
 */
describe('planning against the supplies actually held', () => {
    const supplyItem = (itemHrid, count) => ({
        itemHrid,
        count,
        enhancementLevel: 0,
        itemLocationHrid: '/item_locations/inventory',
    });

    /** A square grid of unrevealed rooms, plus the toolbar the planners write to */
    function buildGrid(side) {
        document.body.innerHTML = '';
        const parent = document.createElement('div');
        for (let i = 0; i < side * side; i++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell_abc';
            parent.appendChild(cell);
        }
        document.body.appendChild(parent);

        const status = document.createElement('span');
        status.className = 'mwi-labyrinth-tile-controls-status';
        document.body.appendChild(status);

        labyrinthClearRate.roomData = Array.from({ length: side }, () => new Array(side).fill(null));
        labyrinthClearRate.currentFloor = 5;
        return status;
    }

    const beaconInput = (value) => {
        const input = document.createElement('input');
        input.className = 'mwi-labyrinth-tile-controls-beacon-count';
        input.value = String(value);
        document.body.appendChild(input);
        return input;
    };

    beforeEach(() => {
        settings.map.clear();
        market.loaded = false;
        market.prices = {};
        bag.items = [
            supplyItem('/items/expert_torch', 43),
            supplyItem('/items/expert_shroud', 2),
            supplyItem('/items/advanced_beacon', 3),
        ];
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.roomData = null;
        bag.items = null;
    });

    test('reads the held counts off the inventory', () => {
        expect(labyrinthClearRate.getSupplyCounts()).toMatchObject({ torch: 43, shroud: 2, beacon: 3, known: true });
    });

    // Path calculation only ever runs against a grid on screen — which is a
    // run going, by the same test the supply reader uses (`roomData` present).
    // So every one of these already exercises the mid-run case the bug report
    // was about: a plan drawn while a run is active, whose "buy more" used to
    // suggest a purchase the run itself could never benefit from.
    test('a path needing more shrouds than are held says so without pricing a buy-now purchase', async () => {
        const status = buildGrid(4);

        await labyrinthClearRate.runPathCalculation();

        // Every unrevealed room on the route costs a shroud under the default
        // ? mode, which is exactly how a two-shroud bag meets a five-shroud plan.
        // "left this run" replaces "owned" here — the pile in view is the run's,
        // and mid-run nothing can be bought to grow it before the run ends.
        expect(status.textContent).toMatch(/\d+ shrouds needed · 2 left this run/);
        // Mid-run there is no restock note at all: buying cannot change this
        // run, and the next run's bag is not this summary's business
        expect(status.textContent).not.toContain('restock');
        expect(status.textContent).not.toContain('at ask');
        expect(status.style.color).toBe('#ff8a80');
    });

    test('a path it can afford is not nagged about supplies', async () => {
        bag.items = [supplyItem('/items/expert_torch', 43), supplyItem('/items/expert_shroud', 99)];
        const status = buildGrid(4);

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).not.toContain('owned');
        expect(status.textContent).not.toContain('left this run');
        expect(status.textContent).not.toContain('restock');
        expect(status.style.color).toBe('');
    });

    test('the shortfall separates confirmed shrouds from ones the ? mode assumed', async () => {
        const status = buildGrid(4);

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).toContain('assumed for unrevealed rooms');
    });

    test('mid-run, a priced shortfall quotes nothing — not this run, not the next', async () => {
        const status = buildGrid(4);
        market.loaded = true;
        market.prices = { '/items/basic_shroud': { ask: 1000 }, '/items/expert_shroud': { ask: 5000 } };

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).toMatch(/\d+ shrouds needed · 2 left this run/);
        expect(status.textContent).not.toContain('restock');
        expect(status.textContent).not.toContain('for next run');
        expect(status.textContent).not.toContain('at ask');
    });

    test('mid-run, what the bag already holds counts toward the NEXT run and can clear the shortfall entirely', async () => {
        const status = buildGrid(4);
        // The run's own stock reads as zero (a payload that names the kind but
        // carries none of it), while the bag — what the next run draws from —
        // holds plenty. No price should be quoted when the bag alone covers it.
        labyrinthClearRate._labyrinth = {
            roomData: [[{ roomType: '/labyrinth_room_types/combat' }]],
            supplyItemCountMap: { '/items/expert_shroud': 0 },
        };
        bag.items = [supplyItem('/items/expert_torch', 43), supplyItem('/items/expert_shroud', 999)];
        market.loaded = true;
        market.prices = { '/items/expert_shroud': { ask: 5000 } };

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).toMatch(/\d+ shrouds needed · 0 left this run/);
        expect(status.textContent).not.toContain('restock');
        expect(status.textContent).not.toContain('for next run');
        expect(status.textContent).not.toContain('at ask');

        labyrinthClearRate._labyrinth = null;
    });

    // Beacon planning runs against the same on-screen grid as the path
    // calculator, so it is mid-run for the same reason: "owned" becomes
    // "left this run", and the wording is the same fix as the shroud line's.
    test('four beacons set against three left this run plans three and shows both numbers', () => {
        const status = buildGrid(6);
        const input = beaconInput(4);

        labyrinthClearRate.runBeaconCalculation();

        expect(status.textContent).toContain('(4 set / 3 left this run)');
        expect(status.textContent).not.toContain('owned');
        // The field keeps the request — it is the user's setting, not a reading
        // of the bag, and clamping it would lose it as beacons are spent
        expect(input.value).toBe('4');
        expect(document.querySelectorAll('[data-beacon-center="1"]')).toHaveLength(3);
    });

    test('owning none degrades to saying so rather than drawing a plan', () => {
        bag.items = [supplyItem('/items/expert_torch', 43)];
        const status = buildGrid(6);
        beaconInput(4);

        labyrinthClearRate.runBeaconCalculation();

        expect(status.textContent).toBe('No beacons left this run — 4 set / 0 left this run');
        expect(document.querySelectorAll('[data-beacon-center="1"]')).toHaveLength(0);
    });

    test('an unreadable inventory plans what was asked for rather than inventing a limit', () => {
        bag.items = null;
        const status = buildGrid(6);
        beaconInput(4);

        labyrinthClearRate.runBeaconCalculation();

        expect(status.textContent).not.toContain('owned');
        expect(document.querySelectorAll('[data-beacon-center="1"]')).toHaveLength(4);
    });
});

/**
 * The beacon count belongs to the floor in front of you, not to the account: a
 * count chosen because one map was worth four beacons used to follow you onto
 * every floor after it, silently. It now resets to the automatic minimum on
 * arrival, and there is a button for saying so mid-floor.
 */
describe('the beacon count as a per-floor override', () => {
    /** Just the toolbar pieces the reset touches, without the rest of the panel */
    function buildToolbar(count) {
        document.body.innerHTML = '';
        const input = document.createElement('input');
        input.className = 'mwi-labyrinth-tile-controls-beacon-count';
        input.value = String(count);
        document.body.appendChild(input);
        const status = document.createElement('span');
        status.className = 'mwi-labyrinth-tile-controls-status';
        document.body.appendChild(status);
        settings.map.set('labyrinthBeaconCount', count);
        return { input, status };
    }

    afterEach(() => {
        // onLabyrinthUpdated arms a couple of repaint timers; nothing in these
        // tests is about them, and they outlive the DOM they would draw into
        clearTimeout(labyrinthClearRate.pruneTileTimer);
        clearTimeout(labyrinthClearRate.autoTileTimer);
        labyrinthClearRate.pruneTileTimer = null;
        labyrinthClearRate.autoTileTimer = null;
        document.body.innerHTML = '';
        settings.map.clear();
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._labyrinth = null;
    });

    test('the reset button drops a manual count back to the automatic minimum', () => {
        const { input, status } = buildToolbar(4);

        expect(labyrinthClearRate.resetBeaconCountToAuto(true)).toBe(true);

        expect(input.value).toBe('0');
        expect(settings.map.get('labyrinthBeaconCount')).toBe(0);
        expect(status.textContent).toContain('min');
    });

    test('resetting what is already automatic reports no change', () => {
        const { input } = buildToolbar(0);

        expect(labyrinthClearRate.resetBeaconCountToAuto()).toBe(false);
        expect(input.value).toBe('0');
        expect(settings.map.get('labyrinthBeaconCount')).toBe(0);
    });

    test('a new floor starts back on the automatic minimum', () => {
        const { input } = buildToolbar(4);
        labyrinthClearRate.currentFloor = 3;

        labyrinthClearRate.onLabyrinthUpdated({ labyrinth: { currentFloor: 4, roomData: [[null]] } });

        expect(settings.map.get('labyrinthBeaconCount')).toBe(0);
        expect(input.value).toBe('0');
    });

    test('an update from the floor you are on leaves the count alone', () => {
        const { input } = buildToolbar(4);
        labyrinthClearRate.currentFloor = 3;

        labyrinthClearRate.onLabyrinthUpdated({ labyrinth: { currentFloor: 3, roomData: [[null]] } });

        expect(settings.map.get('labyrinthBeaconCount')).toBe(4);
        expect(input.value).toBe('4');
    });
});

/**
 * The restock helpers shared by the path and beacon planners: which tier a
 * hint prices, and whether it prices the run in view or the next one.
 *
 * Exercised directly against fabricated `supplies` fixtures rather than
 * through a running plan, so the out-of-run case gets real coverage too —
 * `runPathCalculation`/`runBeaconCalculation` can only ever run against a grid
 * on screen, which is a run going, so there is no way to drive them out of a
 * run to check that the buy-now hint still appears there. These methods are
 * exactly what those planners call, so testing them with `runActive: false`
 * is testing the out-of-run path for real, not standing in for it.
 */
describe('the shared restock helpers', () => {
    const suppliesFixture = (overrides) => ({
        torch: 0,
        shroud: 0,
        beacon: 0,
        byTier: { torch: {}, shroud: {}, beacon: {} },
        known: true,
        hrids: SUPPLY_HRIDS,
        inventory: { shroud: 0, beacon: 0, known: true, byTier: { shroud: {}, beacon: {} } },
        ...overrides,
    });

    beforeEach(() => {
        market.loaded = true;
        market.prices = { '/items/basic_shroud': { ask: 1000 }, '/items/expert_shroud': { ask: 5000 } };
    });

    afterEach(() => {
        market.loaded = false;
        market.prices = {};
    });

    test('out of a run, a shortfall is still priced as a buy-now hint', () => {
        const supplies = suppliesFixture({ shroud: 2 });
        const note = labyrinthClearRate.shortfallRestockNote(supplies, 'shroud', 3);
        expect(note).toContain('3×');
        expect(note).toContain('at ask');
    });

    test('the held tier is priced, not the cheapest one', () => {
        const supplies = suppliesFixture({
            shroud: 2,
            byTier: { torch: {}, shroud: { '/items/expert_shroud': 2 }, beacon: {} },
        });
        const note = labyrinthClearRate.shortfallRestockNote(supplies, 'shroud', 3);
        expect(note).toContain('expert shroud');
        expect(note).not.toContain('basic shroud');
    });

    test('with nothing held, the run’s own stock names the tier', () => {
        // The pile in view — the run's stock, mid-run — holds an expert
        // shroud even though the bag underneath it happens to hold none
        const supplies = suppliesFixture({
            shroud: 1,
            byTier: { torch: {}, shroud: { '/items/expert_shroud': 1 }, beacon: {} },
            inventory: { shroud: 0, beacon: 0, known: true, byTier: { shroud: {}, beacon: {} } },
        });
        expect(labyrinthClearRate.preferredSupplyTier(supplies, 'shroud')).toBe('/items/expert_shroud');
    });

    test('with the run empty, the bag still names a preferred tier', () => {
        const supplies = suppliesFixture({
            shroud: 0,
            inventory: {
                shroud: 4,
                beacon: 0,
                known: true,
                byTier: { shroud: { '/items/expert_shroud': 4 }, beacon: {} },
            },
        });
        expect(labyrinthClearRate.preferredSupplyTier(supplies, 'shroud')).toBe('/items/expert_shroud');
    });

    test('nothing indicating a preference falls back to cheapest-per-use', () => {
        const supplies = suppliesFixture({ shroud: 0 });
        expect(labyrinthClearRate.preferredSupplyTier(supplies, 'shroud')).toBeNull();
        const note = labyrinthClearRate.shortfallRestockNote(supplies, 'shroud', 3);
        expect(note).toContain('basic shroud');
    });

    test('mid-run, the next-run note counts the bag toward what is still needed', () => {
        const supplies = suppliesFixture({
            shroud: 0,
            byTier: { torch: {}, shroud: {}, beacon: {} },
            inventory: {
                shroud: 1,
                beacon: 0,
                known: true,
                byTier: { shroud: { '/items/expert_shroud': 1 }, beacon: {} },
            },
        });
        // 4 needed, 1 already in the bag toward the next run: 3 short, priced
        // against the tier the bag holds
        const note = labyrinthClearRate.nextRunRestockNote(supplies, 'shroud', 4, 'shroud');
        expect(note).toContain('3×');
        expect(note).toContain('expert shroud');
    });

    test('mid-run, a bag that already covers the need prices nothing', () => {
        const supplies = suppliesFixture({
            shroud: 0,
            inventory: { shroud: 10, beacon: 0, known: true, byTier: { shroud: {}, beacon: {} } },
        });
        expect(labyrinthClearRate.nextRunRestockNote(supplies, 'shroud', 4, 'shroud')).toBe('');
    });
});

/**
 * The toolbar's supply readout.
 *
 * Reported as "the amount of torches etc is not pulling correctly": the toolbar
 * said 260 torches while the game's own Supplies row said 40. Both were right
 * about their own pile — the game moves supplies out of the bag and into the run
 * when it starts — and the toolbar was reading the wrong one and not saying
 * which. So what is checked here is the source it picks and the label it puts on
 * it, plus that the icons beside the figures are the game's own artwork rather
 * than three emoji guessing at it.
 */
describe('the toolbar supply readout', () => {
    const supplyItem = (itemHrid, count) => ({
        itemHrid,
        count,
        itemLocationHrid: '/item_locations/inventory',
    });

    /** The span injectTileControls creates, on its own so nothing else is in the way */
    function buildReadout() {
        document.body.innerHTML = '';
        const el = document.createElement('span');
        el.className = 'mwi-labyrinth-tile-controls-supplies';
        document.body.appendChild(el);
        return el;
    }

    /** The game's Supplies row, and an item sheet for `itemIcon` to point at */
    function buildSupplyRow(entries) {
        const panel = document.createElement('div');
        panel.className = 'LabyrinthPanel_labyrinthPanel__1a2b3';
        panel.innerHTML =
            '<div><div>Supplies</div><div>' +
            entries
                .map(
                    ([id, count]) =>
                        '<div class="Item_itemContainer__x7kH1"><svg><use ' +
                        `href="/static/media/items_sprite.9c39e2ec.svg#${id}"></use></svg>` +
                        `<div class="Item_count__1HVvv">${count}</div></div>`
                )
                .join('') +
            '</div></div>';
        document.body.appendChild(panel);
        return panel;
    }

    const iconHrefs = (el) => Array.from(el.querySelectorAll('use')).map((use) => use.getAttribute('href'));

    beforeEach(() => {
        bag.items = [supplyItem('/items/expert_torch', 260), supplyItem('/items/expert_shroud', 16)];
        // `itemIcon` remembers the sheet URL it read off the page, so emptying
        // the DOM is only half of "the game has drawn no item icon yet"
        resetSpriteSheetCache();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._labyrinth = null;
        bag.items = null;
    });

    test('emoji stand in only while the game has drawn no item icon to copy a sheet from', () => {
        const el = buildReadout();

        labyrinthClearRate.refreshSupplyReadout();

        expect(iconHrefs(el)).toHaveLength(0);
        expect(el.textContent).toContain('🔥');
    });

    test('between runs it reads the bag and calls it held', () => {
        const el = buildReadout();

        labyrinthClearRate.refreshSupplyReadout();

        expect(el.textContent).toContain('held:');
        expect(el.textContent).toContain('260');
        expect(el.title).toContain('from your inventory');
    });

    test("in a run it reads the run's own stock, not the bag it came out of", () => {
        const el = buildReadout();
        labyrinthClearRate._labyrinth = {
            roomData: [[{ roomType: '/labyrinth_room_types/combat' }]],
            supplyItemCountMap: { '/items/basic_torch': 40, '/items/expert_beacon': 1 },
        };

        labyrinthClearRate.refreshSupplyReadout();

        expect(el.textContent).toContain('this run:');
        expect(el.textContent).toContain('40');
        expect(el.textContent).not.toContain('260');
        expect(el.title).toContain('carried by this run');
    });

    test("with nothing in the payload it falls back to the game's Supplies row", () => {
        const el = buildReadout();
        buildSupplyRow([
            ['basic_torch', 40],
            ['expert_beacon', 1],
        ]);
        labyrinthClearRate._labyrinth = { roomData: [[{ roomType: '/labyrinth_room_types/combat' }]] };

        labyrinthClearRate.refreshSupplyReadout();

        expect(el.textContent).toContain('this run:');
        expect(el.textContent).toContain('40');
        expect(el.textContent).not.toContain('260');
    });

    test('a run whose stock cannot be read anywhere says the figures are the bag’s', () => {
        const el = buildReadout();
        labyrinthClearRate._labyrinth = { roomData: [[{ roomType: '/labyrinth_room_types/combat' }]] };

        labyrinthClearRate.refreshSupplyReadout();

        expect(el.textContent).toContain('in bag:');
        expect(el.textContent).toContain('260');
        expect(el.title).toContain('may be carrying fewer');
    });

    test("the figures wear the game's item sprites, not emoji", () => {
        const el = buildReadout();
        // itemIcon reads the sheet's hashed URL off an icon the game has drawn
        buildSupplyRow([['basic_torch', 40]]);

        labyrinthClearRate.refreshSupplyReadout();

        const hrefs = iconHrefs(el);
        expect(hrefs).toHaveLength(3);
        // The best tier held for each kind, and the basic tier for a kind held none of
        expect(hrefs[0]).toContain('#expert_torch');
        expect(hrefs[1]).toContain('#expert_shroud');
        expect(hrefs[2]).toContain('#basic_beacon');
        expect(hrefs.every((href) => href.includes('items_sprite'))).toBe(true);
        expect(el.textContent).not.toMatch(/🔥|👻|📡/);
    });
});

/**
 * The live readout on the attempt bar, driven through the real battle_updated
 * path. The reported symptom — a percentage that "changes wildly till I open
 * the lab room tab" — had two causes, and both are checked here: the room the
 * fight is in was only knowable once a labyrinth_updated message had landed,
 * and the fallback estimate was quoted as a point figure it had not earned.
 */
describe('the live clear chance on the attempt bar', () => {
    const LIVE_SELECTOR = '.mwi-labyrinth-live-combat';

    /** The action bar the game draws for a labyrinth fight */
    function buildActionBar(text = 'Labyrinth - Mimic Lv.245') {
        document.body.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'Header_actionName_x';
        const name = document.createElement('div');
        name.className = 'Header_displayName_x';
        name.textContent = text;
        row.appendChild(name);
        document.body.appendChild(row);
        return row;
    }

    /** One battle_updated tick: fractions of max, and the attack counter */
    const tick = (monsterFraction, playerFraction, atkCounter) => ({
        battleId: 'b1',
        pMap: { 0: { cHP: Math.round(1000 * playerFraction), mHP: 1000, cMP: 500, mMP: 500, atkCounter } },
        mMap: { 0: { cHP: Math.round(2000 * monsterFraction), mHP: 2000 } },
    });

    /** A sparse delta carrying only the player — about a fifth of real ticks do */
    const playerTick = (playerFraction, atkCounter) => ({
        battleId: 'b1',
        pMap: { 0: { cHP: Math.round(1000 * playerFraction), mHP: 1000, cMP: 500, mMP: 500, atkCounter } },
    });

    /** ...and one carrying only the monster */
    const monsterTick = (monsterFraction) => ({
        battleId: 'b1',
        mMap: { 0: { cHP: Math.round(2000 * monsterFraction), mHP: 2000 } },
    });

    const liveText = () => document.querySelector(LIVE_SELECTOR)?.textContent || '';

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
        settings.map.clear();
        atk = 0;
        labyrinthClearRate._fight = null;
        labyrinthClearRate._replay = null;
        labyrinthClearRate._liveCombatDrawnAt = 0;
        labyrinthClearRate._liveNodeMaxWidth = 0;
        labyrinthClearRate._headerReadoutText = {};
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._pathData = null;
    });

    afterEach(() => {
        if (labyrinthClearRate._liveCombatTimeout) {
            clearTimeout(labyrinthClearRate._liveCombatTimeout);
            labyrinthClearRate._liveCombatTimeout = null;
        }
        if (labyrinthClearRate.liveProgressTimeout) {
            clearTimeout(labyrinthClearRate.liveProgressTimeout);
            labyrinthClearRate.liveProgressTimeout = null;
        }
        vi.useRealTimers();
        document.body.innerHTML = '';
        labyrinthClearRate._fight = null;
        labyrinthClearRate._replay = null;
        labyrinthClearRate._liveCombatDrawnAt = 0;
        labyrinthClearRate._liveNodeMaxWidth = 0;
        labyrinthClearRate._headerReadoutText = {};
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._pathData = null;
    });

    /**
     * Advance the fight, drawing a tick a second. The attack counter runs
     * across calls — a counter that went backwards is how a *new* fight is
     * detected, so restarting it would silently begin a fresh attempt.
     */
    let atk = 0;
    function runTicks(fractions) {
        for (const [monsterFraction, playerFraction] of fractions) {
            vi.advanceTimersByTime(1000);
            labyrinthClearRate._liveCombatDrawnAt = 0; // past the once-a-second draw throttle
            labyrinthClearRate.onBattleUpdated(tick(monsterFraction, playerFraction, ++atk));
        }
    }

    test('a fight whose evidence is thin is shown as a band, not a swinging figure', () => {
        buildActionBar();

        // Lumpy damage over the first few seconds: the underlying extrapolation
        // moves a long way between blows, which is exactly what was on screen
        const shown = [];
        const lumpy = [
            [0.98, 0.99],
            [0.97, 0.95],
            [0.8, 0.94],
            [0.79, 0.8],
            [0.62, 0.79],
            [0.61, 0.62],
            [0.5, 0.61],
            [0.49, 0.5],
            [0.44, 0.49],
            [0.43, 0.44],
        ];
        for (const step of lumpy) {
            runTicks([step]);
            const text = liveText();
            // Before MIN_ELAPSED_SECONDS the node now holds a placeholder
            // instead of clearing; only quoted chances belong to this check
            expect(text).toBeTruthy();
            if (!text.includes('…')) shown.push(text.replace(/\|.*$/, '').trim());
        }

        expect(shown.length).toBeGreaterThan(2);

        // Never a point figure: a chance the fight has not earned is not quoted
        // to the percentage point in either direction
        for (const text of shown) {
            expect(text).toMatch(/^\[Clear \d+–\d+%\?\]$/);
        }

        // And it never jumps. The readings underneath went 82% → 52% → 67% →
        // 52% across those four seconds — a 30-point swing between consecutive
        // ticks — and the display moves by at most one band
        const lows = shown.map((text) => Number(/Clear (\d+)–/.exec(text)[1]));
        for (let i = 1; i < lows.length; i++) {
            expect(Math.abs(lows[i] - lows[i - 1])).toBeLessThanOrEqual(25);
        }
        expect(new Set(shown).size).toBeLessThanOrEqual(2);
    });

    test('the room is identified from the action bar before any labyrinth message lands', () => {
        buildActionBar();
        dataManagerMock.getInitClientData.mockReturnValue({
            combatMonsterDetailMap: { '/monsters/mimic': { name: 'Mimic' } },
        });

        // No roomData and no pathData — the state a page reloaded mid-fight is in
        expect(labyrinthClearRate.roomData).toBeNull();
        expect(labyrinthClearRate.liveRoomContext()).toEqual({
            monsterHrid: '/monsters/mimic',
            roomLevel: 245,
            source: 'header',
        });

        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('once the grid is known it is the authority, not the header', () => {
        buildActionBar('Labyrinth - Mimic Lv.245');
        dataManagerMock.getInitClientData.mockReturnValue({
            combatMonsterDetailMap: { '/monsters/mimic': { name: 'Mimic' } },
        });
        labyrinthClearRate.roomData = [[{ monsterHrid: '/monsters/imp', recommendedLevel: 200 }]];
        labyrinthClearRate._pathData = [{ x: 0, y: 0 }];

        expect(labyrinthClearRate.liveRoomContext()).toEqual({
            monsterHrid: '/monsters/imp',
            roomLevel: 200,
            source: 'grid',
        });

        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('a monster the data has never heard of yields no context rather than a guess', () => {
        buildActionBar('Labyrinth - Something Else Lv.99');
        dataManagerMock.getInitClientData.mockReturnValue({
            combatMonsterDetailMap: { '/monsters/mimic': { name: 'Mimic' } },
        });

        expect(labyrinthClearRate.liveRoomContext()).toBeNull();

        dataManagerMock.getInitClientData.mockReturnValue(null);
    });

    test('a replayed figure replaces the band once one is in hand', () => {
        buildActionBar();
        runTicks([
            [0.98, 0.99],
            [0.9, 0.95],
            [0.8, 0.9],
            [0.7, 0.85],
            [0.6, 0.8],
            [0.5, 0.75],
            [0.4, 0.7],
        ]);
        expect(liveText()).toMatch(/Clear \d+–\d+%\?/);

        // What maybeReplayFight stores when a replay of this fight completes
        labyrinthClearRate._replay = {
            clearChance: 0.63,
            trials: 400,
            halfWidth: 0.02,
            at: Date.now(),
            fightStartedAt: labyrinthClearRate._fight.startedAt,
        };
        runTicks([[0.38, 0.68]]);

        expect(liveText()).toContain('Clear ~63%');
    });

    test('a fight whose mana the server never sent replays at full, not at NaN', () => {
        // A tick is a sparse delta merged over the last one, so a field never
        // sent is undefined. The health denominator is validated for exactly
        // that reason; the mana one was guarded on health instead, so
        // `cMP / mMP` came out NaN and went straight into the replay.
        buildActionBar();
        const spy = vi.spyOn(labyrinthClearRate, 'maybeReplayFight').mockImplementation(() => {});
        try {
            const dry = (monsterFraction, playerFraction, atkCounter) => ({
                battleId: 'b1',
                pMap: { 0: { cHP: Math.round(1000 * playerFraction), mHP: 1000, atkCounter } },
                mMap: { 0: { cHP: Math.round(2000 * monsterFraction), mHP: 2000 } },
            });
            for (const [m, p] of [
                [1, 1],
                [0.9, 0.95],
                [0.8, 0.9],
                [0.7, 0.85],
                [0.6, 0.8],
                [0.5, 0.75],
                [0.4, 0.7],
            ]) {
                vi.advanceTimersByTime(1000);
                labyrinthClearRate._liveCombatDrawnAt = 0;
                labyrinthClearRate.onBattleUpdated(dry(m, p, ++atk));
            }

            expect(spy).toHaveBeenCalled();
            for (const [, live] of spy.mock.calls) {
                expect(Number.isFinite(live.playerMpFraction)).toBe(true);
                expect(live.playerMpFraction).toBe(1);
            }
        } finally {
            spy.mockRestore();
        }
    });

    /** Full ticks from full health, past MIN_ELAPSED so a chance is quoted */
    function openFight() {
        runTicks([
            [1, 1],
            [0.9, 0.95],
            [0.8, 0.9],
            [0.7, 0.85],
            [0.6, 0.8],
            [0.5, 0.75],
            [0.4, 0.7],
        ]);
    }

    test('a player-only delta keeps the node up, refreshes the stale timer, and retains the monster', () => {
        buildActionBar();
        openFight();
        const node = document.querySelector(LIVE_SELECTOR);
        expect(node).not.toBeNull();

        // Twelve seconds of player-only ticks, each inside the 5s stale window:
        // every one must refresh the timer or the readout expires mid-fight
        for (let i = 1; i <= 3; i++) {
            vi.advanceTimersByTime(4000);
            labyrinthClearRate._liveCombatDrawnAt = 0;
            labyrinthClearRate.onBattleUpdated(playerTick(0.7 - i * 0.05, ++atk));
        }

        expect(document.querySelector(LIVE_SELECTOR)).toBe(node);
        expect(labyrinthClearRate._fight.lastPlayer.cHP).toBe(550);
        // The monster's side carried over from the last tick that had it
        expect(labyrinthClearRate._fight.lastMonster.cHP).toBe(800);
        expect(liveText()).toBeTruthy();
    });

    test('a monster-only delta does the same for the other side', () => {
        buildActionBar();
        openFight();
        const node = document.querySelector(LIVE_SELECTOR);

        for (let i = 1; i <= 3; i++) {
            vi.advanceTimersByTime(4000);
            labyrinthClearRate._liveCombatDrawnAt = 0;
            labyrinthClearRate.onBattleUpdated(monsterTick(0.4 - i * 0.05));
        }

        expect(document.querySelector(LIVE_SELECTOR)).toBe(node);
        expect(labyrinthClearRate._fight.lastMonster.cHP).toBe(500);
        expect(labyrinthClearRate._fight.lastPlayer.cHP).toBe(700);
        expect(liveText()).toBeTruthy();
    });

    test('alternating single-unit deltas update one node in place, with zero removals', () => {
        buildActionBar();
        openFight();
        const node = document.querySelector(LIVE_SELECTOR);
        const removeSpy = vi.spyOn(node, 'remove');

        const texts = new Set([node.textContent]);
        let monsterFraction = 0.4;
        let playerFraction = 0.7;
        for (let i = 0; i < 6; i++) {
            vi.advanceTimersByTime(1000);
            labyrinthClearRate._liveCombatDrawnAt = 0;
            const data =
                i % 2 === 0 ? monsterTick((monsterFraction -= 0.04)) : playerTick((playerFraction -= 0.03), ++atk);
            labyrinthClearRate.onBattleUpdated(data);
            expect(document.querySelectorAll(LIVE_SELECTOR)).toHaveLength(1);
            expect(document.querySelector(LIVE_SELECTOR)).toBe(node);
            texts.add(node.textContent);
        }

        expect(removeSpy).not.toHaveBeenCalled();
        // The text moved (the room clock alone ticks every draw) — in place
        expect(texts.size).toBeGreaterThan(1);
    });

    test('the first seconds show a placeholder in a stable node instead of blinking', () => {
        buildActionBar();
        runTicks([[1, 1]]);
        const node = document.querySelector(LIVE_SELECTOR);
        expect(node).not.toBeNull();
        expect(node.textContent).toContain('Clear …');

        runTicks([
            [0.97, 0.99],
            [0.95, 0.97],
        ]);
        expect(document.querySelectorAll(LIVE_SELECTOR)).toHaveLength(1);
        expect(document.querySelector(LIVE_SELECTOR)).toBe(node);
        expect(node.textContent).toContain('Clear …');
    });

    test('new_battle starts a fresh attempt record without duplicate nodes', () => {
        buildActionBar();
        openFight();
        const oldStart = labyrinthClearRate._fight.startedAt;
        labyrinthClearRate._liveNodeMaxWidth = 57;

        vi.advanceTimersByTime(1000);
        labyrinthClearRate.onNewBattle({
            battleId: 'b1',
            monsters: [{ hrid: '/monsters/mimic', maxHitpoints: 2000, currentHitpoints: 2000 }],
            players: [{ maxHitpoints: 1000, currentHitpoints: 820 }],
        });

        const fight = labyrinthClearRate._fight;
        expect(fight.startedAt).toBeGreaterThan(oldStart);
        expect(fight.caughtStart).toBe(true);
        expect(fight.firstMonsterFraction).toBe(1);
        expect(fight.firstPlayerFraction).toBeCloseTo(0.82, 9);
        // New fight, new monster name: the width ratchet starts over
        expect(labyrinthClearRate._liveNodeMaxWidth).toBe(0);

        // The next tick continues the seeded attempt rather than re-baselining
        runTicks([[0.99, 0.81]]);
        expect(labyrinthClearRate._fight).toBe(fight);
        expect(document.querySelectorAll(LIVE_SELECTOR)).toHaveLength(1);
    });

    test('the width ratchet survives sparse ticks and a header rerender, and resets on the stale boundary', () => {
        buildActionBar();
        openFight();
        // happy-dom measures scrollWidth as 0, so pin a width the fight earned
        labyrinthClearRate._liveNodeMaxWidth = 57;

        vi.advanceTimersByTime(1000);
        labyrinthClearRate._liveCombatDrawnAt = 0;
        labyrinthClearRate.onBattleUpdated(monsterTick(0.38));
        const node = document.querySelector(LIVE_SELECTOR);
        expect(labyrinthClearRate._liveNodeMaxWidth).toBe(57);
        expect(node.style.minWidth).toBe('57px');

        // The game rerender swallows the node mid-throttle; the next tick
        // re-seats it with the text and width it had, without a fresh draw
        const before = node.textContent;
        node.remove();
        vi.advanceTimersByTime(200);
        labyrinthClearRate.onBattleUpdated(monsterTick(0.36));
        const restored = document.querySelector(LIVE_SELECTOR);
        expect(restored).not.toBeNull();
        expect(restored.textContent).toBe(before);
        expect(restored.style.minWidth).toBe('57px');

        // Ticks stopping is a real boundary: readout down, ratchet reset
        vi.advanceTimersByTime(5001);
        expect(document.querySelector(LIVE_SELECTOR)).toBeNull();
        expect(labyrinthClearRate._liveNodeMaxWidth).toBe(0);
    });

    test('a tick with the setting off takes the readout down at once', () => {
        buildActionBar();
        openFight();
        expect(document.querySelector(LIVE_SELECTOR)).not.toBeNull();

        configMock.getSetting.mockReturnValueOnce(false);
        vi.advanceTimersByTime(1000);
        labyrinthClearRate._liveCombatDrawnAt = 0;
        labyrinthClearRate.onBattleUpdated(tick(0.35, 0.65, ++atk));

        expect(document.querySelector(LIVE_SELECTOR)).toBeNull();
    });

    test('the skilling readout lost to a header rerender is restored on the next progress message', () => {
        buildActionBar('Labyrinth - Cheesesmithing');
        const progress = {
            targetLevel: null,
            successRate: 0.8,
            doubleProgressChance: 0.1,
            actionTimeMs: 10000,
            actionCounter: 2,
            currentWorkValue: 30,
            targetWorkValue: 100,
            progressPerAction: 10,
        };

        labyrinthClearRate.refreshLiveProgress(progress);
        const node = document.querySelector('.mwi-labyrinth-live-progress');
        expect(node).not.toBeNull();
        const before = node.textContent;
        expect(before).toContain('Clear');

        // The header rerender wipes the span; the next message — even one the
        // math cannot use — re-seats it with the text it showed
        node.remove();
        labyrinthClearRate.refreshLiveProgress({ ...progress, targetWorkValue: 0 });
        const restored = document.querySelector('.mwi-labyrinth-live-progress');
        expect(restored).not.toBeNull();
        expect(restored.textContent).toBe(before);

        labyrinthClearRate.clearLiveProgress();
    });
});

/**
 * The hover preview — "Shadow Archer / Clear Chance 49.5% ±5.1 / …" — that
 * used to survive leaving the labyrinth grid. It hid itself on `mouseleave`
 * only, and a badge that gets torn out of the DOM (React re-rendering the
 * panel, this script's own overlay teardown running, the run itself ending)
 * never fires that event on its way out — nothing does, for a node no longer
 * in the document. It floated over whatever replaced the grid until the page
 * was refreshed.
 *
 * Combat rows, skilling rows and the grid's own corner badges all bind
 * through the one `bindPreview`/`showPreview` pair (`decorateBadge` for the
 * first two, `appendTileBadge` for the third), so the fix — and the tests
 * below — cover all three from one mechanism rather than one apiece.
 */
describe('the hover preview does not outlive its anchor', () => {
    const PREVIEW_ID = 'mwi-labyrinth-preview';
    const skillResult = () => ({
        type: 'skilling',
        skillHrid: '/skills/milking',
        roomLevel: 10,
        clearChance: 0.9,
        expectedSeconds: 5,
    });
    const combatResult = () => ({
        type: 'combat',
        monsterHrid: '/monsters/imp',
        roomLevel: 20,
        clearChance: 0.5,
        expectedSeconds: 12,
    });
    const isShown = () => document.getElementById(PREVIEW_ID)?.style.display === 'block';
    const hover = (el) => el.dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 10 }));

    // What this describe block is about is whether the preview outlives its
    // anchor, not whether its content renders correctly — that belongs to
    // renderPreviewContent's own coverage. Stubbing it keeps these fixtures
    // to the handful of fields bindPreview/showPreview actually touch instead
    // of every field the full skilling/combat card formats.
    let renderSpy;
    beforeEach(() => {
        renderSpy = vi.spyOn(labyrinthClearRate, 'renderPreviewContent').mockImplementation((el) => {
            el.textContent = 'preview';
        });
    });

    afterEach(() => {
        renderSpy.mockRestore();
        labyrinthClearRate.hidePreview();
        document.getElementById(PREVIEW_ID)?.remove();
        document.body.innerHTML = '';
    });

    test('a normal hover shows on mouseenter and hides on mouseleave, as before', () => {
        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());

        hover(badge);
        expect(isShown()).toBe(true);

        badge.dispatchEvent(new MouseEvent('mouseleave'));
        expect(isShown()).toBe(false);
    });

    test('a skip-threshold row badge (skilling or combat) orphans cleanly once the watchdog checks', () => {
        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
        hover(badge);
        expect(isShown()).toBe(true);

        // The panel switched away — the badge is gone, but nothing fired
        // mouseleave to tell the preview that
        badge.remove();
        expect(isShown()).toBe(true);

        labyrinthClearRate._previewWatchdogTick();
        expect(isShown()).toBe(false);
        expect(document.getElementById(PREVIEW_ID).style.display).toBe('none');
    });

    test('the grid tile corner badge — bound from a separate call site — orphans the same way', () => {
        // appendTileBadge binds the preview to the tile cell itself, not a
        // child badge span, which is the second of the two bindPreview sites
        const cell = document.createElement('div');
        document.body.appendChild(cell);
        labyrinthClearRate.bindPreview(cell, combatResult());
        hover(cell);
        expect(isShown()).toBe(true);

        cell.remove();
        labyrinthClearRate._previewWatchdogTick();
        expect(isShown()).toBe(false);
    });

    test('a watchdog tick finding the anchor still connected leaves a live preview alone', () => {
        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
        hover(badge);

        labyrinthClearRate._previewWatchdogTick();
        expect(isShown()).toBe(true);
    });

    test('the watchdog interval runs only while a preview is showing', () => {
        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
        expect(labyrinthClearRate._previewWatchdog).toBeNull();

        hover(badge);
        expect(labyrinthClearRate._previewWatchdog).not.toBeNull();

        badge.dispatchEvent(new MouseEvent('mouseleave'));
        expect(labyrinthClearRate._previewWatchdog).toBeNull();
    });

    test('a watchdog tick with no preview showing does nothing (no anchor, no crash)', () => {
        expect(() => labyrinthClearRate._previewWatchdogTick()).not.toThrow();
        expect(isShown()).toBe(false);
    });

    test('injectOverlays hides an orphan-prone preview immediately, ahead of the watchdog', () => {
        // injectOverlays is what actually tears the skip-threshold badges
        // down on every grid rebuild; hiding there means the common case is
        // instant and the watchdog is only ever the fallback
        document.body.innerHTML = '<table><tr><td class="LabyrinthPanel_skipThreshold"></td></tr></table>';
        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
        hover(badge);
        expect(isShown()).toBe(true);

        labyrinthClearRate.injectOverlays();
        expect(isShown()).toBe(false);
    });

    test('onLabyrinthUpdated hides a stale preview even when the message carries no roomData', () => {
        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
        hover(badge);
        expect(isShown()).toBe(true);

        // A run ending is exactly the kind of update that carries no grid —
        // injectOverlays is never reached, so this has to be the one that hides it
        labyrinthClearRate.onLabyrinthUpdated({ labyrinth: null });
        expect(isShown()).toBe(false);

        labyrinthClearRate._labyrinth = null;
        labyrinthClearRate.roomData = null;
    });

    test('scrolling hides an open preview', () => {
        labyrinthClearRate._previewScrollHandler = () => labyrinthClearRate.hidePreview();
        window.addEventListener('scroll', labyrinthClearRate._previewScrollHandler, { capture: true, passive: true });

        const badge = document.createElement('span');
        document.body.appendChild(badge);
        labyrinthClearRate.bindPreview(badge, skillResult());
        hover(badge);
        expect(isShown()).toBe(true);

        window.dispatchEvent(new Event('scroll'));
        expect(isShown()).toBe(false);

        window.removeEventListener('scroll', labyrinthClearRate._previewScrollHandler, { capture: true });
        labyrinthClearRate._previewScrollHandler = null;
    });
});

/**
 * Re-planning a route on a floor that has moved on.
 *
 * From a live run: "fix pathing in cases where I have already shrouded the path
 * and click path again". A shroud clears its room outright, so a room that was
 * "Shroud" a moment ago is now just floor — but the planner classified the
 * board when the button went down and then spent seconds running fight sims,
 * and drew its answer against that snapshot. Pressing Path again during a run
 * that keeps moving reproduces it, which is exactly when anyone would press it.
 */
describe('re-planning a route after shrouds have been spent', () => {
    /** A 4x4 floor, its grid, and the toolbar the planner writes to */
    function buildBoard(rooms, unknownMode = 'clearable') {
        document.body.innerHTML = '';
        const parent = document.createElement('div');
        for (let i = 0; i < rooms.length; i++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell_abc';
            parent.appendChild(cell);
        }
        document.body.appendChild(parent);

        const status = document.createElement('span');
        status.className = 'mwi-labyrinth-tile-controls-status';
        document.body.appendChild(status);

        const mode = document.createElement('select');
        mode.className = 'mwi-labyrinth-tile-controls-path-unknown';
        for (const value of ['clearable', 'shroud', 'avoid']) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            mode.appendChild(option);
        }
        mode.value = unknownMode;
        document.body.appendChild(mode);

        labyrinthClearRate.roomData = [rooms.slice(0, 4), rooms.slice(4, 8), rooms.slice(8, 12), rooms.slice(12, 16)];
        labyrinthClearRate.currentFloor = 5;
        return { status, parent };
    }

    /** What each room ended up marked as: '', 'walk', 'Shroud', '?', '⚑'… */
    const marks = (parent) =>
        [...parent.children].map((cell) => {
            const overlay = cell.querySelector('.mwi-labyrinth-path-overlay');
            if (!overlay) return '';
            return overlay.dataset.approach ? 'walk' : cell.textContent || 'route';
        });

    /** A revealed fight the sims judge unbeatable, so the route must shroud it */
    const fight = () => ({
        roomType: '/labyrinth_room_types/combat',
        monsterHrid: '/monsters/gobo',
        recommendedLevel: 100,
    });

    /** What the server sends for a room a shroud has cleared: stripped bare */
    const shrouded = () => ({ isCleared: true });

    /** A fully revealed floor of unbeatable fights, entrance cleared, exit at the corner */
    const unbeatableFloor = () => {
        const rooms = new Array(16).fill(null).map(() => fight());
        rooms[0] = { isCleared: true };
        rooms[15] = { roomType: '/labyrinth_room_types/descend' };
        return rooms;
    };

    beforeEach(() => {
        settings.map.clear();
        bag.items = null;
        // The fights below are meant to be *judged and lost*, not left
        // unsimmable. This harness carries no loadout snapshots, so a real sim
        // reports `failed` — which is "not simmable yet", a room the planner
        // leaves unjudged rather than one it shrouds. A cached 0% result is what
        // it would have got from a sim that actually ran, so the tests are about
        // re-planning rather than about a sim that never started.
        labyrinthClearRate.combatCache.set(
            labyrinthClearRate.buildCombatCacheKey(
                '/monsters/gobo',
                100,
                null,
                labyrinthClearRate.getSimPrecisionPct()
            ),
            { clearChance: 0, winRate: 0, expectedSeconds: Infinity, trials: 400, hitTarget: true }
        );
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.roomData = null;
        labyrinthClearRate.combatCache.clear();
        bag.items = null;
    });

    test('a second press on an unchanged board plans exactly what the first did', async () => {
        const { status, parent } = buildBoard(unbeatableFloor());

        await labyrinthClearRate.runPathCalculation();
        const first = { text: status.textContent, marks: marks(parent) };

        await labyrinthClearRate.runPathCalculation();

        expect(status.textContent).toBe(first.text);
        expect(marks(parent)).toEqual(first.marks);
        // …and it is the right plan: six rooms to the corner, five of them
        // fights it cannot win, the exit itself free to walk into
        expect(first.text).toBe('Path: 6 rooms · 5 shrouds · 0 chests');
    });

    test('a fight the sims could not run is unjudged, not a 0% clear', async () => {
        // Press Path before the loadout snapshots are back from storage and
        // every combat sim reports `failed`. Filing that as a 0% clear chance
        // puts every room below the threshold, so the plan demands five shrouds
        // for a floor it has learned nothing about — and says nothing about why.
        // (One sim covers all fifteen rooms: they are the same monster at the
        // same level, and the queue is keyed on that.)
        const { status, parent } = buildBoard(unbeatableFloor());
        labyrinthClearRate.combatCache.clear(); // nothing judged yet
        gear.ready = false;
        try {
            await labyrinthClearRate.runPathCalculation();

            expect(status.textContent).toContain('0 shrouds');
            expect(status.textContent).toContain('1 fight could not be simmed');
            expect(marks(parent)).not.toContain('Shroud');
        } finally {
            gear.ready = true;
        }
    });

    test('rooms already shrouded are not planned to be shrouded again', async () => {
        const { status, parent } = buildBoard(unbeatableFloor());

        await labyrinthClearRate.runPathCalculation();
        expect(status.textContent).toBe('Path: 6 rooms · 5 shrouds · 0 chests');
        expect(marks(parent)[1]).toBe('Shroud');
        expect(marks(parent)[2]).toBe('Shroud');

        // The player spends two shrouds on the rooms it marked; the server
        // sends those rooms back cleared and stripped of everything else
        labyrinthClearRate.roomData[0][1] = shrouded();
        labyrinthClearRate.roomData[0][2] = shrouded();

        await labyrinthClearRate.runPathCalculation();

        // Not planned for again — and now drawn as ground to walk over, which
        // is what they have become
        expect(status.textContent).toBe('Path: 4 rooms (+2 walked) · 3 shrouds · 0 chests');
        expect(marks(parent)[1]).toBe('walk');
        expect(marks(parent)[2]).toBe('walk');
    });

    test('a shroud spent while the sims are still running is not planned for either', async () => {
        const { status, parent } = buildBoard(unbeatableFloor());

        // The run does not stop for the sims: the player shrouds the first two
        // rooms of the route while the fights are still being simulated
        const spy = vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            labyrinthClearRate.roomData[0][1] = shrouded();
            labyrinthClearRate.roomData[0][2] = shrouded();
            return { clearChance: 0, failed: false };
        });

        await labyrinthClearRate.runPathCalculation();
        spy.mockRestore();

        // The answer is about the floor as it stands, not as it was when the
        // button went down — no "Shroud" over a room already shrouded
        expect(status.textContent).toBe('Path: 4 rooms (+2 walked) · 3 shrouds · 0 chests');
        expect(marks(parent)[1]).toBe('walk');
        expect(marks(parent)[2]).toBe('walk');
    });

    test('a room revealed mid-sim is costed like any other room nothing is known about', async () => {
        // Pessimistic ? mode: an unrevealed room on the route costs a shroud
        const rooms = unbeatableFloor();
        rooms[1] = null; // still dark when the button goes down
        const { status, parent } = buildBoard(rooms, 'shroud');

        const spy = vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            // It comes into view mid-sim — a fight nothing else on the floor
            // shares, so no sim of this pass has anything to say about it
            labyrinthClearRate.roomData[0][1] = {
                roomType: '/labyrinth_room_types/combat',
                monsterHrid: '/monsters/latecomer',
                recommendedLevel: 150,
            };
            return { clearChance: 0, failed: false };
        });

        await labyrinthClearRate.runPathCalculation();
        spy.mockRestore();

        // Being looked at is not the same as being judged: it keeps the same
        // posture it had while it was dark rather than turning free
        expect(marks(parent)[1]).toBe('Shroud?');
        expect(status.textContent).toContain('6 rooms');
        expect(status.textContent).toContain('5 shrouds');
    });

    test('a floor that changes shape mid-sim is refused rather than drawn stale', async () => {
        const { status } = buildBoard(unbeatableFloor());

        const spy = vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            // The next floor: a different grid entirely
            labyrinthClearRate.roomData = [
                [null, null, null],
                [null, null, null],
                [null, null, null],
            ];
            return { clearChance: 0, failed: false };
        });

        await labyrinthClearRate.runPathCalculation();
        spy.mockRestore();

        expect(status.textContent).toContain('press Path again');
    });

    test('the rooms between the entrance and the plan are lit as ground to walk, not work to do', async () => {
        // The first three rooms are behind us; the plan starts at the frontier
        const rooms = unbeatableFloor();
        for (const i of [1, 2, 3]) rooms[i] = shrouded();
        const { status, parent } = buildBoard(rooms);

        await labyrinthClearRate.runPathCalculation();

        // Three rooms of work, three of walking, and the walking is counted
        // beside the plan rather than inside it — it costs nothing
        expect(status.textContent).toBe('Path: 3 rooms (+3 walked) · 2 shrouds · 0 chests');
        expect(marks(parent).slice(0, 4)).toEqual(['', 'walk', 'walk', 'walk']);
        expect(marks(parent)[7]).toBe('Shroud');

        // …and it reads as the same highlight turned down: dashed, faded, and
        // carrying no instruction of its own
        const approach = parent.children[1].querySelector('.mwi-labyrinth-path-overlay');
        expect(approach.getAttribute('style')).toContain('dashed');
        expect(approach.textContent).toBe('');
        expect(parent.children[7].querySelector('.mwi-labyrinth-path-overlay').getAttribute('style')).toContain(
            'solid'
        );
    });

    test('the walk starts from the room the player is standing in when the game says', async () => {
        const rooms = unbeatableFloor();
        for (const i of [1, 2, 3]) rooms[i] = shrouded();
        const { status } = buildBoard(rooms);
        // The path head is the room being run — here, the far end of the
        // cleared stretch, so there is nothing left to walk
        labyrinthClearRate._pathData = JSON.stringify([{ x: 3, y: 0 }]);

        await labyrinthClearRate.runPathCalculation();
        labyrinthClearRate._pathData = null;

        expect(status.textContent).toBe('Path: 3 rooms · 2 shrouds · 0 chests');
    });

    test('clearing progress does not rub out the walk it just created', async () => {
        const rooms = unbeatableFloor();
        for (const i of [1, 2]) rooms[i] = shrouded();
        const { parent } = buildBoard(rooms);

        await labyrinthClearRate.runPathCalculation();
        expect(marks(parent)[1]).toBe('walk');

        // Every approach room is a cleared room, and the pruner exists to strip
        // the plan off rooms that have been cleared since it was drawn
        labyrinthClearRate.pruneClearedPathOverlays();

        expect(marks(parent)[1]).toBe('walk');
        expect(marks(parent)[2]).toBe('walk');
    });

    test('the beacon planner counts a shrouded room as revealed, and plans no coverage over it', () => {
        const rooms = new Array(16).fill(null);
        rooms[0] = { isCleared: true };
        for (const i of [1, 2, 5, 6]) rooms[i] = shrouded();
        const { parent } = buildBoard(rooms);

        labyrinthClearRate.runBeaconCalculation();

        // Coverage is only ever planned over rooms still in the dark — a room a
        // shroud cleared is one of the ones already seen
        for (const i of [0, 1, 2, 5, 6]) {
            expect(parent.children[i].querySelector('.mwi-labyrinth-beacon-overlay')).toBeNull();
        }
        expect(document.querySelectorAll('.mwi-labyrinth-beacon-overlay').length).toBeGreaterThan(0);
    });
});

describe('recomputeCombatSims clears every cached sim before re-running', () => {
    test('empties both cache layers and re-runs the tile calc', async () => {
        labyrinthClearRate.combatCache.set('imp:200:1:1pp:', { clearChance: 0.5 });
        labyrinthClearRate._combatCacheMeta.set('imp:200:1:1pp:', { computedAt: 1, snapshotFingerprint: 'x' });
        const runSpy = vi.spyOn(labyrinthClearRate, 'runTileCalculation').mockResolvedValue(undefined);

        await labyrinthClearRate.recomputeCombatSims();

        expect(labyrinthClearRate.combatCache.size).toBe(0);
        expect(labyrinthClearRate._combatCacheMeta.size).toBe(0);
        // Manual re-run (auto:false) is what re-sims instead of reusing the cache
        expect(runSpy).toHaveBeenCalledWith({ auto: false, uncapped: false });
        runSpy.mockRestore();
    });

    test('passes the uncapped flag through to the tile calc', async () => {
        const runSpy = vi.spyOn(labyrinthClearRate, 'runTileCalculation').mockResolvedValue(undefined);

        await labyrinthClearRate.recomputeCombatSims(true);

        expect(runSpy).toHaveBeenCalledWith({ auto: false, uncapped: true });
        runSpy.mockRestore();
    });
});

describe('fullClearTime shows the real expected clear time, uncapped', () => {
    test('seconds, minutes, and hours without a 999+/∞ cap', () => {
        expect(labyrinthClearRate.fullClearTime(48)).toBe('48s');
        expect(labyrinthClearRate.fullClearTime(655)).toBe('10m 55s');
        expect(labyrinthClearRate.fullClearTime(1095)).toBe('18m 15s');
        expect(labyrinthClearRate.fullClearTime(3900)).toBe('1h 5m');
    });

    test('a room that never clears reads as a dash, not a huge number', () => {
        expect(labyrinthClearRate.fullClearTime(Infinity)).toBe('—');
        expect(labyrinthClearRate.fullClearTime(0)).toBe('—');
    });
});

describe('refreshRoomDataFromLive', () => {
    afterEach(() => {
        labyrinthClearRate.roomData = null;
    });

    test('replaces a stale cached grid with the live client grid', () => {
        // The cached websocket snapshot still says the first tile is uncleared…
        labyrinthClearRate.roomData = [[{ isCleared: false }, { isCleared: false }]];
        const spy = vi.spyOn(labyrinthClearRate, 'getLabyrinthFromReactState').mockReturnValue({
            roomData: [[{ isCleared: true }, { isCleared: false }]],
            currentFloor: 2,
        });
        labyrinthClearRate.refreshRoomDataFromLive();
        // …but the live grid knows it is cleared, and wins.
        expect(labyrinthClearRate.roomData[0][0].isCleared).toBe(true);
        expect(labyrinthClearRate.currentFloor).toBe(2);
        spy.mockRestore();
    });

    test('is a no-op when the live grid is unavailable — never blanks the cache', () => {
        const cached = [[{ isCleared: false }]];
        labyrinthClearRate.roomData = cached;
        const spy = vi.spyOn(labyrinthClearRate, 'getLabyrinthFromReactState').mockReturnValue(null);
        labyrinthClearRate.refreshRoomDataFromLive();
        expect(labyrinthClearRate.roomData).toBe(cached);
        spy.mockRestore();
    });

    test('parses a JSON-string roomData from the live grid', () => {
        labyrinthClearRate.roomData = null;
        const spy = vi.spyOn(labyrinthClearRate, 'getLabyrinthFromReactState').mockReturnValue({
            roomData: JSON.stringify([[{ isCleared: true }]]),
        });
        labyrinthClearRate.refreshRoomDataFromLive();
        expect(labyrinthClearRate.roomData[0][0].isCleared).toBe(true);
        spy.mockRestore();
    });

    test('carries a same-floor clear forward when the live read lags a shroud', () => {
        // You shrouded tile [0][1] and hit resim before the update landed, so the
        // live React grid still reads it uncleared.
        labyrinthClearRate.currentFloor = 3;
        labyrinthClearRate.roomData = [[{ isCleared: true }, { isCleared: true }]];
        const spy = vi.spyOn(labyrinthClearRate, 'getLabyrinthFromReactState').mockReturnValue({
            roomData: [[{ isCleared: true }, { isCleared: false }]],
            currentFloor: 3,
        });
        labyrinthClearRate.refreshRoomDataFromLive();
        // The tracker already knew it was cleared, so it stays cleared — not routed
        // back through.
        expect(labyrinthClearRate.roomData[0][1].isCleared).toBe(true);
        spy.mockRestore();
    });

    test('does not carry clears across a floor change — a fresh floor is fresh', () => {
        // Descended: the old floor's clears must not bleed into the new grid, whose
        // same positions are brand-new rooms.
        labyrinthClearRate.currentFloor = 3;
        labyrinthClearRate.roomData = [[{ isCleared: true }, { isCleared: true }]];
        const spy = vi.spyOn(labyrinthClearRate, 'getLabyrinthFromReactState').mockReturnValue({
            roomData: [[{ isCleared: false }, { isCleared: false }]],
            currentFloor: 4,
        });
        labyrinthClearRate.refreshRoomDataFromLive();
        expect(labyrinthClearRate.roomData[0][0].isCleared).toBe(false);
        expect(labyrinthClearRate.currentFloor).toBe(4);
        spy.mockRestore();
    });
});

/**
 * The control strip's calculate button.
 *
 * There used to be two of them — a full-width "Calculate Labyrinth" inside the
 * collapsible body and a compact one beside the toggle for a folded bar — and
 * with the body open both sat on screen doing the same thing. Worse, the
 * injection kept only the first copy of the strip it found, so a copy the
 * game's grid re-render had orphaned survived with its own buttons, including
 * one built while auto-calc was off. What is pinned here is the invariant that
 * replaced all of it: one strip, and exactly one calculate button, however many
 * times the injection runs.
 */
describe('one calculate button, however often the strip is injected', () => {
    const strips = () => document.querySelectorAll('.mwi-labyrinth-tile-controls');
    const calcButtons = () => document.querySelectorAll('.mwi-labyrinth-tile-controls-button');
    const visibleCalcButtons = () => Array.from(calcButtons()).filter((b) => b.style.display !== 'none');

    /** A grid the strip can attach itself above */
    function buildGrid(side = 2) {
        document.body.innerHTML = '';
        const parent = document.createElement('div');
        for (let i = 0; i < side * side; i++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell_abc';
            parent.appendChild(cell);
        }
        const wrapper = document.createElement('div');
        wrapper.appendChild(parent);
        document.body.appendChild(wrapper);
        labyrinthClearRate.roomData = Array.from({ length: side }, () => new Array(side).fill(null));
        labyrinthClearRate.currentFloor = 3;
    }

    /** Auto-calc on or off; every other checkbox setting reads false */
    const setAutoCalc = (on) =>
        configMock.getSetting.mockImplementation((key) => (key === 'labyrinthAutoCalcTiles' ? on : false));

    beforeEach(() => {
        settings.map.clear();
        labyrinthClearRate._tileControlsCollapsed = false;
        labyrinthClearRate.tileCalcRunning = false;
        buildGrid();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.roomData = null;
        labyrinthClearRate._tileControlsCollapsed = undefined;
        configMock.getSetting.mockImplementation(() => true);
    });

    test('auto-calc off: one strip and one visible calculate button after repeated renders', () => {
        setAutoCalc(false);

        labyrinthClearRate.injectTileControls();
        labyrinthClearRate.injectTileControls();
        labyrinthClearRate.injectTileControls();

        expect(strips()).toHaveLength(1);
        expect(calcButtons()).toHaveLength(1);
        expect(visibleCalcButtons()).toHaveLength(1);
        expect(visibleCalcButtons()[0].textContent).toBe('Calc');
    });

    test('auto-calc on: no manual calculate button at all', () => {
        setAutoCalc(true);

        labyrinthClearRate.injectTileControls();
        labyrinthClearRate.injectTileControls();

        expect(strips()).toHaveLength(1);
        expect(visibleCalcButtons()).toHaveLength(0);
    });

    test('turning auto-calc on hides the button that was already drawn', () => {
        setAutoCalc(false);
        labyrinthClearRate.injectTileControls();
        expect(visibleCalcButtons()).toHaveLength(1);

        setAutoCalc(true);
        labyrinthClearRate.injectTileControls();

        expect(visibleCalcButtons()).toHaveLength(0);
    });

    test('a strip orphaned by a grid re-render is removed rather than left beside the new one', () => {
        setAutoCalc(false);
        labyrinthClearRate.injectTileControls();
        // What a React re-render does: the old bar is detached from the grid it
        // was placed against and parked somewhere else on the page
        const orphan = document.querySelector('.mwi-labyrinth-tile-controls');
        document.body.appendChild(orphan);

        labyrinthClearRate.injectTileControls();

        expect(strips()).toHaveLength(1);
        expect(calcButtons()).toHaveLength(1);
    });

    test('the Uncapped toggle sits beside the precision input and writes the checkbox setting', () => {
        setAutoCalc(false);
        labyrinthClearRate.injectTileControls();

        const uncapped = document.querySelector('.mwi-labyrinth-tile-controls-uncapped');
        expect(uncapped).not.toBeNull();
        expect(uncapped.getAttribute('aria-pressed')).toBe('false');
        expect(uncapped.previousElementSibling.className).toContain('precision');

        uncapped.click();

        // `setSettingValue` writes `.value`, which `getSetting` ignores — a
        // checkbox has to go through `setSetting` or the toggle does nothing
        expect(configMock.setSetting).toHaveBeenCalledWith('labyrinthTileUncapped', true);
    });
});

/**
 * Cancelling a calculation. The promise is that the work stops — the fight in
 * flight AND the rooms queued behind it — while everything already computed
 * survives, and that the UI does not stay stuck saying "Cancel".
 */
describe('cancelling a floor calculation', () => {
    beforeEach(() => {
        cancelSpy.fn.mockClear();
        labyrinthClearRate.tileCalcRunning = false;
        labyrinthClearRate._simCancelRequested = false;
        labyrinthClearRate.combatCache.clear();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.tileCalcRunning = false;
        labyrinthClearRate._simCancelRequested = false;
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate.simQueue = [];
    });

    test('a cancel terminates the worker, empties the queue, and keeps every cached result', () => {
        labyrinthClearRate.combatCache.set('imp:200:1:1pp:', { clearChance: 0.5 });
        labyrinthClearRate.simQueue = [{ monsterHrid: '/monsters/imp', roomLevel: 200, badge: null }];
        labyrinthClearRate.tileCalcRunning = true;

        labyrinthClearRate.cancelTileCalculation();

        expect(cancelSpy.fn).toHaveBeenCalled();
        expect(labyrinthClearRate.simCancelled()).toBe(true);
        expect(labyrinthClearRate.simQueue).toHaveLength(0);
        // The point of cancelling rather than reloading: prior work survives
        expect(labyrinthClearRate.combatCache.get('imp:200:1:1pp:')).toEqual({ clearChance: 0.5 });
    });

    test('nothing is cancelled when nothing is running', () => {
        labyrinthClearRate.cancelTileCalculation();
        expect(cancelSpy.fn).not.toHaveBeenCalled();
    });

    test('a new batch reopens the cancellation scope', () => {
        labyrinthClearRate.tileCalcRunning = true;
        labyrinthClearRate.cancelTileCalculation();
        expect(labyrinthClearRate.simCancelled()).toBe(true);

        labyrinthClearRate.beginSimBatch();

        expect(labyrinthClearRate.simCancelled()).toBe(false);
    });

    test('the button says Cancel while running and goes back to Calc afterwards', () => {
        const btn = document.createElement('button');
        btn.className = 'mwi-labyrinth-tile-controls-button';
        document.body.appendChild(btn);
        configMock.getSetting.mockImplementation(() => false);
        labyrinthClearRate._tileControlsCollapsed = false;

        labyrinthClearRate.tileCalcRunning = true;
        labyrinthClearRate.syncTileCalcButton(2, 7);
        expect(btn.textContent).toBe('Cancel 2/7');
        expect(btn.style.display).not.toBe('none');

        labyrinthClearRate.tileCalcRunning = false;
        labyrinthClearRate.syncTileCalcButton();
        expect(btn.textContent).toBe('Calc');
        expect(btn.disabled).toBe(false);

        configMock.getSetting.mockImplementation(() => true);
        labyrinthClearRate._tileControlsCollapsed = undefined;
    });

    test('a cancelled room stops the rooms queued behind it', async () => {
        // Two combat rooms; the first sim comes back cancelled, so the second
        // must never be started
        document.body.innerHTML = '';
        const parent = document.createElement('div');
        for (let i = 0; i < 2; i++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell_abc';
            parent.appendChild(cell);
        }
        document.body.appendChild(parent);
        labyrinthClearRate.roomData = [
            [
                { monsterHrid: '/monsters/imp', recommendedLevel: 100, isCleared: false },
                { monsterHrid: '/monsters/imp', recommendedLevel: 120, isCleared: false },
            ],
        ];
        labyrinthClearRate.combatCache.set('kept', { clearChance: 0.9 });
        const spy = vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            labyrinthClearRate._simCancelRequested = true;
            return { cancelled: true, failed: true, clearChance: 0, expectedSeconds: Infinity };
        });

        await labyrinthClearRate.runTileCalculation();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(labyrinthClearRate.tileCalcRunning).toBe(false);
        expect(labyrinthClearRate._autoCalcFingerprint).toBeNull();
        expect(labyrinthClearRate.combatCache.get('kept')).toEqual({ clearChance: 0.9 });
        spy.mockRestore();
        labyrinthClearRate.roomData = null;
    });
});

/**
 * A treasure/chest room is directly openable — no fight stands between the
 * player and the loot. The game's room objects can still carry a leftover
 * `monsterHrid` on a treasure room (as `combat-battle-counter.js` and
 * `labyrinth-tracker.js` already have to guard against by checking
 * `roomType` rather than trusting `monsterHrid`'s mere presence), so a tile
 * badge painter that keys off `monsterHrid` alone mistakes the chest for a
 * monster and simulates — and draws — a combat clear-chance badge on it.
 */
describe('a chest (treasure room) never gets a combat clear-chance badge', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.roomData = null;
        labyrinthClearRate.combatCache.clear();
    });

    test('a treasure room carrying a leftover monsterHrid is not simulated or badged', async () => {
        const parent = document.createElement('div');
        const cell = document.createElement('div');
        cell.className = 'LabyrinthPanel_roomCell_abc';
        parent.appendChild(cell);
        document.body.appendChild(parent);

        labyrinthClearRate.roomData = [
            [
                {
                    roomType: '/labyrinth_room_types/treasure',
                    monsterHrid: '/monsters/imp',
                    recommendedLevel: 100,
                    isCleared: false,
                },
            ],
        ];
        const spy = vi.spyOn(labyrinthClearRate, 'computeCombatClear');

        await labyrinthClearRate.runTileCalculation();

        expect(spy).not.toHaveBeenCalled();
        expect(cell.querySelector('.mwi-labyrinth-tile-badge')).toBeNull();
        spy.mockRestore();
    });
});

/**
 * A precision is part of a result's identity — two rooms simulated to ±1pp and
 * ±0.2pp are different measurements — and so is whether the run was allowed to
 * finish. Both have to survive the trip through the cache, or the Automation
 * tab's own knobs would be read back off results computed under the map's.
 */
describe('precision and the fight cap reach the cache', () => {
    afterEach(() => {
        settings.map.clear();
        labyrinthClearRate.combatCache.clear();
    });

    test('a precision files a result in its own slot, and no precision means the configured one', () => {
        settings.map.set('labyrinthSimPrecision', 1);

        expect(labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200, null, 2)).toContain(':2pp:');
        expect(labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200)).toContain(':1pp:');
        // Unchanged for every caller that never passes one — the stored keys
        // from before this argument existed still resolve
        expect(labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200, null, null)).toBe(
            labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200)
        );
    });

    test('an uncapped run refuses a cached result that stopped on the cap', async () => {
        const key = labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200);
        const wide = { clearChance: 0.36, hitTarget: false, trials: 20000 };
        labyrinthClearRate.combatCache.set(key, wide);

        // Capped: the cached answer is the answer
        expect(await labyrinthClearRate.computeCombatClear('/monsters/imp', 200)).toBe(wide);

        // Uncapped: serving that same "(capped)" band back would make the
        // toggle do nothing, so it re-runs instead (and, with no player DTO in
        // this suite, reports that it could not)
        const rerun = await labyrinthClearRate.computeCombatClear('/monsters/imp', 200, { uncapped: true });
        expect(rerun).not.toBe(wide);
        expect(rerun.failed).toBe(true);
        // The cached result is still there for the capped caller
        expect(labyrinthClearRate.combatCache.get(key)).toBe(wide);
    });

    test('an uncapped run does reuse a result that reached its precision target', async () => {
        const key = labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200);
        const tight = { clearChance: 0.36, hitTarget: true, trials: 3000 };
        labyrinthClearRate.combatCache.set(key, tight);

        expect(await labyrinthClearRate.computeCombatClear('/monsters/imp', 200, { uncapped: true })).toBe(tight);
    });
});

/**
 * The labyrinth token combat upgrades (damage/attack speed/cast speed/crit)
 * are read live off characterInfo and folded into the sim as extra buffs, but
 * buying a level changes no gear, no loadout and no crate — nothing else marks
 * a cached result as belonging to the levels it was simmed under. Without the
 * levels in the key, a result cached before a purchase kept answering for the
 * monster/room/loadout forever, since nothing else about the lookup changed.
 */
describe('a labyrinth token upgrade changes the cache slot', () => {
    afterEach(() => {
        dataManagerMock.characterData = null;
    });

    test('raising a token level moves the key, so an old result is not served back', () => {
        dataManagerMock.characterData = { characterInfo: { labyrinthCombatDamageLevel: 0 } };
        const before = labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200);

        dataManagerMock.characterData = { characterInfo: { labyrinthCombatDamageLevel: 5 } };
        const after = labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200);

        expect(after).not.toBe(before);
    });

    test('two levels with no combat upgrades bought share the same key', () => {
        dataManagerMock.characterData = { characterInfo: {} };
        const first = labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200);
        dataManagerMock.characterData = { characterInfo: { labyrinthCombatDamageLevel: 0 } };
        const second = labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200);

        expect(first).toBe(second);
    });
});

const adapterMock = await import('../combat-sim/combat-sim-adapter.js');

/**
 * A combat badge reading "0%" is a claim that the room cannot be cleared, and
 * the one way it used to be produced was a sim that never really ran: the
 * loadout snapshots load from IndexedDB after the page does, and a configured
 * loadout that is not in the store yet used to fall through to the gear the
 * character happens to be wearing. Silently simming the wrong build is worse
 * than not simming — it produces a legitimate-looking wrong number that nothing
 * downstream can tell from a real one.
 */
describe('a labyrinth DTO waits for the loadout it is told to wear', () => {
    beforeEach(() => {
        gear.ready = true;
        gear.waiters = [];
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        adapterMock.buildPlayerDTO.mockReturnValue({ hrid: 'player1', equipment: {} });
        adapterMock.applyLoadoutSnapshotToDTO.mockClear();
    });

    afterEach(() => {
        adapterMock.buildPlayerDTO.mockReset();
        gear.ready = true;
    });

    test('a configured loadout with the store still loading is not simmable', () => {
        gear.ready = false;
        expect(labyrinthClearRate.buildLabyrinthPlayerDTO(3)).toBeNull();
        expect(adapterMock.applyLoadoutSnapshotToDTO).not.toHaveBeenCalled();
    });

    test('no loadout configured still sims the worn gear, loaded or not', () => {
        gear.ready = false;
        expect(labyrinthClearRate.buildLabyrinthPlayerDTO(0)).not.toBeNull();
        expect(adapterMock.applyLoadoutSnapshotToDTO).not.toHaveBeenCalled();
    });

    test('a loaded store missing that loadout keeps the worn-gear fallback', () => {
        // A deleted or never-saved loadout: the store has spoken, and the
        // long-standing behaviour answers with the worn gear rather than
        // bricking the room forever
        Object.assign(gear.snapshots, { 1: { name: 'Fighting', equipment: [] } });
        expect(labyrinthClearRate.buildLabyrinthPlayerDTO(3)).not.toBeNull();
        expect(adapterMock.applyLoadoutSnapshotToDTO).not.toHaveBeenCalled();
    });

    test('a loaded store holding it applies that loadout', () => {
        Object.assign(gear.snapshots, { 3: { name: 'Fighting', equipment: [] } });
        expect(labyrinthClearRate.buildLabyrinthPlayerDTO(3)).not.toBeNull();
        const [dto, name] = adapterMock.applyLoadoutSnapshotToDTO.mock.calls[0];
        expect(dto).toMatchObject({ hrid: 'player1' });
        expect(name).toBe('Fighting');
    });

    test('a sim asked for before the loadout arrives reports failure, not a 0% clear', async () => {
        gear.ready = false;
        labyrinthClearRate.combatCache.clear();
        const spy = vi.spyOn(labyrinthClearRate, 'getLabyrinthLoadoutId').mockReturnValue(3);
        try {
            const result = await labyrinthClearRate.computeCombatClear('/monsters/imp', 200);
            expect(result.failed).toBe(true);
            // Nothing was filed under that room, so a retry can still correct it
            expect(labyrinthClearRate.combatCache.size).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });
});

/**
 * The snapshots arriving is precisely the event that makes an unanswerable
 * badge answerable. Its handler invalidated the stale sims and then left the
 * screen alone, so corrected numbers waited for whatever unrelated DOM mutation
 * happened along next — the "self-heals after a bit" half of the symptom.
 */
describe('the snapshot store arriving redraws the table', () => {
    afterEach(() => {
        // domObserver is mocked, so the registrations it handed back are not
        // callable — disable() would only log about them
        labyrinthClearRate.unregisterHandlers = [];
        labyrinthClearRate.disable();
        labyrinthClearRate.isInitialized = false;
        gear.listeners = [];
        vi.useRealTimers();
    });

    test('a snapshot update injects overlays, the way a setting change does', () => {
        vi.useFakeTimers();
        gear.listeners = [];
        labyrinthClearRate.isInitialized = false;
        labyrinthClearRate.initialize();

        const handler = gear.listeners[gear.listeners.length - 1];
        expect(typeof handler).toBe('function');

        const spy = vi.spyOn(labyrinthClearRate, 'injectOverlays').mockImplementation(() => {});
        handler();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('a teardown inside the settle window cancels the catch-up pass', () => {
        // The ready signal arms two 500 ms catch-up timers. Unregistering the
        // ready handler stops it firing again but cannot cancel a timer already
        // armed, so a character switch inside that window used to let them run
        // on a torn-down feature — re-injecting controls nothing is left to
        // remove, and seeding the cache under whichever character is current by
        // the time the timer fires.
        vi.useFakeTimers();
        gear.listeners = [];
        labyrinthClearRate.isInitialized = false;
        labyrinthClearRate.initialize();

        const seed = vi.spyOn(labyrinthClearRate, '_seedCombatCache').mockImplementation(() => {});
        const controls = vi.spyOn(labyrinthClearRate, 'injectTileControls').mockImplementation(() => {});
        try {
            labyrinthClearRate.unregisterHandlers = [];
            labyrinthClearRate.disable();
            vi.advanceTimersByTime(2000);

            expect(seed).not.toHaveBeenCalled();
            expect(controls).not.toHaveBeenCalled();
        } finally {
            seed.mockRestore();
            controls.mockRestore();
        }
    });
});

/**
 * The persisted cache is keyed on a gear fingerprint hashed from the snapshot
 * store. Seeding that fingerprint while the store is still loading hashes `{}`,
 * so every stored entry — hashed under the real gear — is discarded as a
 * mismatch. That fired on every reload, which is what guaranteed a cold start
 * and the race the 0% badges came out of.
 */
describe('the cold-start cache load waits for the loadout snapshots', () => {
    const sword = { name: 'Fighting', equipment: [{ itemHrid: '/items/sword', enhancementLevel: 5 }] };

    beforeEach(() => {
        db.map.clear();
        gear.waiters = [];
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;
        labyrinthClearRate._snapshotFingerprint = null;
    });

    afterEach(() => {
        gear.ready = true;
        gear.waiters = [];
    });

    test('a persisted entry survives a reload whose snapshots load late', async () => {
        // What the previous session wrote: an entry stamped with the
        // fingerprint of the gear that is about to finish loading
        Object.assign(gear.snapshots, { 1: sword });
        const loadedFingerprint = labyrinthClearRate._snapshotContentFingerprint();
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];

        const key = 'imp:200:1:1pp:';
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
            version: COMBAT_CACHE_STORAGE_VERSION,
            entries: [
                {
                    key,
                    result: { clearChance: 0.75, winRate: 0.75 },
                    computedAt: Date.now(),
                    snapshotFingerprint: loadedFingerprint,
                    scriptVersion: null,
                },
            ],
        });

        // The reload: snapshots still loading when the seeding fires
        gear.ready = false;
        const seeded = labyrinthClearRate._seedCombatCache();
        await Promise.resolve();
        expect(labyrinthClearRate._combatCacheLoaded).toBe(false);
        expect(labyrinthClearRate._snapshotFingerprint).toBeNull();

        // The store lands, and the wait releases
        Object.assign(gear.snapshots, { 1: sword });
        gear.ready = true;
        for (const resolve of gear.waiters.splice(0)) resolve(true);
        await seeded;

        expect(labyrinthClearRate._snapshotFingerprint).toBe(loadedFingerprint);
        expect(labyrinthClearRate.combatCache.get(key)).toMatchObject({
            clearChance: 0.75,
            fromPersistedCache: true,
        });
    });
});

/**
 * A stored result is a claim about a fight made by one particular simulator.
 * The key encodes the room, the gear and the stopping rule, and nothing about
 * the engine — so results from before an engine fix were served as current for
 * the whole seven-day TTL.
 */
describe('cached sims do not outlive the simulator that made them', () => {
    beforeEach(() => {
        db.map.clear();
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate._combatCacheMeta.clear();
        labyrinthClearRate._combatCacheLoaded = false;
    });

    test('the storage version has moved past the pre-fix records', () => {
        expect(COMBAT_CACHE_STORAGE_VERSION).toBeGreaterThan(1);
    });

    test('a version 1 document is discarded whole', async () => {
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
            version: 1,
            entries: [
                {
                    key: 'imp:200:1:1pp:',
                    result: { clearChance: 0.75 },
                    computedAt: Date.now(),
                    snapshotFingerprint: labyrinthClearRate._snapshotContentFingerprint(),
                },
            ],
        });

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.size).toBe(0);
    });

    test('an entry from another script version is dropped, the current one kept', async () => {
        const fingerprint = labyrinthClearRate._snapshotContentFingerprint();
        db.map.set('labyrinth:labyrinthCombatSimCache_me', {
            version: COMBAT_CACHE_STORAGE_VERSION,
            entries: [
                {
                    key: 'old:200:0:1pp:',
                    result: { clearChance: 0.75 },
                    computedAt: Date.now(),
                    snapshotFingerprint: fingerprint,
                    // Some earlier build's engine; scriptVersion() is null here
                    scriptVersion: '9.9.9',
                },
                {
                    key: 'now:200:0:1pp:',
                    result: { clearChance: 0.5 },
                    computedAt: Date.now(),
                    snapshotFingerprint: fingerprint,
                    scriptVersion: null,
                },
            ],
        });

        await labyrinthClearRate._loadCombatCache();

        expect(labyrinthClearRate.combatCache.has('old:200:0:1pp:')).toBe(false);
        expect(labyrinthClearRate.combatCache.has('now:200:0:1pp:')).toBe(true);
    });
});

/**
 * The Automation table sims and files its results under its own precision, and
 * looked them up under the floor map's. Whenever the two settings differ —
 * which is the entire point of the table having its own knob — every lookup
 * missed and every redraw re-simmed every combat row from scratch.
 */
describe('the Automation table looks up what it stores', () => {
    beforeEach(() => {
        settings.map.clear();
        labyrinthClearRate.combatCache.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        settings.map.clear();
        labyrinthClearRate.combatCache.clear();
        document.body.innerHTML = '';
    });

    test('a result stored at the automation precision is found at it', () => {
        settings.map.set('labyrinthSimPrecision', 1);
        settings.map.set('labyrinthAutomationSimPrecision', 3);

        const result = { clearChance: 0.62, expectedSeconds: 40 };
        labyrinthClearRate.combatCache.set(
            labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200, null, 3),
            result
        );

        // The map's precision is a different measurement and rightly misses
        expect(labyrinthClearRate.getCachedCombatResult('/monsters/imp', 200)).toBeNull();
        const found = labyrinthClearRate.getCachedCombatResult(
            '/monsters/imp',
            200,
            labyrinthClearRate.getAutomationSimPrecisionPct()
        );
        expect(found).toBe(result);
    });

    test('the table draws the cached badge instead of queueing another sim', () => {
        settings.map.set('labyrinthSimPrecision', 1);
        settings.map.set('labyrinthAutomationSimPrecision', 3);

        document.body.innerHTML =
            '<table><tbody><tr>' +
            '<td class="LabyrinthPanel_roomLabel__x"><svg><use href="/sprite#imp"></use></svg></td>' +
            '<td class="LabyrinthPanel_skipThreshold__x"></td>' +
            '</tr></tbody></table>';

        const levelSpy = vi.spyOn(labyrinthClearRate, 'getCombatSkipRoomLevel').mockReturnValue(200);
        const loadoutSpy = vi.spyOn(labyrinthClearRate, 'getLabyrinthLoadoutId').mockReturnValue(0);
        const queueSpy = vi.spyOn(labyrinthClearRate, 'queueCombatSim');
        try {
            labyrinthClearRate.combatCache.set(labyrinthClearRate.buildCombatCacheKey('/monsters/imp', 200, null, 3), {
                clearChance: 0.62,
                expectedSeconds: 40,
            });

            labyrinthClearRate.injectOverlays();

            const badge = document.querySelector('[class*="LabyrinthPanel_skipThreshold"] span');
            expect(badge.textContent).toContain('62%');
            expect(queueSpy).not.toHaveBeenCalled();
        } finally {
            levelSpy.mockRestore();
            loadoutSpy.mockRestore();
            queueSpy.mockRestore();
        }
    });
});

describe('combat recommend search under cancellation', () => {
    afterEach(() => {
        labyrinthClearRate.recommendations.clear();
        vi.restoreAllMocks();
    });

    test('a probe cancelled from outside the batch discards the partial search', async () => {
        vi.spyOn(labyrinthClearRate, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        let probes = 0;
        vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            probes++;
            // The first probe passes — bestThreshold is now set — and then a
            // Stop pressed somewhere else (Lab Sim, Combat Sim) kills the
            // worker without setting this batch's cancel flag
            if (probes === 1) return { clearChance: 1, expectedSeconds: 10 };
            return { clearChance: 0, expectedSeconds: Infinity, failed: true, cancelled: true };
        });

        labyrinthClearRate.beginSimBatch();
        const threshold = await labyrinthClearRate.findRecommendedThresholdCombat('/monsters/imp', 0.7);
        // A half-finished search is a lower bound, not a recommendation
        expect(threshold).toBeNull();
    });

    test('an uncancelled search still lands on the highest passing threshold', async () => {
        vi.spyOn(labyrinthClearRate, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async (hrid, roomLevel) => ({
            clearChance: roomLevel <= 100 + 5 - 1 ? 1 : 0,
            expectedSeconds: 10,
        }));

        labyrinthClearRate.beginSimBatch();
        const threshold = await labyrinthClearRate.findRecommendedThresholdCombat('/monsters/imp', 0.7);
        expect(threshold).toBe(5);
    });

    test("the batch's own cancel flag also discards the room mid-search", async () => {
        vi.spyOn(labyrinthClearRate, 'getPlayerEffectiveCombatLevel').mockReturnValue(100);
        let probes = 0;
        vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            probes++;
            if (probes === 2) labyrinthClearRate._simCancelRequested = true;
            return { clearChance: 1, expectedSeconds: 10 };
        });

        labyrinthClearRate.beginSimBatch();
        const threshold = await labyrinthClearRate.findRecommendedThresholdCombat('/monsters/imp', 0.7);
        expect(threshold).toBeNull();
        labyrinthClearRate._simCancelRequested = false;
    });
});

describe('recommend badge at the search ceiling', () => {
    const cellHtml =
        '<table><tbody><tr>' +
        '<td class="LabyrinthPanel_roomLabel__x"><svg><use href="/sprite#imp"></use></svg></td>' +
        '<td class="LabyrinthPanel_skipThreshold__x"></td>' +
        '</tr></tbody></table>';

    afterEach(() => {
        labyrinthClearRate.recommendations.clear();
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    test('a threshold equal to the window edge is shown as at-least, not as an answer', () => {
        document.body.innerHTML = cellHtml;
        vi.spyOn(labyrinthClearRate, 'getCombatSkipThreshold').mockReturnValue(60);
        labyrinthClearRate._recommendTargetPct = 70;
        labyrinthClearRate.recommendations.set('/monsters/imp', { threshold: 1000 });

        labyrinthClearRate.injectRecommendationBadges();

        const badge = document.querySelector('.mwi-labyrinth-recommend');
        expect(badge.textContent).toBe('Rec: ≥+1000');
        expect(badge.title).toContain('at least +1000');
        expect(badge.title).toContain('top of its ±1000 window');
    });

    test('an interior threshold keeps the plain form', () => {
        document.body.innerHTML = cellHtml;
        vi.spyOn(labyrinthClearRate, 'getCombatSkipThreshold').mockReturnValue(60);
        labyrinthClearRate._recommendTargetPct = 70;
        labyrinthClearRate.recommendations.set('/monsters/imp', { threshold: 40 });

        labyrinthClearRate.injectRecommendationBadges();

        const badge = document.querySelector('.mwi-labyrinth-recommend');
        expect(badge.textContent).toBe('Rec: +40');
        expect(badge.title).not.toContain('at least');
        expect(badge.title).not.toContain('window');
    });
});

describe('formulas across the widened ±1000 threshold range', () => {
    const zeroMetrics = () => ({
        skillLevelBonus: 0,
        efficiencyBonus: 0,
        actionSpeedBonus: 0,
        successBonus: 0,
        doubleProgressBonus: 0,
        gatheringBonus: 0,
        experienceBonus: 0,
    });

    afterEach(() => {
        vi.restoreAllMocks();
        dataManagerMock.getSkills.mockImplementation(() => []);
    });

    test('skilling at eff+999 clamps success to the 5% floor and reports an impossible room as 0', () => {
        // Level 100 against room 1099 — the top of the new window
        const result = labyrinthClearRate.computeSkillingClearWithParams(zeroMetrics(), 100, 1099);
        expect(result.successChance).toBeCloseTo(0.05, 12);
        expect(result.clearChance).toBe(0);
        expect(result.expectedSeconds).toBe(Infinity);
        expect(Number.isNaN(result.xpPerRoom)).toBe(false);
    });

    test('a heavily buffed character at eff+999 still gets a bounded, finite clear chance', () => {
        const metrics = {
            ...zeroMetrics(),
            efficiencyBonus: 2,
            actionSpeedBonus: 1,
            doubleProgressBonus: 1,
            successBonus: 1,
        };
        const result = labyrinthClearRate.computeSkillingClearWithParams(metrics, 200, 1199);
        // The floor holds even with +100% success gear: the level penalty dwarfs it
        expect(result.successChance).toBeCloseTo(0.05, 12);
        expect(result.clearChance).toBeGreaterThanOrEqual(0);
        expect(result.clearChance).toBeLessThan(1e-6);
        expect(Number.isFinite(result.clearChance)).toBe(true);
        expect(Number.isNaN(result.expectedSeconds)).toBe(false);
    });

    test('enhancing at eff+999 clamps to the floor and never reports NaN', () => {
        const result = labyrinthClearRate.computeEnhancingClearWithParams(zeroMetrics(), 100, 1099);
        expect(result.successChance).toBeCloseTo(0.05, 12);
        expect(result.clearChance).toBeGreaterThanOrEqual(0);
        expect(result.clearChance).toBeLessThan(0.001);
        expect(Number.isNaN(result.clearChance)).toBe(false);
        expect(Number.isNaN(result.expectedSeconds)).toBe(false);
    });

    test('the 100% ceiling holds when the character towers over the room', () => {
        const result = labyrinthClearRate.computeSkillingClearWithParams(zeroMetrics(), 1000, 1);
        expect(result.successChance).toBe(1);
        expect(result.clearChance).toBeLessThanOrEqual(1);
    });

    test('the skilling recommend search stays inside the window and off the clamp', () => {
        dataManagerMock.getSkills.mockImplementation(() => [{ skillHrid: '/skills/milking', level: 100 }]);
        const threshold = labyrinthClearRate.findRecommendedThreshold('/skills/milking', 0.7);
        expect(Number.isFinite(threshold)).toBe(true);
        expect(threshold).toBeGreaterThanOrEqual(-1000);
        // A level-100 character cannot clear rooms 999 above them at 70% — the
        // answer must be a real threshold, not the window edge
        expect(threshold).toBeLessThan(1000);
        // The search invariant: one step higher no longer meets the bar
        const eff = labyrinthClearRate.getEffectiveLevel('/skills/milking');
        const above = labyrinthClearRate.computeSkillingClear('/skills/milking', Math.floor(eff + threshold + 1 - 1));
        expect(above.clearChance).toBeLessThan(0.7);
    });

    test('the enhancing recommend search terminates finitely over the widened window', () => {
        dataManagerMock.getSkills.mockImplementation(() => [{ skillHrid: '/skills/enhancing', level: 150 }]);
        const threshold = labyrinthClearRate.findRecommendedThreshold('/skills/enhancing', 0.7);
        expect(threshold === null || Number.isFinite(threshold)).toBe(true);
        if (threshold !== null) {
            expect(threshold).toBeGreaterThanOrEqual(-1000);
            expect(threshold).toBeLessThan(1000);
        }
    });

    test('a level-1 character searches the mostly-negative window without hanging', () => {
        const threshold = labyrinthClearRate.findRecommendedThreshold('/skills/milking', 0.7);
        expect(threshold === null || (Number.isFinite(threshold) && Math.abs(threshold) <= 1000)).toBe(true);
    });

    test('getCombatSkipRoomLevel does the plain arithmetic at the new range', () => {
        vi.spyOn(labyrinthClearRate, 'getCombatSkipThreshold').mockReturnValue(1000);
        vi.spyOn(labyrinthClearRate, 'getPlayerEffectiveCombatLevel').mockReturnValue(150);
        expect(labyrinthClearRate.getCombatSkipRoomLevel('/monsters/imp')).toBe(1149);
    });

    // Native MWI persists skip thresholds across -999..999 and the recommendation
    // search above spans the same signed window, so a saved negative threshold is a
    // real setting. Reading it back as 0 stopped Apply Skip matching the row and
    // dropped the clear-rate badge for every negative or zero threshold.
    describe('signed skip thresholds survive the round trip', () => {
        afterEach(() => {
            dataManagerMock.characterData = null;
        });

        test('a negative skilling threshold reads back with its sign', () => {
            dataManagerMock.characterData = { characterSetting: { labyrinthSkipMilking: -22 } };
            expect(labyrinthClearRate.getSkipThreshold('/skills/milking')).toBe(-22);
        });

        test('a negative combat threshold reads back with its sign', () => {
            dataManagerMock.characterData = { characterSetting: { labyrinthSkipGiantShoeBird: -7 } };
            expect(labyrinthClearRate.getCombatSkipThreshold('/monsters/giant_shoe_bird')).toBe(-7);
        });

        test('a negative threshold still names the room it fights, not zero', () => {
            dataManagerMock.characterData = { characterSetting: { labyrinthSkipMilking: -22 } };
            dataManagerMock.getSkills.mockImplementation(() => [{ skillHrid: '/skills/milking', level: 100 }]);
            // floor(100 + -22 - 1)
            expect(labyrinthClearRate.getTargetRoomLevel('/skills/milking')).toBe(77);
        });

        test('a negative combat threshold names its room too', () => {
            vi.spyOn(labyrinthClearRate, 'getCombatSkipThreshold').mockReturnValue(-30);
            vi.spyOn(labyrinthClearRate, 'getPlayerEffectiveCombatLevel').mockReturnValue(150);
            expect(labyrinthClearRate.getCombatSkipRoomLevel('/monsters/imp')).toBe(119);
        });

        /**
         * Zero is what the reader returns for a setting that was never saved, and the
         * automation panel reads a room level of 0 as "no skip configured, draw no
         * badge". Deriving a level from it put a badge (and a queued sim) on every row.
         */
        test('an unset threshold still names no room at all', () => {
            dataManagerMock.characterData = { characterSetting: {} };
            dataManagerMock.getSkills.mockImplementation(() => [{ skillHrid: '/skills/milking', level: 100 }]);
            expect(labyrinthClearRate.getSkipThreshold('/skills/milking')).toBe(0);
            expect(labyrinthClearRate.getTargetRoomLevel('/skills/milking')).toBe(0);
        });

        test('an unset combat threshold names no room either', () => {
            vi.spyOn(labyrinthClearRate, 'getCombatSkipThreshold').mockReturnValue(0);
            vi.spyOn(labyrinthClearRate, 'getPlayerEffectiveCombatLevel').mockReturnValue(150);
            expect(labyrinthClearRate.getCombatSkipRoomLevel('/monsters/imp')).toBe(0);
        });

        test('only the derived room level is clamped, never the threshold', () => {
            dataManagerMock.characterData = { characterSetting: { labyrinthSkipMilking: -400 } };
            dataManagerMock.getSkills.mockImplementation(() => [{ skillHrid: '/skills/milking', level: 100 }]);
            expect(labyrinthClearRate.getSkipThreshold('/skills/milking')).toBe(-400);
            expect(labyrinthClearRate.getTargetRoomLevel('/skills/milking')).toBe(0);
        });
    });
});

describe('the stale-gear marker on a cached room tile', () => {
    /** Replace the mocked loadoutSnapshot's gear in place, keeping the reference */
    function setGear(equipmentSnapshots) {
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        Object.assign(gear.snapshots, equipmentSnapshots);
    }

    const sword = { equipment: [{ itemHrid: '/items/sword', enhancementLevel: 5 }] };
    const axe = { equipment: [{ itemHrid: '/items/axe', enhancementLevel: 0 }] };

    /** Draw the note for a result and read back what it said */
    const noteFor = (result) => {
        const el = document.createElement('div');
        labyrinthClearRate._appendCacheAgeNote(el, result);
        return el.textContent;
    };

    beforeEach(() => {
        gear.ready = true;
        setGear({ 1: sword });
    });

    test('a result simmed under the gear worn now shows its age, not a mark', () => {
        const fingerprint = labyrinthClearRate._snapshotContentFingerprint();
        const text = noteFor({
            fromPersistedCache: true,
            computedAt: Date.now() - 2 * 60 * 60 * 1000,
            snapshotFingerprint: fingerprint,
        });
        expect(text).toContain('cached');
        expect(text).not.toContain('build changed');
    });

    test('a result simmed under other gear is marked, and the age gives way to it', () => {
        const stale = labyrinthClearRate._snapshotContentFingerprint();
        setGear({ 1: axe });

        const text = noteFor({
            fromPersistedCache: true,
            computedAt: Date.now() - 2 * 60 * 60 * 1000,
            snapshotFingerprint: stale,
        });
        expect(text).toBe('build changed since this was computed');
    });

    test('a result simmed this session is marked too — an equip does not refresh a sim', () => {
        const stale = labyrinthClearRate._snapshotContentFingerprint();
        setGear({ 1: axe });

        // No fromPersistedCache and no age: the case the Recompute button's own
        // tooltip admits to, which the age note could never have shown
        expect(noteFor({ snapshotFingerprint: stale })).toBe('build changed since this was computed');
    });

    test('nothing is marked before the loadout snapshots have landed', () => {
        // Otherwise a reload marks every tile on the floor at once: the
        // fingerprint over an empty snapshot set matches no stored one
        const stale = labyrinthClearRate._snapshotContentFingerprint();
        setGear({});
        gear.ready = false;

        const text = noteFor({ fromPersistedCache: true, computedAt: Date.now() - 1000, snapshotFingerprint: stale });
        expect(text).not.toContain('build changed');
        expect(text).toContain('cached');
    });

    test('an entry stored before the fingerprint existed shows the age only, as before', () => {
        setGear({ 1: axe });
        const text = noteFor({ fromPersistedCache: true, computedAt: Date.now() - 2 * 60 * 60 * 1000 });
        expect(text).toContain('cached');
        expect(text).not.toContain('build changed');
    });

    test('the marker names what the fingerprint checks and nothing else', () => {
        const stale = labyrinthClearRate._snapshotContentFingerprint();
        setGear({ 1: axe });
        const el = document.createElement('div');
        labyrinthClearRate._appendCacheAgeNote(el, { snapshotFingerprint: stale });

        // As of v3 the fingerprint covers loadouts, worn item + enhancement
        // level, the seven combat levels, the ability kit and the house rooms —
        // so "build" is now the honest word. Buffs and consumables are still
        // outside it, and the marker must not imply they were checked
        expect(el.textContent).toBe('build changed since this was computed');
        expect(el.textContent).not.toMatch(/buff|tea|drink|food/i);
        expect(el.firstChild.title).toContain('buffs and consumables are not');
    });
});

/**
 * The Recompute button is behind the Labyrinth tab, inside the Room Logs panel,
 * on a tab strip that panel injects. Registering it as a palette verb is the
 * whole point; a verb left registered after the feature is switched off would
 * be a list entry that quietly does nothing, which is what registration exists
 * to prevent.
 */
describe('the recompute verb', () => {
    afterEach(() => {
        labyrinthClearRate.unregisterHandlers = [];
        labyrinthClearRate.disable();
        labyrinthClearRate.isInitialized = false;
        resetCommands();
    });

    /** @returns {Object|undefined} The verb, as the palette would see it */
    const verb = () => registeredCommands().find((entry) => entry.name === 'Recompute lab sims');

    test('initialising offers it, and it is a verb rather than a panel', () => {
        resetCommands();
        labyrinthClearRate.isInitialized = false;
        labyrinthClearRate.initialize();

        expect(verb()).toBeDefined();
        expect(verb().kind).toBe('verb');
    });

    test('switching the feature off takes it out of the palette', () => {
        resetCommands();
        labyrinthClearRate.isInitialized = false;
        labyrinthClearRate.initialize();
        labyrinthClearRate.unregisterHandlers = [];
        labyrinthClearRate.disable();

        expect(verb()).toBeUndefined();
    });

    test('it reports the room count, pluralised', async () => {
        resetCommands();
        labyrinthClearRate.isInitialized = false;
        labyrinthClearRate.initialize();

        const spy = vi.spyOn(labyrinthClearRate, 'recomputeStaleCombatSims');

        spy.mockResolvedValue(3);
        expect(await verb().run()).toBe('3 stale rooms queued');

        spy.mockResolvedValue(1);
        expect(await verb().run()).toBe('1 stale room queued');
        spy.mockRestore();
    });

    test('with nothing to do it says so rather than vanishing', async () => {
        resetCommands();
        labyrinthClearRate.isInitialized = false;
        labyrinthClearRate.initialize();

        const spy = vi.spyOn(labyrinthClearRate, 'recomputeStaleCombatSims').mockResolvedValue(0);
        expect(await verb().run()).toBe('nothing stale');
        // Still listed: an entry you can only find on the days it would have
        // worked is one you cannot learn
        expect(verb()).toBeDefined();
        spy.mockRestore();
    });
});

/**
 * The build fingerprint is what every stored labyrinth record keys on. v1
 * hashed gear alone, so a combat level-up left it unchanged and the replay
 * pooled fights from either side of one — then reported the resulting gap as
 * the sim over-crediting damage. These pin the widened inputs, the version tag
 * that keeps the two definitions from ever matching, and what still does and
 * does not move the value.
 */
const { FINGERPRINT_PREFIX } = await import('./labyrinth-fingerprint.js');
const { gearChangedSince } = await import('./labyrinth-sim-cache.js');

describe('the build fingerprint', () => {
    /** Replace the mocked loadoutSnapshot's gear in place */
    const setGear = (snapshots) => {
        for (const key of Object.keys(gear.snapshots)) delete gear.snapshots[key];
        Object.assign(gear.snapshots, snapshots);
    };

    const skill = (name, level) => ({ skillHrid: `/skills/${name}`, level });
    const levels = (over = {}) => {
        const base = { stamina: 90, intelligence: 80, attack: 95, defense: 92, melee: 99, ranged: 1, magic: 1 };
        return Object.entries({ ...base, ...over }).map(([name, level]) => skill(name, level));
    };

    const sword = { equipment: [{ itemHrid: '/items/sword', enhancementLevel: 5 }] };
    const axe = { equipment: [{ itemHrid: '/items/axe', enhancementLevel: 0 }] };

    beforeEach(() => {
        setGear({ 1: sword });
        dataManagerMock.getSkills.mockReturnValue(levels());
    });

    afterEach(() => {
        dataManagerMock.getSkills.mockReturnValue([]);
    });

    test('a combat level-up moves the fingerprint with the gear held still', () => {
        const before = labyrinthClearRate._snapshotContentFingerprint();
        dataManagerMock.getSkills.mockReturnValue(levels({ melee: 100 }));
        expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);
    });

    test('every combat level the sim reads moves it, not just the offensive ones', () => {
        // Stamina is max HP and intelligence is max MP; both decide fights the
        // sim runs, and neither touches an item
        const before = labyrinthClearRate._snapshotContentFingerprint();
        for (const name of ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic']) {
            dataManagerMock.getSkills.mockReturnValue(levels({ [name]: 200 }));
            expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);
        }
    });

    test('a skilling level does not move it', () => {
        // buildPlayerDTO carries them, Player.createFromDTO never reads one, so
        // no skilling level can change a combat sim's answer — and hashing them
        // would drop the whole combat cache on every woodcutting level
        const before = labyrinthClearRate._snapshotContentFingerprint();
        dataManagerMock.getSkills.mockReturnValue([...levels(), skill('woodcutting', 150)]);
        expect(labyrinthClearRate._snapshotContentFingerprint()).toBe(before);
    });

    test('a gear change still moves it, levels held still', () => {
        const before = labyrinthClearRate._snapshotContentFingerprint();
        setGear({ 1: axe });
        expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);
    });

    test('nothing changing leaves it alone', () => {
        expect(labyrinthClearRate._snapshotContentFingerprint()).toBe(labyrinthClearRate._snapshotContentFingerprint());
    });

    test('the value carries its version, so a v1 record can never match one', () => {
        const current = labyrinthClearRate._snapshotContentFingerprint();
        expect(current.startsWith(FINGERPRINT_PREFIX)).toBe(true);
        // A v1 value is the bare djb2 output — no prefix, and no way to collide
        // with a tagged one whatever the hash happens to be
        expect(current).not.toBe(current.slice(FINGERPRINT_PREFIX.length));
    });

    test('a stored v1 fingerprint reads as a gear change, so its cached sims are re-simmed', () => {
        const stored = labyrinthClearRate._hashString('anything the old definition produced');
        expect(gearChangedSince(stored, labyrinthClearRate._snapshotContentFingerprint(), true)).toBe(true);
    });

    describe('what v3 added: abilities and house rooms', () => {
        /** The DTO shape `_simBuildInputs` reads its two new parts off */
        const dto = (over = {}) => ({
            abilities: [
                { hrid: '/abilities/berserk', level: 20, triggers: null },
                { hrid: '/abilities/cleave', level: 15, triggers: null },
                null,
                null,
                null,
            ],
            houseRooms: { '/house_rooms/gym': 5, '/house_rooms/dairy_barn': 0 },
            drinks: [{ hrid: '/items/super_magic_coffee', triggers: null }, null, null],
            food: [null, null, null],
            ...over,
        });

        beforeEach(() => {
            dataManagerMock.characterData = { characterAbilities: [] };
            dataManagerMock.getInitClientData.mockReturnValue({ itemDetailMap: {} });
            adapterMock.buildPlayerDTO.mockReturnValue(dto());
        });

        afterEach(() => {
            dataManagerMock.characterData = null;
            dataManagerMock.getInitClientData.mockReturnValue(null);
            adapterMock.buildPlayerDTO.mockReset();
        });

        test('swapping an equipped ability moves the fingerprint, gear and levels held still', () => {
            const before = labyrinthClearRate._snapshotContentFingerprint();
            adapterMock.buildPlayerDTO.mockReturnValue(
                dto({
                    abilities: [
                        { hrid: '/abilities/berserk', level: 20, triggers: null },
                        { hrid: '/abilities/precision', level: 15, triggers: null },
                        null,
                        null,
                        null,
                    ],
                })
            );
            expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);
        });

        test('an ability levelling up moves it too', () => {
            const before = labyrinthClearRate._snapshotContentFingerprint();
            adapterMock.buildPlayerDTO.mockReturnValue(
                dto({
                    abilities: [
                        { hrid: '/abilities/berserk', level: 21, triggers: null },
                        { hrid: '/abilities/cleave', level: 15, triggers: null },
                        null,
                        null,
                        null,
                    ],
                })
            );
            expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);
        });

        test('a house room level moves it, and a room standing at 0 does not', () => {
            const before = labyrinthClearRate._snapshotContentFingerprint();
            adapterMock.buildPlayerDTO.mockReturnValue(
                dto({ houseRooms: { '/house_rooms/gym': 6, '/house_rooms/dairy_barn': 0 } })
            );
            expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);

            // Player.createFromDTO skips level 0, so an unbuilt room is not part
            // of the build and must not be part of the hash
            adapterMock.buildPlayerDTO.mockReturnValue(dto({ houseRooms: { '/house_rooms/gym': 5 } }));
            expect(labyrinthClearRate._snapshotContentFingerprint()).toBe(before);
        });

        test('changing a tea or a drink does NOT move it', () => {
            // Deliberate: consumables change several times an hour, so hashing
            // them would restart the cohort before it could ever reach the
            // fights a reading needs, and every reading would read "too few to
            // call" forever
            const before = labyrinthClearRate._snapshotContentFingerprint();
            adapterMock.buildPlayerDTO.mockReturnValue(
                dto({
                    drinks: [{ hrid: '/items/super_magic_tea', triggers: null }, null, null],
                    food: [{ hrid: '/items/orange_gummy', triggers: null }, null, null],
                })
            );
            expect(labyrinthClearRate._snapshotContentFingerprint()).toBe(before);
        });

        test('a loadout-named ability levelling up moves it with the equipped kit untouched', () => {
            // A loadout room sims the snapshot's abilities at the character's
            // current levels, which the snapshot itself does not carry
            setGear({ 1: { ...sword, abilities: [{ abilityHrid: '/abilities/toughness' }] } });
            dataManagerMock.characterData = {
                characterAbilities: [{ abilityHrid: '/abilities/toughness', level: 7 }],
            };
            const before = labyrinthClearRate._snapshotContentFingerprint();

            dataManagerMock.characterData = {
                characterAbilities: [{ abilityHrid: '/abilities/toughness', level: 8 }],
            };
            expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(before);
        });

        test('a build that cannot be read yet is a placeholder, not an empty kit', () => {
            // Callers gate on snapshotsReady, so the placeholder is never
            // mistaken for a character who has unequipped everything
            const read = labyrinthClearRate._snapshotContentFingerprint();
            adapterMock.buildPlayerDTO.mockReturnValue(null);
            expect(labyrinthClearRate._snapshotContentFingerprint()).not.toBe(read);
        });
    });
});

/**
 * A character switch tears the feature down while a sim batch is mid-flight.
 * Everything the batch would otherwise do on its way out belongs to the
 * character that has already gone: the flags the arriving character's own run
 * has since claimed, the timers `disable()` just cancelled, and the badges it
 * would draw onto a board that is no longer the one it was simulating.
 */
describe('a teardown mid-sim', () => {
    beforeEach(() => {
        cancelSpy.fn.mockClear();
        document.body.innerHTML = '';
        labyrinthClearRate.unregisterHandlers = [];
        labyrinthClearRate.tileCalcRunning = false;
        labyrinthClearRate._simCancelRequested = false;
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate.simQueue = [];
    });

    afterEach(() => {
        document.body.innerHTML = '';
        labyrinthClearRate.unregisterHandlers = [];
        labyrinthClearRate.roomData = null;
        labyrinthClearRate.tileCalcRunning = false;
        labyrinthClearRate._simCancelRequested = false;
        labyrinthClearRate.combatCache.clear();
        labyrinthClearRate.simQueue = [];
    });

    /** Two combat rooms on a one-row floor, with the cells the tile pass needs */
    const twoRoomFloor = () => {
        const parent = document.createElement('div');
        for (let i = 0; i < 2; i++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell_abc';
            parent.appendChild(cell);
        }
        document.body.appendChild(parent);
        labyrinthClearRate.roomData = [
            [
                { monsterHrid: '/monsters/imp', recommendedLevel: 100, isCleared: false },
                { monsterHrid: '/monsters/imp', recommendedLevel: 120, isCleared: false },
            ],
        ];
    };

    test('the Calculate button still works after a character switch', () => {
        // The guard is the button's own: left true by teardown, every later
        // press is refused in silence — no error, no feedback, nothing happens
        labyrinthClearRate.tileCalcRunning = true;

        labyrinthClearRate.disable();

        expect(labyrinthClearRate.tileCalcRunning).toBe(false);
    });

    test('teardown drops the cached tile results and the fingerprint that revives them', () => {
        // `_autoCalcFingerprint` is what makes an auto pass skip the sims and
        // redraw badges from `_tileResults` instead. Left standing across a
        // switch, it is one matching fingerprint away from painting the
        // departing character's clear chances onto the arriving character's
        // grid — today only the gear snapshot in the fingerprint prevents it.
        labyrinthClearRate._tileResults = new Map([['0,0', { clearChance: 0.9 }]]);
        labyrinthClearRate._autoCalcFingerprint = 'departing-character';

        labyrinthClearRate.disable();

        expect(labyrinthClearRate._tileResults.size).toBe(0);
        expect(labyrinthClearRate._autoCalcFingerprint).toBeNull();
    });

    test('teardown forgets the run itself, not only its grid', () => {
        // `currentLabyrinthState()` answers with `_labyrinth` before it looks at
        // `dataManager.characterData`, so a live message left standing keeps
        // answering for a character who has gone — supplies, floor and all. And
        // `seedFromCharacterData()` only fills `_pathData` when it is null, so a
        // surviving path blocks the arriving character's own from being seeded.
        labyrinthClearRate._labyrinth = { isActive: true, currentFloor: 7, torchCount: 3 };
        labyrinthClearRate._pathData = '[{"x":2,"y":1}]';
        labyrinthClearRate.currentFloor = 7;

        labyrinthClearRate.disable();

        expect(labyrinthClearRate._labyrinth).toBeNull();
        expect(labyrinthClearRate._pathData).toBeNull();
        expect(labyrinthClearRate.currentFloor).toBe(0);
    });

    test('teardown stops the sim in flight, not just the queue behind it', () => {
        labyrinthClearRate.simQueue = [{ monsterHrid: '/monsters/imp', roomLevel: 200, badge: null }];

        labyrinthClearRate.disable();

        expect(cancelSpy.fn).toHaveBeenCalled();
        expect(labyrinthClearRate.simQueue).toHaveLength(0);
    });

    test('a floor calculation torn down mid-room leaves the next run’s state alone', async () => {
        twoRoomFloor();
        const spy = vi.spyOn(labyrinthClearRate, 'computeCombatClear').mockImplementation(async () => {
            // The character switch lands inside the first room's sim
            labyrinthClearRate.disable();
            // ...and the arriving character starts a calculation of its own
            labyrinthClearRate.tileCalcRunning = true;
            return { clearChance: 0.5, expectedSeconds: 10 };
        });

        await labyrinthClearRate.runTileCalculation();

        // The stale pass simulated one room and stopped, and its `finally` did
        // not clear the flag the arriving character's run now owns
        expect(spy).toHaveBeenCalledTimes(1);
        expect(labyrinthClearRate.tileCalcRunning).toBe(true);
        spy.mockRestore();
        labyrinthClearRate.tileCalcRunning = false;
    });

    test('a recommend run torn down mid-room draws nothing onto the new board', async () => {
        const cell = document.createElement('div');
        cell.className = 'LabyrinthPanel_skipThreshold_abc';
        cell.setAttribute('data-hrid', '/monsters/imp');
        document.body.appendChild(cell);
        const extract = vi
            .spyOn(labyrinthClearRate, 'extractRoomHrid')
            .mockImplementation((el) => el.getAttribute('data-hrid'));
        const inject = vi.spyOn(labyrinthClearRate, 'injectRecommendationBadges').mockImplementation(() => {});
        const search = vi.spyOn(labyrinthClearRate, 'findRecommendedThresholdCombat').mockImplementation(async () => {
            labyrinthClearRate.disable();
            return 5;
        });

        await labyrinthClearRate.runRecommendations();

        expect(inject).not.toHaveBeenCalled();
        search.mockRestore();
        inject.mockRestore();
        extract.mockRestore();
    });
});
