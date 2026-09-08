/** @vitest-environment happy-dom */

/**
 * `parseHaveNeedCount`, the "X" / "/ Y" reader behind the Item Dictionary's
 * missing-materials fallback (used when the action's own game data does not
 * settle it — see `_calcMissingFromGameData`).
 */

import { describe, test, expect, afterEach } from 'vitest';
import { parseHaveNeedCount } from './view-action-button.js';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

describe('parseHaveNeedCount', () => {
    test('reads plain counts', () => {
        expect(parseHaveNeedCount('12', '/ 20')).toEqual({ matched: true, missing: 8 });
    });

    test('en-US comma grouping', () => {
        expect(parseHaveNeedCount('120', '/ 1,234')).toEqual({ matched: true, missing: 1114 });
    });

    test('nothing missing is a matched pair with a null count', () => {
        expect(parseHaveNeedCount('20', '/ 20')).toEqual({ matched: true, missing: null });
        expect(parseHaveNeedCount('25', '/ 20')).toEqual({ matched: true, missing: null });
    });

    test('cells that are not the expected shape do not match', () => {
        expect(parseHaveNeedCount('Reptile Leather', '/ 20')).toEqual({ matched: false, missing: null });
        expect(parseHaveNeedCount('12', 'not a fraction')).toEqual({ matched: false, missing: null });
    });

    describe('locale-grouped counts', () => {
        const asLocale = (value) => {
            localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        test('en-US comma grouping', () => {
            asLocale('en-US');
            expect(parseHaveNeedCount('120', '/ 1,234')).toEqual({ matched: true, missing: 1114 });
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]+(?:\.\d+)?` reads "1.234" as decimal 1.234, not
            // as the grouped integer 1234: the period isn't in the class as a
            // group separator, so it is read as this pattern's own decimal dot.
            asLocale('de-DE');
            expect(parseHaveNeedCount('120', '/ 1.234')).toEqual({ matched: true, missing: 1114 });
        });
    });
});
