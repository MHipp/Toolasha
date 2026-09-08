import { describe, test, expect, vi } from 'vitest';
import { CLEAR_FOLD_LIMIT, clearedAtOf, clearedRecord, entriesOf, mergeClearable } from './cleared-record.js';

/** The union these records already had: everything from both sides, by id */
const union = (base, fresh) => {
    const byId = new Map();
    for (const entry of [...base, ...fresh]) byId.set(entry.id, entry);
    return [...byId.values()].sort((a, b) => a.at - b.at);
};
const fold = mergeClearable(union, (entry) => entry?.at, { label: 'test' });
const at = (id, moment) => ({ id, at: moment });

describe('reading either shape', () => {
    test('a bare array is what these records held before, and reads as uncleared', () => {
        expect(entriesOf([at('a', 1)])).toEqual([at('a', 1)]);
        expect(clearedAtOf([at('a', 1)])).toBe(0);
    });

    test('anything unreadable is an empty, uncleared record', () => {
        expect(entriesOf(null)).toEqual([]);
        expect(entriesOf({ entries: 'nope' })).toEqual([]);
        expect(clearedAtOf({ clearedAt: 'soon' })).toBe(0);
    });

    test('clearedRecord normalises what it is handed', () => {
        expect(clearedRecord()).toEqual({ clearedAt: 0, entries: [] });
        expect(clearedRecord(null, '5')).toEqual({ clearedAt: 5, entries: [] });
    });
});

describe('a clear survives the fold', () => {
    test('the emptied record wins the round trip a fuller peer would otherwise win', () => {
        // Only the pulling device merges, so a clear that loses on the peer
        // loses everywhere: it comes back to the device that made it next pull
        const full = [at('a', 100), at('b', 200)];
        const cleared = clearedRecord([], 300);

        const peerPulled = fold(full, cleared);
        expect(peerPulled).toEqual({ clearedAt: 300, entries: [] });
        expect(fold(cleared, peerPulled)).toEqual({ clearedAt: 300, entries: [] });
    });

    test('entries the peer recorded after the clear survive it', () => {
        // The ordering hazard, and the reason the epoch is not a boolean
        const cleared = clearedRecord([], 300);
        const peer = clearedRecord([at('a', 100), at('c', 400)], 300);

        expect(fold(cleared, peer).entries).toEqual([at('c', 400)]);
    });

    test('an unstamped copy loses to a stamped clear', () => {
        expect(fold([at('a', 100)], clearedRecord([], 300)).entries).toEqual([]);
    });

    test('a record no clear has touched folds exactly as it did', () => {
        expect(fold([at('a', 100)], [at('b', 200)])).toEqual({
            clearedAt: 0,
            entries: [at('a', 100), at('b', 200)],
        });
    });

    test('the newer of two clears is the one that stands', () => {
        const merged = fold(clearedRecord([at('a', 150)], 100), clearedRecord([], 300));
        expect(merged).toEqual({ clearedAt: 300, entries: [] });
    });
});

describe('the mass-delete refusal', () => {
    const many = (count, from = 100) => Array.from({ length: count }, (_, i) => at(`e-${i}`, from + i));

    test('fires on a clear from elsewhere that would empty a long-lived record', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const local = many(CLEAR_FOLD_LIMIT + 1);

        const merged = fold(local, clearedRecord([], 10_000));

        expect(merged.entries).toHaveLength(CLEAR_FOLD_LIMIT + 1);
        // Held back whole: the epoch is not carried either, so the next fold
        // does not quietly finish what this one refused
        expect(merged.clearedAt).toBe(0);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('never stands in the way of a clear this device already holds', () => {
        const theirs = many(CLEAR_FOLD_LIMIT + 1);
        expect(fold(clearedRecord([], 10_000), theirs).entries).toEqual([]);
    });

    test('the limit itself still applies', () => {
        expect(fold(many(CLEAR_FOLD_LIMIT), clearedRecord([], 10_000)).entries).toEqual([]);
    });

    test('a held-back fold still applies the clear this device does hold', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Ours is an older clear of our own; theirs is a newer one we refuse.
        // Our own still applies to what it covers.
        const local = clearedRecord(many(CLEAR_FOLD_LIMIT + 1, 100), 50);
        const merged = fold(local, clearedRecord([at('ancient', 10)], 10_000));

        expect(merged.clearedAt).toBe(50);
        expect(merged.entries.some((entry) => entry.id === 'ancient')).toBe(false);
        warn.mockRestore();
    });
});
