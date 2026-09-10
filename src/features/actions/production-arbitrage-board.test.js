/** @vitest-environment happy-dom */

/**
 * The arbitrage board, drawn.
 *
 * The ranking is mocked — `production-arbitrage.test.js` owns the arithmetic —
 * and the panel shell is replaced with a plain container, so what this file
 * proves is the wiring: the open button lands only on production skill pages,
 * the table draws every column without a section failing, the controls sort
 * and filter what is drawn, a capped row carries its marker, and a row click
 * opens the action.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ranking = vi.hoisted(() => ({
    rows: [],
    rankCalls: 0,
    cleared: 0,
}));

const navigation = vi.hoisted(() => ({
    toAction: vi.fn(() => true),
    toItem: vi.fn(() => true),
}));

const panelState = vi.hoisted(() => ({ created: null, built: 0, destroyed: 0 }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, COLOR_ACCENT: '#22c55e' },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../utils/simple-panel.js', () => ({
    createPanel: ({ draw }) => {
        const panel = document.createElement('div');
        panel.id = 'toolasha-production-arbitrage-panel';
        const body = document.createElement('div');
        panel.appendChild(body);
        const api = {
            draw,
            render: () => {
                body.replaceChildren();
                try {
                    draw(body);
                } catch (error) {
                    const failed = document.createElement('div');
                    failed.textContent = `This could not be drawn: ${error.message}`;
                    body.appendChild(failed);
                }
            },
            show: () => {
                if (!panel.isConnected) document.body.appendChild(panel);
                api.render();
            },
            hide: () => panel.remove(),
            destroy: () => {
                panelState.destroyed++;
                panel.remove();
            },
            get panel() {
                return panel;
            },
        };
        panelState.built++;
        panelState.created = api;
        return api;
    },
}));

vi.mock('../../utils/item-navigation.js', () => ({
    navigateToAction: (...args) => navigation.toAction(...args),
    navigateToItem: (...args) => navigation.toItem(...args),
}));

vi.mock('../../utils/liquidity-cap.js', () => ({
    liquidityMarkerHtml: (limit, { compact = false } = {}) =>
        limit ? `<span title="${limit.note} — ${limit.detail}">${compact ? 'vol-capped' : limit.note}</span>` : '',
}));

vi.mock('./production-arbitrage.js', async () => {
    const actual = await vi.importActual('./production-arbitrage.js');
    return {
        PRODUCTION_SKILLS: actual.PRODUCTION_SKILLS,
        arrangeRows: actual.arrangeRows,
        rankProductionArbitrage: async ({ onProgress } = {}) => {
            ranking.rankCalls += 1;
            onProgress?.(ranking.rows.length, ranking.rows.length, ranking.rows);
            return ranking.rows;
        },
        clearProductionArbitrageCache: () => {
            ranking.cleared += 1;
        },
    };
});

const { default: board, OPEN_BUTTON_CLASS } = await import('./production-arbitrage-board.js');

/**
 * A board row, at sane defaults.
 * @param {Object} overrides - Fields to set
 * @returns {Object}
 */
function row(overrides = {}) {
    return {
        itemHrid: '/items/cheese',
        itemName: 'Cheese',
        actionHrid: '/actions/cheesesmithing/cheese',
        actionName: 'Cheese',
        skillHrid: '/skills/cheesesmithing',
        skillLabel: 'Cheesesmithing',
        requiredLevel: 1,
        level: 50,
        levelMet: true,
        materialCostPerUnit: 50,
        saleAfterTax: 95,
        marginPerUnit: 40,
        marginPerAction: 40,
        marginPerHour: 4000,
        actionsPerHour: 100,
        unitsPerHour: 100,
        makeablePerDay: 2400,
        unitsPerDay: 2400,
        marginPerDay: 96_000,
        uncappedMarginPerDay: 96_000,
        liquidityLimit: null,
        volumeChecked: true,
        quality: null,
        qualityNote: '',
        profitData: {},
        ...overrides,
    };
}

/** The body's text, whitespace collapsed */
function text() {
    return panelState.created.panel.textContent.replace(/\s+/g, ' ');
}

/** Item names in drawn order */
function drawnItems() {
    return [...panelState.created.panel.querySelectorAll('[data-arb-row]')].map(
        (tr) => tr.querySelector('td:nth-child(2)').firstChild.textContent
    );
}

/** A skill page title, as the game draws it */
function skillTitle(label) {
    const title = document.createElement('h1');
    title.className = 'GatheringProductionSkillPanel_title__3VihQ';
    const name = document.createElement('div');
    name.textContent = label;
    title.appendChild(name);
    document.body.appendChild(title);
    return title;
}

/** Settle the async open/render chain */
async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
    ranking.rows = [
        row(),
        row({
            itemHrid: '/items/verdant_cheese',
            itemName: 'Verdant Cheese',
            actionHrid: '/actions/cheesesmithing/verdant_cheese',
            actionName: 'Verdant Cheese',
            requiredLevel: 65,
            levelMet: false,
            marginPerUnit: 200,
            marginPerAction: 200,
            marginPerHour: 20_000,
            makeablePerDay: 2400,
            unitsPerDay: 240,
            marginPerDay: 48_000,
            uncappedMarginPerDay: 480_000,
            liquidityLimit: {
                kind: 'volume',
                note: 'limited by market volume (~1/week)',
                detail: 'Verdant Cheese trades ~1/week, and you are not the only seller.',
                throttle: 0.1,
            },
        }),
        row({
            itemHrid: '/items/egg',
            itemName: 'Egg',
            actionHrid: '/actions/cooking/egg',
            actionName: 'Fried Egg',
            skillHrid: '/skills/cooking',
            skillLabel: 'Cooking',
            requiredLevel: 5,
            level: 10,
            marginPerUnit: -5,
            marginPerAction: -5,
            marginPerHour: -500,
            marginPerDay: -12_000,
            uncappedMarginPerDay: -12_000,
            quality: 'no-price',
            qualityNote: 'No market price for the output — the sale value is unknown',
        }),
    ];
    ranking.rankCalls = 0;
    ranking.cleared = 0;
    navigation.toAction.mockClear();
    navigation.toItem.mockClear();
    board.initialize();
});

afterEach(() => {
    board.disable();
    document.body.replaceChildren();
    board.sort = 'day';
    board.skillHrid = null;
    board.query = '';
    board.craftableOnly = false;
});

describe('open button', () => {
    test('lands on a production skill page and not on a gathering one', () => {
        const cheese = skillTitle('Cheesesmithing');
        const wood = skillTitle('Woodcutting');
        board.injectOpenButton(cheese);
        board.injectOpenButton(wood);
        board.injectOpenButton(cheese);
        expect(cheese.querySelectorAll(`.${OPEN_BUTTON_CLASS}`)).toHaveLength(1);
        expect(wood.querySelector(`.${OPEN_BUTTON_CLASS}`)).toBeNull();
    });

    test('opens the board', async () => {
        const cheese = skillTitle('Brewing');
        board.injectOpenButton(cheese);
        cheese.querySelector(`.${OPEN_BUTTON_CLASS}`).click();
        await settle();
        expect(document.getElementById('toolasha-production-arbitrage-panel')).not.toBeNull();
        expect(ranking.rankCalls).toBe(1);
    });
});

describe('table', () => {
    beforeEach(async () => {
        board.open();
        await settle();
    });

    test('draws every row with every column and nothing failing', () => {
        expect(text()).not.toContain('could not be drawn');
        expect(drawnItems()).toEqual(['Cheese', 'Verdant Cheese', 'Egg']);

        const header = [...panelState.created.panel.querySelectorAll('th')].map((th) => th.textContent);
        expect(header).toEqual([
            '#',
            'Item',
            'Skill',
            'Lvl',
            'Mat cost/unit',
            'Sale (after tax)',
            'Margin/unit',
            'Margin/action',
            'Margin/hr',
            'Make/day',
            'Margin/day',
            'Data',
        ]);

        const cheese = panelState.created.panel.querySelector('[data-arb-row="/actions/cheesesmithing/cheese"]');
        const cells = [...cheese.querySelectorAll('td')].map((td) => td.textContent);
        expect(cells.slice(0, 11)).toEqual([
            '1',
            'Cheese',
            'Cheesesmithing',
            '1',
            '50',
            '95',
            '40',
            '40',
            '4.0K',
            '2.4K',
            '96.0K',
        ]);
    });

    test('marks a level you do not meet, a capped day and a data flag', () => {
        const verdant = panelState.created.panel.querySelector(
            '[data-arb-row="/actions/cheesesmithing/verdant_cheese"]'
        );
        expect(verdant.querySelector('td:nth-child(4)').textContent).toBe('65 ✗');
        expect(verdant.querySelector('td:nth-child(10)').textContent).toBe('240');
        expect(verdant.querySelector('td:nth-child(11)').textContent).toContain('vol-capped');

        const egg = panelState.created.panel.querySelector('[data-arb-row="/actions/cooking/egg"]');
        expect(egg.querySelector('[data-arb-quality]').getAttribute('data-arb-quality')).toBe('no-price');
        expect(egg.querySelector('[data-arb-quality]').textContent).toBe('no price');
        // The action is named when it differs from the item
        expect(egg.querySelector('td:nth-child(2)').textContent).toBe('Egg (Fried Egg)');
    });

    test('sorts by hour and by unit', () => {
        panelState.created.panel.querySelector('[data-arb-sort="hour"]').click();
        expect(drawnItems()).toEqual(['Verdant Cheese', 'Cheese', 'Egg']);
        panelState.created.panel.querySelector('[data-arb-sort="unit"]').click();
        expect(drawnItems()).toEqual(['Verdant Cheese', 'Cheese', 'Egg']);
        panelState.created.panel.querySelector('[data-arb-sort="day"]').click();
        expect(drawnItems()).toEqual(['Cheese', 'Verdant Cheese', 'Egg']);
    });

    test('filters by skill, by text and by craftability', () => {
        const select = panelState.created.panel.querySelector('[data-arb-skill]');
        select.value = '/skills/cooking';
        select.dispatchEvent(new Event('change'));
        expect(drawnItems()).toEqual(['Egg']);

        panelState.created.panel.querySelector('[data-arb-skill]').value = '';
        panelState.created.panel.querySelector('[data-arb-skill]').dispatchEvent(new Event('change'));
        const search = panelState.created.panel.querySelector('[data-arb-search]');
        search.value = 'fried';
        search.dispatchEvent(new Event('input'));
        expect(drawnItems()).toEqual(['Egg']);
        // The box that is being typed in is not rebuilt
        expect(panelState.created.panel.querySelector('[data-arb-search]')).toBe(search);

        search.value = '';
        search.dispatchEvent(new Event('input'));
        panelState.created.panel.querySelector('[data-arb-craftable]').click();
        expect(drawnItems()).toEqual(['Cheese', 'Egg']);
    });

    test('a row click opens the action, falling back to the item', () => {
        panelState.created.panel.querySelector('[data-arb-row="/actions/cooking/egg"]').click();
        expect(navigation.toAction).toHaveBeenCalledWith('/actions/cooking/egg');
        expect(navigation.toItem).not.toHaveBeenCalled();

        navigation.toAction.mockReturnValueOnce(false);
        panelState.created.panel.querySelector('[data-arb-row="/actions/cooking/egg"]').click();
        expect(navigation.toItem).toHaveBeenCalledWith('/items/egg');
    });

    test('recompute forgets the ranking and asks again', async () => {
        panelState.created.panel.querySelector('[data-arb-recompute]').click();
        await settle();
        expect(ranking.cleared).toBe(1);
        expect(ranking.rankCalls).toBe(2);
        expect(drawnItems()).toHaveLength(3);
    });

    test('says so when nothing matches', () => {
        const search = panelState.created.panel.querySelector('[data-arb-search]');
        search.value = 'zzz';
        search.dispatchEvent(new Event('input'));
        expect(text()).toContain('No recipes match');
    });
});

/**
 * The shell the board builds, and gives back.
 *
 * The board builds its panel inside `initialize()` and drops the handle in
 * `disable()`, so a character switch builds a second shell. `createPanel`
 * subscribes to `character_switched` for the life of a shell, so a shell that
 * is dropped rather than released leaves that subscription behind — one per
 * switch, permanently. The teardown has to release what the init built.
 */
describe('the shell the board is built from', () => {
    test('teardown releases the shell it built', () => {
        const built = panelState.built;

        board.disable();

        expect(panelState.destroyed).toBe(built);
    });

    test('every shell a re-init builds is released again', () => {
        for (let cycle = 0; cycle < 3; cycle++) {
            board.initialize();
            board.disable();
        }

        expect(panelState.destroyed).toBe(panelState.built);
    });
});
