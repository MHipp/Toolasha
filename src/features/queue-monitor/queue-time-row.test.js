/** @vitest-environment happy-dom */

/**
 * The Queue Time Left tile.
 *
 * The arithmetic is one line and `action-calculator` is mocked to a flat answer,
 * because what is worth pinning down here is not the multiplication — it is the
 * three shapes of queue the tile has to tell apart. A queue of counted actions
 * has a time. A queue whose running action has no count has no time at all, and
 * must not read as a zero. And a counted action *in front of* an unbounded one
 * has a time, which is time until the queue stops changing rather than time
 * until it empties.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    actions: [],
    skills: [{ skillHrid: '/skills/milking', level: 50 }],
    clientData: { itemDetailMap: {} },
    stats: { actionTime: 10, totalEfficiency: 0 },
    elapsedSecondsInCurrentUnit: () => 0,
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getSkills: () => game.skills,
        getInitClientData: () => game.clientData,
        getEquipment: () => new Map(),
        getActionDetails: (hrid) => (hrid ? { name: hrid, type: '/action_types/milking' } : null),
        getElapsedSecondsInCurrentUnit: (...args) => game.elapsedSecondsInCurrentUnit(...args),
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => game.stats,
}));

vi.mock('../../utils/efficiency.js', () => ({
    calculateEfficiencyMultiplier: (percent) => 1 + percent / 100,
}));

const { queueTimeLeft } = await import('./queue-time-row.js');

/**
 * A counted action.
 * @param {number} maxCount - How many were queued
 * @param {number} currentCount - How many are done
 * @returns {Object} A queued action
 */
function counted(maxCount, currentCount = 0, ordinal = 0) {
    return {
        id: `action-${ordinal}`,
        actionHrid: '/actions/milking/cow',
        hasMaxCount: true,
        maxCount,
        currentCount,
        isDone: false,
        ordinal,
    };
}

/** An action with no count on it. @returns {Object} */
function unbounded(ordinal = 0) {
    return { id: `action-${ordinal}`, actionHrid: '/actions/milking/cow', hasMaxCount: false, isDone: false, ordinal };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.queueTimeLeft.render(container);
    return container;
}

describe('the queue time tile', () => {
    beforeEach(() => {
        game.actions = [];
        game.skills = [{ skillHrid: '/skills/milking', level: 50 }];
        game.clientData = { itemDetailMap: {} };
        game.stats = { actionTime: 10, totalEfficiency: 0 };
        game.elapsedSecondsInCurrentUnit = () => 0;
    });

    test('registers, off by default', () => {
        expect(game.rows.queueTimeLeft).toBeDefined();
        expect(game.rows.queueTimeLeft.defaultVisible).toBe(false);
    });

    test('is a summary with nothing behind it — the monitor panel is about other characters', () => {
        expect(typeof game.rows.queueTimeLeft.onOpen).not.toBe('function');
    });

    test('an empty queue draws nothing at all', () => {
        expect(draw().textContent).toBe('');
    });

    test('a queue the game has not loaded yet draws nothing', () => {
        game.clientData = null;
        game.actions = [counted(100)];

        expect(queueTimeLeft()).toBeNull();
        expect(draw().textContent).toBe('');
    });

    test('counted actions add up to a duration', () => {
        // 100 left at 10s each, and 50 more at 10s each: 1500s, or 25 minutes
        game.actions = [counted(100), counted(100, 50)];

        const left = queueTimeLeft();
        expect(left.seconds).toBe(1500);
        expect(left.finite).toBe(2);
        expect(draw().textContent).toContain('25m');
    });

    test('efficiency shortens the queue', () => {
        game.stats = { actionTime: 10, totalEfficiency: 100 };
        game.actions = [counted(100)];

        expect(queueTimeLeft().seconds).toBe(500);
    });

    test('a remaining count that does not divide evenly still rounds up to a whole action', () => {
        // 50% efficiency -> effectiveRate 1.5. 10 remaining / 1.5 = 6.667 actions,
        // which is 7 whole actions at 10s — not 66.67s of a 7th action nobody can
        // partially run. queue-snapshot.js (the other-character estimate) already
        // rounds up for this reason; the live tile must agree with it.
        game.stats = { actionTime: 10, totalEfficiency: 50 };
        game.actions = [counted(10)];

        expect(queueTimeLeft().seconds).toBe(70);
    });

    test('finished actions are not queued work', () => {
        game.actions = [{ ...counted(100), isDone: true }, counted(10)];

        const left = queueTimeLeft();
        expect(left.queued).toBe(1);
        expect(left.seconds).toBe(100);
    });

    test('an unbounded action alone reads as ∞, never as a zero', () => {
        game.actions = [unbounded()];

        const left = queueTimeLeft();
        expect(left.infinite).toBe(true);
        expect(left.seconds).toBe(0);

        const container = draw();
        expect(container.textContent).toContain('∞');
        expect(container.textContent).not.toContain('0s');
        expect(container.title).toContain('never empties');
    });

    test('a counted action ahead of an unbounded one still has a time, and says what it is', () => {
        game.actions = [counted(60), unbounded()];

        const container = draw();
        expect(container.textContent).toContain('10m');
        expect(container.title).toContain('no count is queued');
    });

    test('the running action subtracts time already spent on its current unit', () => {
        // 100 remaining at 10s each is 1000s undiscounted; 4s already burned on the
        // in-progress unit brings it to 996s. Charging the full 10s here is the tile
        // reporting time that has already elapsed as still ahead of the player.
        game.actions = [counted(100, 0, 0)];
        game.elapsedSecondsInCurrentUnit = (actionId, currentCount) =>
            actionId === 'action-0' && currentCount === 0 ? 4 : 0;

        expect(queueTimeLeft().seconds).toBe(996);
    });

    test('only the running action is discounted — a requeued repeat at array position 0 is not it', () => {
        // Execution order is ascending ordinal, not array position. A repeating action
        // requeued after finishing a cycle sits at the *front* of the array but carries a
        // *higher* ordinal, so it is actually queued behind the lower-ordinal entry later
        // in the array — which is the one really running and the one that should be
        // discounted for time already spent.
        const requeuedRepeat = counted(100, 0, 1); // array position 0, ordinal 1 — not running
        const actuallyRunning = counted(50, 0, 0); // array position 1, ordinal 0 — running
        game.actions = [requeuedRepeat, actuallyRunning];
        game.elapsedSecondsInCurrentUnit = (actionId, currentCount) =>
            actionId === 'action-0' && currentCount === 0 ? 4 : 0;

        // requeuedRepeat: 1000, untouched since it is not the running action.
        // actuallyRunning: 500 - 4 = 496.
        expect(queueTimeLeft().seconds).toBe(1496);
    });

    test('an elapsed reading past the action time never drives the total negative', () => {
        game.actions = [counted(1, 0, 0)];
        game.elapsedSecondsInCurrentUnit = () => 999; // implausible, but must still clamp at 0

        expect(queueTimeLeft().seconds).toBe(0);
    });
});
