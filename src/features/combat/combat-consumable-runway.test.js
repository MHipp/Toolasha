/**
 * The runway caption under each icon of the in-battle Consumables grid.
 *
 * The figure is the consumables panel's own — collector rates, drink re-rating, `secondsLeft` —
 * so what these tests pin is the part that is genuinely new: that the caption lands under the
 * right icon (joined by item, never by slot position), that it refreshes on the collector's own
 * `new_battle` cadence and on nothing faster, and that disabling takes every caption away.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    enabled: true,
    hours: 3,
    latest: null,
    battleHandlers: [],
    observerHandlers: [],
    readyHandlers: [],
    loadCalls: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'combatConsumableRunway' ? mocks.enabled : false),
        getSettingValue: (key, fallback) => (key === 'notifications_combatConsumableLowHours' ? mocks.hours : fallback),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            mocks.observerHandlers.push(callback);
            return () => {
                mocks.observerHandlers = mocks.observerHandlers.filter((h) => h !== callback);
            };
        },
        onReady: (_name, callback) => {
            mocks.readyHandlers.push(callback);
            return () => {
                mocks.readyHandlers = mocks.readyHandlers.filter((h) => h !== callback);
            };
        },
    },
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            if (event === 'new_battle') mocks.battleHandlers.push(handler);
        },
        off: (event, handler) => {
            if (event === 'new_battle') mocks.battleHandlers = mocks.battleHandlers.filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        // Only the coffee carries a buff duration, so only it is re-rated as a drink
        getItemDetails: (hrid) =>
            hrid === COFFEE ? { consumableDetail: { buffs: [{ duration: 300e9 }] } } : { consumableDetail: {} },
    },
}));

vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: {
        getLatestData: () => mocks.latest,
        loadLatestData: async () => {
            mocks.loadCalls += 1;
            return mocks.latest;
        },
    },
}));

vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    calculatePlayerStats: (player) => ({ consumableBreakdown: player.breakdown }),
}));

const GUMMY = '/items/star_fruit_gummy';
const COFFEE = '/items/super_gathering_coffee';
const DONUT = '/items/marsberry_donut';

const runwayModule = await import('./combat-consumable-runway.js');
const { runwayByItem, captionFor, cellItemHrid, CAPTION_MARK } = runwayModule;
const feature = runwayModule.default;

/** One consumable cell, identified the way the grid identifies it: by its sprite icon. */
function cell(itemHrid) {
    const el = document.createElement('div');
    el.className = 'CombatConsumable_combatConsumable__a1b';
    el.innerHTML = `<svg><use href="#${itemHrid.split('/').pop()}"></use></svg>`;
    return el;
}

/** The live Consumables grid holding the given items, in slot order. */
function grid(...itemHrids) {
    const el = document.createElement('div');
    el.className = 'BattlePanel_combatConsumables__x9';
    itemHrids.forEach((hrid) => el.appendChild(cell(hrid)));
    document.body.appendChild(el);
    return el;
}

/** A collector snapshot for the current player with the given per-item rates and stocks. */
function snapshot(entries) {
    return {
        durationSeconds: 600,
        players: [
            {
                isCurrentPlayer: true,
                combatStats: { drinkConcentration: 0 },
                breakdown: entries.map(({ itemHrid, inventoryAmount, consumptionRate }) => ({
                    itemHrid,
                    itemName: itemHrid,
                    inventoryAmount,
                    consumptionRate,
                })),
            },
        ],
    };
}

const captions = () =>
    [...document.querySelectorAll(`[${CAPTION_MARK}]`)].map((el) => ({
        item: el.getAttribute(CAPTION_MARK),
        text: el.textContent,
        color: el.style.color,
        // The caption belongs to the icon it sits directly after
        under: el.previousElementSibling && cellItemHrid(el.previousElementSibling),
    }));

beforeEach(() => {
    mocks.enabled = true;
    mocks.hours = 3;
    mocks.latest = null;
    mocks.battleHandlers = [];
    mocks.observerHandlers = [];
    mocks.readyHandlers = [];
    mocks.loadCalls = 0;
    document.body.innerHTML = '';
});

afterEach(() => {
    feature.cleanup();
});

describe('runwayByItem', () => {
    test('reads the forecast the panel reads: stock over the measured rate, per item', () => {
        // 100 gummies at one every 10 seconds is 1000 seconds of fighting left
        const runways = runwayByItem({
            latest: () =>
                snapshot([
                    { itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 },
                    { itemHrid: DONUT, inventoryAmount: 50, consumptionRate: 0.5 },
                ]),
            stats: (player) => ({ consumableBreakdown: player.breakdown }),
            itemDetails: () => null,
        });

        expect(runways.get(GUMMY)).toBe(1000);
        expect(runways.get(DONUT)).toBe(100);
    });

    test('a drink is re-rated off its buff duration, not off the fight', () => {
        // 300s buff at no concentration = 288/day; 288 held is one day, not the tracked rate
        const runways = runwayByItem({
            latest: () => snapshot([{ itemHrid: COFFEE, inventoryAmount: 288, consumptionRate: 99 }]),
            stats: (player) => ({ consumableBreakdown: player.breakdown }),
            itemDetails: () => ({ consumableDetail: { buffs: [{ duration: 300e9 }] } }),
        });

        expect(runways.get(COFFEE)).toBe(86400);
    });

    test('a slot that is filled but never used is infinite rather than zero', () => {
        const runways = runwayByItem({
            latest: () => snapshot([{ itemHrid: GUMMY, inventoryAmount: 20, consumptionRate: 0 }]),
            stats: (player) => ({ consumableBreakdown: player.breakdown }),
            itemDetails: () => null,
        });

        expect(runways.get(GUMMY)).toBe(Infinity);
    });

    test('no tracked data for this character yields nothing to draw', () => {
        expect(runwayByItem({ latest: () => null }).size).toBe(0);
        expect(runwayByItem({ latest: () => ({ players: [{ isCurrentPlayer: false }] }) }).size).toBe(0);
    });
});

describe('captionFor', () => {
    test('warns below the threshold and stays neutral above it', () => {
        const warn = 3 * 3600;
        expect(captionFor(3600, warn).text).toBe('1h');
        expect(captionFor(3600, warn).color).not.toBe(captionFor(12 * 3600, warn).color);
    });

    test('an unused slot reads infinite rather than as a duration', () => {
        expect(captionFor(Infinity, 3600).text).toBe('∞');
    });
});

describe('drawing on the grid', () => {
    test('renders a caption under each icon, joined by item rather than slot position', () => {
        mocks.latest = snapshot([
            { itemHrid: DONUT, inventoryAmount: 50, consumptionRate: 0.5 },
            { itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 },
        ]);
        // Grid order is the reverse of the breakdown order, so a positional join would swap them
        grid(GUMMY, DONUT);

        feature.initialize();
        feature.redraw();

        expect(captions()).toEqual([
            { item: GUMMY, text: '16m', color: expect.any(String), under: GUMMY },
            { item: DONUT, text: '1m', color: expect.any(String), under: DONUT },
        ]);
    });

    test('an item the forecast does not know about gets no caption at all', () => {
        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 }]);
        grid(GUMMY, DONUT);

        feature.initialize();
        feature.redraw();

        expect(captions().map((c) => c.item)).toEqual([GUMMY]);
    });

    test('refreshes on the collector’s own new_battle cadence, and subscribes to nothing faster', () => {
        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 }]);
        grid(GUMMY);

        feature.initialize();
        expect(mocks.battleHandlers).toHaveLength(1);

        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 3, consumptionRate: 0.1 }]);
        mocks.battleHandlers.forEach((handler) => handler());

        expect(captions()[0].text).toBe('30s');
    });

    test('backfills the persisted snapshot so the grid is not blank before the first kill', async () => {
        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 }]);
        grid(GUMMY);

        feature.initialize();
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.loadCalls).toBe(1);
        expect(captions()).toHaveLength(1);
    });

    test('a rebuilt grid is redrawn through the observer, and never doubles a caption', () => {
        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 }]);
        grid(GUMMY);

        feature.initialize();
        mocks.observerHandlers.forEach((handler) => handler());
        mocks.observerHandlers.forEach((handler) => handler());

        expect(captions()).toHaveLength(1);
    });

    test('does nothing at all while the setting is off', () => {
        mocks.enabled = false;
        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 }]);
        grid(GUMMY);

        feature.initialize();

        expect(mocks.battleHandlers).toHaveLength(0);
        expect(captions()).toHaveLength(0);
    });

    test('disabling removes every caption and unsubscribes', () => {
        mocks.latest = snapshot([{ itemHrid: GUMMY, inventoryAmount: 100, consumptionRate: 0.1 }]);
        grid(GUMMY);

        feature.initialize();
        feature.redraw();
        expect(captions()).toHaveLength(1);

        feature.cleanup();

        expect(captions()).toHaveLength(0);
        expect(mocks.battleHandlers).toHaveLength(0);
        expect(mocks.observerHandlers).toHaveLength(0);
        expect(mocks.readyHandlers).toHaveLength(0);
    });
});
