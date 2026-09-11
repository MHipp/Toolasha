/**
 * @vitest-environment happy-dom
 *
 * Filling a listing price the market will actually admit. The failure that
 * matters: the best standing offer sits outside the game's daily tradable
 * band (a stale order from before the band moved), and matching it fills a
 * price nobody can trade against.
 *
 * The price row itself: since the marketplace rework the center cell is a
 * plain `priceDisplay` div until the player clicks it — there is no `<input>`
 * to write in the common case — flanked by `-`/`+` step buttons and, when the
 * item has a stated band, `Min`/`Max` bound buttons. Fixtures below mirror
 * that shape rather than the pre-rework "always an `<input>`" one.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        getSettingValue: vi.fn((_key, fallback) => fallback),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

import config from '../../core/config.js';
import autoFillPrice, { tradableRangeFrom, clampToRange } from './auto-fill-price.js';

describe('reading the tradable range off the modal', () => {
    test('suffixed bounds parse to real numbers', () => {
        expect(tradableRangeFrom('Tradable range: 307M – 375M')).toEqual({ min: 307_000_000, max: 375_000_000 });
        expect(tradableRangeFrom('Tradable range: 1.5K – 2K')).toEqual({ min: 1500, max: 2000 });
    });

    test('plain and separator-formatted bounds parse too', () => {
        expect(tradableRangeFrom('Tradable range: 1,200 – 1,800')).toEqual({ min: 1200, max: 1800 });
    });

    test('a hyphen instead of an en-dash still reads', () => {
        expect(tradableRangeFrom('Tradable range: 100 - 200')).toEqual({ min: 100, max: 200 });
    });

    test('a modal stating no range yields null rather than a guess', () => {
        expect(tradableRangeFrom('Price (Best Buy Offer: 300,000,000)')).toBeNull();
        expect(tradableRangeFrom('')).toBeNull();
        expect(tradableRangeFrom(null)).toBeNull();
    });

    test('an inverted band is treated as unreadable', () => {
        expect(tradableRangeFrom('Tradable range: 400M – 300M')).toBeNull();
    });
});

describe('clamping the filled price', () => {
    const range = { min: 307_000_000, max: 375_000_000 };

    test('a stale best offer under the floor lands on the floor', () => {
        // The reported case: best buy offer 300M against a 307M–375M band
        expect(clampToRange(300_000_000, range)).toBe(307_000_000);
    });

    test('a price over the ceiling lands on the ceiling', () => {
        expect(clampToRange(400_000_000, range)).toBe(375_000_000);
    });

    test('a price inside the band is left exactly as filled', () => {
        expect(clampToRange(310_000_000, range)).toBe(310_000_000);
        expect(clampToRange(307_000_000, range)).toBe(307_000_000);
        expect(clampToRange(375_000_000, range)).toBe(375_000_000);
    });
});

describe('the one-shot is spent on work done, not on a modal being seen', () => {
    /**
     * A Sell Listing modal. `withControls` false is the half-committed shell the
     * observer can catch: header present, price controls not yet rendered.
     * @param {boolean} withControls - Whether the Best Price label exists yet
     * @returns {{modal: HTMLElement, clicks: string[]}}
     */
    const orderModal = (withControls) => {
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div class="MarketplacePanel_header__yahJo">Sell Listing</div>
            ${withControls ? '<span class="MarketplacePanel_bestPrice__1qP2x">Best Sell: 994,000</span>' : ''}`;
        const clicks = [];
        const label = modal.querySelector('span[class*="MarketplacePanel_bestPrice"]');
        if (label) label.addEventListener('click', () => clicks.push('best-price'));
        return { modal, clicks };
    };

    beforeEach(() => {
        autoFillPrice.processedModals = new WeakSet();
        autoFillPrice.timerRegistry.clearAll();
    });

    test('a fire before the price controls exist does not burn the one chance', () => {
        const early = orderModal(false);
        autoFillPrice.handleOrderModal(early.modal);
        expect(autoFillPrice.processedModals.has(early.modal)).toBe(false);

        // The same modal, now fully committed
        const label = document.createElement('span');
        label.className = 'MarketplacePanel_bestPrice__1qP2x';
        label.textContent = 'Best Sell: 994,000';
        let clicked = 0;
        label.addEventListener('click', () => (clicked += 1));
        early.modal.appendChild(label);

        autoFillPrice.handleOrderModal(early.modal);
        expect(clicked).toBe(1);

        // And not again
        autoFillPrice.handleOrderModal(early.modal);
        expect(clicked).toBe(1);
    });
});

/**
 * A marketplace order modal shaped like the game's real price row: a
 * `MarketplacePanel_input` center cell holding either a live `<input>` (once
 * the player has clicked into it) or, the default, a `priceDisplay` div —
 * flanked by `-`/`+` step buttons and, when the modal states a band, `Min`/
 * `Max` bound buttons. `withMultiplier` also splices the shortcuts feature's
 * own `mwi-mp-multiplier` ÷2/×2 wrappers onto either end of the row, exactly
 * where `injectMultiplierButtons` in marketplace-shortcuts.js puts them.
 * @param {Object} [options]
 * @param {string} [options.header] - Modal header text
 * @param {string} [options.rangeText] - The "Tradable range: ..." line, or '' for none
 * @param {string|number} options.price - The price shown, editing or not
 * @param {boolean} [options.editing] - Render a live `<input>` instead of the display div
 * @param {boolean} [options.hasBounds] - Whether Min/Max buttons exist
 * @param {boolean} [options.withMultiplier] - Splice in the ÷2/×2 wrappers
 * @returns {{modal: HTMLElement, clicks: string[], input: HTMLInputElement|null,
 *   priceDisplay: HTMLElement|null, rangeEl: HTMLElement|null,
 *   setDisplayed: (value: string) => void}}
 */
function orderModalWithPriceRow({
    header = 'Sell Listing',
    rangeText = '',
    price,
    editing = false,
    hasBounds = true,
    withMultiplier = false,
} = {}) {
    const minCell = hasBounds ? '<div class="MarketplacePanel_buttonContainer__min"><button>Min</button></div>' : '';
    const maxCell = hasBounds ? '<div class="MarketplacePanel_buttonContainer__max"><button>Max</button></div>' : '';
    const divCell = withMultiplier
        ? '<div class="MarketplacePanel_buttonContainer__div mwi-mp-multiplier"><button>÷2</button></div>'
        : '';
    const mulCell = withMultiplier
        ? '<div class="MarketplacePanel_buttonContainer__mul mwi-mp-multiplier"><button>×2</button></div>'
        : '';
    const centerCell = editing
        ? `<div class="MarketplacePanel_input__ctr"><input value="${price}"></div>`
        : `<div class="MarketplacePanel_input__ctr"><div class="MarketplacePanel_priceDisplay__ctr">${price}</div></div>`;

    const modal = document.createElement('div');
    modal.innerHTML = `
        <div class="MarketplacePanel_header__yahJo">${header}</div>
        <span class="range">${rangeText}</span>
        <div class="MarketplacePanel_inputContainer__1qP2x">
            <div class="MarketplacePanel_priceInputs__1qP2x">
                ${divCell}${minCell}
                <div class="MarketplacePanel_buttonContainer__dec"><button>-</button></div>
                ${centerCell}
                <div class="MarketplacePanel_buttonContainer__inc"><button>+</button></div>
                ${maxCell}${mulCell}
            </div>
        </div>`;
    document.body.appendChild(modal);

    const clicks = [];
    const buttonNamed = (text) =>
        Array.from(modal.querySelectorAll('button')).find((b) => b.textContent.trim() === text) || null;
    ['Min', '-', '+', 'Max', '÷2', '×2'].forEach((text) => {
        buttonNamed(text)?.addEventListener('click', () => clicks.push(text));
    });

    return {
        modal,
        clicks,
        input: modal.querySelector('input'),
        priceDisplay: modal.querySelector('div[class*="MarketplacePanel_priceDisplay"]'),
        rangeEl: modal.querySelector('.range'),
        setDisplayed(value) {
            const display = modal.querySelector('div[class*="MarketplacePanel_priceDisplay"]');
            if (display) display.textContent = value;
            const input = modal.querySelector('input');
            if (input) input.value = value;
        },
    };
}

describe("clamping a price by pressing the game's own bound buttons", () => {
    afterEach(() => {
        autoFillPrice.clampState = new WeakMap();
        document.body.innerHTML = '';
    });

    test('a displayed price above the ceiling clicks Max once', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);
    });

    test('a displayed price below the floor clicks Min', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '50,000,000',
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Min']);
    });

    test('a displayed price inside the band is left alone', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '70,000,000',
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual([]);
    });

    test('a focused edit-mode input is left alone even when out of range', () => {
        const { modal, input, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
            editing: true,
        });
        input.focus();
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual([]);
    });

    test('an out-of-range edit-mode input that is not focused is still clamped by button', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
            editing: true,
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);
    });

    test('no Min/Max buttons means no press, even out of range', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
            hasBounds: false,
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual([]);
    });

    test('the bound button is still found past the ÷2/×2 multiplier wrappers', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
            withMultiplier: true,
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);
    });

    test("the game's own exact bound, still outside a range parsed from rounded text, is not re-pressed", () => {
        const { modal, clicks, setDisplayed } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);

        // The game settles on its own exact ceiling; the rounded range text
        // still calls this "above 77.8M"
        setDisplayed('77,841,234');
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);

        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);
    });

    test('a later change to a different out-of-range price presses again', () => {
        const { modal, clicks, setDisplayed } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 63.8M – 77.8M',
            price: '100,000,000',
        });
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max']);

        setDisplayed('77,841,234');
        autoFillPrice.clampPriceToTradableRange(modal); // captures the produced price
        expect(clicks).toEqual(['Max']);

        // A best-price refill (or a band re-render after an enhancement-level
        // change) lands on a new, different out-of-range price
        setDisplayed('90,000,000');
        autoFillPrice.clampPriceToTradableRange(modal);
        expect(clicks).toEqual(['Max', 'Max']);
    });
});

describe('the clamp stays live on the interval while the modal is open', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        autoFillPrice.timerRegistry.clearAll();
        autoFillPrice.clampState = new WeakMap();
    });

    afterEach(() => {
        autoFillPrice.timerRegistry.clearAll();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('a displayed price above the ceiling is clicked to Max on the first tick', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 15.1M – 18.4M',
            price: '20,000,000',
        });
        autoFillPrice.watchPriceBand(modal);
        vi.advanceTimersByTime(300);
        expect(clicks).toEqual(['Max']);
    });

    test('the produced price is not re-pressed on later ticks', () => {
        const { modal, clicks, setDisplayed } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 15.1M – 18.4M',
            price: '20,000,000',
        });
        autoFillPrice.watchPriceBand(modal);
        vi.advanceTimersByTime(300);
        expect(clicks).toEqual(['Max']);

        setDisplayed('18,432,109');
        vi.advanceTimersByTime(900); // three more ticks: capture, then two no-ops
        expect(clicks).toEqual(['Max']);
    });

    test('a focused input is never touched by the interval', () => {
        const { modal, input, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 15.1M – 18.4M',
            price: '20,000,000',
            editing: true,
        });
        input.focus();
        autoFillPrice.watchPriceBand(modal);
        vi.advanceTimersByTime(900);
        expect(clicks).toEqual([]);
    });

    test('a closed modal stops being watched', () => {
        const { modal, clicks } = orderModalWithPriceRow({
            rangeText: 'Tradable range: 15.1M – 18.4M',
            price: '20,000,000',
        });
        autoFillPrice.watchPriceBand(modal);
        modal.remove();
        vi.advanceTimersByTime(900);
        expect(clicks).toEqual([]);
    });
});

describe('adjustPrice presses the step button matching the strategy, not an index', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        config.getSettingValue.mockImplementation((_key, fallback) => fallback);
    });

    test('buy outbid presses +', () => {
        config.getSettingValue.mockImplementation((key) => (key === 'market_autoFillBuyStrategy' ? 'outbid' : 'match'));
        const { modal, clicks } = orderModalWithPriceRow({ header: 'Buy Listing', price: '1,000' });
        autoFillPrice.adjustPrice(modal, true, false);
        expect(clicks).toEqual(['+']);
    });

    test('buy undercut presses -', () => {
        config.getSettingValue.mockImplementation((key) =>
            key === 'market_autoFillBuyStrategy' ? 'undercut' : 'match'
        );
        const { modal, clicks } = orderModalWithPriceRow({ header: 'Buy Listing', price: '1,000' });
        autoFillPrice.adjustPrice(modal, true, false);
        expect(clicks).toEqual(['-']);
    });

    test('buy match presses nothing', () => {
        config.getSettingValue.mockImplementation((key) => (key === 'market_autoFillBuyStrategy' ? 'match' : 'match'));
        const { modal, clicks } = orderModalWithPriceRow({ header: 'Buy Listing', price: '1,000' });
        autoFillPrice.adjustPrice(modal, true, false);
        expect(clicks).toEqual([]);
    });

    test('sell undercut presses -', () => {
        config.getSettingValue.mockImplementation((key) =>
            key === 'market_autoFillSellStrategy' ? 'undercut' : 'match'
        );
        const { modal, clicks } = orderModalWithPriceRow({ header: 'Sell Listing', price: '1,000' });
        autoFillPrice.adjustPrice(modal, false, true);
        expect(clicks).toEqual(['-']);
    });

    test('sell match presses nothing', () => {
        config.getSettingValue.mockImplementation((key) => (key === 'market_autoFillSellStrategy' ? 'match' : 'match'));
        const { modal, clicks } = orderModalWithPriceRow({ header: 'Sell Listing', price: '1,000' });
        autoFillPrice.adjustPrice(modal, false, true);
        expect(clicks).toEqual([]);
    });

    test('buy outbid presses + with the ÷2/×2 multiplier wrappers present', () => {
        config.getSettingValue.mockImplementation((key) => (key === 'market_autoFillBuyStrategy' ? 'outbid' : 'match'));
        const { modal, clicks } = orderModalWithPriceRow({
            header: 'Buy Listing',
            price: '1,000',
            withMultiplier: true,
        });
        autoFillPrice.adjustPrice(modal, true, false);
        expect(clicks).toEqual(['+']);
    });

    test('sell undercut presses - with the ÷2/×2 multiplier wrappers present', () => {
        config.getSettingValue.mockImplementation((key) =>
            key === 'market_autoFillSellStrategy' ? 'undercut' : 'match'
        );
        const { modal, clicks } = orderModalWithPriceRow({
            header: 'Sell Listing',
            price: '1,000',
            withMultiplier: true,
        });
        autoFillPrice.adjustPrice(modal, false, true);
        expect(clicks).toEqual(['-']);
    });
});
