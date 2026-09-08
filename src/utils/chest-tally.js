/**
 * Chest Tally
 *
 * What you actually got out of the chests you opened, against what they owed you.
 *
 * Toolasha already prices a chest before you open it — `expected-value-calculator.js`
 * says what one is worth on average, and that shows up in tooltips and net worth.
 * What it cannot say is whether the four hundred you have already opened paid out.
 * Expected value is a statement about the long run; this is the ledger that says
 * whether the long run has arrived.
 *
 * The comparison is deliberately made against **your own openings**, item by item,
 * rather than against a headline average. A chest that owes you one rare in two
 * hundred is not meaningfully behind after fifty, and the per-item breakdown is
 * what shows that the shortfall is one unlucky rare rather than something wrong
 * across the board.
 *
 * Pure, and separate from the panel that draws it, for the usual reason: an
 * expectation computed slightly wrong still renders as a confident percentage.
 *
 * The idea and the ledger shape come from TReasure in MWI Combat Suite by Frotty
 * (MIT) — see `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
 */

import { registerSyncMerge } from './sync-merge-registry.js';

/**
 * Fold one `loot_opened` message into the tally.
 *
 * Returns a new tally rather than mutating, so a caller can persist the result
 * without worrying about which copy is which.
 *
 * @param {Object} tally - `{ [chestHrid]: { opened, loot: { [itemHrid]: count } } }`
 * @param {string} chestHrid - What was opened
 * @param {number} count - How many
 * @param {Array<{itemHrid: string, count: number}>} gainedItems - What came out
 * @returns {Object} A new tally
 */
export function recordOpening(tally, chestHrid, count, gainedItems) {
    if (!chestHrid || !(count > 0)) return tally || {};

    const previous = (tally || {})[chestHrid] || { opened: 0, loot: {} };
    const loot = { ...previous.loot };
    const justNow = {};

    for (const item of gainedItems || []) {
        if (!item?.itemHrid) continue;
        loot[item.itemHrid] = (loot[item.itemHrid] || 0) + (item.count || 0);
        justNow[item.itemHrid] = (justNow[item.itemHrid] || 0) + (item.count || 0);
    }

    // `last` is the same shape as the running total, so anything that can judge
    // a lifetime can judge a single opening without a second code path.
    //
    // `since` is carried rather than re-stamped: it says when this bucket
    // *began* counting, and an opening added to a bucket that a reset started
    // is still part of that counting. Absent on a bucket no reset has touched,
    // and left absent so a ledger that predates stamps keeps its old shape.
    const bucket = { opened: previous.opened + count, loot, last: { opened: count, loot: justNow } };
    if (previous.since != null) bucket.since = previous.since;
    return { ...tally, [chestHrid]: bucket };
}

/**
 * Forget one chest's history, or all of it.
 *
 * A reset leaves an emptied bucket stamped with the moment it happened rather
 * than removing the key. Removing it is what let a reset be undone: the counts
 * are lifetime totals folded per counter with `Math.max`, so a peer that still
 * held the old numbers restated them on the next pull — and the panel's return
 * verdict is computed from `opened` and `loot`, so the figure the user had
 * zeroed came back with nothing on screen to say it had. The stamp is what
 * `mergeStoredTally` compares to decide which side is the newer news.
 *
 * @param {Object} tally - The tally
 * @param {string} [chestHrid] - Which chest; omit to clear everything
 * @param {number} [now] - The stamp to write; injectable for tests
 * @returns {Object} A new tally
 */
export function resetTally(tally, chestHrid, now = Date.now()) {
    const since = Number(now) || 0;
    const cleared = () => ({ opened: 0, loot: {}, since });

    if (!chestHrid) {
        const next = {};
        for (const key of Object.keys(tally || {})) next[key] = cleared();
        return next;
    }

    // Nothing to stamp where there was nothing recorded
    if (!(tally || {})[chestHrid]) {
        const next = { ...tally };
        delete next[chestHrid];
        return next;
    }
    return { ...tally, [chestHrid]: cleared() };
}

/** When a bucket began counting; unstamped buckets have always been counting */
function sinceOf(bucket) {
    return Number(bucket?.since) || 0;
}

/** The newest reset a whole tally carries, for the refusal below */
function newestSince(tally) {
    let newest = 0;
    for (const bucket of Object.values(tally || {})) newest = Math.max(newest, sinceOf(bucket));
    return newest;
}

/** How many openings a bucket claims */
function openedOf(bucket) {
    return Number(bucket?.opened) || 0;
}

/**
 * How many chests one fold may zero on the strength of somebody else's reset.
 *
 * The reference implementation for this refusal is `custom-tabs-data.js` — a
 * fold must never be the thing that empties a curated record. A reset is the
 * one thing here that can take counts away, it arrives from a store or a peer
 * that may be wrong about it, and a ledger of a hundred chests vanishing on a
 * pull is never what the user asked a button on another device for. Twelve is
 * above anything the per-chest Reset can reach in one fold — it zeroes exactly
 * one chest — and above a typical "Delete all history", which touches the
 * handful of chests a player actually opens.
 */
const RESET_FOLD_LIMIT = 12;

/**
 * Fold a stored tally under the one in memory, for writing back.
 *
 * Every count in a tally is a lifetime total that only ever grows, so where
 * both sides have a chest the larger of each count is the truer one: memory's
 * when this tab has been opening chests, storage's when a read that could not
 * be made left memory behind, or another tab got there first. `last` is memory's
 * wherever memory has the chest, since it is the opening this tab just saw.
 * Anything that is not a number is memory's.
 *
 * A reset is the exception, and the reason for `since`. Max-per-counter cannot
 * express "this went back to nought" — it undoes a reset unconditionally — so a
 * reset stamps the bucket it empties (`resetTally`) and a bucket whose stamp is
 * newer wins **whole**, counts and all, rather than being maxed against the
 * other side. An unstamped bucket therefore loses to a stamped one, which is
 * the right bias for an action confirmed through a danger dialog.
 *
 * That is also what keeps the peer's later openings: a device that has taken
 * the reset carries its stamp, and every opening it records afterwards goes
 * into that same stamped bucket (`recordOpening` carries `since` forward). Two
 * buckets counting since the same reset have equal stamps and fold by max as
 * they always did, so news from after the reset is never mistaken for news from
 * before it.
 *
 * `stored` is this device's copy in both callers — the save fold reads it back
 * from storage, and a sync pull hands it the local base with the remote copy as
 * `memory` — which is what the mass-reset refusal below tests.
 *
 * @param {Object} stored - The tally as read back
 * @param {Object} memory - The tally as held
 * @returns {Object} A new tally
 */
export function mergeStoredTally(stored, memory) {
    const base = stored && typeof stored === 'object' ? stored : {};
    const mine = memory && typeof memory === 'object' ? memory : {};
    const merged = { ...base };
    /** Buckets this fold would zero on a stamp the local side does not hold */
    const zeroed = [];

    for (const [chestHrid, entry] of Object.entries(mine)) {
        const theirs = merged[chestHrid];
        if (!theirs || !entry || typeof entry !== 'object') {
            merged[chestHrid] = entry;
            continue;
        }

        const ourSince = sinceOf(entry);
        const theirSince = sinceOf(theirs);
        if (ourSince !== theirSince) {
            const newer = ourSince > theirSince ? entry : theirs;
            const older = newer === entry ? theirs : entry;
            merged[chestHrid] = newer;
            if (openedOf(older) > openedOf(newer)) zeroed.push([chestHrid, older]);
            continue;
        }

        const loot = { ...(theirs.loot || {}) };
        for (const [itemHrid, count] of Object.entries(entry.loot || {})) {
            loot[itemHrid] =
                typeof count === 'number' && typeof loot[itemHrid] === 'number'
                    ? Math.max(loot[itemHrid], count)
                    : count;
        }
        merged[chestHrid] = {
            ...theirs,
            ...entry,
            opened:
                typeof entry.opened === 'number' && typeof theirs.opened === 'number'
                    ? Math.max(theirs.opened, entry.opened)
                    : entry.opened,
            loot,
        };
    }

    // A fold must never be the thing that empties the ledger. The local side
    // holding the newest stamp means the reset is one this device already made
    // or already took, and that always applies — the refusal is only ever about
    // a reset arriving from elsewhere. See RESET_FOLD_LIMIT.
    const ourReset = newestSince(base) >= newestSince(mine);
    if (!ourReset && zeroed.length > RESET_FOLD_LIMIT) {
        for (const [chestHrid, older] of zeroed) merged[chestHrid] = older;
        console.warn(
            `[ChestTally] Refusing a fold that would zero ${zeroed.length} chests at once on a reset this ` +
                'device did not make; every count is kept. Reset here to clear them.'
        );
    }
    return merged;
}

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it — a lifetime count can only be too low, never too high, so
 * the max-per-counter fold is the right answer for two devices as much as for
 * two tabs — except where a reset says otherwise, which is what the `since`
 * stamp is for and why only the pulling device merging is survivable at all.
 * Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See sync-merge-registry.js.
 */
registerSyncMerge({ store: 'settings', base: 'treasureTally', merge: mergeStoredTally, label: 'Treasure tally' });

/**
 * What one chest owes on average, per item.
 *
 * The midpoint of the count range times the rate — the same arithmetic the
 * expected-value calculator uses, kept here in item counts rather than collapsed
 * to a single coin figure, because the interesting question is which item came up
 * short and not just by how much.
 *
 * @param {Array<Object>} dropTable - An entry of `openableLootDropMap`
 * @returns {Object<string, number>} Item hrid → expected count per chest
 */
export function expectedLootPerChest(dropTable) {
    const expected = {};

    for (const drop of dropTable || []) {
        if (!drop?.itemHrid) continue;
        const rate = drop.dropRate ?? 0;
        const average = ((drop.minCount ?? 0) + (drop.maxCount ?? 0)) / 2;
        const count = rate * average;
        if (count > 0) expected[drop.itemHrid] = (expected[drop.itemHrid] || 0) + count;
    }
    return expected;
}

/**
 * How one chest has treated you.
 *
 * Items are returned whether they dropped or not: a rare that never came up is
 * the whole story on an unlucky chest, and leaving it out of the list would hide
 * exactly the row worth seeing.
 *
 * @param {Object} entry - `{ opened, loot }` for one chest
 * @param {Array<Object>} dropTable - That chest's drop table
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {Object} `{ opened, actualValue, expectedValue, difference, ratio, items }`
 *   where `ratio` is null until something has been opened
 */
export function chestPerformance(entry, dropTable, priceOf) {
    const opened = entry?.opened || 0;
    const loot = entry?.loot || {};
    const perChest = expectedLootPerChest(dropTable);

    const hrids = new Set([...Object.keys(perChest), ...Object.keys(loot)]);
    const items = [];
    let actualValue = 0;
    let expectedValue = 0;

    for (const itemHrid of hrids) {
        const price = priceOf(itemHrid);
        // No price means no contribution to either side, which keeps the
        // comparison honest rather than counting the item as free. It is still
        // a row: an item that dropped and is simply not shown reads as a chest
        // that did not contain it, and a panel that quietly omits things is
        // worse than one that says it cannot price them.
        const priced = price > 0;

        const actualCount = loot[itemHrid] || 0;
        const expectedCount = (perChest[itemHrid] || 0) * opened;

        if (priced) {
            actualValue += actualCount * price;
            expectedValue += expectedCount * price;
        }

        items.push({
            itemHrid,
            actualCount,
            expectedCount,
            unpriced: !priced,
            actualValue: priced ? actualCount * price : 0,
            expectedValue: priced ? expectedCount * price : 0,
        });
    }

    // Sorted by how much of each the chest owes you, commonest first, and by
    // nothing else.
    //
    // It used to be sorted by what each was worth, which meant the rows moved
    // whenever a price moved and whenever the cape or cowbell valuation was
    // changed — a list you had learned the shape of rearranged itself for
    // reasons that had nothing to do with the chest. A drop table does not
    // change, so an order taken from it does not either. It is also the order
    // TReasure lists them in.
    //
    // An item that dropped but is not in the table is owed nothing and goes
    // last; the hrid tie-break is only there so that group has a fixed order
    // rather than the map's.
    items.sort((a, b) => b.expectedCount - a.expectedCount || a.itemHrid.localeCompare(b.itemHrid));

    return {
        opened,
        actualValue,
        expectedValue,
        difference: actualValue - expectedValue,
        ratio: expectedValue > 0 ? actualValue / expectedValue : null,
        items,
    };
}

/**
 * One chest's history in the three views the panel shows side by side.
 *
 * The same items appear in each column, in the same order, so a row can be read
 * across: what the last opening gave, what every opening has given, and what one
 * chest and the whole run were owed. Ordering them separately per column would
 * make the comparison a lookup rather than a glance.
 *
 * @param {Object} entry - `{ opened, loot, last }` for one chest
 * @param {Array<Object>} dropTable - That chest's drop table
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {Object} `{ last, total, perChestValue, items }` where each item carries
 *   its last, total and expected figures together
 */
export function chestBreakdown(entry, dropTable, priceOf) {
    const total = chestPerformance(entry, dropTable, priceOf);
    const last = chestPerformance(entry?.last, dropTable, priceOf);
    const perChest = expectedLootPerChest(dropTable);

    const lastByItem = new Map(last.items.map((item) => [item.itemHrid, item]));
    const opened = entry?.opened || 0;

    const items = total.items.map((item) => {
        const price = priceOf(item.itemHrid) || 0;
        const perOne = perChest[item.itemHrid] || 0;
        const lastItem = lastByItem.get(item.itemHrid);
        const lastOpened = entry?.last?.opened || 0;
        const lastExpectedValue = perOne * lastOpened * price;

        return {
            itemHrid: item.itemHrid,
            price,
            unpriced: item.unpriced,
            lastCount: lastItem?.actualCount || 0,
            lastValue: lastItem?.actualValue || 0,
            lastRatio: lastExpectedValue > 0 ? (lastItem?.actualValue || 0) / lastExpectedValue : null,
            totalCount: item.actualCount,
            totalValue: item.actualValue,
            totalRatio: item.expectedValue > 0 ? item.actualValue / item.expectedValue : null,
            expectedPerChest: perOne,
            expectedPerChestValue: perOne * price,
            expectedTotal: perOne * opened,
            expectedTotalValue: item.expectedValue,
        };
    });

    // What one chest is worth on average, which is the figure beside its name
    const perChestValue = Object.entries(perChest).reduce(
        (sum, [itemHrid, count]) => sum + count * (priceOf(itemHrid) || 0),
        0
    );

    return { last, total, perChestValue, items };
}

/**
 * Every chest in the game, with whatever history you have for it.
 *
 * Unopened chests are listed too, priced but with no verdict, because the panel
 * is also the place to look up what a chest is worth before deciding to open it
 * — a list of only what you have already opened cannot answer that.
 *
 * Ordered by how far from expectation each sits, worst first, since the reason
 * to open the panel is usually to find out which chest let you down. Chests with
 * no history sort after those, by what one is worth, so the list stays useful
 * rather than alphabetical.
 *
 * @param {Object} tally - The tally
 * @param {Object} dropTables - `openableLootDropMap`
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {Array<Object>} Performances, each with `chestHrid` and `perChestValue`
 */
export function summariseTally(tally, dropTables, priceOf) {
    // Every chest the game knows about, plus anything in the tally that the game
    // has since stopped listing — history should not vanish on a game update
    const chestHrids = new Set([...Object.keys(dropTables || {}), ...Object.keys(tally || {})]);

    const rows = [...chestHrids].map((chestHrid) => {
        const dropTable = dropTables?.[chestHrid];
        const performance = chestPerformance((tally || {})[chestHrid], dropTable, priceOf);
        const perChest = expectedLootPerChest(dropTable);
        const perChestValue = Object.entries(perChest).reduce(
            (sum, [itemHrid, count]) => sum + count * (priceOf(itemHrid) || 0),
            0
        );
        return { chestHrid, perChestValue, ...performance };
    });

    return sortSummary(rows);
}

/**
 * The orders the panel offers, in the order it offers them.
 *
 * `luck` is the default and the reason the panel exists. The rest are there
 * because it lists every chest in the game — sixty-odd rows — and a ranking by
 * how unlucky each was is the worst possible order for finding one chest you
 * have in mind. `name` is that: the row is where the alphabet says it is.
 */
export const SORT_MODES = [
    { key: 'luck', label: 'Luck (worst first)' },
    { key: 'name', label: 'Name (A–Z)' },
    { key: 'opened', label: 'Most opened' },
    { key: 'value', label: 'Chest value' },
    { key: 'profit', label: 'Coins up or down' },
];

/**
 * Order the rows.
 *
 * Sorts a copy: the caller's array is usually the one on screen, and reordering
 * it underneath a half-drawn table is how a row ends up drawn twice.
 *
 * @param {Array<Object>} rows - From `summariseTally`
 * @param {string} [mode] - One of `SORT_MODES`
 * @param {Function} [nameOf] - `(chestHrid) => string`, for the name order
 * @returns {Array<Object>} A new, sorted array
 */
export function sortSummary(rows, mode = 'luck', nameOf = (chestHrid) => chestHrid) {
    const sorted = [...(rows || [])];

    if (mode === 'name') {
        // Every chest, opened or not, in one alphabet — splitting them would put
        // half the names in one place and half in another, which is the thing
        // this order exists to avoid
        sorted.sort((a, b) => String(nameOf(a.chestHrid)).localeCompare(String(nameOf(b.chestHrid))));
        return sorted;
    }

    sorted.sort((a, b) => {
        // A chest you have never opened has no verdict to rank, so it waits
        // behind the ones that do
        if (!a.opened !== !b.opened) return a.opened ? -1 : 1;
        if (!a.opened) return b.perChestValue - a.perChestValue;

        if (mode === 'opened') return b.opened - a.opened;
        if (mode === 'value') return b.perChestValue - a.perChestValue;
        if (mode === 'profit') {
            return b.actualValue - b.expectedValue - (a.actualValue - a.expectedValue);
        }
        return (a.ratio ?? Infinity) - (b.ratio ?? Infinity);
    });
    return sorted;
}

/**
 * The totals across every chest, since one chest running hot while another runs
 * cold is the common case and neither row answers "am I up or down".
 * @param {Array<Object>} rows - From `summariseTally`
 * @returns {Object} `{ opened, actualValue, expectedValue, difference, ratio }`
 */
export function tallyTotals(rows) {
    const totals = rows.reduce(
        (sum, row) => ({
            opened: sum.opened + row.opened,
            actualValue: sum.actualValue + row.actualValue,
            expectedValue: sum.expectedValue + row.expectedValue,
        }),
        { opened: 0, actualValue: 0, expectedValue: 0 }
    );

    return {
        ...totals,
        difference: totals.actualValue - totals.expectedValue,
        ratio: totals.expectedValue > 0 ? totals.actualValue / totals.expectedValue : null,
    };
}
