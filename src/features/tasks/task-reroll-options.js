/**
 * What a task card's reroll chooser is offering, and what it costs.
 *
 * Pressing a task's Reroll button swaps its action row for a chooser. Every
 * feature that has anything to say about a reroll — the bulk reroller pressing
 * one, protection cancelling one, the header button pricing the next one — has
 * to answer the same question first: which of the buttons on this card is a
 * reroll, and is it free, coins or cowbells?
 *
 * Toolasha used to answer it by reading the label: a reroll option was a button
 * whose text began with "Pay". Nothing in the game guarantees that, and the
 * screenshots of the chooser that finally arrived show it does not hold — the
 * paid options are an icon and a number, and the free one is
 * "MooPass Free Reroll" with no count at all. Under that reading the chooser
 * offers exactly one recognisable button, the free one, and the moment the free
 * one is unavailable (or has been demoted for going nowhere) the bulk reroller
 * finds nothing to press, returns false, and does nothing at all — for the rest
 * of the session, while its label keeps promising a 10.0K reroll.
 *
 * So the chooser is read structurally instead: everything that is not one of the
 * card's own controls (Back, Go, Reroll, Claim, Confirm Discard, the icon-only
 * trash can) and not Toolasha's own injected furniture is a reroll option, and
 * its currency comes from the icon it carries, falling back to the size of the
 * number in its label. That recognises "Pay 10K", "10,000" and a bare icon
 * button alike, and it keeps recognising them when the next build renames
 * everything.
 */

import dataManager from '../../core/data-manager.js';
import { formatKMB } from '../../utils/formatters.js';
import { parseGameNumber, gameDigitsSource } from '../../utils/number-parser.js';

/**
 * Buttons that live on a task card and are never a reroll option.
 * The trash can carries no text at all and is skipped separately.
 */
const CONTROL_LABELS = /^(back|go|reroll|claim|claim reward|cancel|close)$/i;

/** Confirm Discard, however the build words it — a discard is not a reroll */
const DISCARD_LABEL = /discard/i;

/**
 * The free reroll, however the build words it.
 *
 * "MooPass Free Reroll", "Free Reroll (2)", plain "Free" — matched on the one
 * word that has been in all of them. Matching it too narrowly is not harmless:
 * an unmatched free reroll is a reroll protection lets through and a reroll the
 * bulk reroller pays for.
 */
const FREE_LABEL = /\bfree\b/i;

/** A cost below this many units is cowbells; at or above it, coins */
const COIN_COST_FLOOR = 1000;

/**
 * Is this one of Toolasha's own buttons rather than the game's?
 *
 * The profit display and the estimate panels inject buttons into the card, and
 * some of them carry numbers. Reading one as a reroll option would have the
 * bulk reroller press it.
 *
 * @param {Element} button - Any button
 * @returns {boolean}
 */
function isInjectedByToolasha(button) {
    if (typeof button.closest !== 'function') return false;
    return Boolean(button.closest('[class^="mwi-"], [class*=" mwi-"], [id^="mwi-"]'));
}

/**
 * Is the game refusing this button?
 *
 * `disabled` is the honest form, but a button greyed out by class or by aria
 * alone is just as unclickable, and treating it as available is a click that
 * goes nowhere — which is exactly how the bulk reroller talked itself into
 * believing a working MooPass was spent.
 *
 * @param {Element} button - Any button
 * @returns {boolean}
 */
export function isButtonUnavailable(button) {
    if (!button) return true;
    if (button.disabled) return true;
    if (button.getAttribute?.('aria-disabled') === 'true') return true;
    return /disabled/i.test(button.className || '');
}

/**
 * How many free rerolls the label says are left, when it says at all.
 *
 * The chooser has carried "MooPass Free Reroll (2)" on some builds and a bare
 * "MooPass Free Reroll" on others, so a missing count is unknown rather than
 * zero — reading it as zero would hide a free reroll that is sitting right
 * there.
 *
 * @param {string} text - The button's label
 * @returns {number|null} Rerolls left, or null when the label does not say
 */
export function freeRerollsLeftIn(text) {
    const match = /\((\d+)\)/.exec(text || '');
    return match ? parseInt(match[1], 10) : null;
}

/**
 * The number in a reroll option's label, in whole units.
 *
 * Built from {@link gameDigitsSource} rather than the hardcoded
 * `[\d,]+(?:\.\d+)?`, which assumed comma grouping and a period decimal —
 * both wrong in a period-grouping locale (de-DE, fr-FR...), where the old
 * pattern stopped at the first group boundary and then read a stray digit run
 * left over from the group separator as a decimal tail.
 *
 * @param {string} text - The button's label
 * @returns {number|null} Cost, or null when the label carries no number
 */
export function parseRerollCost(text) {
    const match = new RegExp(`(${gameDigitsSource()})\\s*([KMB])?`, 'i').exec(text || '');
    if (!match) return null;
    const raw = parseGameNumber(match[1]);
    if (!Number.isFinite(raw)) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] || '').toLowerCase()] || 1;
    return raw * scale;
}

/**
 * Which currency an option is priced in, read from the icon it carries.
 *
 * @param {Element} button - A chooser button
 * @returns {string|null} 'coin', 'cowbell', or null when it carries no icon
 */
function currencyFromIcon(button) {
    const uses = button.querySelectorAll?.('use') || [];
    for (const use of uses) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (/cowbell/i.test(href)) return 'cowbell';
        if (/coin|gold/i.test(href)) return 'coin';
    }
    return null;
}

/**
 * Read one button as a reroll option.
 *
 * @param {Element} button - A button on a task card
 * @returns {{button: Element, kind: string, text: string, cost: number|null,
 *   remaining: number|null, available: boolean}|null} The option, or null when
 *   the button is not one
 */
export function readRerollOption(button) {
    if (!button || isInjectedByToolasha(button)) return null;

    const text = (button.textContent || '').trim();
    // The icon-only trash can, and anything else the game draws without words
    if (!text) return null;
    if (CONTROL_LABELS.test(text)) return null;
    if (DISCARD_LABEL.test(text)) return null;

    const describe = (kind, cost, remaining) => ({
        button,
        kind,
        text,
        cost,
        remaining,
        available: !isButtonUnavailable(button) && !(kind === 'free' && remaining === 0),
    });

    if (FREE_LABEL.test(text)) {
        return describe('free', 0, freeRerollsLeftIn(text));
    }

    const cost = parseRerollCost(text);
    const kind = currencyFromIcon(button) || (cost === null ? null : cost >= COIN_COST_FLOOR ? 'coin' : 'cowbell');
    // A button with words but no number and no currency icon is some control
    // this function has not been taught about; pressing it is not this
    // module's guess to make
    if (!kind) return null;

    return describe(kind, cost, null);
}

/**
 * Every reroll option the card is currently offering.
 *
 * Read off the whole card, because narrowing to a `*rerollOption*` container
 * first was the bug behind "the menu opens but nothing rerolls". The live
 * chooser puts the MooPass free reroll in its own `RandomTask_rerollOptionsContainer`
 * and leaves the paid coin and cowbell buttons a level up in the
 * `buttonsContainer` beside it — so scoping to the first `rerollOption`-named
 * element found exactly one button, the free one, and the moment that free
 * reroll was unavailable or demoted the reader had no paid option to fall back
 * to and gave up on the card. The per-button filter below is what does the real
 * work: a card at rest carries only controls (Go, Reroll, Claim, the icon-only
 * trash can) and Toolasha's own injected furniture, and every one of those is
 * rejected, so the whole-card scan offers nothing until a chooser is actually
 * open.
 *
 * @param {Element|null|undefined} card - A task card
 * @returns {Array<Object>} The options, in the order the card draws them
 */
export function findRerollOptions(card) {
    if (!card || typeof card.querySelectorAll !== 'function') return [];

    const options = [];
    for (const button of card.querySelectorAll('button')) {
        const option = readRerollOption(button);
        if (option) options.push(option);
    }
    return options;
}

/**
 * What the board can currently prove about the free MooPass reroll.
 *
 * The free reroll's availability is not in character data anywhere Toolasha can
 * read it — the one honest source is the chooser itself, which only exists
 * while a card is mid-flow. So this reports three states rather than two, and
 * the callers are expected to say "may be free" rather than "free" for the
 * third.
 *
 * @param {ParentNode} [root=document] - Where the board is
 * @returns {{known: boolean, available: boolean, remaining: number|null}}
 */
export function readFreeRerollOffer(root = document) {
    const unknown = { known: false, available: false, remaining: null };
    if (!root || typeof root.querySelectorAll !== 'function') return unknown;

    let sawChooser = false;
    for (const card of root.querySelectorAll('[class*="RandomTask_randomTask"]')) {
        const options = findRerollOptions(card);
        if (!options.length) continue;
        sawChooser = true;
        const free = options.find((option) => option.kind === 'free' && option.available);
        if (free) return { known: true, available: true, remaining: free.remaining };
    }

    // A chooser was open and had no free option in it: the pass is spent, or
    // there is no pass. Either way the next reroll is paid for.
    if (sawChooser) return { known: true, available: false, remaining: 0 };
    return unknown;
}

/**
 * Does this character have a MooPass?
 *
 * Read the same way the combat sim reads it: the pass is what puts buffs in
 * `mooPassBuffs`, and an empty list is a character without one.
 *
 * @returns {boolean}
 */
export function hasMooPass() {
    try {
        const buffs = dataManager.getMooPassBuffs?.();
        return Array.isArray(buffs) && buffs.length > 0;
    } catch (error) {
        console.error('[TaskRerollOptions] Failed to read MooPass status:', error);
        return false;
    }
}

/**
 * The bulk reroller's button label.
 *
 * Kept here, next to the reading of the chooser, because the label is a claim
 * about what the next click will cost and the chooser is the only thing that
 * knows. The three cases it has to keep apart:
 *
 *  - a free reroll is visibly on offer, so the next click costs nothing;
 *  - a chooser was open and had no free reroll in it, so it costs coins;
 *  - no chooser is open, so nothing can be seen. A player with a MooPass gets a
 *    starred cost rather than a flat one — "10.0K*" and a title that says the
 *    first one may be free — because promising FREE on a spent pass is worse
 *    than admitting the script cannot see.
 *
 * @param {Object} params - Label inputs
 * @param {number} params.pendingCount - Cards still needing an action
 * @param {string} params.mode - 'coin', 'cowbell' or 'delete'
 * @param {number} params.cost - Cost of the next action in its own units
 * @param {{known: boolean, available: boolean, remaining: number|null}} [params.free] - What the board shows
 * @param {boolean} [params.mooPass] - Does the character have a MooPass?
 * @returns {string} The label
 */
export function formatBulkRerollLabel({ pendingCount, mode, cost, free, mooPass }) {
    if (!pendingCount) return '✓ Tasks settled';
    if (mode === 'delete') return `🗑 Discard Task (${pendingCount})`;

    const costLabel = mode === 'coin' ? `${formatKMB(cost)}💰` : `${cost}🔔`;

    if (free?.available) {
        const remaining = free.remaining;
        if (remaining === null) {
            // The label carries no count, so all that is known is that this one
            // is free
            return pendingCount > 1
                ? `🎲 Reroll FREE then ${costLabel} (${pendingCount})`
                : `🎲 Reroll FREE (${pendingCount})`;
        }
        if (remaining >= pendingCount) return `🎲 Reroll FREE (${pendingCount})`;
        return `🎲 Reroll (${remaining} free, ${pendingCount - remaining}×${costLabel})`;
    }

    if (!free?.known && mooPass) return `🎲 Reroll ${costLabel}* (${pendingCount})`;
    return `🎲 Reroll ${costLabel} (${pendingCount})`;
}
