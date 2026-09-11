/**
 * Stale Capital
 *
 * Pure arithmetic behind the "what of mine isn't moving?" view: turns the
 * current character's open market listings into ranked rows of coins tied
 * up — sell listings that are not filling, and buy orders sitting unfilled —
 * each with its age and how its price compares to the current book.
 *
 * Deliberately not a recorder: every figure here comes from data the game
 * already hands the data manager on every `market_listings_updated`
 * (`dataManager.getMarketListings()`), so there is nothing to persist and
 * nothing that can show a departed character's rows — call it again after a
 * switch and it can only describe whoever is current now.
 *
 * The view (`src/features/market/stale-capital-view.js`) draws this; this
 * file only computes, so the ranking, the totals, and the unpriceable-item
 * label can all be tested without a DOM.
 */

/** The status HRID the server puts on a listing that is still on the board */
export const ACTIVE_STATUS = '/market_listing_status/active';

/**
 * Units still open on a listing — ordered but not yet filled.
 * @param {Object} listing
 * @returns {number}
 */
function remainingQuantity(listing) {
    return Math.max(0, (listing.orderQuantity || 0) - (listing.filledQuantity || 0));
}

/**
 * Whether a listing still holds capital on the board: active, with something
 * left to fill.
 *
 * A filled/cancelled/expired listing has nothing tied up any more, even when
 * it still carries an unclaimed refund or proceeds — that is "collect what's
 * owed", a different question from "what isn't moving".
 * @param {Object} listing - A row from `dataManager.getMarketListings()`
 * @returns {boolean}
 */
export function isOpenListing(listing) {
    return !!listing && listing.status === ACTIVE_STATUS && remainingQuantity(listing) > 0;
}

/**
 * When a listing was created, in epoch ms — its own `createdTimestamp` when
 * present (the game supplies a real one for your own listings), else null
 * rather than a guess.
 * @param {Object} listing
 * @returns {number|null}
 */
function listingCreatedAt(listing) {
    if (Number.isFinite(listing.timestamp)) return listing.timestamp;
    const parsed = Date.parse(listing.createdTimestamp);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How a listing's own price compares to the current best price on its side
 * of the book. Side-independent: "above"/"below" here is purely numeric —
 * the view is what explains what that means for a sell vs. a buy row.
 * @param {number} price - The listing's own price
 * @param {number|null|undefined} bestPrice - Current best ask/bid, or null/undefined when unknown
 * @returns {'above'|'at'|'below'|null} null when `bestPrice` could not be read
 */
export function comparePriceToBook(price, bestPrice) {
    if (typeof bestPrice !== 'number' || !Number.isFinite(bestPrice)) return null;
    if (price === bestPrice) return 'at';
    return price > bestPrice ? 'above' : 'below';
}

/**
 * One row for the stale-capital view.
 * @param {Object} listing - An open listing (see {@link isOpenListing})
 * @param {number} now - Clock, injectable for tests
 * @param {number|null} bestPrice - Current best ask (sell rows) / bid (buy rows), or
 *   null when the item's current price could not be read
 * @returns {Object} A row: id, itemHrid, enhancementLevel, isSell, quantity, price,
 *   coinsTiedUp, ageMs (null when undatable), priceComparison, bestPrice
 */
export function buildRow(listing, now, bestPrice) {
    const quantity = remainingQuantity(listing);
    const createdAt = listingCreatedAt(listing);
    const normalizedBestPrice = typeof bestPrice === 'number' && Number.isFinite(bestPrice) ? bestPrice : null;
    return {
        id: listing.id,
        itemHrid: listing.itemHrid,
        enhancementLevel: listing.enhancementLevel || 0,
        isSell: listing.isSell === true,
        quantity,
        price: listing.price,
        // Quantity remaining × the listing's own price — always knowable from
        // the listing itself, never dependent on whether the current book can
        // be read (that only governs `priceComparison`/`bestPrice` below).
        coinsTiedUp: quantity * (listing.price || 0),
        ageMs: createdAt !== null ? Math.max(0, now - createdAt) : null,
        priceComparison: comparePriceToBook(listing.price, normalizedBestPrice),
        bestPrice: normalizedBestPrice,
    };
}

/**
 * Rows ranked by coins tied up (highest first), oldest breaking a tie.
 * @param {Array<Object>} rows - From {@link buildRow}
 * @returns {Array<Object>} A new, sorted array
 */
function rankByCoinsTiedUp(rows) {
    return [...rows].sort((a, b) => b.coinsTiedUp - a.coinsTiedUp || (b.ageMs ?? -1) - (a.ageMs ?? -1));
}

/**
 * Sum of coins tied up across a set of rows.
 * @param {Array<Object>} rows
 * @returns {number}
 */
function sumCoinsTiedUp(rows) {
    return rows.reduce((sum, row) => sum + row.coinsTiedUp, 0);
}

/**
 * Split the current character's open listings into ranked sell/buy rows, with
 * a coins-tied-up total per side.
 * @param {Array<Object>} listings - `dataManager.getMarketListings()`, as-is
 * @param {(itemHrid: string, enhancementLevel: number, isSell: boolean) => number|null} getBestPrice -
 *   Current best ask (isSell) / bid (!isSell) for an item+level, or null when unknown
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{sellRows: Array<Object>, buyRows: Array<Object>, sellTotal: number, buyTotal: number}}
 */
export function buildStaleCapital(listings, getBestPrice, now = Date.now()) {
    const sellRows = [];
    const buyRows = [];

    for (const listing of listings || []) {
        if (!isOpenListing(listing)) continue;
        const isSell = listing.isSell === true;
        const enhancementLevel = listing.enhancementLevel || 0;
        const bestPrice = getBestPrice(listing.itemHrid, enhancementLevel, isSell);
        const row = buildRow(listing, now, bestPrice);
        (isSell ? sellRows : buyRows).push(row);
    }

    const sellRanked = rankByCoinsTiedUp(sellRows);
    const buyRanked = rankByCoinsTiedUp(buyRows);

    return {
        sellRows: sellRanked,
        buyRows: buyRanked,
        sellTotal: sumCoinsTiedUp(sellRanked),
        buyTotal: sumCoinsTiedUp(buyRanked),
    };
}
