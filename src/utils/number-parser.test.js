/** @vitest-environment happy-dom */
import {
    isAmountText,
    parseItemCount,
    parseGameNumber,
    gameNumberSeparators,
    gameNumberPattern,
    gameDigitsSource,
    _resetGameNumberSeparators,
} from './number-parser.js';

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
        test('parses Q suffix, which the formatters print', () => expect(parseItemCount('2Q')).toBe(2e15));
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

    describe('suffix words', () => {
        test.each([
            ['12 billion', 12e9],
            ['12 Billion', 12e9],
            ['12billion', 12e9],
            ['3 billions', 3e9],
            ['12bn', 12e9],
            ['12 BN', 12e9],
            ['1.5 million', 1.5e6],
            ['2 millions', 2e6],
            ['5 mil', 5e6],
            ['5mil', 5e6],
            ['750 thousand', 750e3],
            ['2 thousands', 2e3],
            ['3 trillion', 3e12],
            ['2tn', 2e12],
            ['1,5 million', 1.5e6],
            ['Amount: 5 million', 5e6],
        ])('%j → %d', (text, expected) => expect(parseItemCount(text)).toBe(expected));
    });

    describe('leniency it already had is unchanged', () => {
        // Read off the parser before suffix words existed: callers read DOM text
        // where a number sits among words, and depend on these answers
        test.each([
            ['100M', 100e6],
            ['1,234', 1234],
            ['x5', 5],
            ['Amount: 1 000', 1000],
            ['12xyz', 12],
            ['12 bananas', 12],
            ['x2k', 2000],
            ['1.5 k', 1500],
            ['12 B', 12e9],
            ['1e10', 1e10],
            ['-5', -5],
            ['  7  ', 7],
        ])('%j → %d', (text, expected) => expect(parseItemCount(text, 'DEFAULT')).toBe(expected));

        test.each(['Best Sell: 994,000', 'max', 'abc'])('%j → default', (text) =>
            expect(parseItemCount(text, 'DEFAULT')).toBe('DEFAULT')
        );
    });

    describe('malformed grouping', () => {
        // Grouping is 1-3 digits then groups of exactly three; anything else is not
        // a number, rather than whatever parseFloat makes of its first two groups
        test.each(['1.2.3', '12,34,5', '1,2,3', '1.2.3k', '1,234,56', '12,34,567', '1.2.3,5', '1,234.5.6', '1,234,'])(
            '%j → default',
            (text) => expect(parseItemCount(text, 'DEFAULT')).toBe('DEFAULT')
        );

        test.each([
            ['1,234,567', 1234567],
            ['1.500.000k', 1.5e9],
            ['1.234.567,89', 1234567.89],
            ['1,234,567.89', 1234567.89],
            ['-1,234,567', -1234567],
        ])('well-formed %j → %d', (text, expected) => expect(parseItemCount(text)).toBe(expected));

        test('a lone separator before other than three digits is a decimal, not bad grouping', () => {
            expect(parseItemCount('1,2345')).toBe(1.2345);
            expect(parseItemCount('0,1234')).toBe(0.1234);
        });
    });

    describe('a separator before a suffix', () => {
        const asLocale = (value) => {
            if (value === null) localStorage.removeItem('i18nextLng');
            else localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => asLocale(null));

        describe('en-US', () => {
            beforeEach(() => asLocale('en-US'));

            // Each of these read 1000x or more too small: a trailing suffix hid the
            // three digits that mark grouping, so the first separator became a decimal
            test.each([
                ['1,500m', 1.5e9],
                ['1,500 m', 1.5e9],
                ['1,234M', 1.234e9],
                ['x1,500k', 1.5e6],
                ['1,500,000k', 1.5e9],
                ['1.500.000k', 1.5e9],
                ['1,500 million', 1.5e9],
            ])('%j → %d', (text, expected) => expect(parseItemCount(text)).toBe(expected));

            test.each([
                ['1.250b', 1.25e9],
                ['1,5m', 1.5e6],
                ['1.5k', 1500],
                ['12,50k', 12500],
            ])('%j keeps its decimal → %d', (text, expected) => expect(parseItemCount(text)).toBe(expected));
        });

        describe('de-DE (period grouping, comma decimal)', () => {
            beforeEach(() => asLocale('de-DE'));

            test.each([
                ['1.500K', 1.5e6],
                ['1,250b', 1.25e9],
                ['1,5m', 1.5e6],
                ['1.500.000k', 1.5e9],
            ])('%j → %d', (text, expected) => expect(parseItemCount(text)).toBe(expected));
        });
    });
});

describe('isAmountText', () => {
    test.each([
        '12b',
        '12B',
        ' 12b ',
        '12 b',
        '1.5t',
        '500m',
        '750k',
        '12,000,000,000',
        '12000000000',
        '12bn',
        '12 billion',
        '3 trillions',
        '1.234,5 mil',
        '2q',
        '1.5 Q',
    ])('%j is an amount', (text) => expect(isAmountText(text)).toBe(true));

    test.each([
        '',
        '   ',
        null,
        undefined,
        'abc',
        '12xyz',
        '12 bananas',
        '12kb',
        '12bnx',
        'x12',
        '-5',
        'b12',
        '12ks',
        '1.2.3',
        '12,34,5',
        '1,2,3b',
    ])('%j is not an amount', (text) => expect(isAmountText(text)).toBe(false));
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

describe('gameNumberPattern / gameDigitsSource', () => {
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

        test('fragments are the comma group and the period decimal', () => {
            expect(gameNumberPattern()).toEqual({ group: ',', decimal: '\\.' });
        });

        test('captures a fully-grouped number whole', () => {
            const re = new RegExp(`^${gameDigitsSource()}$`);
            expect('1,234,567'.match(re)?.[0]).toBe('1,234,567');
        });

        test('captures a decimal tail', () => {
            const re = new RegExp(`^${gameDigitsSource()}$`);
            expect('1,234.5'.match(re)?.[0]).toBe('1,234.5');
        });

        test('decimal:false stops at the group boundary only, not at a period', () => {
            const re = new RegExp(`^${gameDigitsSource({ decimal: false })}`);
            expect('1,234'.match(re)?.[0]).toBe('1,234');
        });
    });

    describe('de-DE (period grouping, comma decimal)', () => {
        beforeEach(() => asLocale('de-DE'));

        test('fragments are the period group and the comma decimal', () => {
            expect(gameNumberPattern()).toEqual({ group: '\\.', decimal: ',' });
        });

        test('captures a period-grouped number whole — the bug this replaces', () => {
            // The hardcoded `\d[\d,]*` this replaces stopped at the first ".",
            // so "1.234.567" captured as just "1".
            const re = new RegExp(`^${gameDigitsSource()}$`);
            expect('1.234.567'.match(re)?.[0]).toBe('1.234.567');
        });

        test('captures a comma decimal tail', () => {
            const re = new RegExp(`^${gameDigitsSource()}$`);
            expect('1.234,5'.match(re)?.[0]).toBe('1.234,5');
        });
    });

    describe('fr-FR (space grouping)', () => {
        beforeEach(() => asLocale('fr-FR'));

        test('groups with \\s so any whitespace variant is caught', () => {
            expect(gameNumberPattern().group).toBe('\\s');
        });

        test('captures a space-grouped number whole, narrow-nbsp or plain space alike', () => {
            const re = new RegExp(`^${gameDigitsSource()}$`);
            expect('1 234 567'.match(re)?.[0]).toBe('1 234 567');
            expect('1 234 567'.match(re)?.[0]).toBe('1 234 567');
        });
    });

    test('re-resolves when the game language changes mid-session', () => {
        asLocale('en-US');
        expect(gameNumberPattern().group).toBe(',');
        localStorage.setItem('i18nextLng', 'de-DE'); // no cache reset — the getter must notice
        expect(gameNumberPattern().group).toBe('\\.');
    });
});
