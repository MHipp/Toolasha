/**
 * @vitest-environment happy-dom
 *
 * Guild Shrines category on the net worth history chart.
 *
 * Fixed Assets picked up a `guildShrines` value, and the chart needs a line for
 * it like every other category (gold, inventory, equipment, listings, house,
 * abilities). The one wrinkle: only snapshots taken after the recording site
 * starts writing the field will have it. Snapshots taken before that keep
 * rendering with the field simply absent, so the tests lean on that — a
 * missing field must read as "no data point here", never a fabricated zero.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#22c55e',
        COLOR_PROFIT: '#047857',
        COLOR_LOSS: '#f87171',
        Z_FLOATING_PANEL: 1100,
        getSettingValue: () => null,
        getSetting: () => false,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback) => fallback),
        set: vi.fn(),
    },
}));

const getHistory = vi.fn(() => []);
const getDetailSnapshot = vi.fn(() => null);
const deleteSnapshot = vi.fn(async () => {});
vi.mock('./networth-history.js', () => ({
    default: { getHistory, getDetailSnapshot, deleteSnapshot },
    GAP_THRESHOLD_MS: 2 * 60 * 60 * 1000,
}));

const { default: networthHistoryChart, computeAllTimeExtremes } = await import('./networth-history-chart.js');

/** A captured Chart.js construction, so tests can inspect what would be drawn. */
class FakeChart {
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
        FakeChart.lastInstance = this;
    }
    destroy() {}
}

const OLD_T = Date.parse('2026-08-01T00:00:00Z'); // before Guild Shrines was recorded
const NEW_T = Date.parse('2026-08-01T01:00:00Z'); // after

/** @returns {Object} A snapshot from before the guildShrines field existed */
function oldSnapshot() {
    return {
        t: OLD_T,
        total: 1000,
        nonExcluded: 1000,
        gold: 100,
        inventory: 300,
        equipment: 200,
        listings: 100,
        house: 250,
        abilities: 50,
        // no guildShrines field
    };
}

/** @returns {Object} A snapshot from after the guildShrines field was added */
function newSnapshot() {
    return {
        t: NEW_T,
        total: 1100,
        nonExcluded: 1100,
        gold: 100,
        inventory: 300,
        equipment: 200,
        listings: 100,
        house: 250,
        abilities: 50,
        guildShrines: 100,
    };
}

function findDataset(label) {
    return FakeChart.lastInstance.config.data.datasets.find((d) => d.label === label);
}

beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.Chart = FakeChart;
    FakeChart.lastInstance = null;
    getHistory.mockReset().mockReturnValue([]);
    getDetailSnapshot.mockReset().mockReturnValue(null);
    deleteSnapshot.mockReset().mockResolvedValue();

    // Reset chart singleton state between tests — it remembers prefs/selections
    // between openings, which is right for the UI and wrong for a test.
    networthHistoryChart.chartInstance = null;
    networthHistoryChart.connectGaps = false;
    networthHistoryChart.showBars = false;
    networthHistoryChart.movingAvgWindow = 0;
    networthHistoryChart.activeRange = 'all';
    networthHistoryChart.categoryVisibility = {
        showTotal: true,
        showNonExcluded: true,
        gold: false,
        inventory: false,
        equipment: false,
        listings: false,
        house: false,
        abilities: false,
        guildShrines: false,
    };
});

describe('Guild Shrines chart series', () => {
    test('is included in the datasets when toggled on, following the existing category convention', () => {
        getHistory.mockReturnValue([oldSnapshot(), newSnapshot()]);
        networthHistoryChart.categoryVisibility.guildShrines = true;

        // openModal builds the canvas/legend and renders once
        return networthHistoryChart.openModal().then(() => {
            const dataset = findDataset('Guild Shrines');
            expect(dataset).toBeTruthy();
            expect(dataset.borderColor).toBe('#ec4899');
            expect(dataset.type).toBe('line');

            // Old snapshot lacks the field -> NaN (a gap), not a fabricated 0
            expect(dataset.data[0].x).toBe(OLD_T);
            expect(Number.isNaN(dataset.data[0].y)).toBe(true);

            // New snapshot carries the real value through untouched
            expect(dataset.data[1]).toEqual({ x: NEW_T, y: 100 });
        });
    });

    test('is left out of the datasets when the toggle is off', () => {
        getHistory.mockReturnValue([oldSnapshot(), newSnapshot()]);
        // categoryVisibility.guildShrines stays false from beforeEach

        return networthHistoryChart.openModal().then(() => {
            expect(findDataset('Guild Shrines')).toBeUndefined();
        });
    });

    test('does not crash rendering a range built entirely from pre-field snapshots', () => {
        getHistory.mockReturnValue([oldSnapshot(), { ...oldSnapshot(), t: OLD_T + 1000 }]);
        networthHistoryChart.categoryVisibility.guildShrines = true;

        expect(() => networthHistoryChart.openModal()).not.toThrow();

        return networthHistoryChart.openModal().then(() => {
            const dataset = findDataset('Guild Shrines');
            expect(dataset).toBeTruthy();
            expect(dataset.data.every((p) => Number.isNaN(p.y))).toBe(true);
        });
    });
});

describe('Guild Shrines legend / toggle chip', () => {
    test('renders a chip in the category row alongside the other categories', async () => {
        getHistory.mockReturnValue([newSnapshot()]);
        await networthHistoryChart.openModal();

        const buttons = [...document.querySelectorAll('button')];
        const chip = buttons.find((b) => b.textContent.includes('Guild Shrines'));
        expect(chip).toBeTruthy();

        // Same swatch-dot treatment as every other category chip
        const dot = chip.querySelector('span');
        expect(dot.style.background).toContain('#ec4899');
    });

    test('toggling the chip re-renders the chart with the series added', async () => {
        getHistory.mockReturnValue([newSnapshot()]);
        await networthHistoryChart.openModal();
        expect(findDataset('Guild Shrines')).toBeUndefined();

        const buttons = [...document.querySelectorAll('button')];
        const chip = buttons.find((b) => b.textContent.includes('Guild Shrines'));
        chip.click();

        expect(networthHistoryChart.categoryVisibility.guildShrines).toBe(true);
        expect(findDataset('Guild Shrines')).toBeTruthy();
    });
});

describe('Guild Shrines tooltip breakdown', () => {
    test('appears in the custom tooltip line list', () => {
        getHistory.mockReturnValue([oldSnapshot(), newSnapshot()]);
        return networthHistoryChart.openModal().then(() => {
            const totalPoint = {
                raw: { x: NEW_T, _raw: newSnapshot() },
                dataset: { label: 'Total Net Worth', data: findDataset('Total Net Worth').data },
                dataIndex: findDataset('Total Net Worth').data.length - 1,
            };
            const context = {
                chart: { canvas: document.getElementById('mwi-nw-chart-canvas') },
                tooltip: { opacity: 1, dataPoints: [totalPoint], caretX: 10, caretY: 10 },
            };
            networthHistoryChart._renderCustomTooltip(context);
            const tooltipEl = document.getElementById('mwi-nw-chart-tooltip');
            expect(tooltipEl.innerHTML).toContain('Guild Shrines');
            expect(tooltipEl.innerHTML).toContain('100');
        });
    });
});

describe('computeAllTimeExtremes', () => {
    test('finds the highest and lowest total in the history, ignoring point order', () => {
        const history = [
            { t: 1, total: 500 },
            { t: 2, total: 900 },
            { t: 3, total: 100 },
            { t: 4, total: 700 },
        ];
        const { high, low } = computeAllTimeExtremes(history);
        expect(high).toEqual({ t: 2, total: 900 });
        expect(low).toEqual({ t: 3, total: 100 });
    });

    test('skips points with no finite total rather than treating them as zero', () => {
        const history = [
            { t: 1, total: 500 },
            { t: 2, total: NaN },
            { t: 3, total: undefined },
        ];
        const { high, low } = computeAllTimeExtremes(history);
        expect(high).toEqual({ t: 1, total: 500 });
        expect(low).toEqual({ t: 1, total: 500 });
    });

    test('returns nulls for an empty or missing history', () => {
        expect(computeAllTimeExtremes([])).toEqual({ high: null, low: null });
        expect(computeAllTimeExtremes(null)).toEqual({ high: null, low: null });
    });
});

describe('All-Time High stat', () => {
    test('shows the highest total ever recorded, not just the plotted range', async () => {
        getHistory.mockReturnValue([
            { t: OLD_T, total: 5_000_000, nonExcluded: 5_000_000 },
            { t: OLD_T + 3_600_000, total: 9_000_000, nonExcluded: 9_000_000 },
            { t: NEW_T, total: 6_000_000, nonExcluded: 6_000_000 },
        ]);

        await networthHistoryChart.openModal();
        const statsRow = document.getElementById('mwi-nw-chart-stats');
        expect(statsRow.textContent).toContain('All-Time High');
        expect(statsRow.textContent).toContain('9.00M');
    });

    test('reads "(now)" when the current total is the all-time high', async () => {
        getHistory.mockReturnValue([
            { t: OLD_T, total: 5_000_000, nonExcluded: 5_000_000 },
            { t: NEW_T, total: 9_000_000, nonExcluded: 9_000_000 },
        ]);

        await networthHistoryChart.openModal();
        const statsRow = document.getElementById('mwi-nw-chart-stats');
        expect(statsRow.textContent).toContain('All-Time High');
        expect(statsRow.innerHTML).toContain('(now)');
    });
});
