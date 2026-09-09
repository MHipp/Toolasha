/**
 * The daily price band a marketplace modal states, and clamping into it.
 *
 * Lifted out of `features/market/auto-fill-price.js` so the buy-modal autofill
 * in `utils/marketplace-autofill.js` can honour the same band. A util two
 * feature bundles both reach must not import a feature module — a named import
 * across bundles compiles to `undefined` — so the band lives here and
 * `auto-fill-price.js` re-exports it for its existing callers.
 */

import { parseItemCount } from './number-parser.js';

/**
 * The tradable range a listing modal states, when it states one.
 *
 * The game bounds each item's postable prices to a daily band ("Tradable
 * range: 307M – 375M"), but the best standing offer can sit OUTSIDE it — a
 * stale order from before the band moved. Matching that offer fills a price
 * the range no longer admits, and a buy listing under the floor is one nobody
 * can sell to.
 *
 * @param {string} text - The modal's text content
 * @returns {{min: number, max: number}|null} The band, or null when unstated
 */
export function tradableRangeFrom(text) {
    const match = String(text || '').match(/tradable range:?\s*([\d.,\s]+[kmbt]?)\s*[–—-]\s*([\d.,\s]+[kmbt]?)/i);
    if (!match) return null;
    const min = parseItemCount(match[1], NaN);
    const max = parseItemCount(match[2], NaN);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
    return { min, max };
}

/**
 * Where a price outside the band should land: the nearest admitted bound.
 * @param {number} price - The filled price
 * @param {{min: number, max: number}} range - The band
 * @returns {number} The price, clamped into the band
 */
export function clampToRange(price, range) {
    return Math.min(Math.max(price, range.min), range.max);
}
