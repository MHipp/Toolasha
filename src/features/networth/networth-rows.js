/**
 * Net worth overlay rows
 *
 * The pieces of net worth worth watching on their own.
 *
 * Net worth as a single figure moves too slowly to be interesting and hides the
 * parts that do move: coins spent, listings that have sold, books bought. Each
 * of these is one field of the same calculation, so they cost nothing to add and
 * nothing to keep current.
 *
 * ## Nothing is computed here
 *
 * A full net worth pass prices every item you own and runs a worker pool, which
 * is emphatically not something a row redrawn once a second may do. Every row
 * here reads the last result the feature published and does no work of its own,
 * so the figures refresh when net worth itself recalculates — on item and price
 * changes — rather than on the overlay's timer.
 *
 * The rows are OPanel's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { abilityBookPanel, abilityPlans } from '../abilities/ability-book-panel.js';
import { cheapestNextLevel } from '../../utils/ability-books.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, glyph } from '../../utils/overlay-format.js';
import networthFeature from './index.js';
import networthHistoryChart from './networth-history-chart.js';

/**
 * A field of the last published net worth, or null.
 * @param {Function} pick - `(data) => number|undefined`
 * @returns {number|null} The figure, or null when there is nothing published yet
 */
function fromNetworth(pick) {
    const data = networthFeature.currentData;
    if (!data) return null;
    const value = pick(data);
    return Number.isFinite(value) ? value : null;
}

/**
 * A published net worth field, rounded the way a tile draws it.
 *
 * This is what every figure row here reports as its `version`: the whole tile is
 * one number and a fixed tooltip, so the number as drawn covers every input it
 * has. Rounded rather than raw, because a memo finer than the display would
 * redraw for changes nobody can see.
 *
 * @param {Function} pick - `(data) => number|undefined`
 * @returns {string} The figure, or `blank` when there is nothing published yet
 */
function figureVersion(pick) {
    const value = fromNetworth(pick);
    return value === null ? 'blank' : String(Math.round(value));
}

/**
 * Open the net worth history chart, or close it if it is already up.
 *
 * Each of these tiles is one field of the same calculation, and the chart plots
 * that field over time — gold, inventory, listings are three of its series. So
 * the chart is the detail behind the tile, which is what `onOpen` is for.
 *
 * Wrapped rather than handed over directly because opening it loads saved
 * preferences first, and the overlay calls `onOpen` inside a synchronous
 * try/catch — a rejection would escape it as an unhandled promise.
 *
 * @returns {Promise<void>}
 */
async function openHistoryChart() {
    try {
        await networthHistoryChart.toggleModal();
    } catch (error) {
        console.error('[NetworthRows] Opening the history chart failed:', error);
    }
}

registerRow({
    key: 'coins',
    empty: 'No coins counted',
    name: 'Coins',
    defaultSize: { width: 160, height: 30 },
    version: () => figureVersion((data) => data.coins),
    render: (container) => {
        const coins = fromNetworth((data) => data.coins);
        // Zero coins is a real answer and worth showing; no answer yet is not
        if (coins === null) return blank(container);

        row(container, [
            glyph('coin'),
            { text: formatLargeNumber(Math.round(coins)), color: ROW_COLORS.gold, bold: true, push: true },
        ]);
        container.title = 'Coins on hand.\nDouble-click for the net worth history chart.';
    },
    onOpen: openHistoryChart,
});

registerRow({
    key: 'marketListings',
    empty: 'No listings',
    name: 'Market Listings',
    defaultSize: { width: 180, height: 30 },
    version: () => figureVersion((data) => data.currentAssets?.listings?.value),
    render: (container) => {
        const listings = fromNetworth((data) => data.currentAssets?.listings?.value);
        if (listings === null) return blank(container);

        row(container, [
            glyph('market'),
            { text: formatLargeNumber(Math.round(listings)), color: ROW_COLORS.accent, bold: true, push: true },
        ]);
        container.title = 'What your open market listings are worth.\nDouble-click for the net worth history chart.';
    },
    onOpen: openHistoryChart,
});

registerRow({
    key: 'inventoryValue',
    empty: 'No inventory value yet',
    name: 'Inventory Value',
    defaultSize: { width: 180, height: 30 },
    version: () => figureVersion((data) => data.currentAssets?.inventory?.value),
    render: (container) => {
        const inventory = fromNetworth((data) => data.currentAssets?.inventory?.value);
        if (inventory === null) return blank(container);

        row(container, [
            glyph('inventory'),
            { text: formatLargeNumber(Math.round(inventory)), bold: true, push: true },
        ]);
        container.title = 'What everything in your inventory is worth.\nDouble-click for the net worth history chart.';
    },
    onOpen: openHistoryChart,
});

/**
 * The next ability level, and what it costs.
 *
 * BRead's own tile: the cheapest ability to advance, written as its book's icon,
 * how many books that level takes, and what they come to. The icon does the
 * naming — a tile is not wide enough to spell "Penetrating Strike" and still
 * have room for the number that decides anything.
 *
 * Books already held sit in the tooltip. They are a figure; the cheapest next
 * level is a purchase, and only one of the two is worth a tile.
 */
registerRow({
    key: 'skillBooks',
    empty: 'No books held',
    name: 'Skill Books',
    defaultSize: { width: 180, height: 30 },
    // Deliberately without a `version()`, unlike the three figure rows above.
    // `abilityPlans` samples the ability experience history on its way past, and
    // this row is the only thing in the script that calls it regularly — the
    // panel calls it only while it is open. A memo here would stop the sampling
    // on every tick it skipped, so the panel's experience-per-hour column would
    // be back to taking ten minutes to say anything, which is precisely what the
    // sampling was moved out of the panel to prevent. The row is cheap in the
    // way that matters anyway: `row()` compares its own draw and skips the DOM
    // write when the figures have not moved.
    render: (container) => {
        const books = networthFeature.currentData?.fixedAssets?.abilityBooks;
        const breakdown = books?.breakdown || [];
        const held = breakdown.reduce((sum, entry) => sum + (entry.count || 0), 0);

        const best = cheapestNextLevel(abilityPlans(null));
        if (!best) return blank(container);

        row(
            container,
            [
                { icon: best.itemHrid, size: 18 },
                // Counted, not abbreviated: "2.8K books" is a number you cannot
                // put in a buy order, and this is a figure you act on
                { text: formatWithSeparator(best.booksToNext), color: ROW_COLORS.good, bold: true },
                { text: 'books', color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(best.costToNext)), color: ROW_COLORS.gold },
                // A cost floored at the Tester shop is not a market quote and
                // must not read as one, the same as in the panel behind this row
                ...(best.shopPriced ? [{ text: 'shop', color: ROW_COLORS.dim }] : []),
            ],
            { center: true }
        );
        container.title =
            `${best.name} is the cheapest next ability level: ${best.booksToNext} books at ` +
            `${Math.round(best.bookPrice).toLocaleString()} each` +
            (best.shopPriced ? ', the Tester shop price.' : '.') +
            (breakdown.length
                ? `\nYou hold ${formatLargeNumber(held)} unread books worth ` +
                  `${formatLargeNumber(Math.round(books.totalCost || 0))}.`
                : '') +
            '\nDouble-click for every equipped ability.';
    },
    // BRead's panel, behind the row that was already about books
    onOpen: () => abilityBookPanel.toggle(),
});
