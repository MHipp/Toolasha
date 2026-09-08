/**
 * The "+N Queued Actions" hover tooltip's content-injection guard.
 *
 * tooltip-observer.js redelivers a popper as freshly "opened" once it has been
 * seen to genuinely leave and return to the document (see
 * tooltip-observer.test.js's "notifies subscribers with 'closed'" cases, and
 * its own module comment). That is exactly the mechanism that forced two other
 * tooltip features to key their "already injected" guard on the tooltip's
 * *content* rather than on the mere presence of a previous injection:
 *
 *   - tooltip-prices.js, commit 6dc52988 ("clear stale tooltip injections when
 *     item changes") — guard keyed on item name.
 *   - dungeon-token-tooltips.js, commit d3101317 ("dungeon token tooltip guard
 *     is keyed on the element, not the item") — same fix, ported.
 *
 * `injectQueueTimesTooltip` in action-time-display.js used the same
 * presence-only shape: `if (tooltipContent.querySelector('.mwi-queue-action-time'))
 * return;` with no key describing which queue state was last rendered. If the
 * game reuses the same popper element for a later hover of the same "+N Queued
 * Actions" badge — after the queue has since progressed (an action completed,
 * reducing remaining counts) — the guard sees the leftover marker from the
 * previous hover and skips re-injection entirely, leaving the stale time/total
 * on screen under the new queue state.
 *
 * This file drives the real, un-mocked tooltip-observer.js (only dom-observer.js
 * is mocked, the same way dungeon-token-tooltips.test.js does it) so the
 * redelivery semantics are exercised for real rather than assumed.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null }));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {};
        },
    },
}));

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        // The queue's material ledger asks what an enhancing row costs before spending it
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue',
        getSettingValue: (_key, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

// perActionTime is fixed, so the only thing that moves the total between the
// two hovers in this test is the actionObj's currentCount, exactly like a real
// enhancing action progressing between two separate opens of the tooltip.
const PER_ACTION_TIME = 2;
vi.mock('../enhancement/enhancement-xp.js', () => ({
    calculateEnhancementPredictions: () => ({
        expectedAttempts: 1000,
        expectedProtections: 0,
        perActionTime: PER_ACTION_TIME,
        successMultiplier: 1,
    }),
}));

const { default: actionTimeDisplay } = await import('./action-time-display.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

const ITEM_HRID = '/items/cheese_sword';
const ACTION_HRID = '/actions/enhancing/cheese_sword';

/** Build the "+N Queued Actions" MuiTooltip popper with one enhancing action row. */
function queueTooltipPopper() {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `
        <div class="QueuedActions_queuedActionsTooltip__x">
            <div class="QueuedActions_actions__container">
                <div class="QueuedActions_action__item">
                    <div class="QueuedActions_actionText__y">
                        <div class="QueuedActions_text__z">#1<svg><use href="#enhancing_icon"></use></svg>Cheese Sword +1</div>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

/** @param {number} currentCount - Attempts already consumed toward maxCount */
function enhancingAction(currentCount) {
    return {
        id: 'action-1',
        ordinal: 0,
        actionHrid: ACTION_HRID,
        primaryItemHash: `char1::/item_locations/inventory::${ITEM_HRID}::1`,
        hasMaxCount: true,
        maxCount: 10,
        currentCount,
        enhancingMaxLevel: 20,
        enhancingProtectionMinLevel: 0,
    };
}

beforeEach(async () => {
    document.body.innerHTML = '';
    game.actionDetails = { [ACTION_HRID]: { type: '/action_types/enhancing', hrid: ACTION_HRID } };
    game.currentActions = [enhancingAction(0)];
    actionTimeDisplay.initializeQueueTooltipObserver();
});

afterEach(() => {
    tooltipObserver.disable();
});

function totalText(el) {
    return el.querySelector('.mwi-queue-tooltip-total')?.textContent ?? null;
}

describe('queue tooltip content-keyed guard', () => {
    test('a fresh popper gets the time injected once', () => {
        const el = queueTooltipPopper();
        observerState.handler(el);

        expect(el.querySelector('.mwi-queue-action-time')).not.toBeNull();
        // 10 - 0 = 10 attempts remaining at 2s each = 20s
        expect(totalText(el)).toBe('Total: 20s');
    });

    test('a reused popper is reprocessed when the queue has progressed since the last open', async () => {
        const el = queueTooltipPopper();
        observerState.handler(el);
        expect(totalText(el)).toBe('Total: 20s');

        // The tooltip closes (removed from the document) and tooltip-observer's
        // removal watcher settles it — flushing its MutationObserver microtask,
        // per tooltip-observer.test.js — before the game reuses the same popper
        // element for the next hover.
        el.remove();
        await Promise.resolve();
        await Promise.resolve();

        // Between hovers, 6 of the 10 queued enhancement attempts completed —
        // exactly the kind of change that happens to a live queue between two
        // separate hovers of the same "+N Queued Actions" badge.
        game.currentActions = [enhancingAction(6)];
        document.body.appendChild(el);
        observerState.handler(el);

        // 10 - 6 = 4 attempts remaining at 2s each = 8s. A guard keyed only on
        // "something was injected before" leaves the stale 20s total standing
        // because `.mwi-queue-action-time` from the first open is still in the
        // (reused) DOM subtree — it never even attempts to recompute.
        expect(totalText(el)).toBe('Total: 8s');
    });
});
