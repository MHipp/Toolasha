/**
 * @vitest-environment happy-dom
 *
 * The ability book calculator injected into the Item Dictionary.
 *
 * The arithmetic itself lives in `utils/ability-books.js` and is tested there;
 * this file is about what the calculator does with it at the level 200 cap,
 * where `booksToLevel` returns null (the experience table has nothing past
 * 200) rather than a number of books — and about the Tester shop, which on the
 * test server floors what a book costs and moves where the buy button goes.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: {}, price: null, testerOn: false, shopCost: 0 }));
const calls = vi.hoisted(() => ({ market: [], openShop: 0, filter: [], quantity: [], pending: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#22c55e',
        COLOR_LOSS: '#f87171',
        getSetting: () => true,
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        getItemDetails: (hrid) => game.data?.itemDetailMap?.[hrid] || null,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => game.price } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (...args) => calls.market.push(args),
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        setQuantity: (...args) => calls.quantity.push(args),
        setPendingCalculation: (fn, options) => calls.pending.push([fn(), options]),
        cleanup: () => {},
    }),
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => game.testerOn,
    testerShopCoinCost: () => game.shopCost,
}));
vi.mock('../../utils/tester-shop-nav.js', () => ({
    openTesterShopPage: async () => {
        calls.openShop++;
        return document.createElement('div');
    },
    setShopFilter: (...args) => calls.filter.push(args),
}));

const { default: abilityBookCalculator } = await import('./ability-book-calculator.js');

/** Each level costs 1,000 more experience than the last, up to the level 200 cap */
const table = [0, 0];
for (let level = 2; level <= 200; level++) table[level] = table[level - 1] + 1000;

beforeEach(() => {
    game.data = {
        levelExperienceTable: table,
        itemDetailMap: { '/items/poke': { name: 'Poke' } },
    };
    game.price = { ask: 100, bid: 90 };
    game.testerOn = false;
    game.shopCost = 0;
    calls.market.length = 0;
    calls.filter.length = 0;
    calls.quantity.length = 0;
    calls.pending.length = 0;
    calls.openShop = 0;
    document.body.innerHTML = '';
});

/** A bare Item Dictionary panel, standing in for the real modal content */
const panel = () => document.createElement('div');

describe('the level 200 cap', () => {
    test('an ability already at the cap reads as maxed, not as needing zero books', async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 200, xp: table[200] }, 500, '/items/poke');

        const text = el.textContent;
        expect(text).toContain('max');
        // Not the old behaviour: null coerced to 0 read as "Books needed: 0",
        // which said "buy nothing" rather than "cannot go further"
        expect(text).not.toContain('Books needed: 0');
        expect(text).not.toContain('NaN');
    });

    test('a maxed ability gets no level input to mistype 201 into', async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 200, xp: table[200] }, 500, '/items/poke');

        expect(el.querySelector('#tillLevelInput')).toBeNull();
    });

    test('an ability one level below the cap still shows a normal calculator', async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 199, xp: table[199] }, 500, '/items/poke');

        const input = el.querySelector('#tillLevelInput');
        expect(input).not.toBeNull();
        expect(input.value).toBe('200');
        // 1,000 experience to level 200 at 500 a book
        expect(el.textContent).toContain('Books needed: 2');
    });
});

describe('the Tester shop as the buy side', () => {
    /** A calculator one level short of 10: 1,000 experience, 2 books at 500 each */
    const build = async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 9, xp: table[9] }, 500, '/items/poke');
        return el;
    };

    /** The panel's buy button, whatever it currently calls itself */
    const buyButton = (el) => Array.from(el.querySelectorAll('button')).find((b) => /buy/i.test(b.textContent));

    /** Let the click handler's awaits run out */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    test('with the setting off the cost is the market quote and the button says marketplace', async () => {
        const el = await build();

        // 2 books at ask 100 / bid 90
        expect(el.textContent).toContain('Cost: 200 / 180 (ask / bid)');
        expect(buyButton(el).textContent).toBe('Buy on Marketplace');
    });

    test('with the setting off the button still goes to the marketplace', async () => {
        const el = await build();
        buyButton(el).click();
        await settle();

        expect(calls.market).toEqual([['/items/poke']]);
        expect(calls.openShop).toBe(0);
    });

    test('a book the shop does not sell is untouched by the setting', async () => {
        game.testerOn = true;
        game.shopCost = 0;
        const el = await build();
        buyButton(el).click();
        await settle();

        expect(el.textContent).toContain('Cost: 200 / 180 (ask / bid)');
        expect(buyButton(el).textContent).toBe('Buy on Marketplace');
        expect(calls.market).toEqual([['/items/poke']]);
    });

    test('a book the shop sells cheaper is costed at the shop, and says so', async () => {
        game.testerOn = true;
        game.shopCost = 10;
        const el = await build();

        // Both columns are buy-side, and 10 beats both the ask and the bid
        expect(el.textContent).toContain('Cost: 20 (Tester shop)');
        expect(el.textContent).not.toContain('(ask / bid)');
    });

    test('the shop floors only the column it beats', async () => {
        game.testerOn = true;
        game.shopCost = 95; // under the ask of 100, over the bid of 90
        const el = await build();

        expect(el.textContent).toContain('Cost: 190 / 180 (shop / bid)');
    });

    test('a shop dearer than the market does not raise the cost', async () => {
        game.testerOn = true;
        game.shopCost = 500;
        const el = await build();

        expect(el.textContent).toContain('Cost: 200 / 180 (ask / bid)');
    });

    test('the recomputed cost after a level change keeps the shop floor', async () => {
        game.testerOn = true;
        game.shopCost = 10;
        const el = await build();
        const input = el.querySelector('#tillLevelInput');
        input.value = '11';
        input.dispatchEvent(new Event('change'));

        // Two levels, 2,000 experience, 4 books
        expect(el.textContent).toContain('Books needed: 4');
        expect(el.textContent).toContain('Cost: 40 (Tester shop)');
    });

    test('a book the shop sells routes the button to the Tester tab with the quantity armed', async () => {
        game.testerOn = true;
        game.shopCost = 10;
        const el = await build();
        const button = buyButton(el);
        expect(button.textContent).toBe('Buy in Tester shop');

        button.click();
        await settle();

        expect(calls.openShop).toBe(1);
        expect(calls.filter).toEqual([['Poke']]);
        expect(calls.pending).toEqual([[2, { itemHrid: '/items/poke' }]]);
        // The shop replaces the marketplace, it does not follow it
        expect(calls.market).toEqual([]);
    });

    test('the button presses no buy control of its own on either path', async () => {
        const clicked = [];
        const card = document.createElement('div');
        card.textContent = 'Poke';
        card.addEventListener('click', () => clicked.push('card'));
        const buy = document.createElement('button');
        buy.textContent = 'Buy';
        buy.addEventListener('click', () => clicked.push('buy'));
        document.body.append(card, buy);

        game.testerOn = true;
        game.shopCost = 10;
        const shopPanel = await build();
        buyButton(shopPanel).click();
        await settle();

        game.testerOn = false;
        const marketPanel = await build();
        buyButton(marketPanel).click();
        await settle();

        expect(clicked).toEqual([]);
    });
});
