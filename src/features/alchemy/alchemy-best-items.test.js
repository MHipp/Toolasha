/** @vitest-environment happy-dom */

/**
 * Tests for the Best Items ranking table.
 *
 * The module's own work is a shaping layer: it decides which items a given alchemy action can
 * even be run on, asks the profit calculator about each, turns the calculator's success rate into
 * XP per hour, and then filters and sorts the result. The calculator itself is mocked — what it
 * returns is its own file's problem, and mocking it is what makes the eligibility rules and the
 * XP arithmetic visible.
 *
 * Expected values are hand-computed in comments.
 *
 * Not covered (pure DOM assembly, no decisions): createModal's styling, the tab injection
 * watcher, renderBreakdownContent's line-by-line layout.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    /** itemHrid → item details, for getItemDetails */
    items: {},
    /** Character skills — the ranking reads the alchemy level to flag under-levelled rows */
    skills: [],
}));

const calculator = vi.hoisted(() => ({
    coinify: vi.fn(),
    decompose: vi.fn(),
    transmute: vi.fn(),
}));

const market = vi.hoisted(() => ({
    /** itemHrid → price */
    prices: {},
}));

const experience = vi.hoisted(() => ({ totalMultiplier: 1 }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, COLOR_ACCENT: '#abcdef' },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getItemDetails: (hrid) => game.items[hrid] || null,
        getSkills: () => game.skills,
    },
}));

vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: (...args) => calculator.coinify(...args),
        calculateDecomposeProfit: (...args) => calculator.decompose(...args),
        calculateTransmuteProfit: (...args) => calculator.transmute(...args),
    },
}));

vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: experience.totalMultiplier }),
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => market.prices[hrid] ?? null,
}));

vi.mock('../../utils/asset-manifest.js', () => ({
    default: { getSpriteUrl: async () => 'sprite.svg' },
}));

vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: vi.fn(),
}));

/**
 * The market-volume cap, as a per-item throttle map. The real arithmetic lives
 * in utils/liquidity-cap.js and is tested there; what this file has to prove
 * is the wiring — a capped figure reaches the ranking and the drawn cell, and
 * the marker is never dropped.
 */
const liquidity = vi.hoisted(() => ({
    throttleByItem: {},
    calls: [],
    // A call that must not settle until the test releases it, so a test can
    // observe several rows' checks in flight at once instead of only ever one
    // at a time (the mock has no real network delay to make that visible
    // otherwise).
    hang: false,
    pending: [],
    // An item whose check throws, to prove one bad row does not sink the rest
    // of a concurrent sweep.
    failFor: null,
}));

function computeCapResult(goldPerHour, sells) {
    for (const sold of sells || []) {
        const throttle = liquidity.throttleByItem[sold.itemHrid];
        if (throttle !== undefined && throttle < 1) {
            return {
                goldPerHour: goldPerHour * throttle,
                capped: true,
                limit: {
                    kind: 'volume',
                    note: 'limited by market volume (~1/week)',
                    detail: `${sold.name || sold.itemHrid} trades ~1/week, and you are not the only seller.`,
                    itemHrid: sold.itemHrid,
                    throttle,
                },
            };
        }
    }
    return { goldPerHour, capped: false, limit: null };
}

vi.mock('../../utils/liquidity-cap.js', () => ({
    sellsFromProfitData: (profitData) =>
        (profitData?.dropRevenues || [])
            .filter((drop) => drop?.itemHrid && !drop.isSelfReturn)
            .map((drop) => ({
                itemHrid: drop.itemHrid,
                name: drop.itemName || null,
                unitsPerHour: drop.dropsPerHour || 0,
            })),
    // The real prefetch just warms market-liquidity.js's own cache, which
    // this mock's capProfitRate never consults (it answers straight out of
    // liquidity.throttleByItem) — a no-op here is faithful to that.
    prefetchLiquidity: async () => {},
    capProfitRate: async ({ goldPerHour, sells }) => {
        liquidity.calls.push({ goldPerHour, sells });
        const itemHrid = sells?.[0]?.itemHrid;
        if (itemHrid && liquidity.failFor === itemHrid) throw new Error('the pool did not answer in time');
        if (liquidity.hang) {
            return new Promise((resolve) => {
                liquidity.pending.push({ sells, resolve: () => resolve(computeCapResult(goldPerHour, sells)) });
            });
        }
        return computeCapResult(goldPerHour, sells);
    },
    liquidityMarkerHtml: (limit, { compact = false } = {}) =>
        limit ? `<span title="${limit.note} — ${limit.detail}">${compact ? 'vol-capped' : limit.note}</span>` : '',
}));

const { default: bestItems, getAlchemyBaseXP, calcXpPerAction } = await import('./alchemy-best-items.js');

/**
 * Build a profit-calculator result with only the fields the ranking reads.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function profit(overrides = {}) {
    return {
        successRate: 1,
        actionsPerHour: 100,
        profitPerHour: 0,
        winningCatalystHrid: null,
        ...overrides,
    };
}

beforeEach(() => {
    game.initClientData = null;
    game.items = {};
    game.skills = [];
    market.prices = {};
    experience.totalMultiplier = 1;
    liquidity.throttleByItem = {};
    liquidity.calls = [];
    liquidity.hang = false;
    liquidity.pending = [];
    liquidity.failFor = null;
    calculator.coinify.mockReset().mockReturnValue(profit());
    calculator.decompose.mockReset().mockReturnValue(profit());
    calculator.transmute.mockReset().mockReturnValue(profit());
});

afterEach(() => {
    // The singleton keeps its selections between openings, which is right for a panel
    bestItems.cachedRankings = {};
    bestItems.sortMode = 'profit';
    bestItems.currentType = 'coinify';
    bestItems.profitableOnly = false;
    bestItems.searchQuery = '';
    bestItems.filterProfitMin = null;
    bestItems.filterProfitMax = null;
    bestItems.filterPriceMin = null;
    bestItems.filterPriceMax = null;
    bestItems.itemsSpriteUrl = null;
    if (bestItems.modal?.parentNode) bestItems.modal.remove();
    bestItems.modal = null;
    document.body.innerHTML = '';
});

describe('getAlchemyBaseXP', () => {
    test('coinify is the item level plus ten', () => {
        expect(getAlchemyBaseXP('coinify', 0)).toBe(10);
        expect(getAlchemyBaseXP('coinify', 65)).toBe(75);
    });

    test('decompose scales harder than coinify', () => {
        // 1.4·level + 14
        expect(getAlchemyBaseXP('decompose', 0)).toBeCloseTo(14, 9);
        expect(getAlchemyBaseXP('decompose', 50)).toBeCloseTo(84, 9);
    });

    test('transmute scales hardest', () => {
        // 1.6·level + 16
        expect(getAlchemyBaseXP('transmute', 0)).toBeCloseTo(16, 9);
        expect(getAlchemyBaseXP('transmute', 50)).toBeCloseTo(96, 9);
    });

    test('the three stay in order at every level', () => {
        for (const level of [1, 10, 40, 100]) {
            const coinify = getAlchemyBaseXP('coinify', level);
            const decompose = getAlchemyBaseXP('decompose', level);
            const transmute = getAlchemyBaseXP('transmute', level);
            expect(decompose).toBeGreaterThan(coinify);
            expect(transmute).toBeGreaterThan(decompose);
        }
    });

    test('an action type it does not know awards nothing', () => {
        // Which is what stops an unrecognised tab quoting a plausible-looking XP rate
        expect(getAlchemyBaseXP('enchant', 50)).toBe(0);
        expect(getAlchemyBaseXP(undefined, 50)).toBe(0);
    });
});

describe('calcXpPerAction', () => {
    test('a guaranteed success awards the full XP', () => {
        // coinify at level 65 → base 75, wisdom ×1 → 75
        expect(calcXpPerAction('coinify', 65, 1)).toBeCloseTo(75, 9);
    });

    test('a failure still awards a tenth', () => {
        expect(calcXpPerAction('coinify', 65, 0)).toBeCloseTo(7.5, 9);
    });

    test('a partial success rate blends the two', () => {
        // 0.6·75 + 0.4·7.5 = 45 + 3 = 48
        expect(calcXpPerAction('coinify', 65, 0.6)).toBeCloseTo(48, 9);
    });

    test('the wisdom multiplier scales both branches', () => {
        experience.totalMultiplier = 1.25;
        // base 75 × 1.25 = 93.75 on success, 9.375 on failure
        // 0.6·93.75 + 0.4·9.375 = 56.25 + 3.75 = 60
        expect(calcXpPerAction('coinify', 65, 0.6)).toBeCloseTo(60, 9);
    });

    test('an unknown action type short-circuits before the wisdom lookup', () => {
        expect(calcXpPerAction('enchant', 65, 1)).toBe(0);
    });

    test('XP rises with the success rate, at every action type', () => {
        for (const type of ['coinify', 'decompose', 'transmute']) {
            expect(calcXpPerAction(type, 40, 0.9)).toBeGreaterThan(calcXpPerAction(type, 40, 0.5));
        }
    });
});

describe('calculateRankings eligibility', () => {
    /**
     * @param {Object} alchemyDetail - the eligibility flags the ranking reads
     * @param {Object} [rest] - name / itemLevel overrides
     */
    const item = (alchemyDetail, rest = {}) => ({ name: 'Item', itemLevel: 10, alchemyDetail, ...rest });

    test('no game data yields no rankings rather than throwing', () => {
        game.initClientData = null;
        expect(bestItems.calculateRankings('coinify')).toEqual([]);

        game.initClientData = {};
        expect(bestItems.calculateRankings('coinify')).toEqual([]);
    });

    test('items with no alchemyDetail at all are skipped', () => {
        game.initClientData = {
            itemDetailMap: {
                '/items/coin': { name: 'Coin', itemLevel: 0 },
                '/items/cheese': item({ isCoinifiable: true }),
            },
        };

        const rankings = bestItems.calculateRankings('coinify');
        expect(rankings.map((r) => r.itemHrid)).toEqual(['/items/cheese']);
    });

    test('each action type reads its own eligibility flag', () => {
        game.initClientData = {
            itemDetailMap: {
                '/items/a': item({ isCoinifiable: true }),
                '/items/b': item({ decomposeItems: [{ itemHrid: '/items/x', count: 1 }] }),
                '/items/c': item({ transmuteDropTable: [{ itemHrid: '/items/y' }] }),
            },
        };

        expect(bestItems.calculateRankings('coinify').map((r) => r.itemHrid)).toEqual(['/items/a']);
        expect(bestItems.calculateRankings('decompose').map((r) => r.itemHrid)).toEqual(['/items/b']);
        expect(bestItems.calculateRankings('transmute').map((r) => r.itemHrid)).toEqual(['/items/c']);
    });

    test('an item eligible for two actions appears under both', () => {
        game.initClientData = {
            itemDetailMap: {
                '/items/both': item({ isCoinifiable: true, decomposeItems: [{ itemHrid: '/items/x' }] }),
            },
        };

        expect(bestItems.calculateRankings('coinify')).toHaveLength(1);
        expect(bestItems.calculateRankings('decompose')).toHaveLength(1);
        expect(bestItems.calculateRankings('transmute')).toHaveLength(0);
    });

    test('coinify and decompose are asked about the unenhanced item; transmute takes no level', () => {
        // Ranking every enhancement level would be a different table; +0 is what is comparable
        game.initClientData = {
            itemDetailMap: {
                '/items/a': item({ isCoinifiable: true }),
                '/items/b': item({ decomposeItems: [], transmuteDropTable: null }),
            },
        };
        game.initClientData.itemDetailMap['/items/b'].alchemyDetail.decomposeItems = [{ itemHrid: '/items/x' }];

        bestItems.calculateRankings('coinify');
        expect(calculator.coinify).toHaveBeenCalledWith('/items/a', 0);

        bestItems.calculateRankings('decompose');
        expect(calculator.decompose).toHaveBeenCalledWith('/items/b', 0);
    });

    test('transmute is asked with the hrid alone', () => {
        game.initClientData = {
            itemDetailMap: { '/items/c': item({ transmuteDropTable: [{ itemHrid: '/items/y' }] }) },
        };

        bestItems.calculateRankings('transmute');
        expect(calculator.transmute).toHaveBeenCalledWith('/items/c');
    });

    test('an item the calculator throws on is dropped, not allowed to sink the table', () => {
        // One unpriceable item used to take the whole ranking down with it
        game.initClientData = {
            itemDetailMap: {
                '/items/bad': item({ isCoinifiable: true }, { name: 'Bad' }),
                '/items/good': item({ isCoinifiable: true }, { name: 'Good' }),
            },
        };
        calculator.coinify.mockImplementation((hrid) => {
            if (hrid === '/items/bad') throw new Error('no price');
            return profit();
        });

        expect(bestItems.calculateRankings('coinify').map((r) => r.name)).toEqual(['Good']);
    });

    test('an item the calculator declines to price is dropped too', () => {
        game.initClientData = {
            itemDetailMap: {
                '/items/null': item({ isCoinifiable: true }, { name: 'Null' }),
                '/items/good': item({ isCoinifiable: true }, { name: 'Good' }),
            },
        };
        calculator.coinify.mockImplementation((hrid) => (hrid === '/items/null' ? null : profit()));

        expect(bestItems.calculateRankings('coinify').map((r) => r.name)).toEqual(['Good']);
    });
});

describe('calculateRankings row shaping', () => {
    beforeEach(() => {
        game.initClientData = {
            itemDetailMap: {
                '/items/cheese': { name: 'Cheese', itemLevel: 65, alchemyDetail: { isCoinifiable: true } },
            },
        };
    });

    test('XP per hour is the expected XP per action times the action rate', () => {
        // level 65 coinify → base 75; success 0.6 → 0.6·75 + 0.4·7.5 = 48 XP/action
        // 250 actions/hr → 12,000 XP/hr
        calculator.coinify.mockReturnValue(profit({ successRate: 0.6, actionsPerHour: 250 }));

        const [row] = bestItems.calculateRankings('coinify');
        expect(row.xpPerHour).toBeCloseTo(12_000, 6);
    });

    test('the calculator’s profit and catalyst pass straight through', () => {
        calculator.coinify.mockReturnValue(
            profit({ profitPerHour: 123_456, winningCatalystHrid: '/items/prime_catalyst' })
        );

        const [row] = bestItems.calculateRankings('coinify');
        expect(row.profitPerHour).toBe(123_456);
        expect(row.catalyst).toBe('/items/prime_catalyst');
        expect(row.profitData).toBe(calculator.coinify.mock.results[0].value);
    });

    test('no winning catalyst becomes an explicit null, not undefined', () => {
        // The table branches on it to decide between an icon and an em dash
        calculator.coinify.mockReturnValue(profit({ winningCatalystHrid: undefined }));

        expect(bestItems.calculateRankings('coinify')[0].catalyst).toBeNull();
    });

    test('the item price is quoted at the buy side, since that is what a run costs', () => {
        market.prices['/items/cheese'] = 4200;

        expect(bestItems.calculateRankings('coinify')[0].itemPrice).toBe(4200);
    });

    test('an unpriced item shows zero rather than null', () => {
        expect(bestItems.calculateRankings('coinify')[0].itemPrice).toBe(0);
    });

    test('an item with no declared level is treated as level 1', () => {
        game.initClientData.itemDetailMap['/items/cheese'].itemLevel = undefined;
        calculator.coinify.mockReturnValue(profit({ successRate: 1, actionsPerHour: 1 }));

        const [row] = bestItems.calculateRankings('coinify');
        expect(row.itemLevel).toBe(1);
        // level 1 coinify → base 11, full success, ×1 wisdom, 1 action/hr
        expect(row.xpPerHour).toBeCloseTo(11, 9);
    });
});

describe('renderTable filtering and sorting', () => {
    /**
     * Put a ready-made ranking into the panel and draw it.
     * @param {Array} rows
     */
    function render(rows) {
        bestItems.createModal();
        bestItems.currentType = 'coinify';
        bestItems.cachedRankings.coinify = rows;
        bestItems.renderTable();
    }

    /** @returns {string[]} item names in the order they were drawn */
    function drawnNames() {
        return Array.from(bestItems.modal.querySelectorAll('tbody tr')).map((tr) => tr.children[1]?.textContent ?? '');
    }

    const row = (name, profitPerHour, xpPerHour, itemPrice = 0) => ({
        itemHrid: `/items/${name}`,
        name,
        itemLevel: 10,
        itemPrice,
        profitPerHour,
        xpPerHour,
        catalyst: null,
        profitData: null,
    });

    test('the default sort is profit descending', () => {
        render([row('low', 100, 0), row('high', 900, 0), row('mid', 500, 0)]);

        expect(drawnNames()).toEqual(['high', 'mid', 'low']);
    });

    test('XP breaks a profit tie, and profit breaks an XP tie', () => {
        // Otherwise two zero-profit items sort by object order, which is the map's, which is
        // whatever the game shipped
        render([row('a', 0, 10), row('b', 0, 90)]);
        expect(drawnNames()).toEqual(['b', 'a']);

        bestItems.sortMode = 'xp';
        bestItems.cachedRankings.coinify = [row('a', 10, 0), row('b', 90, 0)];
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['b', 'a']);
    });

    test('switching to the XP sort reorders by XP', () => {
        render([row('rich', 900, 10), row('wise', 100, 900)]);
        expect(drawnNames()).toEqual(['rich', 'wise']);

        bestItems.sortMode = 'xp';
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['wise', 'rich']);
    });

    test('the profitable-only filter drops zero and negative rows', () => {
        render([row('gain', 10, 0), row('flat', 0, 0), row('loss', -10, 0)]);
        expect(drawnNames()).toHaveLength(3);

        bestItems.profitableOnly = true;
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['gain']);
    });

    test('search matches anywhere in the name, case-insensitively', () => {
        render([row('Blue Cheese', 30, 0), row('Cheddar', 20, 0), row('Bread', 10, 0)]);

        bestItems.searchQuery = 'chee';
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['Blue Cheese']);

        bestItems.searchQuery = 'e';
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['Blue Cheese', 'Cheddar', 'Bread']);
    });

    test('the profit range filter is inclusive at both ends', () => {
        render([row('a', 100, 0), row('b', 500, 0), row('c', 900, 0)]);

        bestItems.filterProfitMin = 100;
        bestItems.filterProfitMax = 500;
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['b', 'a']);
    });

    test('the price range filter reads the item price, not the profit', () => {
        render([row('cheap', 900, 0, 10), row('dear', 100, 0, 10_000)]);

        bestItems.filterPriceMax = 100;
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['cheap']);

        bestItems.filterPriceMax = null;
        bestItems.filterPriceMin = 1000;
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['dear']);
    });

    test('filters stack rather than replacing one another', () => {
        render([row('a', 900, 0, 10), row('b', 900, 0, 10_000), row('c', 50, 0, 10)]);

        bestItems.filterProfitMin = 500;
        bestItems.filterPriceMax = 100;
        bestItems.renderTable();
        expect(drawnNames()).toEqual(['a']);
    });

    test('a filter that matches nothing says so instead of drawing an empty table', () => {
        render([row('a', 10, 0)]);

        bestItems.searchQuery = 'nothing here';
        bestItems.renderTable();
        expect(bestItems.modal.querySelector('[data-mwi-best-table]').textContent).toContain('No eligible items found');
        expect(bestItems.modal.querySelector('tbody')).toBeNull();
    });

    test('the table caps at a hundred rows and says how many were held back', () => {
        render(Array.from({ length: 137 }, (_, i) => row(`item${i}`, 1000 - i, 0)));

        expect(drawnNames()).toHaveLength(100);
        expect(bestItems.modal.querySelector('[data-mwi-best-table]').textContent).toContain(
            'Showing top 100 of 137 items'
        );
    });

    test('the cap counts filtered rows, not the whole ranking', () => {
        render(Array.from({ length: 137 }, (_, i) => row(`item${i}`, i < 20 ? 1000 : -1, 0)));

        bestItems.profitableOnly = true;
        bestItems.renderTable();
        expect(drawnNames()).toHaveLength(20);
        expect(bestItems.modal.querySelector('[data-mwi-best-table]').textContent).not.toContain('Showing top');
    });

    test('rendering does not mutate the cached ranking it was handed', () => {
        // The sort is on a copy; sorting in place would make the cache order depend on which
        // sort mode happened to be selected last
        const rows = [row('low', 100, 0), row('high', 900, 0)];
        render(rows);

        expect(rows.map((r) => r.name)).toEqual(['low', 'high']);
    });

    test('drawing before the panel exists is a no-op, not a crash', () => {
        bestItems.modal = null;
        expect(() => bestItems.renderTable()).not.toThrow();
    });
});

describe('the market-volume cap on the ranking', () => {
    beforeEach(() => {
        game.initClientData = {
            itemDetailMap: {
                '/items/charm': { name: 'Charm', itemLevel: 10, alchemyDetail: { isCoinifiable: true } },
                '/items/cheese': { name: 'Cheese', itemLevel: 10, alchemyDetail: { isCoinifiable: true } },
            },
        };
        calculator.coinify.mockImplementation((hrid) =>
            hrid === '/items/charm'
                ? profit({
                      profitPerHour: 1_000_000_000,
                      dropRevenues: [
                          { itemHrid: '/items/charm', itemName: 'Charm', dropsPerHour: 10, isSelfReturn: true },
                          { itemHrid: '/items/essence', itemName: 'Tailoring Essence', dropsPerHour: 500 },
                      ],
                  })
                : profit({
                      profitPerHour: 500_000,
                      dropRevenues: [{ itemHrid: '/items/milk', itemName: 'Milk', dropsPerHour: 400 }],
                  })
        );
    });

    /** Rank, bound and draw, the way openModal does */
    async function draw() {
        bestItems.cachedRankings.coinify = await bestItems.withLiquidityCaps(bestItems.calculateRankings('coinify'));
        bestItems.createModal();
        bestItems.currentType = 'coinify';
        bestItems.renderTable();
    }

    /** @returns {Array<Element>} the drawn body rows */
    const drawnRows = () => Array.from(bestItems.modal.querySelectorAll('tbody tr'));

    test('a thin-market row is ranked at its capped figure, below an honest one', async () => {
        // 1B/hr through an essence the market takes 1/10,000th of → 100K,
        // which must now lose to the 500K cheese
        liquidity.throttleByItem['/items/essence'] = 0.0001;

        await draw();

        const names = drawnRows().map((tr) => tr.children[1].textContent);
        expect(names).toEqual(['Cheese', 'Charm']);
        // The capped figure is what the cell shows — 1B × 0.0001 = 100K
        expect(drawnRows()[1].children[4].textContent).toContain('100.0K');
    });

    test('and the drawn cell carries the marker, tooltip naming the limiting item', async () => {
        liquidity.throttleByItem['/items/essence'] = 0.0001;

        await draw();

        const cappedCell = drawnRows()[1].children[4];
        expect(cappedCell.innerHTML).toContain('vol-capped');
        expect(cappedCell.querySelector('span[title]').title).toContain('limited by market volume (~1/week)');
        expect(cappedCell.querySelector('span[title]').title).toContain('Tailoring Essence');

        // The liquid row is not accused of anything
        expect(drawnRows()[0].children[4].innerHTML).not.toContain('vol-capped');
    });

    test('the raw figure survives on the row for anything that wants to say both', async () => {
        liquidity.throttleByItem['/items/essence'] = 0.0001;

        const bounded = await bestItems.withLiquidityCaps(bestItems.calculateRankings('coinify'));
        const charm = bounded.find((row) => row.itemHrid === '/items/charm');

        expect(charm.profitPerHour).toBeCloseTo(100_000, 6);
        expect(charm.uncappedProfitPerHour).toBe(1_000_000_000);
        expect(charm.liquidityLimit.itemHrid).toBe('/items/essence');
    });

    test('a liquid market leaves the ranking exactly as calculated, unmarked', async () => {
        await draw();

        const names = drawnRows().map((tr) => tr.children[1].textContent);
        expect(names).toEqual(['Charm', 'Cheese']);
        expect(bestItems.modal.querySelector('[data-mwi-best-table]').innerHTML).not.toContain('vol-capped');
    });

    test('the rows the ranking module handed over are never edited in place', async () => {
        liquidity.throttleByItem['/items/essence'] = 0.0001;

        const raw = bestItems.calculateRankings('coinify');
        await bestItems.withLiquidityCaps(raw);

        expect(raw.find((row) => row.itemHrid === '/items/charm').profitPerHour).toBe(1_000_000_000);
    });
});

describe('loadRankings — painting early, resolving the caps in the background', () => {
    beforeEach(() => {
        game.initClientData = {
            itemDetailMap: {
                '/items/charm': { name: 'Charm', itemLevel: 10, alchemyDetail: { isCoinifiable: true } },
                '/items/cheese': { name: 'Cheese', itemLevel: 10, alchemyDetail: { isCoinifiable: true } },
            },
        };
        calculator.coinify.mockImplementation((hrid) =>
            hrid === '/items/charm'
                ? profit({
                      profitPerHour: 1_000_000_000,
                      dropRevenues: [{ itemHrid: '/items/essence', itemName: 'Tailoring Essence', dropsPerHour: 500 }],
                  })
                : profit({
                      profitPerHour: 500_000,
                      dropRevenues: [{ itemHrid: '/items/milk', itemName: 'Milk', dropsPerHour: 400 }],
                  })
        );
    });

    /** Open the modal the way openModal does, without the async sprite lookup */
    function openOn(type) {
        bestItems.createModal();
        bestItems.modal.style.display = 'flex';
        bestItems.currentType = type;
    }

    test('the raw ranking paints immediately, every row marked pending rather than blank', () => {
        openOn('coinify');

        bestItems.loadRankings('coinify');

        // Nothing has been awaited yet — this is what is on screen the instant
        // loadRankings returns, before any liquidity check has answered
        const rows = bestItems.cachedRankings.coinify;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.capPending)).toBe(true);
        // The true uncapped figure, never a zero standing in for "not known yet"
        expect(rows.find((row) => row.itemHrid === '/items/charm').profitPerHour).toBe(1_000_000_000);

        expect(bestItems.modal.querySelector('[data-mwi-best-table]').textContent).toContain('checking…');
        expect(bestItems.modal.querySelector('[data-mwi-best-table]').innerHTML).not.toContain('vol-capped');
    });

    test('a pending row settles to its capped figure once the check resolves, and the table repaints', async () => {
        liquidity.throttleByItem['/items/essence'] = 0.0001;
        openOn('coinify');

        await bestItems.loadRankings('coinify');

        const charm = bestItems.cachedRankings.coinify.find((row) => row.itemHrid === '/items/charm');
        expect(charm.capPending).toBeUndefined();
        expect(charm.profitPerHour).toBeCloseTo(100_000, 6);
        expect(charm.liquidityLimit.itemHrid).toBe('/items/essence');

        const cell = Array.from(bestItems.modal.querySelectorAll('tbody tr')).find((tr) =>
            tr.textContent.includes('Charm')
        ).children[4];
        expect(cell.innerHTML).toContain('vol-capped');
        expect(cell.innerHTML).not.toContain('checking…');
    });

    test('every row’s check is outstanding at once, not one row blocking the next', async () => {
        liquidity.hang = true;
        openOn('coinify');

        const loadPromise = bestItems.loadRankings('coinify');

        // Let the synchronous fan-out finish starting its first wave before we look.
        await Promise.resolve();
        await Promise.resolve();

        expect(liquidity.pending.length).toBe(2);

        liquidity.pending.forEach((entry) => entry.resolve());
        liquidity.pending = [];
        liquidity.hang = false;
        await loadPromise;
    });

    test('one row’s check failing does not stop the other from settling', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        liquidity.failFor = '/items/essence';
        openOn('coinify');

        await bestItems.loadRankings('coinify');

        const rows = bestItems.cachedRankings.coinify;
        const charm = rows.find((row) => row.itemHrid === '/items/charm');
        const cheese = rows.find((row) => row.itemHrid === '/items/cheese');

        // The failing row keeps its raw, unbounded figure rather than the whole
        // sweep aborting
        expect(charm.profitPerHour).toBe(1_000_000_000);
        expect(charm.capPending).toBeUndefined();
        expect(cheese.profitPerHour).toBe(500_000);

        vi.restoreAllMocks();
    });

    test('a stale sweep for the same type settling late does not clobber a newer one', async () => {
        openOn('coinify');

        let resolveFirst;
        const withCapsSpy = vi
            .spyOn(bestItems, 'withLiquidityCaps')
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));

        // A first sweep starts and hangs (the modal was opened, say)
        const firstLoad = bestItems.loadRankings('coinify');

        // The type is reopened before the first sweep answers — the second
        // sweep replaces the cached array and finishes first
        withCapsSpy.mockImplementationOnce(async () => [{ itemHrid: '/items/second', profitPerHour: 999 }]);
        await bestItems.loadRankings('coinify');
        const settled = bestItems.cachedRankings.coinify;
        expect(settled).toEqual([{ itemHrid: '/items/second', profitPerHour: 999 }]);

        // The first, now-stale sweep finally resolves — it must not overwrite
        // the second sweep's already-settled result
        resolveFirst([{ itemHrid: '/items/stale', profitPerHour: 1 }]);
        await firstLoad;

        expect(bestItems.cachedRankings.coinify).toBe(settled);
        withCapsSpy.mockRestore();
    });
});

describe('detectAlchemyType', () => {
    /**
     * @param {string} label - text of the selected tab
     */
    function selectTab(label) {
        document.body.innerHTML = `
            <div class="AlchemyPanel_tabsComponentContainer__x1">
                <div role="tab" aria-selected="false">Other</div>
                <div role="tab" aria-selected="true">${label}</div>
            </div>`;
    }

    test('it reads the selected tab', () => {
        selectTab('Decompose');
        expect(bestItems.detectAlchemyType()).toBe('decompose');

        selectTab('Transmute');
        expect(bestItems.detectAlchemyType()).toBe('transmute');

        selectTab('Coinify');
        expect(bestItems.detectAlchemyType()).toBe('coinify');
    });

    test('the match survives surrounding text and casing', () => {
        selectTab('  TRANSMUTE 3  ');
        expect(bestItems.detectAlchemyType()).toBe('transmute');
    });

    test('with no panel on screen it falls back to coinify', () => {
        document.body.innerHTML = '';
        expect(bestItems.detectAlchemyType()).toBe('coinify');
    });
});
