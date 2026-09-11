/**
 * @vitest-environment happy-dom
 *
 * The Build Score panel, built rather than reasoned about.
 *
 * The panel arranges rows it does not compute, which is exactly the arrangement
 * that fails quietly: a renamed field on a breakdown row produces a section with
 * a heading, a score of 0.0 and nothing under it, and nothing throws. So the
 * load-bearing assertions here are that the fixture score reaches the page —
 * every section, every constituent line — and that nothing failed to draw.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const stub = vi.hoisted(() => ({ openState: [] }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    clampGeometry: () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async (id, open) => {
        stub.openState.push([id, open]);
    },
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));

const { buildScorePanel, setScoreSource, resetBuildScorePanel, topContributors } =
    await import('./build-score-panel.js');

/**
 * A scored own-character build, in the shape `calculateCombatScore` returns.
 * @param {Object} overrides - Fields to change
 * @returns {Object} scoreData
 */
function scored(overrides = {}) {
    return {
        total: 300,
        house: 50,
        ability: 100,
        equipment: 150,
        guildShrine: 15,
        guildShrineTokens: 400,
        guildShrineKnown: true,
        guildShrineCombat: 12,
        guildShrineCombatTokens: 340,
        equipmentHidden: false,
        hasEquipmentData: true,
        breakdown: {
            houses: [
                { name: 'Dojo 8', value: '35.0', cost: 35_000_000, level: 8 },
                { name: 'Gym 6', value: '15.0', cost: 15_000_000, level: 6 },
            ],
            abilities: [
                {
                    name: 'Fireball 60',
                    value: '70.0',
                    cost: 70_000_000,
                    hrid: '/abilities/fireball',
                    itemHrid: '/items/fireball',
                    level: 60,
                },
                {
                    name: 'Ice Spear 40',
                    value: '30.0',
                    cost: 30_000_000,
                    hrid: '/abilities/ice_spear',
                    itemHrid: '/items/ice_spear',
                    level: 40,
                },
            ],
            equipment: [
                {
                    name: 'Chimerical Guarder +5',
                    value: '110.0',
                    cost: 110_000_000,
                    itemHrid: '/items/chimerical_guarder',
                    slot: '/item_locations/off_hand',
                    enhancementLevel: 5,
                },
                {
                    name: 'Vision Helmet +3',
                    value: '40.0',
                    cost: 40_000_000,
                    itemHrid: '/items/vision_helmet',
                    slot: '/item_locations/head',
                    enhancementLevel: 3,
                },
            ],
            guildShrines: [
                { name: 'Force 4', value: '12.0', cost: 12_000_000, hrid: '/guild_buffs/force', level: 4, tokens: 340 },
            ],
            guildShrinesCombat: [
                { name: 'Force 4', value: '12.0', cost: 12_000_000, hrid: '/guild_buffs/force', level: 4, tokens: 340 },
            ],
        },
        skillerTotal: 90,
        skillerEquipment: 90,
        skillerGuildShrine: 3,
        skillerGuildShrineTokens: 60,
        skillerBreakdown: {
            equipment: [
                {
                    name: 'Enchanted Gloves +7',
                    value: '50.0',
                    cost: 50_000_000,
                    itemHrid: '/items/enchanted_gloves',
                    slot: '/item_locations/hands',
                    enhancementLevel: 7,
                },
                // The same ring the combat score counts: gear with no skill
                // requirement is scored on both sides
                {
                    name: 'Vision Helmet +3',
                    value: '40.0',
                    cost: 40_000_000,
                    itemHrid: '/items/vision_helmet',
                    slot: '/item_locations/head',
                    enhancementLevel: 3,
                },
            ],
            guildShrines: [
                {
                    name: 'Scholar 2',
                    value: '3.0',
                    cost: 3_000_000,
                    hrid: '/guild_buffs/scholar',
                    level: 2,
                    tokens: 60,
                },
            ],
        },
        ...overrides,
    };
}

const text = () => buildScorePanel.panel.textContent;
const FAILED = 'could not be drawn';

/**
 * The clickable heading of a section.
 * @param {string} id - Section key
 * @returns {HTMLElement}
 */
const header = (id) => buildScorePanel.panel.querySelector(`[data-section="${id}"]`);

/**
 * The unfolded contents of a section, or null while it is folded away.
 * @param {string} id - Section key
 * @returns {HTMLElement|null}
 */
const body = (id) => buildScorePanel.panel.querySelector(`[data-section-body="${id}"]`);

beforeEach(() => {
    stub.openState = [];
    setScoreSource(() => scored());
});

afterEach(() => {
    buildScorePanel.hide();
    resetBuildScorePanel();
    setScoreSource(null);
});

describe('drawing the tree', () => {
    test('every section of both scores is drawn, and nothing failed to draw', () => {
        buildScorePanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Combat Score');
        expect(text()).toContain('300.0');
        expect(text()).toContain('Skiller Score');
        expect(text()).toContain('90.0');
        expect(text()).toContain('Equipment');
        expect(text()).toContain('Abilities');
        expect(text()).toContain('House');
        expect(text()).toContain('Guild shrines');
    });

    test('the header says what the number is, so it stops being magic', () => {
        buildScorePanel.show();

        expect(text()).toContain('Score = what this kit would cost to buy, in millions of coins.');
    });

    test('contributions are ordered largest first, not in calculator order', () => {
        buildScorePanel.show();

        const order = [...buildScorePanel.panel.querySelectorAll('[data-section]')].map((el) => el.dataset.section);

        expect(order.slice(0, 4)).toEqual(['combat-equipment', 'combat-abilities', 'combat-house', 'combat-shrines']);
    });

    test('before a score has been computed it says so, rather than drawing an empty tree', () => {
        setScoreSource(() => null);
        buildScorePanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('Scoring your build');
        expect(text()).not.toContain('Combat Score');
    });

    test('a score arriving in an older shape, with no breakdown at all, still draws', () => {
        setScoreSource(() => ({ total: 42, skillerTotal: 7 }));
        buildScorePanel.show();

        expect(text()).not.toContain(FAILED);
        expect(text()).toContain('42.0');
    });
});

describe('expandable sections', () => {
    test('a section starts folded and its constituents are not on the page', () => {
        buildScorePanel.show();

        expect(body('combat-equipment')).toBeNull();
        expect(header('combat-equipment').textContent).toContain('▶');
    });

    test('clicking a section reveals the lines it is made of', () => {
        buildScorePanel.show();
        header('combat-equipment').click();

        expect(body('combat-equipment').textContent).toContain('Chimerical Guarder +5');
        expect(body('combat-equipment').textContent).toContain('Vision Helmet +3');
        expect(header('combat-equipment').textContent).toContain('▼');
    });

    test('an equipment line names the slot it sits in', () => {
        buildScorePanel.show();
        header('combat-equipment').click();

        expect(body('combat-equipment').textContent).toContain('Off Hand');
        expect(body('combat-equipment').textContent).toContain('Head');
    });

    test('an equipment line carries its icon and its exact coin value', () => {
        buildScorePanel.show();
        header('combat-equipment').click();

        const line = [...buildScorePanel.panel.querySelectorAll('div')].find((el) =>
            el.title.startsWith('Chimerical Guarder +5:')
        );

        expect(line.title).toContain('110,000,000 coins');
    });

    test('an ability nobody is selling the book for says so, rather than showing a 0', () => {
        setScoreSource(() =>
            scored({
                breakdown: {
                    ...scored().breakdown,
                    abilities: [
                        {
                            name: 'Ice Spear 40',
                            value: 'no price',
                            cost: 0,
                            unpriced: true,
                            books: 41,
                            hrid: '/abilities/ice_spear',
                            itemHrid: '/items/ice_spear',
                            level: 40,
                        },
                    ],
                },
            })
        );
        buildScorePanel.show();
        header('combat-abilities').click();

        const line = [...buildScorePanel.panel.querySelectorAll('div')].find((el) =>
            el.title.startsWith('Ice Spear 40:')
        );

        expect(body('combat-abilities').textContent).toContain('no price');
        expect(line.title).toContain('41 books');
        expect(line.title).toContain('not counted in the score');
        expect(line.title).not.toContain('0 coins');
    });

    test('folding is per section — opening abilities leaves equipment folded', () => {
        buildScorePanel.show();
        header('combat-abilities').click();

        expect(body('combat-abilities').textContent).toContain('Fireball 60');
        expect(body('combat-equipment')).toBeNull();
    });

    test('clicking a section again folds it away', () => {
        buildScorePanel.show();
        header('combat-house').click();
        expect(body('combat-house').textContent).toContain('Dojo 8');

        header('combat-house').click();
        expect(body('combat-house')).toBeNull();
    });

    test('the shrine section names its tokens, which have no price', () => {
        buildScorePanel.show();
        header('combat-shrines').click();

        expect(body('combat-shrines').textContent).toContain('Force 4');
        expect(body('combat-shrines').textContent).toContain('340 guild tokens');
    });
});

describe('guild shrines, which only your own character has', () => {
    test('a score that never read the levels draws no shrine section, rather than a zero', () => {
        setScoreSource(() =>
            scored({
                guildShrineKnown: false,
                guildShrineCombat: 0,
                skillerGuildShrine: 0,
            })
        );
        buildScorePanel.show();

        expect(text()).not.toContain('Guild shrines');
        expect(header('combat-shrines')).toBeNull();
    });

    test('a character who has bought nothing gets no section either', () => {
        setScoreSource(() => scored({ guildShrineCombat: 0, skillerGuildShrine: 0 }));
        buildScorePanel.show();

        expect(header('combat-shrines')).toBeNull();
        expect(header('skiller-shrines')).toBeNull();
    });
});

describe('biggest contributors', () => {
    test('the largest five lines across both scores, largest first', () => {
        const top = topContributors(scored());

        expect(top).toHaveLength(5);
        expect(top.map((entry) => entry.name)).toEqual([
            'Chimerical Guarder +5',
            'Fireball 60',
            'Enchanted Gloves +7',
            'Vision Helmet +3',
            'Dojo 8',
        ]);
    });

    test('gear counted in both scores is listed once, not twice', () => {
        const names = topContributors(scored()).map((entry) => entry.name);

        expect(names.filter((name) => name === 'Vision Helmet +3')).toHaveLength(1);
    });

    test('each line says which contribution it came out of', () => {
        const byName = Object.fromEntries(topContributors(scored()).map((entry) => [entry.name, entry.from]));

        expect(byName['Chimerical Guarder +5']).toBe('Equipment');
        expect(byName['Fireball 60']).toBe('Ability');
        expect(byName['Dojo 8']).toBe('House');
    });

    test('shrines a score never read are not contributors, even if the rows are there', () => {
        const names = topContributors(scored({ guildShrineKnown: false })).map((entry) => entry.name);

        expect(names).not.toContain('Force 4');
    });

    test('the summary is drawn without unfolding anything', () => {
        buildScorePanel.show();

        expect(text()).toContain('Biggest 5 contributors');
        // The name appears in the summary, but the equipment section is folded
        expect(header('combat-equipment').textContent).toContain('▶');
    });

    test('a row with no raw cost still orders, from its rounded score', () => {
        const top = topContributors({
            breakdown: {
                equipment: [
                    { name: 'Small', value: '1.0' },
                    { name: 'Large', value: '9.0' },
                ],
            },
        });

        expect(top.map((entry) => entry.name)).toEqual(['Large', 'Small']);
    });
});

describe('hidden equipment', () => {
    test('a profile with nothing priced says why, rather than looking like a cheap build', () => {
        setScoreSource(() => scored({ equipmentHidden: true, hasEquipmentData: false }));
        buildScorePanel.show();

        expect(text()).toContain('Equipment is hidden');
    });
});

describe('open state', () => {
    test('opening and closing is remembered, under the panel key', async () => {
        buildScorePanel.show();
        buildScorePanel.hide();

        expect(stub.openState).toEqual([
            ['buildScore', true],
            ['buildScore', false],
        ]);
    });

    test('reopening on a restore does not overwrite the remembered flag', () => {
        buildScorePanel.show({ remember: false });

        expect(stub.openState).toEqual([]);
    });

    test('toggle opens and closes', () => {
        buildScorePanel.toggle();
        expect(buildScorePanel.panel).not.toBeNull();

        buildScorePanel.toggle();
        expect(buildScorePanel.panel).toBeNull();
    });
});

describe('setScoreSource', () => {
    test('anything that is not a function reads as no score', () => {
        setScoreSource('nonsense');
        buildScorePanel.show();

        expect(text()).toContain('Scoring your build');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the copy button', () => {
    const button = () => [...buildScorePanel.panel.querySelectorAll('button')].find((el) => el.textContent === '⧉');

    test('copies both totals and every section, largest first — the score people screenshot to compare builds', () => {
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        buildScorePanel.show();
        button().click();

        expect(written[0]).toContain('Combat Score: 300.0');
        expect(written[0]).toContain('Equipment: 150.0');
        expect(written[0]).toContain('Skiller Score: 90.0');
    });

    test('names whose build it is when it is not yours', () => {
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });
        setScoreSource(() => scored(), 'Briggsy99');

        buildScorePanel.show();
        button().click();

        expect(written[0]).toContain('Build Score — Briggsy99');
    });

    test('is absent before a score has been computed', () => {
        setScoreSource(() => null);
        buildScorePanel.show();

        expect(button()).toBeUndefined();
    });
});
