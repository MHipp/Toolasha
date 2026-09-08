/**
 * The tracker's websocket handlers: a run that is already going when the
 * script comes up (a page load mid-run) must still get a session — the
 * count-1 attempt was never seen, and nothing flagged a pending start.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    handlers: {},
    current: null,
    calls: [],
    actions: [],
}));

const trackerMock = vi.hoisted(() => {
    const mock = {
        isInitialized: true,
        pendingSessionStart: false,
        getCurrentSession: () => state.current,
        findExtendableSession: () => null,
        startSession: vi.fn(async (itemHrid, startLevel, targetLevel, protectFrom) => {
            state.calls.push(['start', itemHrid, startLevel, targetLevel, protectFrom]);
            state.current = { id: 's1', itemHrid, startLevel, targetLevel, protectFrom, totalXP: 0, lastAttempt: null };
            return 's1';
        }),
        recordSuccess: vi.fn(async (...a) => state.calls.push(['success', ...a])),
        recordFailure: vi.fn(async (...a) => state.calls.push(['failure', ...a])),
        trackCoinCost: async () => {},
        trackMaterialCost: async () => {},
        trackProtectionCost: vi.fn(async (...a) => state.calls.push(['prot', ...a])),
        finalizeCurrentSession: vi.fn(async () => {
            state.calls.push(['finalize']);
            state.current = null;
        }),
        // Mirrors the real tracker: arms the same flag the handler itself checks/clears, so a
        // bootstrapped pending start actually drives the next action_completed in tests.
        setPendingStart: vi.fn(() => {
            state.calls.push(['pendingStart']);
            mock.pendingSessionStart = true;
        }),
    };
    return mock;
});

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            state.handlers[type] = fn;
        },
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/enchanted_cloak_refined': { name: 'Enchanted Cloak ★', enhancementCosts: [] },
            },
        }),
        getCurrentActions: () => state.actions,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('./enhancement-xp.js', () => ({
    calculateSuccessXP: () => 0,
    calculateFailureXP: () => 0,
    calculateAdjustedAttemptCount: () => 1,
}));
vi.mock('./tooltip-enhancement.js', () => ({ getEnhancementMaterialPrice: () => 0 }));
vi.mock('./enhancement-ui.js', () => ({ default: { switchToSession: () => {}, scheduleUpdate: () => {} } }));
vi.mock('./enhancement-tracker.js', () => ({ default: trackerMock }));

const { setupEnhancementHandlers } = await import('./enhancement-handlers.js');

const cachedEnhanceAction = (extra = {}) => ({
    actionHrid: '/actions/enhancing/enhance',
    isDone: false,
    ordinal: 3,
    currentCount: 2070,
    primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::5',
    enhancingMaxLevel: 15,
    enhancingProtectionMinLevel: 2,
    ...extra,
});

const attempt = (level, currentCount) => ({
    endCharacterAction: {
        actionHrid: '/actions/enhancing/enhance',
        currentCount,
        primaryItemHash: `30404::/item_locations/inventory::/items/enchanted_cloak_refined::${level}`,
        secondaryItemHash: '30404::/item_locations/inventory::/items/mirror_of_protection::0',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 2,
    },
});

beforeEach(() => {
    state.handlers = {};
    state.current = null;
    state.calls = [];
    state.actions = [];
    trackerMock.pendingSessionStart = false;
    setupEnhancementHandlers();
});

describe('a run already going when the script comes up', () => {
    test('gets a session from the attempt in hand, and records from the next one on', async () => {
        // Count 78 with no session and no pending start: the page loaded mid-run
        await state.handlers.action_completed(attempt(5, 78));
        // Started, and not charged a protection: level 5 → 5 on the first attempt is
        // only the baseline, not a protected failure
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 5, 15, 2]]);

        // The next attempt has a baseline and is recorded
        await state.handlers.action_completed(attempt(6, 79));
        expect(state.calls.at(-1)).toEqual(['success', 5, 6, false]);
    });

    test('below the protection threshold, the inferred start level is one below the result — matching the other two "first observed attempt" paths', async () => {
        // Picked up mid-run at a low level: the result (1) is below the +2
        // protection threshold, so it can only have come from a level-0 success.
        // The other two paths that create a session from a bare result (a fresh
        // rawCount === 1 attempt, and a pendingSessionStart) already make this
        // inference; this is the third one, "mid-run pickup" via
        // findExtendableSession returning null, doing the same thing.
        await state.handlers.action_completed(attempt(1, 42));
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 0, 15, 2]]);
    });
});

describe('the run ending in the queue', () => {
    const enhanceRow = (extra = {}) => ({
        actionHrid: '/actions/enhancing/enhance',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 2,
        ...extra,
    });

    test('an isDone row — cancelled, finished, or out of materials — finalizes the session', async () => {
        state.current = { id: 's1', targetLevel: 15, protectFrom: 2 };
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ isDone: true })] });

        expect(state.calls).toContainEqual(['finalize']);
        expect(state.calls).not.toContainEqual(['pendingStart']);
    });

    test('an isDone row with no session does nothing', async () => {
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ isDone: true })] });

        expect(state.calls).toEqual([]);
    });

    test('an ended run alongside the next queued one is a start, not a stop', async () => {
        state.current = { id: 's1', targetLevel: 15, protectFrom: 2 };
        await state.handlers['actions_updated']({
            endCharacterActions: [enhanceRow({ isDone: true }), enhanceRow({ isDone: false })],
        });

        expect(state.calls).not.toContainEqual(['finalize']);
        expect(state.calls).toContainEqual(['pendingStart']);
    });
});

describe('two attempts landing before the first has finished writing', () => {
    // websocket.js calls handlers fire-and-forget — it never awaits the promise
    // an async handler returns — so a second action_completed starts running
    // while the first is still suspended on its cost writes. The level the
    // attempt started from and the level it ended at have to be claimed in one
    // synchronous step, or the second handler reads the first handler's
    // pre-attempt level as its own baseline.
    test('each attempt is scored against the level it actually started from', async () => {
        // Baseline: a mid-run pickup, so lastAttempt is level 5
        await state.handlers.action_completed(attempt(5, 78));
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 5, 15, 2]]);

        // A protected failure (5 → 5) and the success after it (5 → 6),
        // dispatched back to back the way the socket does. The failure buys a
        // protection, which is one more write to suspend on than the success has.
        const failure = state.handlers.action_completed(attempt(5, 79));
        const success = state.handlers.action_completed(attempt(6, 80));
        await Promise.all([failure, success]);

        // The next attempt has to see level 6, not the level the slower handler
        // finished writing afterwards
        await state.handlers.action_completed(attempt(7, 81));

        // Order is not asserted: the failure buys a protection first, so it
        // finishes writing after the success it preceded. What each attempt was
        // scored against is the thing that has to survive the interleaving.
        const results = state.calls.filter(([kind]) => kind === 'success' || kind === 'failure');
        expect(results).toHaveLength(3);
        expect(results).toContainEqual(['failure', 5, 5]);
        expect(results).toContainEqual(['success', 5, 6, false]);
        expect(results).toContainEqual(['success', 6, 7, false]);
        // The failure mode this guards: 6 → 7 scored from a stale level 5,
        // reported as a Blessed double jump that never happened
        expect(results).not.toContainEqual(['success', 5, 7, true]);
    });
});

describe('TLA-043: bootstrap from an already-cached current action', () => {
    // Before this fix, setupEnhancementHandlers() only ever installed the action_completed and
    // actions_updated listeners — it never looked at what DataManager already had cached. A
    // setting enabled, or a page reload, after the queue's own actions_updated had already fired
    // left pendingSessionStart false with nothing left to set it, other than the mid-run pickup
    // fallback in handleEnhancementResult reacting to the very next action_completed. This test
    // asserts the bootstrap fires synchronously at subscribe time, with no WebSocket message at
    // all — something pre-fix code cannot do, since it never reads getCurrentActions().
    test('an active cached Enhance action arms pendingSessionStart immediately, before any message', () => {
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();

        expect(state.calls).toContainEqual(['pendingStart']);
        expect(trackerMock.pendingSessionStart).toBe(true);
    });

    test('the very next action_completed after that immediately produces a session', async () => {
        state.actions = [cachedEnhanceAction()];
        setupEnhancementHandlers();

        await state.handlers.action_completed(attempt(6, 2071));

        const session = state.current;
        expect(session).toBeTruthy();
        expect(session.itemHrid).toBe('/items/enchanted_cloak_refined');
    });

    test('a requeued repeat sitting first in the array with a higher ordinal is not read as the running action', () => {
        // Both entries are Enhance rows, so array position ([0]) would pick the ordinal-9 one —
        // the repeat requeued to the front of the queue — and read its level (8) as "current".
        // The real running action is the ordinal-2 one, sitting second, at level 5. Feeding
        // findExtendableSession the wrong (position-read) level would miss the extendable
        // session the correct (ordinal-read) level finds, letting the bootstrap wrongly fire.
        trackerMock.findExtendableSession = vi.fn((itemHrid, level) => level === 5);
        state.actions = [
            cachedEnhanceAction({
                ordinal: 9,
                primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::8',
            }),
            cachedEnhanceAction({ ordinal: 2 }), // level 5, from the shared fixture
        ];

        setupEnhancementHandlers();

        expect(trackerMock.findExtendableSession).toHaveBeenCalledWith('/items/enchanted_cloak_refined', 5);
        expect(state.calls).not.toContainEqual(['pendingStart']);
        trackerMock.findExtendableSession = () => null;
    });

    test('a non-enhancing cached action does not arm the bootstrap', () => {
        state.actions = [{ actionHrid: '/actions/milking/milk', isDone: false, ordinal: 1, currentCount: 40 }];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
        expect(trackerMock.pendingSessionStart).toBe(false);
    });

    test('an already-active session is left alone — bootstrap never resets or duplicates it', () => {
        state.current = { id: 's1', itemHrid: '/items/enchanted_cloak_refined', totalXP: 0, lastAttempt: null };
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
    });

    test('a finished (isDone) cached row does not arm the bootstrap', () => {
        state.actions = [cachedEnhanceAction({ isDone: true })];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
    });

    test('an extendable completed session for the same item/level is extended instead of shadowed', () => {
        // Same guard enhancement-tracker.js's disable() documents for a character switch: forcing
        // shouldStartNew via pendingSessionStart would skip findExtendableSession entirely and
        // fragment a session that should have been picked back up.
        trackerMock.findExtendableSession = vi.fn((itemHrid, level) => {
            expect(itemHrid).toBe('/items/enchanted_cloak_refined');
            expect(level).toBe(5);
            return 'old_session';
        });
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
        trackerMock.findExtendableSession = () => null;
    });

    test('the setting disabled skips the bootstrap entirely', async () => {
        state.actions = [cachedEnhanceAction()];
        const configModule = await import('../../core/config.js');
        configModule.default.getSetting = () => false;

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
        configModule.default.getSetting = () => true;
    });
});
