/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { createForecastSection } from './networth-forecast-section.js';

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
