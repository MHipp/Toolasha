/** @vitest-environment happy-dom */
import { parseItemCount, parseGameNumber, gameNumberSeparators, _resetGameNumberSeparators } from './number-parser.js';

describe('parseItemCount', () => {
    describe('plain numbers', () => {
        test('parses simple integer', () => expect(parseItemCount('100')).toBe(100));
        test('parses large integer', () => expect(parseItemCount('1000000')).toBe(1000000));
    });

    describe('K/M/B suffixes', () => {
        test('parses K suffix', () => expect(parseItemCount('1.5K')).toBe(1500));
        test('parses M suffix', () => expect(parseItemCount('2M')).toBe(2000000));
        test('parses B suffix', () => expect(parseItemCount('1.2B')).toBe(1200000000));
        test('parses T suffix', () => expect(parseItemCount('1.2T')).toBe(1200000000000));
        test('parses lowercase k', () => expect(parseItemCount('1.5k')).toBe(1500));
    });

    describe('comma as thousands separator', () => {
        test('1,000 → 1000', () => expect(parseItemCount('1,000')).toBe(1000));
        test('1,234,567 → 1234567', () => expect(parseItemCount('1,234,567')).toBe(1234567));
    });

    describe('comma as decimal separator', () => {
        test('1,5 → 1.5', () => expect(parseItemCount('1,5')).toBe(1.5));
        test('12,5 → 12.5', () => expect(parseItemCount('12,5')).toBe(12.5));
    });

    describe('period as thousands separator', () => {
        test('1.000 → 1000', () => expect(parseItemCount('1.000')).toBe(1000));
        test('1.234.567 → 1234567', () => expect(parseItemCount('1.234.567')).toBe(1234567));
    });

    describe('period as decimal separator', () => {
        test('1.5 → 1.5', () => expect(parseItemCount('1.5')).toBe(1.5));
        test('12.5 → 12.5', () => expect(parseItemCount('12.5')).toBe(12.5));
    });

    describe('space as thousands separator', () => {
        test('1 000 → 1000', () => expect(parseItemCount('1 000')).toBe(1000));
        test('1 234 567 → 1234567', () => expect(parseItemCount('1 234 567')).toBe(1234567));
    });

    describe('mixed separators (European format)', () => {
        test('1.234,56 → 1234.56', () => expect(parseItemCount('1.234,56')).toBe(1234.56));
        test('1.234.567,89 → 1234567.89', () => expect(parseItemCount('1.234.567,89')).toBe(1234567.89));
    });

    describe('mixed separators (US format)', () => {
        test('1,234.56 → 1234.56', () => expect(parseItemCount('1,234.56')).toBe(1234.56));
        test('1,234,567.89 → 1234567.89', () => expect(parseItemCount('1,234,567.89')).toBe(1234567.89));
    });

    describe('prefixed formats', () => {
        test('x5 → 5', () => expect(parseItemCount('x5')).toBe(5));
        test('x1,000 → 1000', () => expect(parseItemCount('x1,000')).toBe(1000));
    });

    describe('default value', () => {
        test('returns default on empty string', () => expect(parseItemCount('', 0)).toBe(0));
        test('returns default on null', () => expect(parseItemCount(null, 0)).toBe(0));
        test('returns default on unparseable', () => expect(parseItemCount('abc', 0)).toBe(0));
    });
});

describe('parseGameNumber', () => {
    /** Point the game's language key at one locale for the duration of a test. */
    const asLocale = (value) => {
        if (value === null) localStorage.removeItem('i18nextLng');
        else localStorage.setItem('i18nextLng', value);
        _resetGameNumberSeparators();
    };

    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    describe('en-US', () => {
        beforeEach(() => asLocale('en-US'));

        test('drops comma grouping', () => expect(parseGameNumber('1,234,567')).toBe(1234567));
        test('keeps the period as the decimal point', () => expect(parseGameNumber('1,234.5')).toBe(1234.5));
        test('reads a bare decimal', () => expect(parseGameNumber('1.5')).toBe(1.5));
        test('keeps the sign', () => expect(parseGameNumber('-1,200')).toBe(-1200));
        test('ignores surrounding text', () => expect(parseGameNumber('Cost: 12,000 coins')).toBe(12000));
    });

    describe('de-DE (comma decimal, period grouping)', () => {
        beforeEach(() => asLocale('de-DE'));

        test('reads the comma as a decimal point, not as grouping', () => {
            // The hardcoded strip this replaces read this back as 15.
            expect(parseGameNumber('1,5')).toBe(1.5);
        });

        test('drops period grouping instead of reading it as a decimal', () => {
            expect(parseGameNumber('1.234')).toBe(1234);
            expect(parseGameNumber('1.234.567')).toBe(1234567);
        });

        test('handles both separators together', () => expect(parseGameNumber('1.234,5')).toBe(1234.5));
    });

    describe('a missing or unusable language key', () => {
        test('defaults to en-US when the key is absent', () => {
            asLocale(null);
            expect(gameNumberSeparators()).toMatchObject({ locale: 'en-US', group: ',', decimal: '.' });
            expect(parseGameNumber('1,234')).toBe(1234);
        });

        test('defaults to en-US when the key names a locale Intl does not know', () => {
            asLocale('not a locale');
            expect(gameNumberSeparators().locale).toBe('en-US');
            expect(parseGameNumber('1,234')).toBe(1234);
        });

        test('accepts an underscore-separated tag', () => {
            asLocale('de_DE');
            expect(gameNumberSeparators().decimal).toBe(',');
        });
    });

    describe('non-numbers', () => {
        beforeEach(() => asLocale('en-US'));

        test('returns the default for text with no number', () => {
            expect(parseGameNumber('none')).toBeNaN();
            expect(parseGameNumber('none', 0)).toBe(0);
            expect(parseGameNumber(null, -1)).toBe(-1);
            expect(parseGameNumber(undefined, -1)).toBe(-1);
        });

        test('passes a finite number straight through', () => expect(parseGameNumber(42.5)).toBe(42.5));
        test('returns the default for a non-finite number', () => expect(parseGameNumber(Infinity, 0)).toBe(0));
    });

    test('re-resolves when the game language changes mid-session', () => {
        asLocale('en-US');
        expect(parseGameNumber('1,5')).toBe(15);
        localStorage.setItem('i18nextLng', 'de-DE'); // no cache reset — the getter must notice
        expect(parseGameNumber('1,5')).toBe(1.5);
    });
});
