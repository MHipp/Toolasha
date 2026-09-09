/**
 * @vitest-environment happy-dom
 *
 * The Ability Book panel, built rather than reasoned about.
 *
 * The arithmetic is tested where it lives. What only building the panel catches
 * is that it reads the character's abilities the way the game actually hands
 * them over, and that every section draws.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: {}, prices: {}, character: null, testerOn: false, shopCosts: {} }));

/** What the panel asked the Tester shop to do, and how often */
const shop = vi.hoisted(() => ({ opened: 0, filtered: [], armed: [] }));

/** What the panel asked the game's buy dialog to be filled with, and for what */
const market = vi.hoisted(() => ({ filled: [], opened: [], initialized: 0 }));

/** The data manager's event bus, reduced to the one event this file cares about */
const bus = vi.hoisted(() => ({ handlers: {} }));

/** What the daily checkpoints have to say about a rate, when anything */
const longWindow = vi.hoisted(() => ({ rate: null }));

vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => market.initialized++,
        setQuantity: (quantity) => market.filled.push(quantity),
        setPendingCalculation: (fn, options) => shop.armed.push([fn(), options]),
        clearQuantity: () => market.filled.push(null),
        cleanup: () => {},
    }),
}));

vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => game.testerOn,
    testerShopCoinCost: (itemHrid) => game.shopCosts[itemHrid] || 0,
}));
vi.mock('../../utils/tester-shop-nav.js', () => ({
    openTesterShopPage: async () => {
        shop.opened++;
        return document.createElement('div');
    },
    setShopFilter: (name) => shop.filtered.push(name),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        get characterData() {
            return game.character;
        },
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (itemHrid) => market.opened.push(itemHrid),
}));
vi.mock('./ability-checkpoints.js', () => ({
    rateFor: () => longWindow.rate,
    rateWindowLabel: (rate) => `measured over ${rate.days} days, ${rate.daysWithGain} with combat`,
}));

const { abilityBookPanel, abilityPlans, resetAbilityTargets } = await import('./ability-book-panel.js');
const { default: dataManager } = await import('../../core/data-manager.js');

/** Each level costs 1,000 more experience than the last */
const table = [0, 0];
for (let level = 2; level <= 200; level++) table[level] = table[level - 1] + 1000;

beforeEach(() => {
    game.data = {
        levelExperienceTable: table,
        abilityDetailMap: {
            '/abilities/poke': { name: 'Poke' },
            '/abilities/smack': { name: 'Smack' },
            '/abilities/rare_move': { name: 'Rare Move' },
        },
        itemDetailMap: {
            '/items/poke': { name: 'Poke Book', abilityBookDetail: { experienceGain: 500 } },
            '/items/smack': { name: 'Smack Book', abilityBookDetail: { experienceGain: 500 } },
            '/items/rare_move': { name: 'Rare Move Book', abilityBookDetail: { experienceGain: 500 } },
        },
    };
    // Equipped is the kit; characterAbilities is where the experience lives
    game.character = {
        combatUnit: {
            combatAbilities: [
                { abilityHrid: '/abilities/poke', level: 2 },
                { abilityHrid: '/abilities/smack', level: 2 },
                { abilityHrid: '/abilities/rare_move', level: 0 },
            ],
        },
        characterAbilities: [
            { abilityHrid: '/abilities/poke', level: 2, experience: 1000 },
            { abilityHrid: '/abilities/smack', level: 2, experience: 1000 },
            { abilityHrid: '/abilities/never_slotted', level: 9, experience: 0 },
        ],
    };
    game.prices = {
        '/items/poke': { ask: 900000, bid: 1 },
        '/items/smack': { ask: 4000, bid: 1 },
    };
    market.filled = [];
    market.opened = [];
    longWindow.rate = null;
    game.testerOn = false;
    game.shopCosts = {};
    shop.opened = 0;
    shop.filtered = [];
    shop.armed = [];
});

afterEach(() => {
    abilityBookPanel.hide();
    // A panel remembers its targets between openings, which is right for a
    // panel and wrong for the next test
    resetAbilityTargets();
});

const text = () => abilityBookPanel.panel.textContent;

/**
 * Every tooltip in the panel, joined.
 *
 * The rows name abilities by their book's icon rather than in words, so what
 * the panel says about an ability is in a `title` and not in its text.
 */
const tooltips = () =>
    [...abilityBookPanel.panel.querySelectorAll('[title]')].map((el) => el.getAttribute('title')).join(' | ');

const FAILED = 'could not be drawn';

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        abilityBookPanel.show();

        // A row per ability, and each still says which ability it is — the icon
        // carries the name now, so the name is in a tooltip rather than in text
        expect(tooltips()).toContain('Poke');
        expect(tooltips()).toContain('Smack');
        expect(text()).not.toContain(FAILED);
    });

    test('only the equipped kit is listed, not everything ever learned', () => {
        // The panel is about what to buy next for the build you are running
        expect(abilityPlans().map((plan) => plan.name)).not.toContain('Never Slotted');
        expect(abilityPlans()).toHaveLength(3);
    });

    test('experience comes from the character, not from the equipped slot', () => {
        // The slot carries a level and no experience; without joining the two
        // every ability reads as freshly levelled and every plan costs a full
        // level more than it should
        expect(abilityPlans().find((plan) => plan.name === 'Poke').experience).toBe(1000);
    });

    test('it draws before the game has sent anything', () => {
        game.data = {};
        game.character = null;
        abilityBookPanel.show();
        expect(text()).toContain('No abilities');
        expect(text()).not.toContain(FAILED);
    });

    test('opening it twice does not build a second one', () => {
        abilityBookPanel.show();
        abilityBookPanel.show();
        expect(document.querySelectorAll('#toolasha-ability-book-panel')).toHaveLength(1);
    });
});

describe('what it puts first', () => {
    test('cheapest, not nearest', () => {
        // Poke and Smack are the same distance from their next level; Smack's
        // book costs a fraction of Poke's, and that is the whole question
        expect(abilityPlans()[0].name).toBe('Smack');
    });

    test('the cheapest reaches the header, written as the tile writes it', () => {
        abilityBookPanel.show();
        // Books and cost rather than a name — the same phrase the overlay tile
        // carries, so the panel opens showing what you opened it for
        expect(abilityBookPanel.headerBest.textContent).toContain('books');
        expect(abilityBookPanel.headerBest.textContent).toContain('2');
        expect(abilityBookPanel.headerBest.title).toContain('Smack');
    });

    test('an unpriced book sorts last and cannot win', () => {
        const plans = abilityPlans();
        expect(plans[plans.length - 1].name).toBe('Rare Move');
        expect(abilityBookPanel.panel).toBeNull();
    });

    test('an unpriced book says so rather than showing nothing', () => {
        abilityBookPanel.show();
        expect(text()).toContain('no price');
    });
});

describe('the rows', () => {
    test('an unlearned ability costs exactly the book that teaches it', () => {
        // Level 1 sits at zero experience, so nothing is owed towards it — the
        // one book is the ability itself, which is the case a plain division
        // reports as zero books
        const rare = abilityPlans().find((plan) => plan.name === 'Rare Move');
        expect(rare.level).toBe(0);
        expect(rare.booksToNext).toBe(1);

        abilityBookPanel.show();
        expect(tooltips()).toContain('Rare Move — not learned');
    });

    test('and a learned ability pays only for the experience', () => {
        // Poke is 1,000 experience from level 3 at 500 a book
        expect(abilityPlans().find((plan) => plan.name === 'Poke').booksToNext).toBe(2);
    });

    test('an ability whose book the game does not describe is not a row', () => {
        game.data.itemDetailMap = {};
        expect(abilityPlans()).toEqual([]);
    });
});

/** The bar's own input, which is the first one in the body */
const sharedInput = () => abilityBookPanel.panel.querySelector('input[type="number"]');

/** One ability's target spinner */
const targetInput = (abilityHrid) => abilityBookPanel.panel.querySelector(`input[data-ability="${abilityHrid}"]`);

describe('the shared target', () => {
    test('typing a level costs every ability up to it', () => {
        abilityBookPanel.show();

        const input = sharedInput();
        input.value = '5';
        input.dispatchEvent(new Event('change'));

        // Level 5 is at 4,000; Poke is at 1,000, so six books
        expect(abilityPlans().find((plan) => plan.name === 'Poke').booksToTarget).toBe(6);
    });

    test('the total says how many it could not price', () => {
        // Otherwise a lower bound reads as a total
        abilityBookPanel.show();
        expect(text()).toContain('1 unpriced');
    });

    test('clearing it goes back to the next level', () => {
        abilityBookPanel.show();
        const input = sharedInput();

        input.value = '5';
        input.dispatchEvent(new Event('change'));
        input.value = '';
        input.dispatchEvent(new Event('change'));

        expect(abilityPlans()[0].booksToTarget).toBeNull();
    });
});

describe('a target per ability', () => {
    test('one ability can be aimed without moving the others', () => {
        abilityBookPanel.show();

        const input = targetInput('/abilities/poke');
        input.value = '5';
        input.dispatchEvent(new Event('change'));

        expect(abilityPlans().find((plan) => plan.name === 'Poke').booksToTarget).toBe(6);
        expect(abilityPlans().find((plan) => plan.name === 'Smack').booksToTarget).toBeNull();
    });

    test('the next level is the resting state rather than a target', () => {
        // Storing it would leave the row stuck at a level it is about to pass
        abilityBookPanel.show();

        const input = targetInput('/abilities/poke');
        input.value = '3';
        input.dispatchEvent(new Event('change'));

        expect(abilityPlans().find((plan) => plan.name === 'Poke').targetLevel).toBeNull();
    });

    test('the total counts each ability where it is aimed', () => {
        abilityBookPanel.show();

        targetInput('/abilities/poke').value = '5';
        targetInput('/abilities/poke').dispatchEvent(new Event('change'));

        // Poke's six books to level 5, plus Smack's two and Rare Move's one to
        // their next — not everything at one target or everything at none
        expect(text()).toContain('9 books');
    });

    test('a level set for everything replaces the ones set one at a time', () => {
        abilityBookPanel.show();

        targetInput('/abilities/poke').value = '20';
        targetInput('/abilities/poke').dispatchEvent(new Event('change'));

        const shared = sharedInput();
        shared.value = '5';
        shared.dispatchEvent(new Event('change'));

        expect(abilityPlans().find((plan) => plan.name === 'Poke').targetLevel).toBe(5);
    });

    test('Reset puts everything back', () => {
        abilityBookPanel.show();

        targetInput('/abilities/poke').value = '20';
        targetInput('/abilities/poke').dispatchEvent(new Event('change'));

        const reset = [...abilityBookPanel.panel.querySelectorAll('button')].find((button) =>
            button.textContent.includes('Reset')
        );
        reset.click();

        expect(abilityPlans().every((plan) => plan.targetLevel === null)).toBe(true);
    });
});

describe('buying the books', () => {
    /** The book icon on one ability's row */
    const bookIcon = (abilityHrid) => {
        const input = abilityBookPanel.panel.querySelector(`input[data-ability="${abilityHrid}"]`);
        return [...input.parentElement.children].find((child) => child.style.cursor === 'pointer');
    };

    test('clicking a book opens it with the count already filled in', () => {
        abilityBookPanel.show();

        bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));

        // Poke is 1,000 experience from level 3 at 500 a book
        expect(market.filled).toEqual([2]);
        expect(market.opened).toEqual(['/items/poke']);
    });

    test('the count follows the target rather than the next level', () => {
        // Retyping it into the dialog is where it gets rounded to something
        // convenient, and 2,800 rather than 2,809 is one book short of a level
        abilityBookPanel.show();

        const target = abilityBookPanel.panel.querySelector('input[data-ability="/abilities/poke"]');
        target.value = '5';
        target.dispatchEvent(new Event('change'));

        bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));
        expect(market.filled).toEqual([6]);
    });

    test('a book with nothing to buy arms nothing rather than the last count', () => {
        // Poke has banked enough for level 3 already, so it needs no books —
        // and a quantity left armed from the previous click would be filled
        // into whatever you buy next
        game.character.characterAbilities[0].experience = 99_999;
        abilityBookPanel.show();

        bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));
        expect(market.filled).toEqual([null]);
        expect(market.opened).toEqual(['/items/poke']);
    });
});

describe('the time column', () => {
    test('an ability nobody is training has no arrival time rather than never', () => {
        abilityBookPanel.show();
        // One reading is not a rate, and "never" would be a claim about the future
        expect(abilityPlans().every((plan) => plan.experiencePerHour === null)).toBe(true);
        expect(text()).toContain('—/hr');
        expect(text()).not.toContain(FAILED);
    });
});

describe('switching character', () => {
    test('a target set for the departed character does not apply to the next one', () => {
        // Main sets Poke to level 20. An ironcow — same abilityHrid, level 2 —
        // switches in next: 20 is still ">  level" for it, so nothing would
        // have caught the stale target were it not cleared on the switch.
        abilityBookPanel.show();
        targetInput('/abilities/poke').value = '20';
        targetInput('/abilities/poke').dispatchEvent(new Event('change'));
        expect(abilityPlans().find((plan) => plan.name === 'Poke').targetLevel).toBe(20);

        game.character = {
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/poke', level: 2 }] },
            characterAbilities: [{ abilityHrid: '/abilities/poke', level: 2, experience: 0 }],
        };
        dataManager.emit('character_switched', {});

        expect(abilityPlans().find((plan) => plan.name === 'Poke').targetLevel).toBeNull();
    });

    test('the shared target does not survive a switch either', () => {
        abilityBookPanel.show();
        const shared = sharedInput();
        shared.value = '5';
        shared.dispatchEvent(new Event('change'));
        expect(abilityPlans()[0].targetLevel).not.toBeNull();

        dataManager.emit('character_switched', {});

        expect(abilityPlans().every((plan) => plan.targetLevel === null)).toBe(true);
    });

    test('a switch while the panel is closed does not open it', () => {
        expect(abilityBookPanel.panel).toBeNull();
        dataManager.emit('character_switched', {});
        expect(abilityBookPanel.panel).toBeNull();
    });

    test('an open panel redraws rather than being left showing stale rows', () => {
        abilityBookPanel.show();
        targetInput('/abilities/poke').value = '20';
        targetInput('/abilities/poke').dispatchEvent(new Event('change'));

        dataManager.emit('character_switched', {});

        // The redrawn target input reflects the reset, not the value typed
        // before the switch
        expect(targetInput('/abilities/poke').value).toBe('3');
    });

    test('a departed character does not leave a rate for the one that switched in', () => {
        // Main's Poke sits at 1,000 experience. abilityPlans() samples it once
        // on the way past, exactly as the networth row does every tick whether
        // or not the panel is open.
        vi.useFakeTimers();
        vi.setSystemTime(0);
        abilityPlans();

        // `character_switching` fires first, while `characterData` still
        // belongs to the departing character — the real sequence, and the
        // reason the history is cleared on this event rather than on
        // `character_switched`.
        dataManager.emit('character_switching', {});

        // An ironcow — same abilityHrid, a run that has already put far more
        // experience into Poke than main ever has — switches in.
        game.character = {
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/poke', level: 40 }] },
            characterAbilities: [{ abilityHrid: '/abilities/poke', level: 40, experience: 500_000 }],
        };
        dataManager.emit('character_switched', {});

        // Thirty seconds later, the row samples again. Nothing about this
        // reading looks like a reset — the experience went up, not down — so
        // the history's own guard against a different character never fires,
        // and the two readings get read as one character gaining 499,000
        // experience in thirty seconds.
        vi.setSystemTime(30_000);
        const plan = abilityPlans().find((entry) => entry.name === 'Poke');

        // A fresh character with one true reading has no rate to report, the
        // same as any other ability nobody has measured yet.
        expect(plan.experiencePerHour).toBeNull();

        vi.useRealTimers();
    });

    test('the history is clear before the arriving character’s data lands, not after', () => {
        // `character_switched` is deferred (see data-manager.js): the game's
        // own emit sequence has `characterData` already updated to the
        // arriving character by the time it fires. A row sampling in that gap
        // — after `character_switching`, before `character_switched` — must
        // already see a clean history, or the same spurious rate reappears
        // one tick earlier than the first test here catches.
        vi.useFakeTimers();
        vi.setSystemTime(0);
        abilityPlans();

        dataManager.emit('character_switching', {});
        game.character = {
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/poke', level: 40 }] },
            characterAbilities: [{ abilityHrid: '/abilities/poke', level: 40, experience: 500_000 }],
        };
        // `character_switched` deliberately not emitted yet — this is the gap

        vi.setSystemTime(30_000);
        const plan = abilityPlans().find((entry) => entry.name === 'Poke');
        expect(plan.experiencePerHour).toBeNull();

        vi.useRealTimers();
    });
});

describe('the rate the time column divides by', () => {
    test('a long enough checkpoint window replaces the live ten-minute rate', () => {
        longWindow.rate = {
            experiencePerHour: 3200,
            days: 14,
            daysWithGain: 3,
            gained: 1_075_200,
            from: '2026-03-01',
            to: '2026-03-15',
        };

        const plan = abilityPlans().find((entry) => entry.name === 'Poke');
        expect(plan.experiencePerHour).toBe(3200);
        expect(plan.rateWindow.days).toBe(14);
    });

    test('the window is on screen, not only in a tooltip', () => {
        longWindow.rate = {
            experiencePerHour: 3200,
            days: 14,
            daysWithGain: 3,
            gained: 1_075_200,
            from: '2026-03-01',
            to: '2026-03-15',
        };
        abilityBookPanel.show();

        // A bare per-hour figure from a fortnight, three days of which had any
        // fighting, reads as a sustained rate and is not one
        expect(text()).toContain('over 14d, 3 w/ combat');
        expect(tooltips()).toContain('measured over 14 days, 3 with combat');
    });

    test('too little checkpoint history falls back to the live rate, as before', () => {
        longWindow.rate = null;
        abilityBookPanel.show();

        // Nothing has been sampled twice in this test, so the live rate is
        // unmeasurable — which is exactly the behaviour that predates the
        // checkpoints and must survive them
        expect(abilityPlans().every((plan) => plan.rateWindow === null)).toBe(true);
        expect(text()).not.toContain('w/ combat');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the Tester shop as the buy side', () => {
    /**
     * Poke's book is 900,000 on the market and Smack's is 4,000, so Smack is
     * the cheapest next level; the shop sells Poke's book for one coin, which
     * is the whole point of the case
     */
    const shopSellsPokeCheap = () => {
        game.testerOn = true;
        game.shopCosts = { '/items/poke': 1 };
    };

    /** The book icon on one ability's row */
    const bookIcon = (abilityHrid) => {
        const input = abilityBookPanel.panel.querySelector(`input[data-ability="${abilityHrid}"]`);
        return [...input.parentElement.children].find((child) => child.style.cursor === 'pointer');
    };

    /** Let a click handler's awaits run out */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** The panel's markup, drawn fresh */
    const drawn = () => {
        abilityBookPanel.hide();
        abilityBookPanel.show();
        return abilityBookPanel.panel.innerHTML;
    };

    describe('with the setting off', () => {
        test('a shop selling the book for a coin changes nothing at all', () => {
            const before = drawn();
            game.shopCosts = { '/items/poke': 1 };

            expect(drawn()).toBe(before);
            expect(abilityPlans()[0].name).toBe('Smack');
            expect(abilityPlans().find((plan) => plan.name === 'Poke').bookPrice).toBe(900000);
        });

        test('the links still go to the marketplace', async () => {
            game.shopCosts = { '/items/poke': 1 };
            abilityBookPanel.show();

            bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));
            abilityBookPanel.headerBest.firstElementChild.dispatchEvent(new Event('click', { bubbles: true }));
            await settle();

            expect(shop.opened).toBe(0);
            expect(market.opened).toEqual(['/items/poke', '/items/smack']);
        });
    });

    test('a book the shop does not sell is untouched by the setting', () => {
        const before = drawn();
        game.testerOn = true;
        game.shopCosts = {};

        expect(drawn()).toBe(before);
        expect(abilityPlans()[0].name).toBe('Smack');
    });

    test('a shop dearer than the market does not raise a price', () => {
        const before = drawn();
        game.testerOn = true;
        game.shopCosts = { '/items/poke': 9_000_000, '/items/smack': 4000 };

        // 4,000 is the ask, not under it: strictly cheaper only
        expect(drawn()).toBe(before);
        expect(abilityPlans().find((plan) => plan.name === 'Poke').bookPrice).toBe(900000);
    });

    test('a book cheaper in the shop is costed at the shop, and that changes what is cheapest', () => {
        expect(abilityPlans()[0].name).toBe('Smack');

        shopSellsPokeCheap();
        const plans = abilityPlans();

        // Two books at one coin beats two books at 4,000
        expect(plans[0].name).toBe('Poke');
        expect(plans[0].bookPrice).toBe(1);
        expect(plans[0].costToNext).toBe(2);
        expect(plans.find((plan) => plan.name === 'Smack').costToNext).toBe(8000);
    });

    test('the header names the ability the shop makes cheapest, and says where the price came from', () => {
        shopSellsPokeCheap();
        abilityBookPanel.show();

        expect(abilityBookPanel.headerBest.title).toContain('Poke');
        expect(abilityBookPanel.headerBest.title).toContain('Tester shop');
        expect(abilityBookPanel.headerBest.textContent).toContain('(Tester shop)');
    });

    test('a shop-floored row says so rather than reading as a market quote', () => {
        shopSellsPokeCheap();
        abilityBookPanel.show();

        const row = abilityBookPanel.panel.querySelector('input[data-ability="/abilities/poke"]').parentElement;
        expect(row.textContent).toContain('shop');
        expect(tooltips()).toContain('the Tester shop price');
        // Smack is not sold there, so its row is a market quote and says nothing
        const smack = abilityBookPanel.panel.querySelector('input[data-ability="/abilities/smack"]').parentElement;
        expect(smack.textContent).not.toContain('shop');
    });

    test('the row link opens the shop, filtered, with the count armed', async () => {
        shopSellsPokeCheap();
        abilityBookPanel.show();

        bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));
        await settle();

        expect(shop.opened).toBe(1);
        expect(shop.filtered).toEqual(['Poke Book']);
        // Poke is 1,000 experience from level 3 at 500 a book
        expect(shop.armed).toEqual([[2, { itemHrid: '/items/poke' }]]);
        // The shop replaces the marketplace, it does not follow it
        expect(market.opened).toEqual([]);
        expect(market.filled).toEqual([]);
    });

    test('the header link opens the shop too, with nothing armed', async () => {
        shopSellsPokeCheap();
        abilityBookPanel.show();

        abilityBookPanel.headerBest.firstElementChild.dispatchEvent(new Event('click', { bubbles: true }));
        await settle();

        expect(shop.opened).toBe(1);
        expect(shop.filtered).toEqual(['Poke Book']);
        // The header carries no count, so there is no quantity to fill in
        expect(shop.armed).toEqual([]);
        expect(market.opened).toEqual([]);
    });

    test('a row the shop does not sell still goes to the marketplace with its count', async () => {
        shopSellsPokeCheap();
        abilityBookPanel.show();

        bookIcon('/abilities/smack').dispatchEvent(new Event('click', { bubbles: true }));
        await settle();

        expect(shop.opened).toBe(0);
        expect(market.opened).toEqual(['/items/smack']);
        expect(market.filled).toEqual([2]);
    });

    test('no buy control is pressed on any path', async () => {
        const clicked = [];
        const card = document.createElement('div');
        card.textContent = 'Poke Book';
        card.addEventListener('click', () => clicked.push('card'));
        const buy = document.createElement('button');
        buy.textContent = 'Buy';
        buy.addEventListener('click', () => clicked.push('buy'));
        document.body.append(card, buy);

        shopSellsPokeCheap();
        abilityBookPanel.show();
        bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));
        abilityBookPanel.headerBest.firstElementChild.dispatchEvent(new Event('click', { bubbles: true }));
        await settle();

        game.testerOn = false;
        abilityBookPanel.hide();
        abilityBookPanel.show();
        bookIcon('/abilities/poke').dispatchEvent(new Event('click', { bubbles: true }));
        await settle();

        expect(clicked).toEqual([]);
        card.remove();
        buy.remove();
    });
});
