/**
 * The task completion tracker.
 *
 * The whole feature rests on one distinction — a task that was claimed versus
 * one that was thrown away or rerolled — and the cost of getting it wrong is not
 * a wrong number on a tile but a wrong number that persists: a reroll counted as
 * income is counted again when the task really is claimed, and the rate is
 * inflated for eight weeks. So most of what is held down here is the three
 * exits, and the fourth case that only shows up in a live session: the same
 * claim delivered twice.
 *
 * The storage half is exercised against a fake IndexedDB rather than a mocked
 * chunked history, because the claim being made is about *which keys are
 * written* — one week's record per week, and the record of a week that has aged
 * out of the window deleted rather than left behind.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        get: vi.fn(async (key, storeName, fallback) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
            return true;
        }),
        getMany: vi.fn(async (keys) => {
            const result = new Map();
            for (const key of keys) result.set(key, store.has(key) ? store.get(key) : null);
            return result;
        }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        // Delegates to the listing above, so a test that changes how keys are
        // listed changes both. `chunked-history.js` reads through this one
        // because an unlistable store must not read as an empty history.
        tryGetAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
});

const game = vi.hoisted(() => ({
    charId: 'cow1',
    clientData: {
        combatMonsterDetailMap: { '/monsters/jungle_sprite': { name: 'Jungle Sprite' } },
        actionDetailMap: { '/actions/milking/cow': { name: 'Cow', type: '/action_types/milking' } },
    },
    quests: [],
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));

vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.charId,
        getInitClientData: () => game.clientData,
        get characterQuests() {
            return game.quests;
        },
        on: vi.fn(),
        off: vi.fn(),
    },
}));

const trackerModule = await import('./task-completion-tracker.js');
const tracker = trackerModule.default;
const { weekChunkId, parseRewards, questSnapshot, isReroll, pruneEntries, rateOver, computeRates, WINDOW_WEEKS } =
    trackerModule;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/**
 * A task on the board.
 * @param {Object} [overrides] - Fields to change
 * @returns {Object} A quest record as the wire carries it
 */
function quest(overrides = {}) {
    return {
        id: 101,
        category: '/quest_category/random_task',
        status: '/quest_status/in_progress',
        type: '/quest_type/action',
        actionHrid: '/actions/milking/cow',
        goalCount: 300,
        currentCount: 0,
        coinRerollCount: 0,
        cowbellRerollCount: 0,
        itemRewardsJSON: JSON.stringify([
            { itemHrid: '/items/coin', count: 3787 },
            { itemHrid: '/items/task_token', count: 4 },
        ]),
        ...overrides,
    };
}

/** The same task, finished and turned in */
const claimed = (overrides = {}) => quest({ status: '/quest_status/claimed', currentCount: 300, ...overrides });

/** A completion entry, for the rate maths */
const entry = (completedAt, tokens = 4, coins = 1000) => ({ completedAt, tokens, coins });

beforeEach(() => {
    storageMock.store.clear();
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    storageMock.isQuotaExceeded.mockImplementation(() => false);
    game.charId = 'cow1';
    game.quests = [];
    tracker.forget();
    tracker.subscribers.clear();
});

describe('telling a completion from everything else', () => {
    test('a claimed task is income, with what it paid', () => {
        tracker.ingest([quest()]);
        const recorded = tracker.ingest([claimed()], 1_700_000_000_000);

        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            questId: 101,
            name: 'Cow',
            category: 'milking',
            taskHrid: '/actions/milking/cow',
            tokens: 4,
            coins: 3787,
            goalCount: 300,
            progressMet: true,
            completedAt: 1_700_000_000_000,
        });
    });

    test('a discarded task pays nothing and is not recorded', () => {
        tracker.ingest([quest()]);
        const recorded = tracker.ingest([quest({ status: '/quest_status/discarded' })]);

        expect(recorded).toEqual([]);
        expect(tracker.entries).toEqual([]);
    });

    test('a task that simply vanishes from the board is not a completion either', () => {
        tracker.ingest([quest({ currentCount: 300 })]);
        // The next full board carries only the other slot: nothing says the
        // missing one was claimed rather than binned
        tracker.ingest([quest({ id: 202 })]);

        expect(tracker.entries).toEqual([]);
    });

    test('a reroll is a new task under the same id, not a finished one', () => {
        tracker.ingest([quest()]);
        const rerolled = quest({
            actionHrid: '/actions/foraging/egg',
            goalCount: 120,
            coinRerollCount: 1,
            itemRewardsJSON: JSON.stringify([
                { itemHrid: '/items/coin', count: 900 },
                { itemHrid: '/items/task_token', count: 1 },
            ]),
        });

        expect(tracker.ingest([rerolled])).toEqual([]);
        expect(tracker.entries).toEqual([]);

        // …and when the rerolled task is finished, it is recorded once, at the
        // value it was rerolled into
        const recorded = tracker.ingest([{ ...rerolled, status: '/quest_status/claimed', currentCount: 120 }]);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ tokens: 1, coins: 900, goalCount: 120 });
        expect(tracker.entries).toHaveLength(1);
    });

    test('the same claim delivered twice is one completion', () => {
        tracker.ingest([quest()]);
        tracker.ingest([claimed()]);
        const again = tracker.ingest([claimed()]);

        expect(again).toEqual([]);
        expect(tracker.entries).toHaveLength(1);
    });

    test('quests that are not random tasks are none of its business', () => {
        tracker.ingest([
            { ...claimed(), id: 7, category: '/quest_category/community' },
            { ...claimed(), id: 8, category: undefined },
        ]);

        expect(tracker.entries).toEqual([]);
    });

    test('a claim never seen in progress is still recorded', () => {
        // A tab opened after the task was already finished
        const recorded = tracker.ingest([claimed({ id: 55 })]);

        expect(recorded).toHaveLength(1);
        expect(recorded[0].tokens).toBe(4);
    });

    test('the board that arrives with the character is a baseline, not a payday', () => {
        // Were the initial board ever to carry an already-claimed task, reading
        // it as an event would book it again on every login
        const recorded = tracker.ingest([claimed({ id: 12 })], Date.now(), { record: false });

        expect(recorded).toEqual([]);
        expect(tracker.entries).toEqual([]);

        // …and the in-progress tasks in it are still the baseline the next real
        // claim is measured against
        tracker.ingest([quest({ id: 13 })], Date.now(), { record: false });
        expect(tracker.live.get(13)).toMatchObject({ tokens: 4 });
    });

    test('isReroll knows an unchanged task from a replaced one', () => {
        const before = questSnapshot(quest());

        expect(isReroll(before, questSnapshot(quest({ currentCount: 12 })))).toBe(false);
        expect(isReroll(before, questSnapshot(quest({ coinRerollCount: 1 })))).toBe(true);
        expect(isReroll(before, questSnapshot(quest({ cowbellRerollCount: 1 })))).toBe(true);
        expect(isReroll(before, questSnapshot(quest({ actionHrid: '/actions/foraging/egg' })))).toBe(true);
        expect(isReroll(before, questSnapshot(quest({ goalCount: 400 })))).toBe(true);
    });
});

describe('telling subscribers about a completion', () => {
    test('a subscriber is told the batch a claim was recorded in', () => {
        const seen = [];
        tracker.onCompletion((entries) => seen.push(entries));

        tracker.ingest([quest()]);
        tracker.ingest([claimed()], 1_700_000_000_000);

        expect(seen).toHaveLength(1);
        expect(seen[0]).toHaveLength(1);
        expect(seen[0][0]).toMatchObject({ questId: 101, tokens: 4 });
    });

    test('a discard notifies nobody — nothing was recorded', () => {
        const seen = [];
        tracker.onCompletion((entries) => seen.push(entries));

        tracker.ingest([quest()]);
        tracker.ingest([quest({ status: '/quest_status/discarded' })]);

        expect(seen).toHaveLength(0);
    });

    test('unsubscribing stops further notifications', () => {
        const seen = [];
        const unsubscribe = tracker.onCompletion((entries) => seen.push(entries));
        unsubscribe();

        tracker.ingest([quest()]);
        tracker.ingest([claimed()]);

        expect(seen).toHaveLength(0);
    });

    test('one subscriber throwing does not stop the others from being told', () => {
        const seen = [];
        tracker.onCompletion(() => {
            throw new Error('boom');
        });
        tracker.onCompletion((entries) => seen.push(entries));

        tracker.ingest([quest()]);
        tracker.ingest([claimed()]);

        expect(seen).toHaveLength(1);
    });
});

describe('what a task paid', () => {
    test('coins, tokens and anything else are kept apart', () => {
        expect(
            parseRewards(
                JSON.stringify([
                    { itemHrid: '/items/coin', count: 3787 },
                    { itemHrid: '/items/task_token', count: 4 },
                    { itemHrid: '/items/purples_gift', count: 1 },
                ])
            )
        ).toEqual({
            coins: 3787,
            tokens: 4,
            items: [{ itemHrid: '/items/purples_gift', count: 1 }],
        });
    });

    test('rewards that will not parse are reported, and the task is still recorded', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        const recorded = tracker.ingest([claimed({ itemRewardsJSON: 'not json' })]);

        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ tokens: 0, coins: 0 });
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    test('a claim stripped of its rewards falls back to the last board reading', () => {
        tracker.ingest([quest()]);
        const recorded = tracker.ingest([claimed({ itemRewardsJSON: '[]' })]);

        expect(recorded[0]).toMatchObject({ tokens: 4, coins: 3787, name: 'Cow' });
    });

    test('a combat task is named after its monster', () => {
        const snapshot = questSnapshot(
            quest({ type: '/quest_type/monster', actionHrid: '', monsterHrid: '/monsters/jungle_sprite' })
        );

        expect(snapshot).toMatchObject({ name: 'Jungle Sprite', category: 'combat' });
    });

    test('an unknown action is still named, from its hrid', () => {
        const snapshot = questSnapshot(quest({ actionHrid: '/actions/cheesesmithing/rainbow_hammer' }));

        expect(snapshot.name).toBe('rainbow hammer');
        expect(snapshot.category).toBe('cheesesmithing');
    });
});

describe('where the completions are kept', () => {
    // The window is measured against the clock, so a fixture dated last January
    // would be pruned before it was ever written. These tests run in the same
    // week their fixtures are dated.
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 15, 9)));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a week is one record, whatever the date inside it', () => {
        expect(weekChunkId(Date.UTC(2026, 0, 5))).toBe('2026-W02');
        expect(weekChunkId(Date.UTC(2026, 0, 11))).toBe('2026-W02');
        expect(weekChunkId(Date.UTC(2026, 0, 12))).toBe('2026-W03');
        // The week that straddles New Year belongs to whichever year owns its
        // Thursday, which is the whole reason for using ISO weeks
        expect(weekChunkId(Date.UTC(2027, 0, 1))).toBe('2026-W53');
    });

    test('a completion writes its own week and nothing else', async () => {
        const week1 = Date.UTC(2026, 0, 6, 12);
        const week2 = Date.UTC(2026, 0, 14, 12);

        tracker.ingest([claimed({ id: 1 })], week1);
        await tracker.flush();
        storageMock.set.mockClear();

        tracker.ingest([claimed({ id: 2 })], week2);
        await tracker.flush();

        const written = storageMock.set.mock.calls.map(([key]) => key);
        expect(written).toContain(`taskCompletionRec_cow1_${weekChunkId(week2)}`);
        expect(written).not.toContain(`taskCompletionRec_cow1_${weekChunkId(week1)}`);
    });

    test('what was written comes back, oldest first', async () => {
        tracker.ingest([claimed({ id: 1 })], Date.UTC(2026, 0, 6));
        tracker.ingest([claimed({ id: 2 })], Date.UTC(2026, 0, 14));
        await tracker.flush();

        tracker.forget();
        const loaded = await tracker.getCompletions();

        expect(loaded.map((completion) => completion.questId)).toEqual([1, 2]);
    });

    test('a week older than the window is dropped, and its record with it', async () => {
        const now = Date.now();
        const old = now - (WINDOW_WEEKS + 1) * 7 * DAY;
        const oldKey = `taskCompletionRec_cow1_${weekChunkId(old)}`;

        // A record from before the window, as a returning player's database
        // would have it
        storageMock.store.set(oldKey, [{ questId: 1, completedAt: old, tokens: 4, coins: 100 }]);

        tracker.ingest([claimed({ id: 2 })], now);
        await tracker.flush();

        expect(tracker.entries.map((completion) => completion.questId)).toEqual([2]);
        expect(storageMock.store.has(oldKey)).toBe(false);
        expect(storageMock.store.has(`taskCompletionRec_cow1_${weekChunkId(now)}`)).toBe(true);
    });

    test('a full disk keeps the completion in memory rather than losing it', async () => {
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        tracker.ingest([claimed({ id: 9 })]);
        await tracker.flush();

        expect(tracker.entries).toHaveLength(1);
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('another character is another history', async () => {
        tracker.ingest([claimed({ id: 1 })]);
        await tracker.flush();

        game.charId = 'cow2';
        tracker.forget();

        expect(await tracker.getCompletions()).toEqual([]);
    });

    test('pruning keeps the window and sorts what is left', () => {
        const now = Date.UTC(2026, 5, 1);
        const kept = pruneEntries([entry(now - 3 * DAY), entry(now - 400 * DAY), entry(now - DAY)], now);

        expect(kept).toHaveLength(2);
        expect(kept[0].completedAt).toBeLessThan(kept[1].completedAt);
    });

    describe('a character switch racing a slow read', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        test('a stale load for the departing character does not overwrite the arriving character in memory', async () => {
            let resolveCow1;
            const pendingCow1 = new Promise((resolve) => {
                resolveCow1 = resolve;
            });
            const realLoad = tracker._store.load.bind(tracker._store);
            vi.spyOn(tracker._store, 'load').mockImplementation((charId) =>
                charId === 'cow1' ? pendingCow1 : realLoad(charId)
            );

            // cow1's read is started and hangs — this is the await `load()` is
            // sitting behind when the character switches.
            const staleLoad = tracker.load();

            // character_switching: the departing character's state is dropped.
            tracker.forget();

            // cow2 logs in and claims a task before cow1's stale read lands.
            game.charId = 'cow2';
            tracker.ingest([claimed({ id: 42 })]);
            await tracker.flush();
            expect(tracker.entries.map((completion) => completion.questId)).toEqual([42]);

            // cow1's read finally resolves, carrying cow1's own history.
            resolveCow1([{ questId: 1, completedAt: Date.now() - HOUR, tokens: 4, coins: 100 }]);
            await staleLoad;

            // The stale resume must not have clobbered what is now in memory
            // for cow2 with cow1's completions.
            expect(tracker.entries.map((completion) => completion.questId)).toEqual([42]);
        });

        test('a stale load for the departing character does not get saved under the arriving character key', async () => {
            let resolveCow1;
            const pendingCow1 = new Promise((resolve) => {
                resolveCow1 = resolve;
            });
            const realLoad = tracker._store.load.bind(tracker._store);
            vi.spyOn(tracker._store, 'load').mockImplementation((charId) =>
                charId === 'cow1' ? pendingCow1 : realLoad(charId)
            );

            const staleLoad = tracker.load();
            tracker.forget();

            game.charId = 'cow2';
            tracker.ingest([claimed({ id: 42 })]);
            await tracker.flush();

            resolveCow1([{ questId: 1, completedAt: Date.now() - HOUR, tokens: 4, coins: 100 }]);
            await staleLoad;

            // A later completion for cow2 must not carry cow1's questId:1 into
            // cow2's own stored week — that would be cow1's history saved
            // under cow2's key.
            tracker.ingest([claimed({ id: 43 })]);
            await tracker.flush();

            const cow2Key = `taskCompletionRec_cow2_${weekChunkId(Date.now())}`;
            const stored = storageMock.store.get(cow2Key) || [];
            expect(stored.map((completion) => completion.questId)).not.toContain(1);
            expect(stored.map((completion) => completion.questId)).toEqual(expect.arrayContaining([42, 43]));
        });

        test("a switch mid-persist does not merge the departing character's pending completion into the arriving character", async () => {
            let resolveCow1;
            const pendingCow1 = new Promise((resolve) => {
                resolveCow1 = resolve;
            });
            const realLoad = tracker._store.load.bind(tracker._store);
            vi.spyOn(tracker._store, 'load').mockImplementation((charId) =>
                charId === 'cow1' ? pendingCow1 : realLoad(charId)
            );

            // cow1 completes a task. `_loaded` is false, so `_persist` takes the
            // first-read branch and its own internal `load()` is the one that
            // hangs on `pendingCow1`.
            tracker.ingest([claimed({ id: 1 })]);
            const cow1Persist = tracker._pending;

            // character_switching: cow1's state is dropped while that read is
            // still in flight.
            tracker.forget();

            // cow2 logs in and claims a task before cow1's stale read lands —
            // this goes through its own, unrelated `load()`/`_persist()` and
            // completes first.
            game.charId = 'cow2';
            tracker.ingest([claimed({ id: 42 })]);
            await tracker.flush();
            expect(tracker.entries.map((completion) => completion.questId)).toEqual([42]);

            // cow1's read finally lands, carrying nothing new (an empty store,
            // as a first-ever completion would find) — but this is the resume
            // that used to graft cow1's pending completion onto whatever
            // `this.entries` held by then.
            resolveCow1([]);
            await cow1Persist;

            // The arriving character's in-memory state must still be only its
            // own completion.
            expect(tracker.entries.map((completion) => completion.questId)).toEqual([42]);

            // And cow1's completion must not have been saved under cow2's key.
            const cow2Key = `taskCompletionRec_cow2_${weekChunkId(Date.now())}`;
            const cow2Stored = storageMock.store.get(cow2Key) || [];
            expect(cow2Stored.map((completion) => completion.questId)).toEqual([42]);
        });
    });
});

describe('the rate', () => {
    test('one completion is a timestamp, not a rate', () => {
        const rate = rateOver([entry(1000)]);

        expect(rate.completions).toBe(1);
        expect(rate.tokensPerHour).toBeNull();
        expect(rate.coinsPerHour).toBeNull();
    });

    test('no completions is no rate and no totals', () => {
        expect(rateOver([])).toMatchObject({ completions: 0, tokens: 0, tokensPerHour: null });
    });

    test('two claims an hour apart is the second one per hour', () => {
        const start = Date.UTC(2026, 0, 6, 8);
        const rate = rateOver([entry(start, 4, 1000), entry(start + HOUR, 6, 2000)]);

        // The first claim starts the clock; only what came after it is measured
        expect(rate.tokensPerHour).toBeCloseTo(6, 6);
        expect(rate.coinsPerHour).toBeCloseTo(2000, 6);
        expect(rate.tokens).toBe(10);
        expect(rate.coins).toBe(3000);
        expect(rate.basis).toBe('wall-clock');
    });

    test('three claims over two hours average out', () => {
        const start = Date.UTC(2026, 0, 6, 8);
        const rate = rateOver([entry(start, 4), entry(start + HOUR, 5), entry(start + 2 * HOUR, 3)]);

        expect(rate.tokensPerHour).toBeCloseTo(4, 6);
    });

    test('two claims in the same instant is no rate rather than an infinite one', () => {
        const rate = rateOver([entry(5000), entry(5000)]);

        expect(rate.tokensPerHour).toBeNull();
        expect(rate.spanMs).toBe(0);
    });

    test('today and the last seven days are counted separately', () => {
        const now = new Date(2026, 0, 15, 18, 0, 0).getTime();
        const todayStart = new Date(2026, 0, 15, 0, 0, 0).getTime();

        const rates = computeRates(
            [
                entry(now - 30 * DAY, 100),
                entry(now - 3 * DAY, 7),
                entry(todayStart + HOUR, 4),
                entry(todayStart + 3 * HOUR, 8),
            ],
            now
        );

        expect(rates.session.completions).toBe(2);
        expect(rates.session.tokensPerHour).toBeCloseTo(4, 6);
        expect(rates.week.completions).toBe(3);
        expect(rates.total.completions).toBe(4);
    });

    test('the tracker reports its rates without touching storage', () => {
        tracker.entries = [entry(Date.UTC(2026, 0, 6, 8)), entry(Date.UTC(2026, 0, 6, 10))];
        storageMock.get.mockClear();

        const rates = tracker.rates(Date.UTC(2026, 0, 6, 12));

        expect(rates.week.completions).toBe(2);
        expect(storageMock.get).not.toHaveBeenCalled();
    });
});
