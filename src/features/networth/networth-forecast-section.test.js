/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import {
    createForecastSection,
    parseForecastTarget,
    buildFanPlot,
    dayTicks,
    fanDomain,
    methodLabel,
    placeEndLabels,
    valueTicks,
} from './networth-forecast-section.js';
import { forecastNetworth } from './networth-forecast.js';
import { networthFormatter } from '../../utils/formatters.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A snapshot series compounding at 1%/day.
 * @param {number} count - How many daily snapshots
 * @returns {Array<Object>} Snapshots
 */
function growingHistory(count) {
    return Array.from({ length: count }, (_, index) => ({ t: index * DAY_MS, total: 1000 * 1.01 ** index }));
}

describe('createForecastSection', () => {
    it('starts collapsed and computes nothing until expanded', () => {
        let reads = 0;
        const section = createForecastSection({
            getHistory: () => {
                reads += 1;
                return growingHistory(40);
            },
            seed: 5,
        });
        expect(section.element.querySelector('.mwi-nw-forecast-body').hidden).toBe(true);
        expect(reads).toBe(0);
    });

    it('draws five fan lines and the figures once expanded', () => {
        const section = createForecastSection({ getHistory: () => growingHistory(40), seed: 5 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();

        expect(section.element.querySelector('.mwi-nw-forecast-body').hidden).toBe(false);
        const lines = section.element.querySelectorAll('.mwi-nw-forecast-fan polyline');
        expect([...lines].map((line) => line.dataset.level)).toEqual(['p10', 'p25', 'p50', 'p75', 'p90']);
        expect(section.element.querySelectorAll('.mwi-nw-forecast-figures > div').length).toBeGreaterThan(3);
    });

    it('says the series is too short and draws nothing', () => {
        const section = createForecastSection({ getHistory: () => growingHistory(3), seed: 5 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();

        expect(section.element.querySelector('.mwi-nw-forecast-fan')).toBeNull();
        expect(section.element.querySelector('.mwi-nw-forecast-insufficient').textContent).toContain(
            'Not enough history'
        );
    });

    it('adds target probabilities when a target is entered', () => {
        const section = createForecastSection({ getHistory: () => growingHistory(40), seed: 5 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();
        const target = section.element.querySelector('.mwi-nw-forecast-target');
        target.value = '2000';
        target.dispatchEvent(new Event('change'));

        expect(section.element.textContent).toContain('Reach target by 30d');
    });
});

/**
 * A billions-scale series with enough spread that a 12B target is neither certain nor impossible.
 * @returns {Array<Object>} Snapshots
 */
function billionsHistory() {
    return Array.from({ length: 40 }, (_, index) => ({
        t: index * DAY_MS,
        total: 10e9 * 1.003 ** index * (1 + 0.02 * Math.sin(index * 1.7)),
    }));
}

/**
 * The figures an expanded section shows for one target entry.
 * @param {string} entry - What the player typed
 * @returns {string} The figures row's text
 */
function figuresFor(entry) {
    const section = createForecastSection({ getHistory: billionsHistory, seed: 11 });
    section.element.querySelector('.mwi-nw-forecast-toggle').click();
    const target = section.element.querySelector('.mwi-nw-forecast-target');
    target.value = entry;
    target.dispatchEvent(new Event('change'));
    return section.element.querySelector('.mwi-nw-forecast-figures').textContent;
}

describe('forecast target entry', () => {
    it('reads "12b" as the same target as "12000000000"', () => {
        const plain = figuresFor('12000000000');
        expect(plain).toContain('Reach target by 30d');
        expect(figuresFor('12b')).toBe(plain);
    });

    it.each(['12B', ' 12b ', '12,000,000,000', '12000000000'])('reads %j as 12 billion', (entry) => {
        expect(figuresFor(entry)).toBe(figuresFor('12000000000'));
    });

    it.each(['abc', '', '   ', '-5', '0'])('shows no target figure for %j', (entry) => {
        const text = figuresFor(entry);
        expect(text).not.toContain('Reach target');
        expect(text).not.toContain('NaN');
    });
});

describe('parseForecastTarget', () => {
    it.each([
        ['12b', 12e9],
        ['12B', 12e9],
        ['1.5t', 1.5e12],
        ['500m', 500e6],
        ['750k', 750e3],
        ['12,000,000,000', 12e9],
        ['12000000000', 12e9],
        ['  12b  ', 12e9],
    ])('reads %j as %d', (entry, expected) => {
        expect(parseForecastTarget(entry)).toBe(expected);
    });

    it.each(['abc', '', '   ', null, undefined, '-5', '0'])('reads %j as no target', (entry) => {
        expect(parseForecastTarget(entry)).toBeNull();
    });
});

/**
 * A forecast shaped by hand, so the labels are checked against numbers the model did not pick.
 * @param {Object<string, number>} ends - Each line's day-30 value
 * @returns {Object} A completed forecast's `days` and `fan`
 */
function knownForecast(ends) {
    const line = (end) => Array.from({ length: 31 }, (_, day) => 11.31e9 + ((end - 11.31e9) * day) / 30);
    return { days: 30, fan: Object.fromEntries(Object.entries(ends).map(([key, end]) => [key, line(end)])) };
}

const SPREAD_ENDS = { p10: 13.14e9, p25: 13.7e9, p50: 14.22e9, p75: 14.8e9, p90: 15.36e9 };

/**
 * @param {HTMLElement} root - Where to look
 * @param {string} selector - Label class selector
 * @returns {Array<string>} The labels' text, in DOM order
 */
const texts = (root, selector) => [...root.querySelectorAll(selector)].map((node) => node.textContent);

describe('forecast chart labels', () => {
    it('names every line at its end with its horizon value, highest first', () => {
        const plot = buildFanPlot(knownForecast(SPREAD_ENDS));
        expect(texts(plot, '.mwi-nw-forecast-end-label')).toEqual([
            'p90 15.36B',
            'p75 14.80B',
            'p50 14.22B',
            'p25 13.70B',
            'p10 13.14B',
        ]);
    });

    it('labels the days from 0 to the horizon and the values with the stats row formatter', () => {
        const plot = buildFanPlot(knownForecast(SPREAD_ENDS));
        expect(texts(plot, '.mwi-nw-forecast-x-tick')).toEqual(['0d', '5d', '10d', '15d', '20d', '25d', '30d']);
        const ticks = texts(plot, '.mwi-nw-forecast-y-tick');
        expect(ticks.length).toBeGreaterThanOrEqual(3);
        for (const tick of ticks) expect(tick).toMatch(/^\d+\.\d{2}B$/);
    });

    it('keeps only the outer lines and the median when the lines bunch, apart and inside the plot', () => {
        const plot = buildFanPlot(knownForecast({ p10: 10e9, p25: 14.2e9, p50: 14.21e9, p75: 14.22e9, p90: 14.23e9 }));
        const labels = [...plot.querySelectorAll('.mwi-nw-forecast-end-label')];
        expect(labels.map((label) => label.dataset.level)).toEqual(['p90', 'p50', 'p10']);
        const tops = labels.map((label) => Number.parseFloat(label.style.top));
        expect(tops[1] - tops[0]).toBeGreaterThanOrEqual(13);
        expect(tops[2] - tops[1]).toBeGreaterThanOrEqual(13);
        for (const top of tops) {
            expect(top).toBeGreaterThanOrEqual(6.5);
            expect(top).toBeLessThanOrEqual(160 - 6.5);
        }
    });

    it('draws a flat forecast without NaN or repeated value ticks', () => {
        const fan = Object.fromEntries(
            ['p10', 'p25', 'p50', 'p75', 'p90'].map((key) => [key, new Array(31).fill(1000)])
        );
        const plot = buildFanPlot({ days: 30, fan });
        expect(plot.innerHTML).not.toContain('NaN');
        const ticks = texts(plot, '.mwi-nw-forecast-y-tick');
        expect(ticks.length).toBeGreaterThan(0);
        expect(new Set(ticks).size).toBe(ticks.length);
        expect(texts(plot, '.mwi-nw-forecast-end-label')).toEqual(['p90 1.00K', 'p50 1.00K', 'p10 1.00K']);
    });

    it('draws an empty fan without NaN or line labels', () => {
        const plot = buildFanPlot({ days: 30, fan: {} });
        expect(plot.innerHTML).not.toContain('NaN');
        expect(plot.querySelectorAll('.mwi-nw-forecast-end-label')).toHaveLength(0);
    });

    it('labels the live section with the values its stats row reports', () => {
        const section = createForecastSection({ getHistory: billionsHistory, seed: 11 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();
        const forecast = forecastNetworth(billionsHistory(), { days: 30, seed: 11 });
        const expected = (key) => networthFormatter(Math.round(forecast.fan[key].at(-1)));

        const labels = texts(section.element, '.mwi-nw-forecast-end-label');
        expect(labels).toContain(`p50 ${expected('p50')}`);
        expect(labels).toContain(`p10 ${expected('p10')}`);
        expect(labels).toContain(`p90 ${expected('p90')}`);
        const figures = section.element.querySelector('.mwi-nw-forecast-figures').textContent;
        expect(figures).toContain(`p50 day 30${expected('p50')}`);
        expect(figures).toContain(`${expected('p10')} – ${expected('p90')}`);
    });

    it.each([
        [60, ['0d', '10d', '20d', '30d', '40d', '50d', '60d']],
        [90, ['0d', '15d', '30d', '45d', '60d', '75d', '90d']],
    ])('ticks a %i-day horizon', (days, expected) => {
        const section = createForecastSection({ getHistory: billionsHistory, seed: 11 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();
        const horizon = section.element.querySelector('.mwi-nw-forecast-horizon');
        horizon.value = String(days);
        horizon.dispatchEvent(new Event('change'));
        expect(texts(section.element, '.mwi-nw-forecast-x-tick')).toEqual(expected);
        expect(section.element.innerHTML).not.toContain('NaN');
    });

    it('draws nothing labelled, and no NaN, when there is no history', () => {
        const section = createForecastSection({ getHistory: () => [], seed: 11 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();
        expect(section.element.querySelector('.mwi-nw-forecast-insufficient')).not.toBeNull();
        expect(section.element.querySelectorAll('.mwi-nw-forecast-end-label')).toHaveLength(0);
        expect(section.element.innerHTML).not.toContain('NaN');
    });
});

describe('chart label helpers', () => {
    it('ticks values on round steps inside the range', () => {
        expect(valueTicks(13e9, 15.5e9)).toEqual([13e9, 13.5e9, 14e9, 14.5e9, 15e9, 15.5e9]);
        expect(valueTicks(13.14e9, 15.36e9)).toEqual([13.5e9, 14e9, 14.5e9, 15e9]);
    });

    it.each([
        [0, 0],
        [5, 5],
        [Number.NaN, 1],
        [1, Number.POSITIVE_INFINITY],
    ])('gives no value ticks for the range %d to %d', (min, max) => {
        expect(valueTicks(min, max)).toEqual([]);
    });

    it.each([
        [30, [0, 5, 10, 15, 20, 25, 30]],
        [7, [0, 2, 4, 7]],
        [1, [0, 1]],
        [0, [0]],
        [Number.NaN, [0]],
    ])('ticks a %d-day horizon', (days, expected) => {
        expect(dayTicks(days)).toEqual(expected);
    });

    it('gives a flat or empty fan a positive span', () => {
        expect(fanDomain({ fan: { p50: [1000, 1000] } })).toEqual({ min: 990, max: 1010 });
        expect(fanDomain({ fan: {} })).toEqual({ min: 0, max: 1 });
    });

    it('leaves clear labels level with their lines', () => {
        const entries = [0, 40, 80, 120, 150].map((y, rank) => ({ y, rank, required: rank % 2 === 0 }));
        const placed = placeEndLabels(entries);
        expect(placed).toHaveLength(5);
        expect(placed.map((entry) => entry.top)).toEqual([6.5, 40, 80, 120, 150]);
    });

    it('stacks coincident labels highest percentile first and keeps them inside the plot', () => {
        const entries = [0, 1, 2, 3, 4].map((rank) => ({ y: 158, rank, required: rank !== 1 && rank !== 3 }));
        const placed = placeEndLabels(entries);
        expect(placed.map((entry) => entry.rank)).toEqual([4, 2, 0]);
        expect(placed.map((entry) => entry.top)).toEqual([127.5, 140.5, 153.5]);
    });
});

describe('methodLabel', () => {
    const july13 = new Date(2026, 6, 13, 12).getTime();
    const september11 = new Date(2026, 8, 11, 20).getTime();

    it('names the generator, the change count and the real dates the window spans', () => {
        const label = methodLabel({
            method: 'block-bootstrap',
            returnCount: 60,
            windowStart: july13,
            windowEnd: september11,
        });
        expect(label).toBe('Bootstrap (60 changes, 07-13 – 09-11)');
    });

    it('names the normal fallback, and leaves the span out when the dates are missing', () => {
        expect(methodLabel({ method: 'gbm', returnCount: 7 })).toBe('GBM (7 changes)');
    });

    it('shows the span in the live section', () => {
        const section = createForecastSection({ getHistory: billionsHistory, seed: 11 });
        section.element.querySelector('.mwi-nw-forecast-toggle').click();
        expect(section.element.querySelector('.mwi-nw-forecast-figures').textContent).toMatch(
            /MethodBootstrap \(39 changes, \d{2}-\d{2} – \d{2}-\d{2}\)/
        );
    });
});

describe('forecast target words', () => {
    it('reads "12bn" and "12 billion" as the same target as "12b"', () => {
        const letter = figuresFor('12b');
        expect(letter).toContain('Reach target by 30d');
        expect(figuresFor('12bn')).toBe(letter);
        expect(figuresFor('12 billion')).toBe(letter);
    });

    it.each(['12xyz', '12 bananas', '12bnx', 'x12b', '12kb'])('refuses %j rather than reading it as 12', (entry) => {
        expect(parseForecastTarget(entry)).toBeNull();
        expect(figuresFor(entry)).not.toContain('Reach target');
    });

    it.each([
        ['12 Billion', 12e9],
        ['1.5 million', 1.5e6],
        ['750 thousand', 750e3],
        ['3 trillion', 3e12],
        ['2tn', 2e12],
        ['5 mil', 5e6],
    ])('reads %j as %d', (entry, expected) => {
        expect(parseForecastTarget(entry)).toBe(expected);
    });
});
