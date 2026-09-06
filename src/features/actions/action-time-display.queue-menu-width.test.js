/**
 * Width contract for the native QueuedActions edit menu.
 *
 * The game's `QueuedActions_queuedActionsEditMenu` popper declares no width, so it sizes to its
 * intrinsic content — and the widest content in it is Toolasha's own injected
 * `.mwi-queue-action-time` / `.mwi-queue-action-profit` rows, whose text ranges from `[∞]` to
 * `[1d 4h 30m · mat: 1,234] Complete at 9/6/2026, 4:15:22 PM`. Measured in a real engine the popup
 * went from 164px to 338px purely from that suffix, so the popup jumped width as the queue
 * progressed. The fix marks the menu and pins its width in CSS; these tests assert the contract
 * (the stylesheet's rules, the marker, idempotence, teardown) since happy-dom performs no layout.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null, unregistered: 0 }));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {
                observerState.unregistered += 1;
            };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: () => null,
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
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const STYLE_ID = 'toolasha-queue-edit-menu-width-styles';
const MARKER_CLASS = 'toolasha-queue-edit-menu-enhanced';

/** The native edit-menu popper with a single queued-action row. */
function editMenu() {
    const el = document.createElement('div');
    el.className = 'QueuedActions_queuedActionsEditMenu__a';
    el.innerHTML = `
        <div class="QueuedActions_action__b">
            <div class="QueuedActions_actionText__c">
                <div class="QueuedActions_text__d">#1Chop Redwood Tree</div>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

const styleText = () => document.getElementById(STYLE_ID)?.textContent ?? '';

describe('QueuedActions edit-menu width contract', () => {
    beforeEach(() => {
        observerState.handler = null;
        observerState.unregistered = 0;
        document.body.innerHTML = '';
        document.head.querySelectorAll('style').forEach((el) => el.remove());
    });

    afterEach(() => {
        actionTimeDisplay.cleanupRegistry.cleanupAll();
    });

    test('one pinned preferred width replaces the intrinsic sizing that caused the 164px/338px flip', () => {
        actionTimeDisplay.initializeQueueObserver();

        expect(styleText()).toContain(`.${MARKER_CLASS} {`);
        expect(styleText()).toContain('width: min(414px, calc(100vw - 64px));');
        expect(styleText()).toContain('max-width: min(414px, calc(100vw - 64px));');
    });

    test('the 280px native floor survives, giving way only when the viewport cannot fit it', () => {
        actionTimeDisplay.initializeQueueObserver();

        expect(styleText()).toContain('min-width: min(280px, calc(100vw - 64px));');
    });

    test('constrained viewports shrink continuously via dvw with a vw fallback, not a JS measurement', () => {
        actionTimeDisplay.initializeQueueObserver();

        expect(styleText()).toContain('@supports (width: 100dvw)');
        expect(styleText()).toContain('width: min(414px, calc(100dvw - 64px));');
    });

    test('injected rows wrap inside the popup instead of widening it', () => {
        actionTimeDisplay.initializeQueueObserver();
        const css = styleText();

        expect(css).toContain(`.${MARKER_CLASS} .mwi-queue-action-time`);
        expect(css).toContain(`.${MARKER_CLASS} .mwi-queue-action-profit`);
        expect(css).toContain('white-space: normal;');
        expect(css).toContain('overflow-wrap: anywhere;');
        expect(css).toContain('min-width: 0;');
    });

    test('the contract applies with no injected rows present at all', () => {
        actionTimeDisplay.initializeQueueObserver();
        const menu = editMenu();
        // No queued actions are matchable here, so injectQueueTimes adds nothing.
        observerState.handler(menu);

        expect(menu.classList.contains(MARKER_CLASS)).toBe(true);
        expect(menu.querySelectorAll('.mwi-queue-action-time').length).toBe(0);
    });

    test('the marker is not duplicated when the same menu is delivered again', () => {
        actionTimeDisplay.initializeQueueObserver();
        const menu = editMenu();

        observerState.handler(menu);
        observerState.handler(menu);

        expect(menu.className.split(/\s+/).filter((c) => c === MARKER_CLASS)).toHaveLength(1);
    });

    test('the contract is scoped to the enhanced menu, never to unrelated poppers', () => {
        actionTimeDisplay.initializeQueueObserver();
        const other = document.createElement('div');
        other.className = 'MuiTooltip-popper';
        document.body.appendChild(other);

        expect(other.classList.contains(MARKER_CLASS)).toBe(false);
        expect(styleText()).not.toContain('MuiTooltip');
    });

    test('re-initializing never appends a duplicate stylesheet', () => {
        actionTimeDisplay.initializeQueueObserver();
        actionTimeDisplay.initializeQueueObserver();

        expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    });

    test('teardown removes the stylesheet and unregisters the observer', () => {
        actionTimeDisplay.initializeQueueObserver();
        expect(document.getElementById(STYLE_ID)).not.toBeNull();

        actionTimeDisplay.cleanupRegistry.cleanupAll();

        expect(document.getElementById(STYLE_ID)).toBeNull();
        expect(observerState.unregistered).toBe(1);
    });
});
