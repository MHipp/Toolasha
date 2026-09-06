/**
 * Character-swap race on the action bar's profit line.
 *
 * `updateActionBarProfit()` awaits market/profit work, then writes into
 * `this.profitElement` — guarded by `activeBarProfitId`, which only a *newer*
 * bar calculation or an explicit `clearBarProfit()` invalidates. A character
 * switch did neither: it cleared `activeProfitCalculationId` (the action-card
 * guard) but left `activeBarProfitId` matching, so a calculation started for
 * the old character resolved after the switch and painted its figure into the
 * new character's freshly created profit row.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const gathering = vi.hoisted(() => ({ resolve: null, pending: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getCurrentActions: () => [],
        getActionDetails: () => ({ type: '/action_types/milking', outputItems: [] }),
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({
    calculateGatheringProfit: () =>
        new Promise((resolve) => {
            gathering.resolve = resolve;
        }),
}));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCoinifyProfit: () => null,
        calculateTransmuteProfit: () => null,
        calculateDecomposeProfit: () => null,
    },
}));
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitData: async (profitData) => profitData,
    liquidityMarkerHtml: () => '',
}));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

describe('action bar profit across a character switch', () => {
    beforeEach(() => {
        gathering.resolve = null;
        document.body.innerHTML = '<div class="Header_actionName_abc123">Milk: Cow (100)</div>';
        actionTimeDisplay.displayElement = null;
        actionTimeDisplay.profitElement = null;
        actionTimeDisplay.activeBarProfitId = null;
        actionTimeDisplay.actionNameObserver = null;
    });

    test('a calculation started before the switch never paints the new character bar', async () => {
        actionTimeDisplay.createDisplayPanel();

        const inFlight = actionTimeDisplay.updateActionBarProfit({ actionHrid: '/actions/milking/cow' }, 500);
        // Let the await on calculateGatheringProfit park before the switch lands.
        await Promise.resolve();

        actionTimeDisplay.handleCharacterSwitch();
        const newProfitElement = actionTimeDisplay.profitElement;
        expect(newProfitElement).toBeTruthy();

        gathering.resolve({ profitPerHour: 1234567, actionsPerHour: 100, efficiencyMultiplier: 1 });
        await inFlight;

        expect(newProfitElement.innerHTML).toBe('');
        expect(document.querySelectorAll('[data-mwi-action-bar-widget="profit"]')).toHaveLength(1);
    });
});
