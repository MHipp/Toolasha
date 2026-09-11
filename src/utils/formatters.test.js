/**
 * Tests for Formatting Utilities
 * Testing pure functions for formatting numbers and time
 */

import { describe, test, expect, vi } from 'vitest';
import {
    numberFormatter,
    timeReadable,
    formatWithSeparator,
    formatKMB,
    formatKMB3Digits,
    coinFormatter,
    formatRelativeTime,
    networthFormatter,
    formatPercentage,
    formatCurrency,
    formatCompactNumber,
    formatLargeNumber,
    formatThreshold,
    parseKMB,
    isSameLocalDay,
    formatActivityStatusTime,
} from './formatters.js';
import { MAGNITUDE_SUFFIXES } from './number-parser.js';

// Mock config module for formatLargeNumber tests
vi.mock('../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => undefined),
        getSettingValue: vi.fn((key, defaultValue) => {
            if (key === 'formatting_useKMBFormat') return 'compact';
            if (key === 'formatting_precision') return '1';
            return defaultValue;
        }),
    },
}));

describe('numberFormatter', () => {
    test('formats whole numbers with thousand separators', () => {
        expect(numberFormatter(1500)).toBe('1,500');
        expect(numberFormatter(1500000)).toBe('1,500,000');
    });

    test('formats numbers with decimal places', () => {
        expect(numberFormatter(1500.5, 1)).toBe('1,500.5');
        expect(numberFormatter(1234.567, 2)).toBe('1,234.57');
    });

    test('handles zero', () => {
        expect(numberFormatter(0)).toBe('0');
        expect(numberFormatter(0, 2)).toBe('0'); // Intl.NumberFormat strips trailing zeros
    });

    test('handles null and undefined', () => {
        expect(numberFormatter(null)).toBe(null);
        expect(numberFormatter(undefined)).toBe(null);
    });

    test('rounds to specified decimal places', () => {
        expect(numberFormatter(1234.999, 0)).toBe('1,235');
        expect(numberFormatter(1234.999, 1)).toBe('1,235'); // Intl.NumberFormat strips trailing zeros
    });

    test('a small negative that rounds to zero displays as 0, not -0', () => {
        // Math.round(-0.4) is the negative zero float, and Intl.NumberFormat
        // renders that as the string "-0" — a value that is actually zero then
        // reads as negative to whoever is looking at it (a slightly-negative
        // floating point remainder is exactly how "missing" or "profit"
        // calculations land on zero in practice).
        expect(numberFormatter(-0.4)).toBe('0');
        // Consistent with numberFormatter(1234.999, 1) below: Intl.NumberFormat
        // strips a trailing ".00" the same way it strips a trailing ".0"
        expect(numberFormatter(-0.001, 2)).toBe('0');
    });
});

describe('timeReadable', () => {
    describe('seconds format (< 1 minute)', () => {
        test('formats seconds only', () => {
            expect(timeReadable(30)).toBe('30s');
            expect(timeReadable(59)).toBe('59s');
        });
    });

    describe('hours:minutes:seconds format (< 1 day)', () => {
        test('formats hours, minutes, and seconds', () => {
            expect(timeReadable(3661)).toBe('1h 01m 01s');
            expect(timeReadable(3600)).toBe('1h 00m 00s');
        });

        test('formats minutes and seconds without hours', () => {
            expect(timeReadable(125)).toBe('0h 02m 05s');
        });
    });

    describe('days format (>= 1 day, < 1 year)', () => {
        test('formats single day', () => {
            expect(timeReadable(86400)).toBe('1 day');
        });

        test('formats days with hours and minutes', () => {
            expect(timeReadable(90000)).toBe('1 day 1h'); // Minutes omitted when 0
        });

        test('formats multiple days', () => {
            expect(timeReadable(172800)).toBe('2 days');
        });

        test('formats days, hours, and minutes', () => {
            expect(timeReadable(93600)).toBe('1 day 2h'); // Minutes omitted when 0
        });
    });

    describe('years format (>= 1 year)', () => {
        test('formats single year', () => {
            expect(timeReadable(31536000)).toBe('1 year');
        });

        test('formats years, months, and days', () => {
            expect(timeReadable(100000000)).toContain('year');
            expect(timeReadable(100000000)).toContain('month');
        });

        test('formats multiple years', () => {
            const result = timeReadable(63072000); // 2 years
            expect(result).toBe('2 years');
        });
    });
});

describe('formatWithSeparator', () => {
    test('formats numbers with thousand separators', () => {
        expect(formatWithSeparator(1000000)).toBe('1,000,000');
        expect(formatWithSeparator(1234567)).toBe('1,234,567');
    });

    test('handles small numbers', () => {
        expect(formatWithSeparator(100)).toBe('100');
        expect(formatWithSeparator(999)).toBe('999');
    });
});

describe('formatKMB', () => {
    test('formats thousands with K suffix', () => {
        expect(formatKMB(1500)).toBe('1.5K');
        expect(formatKMB(1000)).toBe('1.0K');
    });

    test('formats millions with M suffix', () => {
        expect(formatKMB(2300000)).toBe('2.3M');
        expect(formatKMB(1000000)).toBe('1.0M');
    });

    test('formats billions with B suffix', () => {
        expect(formatKMB(1234567890)).toBe('1.2B');
        expect(formatKMB(5000000000)).toBe('5.0B');
    });

    test('formats small numbers without suffix', () => {
        expect(formatKMB(999)).toBe('999');
        expect(formatKMB(500)).toBe('500');
    });

    test('respects decimal parameter', () => {
        expect(formatKMB(1500, 2)).toBe('1.50K');
        expect(formatKMB(1500, 0)).toBe('2K');
    });

    test('handles negative numbers', () => {
        expect(formatKMB(-1500)).toBe('-1.5K');
        expect(formatKMB(-2300000)).toBe('-2.3M');
    });

    test('handles null and undefined', () => {
        expect(formatKMB(null)).toBe(null);
        expect(formatKMB(undefined)).toBe(null);
    });

    test('a small negative that rounds to zero displays as 0, not -0', () => {
        // The sign is decided from the raw number before absNum is rounded, so a
        // fraction like -0.4 that floors/rounds away to nothing still carried its
        // sign onto a "0" that is not actually negative.
        expect(formatKMB(-0.4)).toBe('0');
    });

    test('promotes a value that rounds up to 1000 into the next tier', () => {
        expect(formatKMB(999.6)).toBe('1.0K');
        expect(formatKMB(999950)).toBe('1.0M');
        expect(formatKMB(-999999.999)).toBe('-1.0M');
        expect(formatKMB(999950000)).toBe('1.0B');
        expect(formatKMB(999995000, 2)).toBe('1.00B');
        expect(formatKMB(999500000000, 0)).toBe('1T');
        expect(formatKMB(999950000000000)).toBe('1.0Q');
        // Q has nowhere higher to go
        expect(formatKMB(1e18)).toBe('1000.0Q');
    });
});

describe('formatKMB3Digits', () => {
    test('formats numbers under 1000 as raw numbers', () => {
        expect(formatKMB3Digits(999)).toBe('999');
        expect(formatKMB3Digits(500)).toBe('500');
        expect(formatKMB3Digits(1)).toBe('1');
    });

    test('formats thousands with appropriate decimals', () => {
        expect(formatKMB3Digits(1250)).toBe('1.25K');
        expect(formatKMB3Digits(8210)).toBe('8.21K');
        expect(formatKMB3Digits(82100)).toBe('82.1K');
        expect(formatKMB3Digits(825000)).toBe('825K');
    });

    test('handles rounding edge cases for K', () => {
        expect(formatKMB3Digits(9999)).toBe('10.0K');
        expect(formatKMB3Digits(99999)).toBe('100K');
    });

    test('promotes to M when reaching 1000K', () => {
        expect(formatKMB3Digits(999999)).toBe('1.00M');
    });

    test('formats millions with appropriate decimals', () => {
        expect(formatKMB3Digits(1250000)).toBe('1.25M');
        expect(formatKMB3Digits(82300000)).toBe('82.3M');
        expect(formatKMB3Digits(825000000)).toBe('825M');
    });

    test('formats billions with appropriate decimals', () => {
        expect(formatKMB3Digits(1250000000)).toBe('1.25B');
        expect(formatKMB3Digits(82300000000)).toBe('82.3B');
    });

    test('handles negative numbers', () => {
        expect(formatKMB3Digits(-1250)).toBe('-1.25K');
        expect(formatKMB3Digits(-1250000)).toBe('-1.25M');
    });

    test('a small negative that rounds to zero displays as 0, not -0', () => {
        expect(formatKMB3Digits(-0.4)).toBe('0');
    });

    test('handles null and undefined', () => {
        expect(formatKMB3Digits(null)).toBe(null);
        expect(formatKMB3Digits(undefined)).toBe(null);
    });

    test('promotes billions that round up to 1000B into trillions, instead of overflowing to 4 digits', () => {
        // 999,999,999,999 is 999.999999999B, which rounds to 1000.00 at 2 decimals.
        // The B branch used to have nowhere to promote to, so it displayed "1000B"
        // — a 4-digit figure the "3 significant digit" contract promises never to show.
        expect(formatKMB3Digits(999999999999)).toBe('1.00T');
    });

    test('checks for a fourth digit after rounding at the decimals it prints', () => {
        // 999.5K is 999.50 at two decimals, under the promotion check, but prints
        // with none because it is over 100 — and 999.5 at no decimals is "1000"
        expect(formatKMB3Digits(999500)).toBe('1.00M');
        expect(formatKMB3Digits(-999500)).toBe('-1.00M');
        expect(formatKMB3Digits(999500000000)).toBe('1.00T');
        expect(formatKMB3Digits(99950)).toBe('100K');
    });

    test('returns NaN for NaN instead of throwing', () => {
        expect(formatKMB3Digits(NaN)).toBe('NaN');
    });

    test('formats trillions and quadrillions with the same 3-significant-digit rule as the lower tiers', () => {
        expect(formatKMB3Digits(1250000000000)).toBe('1.25T');
        expect(formatKMB3Digits(82300000000000)).toBe('82.3T');
        expect(formatKMB3Digits(825000000000000)).toBe('825T');
        expect(formatKMB3Digits(1250000000000000)).toBe('1.25Q');
    });
});

describe('coinFormatter', () => {
    test('formats 0-999 as raw numbers', () => {
        expect(coinFormatter(999)).toBe('999');
        expect(coinFormatter(500)).toBe('500');
        expect(coinFormatter(0)).toBe('0');
    });

    test('formats 1,000-9,999 with comma', () => {
        expect(coinFormatter(1000)).toBe('1,000');
        expect(coinFormatter(9999)).toBe('9,999');
        expect(coinFormatter(5000)).toBe('5,000');
    });

    test('formats 10K-9,999K range', () => {
        expect(coinFormatter(10000)).toBe('10K');
        expect(coinFormatter(999999)).toBe('999K');
        expect(coinFormatter(1000000)).toBe('1,000K');
        expect(coinFormatter(9999999)).toBe('9,999K');
    });

    test('formats 10M-9,999M range', () => {
        expect(coinFormatter(10000000)).toBe('10M');
        expect(coinFormatter(999999999)).toBe('999M');
        expect(coinFormatter(1000000000)).toBe('1,000M');
    });

    test('formats 10B-9,999B range', () => {
        expect(coinFormatter(10000000000)).toBe('10B');
        expect(coinFormatter(999999999999)).toBe('999B');
    });

    test('formats 10T+ range', () => {
        expect(coinFormatter(10000000000000)).toBe('10T');
        expect(coinFormatter(1000000000000000)).toBe('1,000T');
    });

    test('handles negative numbers', () => {
        expect(coinFormatter(-1000)).toBe('-1,000');
        expect(coinFormatter(-10000)).toBe('-10K');
    });

    test('a small negative that rounds to zero displays as 0, not -0', () => {
        expect(coinFormatter(-0.4)).toBe('0');
    });

    test('handles null and undefined', () => {
        expect(coinFormatter(null)).toBe(null);
        expect(coinFormatter(undefined)).toBe(null);
    });
});

describe('formatRelativeTime', () => {
    test('formats "Just now" for < 1 minute', () => {
        expect(formatRelativeTime(30000)).toBe('Just now');
        expect(formatRelativeTime(59999)).toBe('Just now');
    });

    test('formats minutes only', () => {
        expect(formatRelativeTime(300000)).toBe('5m');
        expect(formatRelativeTime(600000)).toBe('10m');
    });

    test('formats hours and minutes', () => {
        expect(formatRelativeTime(7200000)).toBe('2h 0m');
        expect(formatRelativeTime(9000000)).toBe('2h 30m');
    });

    test('formats days and hours', () => {
        expect(formatRelativeTime(93600000)).toBe('1d 2h');
        expect(formatRelativeTime(172800000)).toBe('2d 0h');
    });

    test('formats days only for > 7 days', () => {
        expect(formatRelativeTime(864000000)).toBe('10d');
        expect(formatRelativeTime(1296000000)).toBe('15d');
    });

    test('formats "30+ days" for > 30 days', () => {
        expect(formatRelativeTime(2678400000)).toBe('30+ days');
        expect(formatRelativeTime(5000000000)).toBe('30+ days');
    });
});

describe('networthFormatter', () => {
    test('formats numbers under 1000 as raw numbers', () => {
        expect(networthFormatter(999)).toBe('999');
        expect(networthFormatter(500)).toBe('500');
    });

    test('formats thousands with 2 decimals', () => {
        expect(networthFormatter(1234)).toBe('1.23K');
        expect(networthFormatter(45678)).toBe('45.68K');
    });

    test('formats millions with 2 decimals', () => {
        expect(networthFormatter(1234567)).toBe('1.23M');
        expect(networthFormatter(89012345)).toBe('89.01M');
    });

    test('formats billions with 2 decimals', () => {
        expect(networthFormatter(1234567890)).toBe('1.23B');
        expect(networthFormatter(89012345678)).toBe('89.01B');
    });

    test('formats trillions with 2 decimals', () => {
        expect(networthFormatter(6320000000000)).toBe('6.32T');
    });

    test('formats quadrillions with 2 decimals', () => {
        expect(networthFormatter(6320000000000000)).toBe('6.32Q');
    });

    test('stays in Q beyond quadrillions rather than adding another suffix', () => {
        expect(networthFormatter(6320000000000000000)).toBe('6320.00Q');
    });

    test('rolls a value that rounds up to 1000 into the next tier, at every boundary', () => {
        // K -> M
        expect(networthFormatter(999995)).toBe('1.00M');
        // M -> B
        expect(networthFormatter(999995000)).toBe('1.00B');
        // B -> T
        expect(networthFormatter(999995000000)).toBe('1.00T');
        // T -> Q
        expect(networthFormatter(999995000000000)).toBe('1.00Q');
    });

    test('values below 1e12 are unaffected by the T/Q tiers (pinned pre-existing outputs)', () => {
        expect(networthFormatter(999)).toBe('999');
        expect(networthFormatter(1234)).toBe('1.23K');
        expect(networthFormatter(45678)).toBe('45.68K');
        expect(networthFormatter(1234567)).toBe('1.23M');
        expect(networthFormatter(89012345)).toBe('89.01M');
        expect(networthFormatter(1234567890)).toBe('1.23B');
        expect(networthFormatter(89012345678)).toBe('89.01B');
    });

    test('handles negative numbers', () => {
        expect(networthFormatter(-1234)).toBe('-1.23K');
        expect(networthFormatter(-1234567)).toBe('-1.23M');
        expect(networthFormatter(-6320000000000)).toBe('-6.32T');
        expect(networthFormatter(-6320000000000000)).toBe('-6.32Q');
    });

    test('handles a negative value that rolls into the next tier', () => {
        expect(networthFormatter(-999995000000)).toBe('-1.00T');
    });

    test('a small negative that rounds to zero displays as 0, not -0', () => {
        expect(networthFormatter(-0.4)).toBe('0');
    });

    test('handles null and undefined', () => {
        expect(networthFormatter(null)).toBe(null);
        expect(networthFormatter(undefined)).toBe(null);
    });

    test('does not throw for NaN (e.g. Math.round of a missing value upstream)', () => {
        expect(() => networthFormatter(NaN)).not.toThrow();
        expect(networthFormatter(NaN)).toBe('NaNB');
    });
});

describe('parseKMB', () => {
    test.each([
        ['1.5t', 1.5e12],
        ['2q', 2e15],
        ['2Q', 2e15],
        ['500m', 5e8],
        ['1.5b', 1.5e9],
        ['100k', 1e5],
        ['500,000,000', 5e8],
    ])('%j → %d', (text, expected) => expect(parseKMB(text)).toBe(expected));

    test.each(['12xyz', '1.5x', ''])('%j is not an amount', (text) => expect(parseKMB(text)).toBeNaN());

    test('reads every suffix number-parser reads', () => {
        for (const [letter, scale] of Object.entries(MAGNITUDE_SUFFIXES)) {
            expect(parseKMB(`3${letter}`)).toBe(3 * scale);
        }
    });
});

describe('formatThreshold', () => {
    test('abbreviates trillions and quadrillions instead of stopping at B', () => {
        expect(formatThreshold(1.5e12, 2)).toBe('1.50T');
        expect(formatThreshold(-1.5e12, 2)).toBe('-1.50T');
        expect(formatThreshold(6.32e15, 2)).toBe('6.32Q');
    });

    test('promotes a value that rounds up to 1000 into the next tier', () => {
        expect(formatThreshold(999950, 1)).toBe('1.0M');
        expect(formatThreshold(999999.999, 2)).toBe('1.00M');
        expect(formatThreshold(999995000000, 2)).toBe('1.00T');
        expect(formatThreshold(10000, 2)).toBe('10.00K');
    });

    test('a small negative that rounds to zero displays as 0, not -0', () => {
        expect(formatThreshold(-0.4)).toBe('0');
    });

    test('still signs a negative that actually is one', () => {
        expect(formatThreshold(-5)).toBe('-5');
        expect(formatThreshold(-12345)).toBe('-12.3K');
    });
});

describe('formatPercentage', () => {
    test('formats decimal as percentage with 1 decimal', () => {
        expect(formatPercentage(0.05)).toBe('5.0%');
        expect(formatPercentage(0.125)).toBe('12.5%');
    });

    test('respects decimal parameter', () => {
        expect(formatPercentage(0.00123, 2)).toBe('0.12%');
        expect(formatPercentage(0.00123, 3)).toBe('0.123%');
    });

    test('handles whole percentages', () => {
        expect(formatPercentage(1.0)).toBe('100.0%');
        expect(formatPercentage(0.5)).toBe('50.0%');
    });

    test('handles null and undefined', () => {
        expect(formatPercentage(null)).toBe(null);
        expect(formatPercentage(undefined)).toBe(null);
    });

    test('a small negative that rounds to zero displays as 0.0%, not -0.0%', () => {
        // minimumFractionDigits keeps the trailing zeros here (unlike the plain
        // formatters above, whose Intl.NumberFormat call strips them), which is
        // what makes the signed-zero artifact visible instead of disappearing
        // along with the fraction.
        expect(formatPercentage(-0.0001)).toBe('0.0%');
    });
});

describe('formatCurrency', () => {
    test('defaults to game style', () => {
        expect(formatCurrency(1500)).toBe('1,500');
        expect(formatCurrency(1500000)).toBe('1,500K');
    });

    test('formats with game style', () => {
        expect(formatCurrency(1500, { style: 'game' })).toBe('1,500');
        expect(formatCurrency(1500000, { style: 'game' })).toBe('1,500K');
    });

    test('formats with compact style', () => {
        expect(formatCurrency(1500000, { style: 'compact' })).toBe('1.5M');
        expect(formatCurrency(1500000, { style: 'compact', decimals: 2 })).toBe('1.50M');
    });

    test('formats with networth style', () => {
        expect(formatCurrency(1234, { style: 'networth' })).toBe('1.23K');
        expect(formatCurrency(1234567, { style: 'networth' })).toBe('1.23M');
    });

    test('formats with full style', () => {
        expect(formatCurrency(1500000, { style: 'full' })).toBe('1,500,000');
        expect(formatCurrency(1234567, { style: 'full' })).toBe('1,234,567');
    });
});

describe('formatCompactNumber', () => {
    test('is an alias for formatKMB', () => {
        expect(formatCompactNumber(1500)).toBe('1.5K');
        expect(formatCompactNumber(2300000)).toBe('2.3M');
        expect(formatCompactNumber(1234567890)).toBe('1.2B');
    });

    test('respects decimal parameter', () => {
        expect(formatCompactNumber(1500, 2)).toBe('1.50K');
        expect(formatCompactNumber(1500, 0)).toBe('2K');
    });
});

describe('formatLargeNumber', () => {
    test('uses K/M/B format when enabled', () => {
        expect(formatLargeNumber(1500000)).toBe('1.5M');
        expect(formatLargeNumber(2300)).toBe('2.3K');
    });

    test('respects decimal parameter', () => {
        expect(formatLargeNumber(1500000, 2)).toBe('1.50M');
        expect(formatLargeNumber(2300, 0)).toBe('2K');
    });
});

describe('isSameLocalDay', () => {
    test('two instants on the same calendar day match', () => {
        const morning = new Date(2026, 7, 27, 1, 0, 0).getTime();
        const evening = new Date(2026, 7, 27, 23, 0, 0).getTime();
        expect(isSameLocalDay(morning, evening)).toBe(true);
    });

    test('an hour apart across midnight does not match', () => {
        const before = new Date(2026, 7, 27, 23, 30, 0).getTime();
        const after = new Date(2026, 7, 28, 0, 30, 0).getTime();
        expect(isSameLocalDay(before, after)).toBe(false);
    });

    test('the same day one year apart does not match', () => {
        const thisYear = new Date(2026, 7, 27, 12, 0, 0).getTime();
        const lastYear = new Date(2025, 7, 27, 12, 0, 0).getTime();
        expect(isSameLocalDay(thisYear, lastYear)).toBe(false);
    });
});

describe('formatActivityStatusTime', () => {
    const now = new Date(2026, 7, 27, 12, 0, 0).getTime();

    test('a time later today needs no date', () => {
        const later = new Date(2026, 7, 27, 18, 30, 0).getTime();
        expect(formatActivityStatusTime(later, { timeFormat: '24hour' }, now)).toBe('18:30');
    });

    test('a different day carries a short date, in the requested order', () => {
        const tomorrow = new Date(2026, 7, 28, 6, 5, 0).getTime();
        expect(formatActivityStatusTime(tomorrow, { dateFormat: 'MM-DD', timeFormat: '24hour' }, now)).toBe(
            '08-28 06:05'
        );
        expect(formatActivityStatusTime(tomorrow, { dateFormat: 'DD-MM', timeFormat: '24hour' }, now)).toBe(
            '28-08 06:05'
        );
    });

    test('12-hour preference is honoured', () => {
        const later = new Date(2026, 7, 27, 18, 30, 0).getTime();
        expect(formatActivityStatusTime(later, { timeFormat: '12hour' }, now)).toBe('6:30 PM');
    });

    test('no preferences at all still formats, on the schema defaults', () => {
        const later = new Date(2026, 7, 27, 18, 30, 0).getTime();
        expect(formatActivityStatusTime(later, {}, now)).toBe('18:30');
    });
});
