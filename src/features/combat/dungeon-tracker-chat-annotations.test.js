/**
 * @vitest-environment happy-dom
 *
 * The timer labels the tracker writes into party chat.
 *
 * Everything here starts from message text: a run is the gap between two
 * consecutive "Key counts:" lines, and which dungeon it was, who was in it and
 * what number it is are all reconstructed from lines above it. So the tests are
 * written the way the feature reads — build the chat log, run the pass, read
 * the labels back out — with storage mocked so the run-numbering merge (stored
 * history plus what is visible on screen) can be set up exactly.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const game = vi.hoisted(() => ({
    settings: { dungeonTrackerChatAnnotations: true },
    featureEnabled: true,
    allRuns: [],
    currentRun: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_PROFIT: '#5fda5f',
        COLOR_LOSS: '#ff6b6b',
        getSetting: (key) => game.settings[key] ?? false,
        isFeatureEnabled: () => game.featureEnabled,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {} },
}));

vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));

vi.mock('./dungeon-tracker.js', () => ({
    default: { getCurrentRun: () => game.currentRun },
}));

// The real markAsProfileLink lives in chat-profile-link.js with its own tests;
// here a stand-in that decorates the way it does (class + data attribute) shows
// the key-count names are run through it without dragging the chat feature in.
const markAsProfileLinkMock = vi.hoisted(() =>
    vi.fn((el, name) => {
        el.classList.add('mwi-chat-profile-name');
        el.dataset.mwiProfileName = name;
        return true;
    })
);
vi.mock('../chat/chat-profile-link.js', () => ({ markAsProfileLink: markAsProfileLinkMock }));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        scrubOutlierRuns: async () => 0,
        getAllRuns: async () => game.allRuns,
        getTeamKey: (names) => [...names].sort().join(','),
        saveTeamRun: vi.fn(async () => true),
    },
}));

const annotations = (await import('./dungeon-tracker-chat-annotations.js')).default;

const YEAR = new Date().getFullYear();
/** August 4 of the current year, which is what a "[08/04 …]" stamp parses to. */
const aug4 = (h, m, s) => new Date(YEAR, 7, 4, h, m, s, 0);

/**
 * Build the two-span shape a game chat message has: stamp, then body.
 * @param {string} stamp - e.g. '[08/04 10:00:00 AM]'
 * @param {string} body - e.g. 'Key counts: [Alice - 12]'
 * @param {{username?: string}} [options]
 * @returns {HTMLElement}
 */
function message(stamp, body, { username } = {}) {
    const node = document.createElement('div');
    node.className = 'ChatMessage_chatMessage__abc';
    if (username) {
        const name = document.createElement('span');
        name.className = 'ChatMessage_username__x';
        name.textContent = username;
        node.appendChild(name);
    }
    const stampSpan = document.createElement('span');
    stampSpan.textContent = stamp + ' ';
    const bodySpan = document.createElement('span');
    bodySpan.textContent = body;
    node.appendChild(stampSpan);
    node.appendChild(bodySpan);
    document.body.appendChild(node);
    return node;
}

/** Every timer/average label currently on screen, in document order. */
function labels() {
    return [...document.querySelectorAll('.dungeon-timer-annotation, .dungeon-timer-average')].map((el) =>
        el.textContent.trim()
    );
}

function labelOn(node) {
    return node.querySelector('.dungeon-timer-annotation')?.textContent.trim() ?? null;
}

/** What a hex colour looks like once a style declaration has had it. */
function asCss(hex) {
    const probe = document.createElement('div');
    probe.style.color = hex;
    return probe.style.color;
}

/** A stored run in the unified format loadRunCountsFromStorage reads. */
function storedRun({ timestamp, duration, teamKey = 'Alice', dungeonName = 'Chimerical Den', recordedBy = 'me' }) {
    return { timestamp, duration, teamKey, dungeonName, recordedBy, team: teamKey.split(',') };
}

beforeEach(() => {
    document.body.innerHTML = '';
    game.settings = { dungeonTrackerChatAnnotations: true };
    game.featureEnabled = true;
    game.allRuns = [];
    game.currentRun = null;

    annotations.cumulativeStatsByDungeon = {};
    annotations.storedRunNumbers = {};
    annotations.processedMessages.clear();
    annotations.lastSeenDungeonName = null;
    annotations.enabled = true;
    annotations.initComplete = true;
    annotations.timerRegistry.clearAll();
    markAsProfileLinkMock.mockClear();
});

describe('reading a timestamp off a message', () => {
    test('American, twelve-hour, afternoon', () => {
        const node = message('[08/04 01:05:09 PM]', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toEqual(aug4(13, 5, 9));
    });

    test('American, twelve-hour, midnight rolls back to zero', () => {
        const node = message('[08/04 12:30:00 AM]', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toEqual(aug4(0, 30, 0));
    });

    test('American, noon stays at twelve', () => {
        const node = message('[08/04 12:30:00 PM]', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toEqual(aug4(12, 30, 0));
    });

    test('a slash date whose first part cannot be a month is read the other way round', () => {
        const node = message('[16/07 10:00:00]', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toEqual(new Date(YEAR, 6, 16, 10, 0, 0, 0));
    });

    test('international dash format is day first', () => {
        const node = message('[04-8 22:15:30]', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toEqual(aug4(22, 15, 30));
    });

    test('European dot format is day first too', () => {
        const node = message('[4.8. 22:15:30]', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toEqual(aug4(22, 15, 30));
    });

    test('no stamp at all is null', () => {
        const node = message('', 'Key counts: [Alice - 1]');
        expect(annotations.getTimestampFromMessage(node)).toBeNull();
    });

    test('a malformed stamp is null, and says so when asked to', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const node = message('[not a time]', 'Key counts: [Alice - 1]');

        expect(annotations.getTimestampFromMessage(node, true)).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('reading the team off a message', () => {
    test('names come back sorted, counts ignored', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Zoe - 3], [Alice - 12], [Bob - 1,234]');
        expect(annotations.getTeamFromMessage(node)).toEqual(['Alice', 'Bob', 'Zoe']);
    });

    test('a solo run is a team of one', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        expect(annotations.getTeamFromMessage(node)).toEqual(['Alice']);
    });

    test('nothing bracketed is nobody', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts:');
        expect(annotations.getTeamFromMessage(node)).toEqual([]);
    });

    describe('locale-grouped counts', () => {
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
            const node = message('[08/04 10:00:00 AM]', 'Key counts: [Bob - 1,234]');
            expect(annotations.getTeamFromMessage(node)).toEqual(['Bob']);
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]+` fails the whole bracket in a period-grouping
            // locale, which drops the player name along with the count.
            asLocale('de-DE');
            const node = message('[08/04 10:00:00 AM]', 'Key counts: [Bob - 1.234]');
            expect(annotations.getTeamFromMessage(node)).toEqual(['Bob']);
        });
    });
});

describe('finding the party chat tab button', () => {
    test('a hash-suffixed tab container is still found, like the message selector', () => {
        // The game's CSS-module hashes drift release to release (e.g.
        // ChatMessage_chatMessage__abc today, something else tomorrow); every
        // other selector in this file matches on `[class*="Prefix_stem"]` for
        // exactly that reason. The tab container selector must too, rather than
        // pinning today's exact hash.
        const container = document.createElement('div');
        container.className = 'Chat_tabsComponentContainer__someOtherHash';
        const button = document.createElement('button');
        button.className = 'MuiButtonBase-root';
        button.textContent = 'Party';
        container.appendChild(button);
        document.body.appendChild(container);

        annotations.observeTabSwitches();

        button.click();
        expect(annotations.tabClickHandlers.has(button)).toBe(true);
    });
});

describe('sorting chat into events', () => {
    test('each kind of line becomes its own kind of event', () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:05 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:00 AM]', 'Party failed on wave 7');
        message('[08/04 10:05:00 AM]', 'Battle ended: Chimerical Den');

        const events = annotations.extractChatEvents();

        expect(events.map((e) => e.type)).toEqual(['battle_start', 'key', 'fail', 'cancel']);
        expect(events[0].dungeonName).toBe('Chimerical Den');
        expect(events[1].team).toEqual(['Alice']);
        expect(events[1].timestamp).toEqual(aug4(10, 0, 5));
    });

    test('a battle start caches its dungeon name for later messages', () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Sinister Circus');
        annotations.extractChatEvents();
        expect(annotations.lastSeenDungeonName).toBe('Sinister Circus');
    });

    test('a key count with no readable stamp is dropped', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        message('', 'Key counts: [Alice - 12]');
        expect(annotations.extractChatEvents()).toEqual([]);
        warn.mockRestore();
    });

    test('a key count with nobody in it is dropped', () => {
        message('[08/04 10:00:05 AM]', 'Key counts:');
        expect(annotations.extractChatEvents()).toEqual([]);
    });

    test('an already-annotated message is not extracted twice', () => {
        const node = message('[08/04 10:00:05 AM]', 'Key counts: [Alice - 12]');
        node.dataset.processed = '1';
        expect(annotations.extractChatEvents()).toEqual([]);
    });

    test('ordinary chatter is not an event', () => {
        message('[08/04 10:00:00 AM]', 'nice run everyone');
        expect(annotations.extractChatEvents()).toEqual([]);
    });

    test('a player quoting "Key counts:" does not forge a run boundary', () => {
        // A player typing the system phrase carries a name element the real
        // system line never does — that, not the words, is what tells them apart.
        message('[08/04 10:00:05 AM]', 'Key counts: [Alice - 12]', { username: 'Bob' });
        expect(annotations.extractChatEvents()).toEqual([]);
    });

    test('a player quoting "Battle started:" does not forge a session boundary', () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den', { username: 'Bob' });
        expect(annotations.extractChatEvents()).toEqual([]);
    });
});

describe('clickable names on a key counts line', () => {
    test('each bracketed name becomes a profile link, and the text reads unchanged', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Zoe - 3], [Alice - 12], [Bob - 1,234]');
        const before = node.textContent;

        annotations.extractChatEvents();

        const links = [...node.querySelectorAll('a.mwi-chat-profile-name')];
        expect(links.map((a) => a.textContent)).toEqual(['Zoe', 'Alice', 'Bob']);
        expect(links.map((a) => a.dataset.mwiProfileName)).toEqual(['Zoe', 'Alice', 'Bob']);
        expect(node.textContent).toBe(before);
    });

    test('the team reads the same before and after decoration', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Zoe - 3], [Alice - 12]');
        annotations.extractChatEvents();
        expect(annotations.getTeamFromMessage(node)).toEqual(['Alice', 'Zoe']);
    });

    test('running the pass again does not wrap a name twice', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');

        annotations.extractChatEvents();
        annotations.extractChatEvents();

        expect(node.querySelectorAll('a.mwi-chat-profile-name')).toHaveLength(1);
    });

    test('a name the decorator declines stays plain text', () => {
        // What markAsProfileLink does with the setting off, or a bad name
        markAsProfileLinkMock.mockReturnValue(false);
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        const before = node.textContent;

        annotations.extractChatEvents();

        expect(node.querySelector('a')).toBeNull();
        expect(node.textContent).toBe(before);
        markAsProfileLinkMock.mockImplementation((el, name) => {
            el.classList.add('mwi-chat-profile-name');
            el.dataset.mwiProfileName = name;
            return true;
        });
    });

    test('the timer annotation still lands beside a decorated message', async () => {
        // The names are wrapped in <a> elements, not spans, precisely so
        // insertAnnotation's "second span is the body" addressing holds
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const first = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labelOn(first)).toBe('[Run #1: 4m 32s]');
        expect(first.querySelectorAll('a.mwi-chat-profile-name')).toHaveLength(1);
    });
});

describe('deciding which dungeon a run was', () => {
    const keyEvent = { type: 'key', timestamp: aug4(10, 0, 0), team: ['Alice'] };

    test('the nearest battle start above it wins', () => {
        const events = [
            { type: 'battle_start', dungeonName: 'Sinister Circus', timestamp: aug4(9, 0, 0) },
            { type: 'battle_start', dungeonName: 'Chimerical Den', timestamp: aug4(9, 30, 0) },
            keyEvent,
        ];
        expect(annotations.getDungeonNameWithFallback(events, 2)).toBe('Chimerical Den');
    });

    test('a battle start below it does not count', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const events = [keyEvent, { type: 'battle_start', dungeonName: 'Chimerical Den', timestamp: aug4(11, 0, 0) }];
        game.currentRun = null;
        expect(annotations.getDungeonNameWithFallback(events, 0)).toBe('Unknown');
        warn.mockRestore();
    });

    test('with nothing in chat, the run under way is asked', () => {
        game.currentRun = { dungeonName: 'Enchanted Fortress' };
        expect(annotations.getDungeonNameWithFallback([keyEvent], 0)).toBe('Enchanted Fortress');
    });

    test('an unnamed run under way does not count as an answer', () => {
        game.currentRun = { dungeonName: 'Unknown' };
        annotations.lastSeenDungeonName = 'Pirate Cove';
        expect(annotations.getDungeonNameWithFallback([keyEvent], 0)).toBe('Pirate Cove');
    });

    test('and failing that, whatever was last seen scrolling past', () => {
        annotations.lastSeenDungeonName = 'Chimerical Den';
        expect(annotations.getDungeonNameWithFallback([keyEvent], 0)).toBe('Chimerical Den');
    });

    test('with no source at all it is Unknown', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(annotations.getDungeonNameWithFallback([keyEvent], 0)).toBe('Unknown');
        warn.mockRestore();
    });
});

describe('stats from what is on screen', () => {
    const start = (h, m) => ({ type: 'battle_start', dungeonName: 'Chimerical Den', timestamp: aug4(h, m, 0) });
    const key = (h, m, s = 0, team = ['Alice']) => ({ type: 'key', timestamp: aug4(h, m, s), team });

    test('consecutive key counts are runs, and the numbers are theirs', () => {
        const events = [start(10, 0), key(10, 0), key(10, 5), key(10, 12)];

        const stats = annotations.calculateStatsFromEvents(events);

        expect(stats['Alice::Chimerical Den']).toEqual({
            totalRuns: 2,
            avgTime: 360_000, // (5m + 7m) / 2
            fastestTime: 300_000,
            slowestTime: 420_000,
        });
    });

    test('a failure after a key count is not a run, and neither is what follows it', () => {
        // A fail breaks the chain both ways: the run it ended is discarded, and
        // the key count after it has nothing to pair with.
        const events = [start(10, 0), key(10, 0), { type: 'fail', timestamp: aug4(10, 3, 0) }, key(10, 5)];
        expect(annotations.calculateStatsFromEvents(events)).toEqual({});
    });

    test('a battle start between two key counts ends the session, pairing nothing across it', () => {
        const events = [start(10, 0), key(10, 0), start(11, 0), key(11, 5)];
        expect(annotations.calculateStatsFromEvents(events)).toEqual({});
    });

    test('teams are counted separately, and a run belongs to the team that started it', () => {
        // Bob joining partway through does not move the run he finished onto
        // his own record: the pair is attributed to the earlier key count's team.
        const events = [
            start(10, 0),
            key(10, 0, 0, ['Alice']),
            key(10, 5, 0, ['Alice']),
            key(10, 12, 0, ['Alice', 'Bob']),
            key(10, 20, 0, ['Alice', 'Bob']),
        ];

        const stats = annotations.calculateStatsFromEvents(events);

        expect(stats['Alice::Chimerical Den']).toMatchObject({ totalRuns: 2, slowestTime: 420_000 });
        expect(stats['Alice,Bob::Chimerical Den']).toMatchObject({ totalRuns: 1, avgTime: 480_000 });
    });

    test('a run over midnight is not negative', () => {
        const events = [
            { type: 'battle_start', dungeonName: 'Chimerical Den', timestamp: new Date(YEAR, 7, 4, 23, 0, 0) },
            { type: 'key', timestamp: new Date(YEAR, 7, 4, 23, 59, 0), team: ['Alice'] },
            { type: 'key', timestamp: new Date(YEAR, 7, 4, 0, 1, 0), team: ['Alice'] },
        ];
        expect(annotations.calculateStatsFromEvents(events)['Alice::Chimerical Den'].avgTime).toBe(120_000);
    });

    test('runs whose dungeon is unknown are left out', () => {
        game.currentRun = null;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(annotations.calculateStatsFromEvents([key(10, 0), key(10, 5)])).toEqual({});
        warn.mockRestore();
    });

    test('nothing on screen is no stats', () => {
        expect(annotations.calculateStatsFromEvents([])).toEqual({});
    });
});

describe('the label itself', () => {
    test('minutes and seconds, rounded down', () => {
        expect(annotations.formatTime(272_000)).toBe('4m 32s');
        expect(annotations.formatTime(5999)).toBe('0m 5s');
        expect(annotations.formatTime(0)).toBe('0m 0s');
        expect(annotations.formatTime(3_600_000)).toBe('60m 0s');
    });

    test('an annotation is only added once, however often the pass runs', () => {
        const node = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        annotations.insertAnnotation('Run #1: 4m 32s', '#90ee90', node, false);
        annotations.insertAnnotation('Run #1: 4m 32s', '#90ee90', node, false);
        expect(node.querySelectorAll('.dungeon-timer-annotation')).toHaveLength(1);
    });

    test('a message without the two-span shape is left alone', () => {
        const node = document.createElement('div');
        node.className = 'ChatMessage_chatMessage__abc';
        node.appendChild(document.createElement('span'));
        document.body.appendChild(node);

        annotations.insertAnnotation('Run #1: 4m 32s', '#90ee90', node, false);

        expect(node.querySelector('.dungeon-timer-annotation')).toBeNull();
    });
});

describe('seeding from stored history', () => {
    test('runs are numbered oldest first, per team and dungeon', async () => {
        game.allRuns = [
            storedRun({ timestamp: aug4(11, 0, 0).toISOString(), duration: 300_000 }),
            storedRun({ timestamp: aug4(9, 0, 0).toISOString(), duration: 200_000 }),
            storedRun({ timestamp: aug4(10, 0, 0).toISOString(), duration: 400_000 }),
        ];

        await annotations.loadRunCountsFromStorage();

        const numbers = annotations.storedRunNumbers['Alice::Chimerical Den'];
        expect(numbers[aug4(9, 0, 0).getTime()]).toBe(1);
        expect(numbers[aug4(10, 0, 0).getTime()]).toBe(2);
        expect(numbers[aug4(11, 0, 0).getTime()]).toBe(3);

        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den']).toEqual({
            runCount: 3,
            totalTime: 900_000,
            fastestTime: 200_000,
            slowestTime: 400_000,
        });
    });

    test('every character’s runs count, not just the one logged in', async () => {
        // getAllRuns is unfiltered on purpose: a team's history is the team's,
        // whichever of your characters happened to be in the party that night.
        game.allRuns = [
            storedRun({ timestamp: aug4(9, 0, 0).toISOString(), duration: 300_000, recordedBy: 'market123' }),
            storedRun({ timestamp: aug4(10, 0, 0).toISOString(), duration: 300_000, recordedBy: 'iron456' }),
        ];

        await annotations.loadRunCountsFromStorage();

        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].runCount).toBe(2);
    });

    test('teams and dungeons keep their own sequences', async () => {
        game.allRuns = [
            storedRun({ timestamp: aug4(9, 0, 0).toISOString(), duration: 300_000, teamKey: 'Alice,Bob' }),
            storedRun({
                timestamp: aug4(9, 30, 0).toISOString(),
                duration: 300_000,
                teamKey: 'Alice,Bob',
                dungeonName: 'Sinister Circus',
            }),
        ];

        await annotations.loadRunCountsFromStorage();

        expect(Object.keys(annotations.storedRunNumbers).sort()).toEqual([
            'Alice,Bob::Chimerical Den',
            'Alice,Bob::Sinister Circus',
        ]);
        expect(annotations.cumulativeStatsByDungeon['Alice,Bob::Chimerical Den'].runCount).toBe(1);
    });

    test('runs missing a team, a dungeon or a duration are skipped', async () => {
        game.allRuns = [
            { timestamp: aug4(9, 0, 0).toISOString(), duration: 300_000, dungeonName: 'Chimerical Den' },
            { timestamp: aug4(9, 5, 0).toISOString(), duration: 300_000, teamKey: 'Alice' },
            storedRun({ timestamp: aug4(9, 10, 0).toISOString(), duration: 0 }),
            storedRun({ timestamp: aug4(9, 15, 0).toISOString(), duration: 300_000 }),
        ];

        await annotations.loadRunCountsFromStorage();

        expect(Object.keys(annotations.storedRunNumbers)).toEqual(['Alice::Chimerical Den']);
        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].runCount).toBe(1);
    });

    test('a run recorded under the older totalTime field still counts', async () => {
        game.allRuns = [
            {
                timestamp: aug4(9, 0, 0).toISOString(),
                totalTime: 240_000,
                teamKey: 'Alice',
                dungeonName: 'Chimerical Den',
            },
        ];

        await annotations.loadRunCountsFromStorage();

        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den']).toMatchObject({
            runCount: 1,
            totalTime: 240_000,
        });
    });

    test('a storage failure still lets the pass go ahead', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.allRuns = null; // for..of over null throws inside the loader

        await annotations.loadRunCountsFromStorage();

        expect(error).toHaveBeenCalled();
        expect(annotations.initComplete).toBe(true);
        error.mockRestore();
    });
});

describe('annotating a chat log', () => {
    test('a pair of key counts gets a numbered timer and a running average', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const first = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labelOn(first)).toBe('[Run #1: 4m 32s]');
        expect(labels()).toEqual(['[Run #1: 4m 32s]', '[Average: 4m 32s]']);
        expect(first.dataset.processed).toBe('1');
    });

    test('the average is of every run so far, not the last one', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]'); // run 1: 4m
        message('[08/04 10:04:00 AM]', 'Key counts: [Alice - 11]'); // run 2: 6m
        message('[08/04 10:10:00 AM]', 'Key counts: [Alice - 10]');

        await annotations.annotateAllMessages();

        expect(labels()).toEqual(['[Run #1: 4m 0s]', '[Average: 4m 0s]', '[Run #2: 6m 0s]', '[Average: 5m 0s]']);
    });

    test('a run faster than the average is green, a slower one red', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]'); // 4m, no history yet
        message('[08/04 10:04:00 AM]', 'Key counts: [Alice - 11]'); // 6m, slower than the 4m average
        const third = message('[08/04 10:10:00 AM]', 'Key counts: [Alice - 10]'); // 2m, faster than 5m
        message('[08/04 10:12:00 AM]', 'Key counts: [Alice - 9]');

        await annotations.annotateAllMessages();

        const timers = [...document.querySelectorAll('.dungeon-timer-annotation')];
        expect(timers[0].style.color).toBe(asCss('#90ee90')); // no history — neutral
        expect(timers[1].style.color).toBe(asCss('#ff6b6b')); // slower than average
        expect(labelOn(third)).toBe('[Run #3: 2m 0s]');
        expect(timers[2].style.color).toBe(asCss('#5fda5f')); // faster than average
    });

    test('a failed run says so, and gets no number or average', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:03:00 AM]', 'Party failed on wave 7');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBe('[FAILED]');
        expect(labels()).toEqual(['[FAILED]']);
    });

    test('a canceled run says so', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:03:00 AM]', 'Battle ended: Chimerical Den');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBe('[canceled]');
    });

    test('leaving the party mid-run reads as canceled once the next battle starts', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:30:00 AM]', 'Battle started: Chimerical Den');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBe('[canceled]');
    });

    test('a key count with nothing after it is left unlabelled', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBeNull();
        expect(key.dataset.processed).toBeUndefined();
    });

    test('stored runs the chat cannot see still take their place in the numbering', async () => {
        game.allRuns = [
            storedRun({ timestamp: aug4(8, 0, 0).toISOString(), duration: 300_000 }),
            storedRun({ timestamp: aug4(9, 0, 0).toISOString(), duration: 300_000 }),
        ];
        await annotations.loadRunCountsFromStorage();

        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBe('[Run #3: 4m 32s]');
    });

    test('a chat run that matches a stored run is not counted twice', async () => {
        // Same run, seen from both sides: within ten seconds it is one run, so
        // the average must not take its time in a second time.
        game.allRuns = [storedRun({ timestamp: aug4(10, 0, 2).toISOString(), duration: 272_000 })];
        await annotations.loadRunCountsFromStorage();

        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBe('[Run #1: 4m 32s]');
        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].runCount).toBe(1);
        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].totalTime).toBe(272_000);
    });

    test('running the pass again does not renumber or re-average anything', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();
        await annotations.annotateAllMessages();
        await annotations.annotateAllMessages();

        expect(labels()).toEqual(['[Run #1: 4m 32s]', '[Average: 4m 32s]']);
        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].runCount).toBe(1);
    });

    test('each team’s runs are numbered on their own', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        const solo = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:00 AM]', 'Key counts: [Alice - 11]');
        const duo = message('[08/04 10:10:00 AM]', 'Key counts: [Alice - 10], [Bob - 4]');
        message('[08/04 10:15:00 AM]', 'Key counts: [Alice - 9], [Bob - 3]');

        await annotations.annotateAllMessages();

        expect(labelOn(solo)).toBe('[Run #1: 4m 0s]');
        expect(labelOn(duo)).toBe('[Run #1: 5m 0s]');
        expect(Object.keys(annotations.cumulativeStatsByDungeon).sort()).toEqual([
            'Alice,Bob::Chimerical Den',
            'Alice::Chimerical Den',
        ]);
    });

    test('a run whose dungeon is unknown gets a bare timer and no number', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const key = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labelOn(key)).toBe('[4m 32s]');
        expect(labels()).toEqual(['[4m 32s]']); // no average without a dungeon to average over
        warn.mockRestore();
    });

    test('the setting for these labels turns them off on its own', async () => {
        game.settings.dungeonTrackerChatAnnotations = false;
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labels()).toEqual([]);
    });

    test('turning the tracker off turns them off too', async () => {
        game.featureEnabled = false;
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();

        expect(labels()).toEqual([]);
    });

    test('disable() stops the pass without touching the setting', async () => {
        annotations.disable();
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();
        expect(labels()).toEqual([]);
        expect(annotations.isEnabled()).toBe(false);

        annotations.enable();
        expect(annotations.isEnabled()).toBe(true);
    });
});

describe('cleaning up on a character switch', () => {
    test('labels come off and every counter goes back to nothing', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');
        await annotations.annotateAllMessages();
        expect(labels()).toHaveLength(2);

        annotations.cleanup();

        expect(labels()).toEqual([]);
        expect(annotations.cumulativeStatsByDungeon).toEqual({});
        expect(annotations.storedRunNumbers).toEqual({});
        expect(annotations.processedMessages.size).toBe(0);
        expect(annotations.lastSeenDungeonName).toBeNull();
        expect(annotations.initComplete).toBe(false);
        expect(document.querySelector('[data-processed="1"]')).toBeNull();
    });

    test('after a cleanup the same log annotates from scratch', async () => {
        message('[08/04 10:00:00 AM]', 'Battle started: Chimerical Den');
        message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');
        await annotations.annotateAllMessages();

        annotations.cleanup();
        annotations.initComplete = true;
        await annotations.annotateAllMessages();

        expect(labels()).toEqual(['[Run #1: 4m 32s]', '[Average: 4m 32s]']);
    });
});
