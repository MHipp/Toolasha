/**
 * The networth coordinator's recalculations overlap — cooldown-delayed item
 * updates, the price-update debounce and manual refreshes all call
 * recalculate(), and each run yields to the browser throughout. Completion
 * order does not follow start order: the worker-failure fallback revalues a
 * run's whole worker group sequentially, so an older run can finish after a
 * newer one. These tests pin that a superseded run's result is discarded
 * rather than overwriting fresher prices in currentData and the displays.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const calculatorMock = vi.hoisted(() => ({
    calculateNetworth: vi.fn(),
}));

const displayMock = vi.hoisted(() => ({
    header: { update: vi.fn(), setNetworthFeature: vi.fn(), initialize: vi.fn(), disable: vi.fn() },
    inventory: { update: vi.fn(), setNetworthFeature: vi.fn(), initialize: vi.fn(), disable: vi.fn() },
}));

vi.mock('./networth-calculator.js', () => calculatorMock);
vi.mock('./networth-display.js', () => ({
    networthHeaderDisplay: displayMock.header,
    networthInventoryDisplay: displayMock.inventory,
}));
vi.mock('./networth-exclusion-popup.js', () => ({
    default: { refresh: vi.fn(), close: vi.fn() },
}));
const configMock = vi.hoisted(() => ({
    isFeatureEnabled: () => true,
    getSetting: () => false,
    getSettingValue: () => 'ask',
    onSettingChange: vi.fn(),
    offSettingChange: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({ default: configMock }));
vi.mock('../../core/connection-state.js', () => ({
    default: { isConnected: () => true },
}));
vi.mock('../../utils/performance-monitor.js', () => ({
    default: { enabled: false, span: (_g, _n, fn) => fn(), record: vi.fn() },
}));
vi.mock('../../utils/background-work.js', () => ({ runInBackground: vi.fn() }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('./networth-cache.js', () => ({ default: { clear: vi.fn(), checkAndInvalidate: vi.fn() } }));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: vi.fn() }));
vi.mock('./networth-history.js', () => ({ default: { initialize: vi.fn(), disable: vi.fn() } }));
vi.mock('./networth-history-chart.js', () => ({
    default: { setNetworthFeature: vi.fn(), toggleModal: vi.fn(), closeModal: vi.fn() },
}));
vi.mock('./production-income-recorder.js', () => ({ default: { initialize: vi.fn(), cleanup: vi.fn() } }));
vi.mock('./chest-opening-recorder.js', () => ({ default: { initialize: vi.fn(), cleanup: vi.fn() } }));
vi.mock('./gold-sources-panel.js', () => ({ default: { closeModal: vi.fn() } }));
vi.mock('./networth-exclusions.js', () => ({ initExclusions: vi.fn() }));
vi.mock('../../utils/networth-worker-manager.js', () => ({
    calculateItemValueBatch: vi.fn(),
    terminateItemValueWorkerPool: vi.fn(),
}));

import networthFeature from './index.js';

/** A deferred calculateNetworth result the test resolves by hand. */
function deferred(totalNetworth) {
    let resolve;
    const promise = new Promise((res) => {
        resolve = () => res({ totalNetworth, coins: 0 });
    });
    return { promise, resolve };
}

beforeEach(() => {
    calculatorMock.calculateNetworth.mockReset();
    displayMock.header.update.mockClear();
    displayMock.inventory.update.mockClear();
    networthFeature.currentData = null;
});

describe('overlapping recalculations', () => {
    test('a superseded run does not overwrite a newer result', async () => {
        const older = deferred(111); // started first, finishes last
        const newer = deferred(222);
        calculatorMock.calculateNetworth.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

        const olderRun = networthFeature.recalculate();
        const newerRun = networthFeature.recalculate();

        newer.resolve();
        await newerRun;
        expect(networthFeature.currentData.totalNetworth).toBe(222);

        older.resolve();
        await olderRun;

        // The stale run's answer must not land anywhere the UI reads
        expect(networthFeature.currentData.totalNetworth).toBe(222);
        const lastHeaderUpdate = displayMock.header.update.mock.calls.at(-1);
        expect(lastHeaderUpdate[0].totalNetworth).toBe(222);
        expect(displayMock.header.update).toHaveBeenCalledTimes(1);
    });

    test('runs that finish in start order both land', async () => {
        const first = deferred(111);
        const second = deferred(222);
        calculatorMock.calculateNetworth.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        const firstRun = networthFeature.recalculate();
        first.resolve();
        await firstRun;
        expect(networthFeature.currentData.totalNetworth).toBe(111);

        const secondRun = networthFeature.recalculate();
        second.resolve();
        await secondRun;
        expect(networthFeature.currentData.totalNetworth).toBe(222);
        expect(displayMock.header.update).toHaveBeenCalledTimes(2);
    });
});

describe('pricing settings', () => {
    test('the value source re-prices net worth, exactly as the pricing mode does', () => {
        configMock.onSettingChange.mockClear();
        networthFeature.setupEventListeners();

        const keys = configMock.onSettingChange.mock.calls.map(([key]) => key);
        expect(keys).toContain('networth_pricingMode');
        expect(keys).toContain('networth_valueSource');

        // Both are the same handler, so either one triggers a recalculation
        const handlers = configMock.onSettingChange.mock.calls
            .filter(([key]) => key.startsWith('networth_'))
            .map(([, handler]) => handler);
        expect(new Set(handlers).size).toBe(1);
    });
});
