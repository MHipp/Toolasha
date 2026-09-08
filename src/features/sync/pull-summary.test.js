/**
 * What a pull is allowed to claim it did.
 *
 * The counts here are the ones the apply result can actually support. The test
 * that matters most is the one that pins `unchanged` to unknown: a zero there
 * would read as "nothing else moved", which the pull result cannot say.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
    buildPullSummary,
    formatPullSummaryLine,
    formatPullStoreLine,
    rememberPullSummary,
    lastPullSummary,
    clearPullSummary,
} from './pull-summary.js';

/** One folded key, one whole write and one held key, in one store */
const oneOfEach = {
    merged: [{ store: 'guildHistory', key: 'trials', label: 'trial records' }],
    mergeHeld: [{ store: 'guildHistory', key: 'chests', label: 'chest tallies' }],
    // The held key was dropped from the payload, so the store was asked for two:
    // the fold and the whole write
    expected: { guildHistory: 2 },
};

beforeEach(() => {
    clearPullSummary();
});

describe('the counts', () => {
    test('one folded key, one whole write and one held key are counted apart', () => {
        const summary = buildPullSummary(oneOfEach);

        expect(summary.combined).toBe(1);
        expect(summary.writtenWhole).toBe(1);
        expect(summary.held).toBe(1);
        expect(summary.writtenWholePartial).toBe(false);
        expect(summary.stores).toHaveLength(1);
        expect(summary.stores[0]).toMatchObject({
            store: 'guildHistory',
            combined: 1,
            writtenWhole: 1,
            held: 1,
            overwritten: 0,
        });
    });

    test('a folded record carries its key and the registration that folded it', () => {
        const summary = buildPullSummary(oneOfEach);
        expect(summary.stores[0].combinedRecords).toEqual([{ key: 'trials', label: 'trial records' }]);
        expect(summary.stores[0].heldRecords).toEqual([{ key: 'chests', label: 'chest tallies' }]);
    });

    test('unchanged is unknown, never zero', () => {
        const summary = buildPullSummary(oneOfEach);
        expect(summary.unchanged).toBeNull();
        expect(summary.stores[0].unchanged).toBeNull();
        expect(formatPullStoreLine(summary.stores[0])).toContain('unchanged unknown');
    });

    test('a fold that threw is written whole and named separately', () => {
        const summary = buildPullSummary({
            mergeFailed: [{ store: 'settings', key: 'plans', label: 'plans' }],
            expected: { settings: 1 },
        });

        expect(summary.overwritten).toBe(1);
        expect(summary.combined).toBe(0);
        // It took the download whole, so it is one of the whole writes too
        expect(summary.writtenWhole).toBe(1);
        expect(formatPullStoreLine(summary.stores[0])).toBe(
            'settings: 0 combined, 1 written whole, 0 held, 1 overwritten, unchanged unknown'
        );
    });

    test('a store with no expected count reports its whole writes as unknown, not zero', () => {
        const summary = buildPullSummary({
            merged: [{ store: 'mystery', key: 'k', label: 'thing' }],
            expected: {},
        });

        expect(summary.stores[0].writtenWhole).toBeNull();
        expect(summary.writtenWholePartial).toBe(true);
        expect(formatPullStoreLine(summary.stores[0])).toContain('written whole unknown');
    });

    test('an empty pull result summarises to nothing rather than throwing', () => {
        const summary = buildPullSummary();
        expect(summary).toMatchObject({ combined: 0, writtenWhole: 0, held: 0, stores: [] });
    });
});

describe('the toast line', () => {
    test('names only the outcomes that happened', () => {
        expect(formatPullSummaryLine(buildPullSummary(oneOfEach))).toBe(
            'Pull applied: 1 record combined, 1 written whole, 1 held unreadable.'
        );
    });

    test('pluralises, and drops the clauses that are zero', () => {
        const summary = buildPullSummary({
            merged: [
                { store: 's', key: 'a', label: 'a' },
                { store: 's', key: 'b', label: 'b' },
            ],
            expected: { s: 5 },
        });
        expect(formatPullSummaryLine(summary)).toBe('Pull applied: 2 records combined, 3 written whole.');
    });

    test('an unknown store count makes the whole-write figure a floor', () => {
        const summary = buildPullSummary({
            merged: [{ store: 'known', key: 'a', label: 'a' }],
            mergeHeld: [{ store: 'mystery', key: 'b', label: 'b' }],
            expected: { known: 3 },
        });
        expect(formatPullSummaryLine(summary)).toBe(
            'Pull applied: 1 record combined, at least 2 written whole, 1 held unreadable.'
        );
    });

    test('a pull that changed nothing says so', () => {
        expect(formatPullSummaryLine(buildPullSummary())).toBe('Pull applied: no records changed.');
        expect(formatPullSummaryLine(null)).toBe('');
    });
});

describe('the session memory', () => {
    test('a second pull replaces the first, and a clear empties it', () => {
        rememberPullSummary(buildPullSummary(oneOfEach));
        expect(lastPullSummary().combined).toBe(1);

        rememberPullSummary(buildPullSummary({ expected: { settings: 4 } }));
        expect(lastPullSummary().combined).toBe(0);
        expect(lastPullSummary().writtenWhole).toBe(4);

        clearPullSummary();
        expect(lastPullSummary()).toBeNull();
    });
});
