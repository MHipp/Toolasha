/**
 * @vitest-environment happy-dom
 *
 * The Party Luck panel, built rather than reasoned about.
 *
 * The arithmetic is tested in `party-luck.test.js`. What building it catches is
 * that every section draws against a real-shaped run, and that the states it
 * spends most of its life in — nothing measured yet, a player who has looted
 * nothing — say so rather than failing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    players: [],
    actionDetail: null,
    monsters: {},
    context: null,
    luck: null,
    chests: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => game.actionDetail,
        getInitClientData: () => ({ combatMonsterDetailMap: game.monsters }),
        getItemDetails: (hrid) => ({ '/items/a': { name: 'Apple' } })[hrid],
        on: () => {},
        off: () => {},
        getCurrentCharacterId: () => 'char1',
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1100, getSetting: () => true, getSettingValue: () => 'full' },
}));
vi.mock('./combat-drop-luck.js', () => ({
    default: {
        get context() {
            return game.context;
        },
        get lastResult() {
            return game.luck;
        },
        dungeonChestLuck: () => game.chests || null,
    },
    formatOrdinal: (percentile) => `${Math.round(percentile * 100)}th`,
    describeLuck: (percentile) => ({ text: `${Math.round(percentile * 100)}th percentile`, tone: 'unlucky' }),
    describeChestRun: (player) => `${player.name}: chests`,
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => ({ players: game.players }) },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: (hrid) => ({ '/items/a': 100 })[hrid] ?? null }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));

const { partyLuckPanel, buildPartyLuckSummaryText } = await import('./party-luck-panel.js');
const { partyLuck } = await import('./party-luck.js');

beforeEach(() => {
    game.chests = null;
    game.context = { actionHrid: '/actions/zone', difficultyTier: 2, battles: 100 };
    game.luck = { percentile: 0.15, income: 4_000_000, expected: 3_000_000, battles: 100, hasBonuses: true };
    game.monsters = {
        '/monsters/grunt': { dropTable: [{ itemHrid: '/items/a', dropRate: 0.1, minCount: 1, maxCount: 1 }] },
    };
    game.actionDetail = {
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: {
                randomSpawnInfo: {
                    spawns: [{ combatMonsterHrid: '/monsters/grunt', rate: 1, strength: 1 }],
                    maxSpawnCount: 1,
                    maxTotalStrength: 1,
                },
                bossSpawns: [],
            },
        },
    };
    game.players = [
        {
            name: 'Geared',
            isCurrentPlayer: true,
            loot: { a: { itemHrid: '/items/a', count: 10 } },
            combatStats: { combatDropRate: 1, combatRareFind: 0, combatDropQuantity: 0 },
        },
        {
            name: 'Bare',
            isCurrentPlayer: false,
            loot: {},
            combatStats: { combatDropRate: 0, combatRareFind: 0, combatDropQuantity: 0 },
        },
    ];
});

afterEach(() => partyLuckPanel.hide());

const text = () => partyLuckPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        partyLuckPanel.show();

        expect(text()).toContain('Session Statistics');
        expect(text()).toContain('Revenue');
        expect(text()).toContain('Geared');
        expect(text()).toContain('Bare');
        expect(text()).not.toContain(FAILED);
    });

    test('it carries the verdict the Drop Luck panel used to', () => {
        // That panel is gone: a percentile in one panel and the item table that
        // explains it in another meant the answer was always in the half you
        // did not open
        partyLuckPanel.show();

        expect(text()).toContain('Verdict');
        expect(text()).toContain('15th percentile');
        // A percentile alone cannot tell a fortune from a rounding error
        expect(text()).toContain('+1.0M');
        expect(text()).not.toContain(FAILED);
    });

    test('with no reading yet the rest of the panel still draws', () => {
        game.luck = null;
        partyLuckPanel.show();

        expect(text()).not.toContain('Verdict');
        expect(text()).toContain('Session Statistics');
        expect(text()).not.toContain(FAILED);
    });

    test('the session stats are the ones the model was built from', () => {
        // Every figure below depends on these, so a wrong zone or tier has to be
        // visible rather than assumed
        partyLuckPanel.show();

        expect(text()).toContain('Battles');
        expect(text()).toContain('100');
        expect(text()).toContain('Difficulty tier');
    });

    test('an item table names the drop, its haul and what it was owed', () => {
        partyLuckPanel.show();

        expect(text()).toContain('Apple');
        expect(text()).toContain('Owed');
    });

    test('an item that both dropped and was owed is one row, not two', () => {
        // The loot map is keyed by the game's slot key rather than by item hrid.
        // Matched on the raw key, every item that dropped appeared twice — once
        // with the haul and once at a permanent -100%.
        partyLuckPanel.show();

        const geared = partyLuck(game.context).players.find((player) => player.name === 'Geared');
        expect(geared.items.filter((item) => item.itemHrid === '/items/a')).toHaveLength(1);
    });

    test('a drop that was owed and never came is still a row', () => {
        // Those are the interesting ones — a run reads as unlucky because one
        // thing did not turn up, and a silence cannot say that
        const bare = partyLuck(game.context).players.find((player) => player.name === 'Bare');
        expect(bare.items).toHaveLength(1);
        expect(bare.items[0].count).toBe(0);
        expect(bare.items[0].expected).toBeGreaterThan(0);
    });

    test('the party total is there and marked as the party', () => {
        partyLuckPanel.show();
        expect(text()).toContain('TOTAL');
    });

    test('nothing measured yet says why rather than being blank', () => {
        // The zone and battle count are only on the wire during combat, which is
        // the state this panel opens in most of the time
        game.context = null;
        partyLuckPanel.show();

        expect(text()).toContain('No run measured yet');
        expect(text()).not.toContain(FAILED);
    });

    test('a zone the model cannot cover does not fail the panel', () => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true } };
        partyLuckPanel.show();

        expect(text()).toContain('No run measured yet');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the copy button', () => {
    const button = () => [...partyLuckPanel.panel.querySelectorAll('button')].find((el) => el.textContent === '⧉');

    test('copies the verdict and the party revenue, the figure people compare with each other', () => {
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        partyLuckPanel.show();
        button().click();

        expect(written[0]).toContain('15th percentile');
        expect(written[0]).toContain('Geared');
        expect(written[0]).toContain('Bare');
        expect(written[0]).toContain('TOTAL');
    });

    test('is absent when nothing has been measured yet', () => {
        game.context = null;
        partyLuckPanel.show();

        expect(button()).toBeUndefined();
    });

    test('inside a dungeon it copies the chest reading instead', () => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true } };
        game.chests = {
            partySize: 5,
            players: [
                {
                    name: 'Geared',
                    isCurrentPlayer: true,
                    mean: 1.295,
                    byPayout: {},
                    luck: { chests: 16, expected: 15.54, percentile: 0.68 },
                },
            ],
            counted: 'chests',
            entryKey: null,
        };
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        partyLuckPanel.show();
        button().click();

        expect(written[0]).toContain('16 of 15.5');
        expect(written[0]).toContain('68th');
    });
});

describe('buildPartyLuckSummaryText', () => {
    test('is empty when there is nothing measured and no chests', () => {
        expect(buildPartyLuckSummaryText({ players: [] }, null)).toBe('');
    });
});

describe('inside a dungeon', () => {
    beforeEach(() => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true } };
        game.chests = {
            partySize: 5,
            players: [
                {
                    name: 'Geared',
                    isCurrentPlayer: true,
                    mean: 1.295,
                    byPayout: { 1: 8, 2: 4 },
                    luck: {
                        completions: 12,
                        chests: 16,
                        expected: 15.54,
                        extras: 4,
                        expectedExtras: 3.54,
                        chance: 0.295,
                        percentile: 0.68,
                    },
                },
                { name: 'Bare', isCurrentPlayer: false, mean: 1, byPayout: {}, luck: null },
            ],
            counted: 'chests',
            entryKey: null,
        };
    });

    test('the chests are the reading, in place of a percentile the model cannot give', () => {
        partyLuckPanel.show();

        expect(text()).toContain('Dungeon chests');
        expect(text()).toContain('16 of 15.5');
        expect(text()).toContain('68th');
        expect(text()).not.toContain(FAILED);
    });

    test('somebody with no completion yet says so rather than reading as a disaster', () => {
        partyLuckPanel.show();

        expect(text()).toContain('Bare');
        expect(text()).toContain('no completion yet');
    });

    test('a level-gapped player keeps their verdict and gains an explanation', () => {
        // The cut is inside the expectation, so the percentile is about their
        // luck again — but an expectation that looks oddly small should not have
        // to be reverse-engineered from the number
        game.chests.players[0].levelGap = -0.9;
        game.chests.players[0].mean = 0.1;
        game.chests.players[0].observed = 0.08;
        partyLuckPanel.show();

        expect(text()).toContain('level gap');
        expect(text()).toContain('−90%');
        expect(text()).toContain('0.10 a completion');
        expect(text()).toContain('0.08 seen');
        expect(text()).toContain('68th');
        expect(text()).not.toContain(FAILED);
    });

    test('a player with no gap is unaffected by somebody else having one', () => {
        game.chests.players[0].levelGap = 0;
        partyLuckPanel.show();

        expect(text()).toContain('16 of 15.5');
        expect(text()).not.toContain('level gap');
    });

    test('where the completions came from is said, because the two see different things', () => {
        partyLuckPanel.show();
        expect(text()).toContain('inferred from chests');

        partyLuckPanel.hide();
        game.chests.counted = 'tracker';
        partyLuckPanel.show();
        expect(text()).toContain('from the dungeon tracker');
    });

    test('entry keys are shown as spent, not netted against keys bought', () => {
        game.chests.entryKey = { itemHrid: '/items/chimerical_entry_key', spent: 12, gained: 200 };
        partyLuckPanel.show();

        expect(text()).toContain('Entry keys spent');
        expect(text()).toContain('12');
        expect(text()).not.toContain('-188');
    });

    test('and the section is absent when nothing has been spent', () => {
        partyLuckPanel.show();
        expect(text()).not.toContain('Entry keys spent');
    });

    test('and the per-monster tables are not drawn, because there are none', () => {
        // A dungeon pays on completion from a reward table; an item table built
        // from monster drop rates would be a confident answer to another zone
        partyLuckPanel.show();

        expect(text()).not.toContain('Revenue');
        expect(text()).not.toContain('Session Statistics');
    });
});
