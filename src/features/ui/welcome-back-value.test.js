/** @vitest-environment happy-dom */

/**
 * The line added to the game's Welcome Back modal.
 *
 * The arithmetic is the easy half and is tested directly. The half worth more
 * attention is what happens when the modal is not what this expects: a dialog
 * that is not the welcome modal must be left completely alone, an item with no
 * price must not be silently valued at zero, and a modal that yields nothing
 * priceable must produce no row at all rather than a confident "Net 0".
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const settings = vi.hoisted(() => ({ values: { welcomeBackValue: true } }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => settings.values[key] ?? fallback,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
    },
}));

const observer = vi.hoisted(() => ({ handlers: [], unregistered: 0 }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classes, callback) => {
            observer.handlers.push({ name, classes, callback });
            return () => {
                observer.unregistered += 1;
            };
        },
    },
}));

const market = vi.hoisted(() => ({ prices: {} }));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => market.prices[hrid] || null },
}));

const {
    default: welcomeBackValue,
    ROW_CLASS,
    parseOfflineDuration,
    parseExperience,
    readModalItems,
    summarizeWelcomeBack,
    formatSummary,
    isWelcomeBackModal,
    findWelcomeBackModal,
    enrichModal,
} = await import('./welcome-back-value.js');

/** A price table where everything is worth `unit` coins */
const flatPrices = (unit) => () => unit;

/**
 * A stand-in for the game's item tile.
 * @param {string} id - Sprite id, which is the item hrid's last segment
 * @param {string} count - The count exactly as the game would draw it
 * @returns {string} HTML
 */
const tile = (id, count) =>
    `<div class="Item_itemContainer__x7kH1"><svg><use href="/static/media/items.svg#${id}"></use></svg>` +
    `<div class="Item_count__1HVvv">${count}</div></div>`;

/**
 * The welcome modal, as the game draws it.
 * @param {string} inner - Body HTML
 * @returns {HTMLElement} The modal content element
 */
function welcomeModal(inner) {
    document.body.innerHTML =
        '<div class="Modal_modalContainer__3Ryek"><div class="Modal_modal__2gJa9">' +
        `<div class="Modal_modalContent__1jJa2"><h1 class="WelcomeBack_title__9aQ">Welcome Back</h1>${inner}</div>` +
        '</div></div>';
    return document.querySelector('[class*="Modal_modalContent"]');
}

beforeEach(() => {
    document.body.innerHTML = '';
    observer.handlers.length = 0;
    observer.unregistered = 0;
    market.prices = {};
    settings.values = { welcomeBackValue: true, profitCalc_pricingMode: 'conservative' };
});

describe('how long you were away', () => {
    test('reads a clock', () => {
        expect(parseOfflineDuration('You were away for 08:30:00')).toBe(8.5 * 3_600_000);
    });

    test('reads a clock without hours as minutes and seconds', () => {
        expect(parseOfflineDuration('45:30')).toBe((45 * 60 + 30) * 1000);
    });

    test('reads spelled-out units, and adds them', () => {
        expect(parseOfflineDuration('Offline for 1d 2h 30m')).toBe(26.5 * 3_600_000);
        expect(parseOfflineDuration('2 hours 15 minutes')).toBe(2.25 * 3_600_000);
    });

    test('refuses to guess, so the rates are simply left off', () => {
        expect(parseOfflineDuration('a while')).toBeNull();
        expect(parseOfflineDuration(null)).toBeNull();
    });
});

describe('experience', () => {
    test('sums every skill the modal lists', () => {
        expect(parseExperience('Milking 12,000 XP Cheesesmithing 3.5K XP')).toBe(15_500);
    });

    test('is zero when the modal names none', () => {
        expect(parseExperience('nothing here')).toBe(0);
    });

    describe('locale-grouped figures', () => {
        const asLocale = (value) => {
            localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        test('en-US comma grouping', () => {
            asLocale('en-US');
            expect(parseExperience('Milking 12,000 XP')).toBe(12_000);
        });

        test('fr-FR space grouping — the bug this replaces', () => {
            // A hardcoded comma/period union captures nothing at all for a
            // space-grouped figure, since a space is in neither character class.
            asLocale('fr-FR');
            expect(parseExperience('Milking 12 000 XP')).toBe(12_000);
        });
    });
});

describe('reading the items off the modal', () => {
    test('takes the hrid from the sprite and the count from the label', () => {
        const modal = welcomeModal(tile('milk', '1,240'));
        expect(readModalItems(modal)).toEqual([{ hrid: '/items/milk', count: 1240 }]);
    });

    test('a negative count is something that was consumed, not gained', () => {
        const modal = welcomeModal(tile('efficiency_tea', '-12'));
        expect(readModalItems(modal)).toEqual([{ hrid: '/items/efficiency_tea', count: -12 }]);
    });

    test('a labelled section is read the same way as a minus sign', () => {
        const modal = welcomeModal(`<div>Consumed</div><div>${tile('efficiency_tea', '12')}</div>`);
        expect(readModalItems(modal)).toEqual([{ hrid: '/items/efficiency_tea', count: -12 }]);
    });

    test('a tile with no sprite or no count is skipped rather than guessed at', () => {
        const modal = welcomeModal('<div class="Item_itemContainer__x"><div class="Item_count__y">5</div></div>');
        expect(readModalItems(modal)).toEqual([]);
    });
});

describe('the arithmetic', () => {
    const eightHours = 8 * 3_600_000;

    test('nets the consumables off the gains and rates both by the hours offline', () => {
        const summary = summarizeWelcomeBack({
            items: [
                { hrid: '/items/milk', count: 1000 },
                { hrid: '/items/efficiency_tea', count: -100 },
            ],
            experience: 80_000,
            durationMs: eightHours,
            priceOf: flatPrices(10),
        });

        expect(summary.gained).toBe(10_000);
        expect(summary.spent).toBe(1_000);
        expect(summary.net).toBe(9_000);
        expect(summary.perHour).toBe(9_000 / 8);
        expect(summary.xpPerHour).toBe(10_000);
    });

    test('coins are worth themselves, whatever the market says', () => {
        const summary = summarizeWelcomeBack({
            items: [{ hrid: '/items/coin', count: 5000 }],
            durationMs: null,
            priceOf: () => null,
        });

        expect(summary.net).toBe(5000);
        expect(summary.unpriced).toBe(0);
    });

    test('an unpriced item is counted, never valued at zero and folded in', () => {
        const summary = summarizeWelcomeBack({
            items: [
                { hrid: '/items/milk', count: 10 },
                { hrid: '/items/mystery', count: 10 },
            ],
            durationMs: null,
            priceOf: (hrid) => (hrid === '/items/milk' ? 7 : null),
        });

        expect(summary.net).toBe(70);
        expect(summary.priced).toBe(1);
        expect(summary.unpriced).toBe(1);
    });

    test('no duration means no rates, rather than a division by nothing', () => {
        const summary = summarizeWelcomeBack({
            items: [{ hrid: '/items/milk', count: 1 }],
            experience: 500,
            durationMs: null,
            priceOf: flatPrices(3),
        });

        expect(summary.perHour).toBeNull();
        expect(summary.xpPerHour).toBeNull();
    });
});

describe('the line itself', () => {
    test('leads with the net and only mentions consumables when there were some', () => {
        const line = formatSummary({ net: 9000, gained: 10000, spent: 1000, perHour: 1125, xpPerHour: 0, unpriced: 0 });
        expect(line).toContain('Net 9,000');
        expect(line).toContain('used');

        const clean = formatSummary({ net: 500, gained: 500, spent: 0, perHour: null, xpPerHour: null, unpriced: 0 });
        expect(clean).toBe('Net 500');
    });

    test('says how many items it could not price', () => {
        const line = formatSummary({ net: 1, gained: 1, spent: 0, perHour: null, xpPerHour: null, unpriced: 3 });
        expect(line).toContain('3 unpriced');
    });
});

describe('finding the modal', () => {
    test('recognises it by its own class', () => {
        const modal = welcomeModal(tile('milk', '5'));
        expect(isWelcomeBackModal(modal)).toBe(true);
        expect(findWelcomeBackModal(modal)).toBe(modal);
    });

    test('recognises it by its heading when the class has been renamed', () => {
        document.body.innerHTML =
            '<div class="Modal_modalContent__x"><h1 class="Something_title__y">Welcome back!</h1></div>';
        expect(isWelcomeBackModal(document.querySelector('[class*="Modal_modalContent"]'))).toBe(true);
    });

    test('leaves every other dialog in the game alone', () => {
        document.body.innerHTML = '<div class="Modal_modalContent__x"><h1>Buy Now</h1></div>';
        const other = document.querySelector('[class*="Modal_modalContent"]');
        expect(isWelcomeBackModal(other)).toBe(false);
        expect(findWelcomeBackModal(other)).toBeNull();
        expect(enrichModal(other, flatPrices(5))).toBeNull();
    });

    test('a node inside the modal still finds the modal', () => {
        const modal = welcomeModal(tile('milk', '5'));
        const inner = modal.querySelector('[class*="Item_itemContainer"]');
        expect(findWelcomeBackModal(inner)).toBe(modal);
    });
});

describe('injecting the row', () => {
    test('adds exactly one line, with the totals on it', () => {
        const modal = welcomeModal(`<div>You were away for 04:00:00</div>${tile('milk', '400')} 8,000 XP`);

        expect(enrichModal(modal, flatPrices(10))).toBeTruthy();

        const rows = modal.querySelectorAll(`.${ROW_CLASS}`);
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('Toolasha');
        expect(rows[0].textContent).toContain('Net 4,000');
        expect(rows[0].textContent).toContain('/hr');
    });

    test('a second pass over the same modal does not stack a second line', () => {
        const modal = welcomeModal(tile('milk', '400'));
        enrichModal(modal, flatPrices(10));
        enrichModal(modal, flatPrices(10));
        expect(modal.querySelectorAll(`.${ROW_CLASS}`)).toHaveLength(1);
    });

    test('draws nothing when nothing could be priced', () => {
        const modal = welcomeModal(tile('mystery', '400'));
        expect(enrichModal(modal, () => null)).toBeNull();
        expect(modal.querySelector(`.${ROW_CLASS}`)).toBeNull();
    });

    test('prices through the market API and the pricing mode when not given a lookup', () => {
        market.prices['/items/milk'] = { ask: 20, bid: 10 };
        const modal = welcomeModal(tile('milk', '100'));

        enrichModal(modal);

        // Conservative pricing means the bid, so 100 × 10 rather than 100 × 20
        expect(modal.querySelector(`.${ROW_CLASS}`).textContent).toContain('Net 1,000');
    });

    test('a modal that throws on the way through leaves the game’s own dialog intact', () => {
        const modal = welcomeModal(tile('milk', '400'));
        const thrower = () => {
            throw new Error('market exploded');
        };
        expect(enrichModal(modal, thrower)).toBeNull();
        expect(modal.querySelector(`.${ROW_CLASS}`)).toBeNull();
    });
});

describe('the feature wiring', () => {
    test('watches for the modal and enriches it when it appears', () => {
        welcomeBackValue.initialize();
        expect(observer.handlers).toHaveLength(1);

        market.prices['/items/milk'] = { ask: 20, bid: 10 };
        const modal = welcomeModal(`${tile('milk', '100')}<div>02:00:00</div>`);
        observer.handlers[0].callback(modal);

        expect(modal.querySelector(`.${ROW_CLASS}`)).toBeTruthy();
        welcomeBackValue.cleanup();
    });

    test('a switched-off feature registers nothing', () => {
        settings.values.welcomeBackValue = false;
        welcomeBackValue.initialize();
        expect(observer.handlers).toHaveLength(0);
    });

    test('cleanup unhooks the observer and takes the row away with it', () => {
        welcomeBackValue.initialize();
        market.prices['/items/milk'] = { ask: 20, bid: 10 };
        const modal = welcomeModal(tile('milk', '100'));
        observer.handlers[0].callback(modal);

        welcomeBackValue.cleanup();

        expect(observer.unregistered).toBe(1);
        expect(document.querySelector(`.${ROW_CLASS}`)).toBeNull();
    });
});
