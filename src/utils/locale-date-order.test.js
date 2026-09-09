/**
 * Which way round the client writes a numeric date.
 *
 * The chat stamps this exists for carry no year and no clue which number is the
 * month, so the answer has to come from the locale itself rather than from the
 * digits.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { detectDayFirst, isDayFirstLocale, _resetDateFieldOrder } from './locale-date-order.js';

afterEach(() => _resetDateFieldOrder());

describe('detecting the date field order', () => {
    test('day-first locales report day first', () => {
        expect(detectDayFirst('en-GB')).toBe(true);
        expect(detectDayFirst('de-DE')).toBe(true);
        expect(detectDayFirst('nl-NL')).toBe(true);
        expect(detectDayFirst('fr-FR')).toBe(true);
    });

    test('month-first locales report month first', () => {
        expect(detectDayFirst('en-US')).toBe(false);
        expect(detectDayFirst('ja-JP')).toBe(false);
    });

    test('a locale that cannot be resolved falls back to month first', () => {
        expect(detectDayFirst('not a locale')).toBe(false);
    });

    test('the runtime default is resolved once and reused', () => {
        const first = isDayFirstLocale();
        expect(typeof first).toBe('boolean');
        expect(isDayFirstLocale()).toBe(first);
        expect(first).toBe(detectDayFirst(undefined));
    });
});
