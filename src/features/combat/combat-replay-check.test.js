/**
 * @vitest-environment happy-dom
 *
 * Sim accuracy, checked on the three things that could make it lie.
 *
 * **The derivation**, against the same recorded Planet of the Eyes run the
 * attribution replays. A metric derived from real payloads is the only kind
 * worth comparing to a simulator, and the ways it can be wrong are all boundary
 * conditions — a fight cut off by the end of the recording counted as a fast
 * one, the ticks before the first `new_battle` filed under a fight they do not
 * belong to, monster counters carried between battles that reuse the same
 * indices.
 *
 * **The deviation arithmetic**, which is where a sign error would turn "your
 * damage is 10% under the prediction" into the opposite advice.
 *
 * **The noise margin**, which is the whole point: without one, six fights will
 * flag a disagreement every time, and a check that always says the simulator is
 * wrong is a check nobody reads twice.
 *
 * A DOM because the module registers an overlay row and builds a panel at import.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** What the adapter would say the character is wearing, and what the sim was handed */
const game = vi.hoisted(() => ({
    dto: {},
    zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 },
    lastRun: null,
    simResult: {},
    /** Set to a pending promise to park `runSimulation` mid-flight */
    runGate: null,
    /** data-manager event → handlers, so a test can fire a character switch */
    characterHandlers: new Map(),
    /** Whoever the data manager is pretending to be */
    characterId: 'char1',
}));

/** Storage, as a map, with the quota switch the recorders stand down on */
const store = vi.hoisted(() => ({ data: new Map(), quota: false, holds: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback, Z_FLOATING_PANEL: 100 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            // A read a test can hold open, for the switch-mid-read cases
            if (store.holds.has(key)) await store.holds.get(key);
            return store.data.has(key) ? store.data.get(key) : fallback;
        },
        tryGet: async (key) => {
            if (store.unavailable) return null;
            return store.data.has(key) && store.data.get(key) != null
                ? { found: true, value: structuredClone(store.data.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value) => {
            if (store.unavailable) return false;
            store.data.set(key, value);
            return true;
        },
        delete: async (key) => {
            store.data.delete(key);
            return true;
        },
        getAllKeys: async () => Array.from(store.data.keys()),
        isQuotaExceeded: () => store.quota,
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ actionDetailMap: { '/actions/combat/fly': { name: 'Fly' } } }),
        // The panel's draw reaches storage through the character key
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        // Captured so a test can fire a character switch at whatever the
        // module subscribed at import time
        on: (event, handler) => {
            if (!game.characterHandlers.has(event)) game.characterHandlers.set(event, []);
            game.characterHandlers.get(event).push(handler);
        },
        off: (event, handler) => {
            game.characterHandlers.set(
                event,
                (game.characterHandlers.get(event) || []).filter((entry) => entry !== handler)
            );
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({}),
    // A fresh copy each time, as the real one builds: a test that mutated the
    // snapshot would otherwise be mutating what the adapter is pretending to read
    buildPlayerDTO: () => (game.dto ? structuredClone(game.dto) : null),
    getCommunityBuffs: () => ({}),
    getCurrentCombatZone: () => game.zone,
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runSimulation: async (options) => {
        game.lastRun = options;
        // A test can arm `game.runGate` to park the simulation mid-flight —
        // long enough to fire a character switch before it resolves, which is
        // the shape a real 12-simulated-hour run gives a real switch every time.
        if (game.runGate) await game.runGate;
        return game.simResult;
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    clampGeometry: (geometry) => geometry,
    allGeometry: async () => ({}),
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    clearPosition: async () => {},
    restoreGeometry: async () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));

import replayCheck, {
    replayCheckPanel,
    replayFights,
    busiestPlayer,
    observeRecording,
    waveTimingFromRecording,
    dungeonWaveTiming,
    aggregateObservations,
    predictFromSim,
    deviationPct,
    noiseMargin,
    noiseSummary,
    captureLoadoutSnapshot,
    applyLoadoutSnapshot,
    compareMetric,
    compareRun,
    deathCheck,
    sanitizeExportFile,
    summaryLine,
    predictedSwings,
    sampleSizeFor,
    deviationHints,
    historyEntry,
    pruneHistory,
    dropRates,
    MIN_SAMPLE_FIGHTS,
    SIM_HOURS,
    SIM_NOISE_FLOOR_PCT,
    NOISE_QUIET_PCT,
} from './combat-replay-check.js';
import combatRecorder from './combat-recorder.js';
import { resetRecordTargetCache } from './combat-record-control.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import recording from '../../utils/__fixtures__/combat-run.json';

/** Where the scoped keys land, given the character the data manager is pretending to be */
const OBSERVATIONS_KEY = 'combatReplayCheck_observations_char1';
const HISTORY_KEY = 'combatReplayCheck_history_char1';
/** Both records are stored as `{ clearedAt, entries }` so Forget survives a pull */
const storedList = (key) => store.data.get(key)?.entries;
const CHECKPOINT_KEY = 'combatReplayCheck_recordingCheckpoint_char1';

/** A character wearing something, in the shape the adapter hands the simulator */
function loadout({ weapon = '/items/sword', enhancement = 5, attack = 90, ability = '/abilities/poke' } = {}) {
    return {
        hrid: 'player1',
        attackLevel: attack,
        meleeLevel: attack,
        defenseLevel: 70,
        magicLevel: 1,
        rangedLevel: 1,
        staminaLevel: 80,
        intelligenceLevel: 60,
        // Skilling levels never enter a fight and are not part of the snapshot
        cookingLevel: 42,
        equipment: { main_hand: { hrid: weapon, enhancementLevel: enhancement } },
        abilities: [null, { hrid: ability, level: 3, triggers: null }, null, null, null],
        food: [{ hrid: '/items/donut', triggers: null }, null, null],
        drinks: [{ hrid: '/items/coffee', triggers: null }, null, null],
        houseRooms: { '/house_rooms/dairy_barn': 6 },
        guildShrineLevels: { attack: 2 },
        guildCombatBuffs: [{ typeHrid: '/buff_types/attack_level', flatBoost: 3 }],
        achievementCombatBuffs: [],
        // World state, not the character's: these come from now, never the snapshot
        communityBuffLevels: { experience: 4 },
        tokenUpgrades: { speed: 1 },
    };
}

/** Let the awaits inside a fire-and-forget handler settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fire one data-manager event at whatever the module subscribed at import time */
const emitCharacter = (event, data) => (game.characterHandlers.get(event) || []).forEach((handler) => handler(data));

beforeEach(() => {
    store.data.clear();
    store.holds.clear();
    game.characterId = 'char1';
    store.quota = false;
    store.unavailable = false;
    game.dto = loadout();
    game.zone = { zoneHrid: '/actions/combat/fly', difficultyTier: 0 };
    game.lastRun = null;
    game.simResult = {};
    game.runGate = null;
    replayCheck.observations = [];
    replayCheck.history = [];
    replayCheck.comparison = null;
    replayCheck.error = null;
    replayCheck.loaded = false;
    replayCheck.disable();
    // The record-target control keeps module-level state — whether the stored
    // target has been read, and a target read back while a recording was
    // running that is waiting for a quiet moment to be applied. A test that
    // starts a recording leaves that stash behind, and the next test's first
    // panel redraw consumes it and overwrites whatever that test just set. Each
    // test is its own session, so clear it the way a character switch does.
    resetRecordTargetCache();
});

describe('deriving what happened from a recording', () => {
    const fights = replayFights(recording.ticks);

    test('a recording is split at every battle but the last', () => {
        // Six `new_battle` messages, and the sixth battle was still being fought
        // when the recording stopped — its length is unknown, so it is dropped
        const battles = recording.ticks.filter((tick) => tick.type === 'new_battle').length;
        expect(battles).toBe(6);
        expect(fights).toHaveLength(battles - 1);
    });

    test('every fight has a positive length and knows what it was against', () => {
        for (const fight of fights) {
            expect(fight.seconds).toBeGreaterThan(0);
            expect(fight.monsters.length).toBeGreaterThan(0);
        }
    });

    test('a fight runs to the next battle, so the lengths tile the run', () => {
        const spanned = fights.reduce((total, fight) => total + fight.seconds, 0);
        const first = fights[0].startAt;
        const last = fights[fights.length - 1].endAt;
        expect(spanned).toBeCloseTo((last - first) / 1000, 6);
    });

    test('the ticks before the first battle belong to no fight', () => {
        // The recording starts mid-battle. Filing those ticks under the first
        // `new_battle` would credit its damage to a fight that had not begun.
        const firstBattleAt = recording.ticks.find((tick) => tick.type === 'new_battle').at;
        expect(fights[0].startAt).toBe(firstBattleAt);
    });

    test('the run is attributed to the one character who fought it', () => {
        expect(busiestPlayer(fights)).toBe('0');
    });

    test('the damage per fight sums to what the attribution replay measures', () => {
        // The same total the attribution's own replay asserts, arrived at by
        // splitting the run first — if the per-battle reset were wrong, this is
        // where the monsters carried between battles would show up
        const dealt = fights.reduce((total, fight) => total + (fight.players['0']?.damage || 0), 0);
        expect(dealt).toBeGreaterThan(15_000);
    });

    test('the kills are counted, and there are fewer than the whole run had', () => {
        // Fourteen across the whole recording, minus whatever the dropped last
        // battle and the pre-battle ticks contributed
        const killed = fights.reduce((total, fight) => total + fight.kills, 0);
        expect(killed).toBeGreaterThan(0);
        expect(killed).toBeLessThanOrEqual(14);
    });

    test('damage taken is derived too, from the same ticks', () => {
        const taken = fights.reduce((total, fight) => total + (fight.taken['0']?.damage || 0), 0);
        expect(taken).toBeGreaterThan(0);
    });
});

describe('the opening swing of every fight, which used to be invisible', () => {
    /**
     * A wave of one monster, hit `hits` times and killed.
     *
     * The shape that matters is that the monster is **not** in the tick stream
     * until the first hit lands on it — `mMap` is a delta, so a fresh spawn has
     * nothing to report until something happens to it, and the first thing that
     * happens is being hit.
     *
     * @param {Object} options - `{maxHP, hit, hits}`
     * @returns {Array<Object>} Ticks, ending on the battle that closes the fight
     */
    function wave({ maxHP = 100, openingHP = maxHP, hit = 20, hits = 5 } = {}) {
        const ticks = [
            {
                at: 0,
                type: 'new_battle',
                payload: {
                    players: { 0: { name: 'Tester', isPreparingAutoAttack: true } },
                    monsters: {
                        0: { name: 'Fly', combatDetails: { currentHitpoints: openingHP, maxHitpoints: maxHP } },
                    },
                },
            },
        ];

        let health = openingHP;
        for (let i = 1; i <= hits; i += 1) {
            health = Math.max(0, health - hit);
            ticks.push({
                at: i * 1000,
                type: 'battle_updated',
                payload: {
                    pMap: { 0: { atkCounter: i, isAutoAtk: true } },
                    mMap: { 0: { cHP: health, mHP: maxHP, dmgCounter: i, critCounter: 0 } },
                },
            });
        }

        ticks.push({ at: (hits + 1) * 1000, type: 'new_battle', payload: ticks[0].payload });
        return ticks;
    }

    test('the first hit on a fresh spawn counts, and its damage with it', () => {
        // The monster is only in the feed because it was hit. Without a
        // baseline from `new_battle` there is nothing to diff that first tick
        // against, so the swing and its damage went missing — once per monster
        // per fight, which is the opener every time
        const [fight] = replayFights(wave({ maxHP: 100, hit: 20, hits: 5 }));

        expect(fight.players['0'].hits).toBe(5);
        expect(fight.players['0'].damage).toBe(100);
    });

    test('a wave the battle message did not price is left alone rather than guessed at', () => {
        const ticks = wave();
        ticks[0].payload.monsters[0].combatDetails = {};
        ticks[ticks.length - 1].payload = ticks[0].payload;

        // Back to the old reading, which is the honest one when nothing says
        // what the monster started on: four of the five hits
        const [fight] = replayFights(ticks);
        expect(fight.players['0'].hits).toBe(4);
    });

    test('a wave that opens already hurt is priced from what it opened on', () => {
        // Current health before max, so an opener against something already
        // damaged is worth what it actually took off rather than the whole bar
        const [fight] = replayFights(wave({ maxHP: 100, openingHP: 60, hit: 20, hits: 3 }));

        expect(fight.players['0'].hits).toBe(3);
        expect(fight.players['0'].damage).toBe(60);
    });

    test('on a real recording it is 15-25% of every swing, and of the damage', () => {
        const fights = replayFights(recording.ticks);
        // The number the whole thing turned on. A sample that reads a fifth
        // short on swings while killing on schedule is not a slow character; it
        // is an accounting error, and this was it.
        const swung = fights.reduce(
            (total, fight) => total + (fight.players['0']?.hits || 0) + (fight.players['0']?.misses || 0),
            0
        );
        expect(swung).toBe(48);

        // Every monster of every wave can contribute at most one recovered
        // swing — its opener — so the ceiling is the number of spawns, and the
        // floor is one per fight, since something has to open every fight
        const spawns = recording.ticks
            .filter((tick) => tick.type === 'new_battle')
            .slice(0, -1)
            .reduce((total, tick) => total + Object.keys(tick.payload.monsters).length, 0);
        const recovered = swung - 42;
        expect(recovered).toBeGreaterThanOrEqual(fights.length);
        expect(recovered).toBeLessThanOrEqual(spawns);
    });
});

describe('the endpoint reconciliation', () => {
    // The same wave shape the opener tests use: one monster, killed in hits
    const battle = (openingHP = 100, maxHP = 100) => ({
        at: 0,
        type: 'new_battle',
        payload: {
            players: { 0: { name: 'Tester', isPreparingAutoAttack: true } },
            monsters: { 0: { name: 'Fly', combatDetails: { currentHitpoints: openingHP, maxHitpoints: maxHP } } },
        },
    });
    const hit = (at, counter, health) => ({
        at,
        type: 'battle_updated',
        payload: {
            pMap: { 0: { atkCounter: counter, isAutoAtk: true } },
            mMap: { 0: { cHP: health, mHP: 100, dmgCounter: counter, critCounter: 0 } },
        },
    });
    const close = (at) => ({ ...battle(), at });

    test('a clean capture reconciles to zero', () => {
        const [fight] = replayFights([battle(), hit(1000, 1, 80), hit(2000, 2, 60), hit(3000, 3, 0), close(4000)]);
        expect(fight.endpointDealt).toBe(100);
        expect(fight.unattributedDealt).toBe(0);
    });

    test('counterless damage is credited too, and the residual closes', () => {
        // The bleed: health falls with no counter movement, so the hit gate
        // refuses it as a *swing* — but the monster is still down those
        // hitpoints, and they are now attributed as their own class. The
        // residual this test used to measure is what that closed.
        const bleed = {
            at: 2000,
            type: 'battle_updated',
            payload: { mMap: { 0: { cHP: 55, mHP: 100, dmgCounter: 1, critCounter: 0 } } },
        };
        const [fight] = replayFights([battle(), hit(1000, 1, 80), bleed, hit(3000, 2, 30), close(4000)]);
        expect(fight.players['0'].damage).toBe(70); // 20 + 25 counted, 25 bled
        expect(fight.players['0'].dotDamage).toBe(25);
        expect(fight.endpointDealt).toBe(70); // 100 → 30, every point of it
        expect(fight.unattributedDealt).toBe(0);
    });

    test('a self-heal raises what the endpoints owe, not the residual', () => {
        const healTick = {
            at: 2000,
            type: 'battle_updated',
            payload: { mMap: { 0: { cHP: 90, mHP: 100, dmgCounter: 1, critCounter: 0 } } },
        };
        const [fight] = replayFights([battle(), hit(1000, 1, 80), healTick, hit(3000, 2, 70), close(4000)]);
        expect(fight.healedUp).toBe(10);
        // start − end + healed: 100 − 70 + 10 = 40, which is the two hits
        expect(fight.endpointDealt).toBe(40);
        expect(fight.unattributedDealt).toBe(0);
    });

    test('the real recording reconciles: residual present and non-negative', () => {
        const fights = replayFights(recording.ticks);
        for (const fight of fights) {
            expect(Number.isFinite(fight.endpointDealt)).toBe(true);
            expect(fight.unattributedDealt).toBeGreaterThanOrEqual(0);
        }
    });

    test('the aggregate carries the sums, and the coverage is honest on the fixture', () => {
        const observed = aggregateObservations([
            observeRecording(recording, { zoneHrid: '/z', difficultyTier: 0, recordedAt: 1 }),
        ]);
        expect(observed.endpointDealt).toBeGreaterThan(0);
        expect(observed.unattributedDealt).toBeGreaterThanOrEqual(0);
        // The attribution can credit at most what the endpoints state
        expect(observed.unattributedDealt).toBeLessThanOrEqual(observed.endpointDealt);
    });

    test('fights replayed before the residual existed aggregate as null, not zero', () => {
        const legacy = observeRecording(recording, { zoneHrid: '/z', difficultyTier: 0, recordedAt: 1 });
        for (const fight of legacy.fights) {
            delete fight.endpointDealt;
            delete fight.unattributedDealt;
        }
        const observed = aggregateObservations([legacy]);
        expect(observed.endpointDealt).toBe(null);
        expect(observed.unattributedDealt).toBe(null);
    });
});

describe('an observation', () => {
    const observation = observeRecording(recording, {
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        recordedAt: 1_700_000_000_000,
    });

    test('it is stamped with when and where, since the comparison depends on both', () => {
        expect(observation.recordedAt).toBe(1_700_000_000_000);
        expect(observation.zoneHrid).toBe('/actions/combat/fly');
    });

    test('it keeps the derived numbers and none of the payloads', () => {
        expect(observation.fights.length).toBeGreaterThan(0);
        for (const fight of observation.fights) {
            expect(Object.keys(fight).sort()).toEqual(
                [
                    'damageDealt',
                    'damageTaken',
                    'deaths',
                    // The endpoint reconciliation rides with each fight
                    'endpointDealt',
                    'unattributedDealt',
                    'hits',
                    'kills',
                    'misses',
                    'monsters',
                    'regen',
                    'seconds',
                    // One number per fight, which is all the experience band
                    // needs; the split between skills is a per-observation total
                    'xp',
                ].sort()
            );
        }
    });

    test('a solo run is recognised as one', () => {
        expect(observation.partySize).toBe(1);
    });

    test('a recording with no completed fight yields nothing rather than a zero', () => {
        expect(observeRecording({ ticks: [] })).toBe(null);
        expect(observeRecording({ ticks: recording.ticks.slice(0, 5) })).toBe(null);
    });
});

/**
 * An observation of `fights` identical fights, for the arithmetic tests.
 *
 * @param {Object} shape - `{seconds, damageDealt, damageTaken, fights}`
 * @returns {Object}
 */
function evenObservation({ seconds = 10, damageDealt = 1000, damageTaken = 100, fights = 5, ...rest } = {}) {
    return {
        recordedAt: 1_700_000_000_000,
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        truncated: false,
        partySize: 1,
        playerIndex: '0',
        fights: Array.from({ length: fights }, () => ({
            seconds,
            damageDealt,
            damageTaken,
            regen: 0,
            hits: 4,
            misses: 1,
            deaths: 0,
            kills: 3,
            monsters: ['Fly'],
        })),
        ...rest,
    };
}

describe('folding observations together', () => {
    test('the rates are ratios of the totals, not means of the fights', () => {
        const observed = aggregateObservations([evenObservation({ seconds: 10, damageDealt: 1000, fights: 4 })]);
        expect(observed.fights).toBe(4);
        expect(observed.seconds).toBe(40);
        expect(observed.dps).toBe(100);
        expect(observed.secondsPerFight).toBe(10);
    });

    test('two recordings of the same zone are one sample', () => {
        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000 }),
            evenObservation({ fights: 4, recordedAt: 2_000 }),
        ]);
        expect(observed.fights).toBe(7);
        expect(observed.recordings).toBe(2);
        expect(observed.recordedAt).toBe(2_000);
        expect(observed.oldestRecordedAt).toBe(1_000);
    });

    test('a recording of another zone is not folded in', () => {
        // Otherwise a session that moved zones would average two different
        // fights together and compare the average against one of them
        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000, zoneHrid: '/actions/combat/bee' }),
            evenObservation({ fights: 4, recordedAt: 2_000 }),
        ]);
        expect(observed.fights).toBe(4);
        expect(observed.recordings).toBe(1);
        expect(observed.zoneHrid).toBe('/actions/combat/fly');
    });

    test('nothing observed is null rather than a run of zeroes', () => {
        expect(aggregateObservations([])).toBe(null);
        expect(aggregateObservations([{ fights: [] }])).toBe(null);
    });
});

describe('reading the prediction off a sim result', () => {
    const simResult = {
        simulatedTime: 3600 * 1e9,
        encounters: 100,
        deaths: { player1: 2 },
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000, '/monsters/jungle_sprite': 18_000 },
        warnings: [],
    };

    test('damage per second is over the simulated clock, gaps included', () => {
        const predicted = predictFromSim(simResult);
        expect(predicted.seconds).toBe(3600);
        expect(predicted.dps).toBe(100);
        expect(predicted.secondsPerFight).toBe(36);
    });

    test('everything the monsters dealt is what the solo player took', () => {
        // Summed across the wave rather than read off one monster: a zone spawns
        // three at a time and only their total is the damage you actually took
        expect(predictFromSim(simResult).takenPerSecond).toBe(15);
    });

    test('a sim that never ran predicts nothing', () => {
        expect(predictFromSim({ simulatedTime: 0 })).toBe(null);
        expect(predictFromSim(null)).toBe(null);
    });
});

describe('the deviation', () => {
    test('it is signed towards the observation', () => {
        expect(deviationPct(90, 100)).toBeCloseTo(-10, 10);
        expect(deviationPct(110, 100)).toBeCloseTo(10, 10);
        expect(deviationPct(100, 100)).toBe(0);
    });

    test('it is a percentage of the prediction, which is what is being checked', () => {
        // Not of the observation, and not of their mean: the claim under test is
        // the simulator's, so it is the simulator's number that is the denominator
        expect(deviationPct(150, 100)).toBeCloseTo(50, 10);
        expect(deviationPct(100, 150)).toBeCloseTo(-33.333, 3);
    });

    test('there is no deviation from a prediction of nothing', () => {
        expect(deviationPct(10, 0)).toBe(null);
        expect(deviationPct(10, null)).toBe(null);
        expect(deviationPct(undefined, 10)).toBe(null);
    });
});

describe('the noise margin', () => {
    test('fewer fights than the minimum says nothing at all', () => {
        expect(noiseMargin([100, 100])).toBe(null);
        expect(noiseMargin(Array(MIN_SAMPLE_FIGHTS).fill(100))).not.toBe(null);
    });

    test('a sample that never varies still allows for the simulator', () => {
        // The observed side contributes nothing, so what is left is the floor —
        // one sim run is one sample and has its own spread
        expect(noiseMargin([100, 100, 100, 100])).toBeCloseTo(SIM_NOISE_FLOOR_PCT, 10);
    });

    test('a wider spread is a wider margin', () => {
        const tight = noiseMargin([98, 100, 102, 100, 100]);
        const loose = noiseMargin([50, 100, 150, 100, 100]);
        expect(loose).toBeGreaterThan(tight);
    });

    test('more of the same fights narrows it', () => {
        const few = noiseMargin([90, 100, 110]);
        const many = noiseMargin([90, 100, 110, 90, 100, 110, 90, 100, 110]);
        expect(many).toBeLessThan(few);
    });

    test('the two sources of noise add as squares, not as sums', () => {
        const samples = [90, 100, 110, 100];
        const sampleOnly = noiseMargin(samples, 0);
        expect(noiseMargin(samples)).toBeCloseTo(Math.hypot(sampleOnly, SIM_NOISE_FLOOR_PCT), 10);
        expect(noiseMargin(samples)).toBeLessThan(sampleOnly + SIM_NOISE_FLOOR_PCT);
    });
});

describe('flagging a deviation', () => {
    test('a deviation inside the margin is reported and not flagged', () => {
        const metric = compareMetric({
            key: 'dps',
            label: 'Damage dealt / sec',
            observed: 101,
            predicted: 100,
            samples: [90, 100, 110, 100, 100],
        });
        expect(metric.deviationPct).toBeCloseTo(1, 10);
        expect(metric.verdict).toBe('within-noise');
    });

    test('a deviation outside it is flagged', () => {
        const metric = compareMetric({
            key: 'dps',
            label: 'Damage dealt / sec',
            observed: 60,
            predicted: 100,
            samples: [60, 60, 60, 60, 60],
        });
        expect(metric.deviationPct).toBeCloseTo(-40, 10);
        expect(metric.verdict).toBe('beyond-noise');
    });

    test('too few fights is neither, however far apart the numbers are', () => {
        // The dangerous case: two fights that happened to go badly are not
        // evidence about the simulator, and calling them evidence is worse than
        // saying nothing
        const metric = compareMetric({ key: 'dps', label: '', observed: 10, predicted: 100, samples: [10, 10] });
        expect(metric.deviationPct).toBeCloseTo(-90, 10);
        expect(metric.verdict).toBe('insufficient');
    });

    test('a noisy sample can hold a large deviation as unproven', () => {
        const metric = compareMetric({
            key: 'dps',
            label: '',
            observed: 100,
            predicted: 130,
            samples: [10, 100, 190, 60, 140],
        });
        expect(metric.verdict).toBe('within-noise');
    });
});

describe('the whole comparison', () => {
    const observed = aggregateObservations([evenObservation({ seconds: 10, damageDealt: 900, fights: 6 })]);
    const predicted = predictFromSim({
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        warnings: [],
    });

    test('every metric is compared, in a fixed order', () => {
        const comparison = compareRun(observed, predicted);
        expect(comparison.metrics.map((metric) => metric.key)).toEqual(['dps', 'takenPerSecond', 'secondsPerFight']);
    });

    test('the comparison carries when the fight was recorded', () => {
        // The one caveat that cannot be shown without it: gear may have changed
        const comparison = compareRun(observed, predicted);
        expect(comparison.recordedAt).toBe(1_700_000_000_000);
        expect(comparison.fights).toBe(6);
    });

    test('a run at 90 against a prediction of 100 reads as 10% under', () => {
        const comparison = compareRun(observed, predicted);
        const dps = comparison.metrics.find((metric) => metric.key === 'dps');
        expect(dps.observed).toBe(90);
        expect(dps.predicted).toBe(100);
        expect(dps.deviationPct).toBeCloseTo(-10, 10);
        expect(dps.verdict).toBe('beyond-noise');
    });

    test('half a comparison is no comparison', () => {
        expect(compareRun(observed, null)).toBe(null);
        expect(compareRun(null, predicted)).toBe(null);
    });
});

describe('the sanitized export', () => {
    const file = () => ({
        format: 'toolasha-sim-accuracy',
        observations: [{ fights: 3 }],
        recording: {
            segments: [
                {
                    ticks: [
                        {
                            type: 'new_battle',
                            payload: {
                                players: [
                                    { name: 'RealName', character: { id: 7, name: 'RealName' }, currentHitpoints: 500 },
                                ],
                                monsters: [{ name: 'Fly', hrid: '/monsters/fly' }],
                            },
                        },
                        { type: 'battle_updated', payload: { pMap: { 0: { cHP: 400 } } } },
                    ],
                },
                { ticks: null, summary: { fights: 2 } },
            ],
        },
    });

    test('player identities are hashed and stripped; the fight itself is untouched', () => {
        const clean = sanitizeExportFile(file());
        const [player] = clean.recording.segments[0].ticks[0].payload.players;
        expect(player.name).toMatch(/^p[0-9a-f]{8}$/);
        expect(player.character).toBeUndefined();
        expect(player.currentHitpoints).toBe(500);
        // The monster keeps its name — game content is not an identity
        expect(clean.recording.segments[0].ticks[0].payload.monsters[0].name).toBe('Fly');
        expect(clean.sanitized).toBe(true);
    });

    test('the original file is left alone, and tick-less segments are tolerated', () => {
        const original = file();
        sanitizeExportFile(original);
        expect(original.recording.segments[0].ticks[0].payload.players[0].name).toBe('RealName');
        expect(sanitizeExportFile({ recording: null }).sanitized).toBe(true);
    });

    test('object-keyed player maps are sanitized the same way', () => {
        const keyed = file();
        keyed.recording.segments[0].ticks[0].payload.players = {
            0: { name: 'RealName', characterID: 7, currentHitpoints: 500 },
        };
        const clean = sanitizeExportFile(keyed);
        const player = clean.recording.segments[0].ticks[0].payload.players[0];
        expect(player.name).toMatch(/^p[0-9a-f]{8}$/);
        expect(player.characterID).toBeUndefined();
    });
});

describe('the survival claim', () => {
    const sim = (deaths) =>
        predictFromSim({
            simulatedTime: 3600 * 1e9,
            encounters: 360,
            deaths: deaths ? { player1: deaths } : {},
            totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
            warnings: [],
        });
    const sample = (deaths, seconds = 3600) => ({ seconds, deaths });

    test("the sim's death rate is billed over the hours actually observed", () => {
        // 4 deaths per simulated hour, half an hour observed → ~2 expected
        const check = deathCheck(sample(2, 1800), sim(4));
        expect(check.expected).toBeCloseTo(2, 10);
        expect(check.verdict).toBe('within-noise');
    });

    test('one real death against a prediction of zero is beyond noise by itself', () => {
        // This is the failure idling trusts the sim about — no spread hides it
        const check = deathCheck(sample(1), sim(0));
        expect(check.expected).toBe(0);
        expect(check.verdict).toBe('beyond-noise');
    });

    test('rare counts wear a Poisson band, not a percentage one', () => {
        // Expected 9: ±2σ is ±6, so 16 observed is beyond and 14 is within —
        // a percentage band would call both the same
        expect(deathCheck(sample(16), sim(9)).verdict).toBe('beyond-noise');
        expect(deathCheck(sample(14), sim(9)).verdict).toBe('within-noise');
    });

    test('no deaths anywhere is quietly consistent', () => {
        expect(deathCheck(sample(0), sim(0)).verdict).toBe('within-noise');
    });

    test('no clock, no claim', () => {
        expect(deathCheck({ seconds: 0, deaths: 1 }, sim(1))).toBe(null);
        expect(deathCheck(sample(1), { seconds: 0, deaths: 1 })).toBe(null);
    });

    test('the whole comparison carries it', () => {
        const observed = aggregateObservations([evenObservation({ seconds: 10, damageDealt: 900, fights: 6 })]);
        const comparison = compareRun(observed, sim(0));
        expect(comparison.deathCheck).toMatchObject({ observed: 0, expected: 0, verdict: 'within-noise' });
    });
});

describe('the line the tile carries', () => {
    const predicted = predictFromSim({
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        warnings: [],
    });

    test('it says which way the run went and by how much', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 900, fights: 6 })]),
            predicted
        );
        expect(summaryLine(comparison)).toBe('Last 6 fights ran 10.0% under predicted DPS');
    });

    test('a run above the prediction reads as over it', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 1100, fights: 6 })]),
            predicted
        );
        expect(summaryLine(comparison)).toContain('over predicted DPS');
    });

    test('a deviation within noise says so rather than claiming a finding', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 1005, fights: 6 })]),
            predicted
        );
        expect(summaryLine(comparison)).toContain('within noise');
    });

    test('too few fights is admitted on the tile itself', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 900, fights: 2 })]),
            predicted
        );
        expect(summaryLine(comparison)).toContain('too few to judge');
    });

    test('nothing compared yet is not an accuracy claim', () => {
        expect(summaryLine(null)).toBe('No sim check yet');
        expect(summaryLine({ metrics: [] })).toBe('No sim check yet');
    });
});

describe('the loadout the fight was actually fought in', () => {
    test('the snapshot keeps what describes the character', () => {
        const snapshot = captureLoadoutSnapshot(loadout());

        expect(snapshot.equipment.main_hand).toEqual({ hrid: '/items/sword', enhancementLevel: 5 });
        expect(snapshot.levels).toEqual({
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 70,
            magicLevel: 1,
            rangedLevel: 1,
            staminaLevel: 80,
            intelligenceLevel: 60,
        });
        expect(snapshot.abilities[1]).toEqual({ hrid: '/abilities/poke', level: 3, triggers: null });
        expect(snapshot.houseRooms).toEqual({ '/house_rooms/dairy_barn': 6 });
        expect(snapshot.guildShrineLevels).toEqual({ attack: 2 });
        expect(snapshot.drinks[0]).toEqual({ hrid: '/items/coffee', triggers: null });
        expect(snapshot.food[0]).toEqual({ hrid: '/items/donut', triggers: null });
    });

    test('and not what describes the world', () => {
        // Community buffs and token upgrades are the server's state and are the
        // same for the simulated run as for the recorded one. Freezing them
        // would make a snapshot go stale in a way the gear never does.
        const snapshot = captureLoadoutSnapshot(loadout());

        expect(snapshot.communityBuffLevels).toBeUndefined();
        expect(snapshot.tokenUpgrades).toBeUndefined();
        expect(snapshot.cookingLevel).toBeUndefined();
        expect(snapshot.levels.cookingLevel).toBeUndefined();
    });

    test('a character that has not loaded snapshots nothing rather than an empty one', () => {
        expect(captureLoadoutSnapshot(null)).toBe(null);
    });

    test('it is laid over the current character, not swapped for it', () => {
        const snapshot = captureLoadoutSnapshot(loadout({ weapon: '/items/spear', attack: 50 }));
        const current = loadout({ weapon: '/items/sword', attack: 99 });
        current.communityBuffLevels = { experience: 9 };

        const merged = applyLoadoutSnapshot(current, snapshot);

        expect(merged.equipment.main_hand.hrid).toBe('/items/spear');
        expect(merged.attackLevel).toBe(50);
        // Not named by the snapshot, so it comes from now, which is where it is right
        expect(merged.communityBuffLevels).toEqual({ experience: 9 });
        expect(merged.hrid).toBe('player1');
        // And the DTO it was built from is untouched
        expect(current.attackLevel).toBe(99);
    });

    test('no snapshot leaves the DTO exactly as it was built', () => {
        const current = loadout();
        expect(applyLoadoutSnapshot(current, null)).toBe(current);
        expect(applyLoadoutSnapshot(null, captureLoadoutSnapshot(loadout()))).toBe(null);
    });

    test('a recording carries the snapshot the recorder took onto its observation', () => {
        const snapshot = captureLoadoutSnapshot(loadout({ weapon: '/items/spear' }));
        const observation = observeRecording({ ...recording, loadout: snapshot });

        expect(observation.loadout.equipment.main_hand.hrid).toBe('/items/spear');
    });

    test('a legacy recording has no snapshot, and says so rather than inventing one', () => {
        expect(observeRecording(recording).loadout).toBe(null);
    });
});

describe('what the check simulates', () => {
    /** A sim result complete enough for `predictFromSim` to read */
    const simResult = {
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        warnings: [],
    };

    test('the gear worn when it was recorded, not the gear worn now', () => {
        // The whole point: record, go and enhance something, run the check, and
        // the deviation used to be the enhancement
        game.simResult = simResult;
        const recorded = captureLoadoutSnapshot(loadout({ weapon: '/items/spear', enhancement: 0, attack: 50 }));
        game.dto = loadout({ weapon: '/items/sword', enhancement: 12, attack: 99 });
        replayCheck.observations = [evenObservation({ fights: 6, loadout: recorded })];

        return replayCheck.check().then(() => {
            const dto = game.lastRun.playerDTOs[0];
            expect(dto.equipment.main_hand).toEqual({ hrid: '/items/spear', enhancementLevel: 0 });
            expect(dto.attackLevel).toBe(50);
        });
    });

    test('a legacy observation still simulates the character as it is now', () => {
        // Nothing said what it was wearing, so the only honest answer is the
        // current character — which is what the panel's caveat has always said
        game.simResult = simResult;
        game.dto = loadout({ weapon: '/items/sword', enhancement: 12, attack: 99 });
        replayCheck.observations = [evenObservation({ fights: 6 })];

        return replayCheck.check().then(() => {
            const dto = game.lastRun.playerDTOs[0];
            expect(dto.equipment.main_hand).toEqual({ hrid: '/items/sword', enhancementLevel: 12 });
            expect(dto.attackLevel).toBe(99);
        });
    });

    test('the newest snapshot wins, and a sample that straddles a change says so', () => {
        const early = captureLoadoutSnapshot(loadout({ weapon: '/items/spear' }));
        const late = captureLoadoutSnapshot(loadout({ weapon: '/items/sword' }));
        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000, loadout: early }),
            evenObservation({ fights: 3, recordedAt: 2_000, loadout: late }),
        ]);

        expect(observed.loadout.equipment.main_hand.hrid).toBe('/items/sword');
        expect(observed.mixedLoadouts).toBe(true);
    });

    test('the zone and its tier, which is the planet and not the rooms recorded', () => {
        // Worth pinning because it is what the panel now says out loud: the
        // engine draws its own encounters from this zone's spawn table, so the
        // comparison is rate against rate over two samples of the same zone and
        // not a replay of the waves that were fought
        game.simResult = simResult;
        replayCheck.observations = [
            evenObservation({ fights: 6, zoneHrid: '/actions/combat/jungle', difficultyTier: 2 }),
        ];

        return replayCheck.check().then(() => {
            expect(game.lastRun.zoneHrid).toBe('/actions/combat/jungle');
            expect(game.lastRun.difficultyTier).toBe(2);
            // Fights recorded are not an input to the simulation at all
            expect(game.lastRun.hours).toBe(SIM_HOURS);
            expect(game.lastRun).not.toHaveProperty('fights');
        });
    });

    test('the check retains the SimResult it decomposed, for the zone uptime harness', () => {
        // The harness decomposes the very sim whose headline the panel shows —
        // retaining it is what makes the decomposition free (no second sim)
        game.simResult = simResult;
        replayCheck.observations = [evenObservation({ fights: 6 })];

        return replayCheck.check().then(() => {
            expect(replayCheck.lastSimResult).toBe(simResult);
            // With no tick recording in the recorder, the decomposition says
            // so rather than guessing — and the export carries the answer
            expect(replayCheck.uptime).toEqual({ empty: true });
            expect(replayCheck.exportFile().uptime).toEqual({ empty: true });
        });
    });

    test('with task damage off, because the feed never said the monster was a task', () => {
        // `taskDamage` only applies while what you are fighting is your active
        // combat task. Nothing on the feed says whether it was, so a replay
        // simulated with it on predicts damage the run may never have been
        // entitled to and blames the gap on the engine. Pinned rather than left
        // to the runner's default, which is somewhere else to change it.
        game.simResult = simResult;
        replayCheck.observations = [evenObservation({ fights: 6 })];

        return replayCheck.check().then(() => {
            expect(game.lastRun.isTaskFight).toBe(false);
        });
    });

    test('two segments of one recording are one loadout, whenever they were taken', () => {
        const first = captureLoadoutSnapshot(loadout());
        const second = captureLoadoutSnapshot(loadout());
        second.capturedAt = first.capturedAt + 600_000;

        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000, loadout: first }),
            evenObservation({ fights: 3, recordedAt: 2_000, loadout: second }),
        ]);

        expect(observed.mixedLoadouts).toBe(false);
    });
});

describe('surviving a refresh', () => {
    test('the fights so far are written at a fight boundary, summarised and not raw', () => {
        // Raw ticks are megabytes and arrive several times a second; the summary
        // is a few hundred bytes and is what the check reads anyway
        return replayCheck.checkpoint(recording).then(() => {
            const checkpoint = store.data.get(CHECKPOINT_KEY);
            expect(checkpoint.fights.length).toBeGreaterThan(0);
            expect(JSON.stringify(checkpoint)).not.toContain('pMap');
        });
    });

    test('a segment with no completed fight clears the checkpoint instead of writing one', () => {
        // What a rotation leaves behind: the segment it banked is already folded
        // in, so the checkpoint taken from it is a duplicate waiting to happen
        store.data.set(CHECKPOINT_KEY, { fights: [{ seconds: 1 }] });

        return replayCheck.checkpoint({ ticks: recording.ticks.slice(0, 3) }).then(() => {
            expect(store.data.get(CHECKPOINT_KEY)).toBe(null);
        });
    });

    test('a full disk stands the checkpoint down rather than failing every fight', async () => {
        store.quota = true;

        await replayCheck.checkpoint(recording);

        expect(store.data.has(CHECKPOINT_KEY)).toBe(false);
    });

    test('a leftover checkpoint is folded in on startup and then dropped', async () => {
        const interrupted = observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 });
        store.data.set(CHECKPOINT_KEY, interrupted);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        await replayCheck.load();

        expect(replayCheck.observations).toHaveLength(1);
        expect(replayCheck.observations[0].fights).toHaveLength(interrupted.fights.length);
        expect(storedList(OBSERVATIONS_KEY)).toHaveLength(1);
        expect(store.data.get(CHECKPOINT_KEY)).toBe(null);
        expect(log.mock.calls[0][0]).toContain(`Recovered ${interrupted.fights.length} fights`);
        log.mockRestore();
    });

    test('and is not folded in twice when the same run is already kept', async () => {
        const interrupted = observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 });
        store.data.set(OBSERVATIONS_KEY, [interrupted]);
        store.data.set(CHECKPOINT_KEY, { ...interrupted, recordedAt: 2_000 });

        await replayCheck.load();

        expect(replayCheck.observations).toHaveLength(1);
    });

    test('nothing left over is a quiet startup', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        await replayCheck.load();

        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
    });

    test('a character switch during the recovery does not erase the arriving character’s', async () => {
        // The clear is a write of `null` and its key used to be resolved when
        // it ran, so a switch inside the read wrote that `null` over whoever
        // arrived — destroying an interrupted recording that was never this
        // character's to clear, and folding the departing character's fights
        // into the arriving character's observations on the way.
        const THEIRS = 'combatReplayCheck_recordingCheckpoint_char2';
        const mine = observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 });
        const theirs = observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 2_000 });
        store.data.set(CHECKPOINT_KEY, mine);
        store.data.set(THEIRS, theirs);

        let release;
        store.holds.set(
            CHECKPOINT_KEY,
            new Promise((resolve) => {
                release = resolve;
            })
        );

        const recovering = replayCheck.recover();
        await Promise.resolve();

        game.characterId = 'char2';
        replayCheck.disable();

        release();
        await recovering;

        expect(store.data.get(THEIRS)).toEqual(theirs);
        expect(replayCheck.observations).toEqual([]);
    });

    test('a clean stop clears it, so the next session recovers nothing', async () => {
        replayCheck.ensureWatching();
        await settle();
        await replayCheck.checkpoint(recording);
        expect(store.data.get(CHECKPOINT_KEY)).toBeTruthy();

        combatRecorder.startRecording();
        combatRecorder.stopRecording();
        await settle();

        expect(store.data.get(CHECKPOINT_KEY)).toBe(null);
    });
});

/**
 * This module lives outside the feature registry — it starts lazily from the
 * overlay row's render rather than an `initialize()` — so nothing calls
 * `disable()` for it except a `character_switching` handler registered at
 * module scope for exactly this. Without it, `ensureWatching()`'s own guard
 * (`if (this.watching) return`) meant the second character in a session never
 * got a fresh watch at all: the first character's observations, history and
 * comparison kept being read as the second's, main and ironcow alts alike.
 */
describe('a character switch', () => {
    test('stops watching, so the arriving character gets a fresh ensureWatching', async () => {
        replayCheck.ensureWatching();
        await settle();
        expect(replayCheck.watching).toBe(true);

        emitCharacter('character_switching', {});

        expect(replayCheck.watching).toBe(false);
    });

    test('clears the departing character’s observations rather than carrying them into the next', async () => {
        replayCheck.ensureWatching();
        await settle();
        replayCheck.remember(observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 }));
        expect(replayCheck.observations).toHaveLength(1);

        emitCharacter('character_switching', {});

        expect(replayCheck.observations).toHaveLength(0);

        // And the arriving character's own ensureWatching (from its session
        // start, or from opening the panel) is a real re-watch rather than a
        // no-op against the stale `watching` flag
        replayCheck.ensureWatching();
        expect(replayCheck.watching).toBe(true);
    });

    test('a check still in flight does not land its result under the character that arrives next', async () => {
        // `check()` awaits a 12-simulated-hour `runSimulation` call, which on a
        // real switch has every chance of still being in flight when
        // `character_switching` fires and `disable()` runs synchronously.
        replayCheck.observations = [evenObservation({ fights: 6 })];
        let releaseSim;
        game.runGate = new Promise((resolve) => {
            releaseSim = resolve;
        });
        game.simResult = {
            simulatedTime: 3600 * 1e9,
            encounters: 360,
            deaths: {},
            totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
            warnings: [],
        };

        const pending = replayCheck.check();

        // The switch: tears the feature down while the simulation is parked
        emitCharacter('character_switching', {});
        expect(replayCheck.comparison).toBeNull();

        releaseSim();
        await pending;

        // The departing character's comparison must not appear as though it
        // belongs to whoever the overlay is showing now, and must not have
        // been written to the storage key the arriving character reads from.
        expect(replayCheck.comparison).toBeNull();
        expect(replayCheck.lastSimResult).toBeNull();
    });
});

describe('how much of this sample is noise', () => {
    test('it is measured from the fights, not assumed from their number', () => {
        // 1/√n would call twelve fights a 29% margin whatever they did; twelve
        // fights that all landed within a percent of each other are far tighter
        const steady = noiseSummary(aggregateObservations([evenObservation({ fights: 12 })]));

        expect(steady.marginPct).toBeCloseTo(SIM_NOISE_FLOOR_PCT, 10);
        expect(steady.marginPct).toBeLessThan((1 / Math.sqrt(12)) * 100);
    });

    test('a spread sample is a wide band and says not to read anything off it', () => {
        const observed = aggregateObservations([
            {
                ...evenObservation({ fights: 0 }),
                fights: [10, 30, 5, 25, 12].map((damageDealt) => ({
                    seconds: 1,
                    damageDealt,
                    damageTaken: 1,
                    regen: 0,
                    hits: 1,
                    misses: 0,
                    deaths: 0,
                    kills: 1,
                    monsters: ['Fly'],
                })),
            },
        ]);
        const noise = noiseSummary(observed);

        expect(noise.marginPct).toBeGreaterThan(NOISE_QUIET_PCT);
        expect(noise.quiet).toBe(false);
        expect(noise.text).toContain('5 fights');
        expect(noise.text).toContain('differences inside that band are not findings');
    });

    test('a tight sample goes quiet, because it can finally see something', () => {
        const noise = noiseSummary(aggregateObservations([evenObservation({ fights: 24 })]));

        expect(noise.marginPct).toBeLessThan(NOISE_QUIET_PCT);
        expect(noise.quiet).toBe(true);
        expect(noise.text).toContain('large enough to argue with');
    });

    test('too few fights admits it rather than quoting a margin', () => {
        const noise = noiseSummary(aggregateObservations([evenObservation({ fights: 2 })]));

        expect(noise.marginPct).toBe(null);
        expect(noise.quiet).toBe(false);
        expect(noise.text).toContain('too few');
    });

    test('nothing observed is nothing claimed', () => {
        expect(noiseSummary(null)).toMatchObject({ fights: 0, marginPct: null, quiet: false });
    });
});

describe('drawing a deviation the sample cannot see', () => {
    /** Open the panel over one sample and one comparison */
    function draw({ damageDealt = 1000, fights = 6 } = {}) {
        replayCheck.observations = [evenObservation({ seconds: 10, damageDealt, fights })];
        replayCheck.comparison = compareRun(
            aggregateObservations(replayCheck.observations),
            predictFromSim({
                simulatedTime: 3600 * 1e9,
                encounters: 360,
                deaths: {},
                totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
                warnings: [],
            })
        );
        replayCheckPanel.show({ remember: false });
    }

    /** The line whose label is `label`, and the ink its figure is drawn in */
    function row(label) {
        const line = [...replayCheckPanel.panel.querySelectorAll('div')].find(
            (element) => element.firstChild?.textContent === label
        );
        return line ? { text: line.textContent, color: line.lastChild.style.color } : null;
    }

    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('a deviation inside the band is dimmed and carries the band with it', () => {
        // Green read as "checked, and fine". Six fights agreeing with the
        // simulator to within their own margin have established nothing.
        draw({ damageDealt: 1005 });

        const dps = row('Damage dealt / sec');
        expect(dps.text).toContain('±');
        expect(dps.color).toBe(ROW_COLORS.dim);
        expect(dps.color).not.toBe(ROW_COLORS.good);
    });

    test('a deviation outside it is still flagged', () => {
        draw({ damageDealt: 900 });

        expect(row('Damage dealt / sec').color).toBe(ROW_COLORS.bad);
    });

    test('too few fights says so on the row rather than quoting a band', () => {
        draw({ damageDealt: 900, fights: 2 });

        const dps = row('Damage dealt / sec');
        expect(dps.text).toContain('too few fights');
        expect(dps.color).toBe(ROW_COLORS.dim);
    });

    test('the sample line sits beside the fight count, and turns quiet when it can', () => {
        draw({ fights: 24 });

        expect(row('Sample').text).toContain('±');
        expect(row('Sample').color).toBe(ROW_COLORS.good);
    });

    test('and stays dim while the noise is the largest thing in the comparison', () => {
        // Not the fight count that decides this but the spread: four fights that
        // all went the same way see further than twenty that did not
        replayCheck.observations = [
            {
                ...evenObservation({ fights: 0 }),
                fights: [400, 1600, 700, 1300, 900].map((damageDealt) => ({
                    seconds: 10,
                    damageDealt,
                    damageTaken: 100,
                    regen: 0,
                    hits: 4,
                    misses: 1,
                    deaths: 0,
                    kills: 3,
                    monsters: ['Fly'],
                })),
            },
        ];
        replayCheckPanel.show({ remember: false });

        expect(row('Sample').color).toBe(ROW_COLORS.dim);
        expect(row('Sample').text).toContain('not findings');
    });
});

describe('what the panel admits it does not know', () => {
    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('with a snapshot, the gear caveat becomes a statement of fact', () => {
        replayCheck.observations = [evenObservation({ fights: 6, loadout: captureLoadoutSnapshot(loadout()) })];
        replayCheckPanel.show({ remember: false });

        const text = replayCheckPanel.panel.textContent;
        expect(text).toContain('Simmed against the gear worn when recorded');
        expect(text).not.toContain('read as it is worn now');
        // What genuinely is not captured still is
        expect(text).toContain('whether they were actually up');
        expect(text).not.toContain('could not be drawn');
    });

    test('without one, it says the gear is whatever is worn now', () => {
        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheckPanel.show({ remember: false });

        const text = replayCheckPanel.panel.textContent;
        expect(text).toContain('read as it is worn now');
        expect(text).not.toContain('Simmed against the gear worn when recorded');
    });

    test('a sample straddling a gear change is not passed off as one loadout', () => {
        replayCheck.observations = [
            evenObservation({ fights: 3, recordedAt: 1_000, loadout: captureLoadoutSnapshot(loadout()) }),
            evenObservation({
                fights: 3,
                recordedAt: 2_000,
                loadout: captureLoadoutSnapshot(loadout({ weapon: '/items/spear' })),
            }),
        ];
        replayCheckPanel.show({ remember: false });

        expect(replayCheckPanel.panel.textContent).toContain('not all made with the same loadout');
    });
});

describe('the Record button on the panel', () => {
    /** The shared recorder, as the panel finds it */
    function install(recording = false, ticks = 0) {
        const fake = {
            recording,
            isRecording: () => fake.recording,
            recordingStatus: () => ({ ticks, seconds: 0, full: false }),
            startRecording: vi.fn(() => {
                fake.recording = true;
            }),
            stopRecording: vi.fn(() => {
                fake.recording = false;
            }),
            downloadRecording: vi.fn(),
        };
        window.Toolasha = { Combat: { combatRecorder: fake } };
        return fake;
    }

    /** Every button in the open panel, by its label */
    function buttons() {
        return [...(replayCheckPanel.panel?.querySelectorAll('button') || [])];
    }

    function labelled(text) {
        return buttons().find((button) => button.textContent.startsWith(text));
    }

    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('the panel offers a Record button instead of pointing at another panel', () => {
        // Being told to press Record somewhere else was the one thing this
        // panel could do nothing about, and the recording is what it runs on
        install();
        replayCheckPanel.show({ remember: false });

        expect(labelled('Record')).toBeTruthy();
        expect(replayCheckPanel.panel.textContent).not.toContain('could not be drawn');
        expect(replayCheckPanel.panel.textContent).not.toContain('Damage panel');
    });

    test('pressing it starts the shared recorder', () => {
        const recorder = install();
        replayCheckPanel.show({ remember: false });

        labelled('Record').click();

        expect(recorder.startRecording).toHaveBeenCalledTimes(1);
        // Redrawn from the recorder's state, not from a remembered flag
        expect(labelled('Recording')).toBeTruthy();
    });

    test('a recording started anywhere else already reads as running here', () => {
        install(true, 240);
        replayCheckPanel.show({ remember: false });

        expect(labelled('Recording 240…')).toBeTruthy();
        expect(labelled('Record (')).toBeFalsy();
    });

    test('pressing it while running stops the recording and writes no file', () => {
        // The file is for handing over; a recording made here is read by the
        // ingest that follows it
        const recorder = install(true, 240);
        replayCheckPanel.show({ remember: false });

        labelled('Recording').click();

        expect(recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(recorder.downloadRecording).not.toHaveBeenCalled();
        expect(labelled('Record')).toBeTruthy();
    });

    test('no recorder means the other controls still draw', () => {
        window.Toolasha = { Combat: {} };
        replayCheckPanel.show({ remember: false });

        expect(replayCheckPanel.panel.textContent).not.toContain('could not be drawn');
        expect(labelled('Forget')).toBeTruthy();
    });

    test('a simulation running elsewhere leaves the recording label alone', async () => {
        // What this is here to stop: the Record button reverting while a
        // simulation runs, on a recording that never stopped. Reading the
        // button's state is a read of the recorder and nothing else — no
        // storage write, no target restored underneath a running recording.
        const fake = install(true, 240);
        fake.fights = 37;
        fake.recordingStatus = () => ({ ticks: 240, seconds: 600, full: false, fights: fake.fights, target: null });
        fake.setRecordTarget = vi.fn();
        store.data.set('combatRecordControl_target_char1', { value: 5, unit: 'fights' });

        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheckPanel.show({ remember: false });
        expect(labelled('Recording 37 fights…')).toBeTruthy();

        // A simulation, held open while the panel redraws underneath it
        let finish;
        const held = new Promise((resolve) => {
            finish = resolve;
        });
        const running = (async () => {
            await held;
            return { simulatedTime: 3600 * 1e9, encounters: 360, deaths: {}, totalDamageDealt: {}, warnings: [] };
        })();

        for (let i = 0; i < 5; i += 1) {
            replayCheckPanel.render();
            await settle();
        }

        expect(labelled('Recording 37 fights…')).toBeTruthy();
        expect(labelled('Record (')).toBeFalsy();
        expect(fake.stopRecording).not.toHaveBeenCalled();
        // The stale five-fight target on disk is not applied to a run already
        // past thirty-seven fights, which would stop it at the next boundary
        expect(fake.setRecordTarget).not.toHaveBeenCalled();

        finish();
        await running;
        replayCheckPanel.render();
        expect(labelled('Recording 37 fights…')).toBeTruthy();
    });

    test('Save recording writes the observations, the check and the recording as one file', () => {
        const written = [];
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
            written.push(this.download);
        });
        install();

        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheck.comparison = compareRun(
            aggregateObservations(replayCheck.observations),
            predictFromSim({
                simulatedTime: 3600 * 1e9,
                encounters: 360,
                deaths: {},
                totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
                warnings: [],
            })
        );
        replayCheckPanel.show({ remember: false });

        labelled('Save recording').click();
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/^toolasha-sim-accuracy-/);

        const file = replayCheck.exportFile();
        expect(file.format).toBe('toolasha-sim-accuracy');
        expect(file.version).toBe(1);
        expect(file.simHours).toBe(SIM_HOURS);
        expect(file.zone).toEqual({ hrid: '/actions/combat/fly', name: 'Fly', difficultyTier: 0 });
        // The clocks travel with the file, so an offline re-derivation divides
        // by what this divided by rather than by whatever looks reasonable
        expect(file.clocks.observed).toContain('respawn');
        expect(file.clocks.predicted).toContain('respawn');
        expect(file.observations).toHaveLength(1);
        expect(file.observations[0].fights).toHaveLength(6);
        expect(file.aggregate.fights).toBe(6);
        expect(file.comparison.metrics.length).toBeGreaterThan(0);
        expect(Array.isArray(file.history)).toBe(true);
        // And what is missing is said in the file, since a reader cannot tell
        // an absent field from one that was never captured
        expect(file.includes.length).toBeGreaterThan(0);
        expect(file.excludes.join(' ')).toContain('drinks');

        click.mockRestore();
    });

    test('and it exports before any check has been run, which is when it is wanted', () => {
        install();
        replayCheck.observations = [evenObservation({ fights: 4, loadout: captureLoadoutSnapshot(loadout()) })];

        const file = replayCheck.exportFile();
        expect(file.comparison).toBe(null);
        expect(file.observations[0].loadout.equipment.main_hand.hrid).toBe('/items/sword');
    });
});

/**
 * A recording of `count` fights whose battles carry the running totals.
 *
 * The shipped fixture predates experience and loot being read off `new_battle`
 * and carries neither, so the window arithmetic needs a run built to have them.
 *
 * @param {Object} shape - `{count, xpPerFight, dropPerFight, resetAt}`
 * @returns {Object} A recording file, as the recorder hands one over
 */
function runWithGains({ count = 3, xpPerFight = 100, dropPerFight = 2, resetAt = null } = {}) {
    const ticks = [];
    let xp = 5_000;
    let coins = 40;

    for (let battle = 0; battle <= count; battle += 1) {
        // A restarted combat action zeroes the running totals underneath the
        // recording, which is the one case a difference is not a gain
        if (resetAt !== null && battle === resetAt) {
            xp = 0;
            coins = 0;
        }
        ticks.push({
            at: battle * 10_000,
            type: 'new_battle',
            payload: {
                players: {
                    0: {
                        name: 'Tester',
                        isPreparingAutoAttack: true,
                        totalSkillExperienceMap: { '/skills/attack': xp, '/skills/stamina': xp / 2 },
                        totalLootMap: {
                            slot1: { itemHrid: '/items/coin', count: coins },
                            slot2: { itemHrid: '/items/coin', count: 1 },
                        },
                    },
                },
                monsters: { 0: { name: 'Fly' } },
            },
        });
        // Two ticks, because a hit is a counter *rising* and the first sighting
        // of a monster establishes the baseline rather than dealing its health
        ticks.push({
            at: battle * 10_000 + 1_000,
            type: 'battle_updated',
            payload: { pMap: { 0: { cMP: 9, isAutoAtk: true } }, mMap: { 0: { cHP: 100, dmgCounter: 0 } } },
        });
        ticks.push({
            at: battle * 10_000 + 2_000,
            type: 'battle_updated',
            payload: { pMap: { 0: { cMP: 8, isAutoAtk: true } }, mMap: { 0: { cHP: 60, dmgCounter: 1 } } },
        });
        xp += xpPerFight;
        coins += dropPerFight;
    }

    return { ticks, truncated: false, loadout: null };
}

describe('experience and loot, off the battles that carry them', () => {
    test('a fight’s gains are the difference across it, not a running total', () => {
        // `/skills/attack` rises by 100 and `/skills/stamina` by 50 per fight,
        // and coins by 2 — the totals themselves are five thousand and forty
        const fights = replayFights(runWithGains({ count: 3 }).ticks);

        expect(fights).toHaveLength(3);
        expect(fights[0].gains['0'].xp).toEqual({ '/skills/attack': 100, '/skills/stamina': 50 });
        expect(fights[0].gains['0'].loot).toEqual({ '/items/coin': 2 });
    });

    test('two slots of the same item are added rather than one overwriting the other', () => {
        const observation = observeRecording(runWithGains({ count: 3, dropPerFight: 5 }));

        // Both slots are coins; only one of them moves, and the count is the sum
        expect(observation.drops).toEqual({ '/items/coin': 15 });
    });

    test('gains outside the recording window are not in it', () => {
        // The window is the recording, by construction: the totals on the first
        // battle are the baseline, so everything earned before it is excluded
        // however large it was
        const observation = observeRecording(runWithGains({ count: 2, xpPerFight: 100 }));

        expect(observation.xpBySkill).toEqual({ '/skills/attack': 200, '/skills/stamina': 100 });
        expect(observation.gainsFights).toBe(2);
    });

    test('a restarted combat action is unknown gains, not a negative one', () => {
        // The totals fall when the action restarts underneath the recording,
        // and the difference across that is two different sessions
        const fights = replayFights(runWithGains({ count: 3, resetAt: 2 }).ticks);

        expect(fights[0].gains['0']).toBeTruthy();
        expect(fights[1].gains['0']).toBeUndefined();
        expect(fights[2].gains['0']).toBeTruthy();
    });

    test('and the seconds it covers shrink with it, so the rate stays honest', () => {
        const observation = observeRecording(runWithGains({ count: 3, resetAt: 2 }));

        expect(observation.gainsFights).toBe(2);
        expect(observation.gainsSeconds).toBe(20);
        // The run itself is still three fights long
        expect(observation.fights).toHaveLength(3);
    });

    test('a recording whose battles carry no totals has no gains and is not broken by it', () => {
        const observation = observeRecording(recording, { zoneHrid: '/actions/combat/fly' });

        expect(observation.xpBySkill).toEqual({});
        expect(observation.drops).toEqual({});
        expect(observation.gainsFights).toBe(0);
        expect(observation.fights.every((fight) => fight.xp === null)).toBe(true);
    });

    test('the aggregate divides experience by the seconds it was actually earned over', () => {
        const observed = aggregateObservations([
            { ...observeRecording(runWithGains({ count: 3, resetAt: 2 })), zoneHrid: '/actions/combat/fly' },
        ]);

        // Two fights of ten seconds each earned 150 apiece
        expect(observed.gainsSeconds).toBe(20);
        expect(observed.xpTotal).toBe(300);
        expect(observed.xpPerSecond).toBe(15);
    });

    test('a checkpoint carries the gains too, so a refresh does not lose them', async () => {
        await replayCheck.checkpoint(runWithGains({ count: 3 }));

        const checkpoint = store.data.get(CHECKPOINT_KEY);
        expect(checkpoint.xpBySkill).toEqual({ '/skills/attack': 300, '/skills/stamina': 150 });
        expect(checkpoint.drops).toEqual({ '/items/coin': 6 });
    });
});

describe('experience, against what the simulator predicts', () => {
    /** A sim result that earned XP over an hour */
    const simResult = ({ attack = 360_000, stamina = 180_000 } = {}) => ({
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        experienceGained: { player1: { attack, stamina, melee: 0, defense: 0, ranged: 0, magic: 0, intelligence: 0 } },
        warnings: [],
    });

    test('the simulator’s bare skill names are read back as hrids', () => {
        const predicted = predictFromSim(simResult());

        expect(predicted.xpBySkill).toEqual({ '/skills/attack': 360_000, '/skills/stamina': 180_000 });
        expect(predicted.xpTotal).toBe(540_000);
        expect(predicted.xpPerSecond).toBe(150);
    });

    test('skills the run earned nothing in are left out rather than shown as zero', () => {
        expect(Object.keys(predictFromSim(simResult()).xpBySkill)).toEqual(['/skills/attack', '/skills/stamina']);
    });

    test('a compared row appears only when both sides have a number', () => {
        const observed = aggregateObservations([
            { ...observeRecording(runWithGains({ count: 4 })), zoneHrid: '/actions/combat/fly' },
        ]);

        // Both sides: a row with a band
        const withXp = compareRun(observed, predictFromSim(simResult()));
        expect(withXp.experience).toMatchObject({ key: 'xpPerSecond' });
        expect(withXp.experience.marginPct).toBeGreaterThan(0);

        // A simulator that reported no experience is not compared to
        const noXp = compareRun(observed, predictFromSim({ ...simResult(), experienceGained: {} }));
        expect(noXp.experience).toBe(null);
        expect(noXp.experienceBySkill).toEqual([]);
    });

    test('and not when the recording carried no experience', () => {
        const observed = aggregateObservations([
            observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 }),
        ]);

        expect(compareRun(observed, predictFromSim(simResult())).experience).toBe(null);
    });

    test('the per-skill split is shown without a verdict, since it is not a sampling question', () => {
        const observed = aggregateObservations([
            { ...observeRecording(runWithGains({ count: 4 })), zoneHrid: '/actions/combat/fly' },
        ]);
        const comparison = compareRun(observed, predictFromSim(simResult()));

        expect(comparison.experienceBySkill).toHaveLength(2);
        for (const row of comparison.experienceBySkill) {
            expect(row.verdict).toBeUndefined();
            expect(row.deviationPct).not.toBe(null);
        }
        // Commonest first, so a split that went somewhere unexpected is at the top
        expect(comparison.experienceBySkill[0].skillHrid).toBe('/skills/attack');
    });
});

describe('drops, which are shown and not compared', () => {
    test('the simulator predicts none, so nothing pretends to', () => {
        // `SimResult` carries drop-rate multipliers and no drop table. Building
        // an expectation from the game's own tables would check the game
        // against itself, which is a different question and already answered
        expect(
            predictFromSim({
                simulatedTime: 3600 * 1e9,
                encounters: 100,
                totalDamageDealt: { player1: 1 },
            }).drops
        ).toBe(null);
    });

    test('observed drops are counted and rated, commonest first', () => {
        const observed = aggregateObservations([
            {
                ...observeRecording(runWithGains({ count: 4, dropPerFight: 9 })),
                zoneHrid: '/actions/combat/fly',
            },
        ]);
        const rates = dropRates(observed);

        expect(rates).toHaveLength(1);
        expect(rates[0]).toMatchObject({ itemHrid: '/items/coin', count: 36 });
        // Thirty-six coins over forty seconds
        expect(rates[0].perHour).toBeCloseTo(3240, 6);
    });

    test('no gains window is no rates rather than a division by zero', () => {
        expect(dropRates({ drops: { '/items/coin': 4 }, gainsSeconds: 0 })).toEqual([]);
        expect(dropRates(null)).toEqual([]);
    });
});

describe('taking the damage figure apart', () => {
    /** A sim result with an attack histogram, as the engine builds one */
    const withAttacks = (attacks) => ({
        simulatedTime: 100 * 1e9,
        encounters: 10,
        deaths: {},
        totalDamageDealt: { player1: 1000, '/monsters/fly': 100 },
        attacks,
        warnings: [],
    });

    test('the histogram is read as swings, hits and damage', () => {
        const swung = predictedSwings(
            withAttacks({
                player1: {
                    '/monsters/fly': {
                        autoAttack: { 100: 8, miss: 2 },
                        '/abilities/poke': { 250: 2 },
                    },
                },
            })
        );

        expect(swung).toEqual({ swings: 12, hits: 10, damage: 8 * 100 + 2 * 250 });
    });

    test('bleeds, thorns and retaliation are not swings on either side', () => {
        // The attribution ignores health falling without the hit counter
        // moving, so counting the simulator's bleeds would compare two
        // different things and call the difference an engine bug
        const swung = predictedSwings(
            withAttacks({
                player1: {
                    '/monsters/fly': {
                        autoAttack: { 100: 10 },
                        damageOverTime: { 30: 40 },
                        physicalThorns: { 12: 5 },
                        retaliation: { 60: 3, miss: 1 },
                    },
                },
            })
        );

        expect(swung).toEqual({ swings: 10, hits: 10, damage: 1000 });
    });

    test('a result with no attack detail is not decomposed', () => {
        expect(predictedSwings(withAttacks({}))).toBe(null);
        expect(predictedSwings({})).toBe(null);
        // A player who never swung is not a swing count of zero to divide by
        expect(predictedSwings(withAttacks({ player1: { '/monsters/fly': { damageOverTime: { 30: 4 } } } }))).toBe(
            null
        );
    });

    test('the three factors multiply back up to damage per second', () => {
        const observed = aggregateObservations([evenObservation({ seconds: 10, damageDealt: 1000, fights: 6 })]);

        // Four hits and one miss per fight, a thousand damage over ten seconds
        expect(observed.swingsPerSecond).toBeCloseTo(0.5, 10);
        expect(observed.hitRate).toBeCloseTo(0.8, 10);
        expect(observed.damagePerHit).toBeCloseTo(250, 10);
        expect(observed.swingsPerSecond * observed.hitRate * observed.damagePerHit).toBeCloseTo(observed.dps, 6);
    });

    test('both sides of the decomposition divide by the same clock', () => {
        // The one way a decomposition can be wrong without any of its rows
        // being wrong: observed swings over wall time against predicted swings
        // over time-in-combat manufactures a deficit of exactly the respawn
        // share, and every other row still agrees. So both denominators are
        // pinned to what they claim to be.
        const simResult = withAttacks({ player1: { '/monsters/fly': { autoAttack: { 25: 40, miss: 10 } } } });
        const predicted = predictFromSim(simResult);

        // Predicted: `simulatedTime`, the simulator's whole elapsed clock,
        // respawns and time spent dead included
        expect(predicted.seconds).toBe(simResult.simulatedTime / 1e9);
        expect(predicted.swingsPerSecond).toBeCloseTo(50 / (simResult.simulatedTime / 1e9), 12);
        expect(predicted.dps).toBeCloseTo(predicted.damageDealt / predicted.seconds, 12);

        // Observed: battle to battle, respawn gaps included, over the fights
        // that completed — the same span `secondsPerFight` is drawn from
        const observed = aggregateObservations([evenObservation({ seconds: 10, fights: 6 })]);
        expect(observed.seconds).toBe(60);
        expect(observed.swingsPerSecond).toBeCloseTo(30 / observed.seconds, 12);
        expect(observed.dps).toBeCloseTo(observed.damageDealt / observed.seconds, 12);
        expect(observed.secondsPerFight * observed.fights).toBeCloseTo(observed.seconds, 12);

        // And therefore: a run whose swings and seconds both match is not
        // flagged on swings, whatever the respawn share happens to be
        const matched = aggregateObservations([
            {
                ...evenObservation({ fights: 0 }),
                fights: Array.from({ length: 6 }, () => ({
                    seconds: predicted.seconds / 6,
                    damageDealt: predicted.damageDealt / 6,
                    damageTaken: 10,
                    regen: 0,
                    hits: 40 / 6,
                    misses: 10 / 6,
                    deaths: 0,
                    kills: 1,
                    monsters: ['Fly'],
                })),
            },
        ]);
        const swings = compareRun(matched, predicted).decomposition.find((m) => m.key === 'swingsPerSecond');
        expect(swings.deviationPct).toBeCloseTo(0, 10);
    });

    test('the derived fight length is the same span the swing rate divides by', () => {
        // Straight off a recording rather than a hand-built observation: what
        // `replayFights` calls a fight's seconds is `new_battle` to
        // `new_battle`, respawn included, and the swing count is over exactly
        // that window and no other
        const fights = replayFights(recording.ticks);
        const spanned = fights.reduce((total, fight) => total + fight.seconds, 0);
        const observed = aggregateObservations([observeRecording(recording)]);

        expect(observed.seconds).toBeCloseTo(spanned, 10);
        expect(observed.swingsPerSecond).toBeCloseTo(observed.swings / spanned, 12);
        expect(observed.dps).toBeCloseTo(observed.damageDealt / spanned, 12);
    });

    test('each factor gets its own band, measured from the fights', () => {
        const observed = aggregateObservations([evenObservation({ fights: 6 })]);
        const comparison = compareRun(
            observed,
            predictFromSim(withAttacks({ player1: { '/monsters/fly': { autoAttack: { 250: 40, miss: 10 } } } }))
        );

        expect(comparison.decomposition.map((metric) => metric.key)).toEqual([
            'swingsPerSecond',
            'hitRate',
            'damagePerHit',
        ]);
        for (const metric of comparison.decomposition) {
            expect(metric.marginPct).toBeGreaterThan(0);
        }
    });

    test('no decomposition when either side cannot supply one', () => {
        const observed = aggregateObservations([evenObservation({ fights: 6 })]);

        // The simulator carried no histogram
        expect(compareRun(observed, predictFromSim(withAttacks({}))).decomposition).toEqual([]);

        // The recording predates hits and misses being kept
        const old = aggregateObservations([
            {
                ...evenObservation({ fights: 0 }),
                fights: Array.from({ length: 5 }, () => ({
                    seconds: 10,
                    damageDealt: 1000,
                    damageTaken: 100,
                    regen: 0,
                    deaths: 0,
                    kills: 3,
                    monsters: ['Fly'],
                })),
            },
        ]);
        expect(
            compareRun(old, predictFromSim(withAttacks({ player1: { '/monsters/fly': { autoAttack: { 250: 40 } } } })))
                .decomposition
        ).toEqual([]);
    });
});

describe('saying how many more fights would settle it', () => {
    /** An observation whose per-fight damage has a known spread */
    function spread(values) {
        return {
            ...evenObservation({ fights: 0 }),
            fights: values.map((damageDealt) => ({
                seconds: 10,
                damageDealt,
                damageTaken: 100,
                regen: 0,
                hits: 4,
                misses: 1,
                deaths: 0,
                kills: 3,
                monsters: ['Fly'],
            })),
        };
    }

    test('a wide sample is told how many more it needs, from its own variance', () => {
        const observed = aggregateObservations([spread([800, 1200, 900, 1100, 1000])]);
        const suggestion = sampleSizeFor(observed);

        expect(suggestion.quiet).toBe(false);
        expect(suggestion.reachable).toBe(true);
        expect(suggestion.needed).toBeGreaterThan(0);
        expect(suggestion.requiredFights).toBe(suggestion.needed + suggestion.fights);
        expect(suggestion.text).toContain(`≈${suggestion.needed} more for ±${NOISE_QUIET_PCT}%`);
    });

    test('and the arithmetic is the margin formula run backwards', () => {
        const values = [800, 1200, 900, 1100, 1000];
        const observed = aggregateObservations([spread(values)]);

        // The rate per fight is the damage over ten seconds
        const rates = values.map((value) => value / 10);
        const mean = rates.reduce((total, value) => total + value, 0) / rates.length;
        const variance = rates.reduce((total, value) => total + (value - mean) ** 2, 0) / (rates.length - 1);
        const variation = Math.sqrt(variance) / mean;
        const room = NOISE_QUIET_PCT ** 2 - SIM_NOISE_FLOOR_PCT ** 2;
        const expected = Math.ceil(((1.96 * variation * 100) / Math.sqrt(room)) ** 2);

        expect(sampleSizeFor(observed).requiredFights).toBe(expected);
    });

    test('a sample already under the threshold is told it is done, not told to record more', () => {
        const suggestion = sampleSizeFor(aggregateObservations([evenObservation({ fights: 12 })]));

        expect(suggestion.quiet).toBe(true);
        expect(suggestion.needed).toBe(0);
        expect(suggestion.text).toContain(`already under ±${NOISE_QUIET_PCT}%`);
    });

    test('a band inside the simulator’s own allowance is refused rather than promised', () => {
        // The floor is added in quadrature and never shrinks, so no sample size
        // reaches a band at or under it
        const suggestion = sampleSizeFor(aggregateObservations([spread([800, 1200, 900, 1100, 1000])]), 1.5);

        expect(suggestion.reachable).toBe(false);
        expect(suggestion.needed).toBe(null);
        expect(suggestion.text).toContain('no sample size reaches it');
    });

    test('too few fights is no projection at all, since there is no spread to measure', () => {
        expect(sampleSizeFor(aggregateObservations([evenObservation({ fights: 2 })]))).toBe(null);
        expect(sampleSizeFor(null)).toBe(null);
    });

    test('it agrees with the band the panel already quotes', () => {
        const observed = aggregateObservations([spread([800, 1200, 900, 1100, 1000])]);

        expect(sampleSizeFor(observed).marginPct).toBeCloseTo(noiseSummary(observed).marginPct, 10);
    });
});

describe('what to look at first', () => {
    /** A comparison with the given verdicts on the headline and the factors */
    function comparisonWith({ metrics = {}, decomposition = {}, experience = null } = {}) {
        const row = (key, verdict) => ({ key, label: key, verdict, deviationPct: -9, marginPct: 3 });
        return {
            metrics: Object.entries(metrics).map(([key, verdict]) => row(key, verdict)),
            decomposition: Object.entries(decomposition).map(([key, verdict]) => row(key, verdict)),
            experience: experience ? row('xpPerSecond', experience) : null,
        };
    }

    const snapshot = { loadout: { levels: {} }, mixedLoadouts: false, deaths: 0 };

    test('nothing outside its band is nothing to explain', () => {
        // A deviation the sample cannot see does not need a suspect list
        const comparison = comparisonWith({
            metrics: { dps: 'within-noise' },
            decomposition: { hitRate: 'within-noise' },
        });

        expect(deviationHints(comparison, snapshot)).toEqual([]);
        expect(deviationHints(null, snapshot)).toEqual([]);
    });

    test('too few fights is not a deviation either', () => {
        const comparison = comparisonWith({ metrics: { dps: 'insufficient' } });
        expect(deviationHints(comparison, snapshot)).toEqual([]);
    });

    test('one factor outside its band names that factor first', () => {
        const comparison = comparisonWith({
            metrics: { dps: 'beyond-noise' },
            decomposition: { swingsPerSecond: 'within-noise', hitRate: 'beyond-noise' },
        });

        expect(deviationHints(comparison, snapshot)[0]).toContain('Accuracy');
    });

    test('two factors outside name neither, because that is not specific', () => {
        const comparison = comparisonWith({
            metrics: { dps: 'beyond-noise' },
            decomposition: { swingsPerSecond: 'beyond-noise', hitRate: 'beyond-noise' },
        });
        const hints = deviationHints(comparison, snapshot);

        expect(hints.some((hint) => hint.includes('Accuracy'))).toBe(false);
        expect(hints.some((hint) => hint.includes('Attack speed'))).toBe(false);
    });

    test('a headline gap with every factor inside says so rather than staying silent', () => {
        const comparison = comparisonWith({
            metrics: { dps: 'beyond-noise' },
            decomposition: {
                swingsPerSecond: 'within-noise',
                hitRate: 'within-noise',
                damagePerHit: 'within-noise',
            },
        });

        expect(deviationHints(comparison, snapshot).some((hint) => hint.includes('spread thinly'))).toBe(true);
    });

    test('a known difference outranks every guess', () => {
        // Without a snapshot the simulated character is simply not the recorded
        // one, and nothing else matters until that is ruled out
        const comparison = comparisonWith({
            metrics: { dps: 'beyond-noise' },
            decomposition: { hitRate: 'beyond-noise' },
        });

        expect(deviationHints(comparison, { ...snapshot, loadout: null })[0]).toContain('Gear drift');
    });

    test('a sample straddling a gear change says which fights were mis-compared', () => {
        const comparison = comparisonWith({ metrics: { dps: 'beyond-noise' } });

        expect(deviationHints(comparison, { ...snapshot, mixedLoadouts: true })[0]).toContain('same kit');
    });

    test('consumables are a suspect for damage and not for fight length', () => {
        const damage = comparisonWith({ metrics: { dps: 'beyond-noise' } });
        const length = comparisonWith({ metrics: { secondsPerFight: 'beyond-noise' } });

        expect(deviationHints(damage, snapshot).some((hint) => hint.startsWith('Consumables'))).toBe(true);
        expect(deviationHints(length, snapshot).some((hint) => hint.startsWith('Consumables'))).toBe(false);
    });

    test('experience outside its band gets its own suspects, not the damage ones', () => {
        const comparison = comparisonWith({ experience: 'beyond-noise' });
        const hints = deviationHints(comparison, snapshot);

        expect(hints.some((hint) => hint.startsWith('Experience buffs'))).toBe(true);
        expect(hints.some((hint) => hint.startsWith('Consumables'))).toBe(false);
    });

    test('deaths are mentioned only when there were some', () => {
        const comparison = comparisonWith({ metrics: { secondsPerFight: 'beyond-noise' } });

        expect(deviationHints(comparison, { ...snapshot, deaths: 2 })[0]).toContain('2 in this sample');
        expect(deviationHints(comparison, snapshot).some((hint) => hint.startsWith('Deaths'))).toBe(false);
    });
});

describe('whether the accuracy is drifting', () => {
    const entry = (at, extra = {}) => ({
        at,
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        fights: 20,
        deviationPct: -4,
        marginPct: 3,
        verdict: 'beyond-noise',
        ...extra,
    });

    test('a check is remembered by its headline deviation', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ fights: 6, damageDealt: 900 })]),
            predictFromSim({
                simulatedTime: 3600 * 1e9,
                encounters: 360,
                deaths: {},
                totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
                warnings: [],
            })
        );
        const remembered = historyEntry(comparison, 5_000);

        expect(remembered).toMatchObject({ at: 5_000, zoneHrid: '/actions/combat/fly', fights: 6 });
        expect(remembered.deviationPct).toBeCloseTo(comparison.metrics[0].deviationPct, 10);
        // The cohort marker: which engine's prediction was deviated from.
        // Null outside the sandbox, but always present.
        expect('v' in remembered).toBe(true);
    });

    test('a check with nothing to say is not remembered as a zero', () => {
        expect(historyEntry(null)).toBe(null);
        expect(historyEntry({ metrics: [{ key: 'dps', deviationPct: null }] })).toBe(null);
    });

    test('the oldest are dropped once there are too many', () => {
        const now = 100_000_000_000;
        const entries = Array.from({ length: 20 }, (_, index) => entry(now - index * 1_000));

        const kept = pruneHistory(entries, now);

        expect(kept).toHaveLength(8);
        // Oldest first, and the newest is the one that survived
        expect(kept[kept.length - 1].at).toBe(now);
        expect(kept[0].at).toBe(now - 7_000);
    });

    test('and by age, since a month-old check describes a character that has moved on', () => {
        const now = 100_000_000_000;
        const month = 30 * 24 * 60 * 60 * 1000;

        const kept = pruneHistory([entry(now - month - 1), entry(now - 1_000)], now);

        expect(kept).toHaveLength(1);
        expect(kept[0].at).toBe(now - 1_000);
    });

    test('a malformed entry is dropped rather than drawn as an invalid date', () => {
        expect(pruneHistory([{ deviationPct: 4 }, null, entry(Date.now())])).toHaveLength(1);
        expect(pruneHistory(null)).toEqual([]);
    });

    test('running the check writes the result beside the ones before it', async () => {
        replayCheck.observations = [evenObservation({ fights: 6, damageDealt: 900 })];
        game.simResult = {
            simulatedTime: 3600 * 1e9,
            encounters: 360,
            deaths: {},
            totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
            warnings: [],
        };

        await replayCheck.check();

        expect(replayCheck.history).toHaveLength(1);
        expect(storedList(HISTORY_KEY)).toHaveLength(1);
    });

    test('a full disk keeps it in memory rather than failing the check', async () => {
        replayCheck.observations = [evenObservation({ fights: 6, damageDealt: 900 })];
        game.simResult = {
            simulatedTime: 3600 * 1e9,
            encounters: 360,
            deaths: {},
            totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
            warnings: [],
        };
        store.quota = true;

        await replayCheck.check();

        expect(replayCheck.history).toHaveLength(1);
        expect(store.data.has(HISTORY_KEY)).toBe(false);
    });

    test('Forget clears it too, since a button that leaves a table on screen looks broken', async () => {
        replayCheck.history = [entry(Date.now())];

        await replayCheck.forget();

        expect(replayCheck.history).toEqual([]);
        expect(storedList(HISTORY_KEY)).toEqual([]);
    });

    test('it is read back per character on load', async () => {
        store.data.set(HISTORY_KEY, [entry(Date.now())]);

        await replayCheck.load();

        expect(replayCheck.history).toHaveLength(1);
    });
});

describe('the target control on the panel', () => {
    /** The shared recorder, with a target the control can set */
    function install({ recording = false, fights = 0, seconds = 0, targetMet = false } = {}) {
        const fake = {
            recording,
            target: null,
            isRecording: () => fake.recording,
            recordingStatus: () => ({ ticks: 0, seconds, full: false, fights, target: fake.target, targetMet }),
            normalizeTarget: (raw) =>
                Number(raw?.value) > 0 && ['fights', 'minutes'].includes(raw?.unit)
                    ? { value: Number(raw.value), unit: raw.unit }
                    : null,
            setRecordTarget: vi.fn((next) => {
                fake.target = fake.normalizeTarget(next);
                return fake.target;
            }),
            recordTarget: () => fake.target,
            startRecording: vi.fn(() => {
                fake.recording = true;
            }),
            stopRecording: vi.fn(),
            downloadRecording: vi.fn(),
        };
        window.Toolasha = { Combat: { combatRecorder: fake } };
        return fake;
    }

    const box = () => replayCheckPanel.panel?.querySelector('input[type="number"]');
    const buttons = () => [...(replayCheckPanel.panel?.querySelectorAll('button') || [])];
    const labelled = (text) => buttons().find((button) => button.textContent.startsWith(text));

    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('an empty box is unlimited, which is what recording has always done', () => {
        install();
        replayCheckPanel.show({ remember: false });

        expect(box()).toBeTruthy();
        expect(box().value).toBe('');
        expect(labelled('fights')).toBeTruthy();
        expect(replayCheckPanel.panel.textContent).not.toContain('could not be drawn');
    });

    test('typing a number sets it as the target', async () => {
        const recorder = install();
        replayCheckPanel.show({ remember: false });

        box().value = '100';
        box().dispatchEvent(new window.Event('change'));
        await settle();

        expect(recorder.target).toEqual({ value: 100, unit: 'fights' });
    });

    test('and clearing it goes back to unlimited', async () => {
        const recorder = install();
        replayCheckPanel.show({ remember: false });

        box().value = '100';
        box().dispatchEvent(new window.Event('change'));
        await settle();
        box().value = '';
        box().dispatchEvent(new window.Event('change'));
        await settle();

        expect(recorder.target).toBe(null);
    });

    test('the unit toggles, and re-reads the number it is already holding', async () => {
        const recorder = install();
        replayCheckPanel.show({ remember: false });

        box().value = '30';
        box().dispatchEvent(new window.Event('change'));
        await settle();
        expect(recorder.target).toEqual({ value: 30, unit: 'fights' });

        labelled('fights').click();
        await settle();

        expect(recorder.target).toEqual({ value: 30, unit: 'minutes' });
        expect(labelled('min')).toBeTruthy();
    });

    test('but a character switch takes the unit with the target it was chosen for', async () => {
        // The target is per-character and a switch clears it; the unit is only
        // remembered as shorthand for that target, so a unit left behind would
        // count the arriving character's first typed number in a unit they
        // never picked
        install();
        replayCheckPanel.show({ remember: false });
        labelled('fights').click();
        await settle();
        expect(labelled('min')).toBeTruthy();

        replayCheck.disable();
        replayCheckPanel.render();
        const recorder = install();
        replayCheckPanel.render();

        expect(labelled('fights')).toBeTruthy();
        box().value = '100';
        box().dispatchEvent(new window.Event('change'));
        await settle();

        expect(recorder.target).toEqual({ value: 100, unit: 'fights' });
    });

    test('a target already set draws in the box, so it survives a redraw', () => {
        const recorder = install();
        recorder.target = { value: 45, unit: 'minutes' };
        replayCheckPanel.show({ remember: false });

        expect(box().value).toBe('45');
        expect(labelled('min')).toBeTruthy();
    });

    test('the running button shows progress towards it', () => {
        const recorder = install({ recording: true, fights: 37 });
        recorder.target = { value: 100, unit: 'fights' };
        replayCheckPanel.show({ remember: false });

        expect(labelled('Recording 37/100 fights…')).toBeTruthy();
    });

    test('and says Done once it has been reached', () => {
        const recorder = install({ fights: 100, targetMet: true });
        recorder.target = { value: 100, unit: 'fights' };
        replayCheckPanel.show({ remember: false });

        expect(labelled('Done — 100 fights')).toBeTruthy();
    });

    test('the box goes wherever the Record button goes', () => {
        // Both are drawn from the same state, so a panel that could draw no
        // button would draw no box to point it at either
        install();
        replayCheckPanel.show({ remember: false });

        expect(labelled('Record')).toBeTruthy();
        expect(box()).toBeTruthy();
        expect(replayCheckPanel.panel.textContent).not.toContain('could not be drawn');
    });
});

describe('the panel, on everything it now says', () => {
    /** A sim result carrying the attack histogram and the experience */
    const fullSim = {
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        attacks: { player1: { '/monsters/fly': { autoAttack: { 250: 1440, miss: 360 } } } },
        experienceGained: { player1: { attack: 360_000, stamina: 180_000 } },
        warnings: [],
    };

    const text = () => replayCheckPanel.panel.textContent;

    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('the suggestion offers a target, and pressing it sets one', async () => {
        const recorder = {
            recording: false,
            target: null,
            isRecording: () => false,
            recordingStatus: () => ({ ticks: 0, seconds: 0, full: false, fights: 0, target: null, targetMet: false }),
            normalizeTarget: (raw) => (Number(raw?.value) > 0 ? { value: Number(raw.value), unit: raw.unit } : null),
            setRecordTarget: vi.fn((next) => {
                recorder.target = recorder.normalizeTarget(next);
                return recorder.target;
            }),
            recordTarget: () => recorder.target,
            startRecording: vi.fn(),
            stopRecording: vi.fn(),
            downloadRecording: vi.fn(),
        };
        window.Toolasha = { Combat: { combatRecorder: recorder } };

        replayCheck.observations = [
            {
                ...evenObservation({ fights: 0 }),
                fights: [800, 1200, 900, 1100, 1000].map((damageDealt) => ({
                    seconds: 10,
                    damageDealt,
                    damageTaken: 100,
                    regen: 0,
                    hits: 4,
                    misses: 1,
                    deaths: 0,
                    kills: 3,
                    monsters: ['Fly'],
                })),
            },
        ];
        replayCheckPanel.show({ remember: false });

        const ask = [...replayCheckPanel.panel.querySelectorAll('button')].find((button) =>
            button.textContent.startsWith('Record to ±')
        );
        expect(ask).toBeTruthy();
        expect(text()).toContain('more fights');

        ask.click();
        await settle();

        // The band and not the projected count: the count is an estimate off
        // this sample's spread, the band is the thing actually wanted, and the
        // recorder can now measure it as it goes
        expect(recorder.target.unit).toBe('noise');
        expect(recorder.target.value).toBe(NOISE_QUIET_PCT);
    });

    test('a sample already tight enough is not told to record more', () => {
        replayCheck.observations = [evenObservation({ fights: 24 })];
        replayCheckPanel.show({ remember: false });

        expect(text()).not.toContain('more fights');
    });

    test('the decomposition is drawn under the headline once there is one', () => {
        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheck.comparison = compareRun(aggregateObservations(replayCheck.observations), predictFromSim(fullSim));
        replayCheckPanel.show({ remember: false });

        expect(text()).toContain('Where the damage difference is');
        expect(text()).toContain('Share of swings landing');
        expect(text()).toContain('Crits are not compared');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the hints only appear when something is outside its band', () => {
        replayCheck.observations = [evenObservation({ fights: 6, damageDealt: 1000 })];
        replayCheck.comparison = compareRun(aggregateObservations(replayCheck.observations), predictFromSim(fullSim));
        replayCheckPanel.show({ remember: false });

        expect(text()).not.toContain('Worth checking first');

        replayCheckPanel.hide({ remember: false });
        replayCheck.observations = [evenObservation({ fights: 6, damageDealt: 700 })];
        replayCheck.comparison = compareRun(aggregateObservations(replayCheck.observations), predictFromSim(fullSim));
        replayCheckPanel.show({ remember: false });

        expect(text()).toContain('Worth checking first');
        expect(text()).toContain('Hints, not verdicts');
    });

    test('drops are labelled as not compared, because nothing predicts them', () => {
        replayCheck.observations = [
            { ...observeRecording(runWithGains({ count: 5 })), zoneHrid: '/actions/combat/fly' },
        ];
        replayCheck.comparison = compareRun(aggregateObservations(replayCheck.observations), predictFromSim(fullSim));
        replayCheckPanel.show({ remember: false });

        expect(text()).toContain('Drops observed (not compared)');
        expect(text()).toContain('no per-item drop');
    });

    test('the caveat no longer claims experience is not on the feed', () => {
        replayCheck.observations = [
            { ...observeRecording(runWithGains({ count: 5 })), zoneHrid: '/actions/combat/fly' },
        ];
        replayCheckPanel.show({ remember: false });

        expect(text()).not.toContain('not on the feed at all');
        expect(text()).toContain('taken from the running totals');
    });

    test('and says so plainly when the recording carried none', () => {
        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheckPanel.show({ remember: false });

        expect(text()).toContain('No experience or loot totals were on these battles');
    });

    test('the history table appears once there is a trend to see', () => {
        replayCheck.observations = [evenObservation({ fights: 6 })];
        const at = Date.now();
        replayCheck.history = [
            {
                at: at - 200_000,
                zoneHrid: '/actions/combat/fly',
                fights: 20,
                deviationPct: -3,
                marginPct: 2,
                verdict: 'beyond-noise',
            },
            {
                at: at - 100_000,
                zoneHrid: '/actions/combat/fly',
                fights: 30,
                deviationPct: -8,
                marginPct: 2,
                verdict: 'beyond-noise',
            },
        ];
        replayCheckPanel.show({ remember: false });

        expect(text()).toContain('Past checks');
        expect(text()).toContain('-8.0% ± 2.0% on 30 fights');
    });

    test('one check is not a trend, so no table', () => {
        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheck.history = [
            {
                at: Date.now(),
                zoneHrid: '/actions/combat/fly',
                fights: 20,
                deviationPct: -3,
                marginPct: 2,
                verdict: 'beyond-noise',
            },
        ];
        replayCheckPanel.show({ remember: false });

        expect(text()).not.toContain('Past checks');
    });
});

describe('observations and history survive a failed read and a second tab', () => {
    /** An observation whose signature is its own */
    const obs = (recordedAt, damage) => ({ recordedAt, fights: [{ damageDealt: damage }] });
    const entry = (at) => ({ at, zoneHrid: '/actions/combat/fly', result: 'ok' });

    test('a load that cannot read storage keeps what is in memory', async () => {
        replayCheck.observations = [obs(1, 10)];
        replayCheck.history = [entry(Date.now())];
        store.unavailable = true;

        await replayCheck.load();

        expect(replayCheck.observations).toHaveLength(1);
        expect(replayCheck.history).toHaveLength(1);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        store.data.set(OBSERVATIONS_KEY, [obs(1, 10)]);
        store.data.set(HISTORY_KEY, [entry(Date.now() - 1000)]);
        replayCheck.observations = [obs(2, 20)];
        replayCheck.history = [entry(Date.now())];
        store.unavailable = true;

        expect(await replayCheck.saveObservations()).toBe(false);
        expect(await replayCheck.saveHistory()).toBe(false);

        // Seeded in the pre-`clearedAt` shape and left exactly as it was: a
        // skipped save writes nothing, so the bare array is still a bare array
        expect(store.data.get(OBSERVATIONS_KEY)).toEqual([obs(1, 10)]);
        expect(store.data.get(HISTORY_KEY)).toHaveLength(1);
        expect(replayCheck.observations).toEqual([obs(2, 20)]);
    });

    test('a save folds in what another tab stored meanwhile', async () => {
        const now = Date.now();
        store.data.set(OBSERVATIONS_KEY, [obs(1, 10), obs(3, 30)]);
        store.data.set(HISTORY_KEY, [entry(now - 3000)]);
        replayCheck.observations = [obs(1, 10), obs(2, 20)];
        replayCheck.history = [entry(now - 2000)];

        await replayCheck.saveObservations();
        await replayCheck.saveHistory();

        expect(storedList(OBSERVATIONS_KEY).map((o) => o.recordedAt)).toEqual([1, 2, 3]);
        expect(replayCheck.observations.map((o) => o.recordedAt)).toEqual([1, 2, 3]);
        expect(storedList(HISTORY_KEY).map((e) => e.at)).toEqual([now - 3000, now - 2000]);
        expect(replayCheck.history).toHaveLength(2);
    });

    test('once storage reads again the next save lands everything', async () => {
        store.unavailable = true;
        replayCheck.observations = [obs(1, 10)];
        await replayCheck.saveObservations();
        expect(store.data.has(OBSERVATIONS_KEY)).toBe(false);

        store.unavailable = false;
        replayCheck.observations = [...replayCheck.observations, obs(2, 20)];
        await replayCheck.saveObservations();

        expect(storedList(OBSERVATIONS_KEY).map((o) => o.recordedAt)).toEqual([1, 2]);
    });

    test('forgetting is the one overwrite', async () => {
        store.data.set(OBSERVATIONS_KEY, [obs(1, 10)]);
        store.data.set(HISTORY_KEY, [entry(Date.now())]);

        await replayCheck.forget();

        expect(storedList(OBSERVATIONS_KEY)).toEqual([]);
        expect(storedList(HISTORY_KEY)).toEqual([]);
        // Stamped, so the fold on the other device drops what it still holds
        expect(store.data.get(OBSERVATIONS_KEY).clearedAt).toBeGreaterThan(0);
        expect(store.data.get(HISTORY_KEY).clearedAt).toBeGreaterThan(0);
    });
});

describe('per-wave timing of a dungeon recording', () => {
    /** Two waves of one monster each, then the announcement of a third so wave 2 has a gap */
    function dungeonTicks() {
        return [
            { at: 0, type: 'new_battle', payload: { wave: 1, mMap: { m: { cHP: 100, mHP: 100 } } } },
            { at: 500, type: 'battle_updated', payload: { mMap: { m: { cHP: 100, mHP: 100 } } } }, // undamaged yet
            { at: 2_900, type: 'battle_updated', payload: { mMap: { m: { cHP: 60, mHP: 100 } } } }, // first hit
            { at: 6_000, type: 'battle_updated', payload: { mMap: { m: { cHP: 0, mHP: 100 } } } }, // kill
            { at: 9_000, type: 'new_battle', payload: { wave: 2, mMap: { m2: { cHP: 200, mHP: 200 } } } }, // 3.0s gap
            { at: 10_000, type: 'battle_updated', payload: { mMap: { m2: { cHP: 150, mHP: 200 } } } },
            { at: 14_000, type: 'battle_updated', payload: { mMap: { m2: { cHP: 0, mHP: 200 } } } },
            { at: 17_000, type: 'new_battle', payload: { wave: 3, mMap: {} } },
        ];
    }

    test('reads each wave’s spawn→first-hit, spawn→last-kill and the respawn gap off delta ticks', () => {
        // The third announcement carries no monsters, so it is not a wave
        expect(waveTimingFromRecording({ ticks: dungeonTicks() })).toEqual([
            { wave: 1, spawnToFirstHitMs: 2_900, spawnToFightEndMs: 6_000, newBattleToNextMs: 9_000, gapMs: 3_000 },
            { wave: 2, spawnToFirstHitMs: 1_000, spawnToFightEndMs: 5_000, newBattleToNextMs: 8_000, gapMs: 3_000 },
        ]);
    });

    test('a previous wave’s corpse echoing at zero, and a tick with no monster changes, are not this wave’s hits', () => {
        // Delta ticks: the old wave's monster echoes 0/100 after the new wave is
        // announced, then a tick with nothing about monsters, then the wave's own
        // first hit and its kill
        const ticks = [
            { at: 0, type: 'new_battle', payload: { wave: 4, mMap: { n: { cHP: 500, mHP: 500 } } } },
            { at: 200, type: 'battle_updated', payload: { mMap: { m: { cHP: 0, mHP: 100 } } } },
            { at: 400, type: 'battle_updated', payload: { pMap: {} } },
            { at: 1_000, type: 'battle_updated', payload: { mMap: { n: { cHP: 300, mHP: 500 } } } },
            { at: 4_000, type: 'battle_updated', payload: { mMap: { n: { cHP: 0, mHP: 500 } } } },
        ];
        expect(waveTimingFromRecording({ ticks })).toEqual([
            { wave: 4, spawnToFirstHitMs: 1_000, spawnToFightEndMs: 4_000, newBattleToNextMs: null, gapMs: null },
        ]);
    });

    test('a battle with no wave field (a normal zone) is not a wave', () => {
        const ticks = [
            { at: 0, type: 'new_battle', payload: { mMap: { m: { cHP: 10, mHP: 10 } } } },
            { at: 1_000, type: 'battle_updated', payload: { mMap: { m: { cHP: 5, mHP: 10 } } } },
        ];
        expect(waveTimingFromRecording({ ticks })).toEqual([]);
        expect(waveTimingFromRecording(null)).toEqual([]);
    });

    test('lines waves up against the sim by label, wave w against #w, and averages per wave', () => {
        vi.spyOn(console, 'table').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const NS = 1e9;
        const simResult = {
            isDungeon: true,
            dungeonsCompleted: 10,
            // one run's worth of ns per wave: #1 fought 6.5s, first hit at 3.7s; #2 5.2s, first hit at 3.5s
            timeSpentAlive: [
                { name: '#1', timeSpentAlive: 6.5 * NS, count: 1 },
                { name: '#2', timeSpentAlive: 5.2 * NS, count: 1 },
            ],
            waveFirstHit: [
                { name: '#1', total: 3.7 * NS, count: 1 },
                { name: '#2', total: 3.5 * NS, count: 1 },
            ],
        };

        const { rows, summary } = dungeonWaveTiming({ recording: { ticks: dungeonTicks() }, simResult });

        // new_battle.wave and the sim's labels are both 1-based: pairing them
        // one apart once made every elite wave look under-modelled
        expect(rows[0]).toEqual({
            wave: 1,
            runs: 1,
            realFirstHitMs: 2_900,
            simFirstHitMs: 3_700,
            windupDeltaMs: 800,
            realFightMs: 6_000,
            simFightMs: 6_500,
            fightDeltaMs: 500,
            realDamagePhaseMs: 3_100,
            simDamagePhaseMs: 2_800,
            damagePhaseDeltaMs: -300,
            realGapMs: 3_000,
        });
        expect(rows[1]).toMatchObject({ wave: 2, realFirstHitMs: 1_000, simFirstHitMs: 3_500, windupDeltaMs: 2_500 });
        // the third announcement carried no monsters, so it is not a wave
        expect(rows).toHaveLength(2);
        expect(summary).toMatchObject({
            wavesCompared: 2,
            simRuns: 10,
            meanWindupDeltaMs: 1_650,
            meanDamagePhaseDeltaMs: -1_300,
            meanRealGapMs: 3_000,
        });
        vi.restoreAllMocks();
    });
});

describe('a cross-device sync pull combines the replay-check records', () => {
    test('the observation list is unioned by signature, not replaced', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

        // Both key shapes: the scoped one every account writes, and the bare
        // pre-scoping key still sitting on accounts that never migrated
        for (const key of ['combatReplayCheck_observations', 'combatReplayCheck_observations_char-A']) {
            const registration = mergeForKey('settings', key);
            expect(registration, `settings/${key} has no sync merge`).toBeTruthy();

            // This device watched one recording, the laptop watched another.
            // A whole-key write leaves the pull with only the laptop's, and
            // the run this device measured stops having been measured
            const local = [{ recordedAt: 10, fights: [{ damageDealt: 5 }] }];
            const incoming = [{ recordedAt: 20, fights: [{ damageDealt: 7 }, { damageDealt: 9 }] }];

            expect(registration.merge(local, incoming).entries.map((entry) => entry.recordedAt)).toEqual([10, 20]);
        }
    });

    test('Forget survives the round trip a peer would otherwise undo', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'combatReplayCheck_observations_char-A');

        // A forgets and pushes; B pulls. Only the pulling device merges, so a
        // Forget that loses here loses everywhere and comes back to A next pull
        const full = [{ recordedAt: 10 }, { recordedAt: 20 }];
        const forgotten = { clearedAt: 30, entries: [] };

        const bPulled = registration.merge(full, forgotten);
        expect(bPulled).toEqual({ clearedAt: 30, entries: [] });
        expect(registration.merge(forgotten, bPulled)).toEqual({ clearedAt: 30, entries: [] });
    });

    test('an observation the peer recorded after the Forget survives it', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'combatReplayCheck_observations_char-A');

        // The ordering hazard: the other device kept watching runs after the
        // Forget, and comparing the epoch to each `recordedAt` is what keeps them
        const peer = { clearedAt: 30, entries: [{ recordedAt: 40 }] };
        const forgotten = { clearedAt: 30, entries: [] };

        expect(registration.merge(forgotten, peer).entries.map((entry) => entry.recordedAt)).toEqual([40]);
    });

    test('a record no Forget has touched folds exactly as it did', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'combatReplayCheck_history_char-A');

        // Bare arrays are what every stored copy was before the epoch existed
        const now = Date.now();
        const merged = registration.merge([{ at: now - 2_000 }], [{ at: now - 1_000 }]);
        expect(merged).toEqual({ clearedAt: 0, entries: [{ at: now - 2_000 }, { at: now - 1_000 }] });
    });

    test('the check history is unioned by when the check ran', async () => {
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

        for (const key of ['combatReplayCheck_history', 'combatReplayCheck_history_char-A']) {
            const registration = mergeForKey('settings', key);
            expect(registration, `settings/${key} has no sync merge`).toBeTruthy();

            const now = Date.now();
            const local = [{ at: now - 2_000, ratio: 0.9 }];
            const incoming = [{ at: now - 1_000, ratio: 1.1 }];

            expect(registration.merge(local, incoming).entries.map((entry) => entry.ratio)).toEqual([0.9, 1.1]);
        }
    });
});
