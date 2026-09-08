/** @vitest-environment happy-dom */

/**
 * Reading the In Progress tab.
 *
 * The fixtures below are built from the one card that has actually been
 * observed: a "Trial Chameleon" at Lv.140 with a small falling number over a
 * large one (30,857 / 618,000) and a second, larger pair beside it
 * (582,115 / 600,000). Two things are worth pinning down and both are here — a
 * bar reading must survive commas and abbreviations, and which of two readings
 * is the boss must be decided by which one *falls*, never by which comes first.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import {
    classifyReadings,
    findTrialClockMs,
    findTrialsRoot,
    inFloatingDialog,
    isPlausibleReading,
    isStatLabel,
    isTrialsSetupTab,
    onTrialTab,
    parsePoints,
    readPersonalStats,
    readTrialStatus,
    parseSignups,
    isCombatTrialName,
    matchTrialHrid,
    parseAmount,
    parseBarReadings,
    parseClockMs,
    parseTrialLevel,
    parseTrialTier,
    parseWordyDurationMs,
    readTrialTiles,
    textLines,
} from './guild-trials-scrape.js';
import { NOTICE_BOARD_NAME } from './guild-notice-board.fixture.js';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

/** An hour, which is how long a trial runs */
const HOUR_MS = 60 * 60 * 1000;

describe('parseAmount', () => {
    test('plain and comma-grouped numbers', () => {
        expect(parseAmount('618000')).toBe(618_000);
        expect(parseAmount('618,000')).toBe(618_000);
        expect(parseAmount('  30,857 ')).toBe(30_857);
        expect(parseAmount('0')).toBe(0);
    });

    test('the abbreviations the game renders in bars', () => {
        expect(parseAmount('618K')).toBe(618_000);
        expect(parseAmount('1.2M')).toBe(1_200_000);
        expect(parseAmount('3b')).toBe(3_000_000_000);
        expect(parseAmount('2.5 T')).toBe(2.5e12);
    });

    test('anything that is not a number is not one', () => {
        expect(parseAmount('Trial Chameleon')).toBeNull();
        expect(parseAmount('')).toBeNull();
        expect(parseAmount(null)).toBeNull();
        expect(parseAmount('12x')).toBeNull();
    });
});

describe('parseBarReadings', () => {
    test('finds every current-over-max pair, in order', () => {
        expect(parseBarReadings('Trial Chameleon Lv.140 30,857 / 618,000 582,115 / 600,000')).toEqual([
            { current: 30_857, max: 618_000 },
            { current: 582_115, max: 600_000 },
        ]);
    });

    test('tolerates spacing and abbreviation', () => {
        expect(parseBarReadings('12.5K/1.2M')).toEqual([{ current: 12_500, max: 1_200_000 }]);
        expect(parseBarReadings('0  /  900')).toEqual([{ current: 0, max: 900 }]);
    });

    test('a bar with no maximum is not a reading', () => {
        expect(parseBarReadings('5 / 0')).toEqual([]);
    });

    test('text with no bars yields nothing', () => {
        expect(parseBarReadings('Waiting for the trial to begin')).toEqual([]);
        expect(parseBarReadings(null)).toEqual([]);
    });
});

describe('parseTrialLevel', () => {
    test('reads the level off the tile summary', () => {
        expect(parseTrialLevel('Lv.140')).toBe(140);
        expect(parseTrialLevel('Trial Chameleon Lv. 200 ')).toBe(200);
        expect(parseTrialLevel('lv100')).toBe(100);
    });

    test('a tile with no level marker has no level', () => {
        expect(parseTrialLevel('Trial Chameleon')).toBeNull();
        expect(parseTrialLevel(undefined)).toBeNull();
    });
});

describe('parseClockMs', () => {
    test('mm:ss and h:mm:ss', () => {
        expect(parseClockMs('42:15 remaining')).toBe((42 * 60 + 15) * 1000);
        expect(parseClockMs('1:00:00')).toBe(3_600_000);
        expect(parseClockMs('0:09')).toBe(9000);
    });

    test('text with no clock in it', () => {
        expect(parseClockMs('In progress')).toBeNull();
        expect(parseClockMs(null)).toBeNull();
    });
});

describe('naming', () => {
    test('the five encounters are recognised as combat trials', () => {
        for (const name of ['Trial Badger', 'trial chameleon', 'Trial Jellyfish', 'Hedgehog', 'The Swarm']) {
            expect(isCombatTrialName(name)).toBe(true);
        }
    });

    test('anything else is a skilling trial', () => {
        expect(isCombatTrialName('Trial Milking')).toBe(false);
        expect(isCombatTrialName('')).toBe(false);
    });

    test('a displayed name is matched to the hrid the socket reports', () => {
        const hrids = ['/guild_trials/chameleon', '/guild_trials/milking', '/guild_trials/cheesesmithing'];
        expect(matchTrialHrid('Trial Chameleon', hrids)).toBe('/guild_trials/chameleon');
        expect(matchTrialHrid('Milking', hrids)).toBe('/guild_trials/milking');
        expect(matchTrialHrid('Cheesesmithing', hrids)).toBe('/guild_trials/cheesesmithing');
    });

    test('a name matching nothing matches nothing', () => {
        expect(matchTrialHrid('Trial Badger', ['/guild_trials/milking'])).toBeNull();
        expect(matchTrialHrid('', ['/guild_trials/milking'])).toBeNull();
        expect(matchTrialHrid('Milking', [])).toBeNull();
    });
});

describe('readTrialTiles', () => {
    /**
     * The observed card, as markup.
     * @param {Array<{name: string, level: number, bars: string}>} cards - Cards to build
     * @returns {Element} A trials-content root
     */
    function buildTab(cards) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__abc';
        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__xyz';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__q1">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__p2">Lv.${card.level}</div>` +
                `<div class="ProgressBar_text__r3">${card.bars}</div>`;
            root.appendChild(tile);
        }
        document.body.appendChild(root);
        return root;
    }

    test('reads the observed Trial Chameleon card', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bars: '30,857 / 618,000 582,115 / 600,000' }]);
        const tiles = readTrialTiles(root);

        expect(tiles).toHaveLength(1);
        expect(tiles[0]).toMatchObject({
            name: 'Trial Chameleon',
            level: 140,
            tier: 5,
            kind: 'combat',
            readings: [
                { current: 30_857, max: 618_000 },
                { current: 582_115, max: 600_000 },
            ],
        });
        expect(tiles[0].element.className).toContain('GuildPanel_tile');
    });

    test('a skilling card is read as one', () => {
        const root = buildTab([{ name: 'Trial Milking', level: 110, bars: '1.2M / 4M' }]);
        const tiles = readTrialTiles(root);

        expect(tiles[0]).toMatchObject({ name: 'Trial Milking', tier: 2, kind: 'skilling' });
        expect(tiles[0].readings).toEqual([{ current: 1_200_000, max: 4_000_000 }]);
    });

    test('several cards come back in document order', () => {
        const root = buildTab([
            { name: 'Trial Milking', level: 100, bars: '0 / 100' },
            { name: 'Trial Swarm', level: 130, bars: '5 / 500' },
        ]);
        expect(readTrialTiles(root).map((tile) => tile.name)).toEqual(['Trial Milking', 'Trial Swarm']);
    });

    test('a card with no level is not a trial', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a">' +
            '<div class="GuildPanel_tile__b"><div class="GuildPanel_tileSummary__c">Not started</div></div>' +
            '</div>';
        expect(readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'))).toEqual([]);
    });

    test('a summary nested inside a tile still yields one tile, not two', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a"><div class="GuildPanel_tile__b">' +
            '<div><div class="GuildPanel_tileSummary__c">Lv.150</div></div>' +
            '<div class="GuildPanel_tileName__d">Trial Badger</div>' +
            '<div>10 / 100</div></div></div>';
        const tiles = readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'));

        expect(tiles).toHaveLength(1);
        expect(tiles[0]).toMatchObject({ name: 'Trial Badger', level: 150, tier: 6, kind: 'combat' });
    });

    test('a name is recovered from the card text when there is no name element', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a"><div class="GuildPanel_tile__b">' +
            '<div class="GuildPanel_tileSummary__c">Trial Jellyfish Lv.170 4 / 40</div></div></div>';
        const tiles = readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'));

        expect(tiles[0].name).toBe('Trial Jellyfish');
        expect(tiles[0].kind).toBe('combat');
    });

    test('a level element beside a bar element is not welded into one number', () => {
        // `textContent` on the card gives `Trial MilkingLv.1101.2M / 4M`, which
        // parses as level 1,101 and a current of 1,101,200,000 if the card is
        // read as one string. Both readings are plausible-looking and wrong.
        const root = buildTab([{ name: 'Trial Milking', level: 110, bars: '1.2M / 4M' }]);
        const tiles = readTrialTiles(root);

        expect(tiles[0].level).toBe(110);
        expect(tiles[0].readings).toEqual([{ current: 1_200_000, max: 4_000_000 }]);
    });

    test('nothing to read is an empty list, not a throw', () => {
        expect(readTrialTiles(null)).toEqual([]);
        expect(readTrialTiles({})).toEqual([]);
    });

    test('a guild building is not a trial, however wide the root is', () => {
        // The same `GuildPanel_tileSummary` carries a building's "Lv. 10 / 20",
        // and the root being scraped is a whole guild panel whenever the tab's
        // own container is not where it was expected. A building read as a trial
        // would be a tier-1 card with a nonsense bar on it.
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__a">' +
            '<div class="GuildPanel_tile__b"><div class="GuildPanel_tileSummary__c">Treasury Lv. 10 / 20</div></div>' +
            '<div class="GuildPanel_tile__d"><div class="GuildPanel_tileSummary__e">Trial Milking Lv.110</div>' +
            '<div>1.2M / 4M</div></div></div>';

        const tiles = readTrialTiles(document.querySelector('[class*="GuildPanel_guildPanel"]'));
        expect(tiles.map((tile) => tile.name)).toEqual(['Trial Milking']);
    });
});

describe('a guild notice board is not a trial', () => {
    // From a live 106-member guild: the whole notice — braille art, a welcome,
    // three Discord links, the kick rules — became a tile, because two Discord
    // channel ids in it have exactly the shape of a progress bar. It was then
    // sampled every five seconds and used to start the recorder
    const CHANNEL_LINK = 'https://discord.com/channels/1234500000000000001/1525000000000000321';

    test('two Discord channel ids are not a progress bar', () => {
        expect(parseBarReadings(CHANNEL_LINK)).toEqual([]);
        expect(isPlausibleReading(1_309_080_597_314_011_148, 1_525_897_111_936_438_314)).toBe(false);
    });

    test('a real pool and a real boss still read', () => {
        expect(parseBarReadings('20,500 / 57,120')).toEqual([{ current: 20_500, max: 57_120 }]);
        expect(parseBarReadings('4.2M / 8.4M')).toEqual([{ current: 4_200_000, max: 8_400_000 }]);
        expect(isPlausibleReading(490_871, 721_000)).toBe(true);
        // A bar that has not been populated is still not a full one
        expect(isPlausibleReading(0, 0)).toBe(false);
    });

    test('the notice yields no cards, however trial-shaped its prose', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            `<div class="GuildPanel_tileName__d">${NOTICE_BOARD_NAME.replace(/</g, '')}</div>` +
            `<div class="ProgressBar_text__f">${CHANNEL_LINK}</div>`;
        root.appendChild(tile);
        document.body.appendChild(root);

        expect(readTrialTiles(root)).toEqual([]);
    });
});

describe('a card is not allowed to be in a dialog', () => {
    // Reported live: clicking the boss in the trial fight view opens a stat
    // popup headed "Trial Chameleon - Lv.110", and the whole trial block —
    // Rate, On pace, Banked, Per player — was drawn inside it, above the boss's
    // own stat lines. A trial name over a level is exactly what a card is
    // anchored by, so no card filter could ever have caught this
    function buildPopup() {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a">' +
            '<div class="Modal_modalContainer__m" role="dialog">' +
            '<div class="Modal_modalContent__n">' +
            '<div class="GuildPanel_tileName__q">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__p">Lv.110</div>' +
            '<div class="ProgressBar_text__r">618,000 / 618,000</div>' +
            '</div></div></div>';
        return document.querySelector('[class*="GuildPanel_trialsContent"]');
    }

    test('the boss’s stat popup yields no cards', () => {
        expect(readTrialTiles(buildPopup())).toEqual([]);
    });

    test('a dialog is recognised by its class or by its role', () => {
        buildPopup();
        const inside = document.querySelector('[class*="GuildPanel_tileSummary"]');
        expect(inFloatingDialog(inside)).toBe(true);

        document.body.innerHTML = '<div class="GuildPanel_tile__a"><span id="plain">Lv.110</span></div>';
        expect(inFloatingDialog(document.getElementById('plain'))).toBe(false);
        expect(inFloatingDialog(null)).toBe(false);
    });

    test('an aria-modal wrapper counts even without a matching class', () => {
        document.body.innerHTML = '<div aria-modal="true"><span id="in">Lv.110</span></div>';
        expect(inFloatingDialog(document.getElementById('in'))).toBe(true);
    });

    test('the real cards beside a popup are still read', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_trialsContent__a">' +
            '<div class="GuildPanel_tile__c">' +
            '<div class="GuildPanel_tileName__q">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__p">Lv.140</div>' +
            '</div>' +
            '<div class="Modal_modalContent__n">' +
            '<div class="GuildPanel_tileName__q">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__p">Lv.110</div>' +
            '</div></div>';

        const tiles = readTrialTiles(document.querySelector('[class*="GuildPanel_trialsContent"]'));
        expect(tiles).toHaveLength(1);
        expect(tiles[0].level).toBe(140);
    });
});

describe('findTrialsRoot', () => {
    test('prefers the tab container the game names, when it has one', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__a"><div class="GuildPanel_trialsContent__b">' +
            '<div class="GuildPanel_tileSummary__c">Trial Milking Lv.110</div></div></div>';

        expect(findTrialsRoot(document).className).toContain('GuildPanel_trialsContent');
    });

    test('accepts the other spelling the tab could plausibly carry', () => {
        // Every other tab is `<name>Tab` — `membersTab`, `overviewTab` — so
        // `trialsContent` was always a guess, and guessing once is enough
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__a"><div class="GuildPanel_trialsTab__b">' +
            '<div class="GuildPanel_tileSummary__c">Trial Milking Lv.110</div></div></div>';

        expect(findTrialsRoot(document).className).toContain('GuildPanel_trialsTab');
    });

    test('falls back to the guild panel itself when the tab is called something else', () => {
        // This is the whole bug: one unverified class name took the feature
        // offline with no error anywhere. A card on screen is enough to work from.
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__a"><div class="GuildPanel_somethingElse__b">' +
            '<div class="GuildPanel_tileSummary__c">Trial Milking Lv.110</div></div></div>';

        const root = findTrialsRoot(document);
        expect(root.className).toContain('GuildPanel_guildPanel');
        expect(readTrialTiles(root)).toHaveLength(1);
    });

    test('the outermost guild element wins, not the first small child', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__a"><div class="GuildPanel_inner__b">' +
            '<div class="GuildPanel_tileSummary__c">Trial Milking Lv.110</div></div></div>';

        expect(findTrialsRoot(document).className).toContain('GuildPanel_guildPanel');
    });

    test('no cards on screen is no root, rather than a panel to scrape for nothing', () => {
        document.body.innerHTML = '<div class="GuildPanel_guildPanel__a"><table></table></div>';
        expect(findTrialsRoot(document)).toBeNull();
    });

    test('nothing to look at is null, not a throw', () => {
        expect(findTrialsRoot(null)).toBeNull();
        expect(findTrialsRoot({})).toBeNull();
    });
});

describe('textLines', () => {
    test('one entry per element that holds text, in document order', () => {
        document.body.innerHTML = '<div id="t"><span>Trial Badger</span><span>Lv.150</span><i>10 / 100</i></div>';
        expect(textLines(document.getElementById('t'))).toEqual(['Trial Badger', 'Lv.150', '10 / 100']);
    });

    test('an element that is only text is one line', () => {
        document.body.innerHTML = '<div id="t">Trial Badger Lv.150</div>';
        expect(textLines(document.getElementById('t'))).toEqual(['Trial Badger Lv.150']);
    });

    test('empty elements contribute nothing', () => {
        document.body.innerHTML = '<div id="t"><span></span><span>  </span><span>Lv.100</span></div>';
        expect(textLines(document.getElementById('t'))).toEqual(['Lv.100']);
    });
});

describe('classifyReadings', () => {
    const sample = (...pairs) => pairs.map(([current, max]) => ({ current, max }));

    test('a combat card is the boss’s health then its mana', () => {
        // Confirmed from a live client. The second bar is the boss's mana — not
        // a pool, and not something the party's damage moves
        const history = [
            sample([618_000, 618_000], [500_000, 600_000]),
            sample([400_000, 618_000], [540_000, 600_000]),
            sample([30_857, 618_000], [582_115, 600_000]),
        ];
        expect(classifyReadings(history, 'combat')).toEqual({ bossIndex: 0, poolIndex: null });
    });

    test('a combat card whose readings straddle a tier clear is still read', () => {
        // The recorded trial, exactly: neither bar fell between the two
        // readings, because the party finished tier 2's boss and is partway
        // into tier 3's larger one. Deciding by movement gave up here and the
        // card produced no rate for the whole hour.
        const history = [sample([23_031, 618_000], [582_560, 600_000]), sample([506_273, 669_500], [644_395, 650_000])];
        expect(classifyReadings(history, 'combat')).toEqual({ bossIndex: 0, poolIndex: null });
    });

    test('a single unmoved reading is called by the trial kind', () => {
        expect(classifyReadings([sample([100, 1000])], 'combat')).toEqual({ bossIndex: 0, poolIndex: null });
        expect(classifyReadings([sample([100, 1000])], 'skilling')).toEqual({ bossIndex: null, poolIndex: 0 });
    });

    test('a skilling card is still read by which way its pool moves', () => {
        const history = [sample([100, 1000]), sample([200, 1000])];
        expect(classifyReadings(history, 'skilling')).toEqual({ bossIndex: null, poolIndex: 0 });
    });

    test('a skilling pool that fell is a tier reset, not a boss', () => {
        // Across a tier clear the pool resets onto the next tier's target, so
        // its lone bar *falls* — and reading that by movement dropped the bar
        // from the analysis right as the next tier began. One bar on a
        // skilling card is the pool by construction.
        const history = [sample([90_000, 93_840]), sample([1_200, 97_920])];
        expect(classifyReadings(history, 'skilling')).toEqual({ bossIndex: null, poolIndex: 0 });
    });

    test('nothing to classify', () => {
        expect(classifyReadings([], 'combat')).toEqual({ bossIndex: null, poolIndex: null });
        expect(classifyReadings(undefined, 'skilling')).toEqual({ bossIndex: null, poolIndex: null });
    });
});

describe('parseWordyDurationMs', () => {
    test('reads the units the game writes durations in', () => {
        expect(parseWordyDurationMs('42m 15s')).toBe(42 * 60_000 + 15_000);
        expect(parseWordyDurationMs('1h 3m')).toBe(3600_000 + 180_000);
        expect(parseWordyDurationMs('58 sec')).toBe(58_000);
        expect(parseWordyDurationMs('2 hours 30 minutes')).toBe(9000_000);
    });

    test('a number with no unit on it is not a duration', () => {
        expect(parseWordyDurationMs('618000')).toBeNull();
        expect(parseWordyDurationMs('Trial Chameleon')).toBeNull();
        expect(parseWordyDurationMs(null)).toBeNull();
    });
});

describe('findTrialClockMs', () => {
    /**
     * A tab built from lines of text, one element each.
     * @param {string[]} lines - What the tab says
     * @returns {Element} The root
     */
    function tab(lines) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        for (const text of lines) {
            const el = document.createElement('div');
            el.textContent = text;
            root.appendChild(el);
        }
        document.body.appendChild(root);
        return root;
    }

    test('finds the countdown without being told which element holds it', () => {
        // `GuildPanel_eventStatusRow` is as unverified as the tab container was,
        // and it was the only thing that ever produced a time left
        expect(findTrialClockMs(tab(['Trial Chameleon', '42:15 remaining']), HOUR_MS)).toBe(42 * 60_000 + 15_000);
    });

    test('reads a countdown written in words too', () => {
        expect(findTrialClockMs(tab(['Ends in 12m 30s']), HOUR_MS)).toBe(12 * 60_000 + 30_000);
    });

    test('a progress bar is not a clock', () => {
        // `15 / 60` would otherwise read as fifteen minutes, and a pace fitted to
        // an invented deadline is worse than no pace at all
        expect(findTrialClockMs(tab(['582,115 / 600,000', '15 / 60']), HOUR_MS)).toBeNull();
    });

    test('anything longer than a trial is something else, and is rejected rather than clamped', () => {
        // Clamping 1:30:00 down to an hour would turn a wrong reading into a
        // confident one
        expect(findTrialClockMs(tab(['1:30:00']), HOUR_MS)).toBeNull();
        expect(findTrialClockMs(tab(['0:00']), HOUR_MS)).toBeNull();
    });

    test('a labelled line wins over a bare number that happens to parse', () => {
        expect(findTrialClockMs(tab(['3:20', 'Time remaining 12:00']), HOUR_MS)).toBe(12 * 60_000);
    });

    test('a bare plausible clock is still taken when nothing is labelled', () => {
        expect(findTrialClockMs(tab(['3:20']), HOUR_MS)).toBe(200_000);
    });

    test('no clock anywhere is null, not a guess', () => {
        expect(findTrialClockMs(tab(['Trial Chameleon', 'Lv.140']), HOUR_MS)).toBeNull();
        expect(findTrialClockMs(null, HOUR_MS)).toBeNull();
    });
});

describe('the cards on the two live tabs', () => {
    /**
     * A Trials-tab setup card, as the live client draws one.
     * @param {string} html - The card's inner markup
     * @returns {Element} A guild panel holding it
     */
    function panelWith(html) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${html}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('a Trials card gives level, tier, points and sign-ups, and no readings', () => {
        const root = panelWith(
            '<div class="GuildPanel_tile__a">' +
                '<div class="GuildPanel_tileName__n">Milking</div>' +
                '<div class="GuildPanel_tileSummary__s">Lv.130</div>' +
                '<div>600 pts</div><div>1/28 signed up</div><div>20m 53s</div></div>'
        );

        expect(readTrialTiles(root)[0]).toMatchObject({
            name: 'Milking',
            level: 130,
            tier: 4,
            kind: 'skilling',
            points: 600,
            signups: { signed: 1, total: 28 },
            readings: [],
        });
    });

    test('an In Progress card gives the reading, with no level anywhere on it', () => {
        const root = panelWith('<div class="GuildPanel_card__a"><div>Alchemy</div><div>18,850 / 65,280</div></div>');
        const cards = readTrialTiles(root);

        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ name: 'Alchemy', level: null, tier: null, kind: 'skilling' });
        expect(cards[0].readings).toEqual([{ current: 18_850, max: 65_280 }]);
    });

    test('a card whose name is not a trial is not a card', () => {
        // Guild buildings, member rows and the guild's own XP bar all live on
        // the same panel, and the fallback root is the whole panel
        const root = panelWith(
            '<div class="GuildPanel_tile__a"><div>Treasury</div><div>Lv. 10 / 20</div></div>' +
                '<div class="GuildPanel_tile__b"><div>Guild Experience</div><div>4,120 / 20,000</div></div>'
        );

        expect(readTrialTiles(root)).toEqual([]);
    });

    test('a combat trial on the In Progress tab is still classed as combat', () => {
        const root = panelWith(
            '<div class="GuildPanel_card__a"><div>Trial Chameleon</div><div>30,857 / 618,000</div></div>'
        );
        expect(readTrialTiles(root)[0].kind).toBe('combat');
    });

    test("this script's own block is not read back as game text", () => {
        const root = panelWith(
            '<div class="GuildPanel_tile__a"><div>Alchemy</div><div>18,850 / 65,280</div>' +
                '<div class="mwi-trial-info"><div>Next tier work (T7)</div><div>1 / 2</div></div></div>'
        );

        expect(readTrialTiles(root)[0].readings).toEqual([{ current: 18_850, max: 65_280 }]);
    });

    test('the same trial on both tabs is one card each, keyed by the same name', () => {
        const trials = readTrialTiles(
            panelWith('<div class="GuildPanel_tile__a"><div>Alchemy</div><div>Lv.150</div></div>')
        )[0];
        const live = readTrialTiles(
            panelWith('<div class="GuildPanel_card__a"><div>Alchemy</div><div>18,850 / 65,280</div></div>')
        )[0];

        expect(trials.name).toBe(live.name);
        expect(trials.tier).toBe(6);
        expect(live.readings).toHaveLength(1);
    });
});

describe('a card that states its tier instead of its level', () => {
    /**
     * A guild panel holding one card.
     * @param {string} html - The card's markup
     * @returns {Element} The panel
     */
    function panelWith(html) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${html}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('the stated tier is read, and the points file under it', () => {
        // From the live export: the record held `tiers: []` and `pointsByTier:
        // {}` for a week whose cards were plainly showing "840 pts" and "T6".
        // The tier was only ever derived from `Lv.<n>`, so a card without one
        // recorded no tier — and a points figure with no tier to file it under
        // is dropped, which is why both were empty at once.
        const tile = readTrialTiles(
            panelWith(
                '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Alchemy</div>' +
                    '<div>840 pts</div><div>T6</div><div>1/28 signed up</div></div>'
            )
        )[0];

        expect(tile).toMatchObject({ name: 'Alchemy', level: null, tier: 6, points: 840 });
    });

    test('"Tier 8" spelled out is the same claim', () => {
        const tile = readTrialTiles(
            panelWith(
                '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Trial Chameleon</div>' +
                    '<div>Tier 8</div><div>1,080 pts</div></div>'
            )
        )[0];
        expect(tile).toMatchObject({ tier: 8, points: 1080, kind: 'combat' });
    });

    test('a level still decides when the card carries no tier of its own', () => {
        const tile = readTrialTiles(
            panelWith(
                '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Milking</div>' +
                    '<div class="GuildPanel_tileSummary__s">Lv.130</div></div>'
            )
        )[0];
        expect(tile).toMatchObject({ level: 130, tier: 4 });
    });

    test("this script's own tier badge is not read back as the game's", () => {
        // `guild-credit-value.js` writes a `T<n>` span into the level line. It
        // carries an `mwi-` class and `textLines` skips it, so the tier here is
        // still the one derived from the level rather than the one this drew
        const tile = readTrialTiles(
            panelWith(
                '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Milking</div>' +
                    '<div class="GuildPanel_tileSummary__s">Lv.130<span class="mwi-trial-tier">T9</span></div></div>'
            )
        )[0];
        expect(tile.tier).toBe(4);
    });
});

describe('a card that says the trial is over', () => {
    /**
     * A guild panel holding one card.
     * @param {string} html - The card's markup
     * @returns {Element} The panel
     */
    function panelWith(html) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${html}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('“Completed” is read off the card', () => {
        // The finished Trial Chameleon. Worth reading because it settles what
        // the tier badge means: 960 pts is the ladder's three-tier total at
        // +20%, so a finished card's badge is the tiers earned
        const tile = readTrialTiles(
            panelWith(
                '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Trial Chameleon</div>' +
                    '<div class="GuildPanel_tileSummary__s">Lv.120</div>' +
                    '<div>960 pts</div><div>Completed</div><div>1/28 signed up</div></div>'
            )
        )[0];

        expect(tile).toMatchObject({ name: 'Trial Chameleon', tier: 3, points: 960, completed: true });
    });

    test('a card still running does not say it', () => {
        const tile = readTrialTiles(
            panelWith(
                '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Alchemy</div>' +
                    '<div class="GuildPanel_tileSummary__s">Lv.170</div><div>1,080 pts</div><div>20m 53s</div></div>'
            )
        )[0];
        expect(tile.completed).toBe(false);
    });
});

describe('the Overview tab is not the trials tab', () => {
    /**
     * The guild page as the Overview tab draws it: a notice board and the
     * guild's own XP bar, and not a trial anywhere.
     * @returns {Element} The panel
     */
    function overview() {
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="TabsComponent_tab__x TabsComponent_selected__y">Overview</div>' +
            '<div class="TabsComponent_tab__x">Trials</div>' +
            '<div class="GuildPanel_notice__n">Welcome! We are milking at Level 90 if anyone wants to join, ' +
            'and there is cheesesmithing on Thursdays.</div>' +
            '<div class="GuildPanel_dataBlock__d"><div>Exp to Next Level</div><div>4,120 / 20,000</div></div>' +
            '</div>';
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('a notice board beside an XP bar builds no cards', () => {
        // Every ingredient of the reported bug in one fixture: a reading that
        // looks like a progress bar, and prose that mentions two skills
        expect(readTrialTiles(overview())).toEqual([]);
    });

    test('and the tab strip says so on its own', () => {
        expect(onTrialTab(overview())).toBe(false);
    });

    test('the trials tab passes the same gate', () => {
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="TabsComponent_tab__x">Overview</div>' +
            '<div class="TabsComponent_tab__x TabsComponent_selected__y">In Progress</div>' +
            '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Alchemy</div>' +
            '<div>18,850 / 65,280</div></div></div>';
        const panel = document.querySelector('[class*="GuildPanel_guildPanel"]');

        expect(onTrialTab(panel)).toBe(true);
        expect(readTrialTiles(panel)).toHaveLength(1);
    });

    test('a page with no legible tab strip is allowed, not refused', () => {
        // The class name is unverified, and a gate that fails closed on an
        // unrecognised tab strip takes the whole feature off the screen the day
        // the game renames something
        document.body.innerHTML = '<div class="GuildPanel_guildPanel__r"><div>Alchemy</div></div>';
        expect(onTrialTab(document.querySelector('[class*="GuildPanel"]'))).toBe(true);
        expect(onTrialTab(null)).toBe(true);
    });
});

describe('readTrialStatus', () => {
    /**
     * A tab built from lines of text, one element each.
     * @param {string[]} lines - What the tab says
     * @returns {Element} The root
     */
    function tab(lines) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${lines
            .map((line) => `<div>${line}</div>`)
            .join('')}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('a scheduled cycle, with how long until it starts', () => {
        const status = readTrialStatus(tab(['Skilling Trial', 'Scheduled Wed 04:00 PM 2h 24m']));

        expect(status.phase).toBe('scheduled');
        expect(status.startsInMs).toBe(2 * 3600_000 + 24 * 60_000);
    });

    test('a caller-supplied line walk is used in place of walking the root again', () => {
        // The render walks the panel once and hands the same lines to both
        // readers; supplying them must match reading the root directly.
        const root = tab(['Skilling Trial - In Progress  Thu 04:00 PM', 'Work Time 3.14s', 'Success Rate 60.8%']);
        const shared = textLines(root);

        expect(readTrialStatus(root, shared)).toEqual(readTrialStatus(root));
        expect(readPersonalStats(root, shared)).toEqual(readPersonalStats(root));
        // And it really used what was handed in, not the DOM: a doctored list is honoured
        expect(readTrialStatus(root, ['Combat Trial - Scheduled Thu 05:00 PM 1h 2m'])).toMatchObject({
            phase: 'scheduled',
            kind: 'combat',
        });
    });

    test('the live header, exactly as the game writes it', () => {
        // From the running trial: the status carries the trial's *kind* in front
        // of it, which is not what this was built against, and the gate that
        // reads it kept the recorder from arming
        expect(readTrialStatus(tab(['Skilling Trial - In Progress  Thu 04:00 PM'])).phase).toBe('live');
        expect(readTrialStatus(tab(['Combat Trial - In Progress  Thu 05:00 PM'])).phase).toBe('live');
    });

    test('a header split across elements is still one status', () => {
        // The game draws the kind and the status as separate runs
        expect(readTrialStatus(tab(['Skilling Trial -', 'In Progress', 'Thu 04:00 PM'])).phase).toBe('live');
    });

    test('a status below whatever the tab draws above it is still found', () => {
        const preamble = Array.from({ length: 15 }, (_, index) => `Row ${index}`);
        expect(readTrialStatus(tab([...preamble, 'Combat Trial - In Progress'])).phase).toBe('live');
    });

    test('the header names which trial it is about', () => {
        // A cycle runs the skilling hour and then the combat one, so a status
        // without its kind attached says the combat trial is under way during
        // the skilling hour — which is what it did
        expect(readTrialStatus(tab(['Skilling Trial - In Progress  Thu 04:00 PM']))).toMatchObject({
            phase: 'live',
            kind: 'skilling',
        });
        expect(readTrialStatus(tab(['Combat Trial - Scheduled Thu 05:00 PM 1h 2m']))).toMatchObject({
            phase: 'scheduled',
            kind: 'combat',
        });
        // A header that names no kind is the old, single-trial case
        expect(readTrialStatus(tab(['In Progress'])).kind).toBeNull();
    });

    test('a finished cycle', () => {
        expect(readTrialStatus(tab(['Completed Thu 09:00 AM'])).phase).toBe('completed');
    });

    test('a running one', () => {
        expect(readTrialStatus(tab(['In Progress', '42:15 remaining'])).phase).toBe('live');
    });

    test('prose that happens to contain the word is not a status', () => {
        const long =
            'Trials are scheduled once a week and the guild is welcome to sign up for whichever of them ' +
            'it likes the look of';
        expect(readTrialStatus(tab([long])).phase).toBeNull();
    });

    test('nothing to read is no phase rather than a throw', () => {
        expect(readTrialStatus(null).phase).toBeNull();
        expect(readTrialStatus(tab(['Alchemy', '18,850 / 65,280'])).phase).toBeNull();
    });
});

describe('readPersonalStats', () => {
    /**
     * A tab built from lines of text, one element each.
     * @param {string[]} lines - What the tab says
     * @returns {Element} The root
     */
    function tab(lines) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${lines
            .map((line) => `<div>${line}</div>`)
            .join('')}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('the footer’s own stats are read as label and value', () => {
        // The only personal skilling figures anything offers: no socket message
        // carries a success chance, and this footer is where the game states one
        const stats = readPersonalStats(tab(['Work Time', '3.14s', 'Success Rate', '60.8%', 'Efficiency', '12%']));

        expect(stats).toMatchObject({ 'Work Time': '3.14s', 'Success Rate': '60.8%', Efficiency: '12%' });
    });

    test('a label and value on one run are read too', () => {
        const stats = readPersonalStats(tab(['Success Rate: 60.8%', 'Work Time: 3.14s']));
        expect(stats).toMatchObject({ 'Success Rate': '60.8%', 'Work Time': '3.14s' });
    });

    test('the per-minute time list is not a stat sheet', () => {
        // Exactly what the export carried beside the real stats: fifty-eight
        // rows of a session log, read as labelled numbers and stored as stats
        const stats = readPersonalStats(
            tab([
                'Work Power',
                '146',
                'Success Rate',
                '49.6%',
                '59m',
                '5s',
                '58m',
                '2s',
                '1m',
                '3s',
                'Time',
                '1s',
                'Lv.100',
                '6',
            ])
        );

        expect(stats).toEqual({ 'Work Power': '146', 'Success Rate': '49.6%' });
    });

    test('what counts as a stat name is a word, not a number with a unit', () => {
        expect(isStatLabel('Work Power')).toBe(true);
        expect(isStatLabel('Double Progress')).toBe(true);
        expect(isStatLabel('Armor')).toBe(true);
        // A number with a unit stuck to it, a bare heading, and a level badge
        expect(isStatLabel('59m')).toBe(false);
        expect(isStatLabel('1m')).toBe(false);
        expect(isStatLabel('Time')).toBe(false);
        expect(isStatLabel('Total')).toBe(false);
        expect(isStatLabel('Lv.100')).toBe(false);
        expect(isStatLabel('T3')).toBe(false);
        expect(isStatLabel('')).toBe(false);
    });

    test('a progress bar is not a stat', () => {
        const stats = readPersonalStats(tab(['Alchemy', '18,850 / 65,280', '1/28 signed up']));
        expect(stats).toEqual({});
    });

    test('whatever the game adds later is captured without being named here', () => {
        const stats = readPersonalStats(tab(['Some New Stat', '4.5x']));
        expect(stats['Some New Stat']).toBe('4.5x');
    });

    test('nothing to read is an empty object rather than a throw', () => {
        expect(readPersonalStats(null)).toEqual({});
        expect(readPersonalStats(tab([]))).toEqual({});
    });
});

describe('isTrialsSetupTab', () => {
    /**
     * A guild panel holding one card.
     * @param {string} html - The card's markup
     * @returns {Element} The panel
     */
    function panelWith(html) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${html}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    test('the setup tab is cards with points and sign-ups and no bar', () => {
        const root = panelWith(
            '<div class="GuildPanel_tile__a"><div class="GuildPanel_tileName__n">Alchemy</div>' +
                '<div class="GuildPanel_tileSummary__s">Lv.170</div><div>1,080 pts</div>' +
                '<div>1/28 signed up</div></div>'
        );
        expect(isTrialsSetupTab(root)).toBe(true);
    });

    test('a card with a reading on it is the In Progress tab', () => {
        const root = panelWith(
            '<div class="GuildPanel_card__a"><div>Trial Chameleon</div><div>506,273 / 669,500</div></div>'
        );
        expect(isTrialsSetupTab(root)).toBe(false);
    });

    test('a guild page with no trial cards is neither', () => {
        expect(isTrialsSetupTab(panelWith('<div class="GuildPanel_tile__a"><div>Treasury</div></div>'))).toBe(false);
        expect(isTrialsSetupTab(null)).toBe(false);
    });
});

describe('parseTrialTier', () => {
    test('reads a tier a card states', () => {
        expect(parseTrialTier('T6')).toBe(6);
        expect(parseTrialTier('840 pts T6')).toBe(6);
        expect(parseTrialTier('Tier 12')).toBe(12);
    });

    test('anything outside the ladder is not a tier', () => {
        expect(parseTrialTier('T0')).toBeNull();
        expect(parseTrialTier('T99')).toBeNull();
        expect(parseTrialTier('Lv.130')).toBeNull();
        expect(parseTrialTier('20m 53s')).toBeNull();
        expect(parseTrialTier(null)).toBeNull();
    });
});

describe('parseSignups', () => {
    test('reads the count whichever way round the card writes it', () => {
        expect(parseSignups('1/28 signed up')).toEqual({ signed: 1, total: 28 });
        expect(parseSignups('Signed Up 3/56')).toEqual({ signed: 3, total: 56 });
        expect(parseSignups('0/28 signed up')).toEqual({ signed: 0, total: 28 });
    });

    test('a ratio that does not say it is a sign-up count is not one', () => {
        // Which is the whole point: this exists so a sign-up ratio is never
        // sampled as a pool reading, and a pool reading is never read as sign-ups
        expect(parseSignups('18,850 / 65,280')).toBeNull();
        expect(parseSignups('signed up')).toBeNull();
    });
});

describe('parsePoints', () => {
    test('reads what a tier is worth off the card', () => {
        expect(parsePoints('600 pts')).toBe(600);
        expect(parsePoints('0 pts')).toBe(0);
        expect(parsePoints('1,200 points')).toBe(1200);
    });

    test('a number with no points on it is not a points figure', () => {
        expect(parsePoints('Lv.130')).toBeNull();
        expect(parsePoints('20m 53s')).toBeNull();
    });
});

describe('locale-grouped captures', () => {
    const asLocale = (value) => {
        localStorage.setItem('i18nextLng', value);
        _resetGameNumberSeparators();
    };

    /**
     * A tab built from lines of text, one element each.
     * @param {string[]} lines - What the tab says
     * @returns {Element} The root
     */
    function tab(lines) {
        document.body.innerHTML = `<div class="GuildPanel_guildPanel__r">${lines
            .map((line) => `<div>${line}</div>`)
            .join('')}</div>`;
        return document.querySelector('[class*="GuildPanel_guildPanel"]');
    }

    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    describe('en-US', () => {
        beforeEach(() => asLocale('en-US'));

        test('parseAmount reads comma grouping', () => expect(parseAmount('618,000')).toBe(618_000));

        test('parseBarReadings reads comma grouping', () => {
            expect(parseBarReadings('30,857 / 618,000')).toEqual([{ current: 30_857, max: 618_000 }]);
        });

        test('parseSignups reads comma grouping', () => {
            expect(parseSignups('1,028/2,800 signed up')).toEqual({ signed: 1028, total: 2800 });
        });

        test('readPersonalStats reads a comma-grouped value', () => {
            const stats = readPersonalStats(tab(['Total Rerolls', '1,234']));
            expect(stats['Total Rerolls']).toBe('1,234');
        });
    });

    describe('de-DE (period grouping) — the bug this replaces', () => {
        beforeEach(() => asLocale('de-DE'));

        test('parseAmount reads period grouping instead of stopping at the first group', () => {
            // A hardcoded `[\d,]*\.?\d+` reads "618.000" as decimal 618 point 000,
            // i.e. 618. The fix reads the period as this locale's group separator.
            expect(parseAmount('618.000')).toBe(618_000);
        });

        test('parseBarReadings reads period grouping', () => {
            expect(parseBarReadings('30.857 / 618.000')).toEqual([{ current: 30_857, max: 618_000 }]);
        });

        test('parseSignups reads period grouping — the named regression', () => {
            // A hardcoded `\d[\d,]*` captures "1.028/2.800" as "1/2": the period
            // is not in the class, so the match stops at the first group boundary.
            expect(parseSignups('1.028/2.800 signed up')).toEqual({ signed: 1028, total: 2800 });
        });

        test('readPersonalStats reads a period-grouped value', () => {
            const stats = readPersonalStats(tab(['Total Rerolls', '1.234']));
            expect(stats['Total Rerolls']).toBe('1.234');
        });

        test('findTrialsRoot still recognises a period-grouped bar reading', () => {
            const scope = document.createElement('div');
            const panel = document.createElement('div');
            panel.className = 'GuildPanel_root';
            panel.innerHTML = '<div>Alchemy 18.850 / 65.280</div>';
            scope.appendChild(panel);
            expect(findTrialsRoot(scope)).toBe(panel);
        });
    });
});
