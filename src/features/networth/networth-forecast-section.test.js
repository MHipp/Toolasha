/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { createForecastSection, parseForecastTarget } from './networth-forecast-section.js';

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
