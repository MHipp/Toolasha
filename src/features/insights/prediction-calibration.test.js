/**
 * The recorder, with the game faked around it.
 *
 * The load-bearing rule is which pairs get written at all. A prediction taken
 * *after* a run finished is measured against gear the run was never played
 * with, so the recorder must refuse it — and the one case where that refusal
 * would be wrong is the run that was already going when the script started,
 * whose forecast is still current. Both are asserted here, because either
 * mistake produces a full-looking history of numbers that mean nothing.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char-1',
    actionType: '/action_types/milking',
    profitPerHour: 1000,
    /** Loot log handlers, by message type */
    handlers: {},
    stored: {},
    unavailable: false,
    /** What the loot log's own arithmetic says a finished run paid */
    runProfit: { askProfit: 500, bidProfit: 400 },
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => game.stored[`${store}:${key}`] ?? fallback,
        tryGet: async (key, store) => {
            if (game.unavailable) return null;
            const value = game.stored[`${store}:${key}`];
            return value == null ? { found: false, value: null } : { found: true, value: structuredClone(value) };
        },
        set: async (key, value, store) => {
            if (game.unavailable) return false;
            game.stored[`${store}:${key}`] = structuredClone(value);
            return true;
        },
        delete: async (key, store) => {
            delete game.stored[`${store}:${key}`];
            return true;
        },
        getAllKeys: async (store) =>
            Object.keys(game.stored)
                .filter((k) => k.startsWith(`${store}:`))
                .map((k) => k.slice(store.length + 1)),
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char-1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getActionDetails: () => ({ type: game.actionType }),
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.handlers[type] = handler;
        },
        off: (type) => {
            delete game.handlers[type];
        },
    },
}));
vi.mock('../actions/gathering-profit.js', () => ({
    calculateGatheringProfit: async () => {
        if (game.gate) await game.gate;
        return { profitPerHour: game.profitPerHour, hasMissingPrices: false };
    },
}));
vi.mock('../actions/production-profit.js', () => ({
    calculateProductionProfit: async () => ({ profitPerHour: game.profitPerHour, hasMissingPrices: false }),
}));
vi.mock('../actions/loot-log-stats.js', () => ({
    LootLogStats: class {
        calculateProfit() {
            return game.runProfit;
        }
    },
}));
// The work is supposed to wait for a quiet moment; a test has none to wait for
vi.mock('../../utils/background-work.js', () => ({ runInBackground: async (name, work) => await work() }));

const { PredictionCalibration, actionTypeOf, mergeCalibrationRecords } = await import('./prediction-calibration.js');

/**
 * A loot log entry.
 * @param {number} id - characterActionId
 * @param {string} start - ISO start
 * @param {number} minutes - How long it ran
 * @returns {Object}
 */
function entry(id, start, minutes = 60) {
    const startTime = new Date(start);
    return {
        characterActionId: id,
        actionHrid: '/actions/milking/cow',
        startTime: startTime.toISOString(),
        endTime: new Date(startTime.getTime() + minutes * 60_000).toISOString(),
        actionCount: 100,
        drops: { '/items/milk': 100 },
    };
}

let calibration;

beforeEach(async () => {
    game.stored = {};
    game.handlers = {};
    // Readable storage is the neutral state. Several tests below make storage
    // unreadable and only some of them put it back, so it has to be reset here
    // rather than in the one describe that plays with it — otherwise a test
    // that merely runs after one of those silently gets its saves skipped.
    game.unavailable = false;
    game.characterId = 'char-1';
    game.profitPerHour = 1000;
    game.runProfit = { askProfit: 500, bidProfit: 400 };
    game.gate = null;
    calibration = new PredictionCalibration();
    await calibration.initialize();
});

/** Deliver a loot log message and wait for the queued pass. */
async function send(lootLog) {
    game.handlers.loot_log_updated({ lootLog });
    await calibration.queue;
}

/**
 * The stored ledger's entries, unwrapping the `{clearedAt, entries}` shape a
 * save now writes (cleared-record.js). A bare array, if a test wrote one
 * directly, reads as itself.
 */
function storedEntries(key) {
    const value = game.stored[key];
    return Array.isArray(value) ? value : value?.entries || [];
}

/** Simulate another tab's write: the entries change, the clear epoch carries. */
function writeStoredEntries(key, entries) {
    game.stored[key] = { clearedAt: game.stored[key]?.clearedAt || 0, entries };
}

describe('actionTypeOf', () => {
    test('names the skill an action belongs to', () => {
        expect(actionTypeOf('/actions/milking/cow')).toBe('milking');
        expect(actionTypeOf('')).toBe('unknown');
    });
});

describe('pairing a forecast with a finished run', () => {
    test('writes nothing for the run that is still going', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('writes the pair once a later run replaces it', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        const records = await calibration.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ id: 1, actionType: 'milking', predicted: 1000, actual: 500 });
        // The pair is persisted under this character's own key
        expect(storedEntries('lootLogHistory:calibration_char-1')).toHaveLength(1);
    });

    test('keeps the forecast taken while the run was going, not a later one', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        // Gear changed, so the calculator now says something else entirely
        game.profitPerHour = 9999;
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        expect((await calibration.getRecords())[0].predicted).toBe(1000);
    });

    test('refuses a run that was already over when the script started', async () => {
        // Both arrive at once: the older one never had a live forecast taken
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);
        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('does not write the same run twice', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        expect(await calibration.getRecords()).toHaveLength(1);
    });

    test('skips runs too short for their rate to mean anything', async () => {
        await send([entry(1, '2026-08-04T10:00:00Z', 0.5)]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z', 0.5)]);

        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('turns the run total into a rate per hour', async () => {
        // Half an hour of running that paid 500 is 1000/h
        await send([entry(1, '2026-08-04T10:00:00Z', 30)]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z', 30)]);

        expect((await calibration.getRecords())[0].actual).toBe(1000);
    });

    test('records nothing for an action the calculators cannot forecast', async () => {
        game.actionType = '/action_types/combat';
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        expect(await calibration.getRecords()).toHaveLength(0);
        game.actionType = '/action_types/milking';
    });

    test('accepts a pair another recorder measured, into the same ledger', async () => {
        const written = await calibration.addRecord({
            id: 'combat|A|2026-08-04T10:00:00Z',
            actionType: 'combat',
            predicted: 1000,
            actual: 900,
            t: Date.now(),
        });

        expect(written).toBe(true);
        // Same store, same key: one history, whoever measured the pair
        expect(storedEntries('lootLogHistory:calibration_char-1')).toHaveLength(1);
    });

    test('every pair carries its script-version cohort marker', async () => {
        await calibration.addRecord({ id: 'combat|v|1', actionType: 'combat', predicted: 1, actual: 1, t: 0 });
        // Outside the userscript sandbox the version is null — but the field is
        // there, so a reader can split cohorts without guessing from timestamps
        const [stamped] = await calibration.getRecords();
        expect('v' in stamped).toBe(true);
        expect(stamped.v).toBeNull();

        // A caller that stamped its own version keeps it
        await calibration.addRecord({
            id: 'combat|v|2',
            actionType: 'combat',
            predicted: 1,
            actual: 1,
            t: 0,
            v: '9.9.9',
        });
        expect((await calibration.getRecords()).at(-1).v).toBe('9.9.9');
    });

    test('does not accept the same outside pair twice, nor one without a name', async () => {
        const record = { id: 'combat|A|t', actionType: 'combat', predicted: 1, actual: 1, t: 0 };
        expect(await calibration.addRecord(record)).toBe(true);
        expect(await calibration.addRecord(record)).toBe(false);
        expect(await calibration.addRecord({ actionType: 'combat', predicted: 1, actual: 1 })).toBe(false);
        expect(await calibration.getRecords()).toHaveLength(1);
    });

    test('a character switch mid-predict must not carry the departing forecast into the arriving ledger', async () => {
        let releaseGate;
        game.gate = new Promise((resolve) => {
            releaseGate = resolve;
        });

        // char-1's run starts; the forecast calculation is in flight (gated) when
        // the character-switch teardown fires.
        game.handlers.loot_log_updated({ lootLog: [entry(1, '2026-08-04T10:00:00Z')] });
        await Promise.resolve();
        await Promise.resolve();

        // feature-registry tears the module down before currentCharacterId moves,
        // then the id moves and the module is brought back up for char-2.
        calibration.disable();
        game.characterId = 'char-2';
        await calibration.initialize();
        await calibration.ready;

        // The gated forecast for char-1's run resolves only now, after the switch.
        releaseGate();
        await calibration.queue;

        // char-2's own loot log reuses a characterActionId — ids are only unique
        // within one character's history — so char-1's leftover pending forecast
        // must not be mistaken for a real char-2 pair.
        game.handlers.loot_log_updated({
            lootLog: [entry(3, '2026-08-04T12:00:00Z'), entry(1, '2026-08-04T10:00:00Z')],
        });
        await calibration.queue;

        const records = await calibration.getRecords();
        expect(records.find((r) => r.id === 1)).toBeUndefined();
        expect(storedEntries('lootLogHistory:calibration_char-2').find((r) => r.id === 1)).toBeUndefined();
    });

    test('drops the oldest pairs rather than growing without end', async () => {
        calibration.records = Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, t: i }));
        await send([entry(1, '2026-08-04T10:00:00Z')]);
        await send([entry(2, '2026-08-04T11:30:00Z'), entry(1, '2026-08-04T10:00:00Z')]);

        const records = await calibration.getRecords();
        expect(records).toHaveLength(1000);
        expect(records[0].id).toBe('old-1');
        expect(records[records.length - 1].id).toBe(1);
    });
});

describe('the ledger survives a failed read and a second tab', () => {
    const KEY = 'lootLogHistory:calibration_char-1';
    const pair = (id, t = 0) => ({ id, actionType: 'combat', predicted: 1, actual: 1, t });

    test('a load that cannot read storage keeps the pairs in memory', async () => {
        await calibration.addRecord(pair('a', 1));
        game.unavailable = true;
        calibration.store.reset();

        await calibration._load();

        expect((await calibration.getRecords()).map((r) => r.id)).toEqual(['a']);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        await calibration.addRecord(pair('a', 1));
        game.unavailable = true;

        expect(await calibration.addRecord(pair('b', 2))).toBe(true);

        game.unavailable = false;
        expect(storedEntries(KEY).map((r) => r.id)).toEqual(['a']);
        expect((await calibration.getRecords()).map((r) => r.id)).toEqual(['a', 'b']);
    });

    test('a save folds in pairs another tab wrote meanwhile', async () => {
        await calibration.addRecord(pair('a', 1));
        writeStoredEntries(KEY, [...storedEntries(KEY), pair('c', 3)]);

        await calibration.addRecord(pair('b', 2));

        expect(storedEntries(KEY).map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect((await calibration.getRecords()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
        // And the merged-in pair is known, so it is not accepted twice
        expect(await calibration.addRecord(pair('c', 3))).toBe(false);
    });

    test('once storage reads again the next save lands everything', async () => {
        game.unavailable = true;
        await calibration.addRecord(pair('a', 1));
        await calibration.addRecord(pair('b', 2));
        expect(game.stored[KEY]).toBeUndefined();

        game.unavailable = false;
        await calibration.addRecord(pair('c', 3));

        expect(storedEntries(KEY).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    test('clearing is the one overwrite, and stamps what it writes', async () => {
        await calibration.addRecord(pair('a', 1));

        await calibration.clear();

        expect(storedEntries(KEY)).toEqual([]);
        // Stamped, so a peer's still-full copy cannot restore what was cleared
        // on the next sync pull (utils/cleared-record.js)
        expect(game.stored[KEY].clearedAt).toBeGreaterThan(0);
    });

    test('a character switch forgets the departing character’s pairs', async () => {
        await calibration.addRecord(pair('a', 1));
        game.characterId = 'char-2';

        await calibration.addRecord(pair('z', 9));

        expect(storedEntries('lootLogHistory:calibration_char-2').map((r) => r.id)).toEqual(['z']);
        expect(storedEntries(KEY).map((r) => r.id)).toEqual(['a']);
        game.characterId = 'char-1';
    });
});

describe('Clear survives a sync pull', () => {
    const pair = (id, t) => ({ id, actionType: 'combat', predicted: 1, actual: 1, t });
    const pool = (entries, clearedAt = 0) => ({ clearedAt, entries });

    test('a peer that still holds the cleared pairs does not bring them back', () => {
        // This device cleared and pushed; a peer that had not cleared pulls.
        // The plain union has no way to say a pair was thrown away, so without
        // the epoch the peer's still-full copy restores it — and restores it
        // back to this device on the next pull
        const full = [pair('old-1', 500), pair('old-2', 600)];
        const cleared = pool([], 1_000);

        const peerPulled = mergeCalibrationRecords(full, cleared);
        expect(peerPulled).toEqual(pool([], 1_000));
        expect(mergeCalibrationRecords(cleared, peerPulled)).toEqual(pool([], 1_000));
    });

    test('a pair recorded elsewhere after the clear still arrives', () => {
        const cleared = pool([], 1_000);
        const peer = pool([pair('before', 500), pair('after', 2_000)], 1_000);

        expect(mergeCalibrationRecords(cleared, peer).entries.map((r) => r.id)).toEqual(['after']);
    });

    test('the fold is order-independent', () => {
        const cleared = pool([], 1_000);
        const peer = pool([pair('before', 500), pair('after', 2_000)], 1_000);

        expect(mergeCalibrationRecords(cleared, peer).entries.map((r) => r.id)).toEqual(['after']);
        expect(mergeCalibrationRecords(peer, cleared).entries.map((r) => r.id)).toEqual(['after']);
    });

    test('a ledger no clear has touched folds exactly as it did', () => {
        const merged = mergeCalibrationRecords([pair('mine', 5_000)], [pair('theirs', 6_000)]);
        expect(merged.clearedAt).toBe(0);
        expect(merged.entries.map((r) => r.id)).toEqual(['mine', 'theirs']);
    });
});
