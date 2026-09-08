/** @vitest-environment happy-dom */

/**
 * `getSuccessRate`, the alchemy success-rate reader `output-totals.js` uses to
 * scale expected output totals by the panel's own stated rate.
 */

import { describe, test, expect, afterEach } from 'vitest';
import outputTotals from './output-totals.js';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

/**
 * A detail panel carrying the success-rate row the game draws.
 * @param {string} rateText - The value text, e.g. "72.5%"
 * @returns {HTMLElement} The panel
 */
function panel(rateText) {
    const root = document.createElement('div');
    root.innerHTML =
        '<div class="SkillActionDetail_successRate__x">' +
        `<div class="SkillActionDetail_value__y">${rateText}</div>` +
        '</div>';
    return root;
}

describe('getSuccessRate', () => {
    test('no success-rate row at all is a rate of 1 (non-alchemy action)', () => {
        expect(outputTotals.getSuccessRate(document.createElement('div'))).toBe(1);
    });

    describe('locale-grouped rates', () => {
        const asLocale = (value) => {
            localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        test('en-US period decimal', () => {
            asLocale('en-US');
            expect(outputTotals.getSuccessRate(panel('72.5%'))).toBeCloseTo(0.725);
        });

        test('de-DE comma decimal — the bug this replaces', () => {
            // An unconditional `.replace(',', '.')` happened to get this one
            // right by luck; a locale-derived read is not luck.
            asLocale('de-DE');
            expect(outputTotals.getSuccessRate(panel('72,5%'))).toBeCloseTo(0.725);
        });
    });
});
