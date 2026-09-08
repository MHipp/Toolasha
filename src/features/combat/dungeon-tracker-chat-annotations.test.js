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
    pendingDungeon: null,
    averageBaselines: {},
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
    default: { getCurrentRun: () => game.currentRun, getPendingDungeon: () => game.pendingDungeon },
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
        getAverageBaselines: async () => game.averageBaselines,
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

function averageOn(node) {
    return node.querySelector('.dungeon-timer-average')?.textContent.trim() ?? null;
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
    game.pendingDungeon = null;
    game.averageBaselines = {};

    annotations.cumulativeStatsByDungeon = {};
    annotations.storedRunDurations = {};
    annotations.averageBaselines = {};
    annotations.storedRunNumbers = {};
    annotations.annotatedChatRuns = {};
    annotations.chatRunsInCumulative = {};
    annotations.processedMessages.clear();
    annotations.lastSeenDungeonName = null;
    annotations._annotatedWithoutDungeonName = false;
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

    test('the dungeon the tracker is only armed for counts too', () => {
        // Page load arms the tracker and leaves restoring the run to the next
        // battle, so for up to a wave there is no currentRun to ask.
        game.pendingDungeon = { dungeonName: 'Sinister Circus', pending: true };
        expect(annotations.getDungeonNameWithFallback([keyEvent], 0)).toBe('Sinister Circus');
    });

    test('an unnamed pending dungeon does not count as an answer', () => {
        game.pendingDungeon = { dungeonName: 'Unknown', pending: true };
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

    test('a log annotated before anything could name the dungeon is redone once something can', async () => {
        // The window after a mid-run reload: "Battle started:" scrolled out of
        // chat long ago and the tracker holds no run until a battle verifies the
        // one it is restoring. That first pass names nothing, and because it
        // marks the messages processed the average would otherwise stay missing
        // for the rest of the session.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const first = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        const second = message('[08/04 10:04:00 AM]', 'Key counts: [Alice - 11]');
        message('[08/04 10:10:00 AM]', 'Key counts: [Alice - 10]');

        await annotations.annotateAllMessages();
        expect(labels()).toEqual(['[4m 0s]', '[6m 0s]']);
        warn.mockRestore();

        game.currentRun = { dungeonName: 'Chimerical Den' };
        await annotations.annotateAllMessages();

        expect(labelOn(first)).toBe('[Run #1: 4m 0s]');
        expect(labelOn(second)).toBe('[Run #2: 6m 0s]');
        expect(labels()).toEqual(['[Run #1: 4m 0s]', '[Average: 4m 0s]', '[Run #2: 6m 0s]', '[Average: 5m 0s]']);
        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].runCount).toBe(2);
    });

    test('the dungeon the tracker is merely armed for is enough to redo it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const first = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();
        warn.mockRestore();

        game.pendingDungeon = { dungeonName: 'Chimerical Den', pending: true };
        await annotations.annotateAllMessages();

        expect(labelOn(first)).toBe('[Run #1: 4m 32s]');
    });

    test('a log that stays unnameable is not redone on every pass', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const first = message('[08/04 10:00:00 AM]', 'Key counts: [Alice - 12]');
        message('[08/04 10:04:32 AM]', 'Key counts: [Alice - 11]');

        await annotations.annotateAllMessages();
        await annotations.annotateAllMessages();
        await annotations.annotateAllMessages();

        expect(labelOn(first)).toBe('[4m 32s]');
        expect(labels()).toEqual(['[4m 32s]']);
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

/**
 * The average printed beside each run used to be a lifetime one, and that is
 * exactly what made it useless after a build change: with 205 runs banked, a
 * run a minute faster moves the figure by a fifth of a second. These are the
 * two ways out — a trailing window, and a marker saying "start here" — and the
 * pin that says neither of them changes anything until it is asked for.
 */
describe('how far back the average reaches', () => {
    /** August 4, 12-hour with a meridiem, which is what the parser reads unambiguously. */
    function stampAt(date) {
        const pad = (value) => String(value).padStart(2, '0');
        const hours = date.getHours();
        const hour12 = hours % 12 === 0 ? 12 : hours % 12;
        return `[08/04 ${pad(hour12)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${hours < 12 ? 'AM' : 'PM'}]`;
    }

    /**
     * Lay `durations` out as consecutive key-count lines starting at `start`.
     * N durations need N+1 lines: a run is the gap between two of them.
     * @param {Date} start - When the first key count landed
     * @param {Array<number>} durations - Run lengths in ms
     * @returns {{nodes: Array<HTMLElement>, times: Array<Date>}} The lines and their stamps
     */
    function chatRuns(start, durations) {
        const times = [start];
        for (const duration of durations) times.push(new Date(times[times.length - 1].getTime() + duration));
        const nodes = times.map((at, index) => message(stampAt(at), `Key counts: [Alice - ${100 - index}]`));
        return { nodes, times };
    }

    // The maintainer's own log: nine runs after an ability change that cut the
    // real time from ~10m20s to ~9m15s.
    const RECENT = [584, 557, 580, 556, 542, 556, 565, 533, 526].map((seconds) => seconds * 1000);
    const OLD_DURATION = 620_000; // 10m 20s

    /**
     * 200 banked runs at 10m20s on the days before, then the nine recent ones
     * both in storage and on screen — which is what a backfilled log looks like.
     * @returns {{nodes: Array<HTMLElement>, times: Array<Date>}} The chat lines
     */
    function maintainersLog() {
        message('[08/04 08:59:00 AM]', 'Battle started: Chimerical Den');
        const laid = chatRuns(aug4(9, 0, 0), RECENT);

        const old = [];
        const firstOld = new Date(YEAR, 7, 2, 0, 0, 0).getTime();
        for (let i = 0; i < 200; i++) {
            old.push(
                storedRun({
                    timestamp: new Date(firstOld + i * 660_000).toISOString(),
                    duration: OLD_DURATION,
                })
            );
        }
        game.allRuns = [
            ...old,
            ...RECENT.map((duration, i) => storedRun({ timestamp: laid.times[i].toISOString(), duration })),
        ];
        return laid;
    }

    test('a window of 20 answers the real case; the lifetime average does not', async () => {
        game.settings.dungeonTrackerAverageWindow = 20;
        const { nodes } = maintainersLog();

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // The last annotated line is run 209 — the ninth recent run. Its window
        // is the nine recent runs (4999s) plus the eleven 10m20s runs before
        // them (6820s): 11819/20 = 590s. The lifetime figure is 617s, and that
        // is the number that would not move.
        expect(labelOn(nodes[8])).toBe('[Run #209: 8m 46s]');
        expect(averageOn(nodes[8])).toBe('[Avg last 20: 9m 50s]');
    });

    test('with the setting at its default the label is exactly what it has always been', async () => {
        const { nodes } = maintainersLog();

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // 128999s over 209 runs. The point of pinning it is that upgrading
        // changes nobody's chat until they ask for a window.
        expect(averageOn(nodes[8])).toBe('[Average: 10m 17s]');
        expect(averageOn(nodes[0])).toBe('[Average: 10m 17s]');
    });

    test('a marker excludes what came before it and keeps the run numbers', async () => {
        const durations = [600_000, 600_000, 300_000, 240_000];
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), durations);
        game.allRuns = durations.map((duration, i) => storedRun({ timestamp: times[i].toISOString(), duration }));
        // Marked between run 2 and run 3
        game.averageBaselines = { 'Alice::Chimerical Den': times[2].getTime() - 1 };

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // Runs 1 and 2 are behind the marker: numbered and timed as always, but
        // in no window, so no average line at all rather than a stale one
        expect(labelOn(nodes[0])).toBe('[Run #1: 10m 0s]');
        expect(averageOn(nodes[0])).toBeNull();
        expect(averageOn(nodes[1])).toBeNull();
        // The first run after the marker averages to itself
        expect(labelOn(nodes[2])).toBe('[Run #3: 5m 0s]');
        expect(averageOn(nodes[2])).toBe('[Avg last 1: 5m 0s]');
        expect(labelOn(nodes[3])).toBe('[Run #4: 4m 0s]');
        expect(averageOn(nodes[3])).toBe('[Avg last 2: 4m 30s]');
    });

    test('a marker floors a window that would otherwise reach past it', async () => {
        game.settings.dungeonTrackerAverageWindow = 20;
        const { nodes, times } = maintainersLog();
        // Marked just before the first recent run, so only those nine count
        game.averageBaselines = { 'Alice::Chimerical Den': times[0].getTime() - 1 };

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // 4999s over nine runs, not twenty — the window is a cap, not a quota
        expect(averageOn(nodes[8])).toBe('[Avg last 9: 9m 15s]');
        expect(labelOn(nodes[8])).toBe('[Run #209: 8m 46s]');
    });

    test('a windowed average still does not count a storage-matched run twice', async () => {
        // The invariant the running total has always had to keep: a chat run
        // that is also in storage is one run, not two. A window reads the same
        // merged list, so the check is that the figure is the plain mean.
        game.settings.dungeonTrackerAverageWindow = 20;
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), [600_000, 300_000]);
        game.allRuns = [
            storedRun({ timestamp: times[0].toISOString(), duration: 600_000 }),
            storedRun({ timestamp: times[1].toISOString(), duration: 300_000 }),
        ];

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        expect(averageOn(nodes[0])).toBe('[Avg last 1: 10m 0s]');
        expect(averageOn(nodes[1])).toBe('[Avg last 2: 7m 30s]');

        // A second pass must not move it either
        await annotations.annotateAllMessages();
        expect(averageOn(nodes[1])).toBe('[Avg last 2: 7m 30s]');
    });

    /** The colour the run timer on this line was given. */
    function colourOn(node) {
        return node.querySelector('.dungeon-timer-annotation')?.style.color ?? null;
    }

    /**
     * A log whose recent pace differs from its lifetime pace, both in storage
     * and on screen — the shape that makes the two averages disagree.
     * @param {number} oldDuration - What the banked runs before today took
     * @param {Array<number>} recent - Today's run lengths, in ms
     * @returns {{nodes: Array<HTMLElement>, times: Array<Date>}} The chat lines
     */
    function logWithPaceChange(oldDuration, recent) {
        message('[08/04 08:59:00 AM]', 'Battle started: Chimerical Den');
        const laid = chatRuns(aug4(9, 0, 0), recent);
        const old = [];
        const firstOld = new Date(YEAR, 7, 2, 0, 0, 0).getTime();
        for (let i = 0; i < 200; i++) {
            old.push(storedRun({ timestamp: new Date(firstOld + i * 660_000).toISOString(), duration: oldDuration }));
        }
        game.allRuns = [
            ...old,
            ...recent.map((duration, i) => storedRun({ timestamp: laid.times[i].toISOString(), duration })),
        ];
        return laid;
    }

    test('a window colours a run against the window, not the lifetime figure', async () => {
        game.settings.dungeonTrackerAverageWindow = 10;
        // 200 banked runs at 10m20s, then twenty of today's at 9m0s, then one
        // at 10m0s. Lifetime is 10m13s, so that last run reads faster than
        // ever; against the ten runs before it (9m0s) it is plainly slower.
        const { nodes } = logWithPaceChange(620_000, [...Array(20).fill(540_000), 600_000]);

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        expect(averageOn(nodes[20])).toBe('[Avg last 10: 9m 6s]');
        expect(colourOn(nodes[20])).toBe(asCss('#ff6b6b'));
    });

    test('and the converse: slower than the lifetime figure, faster than the window', async () => {
        game.settings.dungeonTrackerAverageWindow = 10;
        // The same shape upside down: the party got slower, so a 10m50s run is
        // worse than the 9m20s lifetime average and better than the 11m0s the
        // ten runs before it took.
        const { nodes } = logWithPaceChange(500_000, [...Array(20).fill(660_000), 650_000]);

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        expect(averageOn(nodes[20])).toBe('[Avg last 10: 10m 59s]');
        expect(colourOn(nodes[20])).toBe(asCss('#5fda5f'));
    });

    test('with the setting at its default the colours are exactly what they have always been', async () => {
        const { nodes } = maintainersLog();

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // Every recent run is faster than the 10m17s lifetime average, and with
        // no window in force that is still what decides the colour
        for (let i = 0; i < 9; i++) expect(colourOn(nodes[i])).toBe(asCss('#5fda5f'));
    });

    test('a line whose window covers nothing is neutral, not judged against zero', async () => {
        const durations = [600_000, 600_000, 300_000, 240_000];
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), durations);
        game.allRuns = durations.map((duration, i) => storedRun({ timestamp: times[i].toISOString(), duration }));
        game.averageBaselines = { 'Alice::Chimerical Den': times[2].getTime() - 1 };

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // Runs 1 and 2 are behind the marker: no average line, and so nothing
        // to be fast or slow against either
        expect(averageOn(nodes[0])).toBeNull();
        expect(colourOn(nodes[0])).toBe(asCss('#90ee90'));
        expect(colourOn(nodes[1])).toBe(asCss('#90ee90'));
        // The first line the marker lets through is judged again
        expect(colourOn(nodes[3])).toBe(asCss('#5fda5f'));
    });

    test('a marker on one dungeon leaves another dungeon alone', async () => {
        message('[08/04 09:59:00 AM]', 'Battle started: Sinister Circus');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), [600_000, 300_000]);
        game.allRuns = [
            storedRun({ timestamp: times[0].toISOString(), duration: 600_000, dungeonName: 'Sinister Circus' }),
            storedRun({ timestamp: times[1].toISOString(), duration: 300_000, dungeonName: 'Sinister Circus' }),
        ];
        game.averageBaselines = { 'Alice::Chimerical Den': Date.now() };

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        expect(averageOn(nodes[1])).toBe('[Average: 7m 30s]');
    });
});

/**
 * The bug the maintainer reported: two consecutive lines in party chat read
 * `Run #225` and then `Run #315`, with the trailing average collapsing from
 * `Avg last 20: 9m 20s` to `Avg last 20: 5m 9s` on a run that itself took
 * 9m 15s. A page refresh sat between the two lines.
 *
 * Both halves come from one place. A run labelled on one pass has its message
 * marked `data-processed`, so the next pass no longer extracts it — and the
 * pass used to keep its slot by writing the chat timestamp into
 * `storedRunNumbers`, the very map it later reads back as "the runs storage
 * knows about". From then on that run is in the merged list twice: once as the
 * tracker's own banked copy, and once as a phantom stored run with no entry in
 * `storedRunDurations` and so no duration at all. The phantoms inflate every
 * later run number, and the windowed average divided by a slot count that
 * counted them.
 */
describe('a run seen from both sides is still one run', () => {
    /** August 4, 12-hour with a meridiem — the stamp shape the parser reads unambiguously. */
    function stamp(date) {
        const pad = (value) => String(value).padStart(2, '0');
        const hours = date.getHours();
        const hour12 = hours % 12 === 0 ? 12 : hours % 12;
        return `[08/04 ${pad(hour12)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${hours < 12 ? 'AM' : 'PM'}]`;
    }

    /**
     * Lay out N+1 key-count lines for N runs of the given lengths.
     * @param {Date} start - When the first key count landed
     * @param {Array<number>} durations - Run lengths in ms
     * @returns {{nodes: Array<HTMLElement>, times: Array<Date>}} Lines and their stamps
     */
    function chatRuns(start, durations) {
        const times = [start];
        for (const duration of durations) times.push(new Date(times[times.length - 1].getTime() + duration));
        const nodes = times.map((at, index) => message(stamp(at), `Key counts: [Alice - ${400 - index}]`));
        return { nodes, times };
    }

    /**
     * What a page refresh does: every counter this session built is gone and
     * the chat is re-rendered from the server with nothing marked processed,
     * so the numbering is rebuilt from storage plus whatever chat still shows.
     * @returns {Promise<void>} When the rebuilt state has loaded
     */
    async function reload() {
        annotations.cleanup();
        document.body.innerHTML = '';
        annotations.storedRunDurations = {};
        annotations.annotatedChatRuns = {};
        await annotations.loadRunCountsFromStorage();
    }

    test('a run labelled on an earlier pass is not re-counted as a stored run', async () => {
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), [600_000, 300_000]);
        game.allRuns = [
            storedRun({ timestamp: times[0].toISOString(), duration: 600_000 }),
            storedRun({ timestamp: times[1].toISOString(), duration: 300_000 }),
        ];

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();
        expect(labelOn(nodes[0])).toBe('[Run #1: 10m 0s]');
        expect(labelOn(nodes[1])).toBe('[Run #2: 5m 0s]');

        // A third run lands: chat gets its lines, the tracker banks it. It is
        // run 3, not run 5 — the two labelled runs are not phantoms as well.
        const third = message(stamp(times[2]), 'Key counts: [Alice - 397]');
        message(stamp(new Date(times[2].getTime() + 240_000)), 'Key counts: [Alice - 396]');
        game.allRuns.push(storedRun({ timestamp: times[2].toISOString(), duration: 240_000 }));

        await annotations.annotateAllMessages();

        expect(labelOn(third)).toBe('[Run #3: 4m 0s]');
    });

    test('run numbers survive a refresh', async () => {
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const durations = [600_000, 600_000, 300_000];
        const { times } = chatRuns(aug4(10, 0, 0), durations);
        // The tracker banks the server's own millisecond stamp for the same
        // key count the chat line shows truncated to the second, so the two
        // sides of one run never hold the identical number
        game.allRuns = durations.map((duration, i) =>
            storedRun({ timestamp: new Date(times[i].getTime() + 431).toISOString(), duration })
        );

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();

        // A fourth run arrives live: one pass per message, the way chat does it
        const fourth = message(stamp(times[3]), 'Key counts: [Alice - 396]');
        await annotations.annotateAllMessages();
        message(stamp(new Date(times[3].getTime() + 240_000)), 'Key counts: [Alice - 395]');
        game.allRuns.push(
            storedRun({ timestamp: new Date(times[3].getTime() + 431).toISOString(), duration: 240_000 })
        );
        await annotations.annotateAllMessages();

        expect(labelOn(fourth)).toBe('[Run #4: 4m 0s]');

        // Refresh: same storage, same chat, so the same numbers
        await reload();
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const relaid = chatRuns(aug4(10, 0, 0), [...durations, 240_000]);
        await annotations.annotateAllMessages();

        expect(labelOn(relaid.nodes[3])).toBe('[Run #4: 4m 0s]');
    });

    test('a run labelled before it was banked is in the lifetime average exactly once', async () => {
        // Storage learns about a run only after the pass that labelled it -
        // the tracker banks it a moment later, at the server's own millisecond
        // stamp for the same key count the chat line shows truncated.
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), [600_000, 300_000]);

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();
        expect(averageOn(nodes[1])).toBe('[Average: 7m 30s]');

        game.allRuns = [
            storedRun({ timestamp: new Date(times[0].getTime() + 431).toISOString(), duration: 600_000 }),
            storedRun({ timestamp: new Date(times[1].getTime() + 431).toISOString(), duration: 300_000 }),
        ];
        await annotations.refreshRunCounts();

        // Both sources now hold both runs; the average is still of two runs
        expect(averageOn(nodes[1])).toBe('[Average: 7m 30s]');
        expect(annotations.cumulativeStatsByDungeon['Alice::Chimerical Den'].runCount).toBe(2);
    });

    test('a labelled run nothing banked still counts once the lines scroll away', async () => {
        // Party chat keeps only the last hundred or so lines. Two runs are
        // labelled; nothing banks them (the tracker was not watching); their
        // lines scroll off; then a backfill rebuilds the counters from storage.
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(10, 0, 0), [600_000, 600_000]);

        await annotations.loadRunCountsFromStorage();
        await annotations.annotateAllMessages();
        expect(averageOn(nodes[1])).toBe('[Average: 10m 0s]');

        for (const node of nodes) node.remove();
        message('[08/04 09:59:00 AM]', 'Battle started: Chimerical Den');
        const third = message(stamp(times[2]), 'Key counts: [Alice - 397]');
        message(stamp(new Date(times[2].getTime() + 300_000)), 'Key counts: [Alice - 396]');

        await annotations.refreshRunCounts();

        // Three runs at 10m, 10m and 5m: 8m 20s. Reading 5m 0s would mean the
        // two the pass remembers well enough to number were dropped from the
        // total the moment it was rebuilt.
        expect(labelOn(third)).toBe('[Run #3: 5m 0s]');
        expect(averageOn(third)).toBe('[Average: 8m 20s]');
    });

    test('a run whose duration is unknown is left out of the average, not counted as zero', async () => {
        // The reported shape: a window of twenty over eleven real 9m15s runs
        // and nine runs nothing knows the length of. The answer is 9m 15s —
        // the average of what is known — not the 5m 9s that dividing the same
        // total by twenty gives.
        game.settings.dungeonTrackerAverageWindow = 20;
        message('[08/04 08:59:00 AM]', 'Battle started: Chimerical Den');
        const { nodes, times } = chatRuns(aug4(9, 0, 0), Array(11).fill(555_000));
        game.allRuns = times.slice(0, 11).map((at) => storedRun({ timestamp: at.toISOString(), duration: 555_000 }));

        await annotations.loadRunCountsFromStorage();
        // Nine older runs whose length nothing knows. The loader drops a run
        // with no duration outright, so they are seeded the way a phantom
        // reached the merge: a number slot with no duration beside it.
        for (let i = 1; i <= 9; i++) {
            annotations.storedRunNumbers['Alice::Chimerical Den'][aug4(9, 0, 0).getTime() - i * 600_000] = 0;
        }

        await annotations.annotateAllMessages();

        expect(labelOn(nodes[10])).toBe('[Run #20: 9m 15s]');
        expect(averageOn(nodes[10])).toBe('[Avg last 11: 9m 15s]');
    });

    test('a window with nothing usable in it reports no average rather than zero', () => {
        const merged = [
            { ts: 1000, isChatRun: false, duration: null },
            { ts: 2000, isChatRun: true, duration: null },
        ];

        expect(annotations.buildWindowedAverages(merged, 2, 0).get(2000)).toEqual({ average: 0, covered: 0 });
    });
});
