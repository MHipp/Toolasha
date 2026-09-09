/**
 * Market Prices
 *
 * A price cache that remembers how much was resting at the top of each book,
 * not just what it cost.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * The game's marketplace.json publishes a best ask and a best bid and nothing
 * else — no size. That is enough to say what an item is worth and useless for
 * saying whether you can trade it: a 40k spread with one unit at the ask is a
 * curiosity, the same spread with eight hundred is a trade. The order books the
 * game pushes when you open an item do carry size, so a sighting seen that way
 * is kept with its quantities. Readings are folded newest-wins by timestamp,
 * though: a fresher marketplace.json snapshot (which carries no size) replaces
 * an older order-book reading and resets its sizes to zero, so a stored size
 * lasts only until the next snapshot re-reads that item. Consumers that need
 * depth must treat a zero size as "unknown", not "none listed".
 *
 * Pure: entries in, entries out. Storage and sockets live in the feature module.
 */

/** Entries untouched for this long are dropped rather than kept forever */
export const PRICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The key one price is held under. An enhanced item is a different market from
 * its plain form and never shares a price with it.
 * @param {string} itemHrid - Item
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {string}
 */
export function priceKey(itemHrid, enhancementLevel = 0) {
    return `${itemHrid}:${Math.max(0, Math.floor(Number(enhancementLevel) || 0))}`;
}

/**
 * Read one side of an order book into a price and the size resting at it.
 * @param {Array<Object>} orders - Orders, best first
 * @returns {{price: number, quantity: number}} price is -1 when the side is empty
 */
export function topOfSide(orders) {
    const list = (Array.isArray(orders) ? orders : []).filter(Boolean);
    if (!list.length) return { price: -1, quantity: 0 };

    const price = list[0].price;
    const quantity = list
        .filter((order) => order.price === price)
        .reduce((sum, order) => sum + Math.max(0, Number(order.quantity) || 0), 0);
    return { price, quantity };
}

/**
 * Fold one order book into an entry.
 * @param {Object|null} book - { asks, bids }
 * @param {number} at - Timestamp (ms)
 * @returns {Object} { ask, bid, askQty, bidQty, at }
 */
export function entryFromBook(book, at) {
    const ask = topOfSide(book?.asks);
    const bid = topOfSide(book?.bids);
    return { ask: ask.price, bid: bid.price, askQty: ask.quantity, bidQty: bid.quantity, at };
}

/**
 * Take a newer reading of one item, if it is in fact newer.
 *
 * The percentage move is kept against the reading it replaced, which is what a
 * watchlist chip shows. Measured on ask plus bid rather than either alone: a
 * book whose ask vanishes and returns would otherwise report a move of hundreds
 * of percent with nothing having happened.
 *
 * How long that move took is kept beside it, because a percentage on its own is
 * not a move. The pooled dataset updates on the community's trading activity
 * rather than a clock, so the gap between two readings of a busy item is
 * minutes and the gap between two readings of a quiet one can be days — and
 * "2.1%" means opposite things across those two spans. A reader shown the
 * figure without the span has no way to tell which they are looking at, so the
 * span rides with it and the chip declines to draw a move it cannot date.
 *
 * @param {Object|undefined} existing - What is held now
 * @param {Object} next - The new reading
 * @returns {Object|null} The entry to store, or null when the reading is not newer
 */
export function foldPrice(existing, next) {
    // A clock that has run backwards is more likely wrong than the data, so a
    // stored reading from the future is replaced rather than trusted
    if (existing && existing.at >= next.at && existing.at <= Date.now()) return null;

    let rise = 0;
    // Zero rather than null for a first reading, matching `rise`: there is no
    // move yet, so there is no span for one either
    let riseSpanMs = 0;
    if (existing) {
        // Only sides quoted in BOTH readings count. `-1` is "nobody is on this
        // side", not a price, and summing it in made an emptying book look like
        // a crash: 120/100 followed by -1/100 folded to 89/190, a chip reading
        // "▼53.2%" with the bid untouched. Both sides gone was worse still —
        // -2 as a denominator prints thousands of percent, with a sign flip.
        let before = 0;
        let after = 0;
        for (const side of ['ask', 'bid']) {
            if (existing[side] > 0 && next[side] > 0) {
                before += existing[side];
                after += next[side];
            }
        }
        // No side common to the two readings is no move at all, and so no span:
        // `describeMove` declines to draw a move it cannot date, which is the
        // right outcome for a step that was never measured.
        if (before > 0) {
            rise = after / before - 1;
            riseSpanMs = Math.max(0, next.at - existing.at);
        }
    }

    return { ...next, rise, riseSpanMs };
}

/**
 * Prices the game does not quote but that are known anyway.
 *
 * Coins are worth a coin. A single cowbell is not traded — only bags of ten
 * are — so its price is the bag's, divided, which is the figure any calculation
 * about cowbells actually needs.
 *
 * @param {string} itemHrid - Item
 * @param {Function} lookup - (key) => entry, for prices derived from another item
 * @param {number} at - Timestamp
 * @returns {Object|null}
 */
export function specialPrice(itemHrid, lookup, at) {
    if (itemHrid === '/items/coin') return { ask: 1, bid: 1, askQty: 0, bidQty: 0, rise: 0, at };

    if (itemHrid === '/items/cowbell') {
        const bag = lookup(priceKey('/items/bag_of_10_cowbells'));
        if (!bag) return null;
        return { ...bag, ask: bag.ask / 10, bid: bag.bid / 10 };
    }

    return null;
}

/**
 * Drop entries older than the cutoff.
 * @param {Object} entries - Keyed entries
 * @param {number} cutoff - Timestamp (ms); anything older goes
 * @returns {Object} A new object
 */
export function pruneStale(entries, cutoff) {
    return Object.fromEntries(Object.entries(entries || {}).filter(([, entry]) => entry?.at >= cutoff));
}
