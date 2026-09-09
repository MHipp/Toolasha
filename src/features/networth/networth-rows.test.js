/** @vitest-environment happy-dom */

/**
 * The net worth overlay tiles, and what opens behind them.
 *
 * Each of these tiles is one field of the same calculation and one series of the
 * history chart, so the chart is what the tile summarises. What is worth pinning
 * down is that double-clicking actually reaches it: `onOpen` is a plain function
 * on the row definition, and a row registered without one is silently inert —
 * the panel just stops giving the tile a pointer cursor.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    currentData: null,
    chartToggles: 0,
    chartRejects: false,
    bookPanelToggles: 0,
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('./index.js', () => ({
    default: {
        get currentData() {
            return game.currentData;
        },
    },
}));

vi.mock('./networth-history-chart.js', () => ({
    default: {
        toggleModal: async () => {
            game.chartToggles += 1;
            if (game.chartRejects) throw new Error('storage is asleep');
        },
    },
}));

vi.mock('../abilities/ability-book-panel.js', () => ({
    abilityBookPanel: {
        toggle: () => {
            game.bookPanelToggles += 1;
        },
    },
    abilityPlans: () => [],
}));

/** The cheapest next ability level, when the row is given one to draw */
const cheapest = vi.hoisted(() => ({ best: null }));

vi.mock('../../utils/ability-books.js', () => ({
    cheapestNextLevel: () => cheapest.best,
}));

await import('./networth-rows.js');

/** The three tiles that are a field of net worth and open its chart */
const CHART_TILES = ['coins', 'marketListings', 'inventoryValue'];

/**
 * Draw a tile into a fresh container.
 * @param {string} key - Row key
 * @returns {HTMLElement} The container it drew into
 */
function draw(key) {
    const container = document.createElement('div');
    game.rows[key].render(container);
    return container;
}

// One hoisted `game` object stands in for every module this file mocks, so its
// counters carry from test to test. Clear them all before each test rather than
// per describe: the skill-books tile asserts the chart was *not* opened, which
// only holds if the count another describe left behind has been cleared.
beforeEach(() => {
    game.currentData = null;
    game.chartToggles = 0;
    game.chartRejects = false;
    game.bookPanelToggles = 0;
});

describe('net worth tiles', () => {
    test('every field tile registers', () => {
        for (const key of CHART_TILES) expect(game.rows[key]).toBeDefined();
    });

    test('a tile draws nothing at all before net worth has been calculated', () => {
        for (const key of CHART_TILES) expect(draw(key).textContent).toBe('');
    });

    test('a tile draws its figure once net worth has published one', () => {
        game.currentData = {
            coins: 12_345_678,
            currentAssets: { listings: { value: 2_000_000 }, inventory: { value: 500_000 } },
        };

        expect(draw('coins').textContent).toContain('12.35M');
        expect(draw('marketListings').textContent).toContain('2.00M');
        expect(draw('inventoryValue').textContent).toContain('500.00K');
    });

    test('zero coins is a real answer and is drawn; a missing field is not', () => {
        game.currentData = { coins: 0, currentAssets: {} };

        expect(draw('coins').textContent).toContain('0');
        expect(draw('marketListings').textContent).toBe('');
    });
});

describe('opening the history chart', () => {
    beforeEach(() => {
        game.currentData = { coins: 1, currentAssets: { listings: { value: 1 }, inventory: { value: 1 } } };
    });

    test.each(CHART_TILES)('%s is registered with a way to open the chart', (key) => {
        expect(typeof game.rows[key].onOpen).toBe('function');
    });

    test.each(CHART_TILES)('%s opens the history chart when the tile is opened', async (key) => {
        await game.rows[key].onOpen();

        expect(game.chartToggles).toBe(1);
    });

    test.each(CHART_TILES)('%s says what a double-click will do', (key) => {
        expect(draw(key).title).toContain('Double-click for the net worth history chart');
    });

    test('a chart that fails to open is logged rather than thrown', async () => {
        game.chartRejects = true;
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(game.rows.coins.onOpen()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();

        logged.mockRestore();
    });

    test('the tile is only a summary — rendering never opens anything', () => {
        for (const key of CHART_TILES) draw(key);

        expect(game.chartToggles).toBe(0);
    });
});

describe('the skill books tile', () => {
    test('still opens the ability book panel, not the chart', () => {
        game.rows.skillBooks.onOpen();

        expect(game.bookPanelToggles).toBe(1);
        expect(game.chartToggles).toBe(0);
    });
});

/**
 * The figure tiles' `version()`.
 *
 * The overlay redraws every visible tile once a second and skips a row whose
 * version has not moved. Each of these tiles is one published figure and a fixed
 * tooltip, so the figure as drawn is the whole input — but only if the version
 * really does move when the figure does, which is what these pin down.
 */
describe('the figure tiles summarise their own inputs', () => {
    const version = (key) => game.rows[key].version();

    beforeEach(() => {
        game.currentData = {
            coins: 1_000,
            totalNetworth: 5_000,
            currentAssets: { listings: { value: 20 }, inventory: { value: 300 } },
        };
    });

    test('nothing published yet is one settled version', () => {
        game.currentData = null;
        for (const key of ['coins', 'marketListings', 'inventoryValue']) {
            expect(version(key)).toBe('blank');
            expect(version(key)).toBe(version(key));
        }
    });

    test('each tile holds still while its own figure does', () => {
        const before = ['coins', 'marketListings', 'inventoryValue'].map(version);
        expect(['coins', 'marketListings', 'inventoryValue'].map(version)).toEqual(before);
    });

    test('and moves as soon as its figure does', () => {
        const coins = version('coins');
        game.currentData = { ...game.currentData, coins: 1_001 };
        expect(version('coins')).not.toBe(coins);
    });

    test('a tile does not move for a figure that is not its own', () => {
        // Three tiles off one calculation: the listings tile has no business
        // redrawing because the coin count changed
        const listings = version('marketListings');
        game.currentData = { ...game.currentData, coins: 999_999 };
        expect(version('marketListings')).toBe(listings);
    });

    test('a published zero is a figure, and not the same as no answer yet', () => {
        game.currentData = { ...game.currentData, coins: 0 };
        expect(version('coins')).toBe('0');
        expect(version('coins')).not.toBe('blank');
    });

    test('Skill Books stays without one, because reading it feeds the experience sampler', () => {
        // `abilityPlans` samples the ability experience history on its way past,
        // and this row is the only thing that calls it regularly. A memo would
        // stop the sampling on every tick it skipped.
        expect(game.rows.skillBooks.version).toBeUndefined();
    });
});

describe('the skill books tile', () => {
    /** One cheapest-next-level, priced wherever the test says */
    const best = (shopPriced) => ({
        name: 'Poke',
        itemHrid: '/items/poke',
        booksToNext: 2,
        costToNext: 2,
        bookPrice: 1,
        shopPriced,
    });

    afterEach(() => {
        cheapest.best = null;
    });

    test('a cost floored at the Tester shop says so rather than reading as a market quote', () => {
        cheapest.best = best(true);
        const container = draw('skillBooks');

        expect(container.textContent).toContain('shop');
        expect(container.title).toContain('the Tester shop price');
    });

    test('a market quote says nothing of the sort', () => {
        cheapest.best = best(false);
        const container = draw('skillBooks');

        expect(container.textContent).not.toContain('shop');
        expect(container.title).not.toContain('Tester');
    });
});
