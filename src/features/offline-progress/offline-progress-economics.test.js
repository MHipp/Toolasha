/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
    fakeDataManager,
    mockOnClass,
    mockCalculateOfflineEconomics,
    mockGetItemDetails,
    mockGetOfflineHourCap,
    settingValues,
    settingChangeCallbacks,
} = vi.hoisted(() => {
    const listeners = new Map();
    return {
        settingValues: { offlineProgressEconomics: true, profitCalc_pricingMode: 'hybrid' },
        settingChangeCallbacks: new Map(),
        mockGetItemDetails: vi.fn(() => null),
        mockGetOfflineHourCap: vi.fn(() => null),
        mockCalculateOfflineEconomics: vi.fn(),
        mockOnClass: vi.fn(),
        fakeDataManager: {
            characterData: null,
            on: (event, handler) => {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
            },
            off: (event, handler) => {
                listeners.get(event)?.delete(handler);
            },
            emit: (event, data) => {
                for (const handler of Array.from(listeners.get(event) || [])) handler(data);
            },
            listenerCount: (event) => listeners.get(event)?.size || 0,
        },
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: Object.assign(fakeDataManager, {
        getItemDetails: mockGetItemDetails,
        getOfflineHourCap: mockGetOfflineHourCap,
    }),
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn((key) => settingValues[key] ?? true),
        getSettingValue: vi.fn((key, def) => settingValues[key] ?? def),
        getPricingModeLabel: vi.fn(() => 'Buy: Ask / Sell: Ask'),
        onSettingChange: (key, cb) => {
            if (!settingChangeCallbacks.has(key)) settingChangeCallbacks.set(key, new Set());
            settingChangeCallbacks.get(key).add(cb);
        },
        offSettingChange: (key, cb) => {
            settingChangeCallbacks.get(key)?.delete(cb);
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: mockOnClass.mockImplementation(() => vi.fn()),
    },
}));
vi.mock('../../utils/offline-economics-calculator.js', () => ({
    calculateOfflineEconomics: mockCalculateOfflineEconomics,
}));
vi.mock('../../utils/market-data.js', () => ({ formatPrice: vi.fn((n) => String(Math.round(n))) }));

// One entry per `createMutationWatcher` call, oldest first, so a test can tell
// a still-live watch (from the modal currently open) apart from a superseded
// one (a previous modal's watch that a correct implementation must have
// disconnected already).
let capturedWatches = [];
let capturedCleanupCallback = null;
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: vi.fn((_el, callback) => {
        capturedCleanupCallback = callback;
        const unwatch = vi.fn();
        capturedWatches.push({ callback, unwatch });
        return unwatch;
    }),
}));

import offlineProgressEconomics, { buildBlock } from './offline-progress-economics.js';

function buildModalNode() {
    const modalContent = document.createElement('div');
    modalContent.className = 'OfflineProgressModal_modalContent__3ZsUb';
    modalContent.innerHTML = `
        <div class="OfflineProgressModal_header__3HqPY">Welcome Back!</div>
        <div class="OfflineProgressModal_itemList__26h-Y">
            <div class="OfflineProgressModal_offlineProgress__3P0VR">
                <div class="OfflineProgressModal_label__2HwFG">Offline duration</div>
                <div>3h 0m</div>
            </div>
        </div>
    `;
    document.body.appendChild(modalContent);
    return modalContent;
}

const SAMPLE_ECONOMICS = {
    revenue: 100,
    cost: 20,
    profit: 80,
    revenuePerDay: 300,
    costPerDay: 60,
    profitPerDay: 240,
    durationSeconds: 28800,
    isPartial: false,
    unvaluedItems: [],
    lines: [],
};

function triggerCharacterInitialized(overrides = {}) {
    fakeDataManager.emit('character_initialized', {
        offlineItems: [{ itemHrid: '/items/cheese', enhancementLevel: 0, offlineCount: 10 }],
        currentTimestamp: '2026-08-19T12:00:00.000Z',
        character: { lastOfflineTime: '2026-08-19T04:00:00.000Z' },
        ...overrides,
    });
}

describe('offline-progress-economics', () => {
    beforeEach(() => {
        settingValues.offlineProgressEconomics = true;
        settingValues.profitCalc_pricingMode = 'hybrid';
        mockCalculateOfflineEconomics.mockReset().mockReturnValue(SAMPLE_ECONOMICS);
        mockGetItemDetails.mockReset().mockReturnValue(null);
        mockGetOfflineHourCap.mockReset().mockReturnValue(null);
        mockOnClass.mockClear();
        fakeDataManager.characterData = null;
        capturedCleanupCallback = null;
        capturedWatches = [];
    });

    afterEach(() => {
        offlineProgressEconomics.disable();
        document.body.innerHTML = '';
    });

    test('injects the economics block after character_initialized delivers offline items and the modal mounts', () => {
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();

        const modalNode = buildModalNode();
        const onClassCallback = mockOnClass.mock.calls[0][2];
        onClassCallback(modalNode);

        const block = document.querySelector('#mwi-offline-economics');
        expect(block).not.toBeNull();
        expect(block.previousElementSibling.className).toContain('OfflineProgressModal_itemList');
    });

    test('reads the offline hour cap from dataManager and threads it into calculateOfflineEconomics', () => {
        mockGetOfflineHourCap.mockReturnValue(82);
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();

        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);

        expect(mockCalculateOfflineEconomics).toHaveBeenCalledWith(expect.objectContaining({ offlineHourCap: 82 }));
    });

    test('catches up on offline data cached before initialize() ran (the real-world boot order)', () => {
        // dataManager's own character_initialized handler already fired and cached the payload
        // via `characterData` before this feature's own (featureRegistry-gated) initialize()
        // call ever subscribed - initialize() must not rely solely on catching the live event.
        fakeDataManager.characterData = {
            offlineItems: [{ itemHrid: '/items/cheese', enhancementLevel: 0, offlineCount: 10 }],
            currentTimestamp: '2026-08-19T12:00:00.000Z',
            character: { lastOfflineTime: '2026-08-19T04:00:00.000Z' },
        };

        offlineProgressEconomics.initialize();

        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);

        expect(document.querySelector('#mwi-offline-economics')).not.toBeNull();
    });

    test('catches up on a native modal that was already mounted before initialize() ran (real-world boot order, no manual mockOnClass trigger)', () => {
        // The native modal renders from the same event this feature's own initialize() is
        // chained behind, so it is very likely already in the DOM by the time domObserver.onClass
        // gets registered - that watcher only reacts to *future* insertions.
        fakeDataManager.characterData = {
            offlineItems: [{ itemHrid: '/items/cheese', enhancementLevel: 0, offlineCount: 10 }],
            currentTimestamp: '2026-08-19T12:00:00.000Z',
            character: { lastOfflineTime: '2026-08-19T04:00:00.000Z' },
        };
        buildModalNode();

        offlineProgressEconomics.initialize();

        expect(document.querySelector('#mwi-offline-economics')).not.toBeNull();
    });

    test('does not inject anything when there is no cached offline data (e.g. an ordinary login with no offline items)', () => {
        offlineProgressEconomics.initialize();
        fakeDataManager.emit('character_initialized', {
            offlineItems: [],
            currentTimestamp: '2026-08-19T12:00:00.000Z',
            character: { lastOfflineTime: '2026-08-19T04:00:00.000Z' },
        });

        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);

        expect(document.querySelector('#mwi-offline-economics')).toBeNull();
    });

    test('processing the same modal node twice only injects the block once', () => {
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();

        const modalNode = buildModalNode();
        const onClassCallback = mockOnClass.mock.calls[0][2];
        onClassCallback(modalNode);
        onClassCallback(modalNode);

        expect(document.querySelectorAll('#mwi-offline-economics')).toHaveLength(1);
    });

    test('character_switching removes the injected block and clears cached offline data', () => {
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();
        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);
        expect(document.querySelector('#mwi-offline-economics')).not.toBeNull();

        fakeDataManager.emit('character_switching', {});

        expect(document.querySelector('#mwi-offline-economics')).toBeNull();

        // A second modal for a different character with no fresh character_initialized must not
        // resurrect the old block.
        document.body.innerHTML = '';
        const secondModalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](secondModalNode);
        expect(document.querySelector('#mwi-offline-economics')).toBeNull();
    });

    test('the injected block is removed once the native modal closes', () => {
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();
        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);
        expect(document.querySelector('#mwi-offline-economics')).not.toBeNull();

        modalNode.remove();
        capturedCleanupCallback();

        expect(document.querySelector('#mwi-offline-economics')).toBeNull();
    });

    test('a pricing mode change while the modal is open recomputes and replaces the block', () => {
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();
        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);

        mockCalculateOfflineEconomics.mockReturnValue({ ...SAMPLE_ECONOMICS, revenue: 999 });
        for (const cb of settingChangeCallbacks.get('profitCalc_pricingMode')) cb('optimistic');

        expect(mockCalculateOfflineEconomics).toHaveBeenCalledTimes(2);
        expect(document.querySelectorAll('#mwi-offline-economics')).toHaveLength(1);
        expect(document.querySelector('#mwi-offline-economics').textContent).toContain('999');
    });

    test('a stale watch from a leftover previous modal cannot tear down the current character’s block', () => {
        // Character A's modal appears and gets a block.
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();
        const modalA = buildModalNode();
        mockOnClass.mock.calls[0][2](modalA);
        expect(capturedWatches).toHaveLength(1);

        // The player switches to character B while modal A's element is still
        // attached to the DOM (the game has not removed it yet) - the real
        // scenario a 1-main-plus-3-ironcow session hits routinely.
        fakeDataManager.emit('character_switching', {});
        triggerCharacterInitialized();
        const modalB = buildModalNode();
        mockOnClass.mock.calls[0][2](modalB);
        expect(document.querySelector('#mwi-offline-economics')).not.toBeNull();

        // Watch A must have been disconnected once watch B took over - a real
        // MutationObserver never calls back again after `disconnect()`, so this
        // is what actually keeps watch A from later reaching into character B's
        // `currentBlock` when modal A eventually leaves the DOM for real.
        expect(capturedWatches).toHaveLength(2);
        expect(capturedWatches[0].unwatch).toHaveBeenCalled();
    });

    test('the pricing mode listener is unsubscribed once the modal closes (no leaked recompute)', () => {
        offlineProgressEconomics.initialize();
        triggerCharacterInitialized();
        const modalNode = buildModalNode();
        mockOnClass.mock.calls[0][2](modalNode);

        modalNode.remove();
        capturedCleanupCallback();

        expect(settingChangeCallbacks.get('profitCalc_pricingMode').size).toBe(0);
    });

    test('does nothing when the feature setting is disabled', () => {
        settingValues.offlineProgressEconomics = false;
        offlineProgressEconomics.initialize();

        expect(fakeDataManager.listenerCount('character_initialized')).toBe(0);
        expect(mockOnClass).not.toHaveBeenCalled();
    });

    test('initialize -> disable -> initialize registers exactly one character_initialized listener', () => {
        offlineProgressEconomics.initialize();
        offlineProgressEconomics.disable();
        offlineProgressEconomics.initialize();

        expect(fakeDataManager.listenerCount('character_initialized')).toBe(1);
        expect(fakeDataManager.listenerCount('character_switching')).toBe(1);
    });
});

const RICH_ECONOMICS = {
    revenue: 150,
    cost: 30,
    profit: 120,
    revenuePerDay: 450,
    costPerDay: 90,
    profitPerDay: 360,
    durationSeconds: 28800,
    isPartial: true,
    unvaluedItems: [
        { itemHrid: '/items/mystery_box', enhancementLevel: 0, offlineCount: 2 },
        { itemHrid: '/items/broken_widget', enhancementLevel: 0, offlineCount: -1 },
    ],
    lines: [
        {
            itemHrid: '/items/cheese',
            enhancementLevel: 0,
            quantity: 10,
            side: 'sell',
            unitValue: 10,
            totalValue: 100,
            source: 'market',
        },
        {
            itemHrid: '/items/coin',
            enhancementLevel: 0,
            quantity: 50,
            side: 'sell',
            unitValue: 1,
            totalValue: 50,
            source: 'coin',
        },
        {
            itemHrid: '/items/log',
            enhancementLevel: 3,
            quantity: 5,
            side: 'buy',
            unitValue: 6,
            totalValue: 30,
            source: 'market',
        },
    ],
};

describe('buildBlock - expandable Revenue/Cost details', () => {
    beforeEach(() => {
        mockGetItemDetails.mockReset().mockReturnValue(null);
    });

    test('Revenue and Cost show a + prefix (expandable), Profit does not', () => {
        const block = buildBlock(RICH_ECONOMICS);
        const [, revenueWrapper, costWrapper, profitWrapper] = block.children;

        expect(revenueWrapper.firstElementChild.textContent).toContain('+ Revenue');
        expect(costWrapper.firstElementChild.textContent).toContain('+ Cost');
        expect(profitWrapper.firstElementChild.textContent).not.toContain('+ Profit');
        expect(profitWrapper.children).toHaveLength(1); // no details element at all
    });

    test('clicking Revenue reveals only its own sell-side line items and gained unvalued items', () => {
        const block = buildBlock(RICH_ECONOMICS);
        const revenueWrapper = block.children[1];
        const [row, details] = revenueWrapper.children;

        expect(details.style.display).toBe('none');
        row.dispatchEvent(new Event('click', { bubbles: true }));

        expect(details.style.display).toBe('block');
        expect(row.textContent).toContain('- Revenue');
        expect(details.textContent).toContain('10x'); // cheese line
        expect(details.textContent).toContain('50x'); // coin line
        expect(details.textContent).toContain('mystery_box');
        expect(details.textContent).not.toContain('log'); // cost-side line must not leak in
        expect(details.textContent).not.toContain('broken_widget'); // consumed unvalued item
    });

    test('clicking Cost reveals only its own buy-side line items and consumed unvalued items, with enhancement level shown', () => {
        const block = buildBlock(RICH_ECONOMICS);
        const costWrapper = block.children[2];
        const [row, details] = costWrapper.children;

        row.dispatchEvent(new Event('click', { bubbles: true }));

        expect(details.textContent).toContain('log +3');
        expect(details.textContent).toContain('broken_widget');
        expect(details.textContent).not.toContain('cheese');
        expect(details.textContent).not.toContain('mystery_box');
    });

    test('clicking a row twice collapses it again', () => {
        const block = buildBlock(RICH_ECONOMICS);
        const revenueWrapper = block.children[1];
        const [row, details] = revenueWrapper.children;

        row.dispatchEvent(new Event('click', { bubbles: true }));
        expect(details.style.display).toBe('block');

        row.dispatchEvent(new Event('click', { bubbles: true }));
        expect(details.style.display).toBe('none');
        expect(row.textContent).toContain('+ Revenue');
    });

    test('a row with no line items and no unvalued items renders as plain, non-expandable text', () => {
        const emptyEconomics = { ...RICH_ECONOMICS, lines: [], unvaluedItems: [], isPartial: false };
        const block = buildBlock(emptyEconomics);
        const [, revenueWrapper] = block.children;

        expect(revenueWrapper.children).toHaveLength(1);
        expect(revenueWrapper.firstElementChild.textContent).not.toContain('+ Revenue');
        expect(revenueWrapper.firstElementChild.style.cursor).not.toBe('pointer');
    });

    test('line items within a row are sorted highest total value first, regardless of input order', () => {
        const economics = {
            ...RICH_ECONOMICS,
            unvaluedItems: [],
            lines: [
                {
                    itemHrid: '/items/small_thing',
                    enhancementLevel: 0,
                    quantity: 1,
                    side: 'sell',
                    unitValue: 5,
                    totalValue: 5,
                    source: 'market',
                },
                {
                    itemHrid: '/items/big_thing',
                    enhancementLevel: 0,
                    quantity: 1,
                    side: 'sell',
                    unitValue: 500,
                    totalValue: 500,
                    source: 'market',
                },
                {
                    itemHrid: '/items/medium_thing',
                    enhancementLevel: 0,
                    quantity: 1,
                    side: 'sell',
                    unitValue: 50,
                    totalValue: 50,
                    source: 'market',
                },
            ],
        };

        const block = buildBlock(economics);
        const [, revenueWrapper] = block.children;
        const details = revenueWrapper.children[1];
        const order = Array.from(details.children).map((row) => row.textContent);

        expect(order[0]).toContain('big_thing');
        expect(order[1]).toContain('medium_thing');
        expect(order[2]).toContain('small_thing');
    });

    test('the block stretches to fill the width of its native parent instead of shrinking to content', () => {
        const block = buildBlock(RICH_ECONOMICS);
        expect(block.style.alignSelf).toBe('stretch');
        expect(block.style.width).toBe('100%');
    });
});

describe('buildBlock - offline cap overrun line', () => {
    test('away time within the cap renders no overrun line at all', () => {
        const economics = {
            ...SAMPLE_ECONOMICS,
            awayHours: 8,
            offlineHourCap: 24,
            overrunHours: 0,
            overrunValue: null,
        };

        const block = buildBlock(economics);

        expect(block.textContent).not.toContain('over');
        expect(block.textContent).not.toContain('missed');
    });

    test('away time past the cap renders the hours over and the estimated value', () => {
        const economics = {
            ...SAMPLE_ECONOMICS,
            awayHours: 48,
            offlineHourCap: 20,
            overrunHours: 28,
            overrunValue: 1400,
        };

        const block = buildBlock(economics);
        const text = block.textContent;

        expect(text).toContain('Away 48.0h (cap 20h)');
        expect(text).toContain('28.0h over');
        expect(text).toContain('missed');
        expect(text).toContain('1400'); // formatPrice is mocked to Math.round in this file
    });

    test('an economics result with no overrun fields (e.g. an older/mocked shape) renders no line rather than crashing', () => {
        const block = buildBlock(SAMPLE_ECONOMICS);

        expect(block.textContent).not.toContain('missed');
    });
});
