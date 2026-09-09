/**
 * Which way round the client writes a numeric date, and the date a chat stamp
 * therefore means.
 *
 * The chat stamps this exists for carry no year and no clue which number is the
 * month, so the answer has to come from the locale itself rather than from the
 * digits.
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { detectDayFirst, isDayFirstLocale, chatStampToDate, _resetDateFieldOrder } from './locale-date-order.js';

afterEach(() => _resetDateFieldOrder());

/** Pretend the client renders dates in this order, whatever the runtime's locale is. */
const clientOrder = (dayFirst) => _resetDateFieldOrder(dayFirst);

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

describe('reading a chat stamp as a date', () => {
    const NOW = new Date(2028, 11, 15, 12, 0, 0);
    const stamp = (fields, now = NOW) =>
        chatStampToDate({ ambiguousOrder: true, hour: 10, minute: 0, sec: 0, ...fields }, now);

    beforeEach(() => clientOrder(true));

    test('both fields under thirteen follow the locale', () => {
        expect(stamp({ first: 4, second: 3 })).toEqual(new Date(2028, 2, 4, 10, 0, 0, 0));
        clientOrder(false);
        expect(stamp({ first: 4, second: 3 })).toEqual(new Date(2028, 3, 3, 10, 0, 0, 0));
    });

    test('a field over twelve overrules the locale, either way round', () => {
        expect(stamp({ first: 16, second: 7 })).toEqual(new Date(2028, 6, 16, 10, 0, 0, 0));
        expect(stamp({ first: 7, second: 16 })).toEqual(new Date(2028, 6, 16, 10, 0, 0, 0));
    });

    test('a stamp no reading can make a date is dropped', () => {
        expect(stamp({ first: 16, second: 16 })).toBeNull();
    });

    test('the unambiguous separators are day-first whatever the locale says', () => {
        clientOrder(false);
        expect(stamp({ first: 4, second: 8, ambiguousOrder: false })).toEqual(new Date(2028, 7, 4, 10, 0, 0, 0));
    });

    test('AM/PM is applied around noon and midnight', () => {
        expect(stamp({ first: 4, second: 3, hour: 1, period: 'PM' })).toEqual(new Date(2028, 2, 4, 13, 0, 0, 0));
        expect(stamp({ first: 4, second: 3, hour: 12, period: 'AM' })).toEqual(new Date(2028, 2, 4, 0, 0, 0, 0));
        expect(stamp({ first: 4, second: 3, hour: 12, period: 'PM' })).toEqual(new Date(2028, 2, 4, 12, 0, 0, 0));
    });

    test('a stamp the current year would put in the future is last year', () => {
        const newYear = new Date(2028, 0, 1, 0, 30, 0);
        expect(stamp({ first: 31, second: 12, hour: 23, minute: 58 }, newYear)).toEqual(
            new Date(2027, 11, 31, 23, 58, 0, 0)
        );
        expect(stamp({ first: 1, second: 1, hour: 0, minute: 2 }, newYear)).toEqual(new Date(2028, 0, 1, 0, 2, 0, 0));
    });

    test('a stamp a little ahead of a slow clock stays in this year', () => {
        const slow = new Date(2028, 5, 10, 12, 0, 0);
        expect(stamp({ first: 10, second: 6, hour: 12, minute: 5 }, slow)).toEqual(new Date(2028, 5, 10, 12, 5, 0, 0));
    });
});
