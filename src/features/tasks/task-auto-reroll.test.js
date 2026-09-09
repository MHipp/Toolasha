/** @vitest-environment happy-dom */

/**
 * Tests for the Task Auto-Reroll Reminder's decision rule.
 *
 * The badge used to mean nothing more than "this hrid is on a list". The rule
 * covered here is what makes it a decision: a task is only worth rerolling when
 * it trails the board by more than the reroll costs, priced over the hours the
 * task would otherwise occupy. Getting that comparison wrong in either
 * direction costs real coins — badging good tasks, or staying quiet on bad ones.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

/** Who is logged in, and whether the feature's own setting is on */
const world = vi.hoisted(() => ({ charId: 'test', enabled: false }));
/** The settings store the two per-character lists live in: key -> array */
const db = vi.hoisted(() => ({ map: new Map(), hold: null, transactions: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => world.enabled, getSettingValue: (_k, d) => d },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback = []) => {
            db.transactions.push([key]);
            // A read left open, so a test can land a character switch inside one
            if (db.hold) await db.hold;
            return db.map.has(key) ? db.map.get(key) : fallback;
        },
        getMany: async (keys) => {
            // One entry however many keys it carries: that is what a batched
            // read buys, and what a test counting transactions is looking at
            db.transactions.push([...keys]);
            if (db.hold) await db.hold;
            return new Map(keys.map((key) => [key, db.map.has(key) ? db.map.get(key) : null]));
        },
        parseJSON: (raw, _key, fallback = null) => (raw === null ? fallback : raw),
        setJSON: async (key, value) => {
            db.map.set(key, value);
            return true;
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => world.charId } }));
vi.mock('./task-profit-calculator.js', () => ({ calculateTaskTokenValue: () => ({ tokenValue: 2000 }) }));
vi.mock('./task-profit-display.js', () => ({ readVisibleTaskRatings: () => ({}) }));

const { nextRerollCostInRatingUnits, ratesBelowBoard } = await import('./task-auto-reroll.js');
const { taskAutoReroll } = await import('./task-auto-reroll.js');

describe('nextRerollCostInRatingUnits', () => {
    test('doubles with each coin reroll already spent, up to the cap', () => {
        expect(nextRerollCostInRatingUnits(0, 'gold', null)).toBe(10000);
        expect(nextRerollCostInRatingUnits(3, 'gold', null)).toBe(80000);
        expect(nextRerollCostInRatingUnits(5, 'gold', null)).toBe(320000);
        expect(nextRerollCostInRatingUnits(12, 'gold', null)).toBe(320000);
    });

    test('restates the cost in tokens when the board is rated in tokens', () => {
        expect(nextRerollCostInRatingUnits(0, 'tokens', 2000)).toBe(5);
    });

    test('gives up rather than guess when a token has no price', () => {
        expect(nextRerollCostInRatingUnits(0, 'tokens', 0)).toBe(null);
        expect(nextRerollCostInRatingUnits(0, 'tokens', null)).toBe(null);
    });
});

describe('ratesBelowBoard', () => {
    // A 2-hour task on a board whose median is 100K/hr: a 10K reroll spread
    // over those hours is 5K/hr, so the task has to trail 95K/hr to be worth it
    const twoHourTask = (value) => ({ value, hours: 2 });

    test('badges a task that trails the board by more than the reroll costs', () => {
        expect(ratesBelowBoard(twoHourTask(90000), 100000, 10000)).toBe(true);
    });

    test('leaves a task alone when the reroll costs more than the gap', () => {
        expect(ratesBelowBoard(twoHourTask(96000), 100000, 10000)).toBe(false);
    });

    test('leaves the board median itself alone', () => {
        expect(ratesBelowBoard(twoHourTask(100000), 100000, 10000)).toBe(false);
    });

    test('a dearer reroll makes the rule stricter', () => {
        // Same task, but this card has been rerolled up to 320K already
        expect(ratesBelowBoard(twoHourTask(90000), 100000, 320000)).toBe(false);
    });

    test('a nearly-finished bad task is still flagged, since the basis is the whole task', () => {
        // 4h task, 90% done. Both sides are the whole task's: a 10K reroll over
        // 4h is 2.5K/hr, and the card trails the 100K/hr median by 10K/hr.
        // Amortising over the 0.4h remaining made the cost 25K/hr and the rule
        // unable to fire on exactly the tasks worth rerolling.
        expect(ratesBelowBoard({ value: 90000, hours: 4 }, 100000, 10000)).toBe(true);
    });

    test('stays quiet without a board, a rating time, or a priced reroll', () => {
        expect(ratesBelowBoard(twoHourTask(1), null, 10000)).toBe(false);
        expect(ratesBelowBoard({ value: 1, hours: null }, 100000, 10000)).toBe(false);
        expect(ratesBelowBoard(undefined, 100000, 10000)).toBe(false);
        expect(ratesBelowBoard(twoHourTask(1), 100000, null)).toBe(false);
    });

    test('a short task is judged more harshly — the reroll amortises over less time', () => {
        const gap = { value: 90000, hours: 0.1 };
        // 10K spread over 6 minutes is 100K/hr, far more than the 10K/hr gap
        expect(ratesBelowBoard(gap, 100000, 10000)).toBe(false);
    });
});

describe('the per-character lists across a switch', () => {
    beforeEach(() => {
        world.charId = 'market';
        world.enabled = true;
        db.map.clear();
        db.hold = null;
        db.transactions = [];
        taskAutoReroll.disable();
    });

    test('an init still in flight does not hand its blacklist to the arriving character', async () => {
        db.map.set('taskAutoRerollHrids_market', ['/monsters/imp']);
        db.map.set('taskAutoRerollHrids_iron', ['/monsters/rat']);

        let release;
        db.hold = new Promise((resolve) => {
            release = resolve;
        });
        const marketInit = taskAutoReroll.initialize();

        // The switch: the feature layer is torn down and brought back up for
        // the arriving character, whose own read lands first
        taskAutoReroll.disable();
        world.charId = 'iron';
        db.hold = null;
        await taskAutoReroll.initialize();
        release();
        await marketInit;

        expect([...taskAutoReroll.autoRerollHrids]).toEqual(['/monsters/rat']);

        // and the toggle that follows writes the arriving character's list,
        // under the arriving character's key
        await taskAutoReroll.toggleHrid('/monsters/cow');
        expect(db.map.get('taskAutoRerollHrids_iron')).toEqual(['/monsters/rat', '/monsters/cow']);
        expect(db.map.get('taskAutoRerollHrids_market')).toEqual(['/monsters/imp']);
    });

    test('a teardown drops the lists, so nothing is badged off the departing character’s', async () => {
        db.map.set('taskAutoRerollHrids_market', ['/monsters/imp']);
        db.map.set('taskProtectedHrids_market', ['/monsters/goblin']);
        await taskAutoReroll.initialize();
        expect(taskAutoReroll.autoRerollHrids.size).toBe(1);

        taskAutoReroll.disable();

        expect(taskAutoReroll.autoRerollHrids.size).toBe(0);
        expect(taskAutoReroll.protectedHrids.size).toBe(0);
    });

    test('a save is refused outright when the list in memory is not this character’s', async () => {
        db.map.set('taskAutoRerollHrids_market', ['/monsters/imp']);
        db.map.set('taskAutoRerollHrids_iron', ['/monsters/rat']);
        await taskAutoReroll.initialize();

        // No teardown at all — the pointer simply moved
        world.charId = 'iron';
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await taskAutoReroll.toggleHrid('/monsters/cow');
        } finally {
            warned.mockRestore();
        }

        expect(db.map.get('taskAutoRerollHrids_iron')).toEqual(['/monsters/rat']);
    });
});

/**
 * Start-up runs a dozen features' initializers at once, so every transaction
 * one of them opens waits behind all of theirs. Both lists live in the same
 * store and were read one after the other.
 */
describe('what start-up costs the settings store', () => {
    beforeEach(() => {
        world.charId = 'market';
        world.enabled = true;
        db.map.clear();
        db.hold = null;
        db.transactions = [];
        taskAutoReroll.disable();
    });

    test('both lists come out of one transaction, with the same values', async () => {
        db.map.set('taskAutoRerollHrids_market', ['/monsters/imp']);
        db.map.set('taskProtectedHrids_market', ['/monsters/cow']);

        await taskAutoReroll.initialize();

        expect(db.transactions).toHaveLength(1);
        expect(db.transactions[0]).toEqual(['taskAutoRerollHrids_market', 'taskProtectedHrids_market']);
        expect([...taskAutoReroll.autoRerollHrids]).toEqual(['/monsters/imp']);
        expect([...taskAutoReroll.protectedHrids]).toEqual(['/monsters/cow']);
    });

    test('a character with neither list stored gets two empty ones', async () => {
        await taskAutoReroll.initialize();

        expect(taskAutoReroll.autoRerollHrids.size).toBe(0);
        expect(taskAutoReroll.protectedHrids.size).toBe(0);
    });
});
