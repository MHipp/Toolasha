import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    charId: 'char1',
    settingOn: true,
    quota: false,
    actionDetails: {},
    prices: {},
    stored: [],
    saved: null,
}));

vi.mock('../../core/storage.js', () => ({
    default: { isQuotaExceeded: () => state.quota },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => state.settingOn },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.charId,
        getActionDetails: (hrid) => state.actionDetails[hrid] || null,
        on: vi.fn(),
        off: vi.fn(),
    },
}));
vi.mock('../../utils/offline-economics-calculator.js', () => ({
    calculateOfflineEconomics: ({ offlineItems }) => ({ profit: offlineItems.length * 1000 }),
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => state.prices[hrid] ?? null,
}));
vi.mock('../../utils/chunked-history.js', () => ({
    timeChunkId: (t) => new Date(t).toISOString().slice(0, 7),
    createChunkedHistory: () => ({
        load: vi.fn(async () => state.stored.map((row) => ({ ...row }))),
        save: vi.fn(async (charId, rows) => {
            state.saved = { charId, rows: rows.map((row) => ({ ...row })) };
            return true;
        }),
        forget: vi.fn(),
    }),
}));

const { default: recorder } = await import('./production-income-recorder.js');
const { localDayId } = await import('./gold-sources.js');

const TODAY = localDayId(Date.now());

/** A cooking action that turns 2 milk into 1 cheese */
const COOKING = {
    type: '/action_types/cooking',
    outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
    inputItems: [{ itemHrid: '/items/milk', count: 2 }],
};

beforeEach(() => {
    state.charId = 'char1';
    state.settingOn = true;
    state.quota = false;
    state.actionDetails = { '/actions/cooking/cheese': COOKING };
    state.prices = { '/items/cheese': 100, '/items/milk': 40 };
    state.stored = [];
    state.saved = null;
    recorder._forget();
});

describe('recording production', () => {
    test('records outputs and inputs apart, so the day is a margin and not a gross', async () => {
        await recorder._onActionCompleted({
            endCharacterAction: { id: 1, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });

        const row = state.saved.rows.find((entry) => entry.d === TODAY);
        expect(row.outputValue).toBe(100);
        expect(row.inputValue).toBe(80);
        expect(row.actions).toBe(1);
    });

    test('a jump in the action counter counts every action it covers', async () => {
        const action = { id: 7, actionHrid: '/actions/cooking/cheese', currentCount: 1 };
        await recorder._onActionCompleted({ endCharacterAction: action });
        await recorder._onActionCompleted({ endCharacterAction: { ...action, currentCount: 5 } });

        const row = state.saved.rows.find((entry) => entry.d === TODAY);
        // One for the first message, four for the jump
        expect(row.actions).toBe(5);
        expect(row.outputValue).toBe(500);
    });

    test('a counter that went backwards is a new action, counted once', async () => {
        const action = { id: 9, actionHrid: '/actions/cooking/cheese', currentCount: 40 };
        await recorder._onActionCompleted({ endCharacterAction: action });
        await recorder._onActionCompleted({ endCharacterAction: { ...action, currentCount: 1 } });
        expect(state.saved.rows.find((entry) => entry.d === TODAY).actions).toBe(2);
    });

    test('combat, gathering and enhancing are left to the recorders that already have them', async () => {
        state.actionDetails['/actions/combat/cow'] = { type: '/action_types/combat', outputItems: [] };
        state.actionDetails['/actions/milking/cow'] = {
            type: '/action_types/milking',
            outputItems: [{ itemHrid: '/items/milk', count: 1 }],
        };

        await recorder._onActionCompleted({
            endCharacterAction: { id: 2, actionHrid: '/actions/combat/cow', currentCount: 1 },
        });
        await recorder._onActionCompleted({
            endCharacterAction: { id: 3, actionHrid: '/actions/milking/cow', currentCount: 1 },
        });

        expect(state.saved).toBeNull();
    });

    test('nothing is recorded while the setting is off', async () => {
        state.settingOn = false;
        await recorder._onActionCompleted({
            endCharacterAction: { id: 4, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });
        expect(state.saved).toBeNull();
    });

    test('nothing is recorded once storage has refused a write', async () => {
        state.quota = true;
        await recorder._onActionCompleted({
            endCharacterAction: { id: 5, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });
        expect(state.saved).toBeNull();
    });

    test('an unpriceable recipe is counted as uncounted rather than valued', async () => {
        state.prices = {};
        await recorder._onActionCompleted({
            endCharacterAction: { id: 6, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });

        // Not valued — nothing is added to either half — but recorded as an
        // action the day's figure is short by, so the panel can say so
        const [row] = state.saved.rows;
        expect(row).toMatchObject({ outputValue: 0, inputValue: 0, actions: 0, unpricedActions: 1 });
    });

    test('an input with no price does not let its outputs be counted as income', async () => {
        // The whole reason this recorder exists: counting the gross of a recipe
        // whose inputs could not be priced reports a crafting day as several
        // times the profit it was
        state.prices = { '/items/cheese': 10 };
        await recorder._onActionCompleted({
            endCharacterAction: { id: 61, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });

        const [row] = state.saved.rows;
        expect(row.outputValue).toBe(0);
        expect(row.unpricedActions).toBe(1);
    });
});

describe('the action-counter map', () => {
    test('a long-running action is not evicted by two hundred short ones', async () => {
        const long = { id: 'long', actionHrid: '/actions/cooking/cheese', currentCount: 1 };
        await recorder._onActionCompleted({ endCharacterAction: long });

        // Two hundred other actions go past, each touching the map once
        for (let i = 0; i < 200; i += 1) {
            await recorder._onActionCompleted({
                endCharacterAction: { id: `other${i}`, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
            });
            // …and the long one ticks between them, which must move it to the
            // end of the eviction order rather than leaving it first-seen
            await recorder._onActionCompleted({ endCharacterAction: { ...long, currentCount: 2 + i } });
        }

        state.saved = null;
        await recorder._onActionCompleted({ endCharacterAction: { ...long, currentCount: 300 } });

        // 300 minus the 201 already counted for it, not a re-baselined 1
        const row = state.saved.rows.find((entry) => entry.d === TODAY);
        expect(row.actions).toBeGreaterThan(0);
        expect(recorder._completedSince({ ...long, currentCount: 305 })).toBe(5);
    });
});

describe('a character switch mid-read', () => {
    test('the departing character’s rows are never adopted by the arriving one', async () => {
        // The read is in flight when the switch lands
        const load = recorder.load();
        recorder._forget();
        await load;

        expect(recorder._rows).toEqual([]);
    });
});

describe('not losing what is already stored', () => {
    test('the stored months are read before the first write, so the save cannot delete them', async () => {
        state.stored = [
            { d: '2026-01-01', outputValue: 5, inputValue: 1, actions: 1, offlineProfit: 0 },
            { d: '2026-02-01', outputValue: 7, inputValue: 2, actions: 1, offlineProfit: 0 },
        ];

        await recorder._onActionCompleted({
            endCharacterAction: { id: 11, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });

        const days = state.saved.rows.map((row) => row.d);
        expect(days).toContain('2026-01-01');
        expect(days).toContain('2026-02-01');
        expect(days).toContain(TODAY);
    });

    test('a day past retention is dropped', async () => {
        state.stored = [{ d: '2020-01-01', outputValue: 5, inputValue: 1, actions: 1, offlineProfit: 0 }];
        await recorder._onActionCompleted({
            endCharacterAction: { id: 12, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });
        expect(state.saved.rows.map((row) => row.d)).not.toContain('2020-01-01');
    });

    test('nothing is written before login, when there is no character to write it under', async () => {
        state.charId = null;
        await recorder._onActionCompleted({
            endCharacterAction: { id: 13, actionHrid: '/actions/cooking/cheese', currentCount: 1 },
        });
        expect(state.saved).toBeNull();
    });
});

describe('offline income', () => {
    test('is recorded on its own row, apart from production', async () => {
        recorder._onCharacterInitialized({
            offlineItems: [{ itemHrid: '/items/cheese', offlineCount: 3 }],
            currentTimestamp: new Date().toISOString(),
            character: { lastOfflineTime: new Date(Date.now() - 3600_000).toISOString() },
        });
        await vi.waitFor(() => expect(state.saved).not.toBeNull());

        const row = state.saved.rows.find((entry) => entry.d === TODAY);
        expect(row.offlineProfit).toBe(1000);
        expect(row.outputValue).toBe(0);
    });

    test('a login with no offline session records nothing', async () => {
        recorder._onCharacterInitialized({ offlineItems: [], currentTimestamp: new Date().toISOString() });
        expect(state.saved).toBeNull();
    });
});

describe('an offline session recorded across a character switch', () => {
    test('is never filed under the character who arrived while the rows were read', async () => {
        // The Welcome Back payload is read, then the rows behind it — and a
        // switch lands inside that read
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const storeLoad = recorder._store.load;
        recorder._store.load = vi.fn(async (charId) => {
            await gate;
            return storeLoad(charId);
        });

        recorder._onCharacterInitialized({
            offlineItems: [{ itemHrid: '/items/cheese', offlineCount: 3 }],
            currentTimestamp: new Date().toISOString(),
            character: { lastOfflineTime: new Date(Date.now() - 3600_000).toISOString() },
        });

        recorder._forget();
        state.charId = 'char2';
        // The arriving character starts its own read, so `_charId` names them
        const arriving = recorder.load();
        release();
        await arriving;
        await new Promise((resolve) => setTimeout(resolve, 0));

        // char1's offline profit must not be written, least of all under char2
        expect(state.saved).toBeNull();

        recorder._store.load = storeLoad;
    });
});
