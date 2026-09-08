/**
 * @vitest-environment happy-dom
 *
 * Reading a task card's reroll chooser, from the chooser the player actually
 * has rather than the one the tests used to invent.
 *
 * Every earlier test in this repo built the chooser as
 * ['Back', 'Pay 10K', 'Pay 1', 'MooPass Free Reroll (2)'], and the code was
 * written to match: a reroll option was a button whose label began with "Pay".
 * The devtools capture that finally arrived shows something else — the free
 * reroll is `<button class="Button_button__1Fe9z Button_fullWidth__17pVU">
 * MooPass Free Reroll</button>` with no count on it, and the paid options are
 * a currency icon and a number. Under the old reading a chooser like that
 * offers exactly one recognisable button, and once that one is unavailable
 * there is nothing left to press.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const character = vi.hoisted(() => ({ mooPassBuffs: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getMooPassBuffs: () => character.mooPassBuffs,
    },
}));

const {
    findRerollOptions,
    formatBulkRerollLabel,
    freeRerollsLeftIn,
    hasMooPass,
    parseRerollCost,
    readFreeRerollOffer,
} = await import('./task-reroll-options.js');

/**
 * A task card whose chooser is open, drawn the way the screenshots show it.
 *
 * @param {Array<Object>} specs - {label, icon, className, disabled, ariaDisabled}
 * @returns {HTMLElement} The card, on the board
 */
function chooserCard(specs) {
    const card = document.createElement('div');
    card.className = 'RandomTask_randomTask__1abc';

    const row = document.createElement('div');
    row.className = 'RandomTask_action__4jkl';
    for (const spec of specs) {
        const button = document.createElement('button');
        button.className = spec.className || 'Button_button__1Fe9z';
        if (spec.icon) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `/static/media/misc_sprite.svg#${spec.icon}`);
            svg.appendChild(use);
            button.appendChild(svg);
        }
        button.appendChild(document.createTextNode(spec.label));
        if (spec.disabled) button.disabled = true;
        if (spec.ariaDisabled) button.setAttribute('aria-disabled', 'true');
        button.addEventListener('click', () => {
            card.dataset.pressed = spec.label;
        });
        row.appendChild(button);
    }
    card.appendChild(row);
    document.body.appendChild(card);
    return card;
}

/** The chooser exactly as the user's devtools captured it */
const screenshotChooser = () => [
    { label: 'Back' },
    { label: '10,000', icon: 'coin' },
    { label: '1', icon: 'cowbell' },
    { label: 'MooPass Free Reroll', className: 'Button_button__1Fe9z Button_fullWidth__17pVU' },
];

beforeEach(() => {
    document.body.replaceChildren();
    character.mooPassBuffs = [];
});

describe('what the chooser is offering', () => {
    test('the free reroll is found with no count on its label and a fullWidth class', () => {
        const card = chooserCard(screenshotChooser());

        const free = findRerollOptions(card).find((option) => option.kind === 'free');

        expect(free).toBeDefined();
        expect(free.text).toBe('MooPass Free Reroll');
        expect(free.remaining).toBe(null);
        expect(free.available).toBe(true);
    });

    test('the paid options are found even though nothing says "Pay"', () => {
        // The whole of the third report: the old reader took a reroll option to
        // be a button whose text begins with "Pay", so a chooser drawn as an
        // icon and a number offered it nothing to press
        const card = chooserCard(screenshotChooser());

        const kinds = findRerollOptions(card).map((option) => option.kind);

        expect(kinds).toEqual(['coin', 'cowbell', 'free']);
    });

    test('the paid options are found even when the free reroll sits in its own container', () => {
        // The live DOM the player captured: the MooPass free reroll is inside a
        // RandomTask_rerollOptionsContainer, and the paid coin/cowbell buttons are
        // a level up beside it in the buttonsContainer. Narrowing the scan to the
        // rerollOption-named container found only the free button — so once the
        // free reroll was demoted for going nowhere, there was no paid option to
        // fall back to and the card was skipped with "No usable reroll option".
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';

        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'RandomTask_buttonsContainer__xyz';

        const paid = (label, icon) => {
            const button = document.createElement('button');
            button.className = 'Button_button__1Fe9z';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `/static/media/misc_sprite.svg#${icon}`);
            svg.appendChild(use);
            button.appendChild(svg);
            button.appendChild(document.createTextNode(label));
            buttonsContainer.appendChild(button);
        };
        paid('10,000', 'coin');
        paid('1', 'cowbell');

        const rerollOptionsContainer = document.createElement('div');
        rerollOptionsContainer.className = 'RandomTask_rerollOptionsContainer__abc';
        const free = document.createElement('button');
        free.className = 'Button_button__1Fe9z Button_fullWidth__17pVU';
        free.textContent = 'MooPass Free Reroll';
        rerollOptionsContainer.appendChild(free);
        buttonsContainer.appendChild(rerollOptionsContainer);

        card.appendChild(buttonsContainer);
        document.body.appendChild(card);

        expect(findRerollOptions(card).map((option) => option.kind)).toEqual(['coin', 'cowbell', 'free']);
    });

    test('"Pay 10K" is still read the same way, for the builds that word it so', () => {
        const card = chooserCard([{ label: 'Back' }, { label: 'Pay 10K' }, { label: 'Pay 1' }]);

        expect(findRerollOptions(card).map((option) => [option.kind, option.cost])).toEqual([
            ['coin', 10000],
            ['cowbell', 1],
        ]);
    });

    test('the icon wins over the size of the number', () => {
        // A 320-cowbell chooser would read as coins on magnitude alone
        const card = chooserCard([{ label: '320', icon: 'cowbell' }]);

        expect(findRerollOptions(card)[0].kind).toBe('cowbell');
    });

    test('the card’s own controls are never offered as rerolls', () => {
        const card = chooserCard([
            { label: 'Go' },
            { label: 'Reroll' },
            { label: '' },
            { label: 'Claim Reward' },
            { label: 'Confirm Discard' },
            { label: 'Back' },
        ]);

        expect(findRerollOptions(card)).toEqual([]);
    });

    test('Toolasha’s own injected buttons are not mistaken for reroll options', () => {
        const card = chooserCard([{ label: '10,000', icon: 'coin' }]);
        const mine = document.createElement('div');
        mine.className = 'mwi-task-profit';
        const button = document.createElement('button');
        button.textContent = '2,500,000';
        mine.appendChild(button);
        card.appendChild(mine);

        expect(findRerollOptions(card).map((option) => option.text)).toEqual(['10,000']);
    });

    test('a greyed-out option is found but not available', () => {
        const byClass = chooserCard([{ label: 'Free Reroll (0)', className: 'Button_disabled__7x' }]);
        expect(findRerollOptions(byClass)[0].available).toBe(false);

        const byAria = chooserCard([{ label: 'MooPass Free Reroll', ariaDisabled: true }]);
        expect(findRerollOptions(byAria)[0].available).toBe(false);
    });

    test('a free reroll counted down to zero is not available either', () => {
        // The count is what is left on the pass, so (0) is a button that looks
        // pressable and reaches no server — the exact state that talked the
        // bulk reroller into giving up on free rerolls permanently
        const card = chooserCard([{ label: 'MooPass Free Reroll (0)' }]);

        expect(findRerollOptions(card)[0].available).toBe(false);
    });
});

describe('label parsing', () => {
    test('reads what is left on the pass, and admits when the label does not say', () => {
        expect(freeRerollsLeftIn('MooPass Free Reroll (2)')).toBe(2);
        expect(freeRerollsLeftIn('MooPass Free Reroll (0)')).toBe(0);
        expect(freeRerollsLeftIn('MooPass Free Reroll')).toBe(null);
    });

    test('costs are read in whatever notation the build uses', () => {
        expect(parseRerollCost('10K')).toBe(10000);
        expect(parseRerollCost('10,000')).toBe(10000);
        expect(parseRerollCost('Pay 320K')).toBe(320000);
        expect(parseRerollCost('1')).toBe(1);
        expect(parseRerollCost('Back')).toBe(null);
    });

    describe('locale-grouped costs', () => {
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
            expect(parseRerollCost('10,000')).toBe(10000);
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]+(?:\.\d+)?` reads "10.000" as decimal 10, not
            // as ten thousand: the period isn't in the class, so the digit run
            // stops there and the leftover ".000" is misread as a decimal tail.
            asLocale('de-DE');
            expect(parseRerollCost('10.000')).toBe(10000);
        });
    });
});

describe('what the board can prove about the free reroll', () => {
    test('an open chooser with a free option is proof it is available', () => {
        chooserCard(screenshotChooser());

        expect(readFreeRerollOffer(document)).toEqual({ known: true, available: true, remaining: null });
    });

    test('an open chooser without one is proof it is not', () => {
        chooserCard([{ label: 'Back' }, { label: '10,000', icon: 'coin' }]);

        expect(readFreeRerollOffer(document)).toEqual({ known: true, available: false, remaining: 0 });
    });

    test('a board at rest proves nothing either way', () => {
        chooserCard([{ label: 'Go' }, { label: 'Reroll' }, { label: '' }]);

        expect(readFreeRerollOffer(document)).toEqual({ known: false, available: false, remaining: null });
    });

    test('the count comes through when the build prints one', () => {
        chooserCard([{ label: 'Back' }, { label: 'MooPass Free Reroll (2)' }]);

        expect(readFreeRerollOffer(document).remaining).toBe(2);
    });
});

describe('does this character have a MooPass', () => {
    test('an empty buff list is a character without one', () => {
        expect(hasMooPass()).toBe(false);
    });

    test('any MooPass buff is one with', () => {
        character.mooPassBuffs = [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05 }];
        expect(hasMooPass()).toBe(true);
    });
});

describe('the header button’s price', () => {
    const paid = { known: true, available: false, remaining: 0 };
    const freeUnknownCount = { known: true, available: true, remaining: null };
    const unseen = { known: false, available: false, remaining: null };

    test('a free next reroll is quoted FREE, not 10.0K', () => {
        // What the user photographed: the chooser is open with the MooPass free
        // reroll sitting in it, and the header button quotes "Reroll 10.0K💰 (1)"
        expect(formatBulkRerollLabel({ pendingCount: 1, mode: 'coin', cost: 10000, free: freeUnknownCount })).toBe(
            '🎲 Reroll FREE (1)'
        );
    });

    test('several pending with a known allowance splits free from paid', () => {
        expect(
            formatBulkRerollLabel({
                pendingCount: 3,
                mode: 'coin',
                cost: 10000,
                free: { known: true, available: true, remaining: 2 },
            })
        ).toBe('🎲 Reroll (2 free, 1×10.0K💰)');
    });

    test('an allowance that covers everything pending is just FREE', () => {
        expect(
            formatBulkRerollLabel({
                pendingCount: 2,
                mode: 'coin',
                cost: 10000,
                free: { known: true, available: true, remaining: 5 },
            })
        ).toBe('🎲 Reroll FREE (2)');
    });

    test('a free reroll with no count says what it knows and no more', () => {
        expect(formatBulkRerollLabel({ pendingCount: 3, mode: 'coin', cost: 10000, free: freeUnknownCount })).toBe(
            '🎲 Reroll FREE then 10.0K💰 (3)'
        );
    });

    test('a MooPass holder with no chooser open gets a star, not a promise', () => {
        expect(formatBulkRerollLabel({ pendingCount: 2, mode: 'coin', cost: 10000, free: unseen, mooPass: true })).toBe(
            '🎲 Reroll 10.0K💰* (2)'
        );
    });

    test('without a MooPass the cost is quoted flat', () => {
        expect(
            formatBulkRerollLabel({ pendingCount: 2, mode: 'coin', cost: 10000, free: unseen, mooPass: false })
        ).toBe('🎲 Reroll 10.0K💰 (2)');
    });

    test('a chooser that proved the pass is spent is quoted flat even with a MooPass', () => {
        expect(formatBulkRerollLabel({ pendingCount: 1, mode: 'coin', cost: 10000, free: paid, mooPass: true })).toBe(
            '🎲 Reroll 10.0K💰 (1)'
        );
    });

    test('cowbells and discards and an empty board keep their old wording', () => {
        expect(formatBulkRerollLabel({ pendingCount: 2, mode: 'cowbell', cost: 4, free: paid })).toBe(
            '🎲 Reroll 4🔔 (2)'
        );
        expect(formatBulkRerollLabel({ pendingCount: 2, mode: 'delete', cost: 0, free: paid })).toBe(
            '🗑 Discard Task (2)'
        );
        expect(formatBulkRerollLabel({ pendingCount: 0 })).toBe('✓ Tasks settled');
    });
});
