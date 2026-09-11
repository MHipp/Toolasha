/**
 * Stale Capital View — the plain-language price-comparison badge.
 *
 * The modal itself is DOM chrome shared with the Ledger view; this only
 * exercises the pure label/color mapping over a row from `buildStaleCapital`,
 * so it stays testable without building the modal (see trade-ledger-view.test.js
 * for the same convention).
 */

import { describe, test, expect } from 'vitest';
import { priceComparisonBadge } from './stale-capital-view.js';

describe('priceComparisonBadge', () => {
    test('an unpriceable row is labeled "unknown", never a guessed comparison', () => {
        const row = { isSell: true, priceComparison: null };
        expect(priceComparisonBadge(row)).toEqual({ text: 'unknown', color: '#9ca3af' });
    });

    test('a sell listing priced above the best ask is the losing side (red)', () => {
        const row = { isSell: true, priceComparison: 'above' };
        const badge = priceComparisonBadge(row);
        expect(badge.text).toBe('above best ask');
        expect(badge.color).toBe('#f87171');
    });

    test('a sell listing priced below the best ask is the winning side (green)', () => {
        const row = { isSell: true, priceComparison: 'below' };
        const badge = priceComparisonBadge(row);
        expect(badge.text).toBe('below best ask');
        expect(badge.color).toBe('#4ade80');
    });

    test('a buy order priced below the best bid is the losing side (red)', () => {
        const row = { isSell: false, priceComparison: 'below' };
        const badge = priceComparisonBadge(row);
        expect(badge.text).toBe('below best bid');
        expect(badge.color).toBe('#f87171');
    });

    test('a buy order priced above the best bid is the winning side (green)', () => {
        const row = { isSell: false, priceComparison: 'above' };
        const badge = priceComparisonBadge(row);
        expect(badge.text).toBe('above best bid');
        expect(badge.color).toBe('#4ade80');
    });

    test('matching the book exactly is neutral for either side', () => {
        expect(priceComparisonBadge({ isSell: true, priceComparison: 'at' })).toEqual({
            text: 'at best ask',
            color: '#9ca3af',
        });
        expect(priceComparisonBadge({ isSell: false, priceComparison: 'at' })).toEqual({
            text: 'at best bid',
            color: '#9ca3af',
        });
    });
});
