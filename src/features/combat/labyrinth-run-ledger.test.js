import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
const game = vi.hoisted(() => ({ characterId: 'char1' }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        characterData: null,
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    default: labyrinthRunLedger,
    gridSize,
    roomsFullClear,
    roomsRush,
    torchesForPlan,
    rushFloorTable,
    foldSighting,
    observedUse,
    preserveChance,
    burnSummary,
    torchesPerFloor,
    sparkText,
} = await import('./labyrinth-run-ledger.js');

describe('the grid arithmetic, straight from the game guide', () => {
    test('floor 1 is 4×4, one wider per floor, capped at 8×8 from floor 5', () => {
        expect(gridSize(1)).toBe(4);
        expect(gridSize(2)).toBe(5);
        expect(gridSize(4)).toBe(7);
        expect(gridSize(5)).toBe(8);
        expect(gridSize(17)).toBe(8);
    });

    test('a full clear enters the whole grid; a rush the corner-to-corner path', () => {
        expect(roomsFullClear(1)).toBe(16);
        expect(roomsFullClear(5)).toBe(64);
        expect(roomsRush(1)).toBe(7); // 4+4−1 rooms along the shortest path
        expect(roomsRush(5)).toBe(15);
    });

    test('the plan sums rushed floors as paths and the rest as full grids', () => {
        // Rush ≤2, deepest 3: 7 + 9 + 36
        expect(torchesForPlan(2, 3)).toBe(52);
        // Rush nothing: full clears only
        expect(torchesForPlan(0, 2)).toBe(16 + 25);
    });

    test('the advisor table marks which rush floors fit the capacity', () => {
        const rows = rushFloorTable(3, 60);
        expect(rows).toHaveLength(4); // rush 0..3
        expect(rows[0]).toEqual({ rushFloor: 0, torches: 77, fits: false });
        // A preserving tier hands a share back: the same rooms, fewer torches
        expect(rushFloorTable(3, 50, 0.2)[0].torches).toBe(Math.ceil(77 * 0.8));
        expect(
            preserveChance('/items/expert_torch', {
                '/items/expert_torch': {
                    description: 'Used in the Labyrinth. Consumed when entering a room. 20% chance to preserve.',
                },
            })
        ).toBe(0.2);
        expect(
            preserveChance('/items/basic_torch', { '/items/basic_torch': { description: 'Used in the Labyrinth.' } })
        ).toBe(0);
        expect(rows[2].torches).toBe(52);
        expect(rows[2].fits).toBe(true);
    });
});

describe('foldSighting', () => {
    const active = (over = {}) => ({
        isActive: true,
        startedAt: '2026-08-18T00:00:00Z',
        currentFloor: 3,
        torchCount: 120,
        shroudCount: 4,
        beaconCount: 5,
        torchItemHrid: '/items/expert_torch',
        ...over,
    });
    const start = { phase: 'unknown', run: null };

    test('a run joined mid-way keeps its floor-of-a-measurement out of the average', () => {
        // First seen on floor 3 (a reload): its start is just where we came
        // in, so the spend it reports would drag a 350-torch run down to 100
        let s = foldSighting(start, active({ currentFloor: 3, torchCount: 120 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 6, torchCount: 40 }), 2000).state;
        const { ended } = foldSighting(s, { isActive: false }, 3000);

        expect(ended.startTrusted).toBe(false);
        expect(observedUse([ended], 'torch')).toEqual([]);
    });

    test('a record from before the trust flag existed does not count either', () => {
        expect(observedUse([{ start: { torch: 100 }, left: { torch: 40 } }], 'torch')).toEqual([]);
    });

    test('an active run is tracked at its deepest floor and last-seen counts', () => {
        let s = foldSighting(start, active(), 1000).state;
        s = foldSighting(s, active({ currentFloor: 5, torchCount: 80 }), 2000).state;
        expect(s.run.floor).toBe(5);
        expect(s.run.left.torch).toBe(80);
        expect(s.run.itemHrids.torch).toBe('/items/expert_torch');
    });

    test('the first counts seen are the start, so the ending can say what was spent', () => {
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 120, shroudCount: 4 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 5, torchCount: 61, shroudCount: 1 }), 2000).state;
        const { ended } = foldSighting(s, { isActive: false }, 3000);
        expect(ended.start).toMatchObject({ torch: 120, shroud: 4 });
        expect(ended.left).toMatchObject({ torch: 61, shroud: 1 });
        expect(observedUse([ended], 'torch')).toEqual([59]);
        expect(observedUse([ended], 'shroud')).toEqual([3]);
        // A record with no start (an older ledger) reports nothing rather than a guess
        expect(observedUse([{ left: { torch: 10 } }], 'torch')).toEqual([]);
    });

    test('a reconnect mid-run closes the old run out instead of dropping it', () => {
        // Socket drops after floor 3; by the time it is back, the next run has
        // started. The old run's 60 torches used to vanish with it.
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 100 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 3, torchCount: 40 }), 2000).state;
        const next = foldSighting(s, active({ startedAt: '2026-08-18T04:00:00Z', currentFloor: 1 }), 9000);

        expect(next.ended).toBeTruthy();
        expect(next.ended.key).toBe('2026-08-18T00:00:00Z');
        expect(next.ended.spent.torch).toBe(60);
        expect(next.ended.endedAt).toBe(9000);
        expect(next.ended.endedByInference).toBe(true);
        // …and the new run is what the state now follows
        expect(next.state.run.key).toBe('2026-08-18T04:00:00Z');
    });

    test('a run closed by inference is kept but never averaged', () => {
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 100 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 3, torchCount: 40 }), 2000).state;
        const { ended } = foldSighting(s, active({ startedAt: '2026-08-18T04:00:00Z', currentFloor: 1 }), 9000);

        // Its spend is a lower bound — whatever it burned after the last
        // sighting went unseen — so it must not be presented as measured
        expect(ended.startTrusted).toBe(true);
        expect(observedUse([ended], 'torch')).toEqual([]);
        expect(burnSummary([ended], 'torch')).toBeNull();
        expect(torchesPerFloor([ended])).toEqual([]);
    });

    test('a run seen to its end is not marked as inferred', () => {
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 100 }), 1000).state;
        const { ended } = foldSighting(s, { isActive: false }, 2000);
        expect(ended.endedByInference).toBeUndefined();
        expect(observedUse([ended], 'torch')).toEqual([0]);
    });

    test('a mid-run shop top-up does not net against earlier spending', () => {
        // Start with 100, spend down to 40 by floor 3, buy back up to 150 with
        // earned points, then spend down to 40 by the exit. start - left would
        // read this as 100 - 40 = 60 spent; the true spend across both legs is
        // 60 + 110 = 170.
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 100 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 3, torchCount: 40 }), 2000).state;
        s = foldSighting(s, active({ currentFloor: 3, torchCount: 150 }), 3000).state;
        s = foldSighting(s, active({ currentFloor: 6, torchCount: 40 }), 4000).state;
        const { ended } = foldSighting(s, { isActive: false }, 5000);

        expect(ended.spent.torch).toBe(170);
        expect(observedUse([ended], 'torch')).toEqual([170]);
        // A record with no start - left "net spend" of its own would
        // undercount, or even go negative once the top-up outweighs the
        // pre-top-up spend — spent never does either.
        expect(ended.start.torch - ended.left.torch).toBe(60);
    });

    test('a record from before spend-accumulation existed falls back to start - left', () => {
        expect(observedUse([{ startTrusted: true, start: { torch: 100 }, left: { torch: 40 } }], 'torch')).toEqual([
            60,
        ]);
    });

    test('the ending records the run once, off the active→ended edge', () => {
        const s = foldSighting(start, active({ torchCount: 61 }), 1000).state;
        const { state, ended } = foldSighting(s, { isActive: false }, 2000);
        expect(ended).toMatchObject({ floor: 3, left: { torch: 61 }, endedAt: 2000 });
        // The server re-sends after a run ends; a second ended sighting records nothing
        expect(foldSighting(state, { isActive: false }, 3000).ended).toBeNull();
    });

    test('the post-run re-sends do not bank the finished run a second time at full capacity', () => {
        // The run ends with 43 torches left. The server then re-sends the
        // labyrinth: the grid and the path are still in hand and `isActive` is
        // absent, so the payload reads as active — on the restocked pile, not
        // on the run's own stock. That re-opened the finished run and recorded
        // it again with a whole capacity left unspent, which is the "left over
        // 400 of 400" line the Consumables panel showed.
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 400 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 7, torchCount: 43 }), 2000).state;
        const first = foldSighting(s, { isActive: false }, 3000);
        expect(first.ended.left.torch).toBe(43);

        const resend = foldSighting(
            first.state,
            { startedAt: '2026-08-18T00:00:00Z', currentFloor: 7, torchCount: 400, roomData: [[{}]] },
            4000
        );
        expect(resend.ended).toBeNull();
        expect(resend.state.phase).toBe('ended');
        expect(foldSighting(resend.state, { isActive: false }, 5000).ended).toBeNull();

        // …and the next real run is still followed
        const next = foldSighting(resend.state, active({ startedAt: 'S2', currentFloor: 1, torchCount: 400 }), 6000);
        expect(next.state.run.key).toBe('S2');
        expect(foldSighting(next.state, { isActive: false }, 7000).ended.left.torch).toBe(400);
    });

    test('an unstamped active sighting after a run has ended opens nothing', () => {
        // The post-run re-send with the stamp stripped: it still carries the
        // grid, so it reads as active, and there is no run in hand to key it
        // on. Naming it after the clock invented a run neither ending guard
        // could see — `endedKey` and the ring both hold the real run's key.
        let s = foldSighting(start, active({ currentFloor: 1, torchCount: 400 }), 1000).state;
        s = foldSighting(s, active({ currentFloor: 7, torchCount: 43 }), 2000).state;
        const ended = foldSighting(s, { isActive: false }, 3000);

        const resend = foldSighting(ended.state, { currentFloor: 7, torchCount: 400, roomData: [[{}]] }, 4000);

        expect(resend.ended).toBeNull();
        expect(resend.state).toBe(ended.state);
        expect(resend.state.run).toBeNull();
        expect(resend.state.phase).toBe('ended');
        // …and no ending falls out of it later either
        expect(foldSighting(resend.state, { isActive: false }, 5000).ended).toBeNull();
    });

    test('an unstamped sighting mid-run keeps the run it is already following', () => {
        const s = foldSighting(start, active({ currentFloor: 1, torchCount: 400 }), 1000).state;

        const next = foldSighting(s, { currentFloor: 4, torchCount: 210, roomData: [[{}]] }, 2000);

        expect(next.state.run.key).toBe('2026-08-18T00:00:00Z');
        expect(next.state.run.left.torch).toBe(210);
        expect(next.ended).toBeNull();
    });

    test('a stamped payload after an unstamped one opens the run under its stamp', () => {
        const ignored = foldSighting(start, { currentFloor: 1, torchCount: 400, roomData: [[{}]] }, 1000);
        expect(ignored.state.run).toBeNull();

        const opened = foldSighting(ignored.state, active({ startedAt: 'S9', currentFloor: 1, torchCount: 400 }), 2000);

        expect(opened.state.run.key).toBe('S9');
        expect(opened.state.run.startTrusted).toBe(true);
        expect(foldSighting(opened.state, { isActive: false }, 3000).ended.key).toBe('S9');
    });

    test('a payload that says nothing about the run is not the run ending', () => {
        const s = foldSighting(start, active(), 1000).state;
        expect(foldSighting(s, {}, 2000).ended).toBeNull();
        expect(foldSighting(s, {}, 2000).state.phase).toBe('active');
    });
});

describe('the ring survives a failed read and a second tab', () => {
    const KEY = 'labyrinthRunLedger_char1';
    const stored = () => storageMock.storeFor('labyrinth').get(KEY);
    const ending = (key, endedAt = Number(key)) => ({ key, floor: 3, endedAt });

    beforeEach(() => {
        storageMock.reset();
        game.characterId = 'char1';
        labyrinthRunLedger.ledgerOwner = null;
        labyrinthRunLedger.recorded.clear();
    });

    test('an ending is appended newest first under the character key', async () => {
        await labyrinthRunLedger._append(ending('1'));
        await labyrinthRunLedger._append(ending('2'));

        expect(stored().map((run) => run.key)).toEqual(['2', '1']);
        expect((await labyrinthRunLedger.runs()).map((run) => run.key)).toEqual(['2', '1']);
    });

    test('a read that cannot be made keeps the ring in memory instead of truncating it', async () => {
        await labyrinthRunLedger._append(ending('1'));
        storageMock.unavailable = true;

        await labyrinthRunLedger._append(ending('2'));

        expect((await labyrinthRunLedger.runs()).map((run) => run.key)).toEqual(['2', '1']);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        await labyrinthRunLedger._append(ending('1'));
        storageMock.unavailable = true;

        expect(await labyrinthRunLedger._append(ending('2'))).toBe(false);

        storageMock.unavailable = false;
        expect(stored().map((run) => run.key)).toEqual(['1']);
    });

    test('a save folds in endings another tab recorded meanwhile', async () => {
        await labyrinthRunLedger._append(ending('1'));
        storageMock.storeFor('labyrinth').set(KEY, [ending('3'), ending('1')]);

        await labyrinthRunLedger._append(ending('2'));

        expect(stored().map((run) => run.key)).toEqual(['3', '2', '1']);
    });

    test('once storage reads again the next save lands everything', async () => {
        storageMock.unavailable = true;
        await labyrinthRunLedger._append(ending('1'));
        await labyrinthRunLedger._append(ending('2'));
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        await labyrinthRunLedger._append(ending('3'));

        expect(stored().map((run) => run.key)).toEqual(['3', '2', '1']);
    });

    test('a run already in the ring is not appended over by a second ending', async () => {
        // A reload between the ending and the server's post-run re-sends has no
        // `recorded` set to consult, and the merge lets memory win over what is
        // stored — so the re-derived ending replaced the true leftovers with the
        // restocked counts instead of being ignored.
        await labyrinthRunLedger._append({ ...ending('1'), left: { torch: 43 } });
        labyrinthRunLedger.recorded.clear();

        expect(await labyrinthRunLedger._append({ ...ending('1', 9999), left: { torch: 400 } })).toBe(false);

        expect(stored()).toHaveLength(1);
        expect(stored()[0].left.torch).toBe(43);
    });

    test('a character switch forgets the departing character’s endings', async () => {
        await labyrinthRunLedger._append(ending('1'));
        game.characterId = 'char2';

        await labyrinthRunLedger._append(ending('9'));

        expect(
            storageMock
                .storeFor('labyrinth')
                .get('labyrinthRunLedger_char2')
                .map((run) => run.key)
        ).toEqual(['9']);
        expect(stored().map((run) => run.key)).toEqual(['1']);
    });

    test('a run in flight when the character changes is not filed under the arriving one', async () => {
        // The registry tears features down by calling disable(), which the
        // ledger did not have — so the handler stayed hooked with the departing
        // character's run still active. The arriving character's first sighting
        // says no labyrinth, which is the active→ended edge, and the append
        // resolves the key when it runs rather than when the run started.
        labyrinthRunLedger.stateOwner = null;
        labyrinthRunLedger.observe({
            isActive: true,
            startedAt: 5000,
            floor: 4,
            torchCount: 80,
            shroudCount: 4,
            beaconCount: 3,
        });
        expect(labyrinthRunLedger.state.phase).toBe('active');

        game.characterId = 'char2';
        labyrinthRunLedger.observe({ isActive: false });
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));

        expect(storageMock.storeFor('labyrinth').get('labyrinthRunLedger_char2')).toBeUndefined();
    });

    test('the registry tears the ledger down by the name it calls', () => {
        expect(typeof labyrinthRunLedger.disable).toBe('function');
        labyrinthRunLedger.observe({ isActive: true, startedAt: 6000, floor: 2, torchCount: 50 });
        labyrinthRunLedger.disable();
        expect(labyrinthRunLedger.state).toEqual({ phase: 'unknown', run: null });
    });
});

/**
 * A ledger record, trimmed to what the trend readings look at.
 * @param {Object} fields - Overrides
 * @returns {Object}
 */
function run({ key = 'r', floor = 5, torch = 100, shroud = 2, beacon = 3, trusted = true, ...rest } = {}) {
    return {
        key,
        startTrusted: trusted,
        floor,
        spent: { torch, shroud, beacon },
        endedAt: 1000,
        ...rest,
    };
}

describe('burnSummary', () => {
    test('averages what the trusted runs spent, and says how many there were', () => {
        const summary = burnSummary([run({ torch: 100 }), run({ torch: 50 }), run({ torch: 60 })], 'torch');
        expect(summary).toEqual({ runs: 3, total: 210, average: 70, min: 50, max: 100 });
    });

    test('each supply is summarised on its own', () => {
        const runs = [run({ shroud: 4, beacon: 1 }), run({ shroud: 2, beacon: 5 })];
        expect(burnSummary(runs, 'shroud')).toMatchObject({ runs: 2, average: 3 });
        expect(burnSummary(runs, 'beacon')).toMatchObject({ runs: 2, average: 3 });
    });

    test('a run joined part-way through is left out entirely', () => {
        // The 350-torch run that read as 106: its start is only where it was
        // first seen, so its spend is a floor rather than a measurement
        const summary = burnSummary([run({ torch: 300 }), run({ torch: 106, trusted: false })], 'torch');
        expect(summary).toEqual({ runs: 1, total: 300, average: 300, min: 300, max: 300 });
    });

    test('no trusted run means no summary at all, rather than a zero', () => {
        expect(burnSummary([run({ trusted: false })], 'torch')).toBeNull();
        expect(burnSummary([], 'torch')).toBeNull();
        expect(burnSummary(null, 'torch')).toBeNull();
    });
});

describe('torchesPerFloor', () => {
    test('normalises each run by the deepest floor it reached', () => {
        // 120 torches over 6 floors and 40 over 2 are the same play; only the
        // per-floor figure says so
        const entries = torchesPerFloor([run({ torch: 120, floor: 6 }), run({ torch: 40, floor: 2 })]);
        expect(entries.map((entry) => entry.perFloor)).toEqual([20, 20]);
        expect(entries.map((entry) => entry.torches)).toEqual([120, 40]);
        expect(entries.map((entry) => entry.floor)).toEqual([6, 2]);
    });

    test('untrusted runs are excluded, for the same reason the average excludes them', () => {
        const entries = torchesPerFloor([run({ torch: 120, floor: 6 }), run({ torch: 12, floor: 6, trusted: false })]);
        expect(entries).toHaveLength(1);
        expect(entries[0].perFloor).toBe(20);
    });

    test('a run that never reached floor 1 has nothing to divide by', () => {
        expect(torchesPerFloor([run({ floor: 0 })])).toEqual([]);
    });

    test('an old record with no `spent` falls back to start minus left', () => {
        const legacy = { key: 'old', startTrusted: true, floor: 4, start: { torch: 90 }, left: { torch: 10 } };
        expect(torchesPerFloor([legacy])[0]).toMatchObject({ torches: 80, floor: 4, perFloor: 20 });
    });

    test('a record with neither figure is skipped rather than counted as nothing', () => {
        expect(torchesPerFloor([{ key: 'x', startTrusted: true, floor: 3 }])).toEqual([]);
    });

    test('the ledger order is kept, so the caller decides which way time runs', () => {
        const entries = torchesPerFloor([
            run({ key: 'new', torch: 10, floor: 1 }),
            run({ key: 'old', torch: 30, floor: 1 }),
        ]);
        expect(entries.map((entry) => entry.torches)).toEqual([10, 30]);
    });
});

describe('sparkText', () => {
    test('one glyph per value, low to high', () => {
        const bars = sparkText([1, 2, 3, 4]);
        expect(bars).toHaveLength(4);
        expect(bars[0]).toBe('▁');
        expect(bars[3]).toBe('█');
    });

    test('a flat series is drawn flat rather than magnified into noise', () => {
        expect(sparkText([40, 40, 40])).toBe('▄▄▄');
    });

    test('nothing to draw draws nothing', () => {
        expect(sparkText([])).toBe('');
        expect(sparkText(null)).toBe('');
        expect(sparkText([NaN, undefined])).toBe('');
    });

    test('a single reading is one bar, not a shape', () => {
        expect(sparkText([7])).toHaveLength(1);
    });
});
