/**
 * Order book reading
 *
 * How deep a price level is, and how long an order placed there would wait.
 *
 * The game sends an order book with each listing's creation timestamp, and those
 * timestamps are the only rate signal available anywhere: twenty listings at one
 * price spanning ten minutes is a level that churns, and twenty spanning a week
 * is a level where an order is a week-long proposition.
 *
 * ## The assumption, stated
 *
 * Fill time is estimated as **depth ahead ÷ the rate at which depth arrived**.
 * That is the steady-state assumption — that a price level drains about as fast
 * as it fills — which holds in a liquid market and fails in a moving one. It is
 * the honest reading of what the data can support: the book says how fast orders
 * *arrive*, and nothing directly says how fast they are *taken*.
 *
 * The queue extrapolation is Ranged Way Idle's, by way of the queue length
 * estimator this shares its arithmetic with.
 */

/** The book only ever sends this many listings per side */
const VISIBLE_LISTINGS = 20;

/**
 * The best price on one side of the book.
 *
 * Listings arrive best-first, so this is simply the head — but reading it
 * through a function keeps the assumption in one place rather than in every
 * caller that indexes `[0]`.
 *
 * @param {Array<Object>} listings - One side of the book
 * @returns {number|null} The price, or null when the side is empty
 */
export function bestPrice(listings) {
    const price = listings?.[0]?.price;
    return price > 0 ? price : null;
}

/**
 * How much sits at a price, extrapolating past the twenty the game shows.
 *
 * When all twenty visible listings share the best price, the level is deeper
 * than the window and the timestamps are used to guess by how much — the same
 * extrapolation the queue length display makes, so the two never disagree.
 *
 * @param {Array<Object>} listings - One side of the book
 * @param {number} price - The price level to measure
 * @returns {{quantity: number, estimated: boolean, spanMs: number}} Depth at that price
 */
export function queueAt(listings, price) {
    const rows = listings || [];

    let quantity = 0;
    for (const listing of rows) {
        if (listing?.price === price) quantity += listing.quantity || 0;
    }

    // Fewer than a full window means the level is fully visible, and the count
    // is a fact rather than an estimate
    if (rows.length < VISIBLE_LISTINGS || rows[VISIBLE_LISTINGS - 1]?.price !== price) {
        return { quantity, estimated: false, spanMs: listingSpanMs(rows) };
    }

    const spanMs = listingSpanMs(rows);
    if (!(spanMs > 0)) return { quantity, estimated: false, spanMs };

    // Nothing has arrived since the newest listing when it arrived a moment ago,
    // which extrapolates to exactly the visible depth — a real answer, not an
    // inapplicable one, so it still counts as estimated
    const sinceLast = Math.max(0, Date.now() - new Date(rows[VISIBLE_LISTINGS - 1].createdTimestamp).getTime());

    // Ranged Way Idle's formula: the window covers a known stretch of time, and
    // the rest of the queue is assumed to have arrived at the same rate
    const multiplier = 1 + ((VISIBLE_LISTINGS - 1) / VISIBLE_LISTINGS) * (sinceLast / spanMs);
    return { quantity: quantity * multiplier, estimated: true, spanMs };
}

/**
 * How long the visible listings took to accumulate.
 * @param {Array<Object>} listings - One side of the book
 * @returns {number} Milliseconds, or 0 when it cannot be told
 */
function listingSpanMs(listings) {
    const rows = listings || [];
    if (rows.length < 2) return 0;

    const first = new Date(rows[0]?.createdTimestamp).getTime();
    const last = new Date(rows[rows.length - 1]?.createdTimestamp).getTime();
    const span = Math.abs(last - first);
    return Number.isFinite(span) ? span : 0;
}

/**
 * How long an order joining the back of a queue would wait.
 *
 * Depth ahead divided by the rate depth arrived at — see the note at the top of
 * this file for why that is the rate being used and what it assumes. Returns
 * null rather than a guess when the book gives nothing to measure, so a caller
 * can tell "slow" apart from "unknown".
 *
 * @param {Array<Object>} listings - The side the order would join
 * @param {number} count - How many the order is for
 * @returns {number|null} Seconds, or null when unmeasurable
 */
export function estimateFillSeconds(listings, count) {
    const price = bestPrice(listings);
    if (price === null) return null;

    const { quantity, spanMs } = queueAt(listings, price);
    if (!(spanMs > 0)) return null;

    // Quantity that arrived across the window, which is the rate's numerator.
    // The extrapolated total is what the order waits behind, not what arrived.
    let arrived = 0;
    for (const listing of listings) {
        if (listing?.price === price) arrived += listing.quantity || 0;
    }
    if (!(arrived > 0)) return null;

    const perSecond = arrived / (spanMs / 1000);
    // The order's own quantity counts: it is not filled until all of it is
    return (quantity + count) / perSecond;
}

/**
 * What a quantity would fetch (or cost) against one side of a book.
 *
 * Walks the listings in the order the game sends them — best first — taking
 * from each until the quantity is met. The counterpart to {@link bestPrice} for
 * anything valuing more than one unit: a batch quoted at the top price alone
 * overstates a sale and understates a purchase by however much the book slopes.
 *
 * `filled` short of `quantity` is the answer, not a failure: the game only ever
 * sends twenty listings per side, so a book that runs out has genuinely not
 * said what the rest of the batch is worth. Callers report the shortfall rather
 * than extrapolating past it.
 *
 * `price` is the level the walk stopped on — the worst price a buyer of the
 * whole quantity has to accept, and so the lowest price whose *cumulative*
 * supply covers it. Null when nothing was taken.
 *
 * @param {Array<{price: number, quantity: number}>} listings - One side of the book, best first
 * @param {number} quantity - How many units to walk for
 * @returns {{filled: number, gold: number, covered: boolean, price: number|null}} Units the
 *   book covered, what they come to, whether the whole quantity was covered, and the
 *   price level the walk ended on
 */
export function walkForQuantity(listings, quantity) {
    const wanted = Number(quantity) > 0 ? Number(quantity) : 0;
    let filled = 0;
    let gold = 0;
    let last = null;

    for (const listing of listings || []) {
        if (filled >= wanted) break;
        const price = Number(listing?.price);
        const available = Number(listing?.quantity);
        if (!(price > 0) || !(available > 0)) continue;
        const take = Math.min(wanted - filled, available);
        filled += take;
        gold += take * price;
        last = price;
    }

    return { filled, gold, covered: wanted > 0 && filled >= wanted, price: last };
}

/**
 * The lowest price at which a side's cumulative supply first covers a quantity.
 *
 * What a "Buy Now" at the best ask has to be raised to for the whole order to
 * go through: the top of the book only ever holds the units listed at the top
 * price, so a larger order has to reach down to the level where the running
 * total finally meets it.
 *
 * Null when the known ladder never gets there — the game sends only its top
 * rows, so a book that runs out has not said what the covering price is, and
 * guessing one would raise a price for no stated gain.
 *
 * @param {Array<{price: number, quantity: number}>} listings - Ask side, best first
 * @param {number} quantity - Units wanted
 * @returns {number|null} The covering price, or null when the book does not cover it
 */
export function priceCoveringQuantity(listings, quantity) {
    const walk = walkForQuantity(listings, quantity);
    return walk.covered ? walk.price : null;
}

/**
 * The next distinct price above a level on one side of a book.
 *
 * The step the verify loop takes when the modal still says the order is not
 * covered — the cached book was older than the modal, so the next rung of the
 * ladder is the next thing worth trying.
 *
 * @param {Array<{price: number, quantity: number}>} listings - Ask side, best first
 * @param {number} price - The level already tried
 * @returns {number|null} The next higher listed price, or null when there is none
 */
export function nextPriceAbove(listings, price) {
    const floor = Number(price);
    let best = null;
    for (const listing of listings || []) {
        const candidate = Number(listing?.price);
        if (!(candidate > 0) || !(candidate > floor)) continue;
        if (best === null || candidate < best) best = candidate;
    }
    return best;
}

/**
 * How many whole units a budget buys against one side of a book.
 *
 * The inverse of {@link walkForQuantity} for the buy side: spend down the ask
 * ladder rather than measure a fixed quantity. Partial units are never bought,
 * so each level yields the floor of what the remaining budget covers there.
 *
 * `exhausted` says the walk ran off the end of the book with budget left — the
 * true count is higher than reported, because the listings past the twenty the
 * game sends are not known.
 *
 * @param {Array<{price: number, quantity: number}>} listings - Ask side, best first
 * @param {number} budget - Gold to spend
 * @returns {{units: number, gold: number, exhausted: boolean}} Units bought, gold spent,
 *   and whether the book ran out before the budget did
 */
export function walkForBudget(listings, budget) {
    let remaining = Number(budget) > 0 ? Number(budget) : 0;
    let units = 0;
    let gold = 0;

    for (const listing of listings || []) {
        const price = Number(listing?.price);
        const available = Number(listing?.quantity);
        if (!(price > 0) || !(available > 0)) continue;
        const take = Math.min(available, Math.floor(remaining / price));
        if (take <= 0) return { units, gold, exhausted: false };
        units += take;
        gold += take * price;
        remaining -= take * price;
        // Taking less than the level held means the budget bound here, and every
        // level past this one is dearer — so the book was never the limit
        if (take < available) return { units, gold, exhausted: false };
    }

    return { units, gold, exhausted: remaining > 0 };
}
