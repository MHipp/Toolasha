/** @vitest-environment happy-dom */

/**
 * The guild roster, over a faked tracker.
 *
 * Two claims here are the ones a guild would act on, so they are the ones worth
 * pinning down. A contribution share must be of the XP actually *observed* —
 * counting a member nobody has two readings for as a zero would put a newly
 * tracked player in the same list as one who quit. And "gone quiet" must be each
 * member against their own week, not against a fixed rate, or every casual
 * player is permanently flagged and the list stops being read.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const csvExport = vi.hoisted(() => ({ downloads: [] }));
vi.mock('../../utils/csv-export.js', async (importOriginal) => ({
    ...(await importOriginal()),
    downloadCsv: (filename, csv) => {
        csvExport.downloads.push({ filename, csv });
        return true;
    },
}));

const tracker = vi.hoisted(() => ({
    guildName: 'Milky Way',
    series: {},
    members: [],
    guildSeries: [],
    level: { level: 42, currentXP: 1_000_000, nextLevelXP: 1_200_000, xpToNext: 200_000 },
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => true } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: (definition) => tracker.rows.push(definition) }));
vi.mock('./guild-member-skills.js', () => ({
    default: {
        progress: () => tracker.cycler,
        nextBattleUnit: () => tracker.unit ?? null,
        anyBattleUnits: () => tracker.anyUnits ?? false,
        openNextUnit: () => {
            tracker.openedUnits.push(tracker.unit?.name ?? null);
            return tracker.unitResult ?? { opened: null, how: 'no-unit' };
        },
        openNextProfile: () => {
            tracker.opened.push(tracker.cycler.next?.name ?? null);
            return tracker.cyclerResult;
        },
        redoAll: () => {
            tracker.redone += 1;
            return tracker.cycler.logged;
        },
    },
}));
vi.mock('./guild-loadout-capture.js', () => ({
    default: {
        initialize: async () => {},
        // Counted, not merely guarded: the roster is one of two owners, and
        // `guild-roster-view.capture-ownership.test.js` is where the count
        // itself is pinned down against the real module
        cleanup: () => {},
        seen: () => [],
        onCaptured: (listener) => {
            tracker.capturedListeners.push(listener);
            return () => {
                const index = tracker.capturedListeners.indexOf(listener);
                if (index !== -1) tracker.capturedListeners.splice(index, 1);
            };
        },
    },
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => tracker.guildName,
        getAllMemberSeries: () => tracker.series,
        getMemberList: () => tracker.members,
        getGuildSeries: () => tracker.guildSeries,
        getGuildLevelProgress: () => tracker.level,
    },
}));

tracker.rows = [];
tracker.capturedListeners = [];
tracker.cycler = { logged: 0, total: 0, next: null, stale: 0 };
tracker.cyclerResult = { opened: null, how: 'done' };
tracker.opened = [];
tracker.redone = 0;
tracker.unit = null;
tracker.unitResult = null;
tracker.openedUnits = [];

const rosterModule = await import('./guild-roster-view.js');
const {
    filterSeenToRoster,
    filterRosterRows,
    drawProfileCycler,
    drawSeenLoadouts,
    seriesDelta,
    ratePerHour,
    isGoneQuiet,
    contributionShares,
    projectGuildXP,
    buildRoster,
    memberLabel,
    guildRosterPanel,
    registerGuildRosterRow,
    resetRosterFilter,
    rosterCsvRows,
    ROSTER_CSV_COLUMNS,
    WINDOW_7D,
} = rosterModule;
const guildRosterFeature = rosterModule.default;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A member's samples: `xp` at each of `hoursAgo`.
 * @param {Array<[number, number]>} points - `[hoursAgo, xp]`
 * @returns {Array<{t: number, xp: number}>} Oldest first
 */
const series = (points) => points.map(([hoursAgo, xp]) => ({ t: now - hoursAgo * HOUR, xp })).sort((a, b) => a.t - b.t);

describe('the profile cycler', () => {
    beforeEach(() => {
        tracker.opened = [];
        tracker.redone = 0;
        tracker.cycler = { logged: 2, total: 8, next: { name: 'Ada' }, stale: 0 };
        tracker.cyclerResult = { opened: 'Ada', how: 'row' };
        tracker.unit = null;
        tracker.unitResult = null;
        tracker.openedUnits = [];
        tracker.anyUnits = false;
        document.body.innerHTML = '';
    });

    test('a fight on screen gets its own battle-info button, separate from profiles', () => {
        // A profile carries skills but no combat sheet, so the two
        // collections are separate tools — one button must never silently
        // stand in for the other
        tracker.unit = { name: 'Bo', el: document.createElement('div') };
        tracker.unitResult = { opened: 'Bo', how: 'unit' };
        const body = document.createElement('div');
        drawProfileCycler(body);

        const battle = body.querySelector('.mwi-battleinfo-cycler');
        const profile = body.querySelector('.mwi-profile-cycler');
        expect(battle.textContent).toContain('Bo’s battle info');
        expect(profile.textContent).toContain('Ada’s profile');

        battle.click();
        expect(tracker.openedUnits).toEqual(['Bo']);
        expect(tracker.opened).toEqual([]);
        expect(body.textContent).toContain('Waiting for Bo’s battle info');
    });

    test('no fight on screen means no battle-info button at all', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);
        expect(body.querySelector('.mwi-battleinfo-cycler')).toBeNull();
        expect(body.textContent).not.toContain('fresh combat sheet');
    });

    test('a fight where everyone is fresh says so instead of hiding the button', () => {
        // All four fighters clicked minutes ago: no unit is due, but a
        // silently absent button reads as broken
        tracker.unit = null;
        tracker.anyUnits = true;
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('.mwi-battleinfo-cycler')).toBeNull();
        expect(body.textContent).toContain('Everyone in the fight has a fresh combat sheet');
    });

    test('shows how far along the roster it is, and who is next', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.textContent).toContain('logged 2/8');
        expect(body.querySelector('button').textContent).toContain('Ada');
    });

    test('one click opens one profile', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);
        body.querySelector('button').click();

        // One click, one profile — nothing loops
        expect(tracker.opened).toEqual(['Ada']);
    });

    test('when the chat command is the only way in, it says to press Enter', () => {
        tracker.cyclerResult = { opened: 'Ada', how: 'chat' };
        const body = document.createElement('div');
        drawProfileCycler(body);
        const button = body.querySelector('button');
        button.click();

        // The button says what it did; the status line says what to do next
        expect(button.textContent).toContain('Asked for Ada');
        expect(body.textContent).toContain('Press Enter in chat');
    });

    test('a hidden chat is said plainly rather than swallowed', () => {
        // The reported failure: chat was hidden, the fill went nowhere, and the
        // cycler moved on regardless
        tracker.cyclerResult = { opened: 'Ada', how: 'no-chat' };
        const body = document.createElement('div');
        drawProfileCycler(body);
        body.querySelector('button').click();

        expect(body.textContent).toContain('Open the chat panel first');
        // And the member is still the one being offered
        expect(body.querySelector('button').textContent).toContain('Ada');
    });

    test('a profile still in flight is shown as waiting, not as done', () => {
        tracker.cycler = { logged: 2, total: 8, next: null, pending: { name: 'Ada' }, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.textContent).toContain('Waiting for Ada');
        expect(body.textContent).toContain('logged 2/8');
    });

    test('redo marks everyone due again without asking for anything', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);

        const redo = body.querySelector('.mwi-profile-redo');
        expect(redo.textContent).toContain('Redo all 2');

        redo.click();

        expect(tracker.redone).toBe(1);
        // Redo changes who is due; it never opens a profile
        expect(tracker.opened).toEqual([]);
    });

    test('with nothing captured there is nothing to redo', () => {
        tracker.cycler = { logged: 0, total: 8, next: { name: 'Ada' }, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('.mwi-profile-redo')).toBeNull();
    });

    test('a fully logged roster has nothing to click', () => {
        tracker.cycler = { logged: 8, total: 8, next: null, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('button').disabled).toBe(true);
        expect(body.textContent).toContain('Every member logged');
    });

    test('stale captures are counted so they can be refreshed', () => {
        tracker.cycler = { logged: 8, total: 8, next: { name: 'Bo' }, stale: 3 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.textContent).toContain('3 captures older than a week');
    });

    test('no roster is a note rather than a dead button', () => {
        tracker.cycler = { logged: 0, total: 0, next: null, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('button')).toBeNull();
        expect(body.textContent).toContain('No roster yet');
    });
});

describe('seriesDelta', () => {
    test('measures what was gained inside the window, and over how long', () => {
        const measured = seriesDelta(
            series([
                [48, 1000],
                [24, 2000],
                [1, 3000],
            ]),
            WINDOW_7D,
            now
        );

        expect(measured.delta).toBe(2000);
        expect(measured.spanMs).toBe(47 * HOUR);
    });

    test('ignores samples outside the window', () => {
        const measured = seriesDelta(
            series([
                [200, 1000],
                [2, 5000],
                [1, 5500],
            ]),
            DAY,
            now
        );

        expect(measured.delta).toBe(500);
    });

    test('one sample in the window is not a measurement', () => {
        expect(seriesDelta(series([[1, 100]]), DAY, now)).toBeNull();
        expect(
            seriesDelta(
                series([
                    [200, 100],
                    [1, 500],
                ]),
                DAY,
                now
            )
        ).toBeNull();
    });
});

describe('ratePerHour', () => {
    test('is the gain over the span it was gained in', () => {
        const rate = ratePerHour(
            series([
                [10, 0],
                [0, 5000],
            ]),
            WINDOW_7D,
            now
        );
        expect(rate).toBe(500);
    });
});

describe('isGoneQuiet', () => {
    test('flags a rate that has collapsed against the member’s own week', () => {
        expect(isGoneQuiet(10, 1000)).toBe(true);
        expect(isGoneQuiet(null, 1000)).toBe(true);
    });

    test('leaves a steady member alone, however slow', () => {
        expect(isGoneQuiet(900, 1000)).toBe(false);
        // A member who was barely earning all week has no collapse to detect
        expect(isGoneQuiet(0, 0.5)).toBe(false);
    });
});

describe('filterRosterRows', () => {
    const members = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'AliceInTraining' }];

    test('blank text is not searching — everyone shows', () => {
        expect(filterRosterRows(members, '')).toBe(members);
        expect(filterRosterRows(members, '   ')).toEqual(members);
    });

    test('matches a case-insensitive substring anywhere in the name', () => {
        expect(filterRosterRows(members, 'ali').map((member) => member.name)).toEqual(['Alice', 'AliceInTraining']);
        expect(filterRosterRows(members, 'BOB').map((member) => member.name)).toEqual(['Bob']);
    });

    test('no match is an empty list, not the whole roster', () => {
        expect(filterRosterRows(members, 'zzz')).toEqual([]);
    });
});

describe('contributionShares', () => {
    test('shares are of the total actually earned', () => {
        expect(contributionShares([{ delta: 300 }, { delta: 100 }])).toEqual([75, 25]);
    });

    test('an unmeasured member neither takes a share nor breaks the sum', () => {
        const shares = contributionShares([{ delta: 300 }, { delta: null }, { delta: 100 }]);
        expect(shares).toEqual([75, 0, 25]);
    });

    test('nothing earned is not a division by zero', () => {
        expect(contributionShares([{ delta: 0 }, { delta: 0 }])).toEqual([0, 0]);
    });
});

describe('projectGuildXP', () => {
    test('carries the current rate forward', () => {
        expect(projectGuildXP(1000, 10, 24)).toBe(1240);
    });

    test('declines to project without a rate', () => {
        expect(projectGuildXP(1000, 0, 24)).toBeNull();
        expect(projectGuildXP(1000, null, 24)).toBeNull();
    });
});

describe('buildRoster', () => {
    test('ranks by this week’s share and flags who has stopped', () => {
        const roster = buildRoster({
            now,
            meta: { a: { name: 'Alice' }, b: { name: 'Bob' }, c: { name: 'Carol' } },
            series: {
                // Steady all week
                a: series([
                    [160, 0],
                    [24, 6000],
                    [1, 6500],
                ]),
                // Earned a lot, then stopped two days ago
                b: series([
                    [160, 0],
                    [48, 9000],
                    [1, 9000],
                ]),
                // Only ever seen once
                c: series([[1, 100_000]]),
            },
        });

        expect(roster.map((member) => member.name)).toEqual(['Bob', 'Alice', 'Carol']);
        expect(roster[0].share7d).toBeCloseTo(58.06, 1);
        expect(roster[0].quiet).toBe(true);
        expect(roster[1].quiet).toBe(false);
        // Never measured: no share, and no claim that they earned nothing
        expect(roster[2].delta7d).toBeNull();
        expect(roster[2].share7d).toBe(0);
    });
});

describe('rosterCsvRows', () => {
    test('carries raw numbers, not the panel’s rounded percentages', () => {
        const [row] = rosterCsvRows([
            { name: 'Alice', samples: 12, delta7d: 6543.6, share7d: 58.061, delta30d: 9000, share30d: 42.857 },
        ]);
        expect(row.delta7d).toBe(6544);
        expect(row.share7d).toBe(58.1);
        expect(row.delta30d).toBe(9000);
        expect(row.share30d).toBe(42.9);
    });

    test('a member with nothing measured is a blank cell, not a zero', () => {
        const [row] = rosterCsvRows([{ name: 'Carol', samples: 1, delta7d: null, share7d: 0 }]);
        expect(row.delta7d).toBeNull();
        expect(row.share7d).toBe(0);
    });

    test('an unnamed member gets the same placeholder the panel shows', () => {
        const [row] = rosterCsvRows([{ name: null, samples: 1 }]);
        expect(row.name).toBe('Unnamed member');
    });
});

describe('a member who has left the guild', () => {
    // Reported live from a 107-member guild: "Gone quiet (2)" listed
    // "#9349 · —/h today vs 348/h this week" — somebody who left, still holding
    // last week's rate, doing nothing today because they were gone, and headed
    // with an internal id because they had been dropped from the member list
    const departed = {
        now,
        meta: { a: { name: 'Alice' } },
        series: {
            a: series([
                [160, 0],
                [24, 6000],
                [1, 6500],
            ]),
            9349: series([
                [160, 0],
                [48, 9000],
                [1, 9000],
            ]),
        },
    };

    test('is not on the roster at all, however much history they left behind', () => {
        const roster = buildRoster(departed);

        expect(roster.map((member) => member.characterID)).toEqual(['a']);
        expect(roster.some((member) => member.quiet)).toBe(false);
    });

    test('and does not count towards anybody’s share', () => {
        // Their nine thousand XP was diluting everyone else's contribution
        const roster = buildRoster(departed);
        expect(roster[0].share7d).toBeCloseTo(100, 6);
    });

    test('an empty member list is “not known yet”, not “nobody is here”', () => {
        // Before any roster message has arrived, the history stands in — which
        // is what it did before, and losing the whole panel would be worse
        const roster = buildRoster({ ...departed, meta: {} });
        expect(roster).toHaveLength(2);
    });

    test('a member with no name is said to have none, never numbered', () => {
        const roster = buildRoster({ now, meta: { 9349: {} }, series: { 9349: series([[1, 10]]) } });

        expect(roster[0].name).toBeNull();
        expect(memberLabel(roster[0])).toBe('Unnamed member');
        expect(memberLabel(roster[0])).not.toContain('9349');
    });
});

describe('the panel and tile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        tracker.rows = [];
        tracker.cycler = { logged: 0, total: 0, next: null, stale: 0 };
        tracker.cyclerResult = { opened: null, how: 'done' };
        tracker.opened = [];
        tracker.redone = 0;
        tracker.unit = null;
        tracker.unitResult = null;
        tracker.openedUnits = [];
        tracker.anyUnits = false;
        tracker.members = [
            { characterID: 'a', name: 'Alice' },
            { characterID: 'b', name: 'Bob' },
        ];
        tracker.series = {
            a: series([
                [160, 0],
                [24, 6000],
                [1, 6500],
            ]),
            b: series([
                [160, 0],
                [48, 9000],
                [1, 9000],
            ]),
        };
        tracker.guildSeries = series([
            [160, 0],
            [1, 15_500],
        ]);
    });

    afterEach(() => {
        guildRosterPanel.hide({ remember: false });
        vi.useRealTimers();
        resetRosterFilter();
    });

    test('draws every section', () => {
        guildRosterPanel.show({ remember: false });
        const text = guildRosterPanel.panel.textContent;

        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Milky Way');
        expect(text).toContain('Alice');
        expect(text).toContain('Bob');
        expect(text).toContain('Gone quiet (1)');
        expect(text).toContain('Projected in 7d');
    });

    test('a departed member is drawn nowhere, not even in Gone quiet', () => {
        // The live report: "Gone quiet (2)" listing "#9349 · —/h today vs 348/h
        // this week" — a member who had left, still holding last week's rate
        tracker.series = {
            ...tracker.series,
            9349: series([
                [160, 0],
                [48, 9000],
                [1, 9000],
            ]),
        };
        guildRosterPanel.show({ remember: false });
        const text = guildRosterPanel.panel.textContent;

        expect(text).not.toContain('9349');
        // Bob is the one genuinely quiet member, and the count is his alone
        expect(text).toContain('Gone quiet (1)');
        expect(text).toContain('Contribution (2 of 2 measured)');
    });

    test('the contribution card can export its rows as CSV', () => {
        csvExport.downloads = [];
        guildRosterPanel.show({ remember: false });

        const button = [...guildRosterPanel.panel.querySelectorAll('button')].find(
            (candidate) => candidate.textContent === 'Export CSV'
        );
        expect(button).toBeTruthy();
        button.click();

        expect(csvExport.downloads).toHaveLength(1);
        const { csv } = csvExport.downloads[0];
        expect(csv.split('\r\n')[0]).toBe(ROSTER_CSV_COLUMNS.map((column) => column.label).join(','));
        expect(csv).toContain('Alice');
        expect(csv).toContain('Bob');
    });

    test('nothing to export means no button, not a button over an empty table', () => {
        tracker.series = { a: series([[1, 100]]), b: series([[1, 200]]) };
        guildRosterPanel.show({ remember: false });

        const button = [...guildRosterPanel.panel.querySelectorAll('button')].find(
            (candidate) => candidate.textContent === 'Export CSV'
        );
        expect(button).toBeUndefined();
    });

    test('says so plainly when there is no guild yet', () => {
        tracker.guildName = null;
        guildRosterPanel.show({ remember: false });
        expect(guildRosterPanel.panel.textContent).toContain('No guild data yet');
        tracker.guildName = 'Milky Way';
    });

    test('the tile names the top contributor and counts the quiet', () => {
        registerGuildRosterRow();
        const [tile] = tracker.rows;
        expect(tile.key).toBe('guildRoster');

        const container = document.createElement('div');
        tile.render(container);

        expect(container.textContent).toContain('Bob');
        expect(container.textContent).toContain('1 quiet');
        expect(typeof tile.onOpen).toBe('function');
    });

    test('a member with no captured name is withheld on the tile too, never printed as null', () => {
        // Before the first roster message the member list is empty and the
        // history stands in, so every row's name is null. The panel already said
        // "Unnamed member"; the tile read `top.name` straight through and drew
        // `null produced 58.1% of the guild XP observed this week` beside it.
        tracker.members = [];
        registerGuildRosterRow();
        const [tile] = tracker.rows;

        const container = document.createElement('div');
        tile.render(container);

        expect(container.textContent).toContain('Unnamed member');
        expect(container.textContent).not.toContain('null');
        expect(container.title).toContain('Unnamed member');
        expect(container.title).not.toContain('null');
    });
});

describe('a captured loadout redraws the panel at once', () => {
    beforeEach(() => {
        tracker.capturedListeners = [];
        tracker.rows = [];
    });

    afterEach(() => {
        guildRosterFeature.cleanup();
    });

    test('the feature subscribes, the event renders, and cleanup unsubscribes', async () => {
        await guildRosterFeature.initialize();
        expect(tracker.capturedListeners).toHaveLength(1);

        // The defect: the Battle Info cycler sat waiting on the panel's 3s
        // refresh tick after a sheet had already landed
        const render = vi.spyOn(guildRosterPanel, 'render').mockImplementation(() => {});
        for (const listener of tracker.capturedListeners) {
            listener({ name: 'Bo', source: 'battle_unit_fetched', abilitiesAuthoritative: true, at: now });
        }
        expect(render).toHaveBeenCalledTimes(1);
        render.mockRestore();

        guildRosterFeature.cleanup();
        expect(tracker.capturedListeners).toHaveLength(0);
    });
});

describe('seen loadouts', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    /** @returns {HTMLElement} A panel body to draw into */
    const body = () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        return el;
    };

    test('every line leads with when the sheet was seen', () => {
        const host = body();
        drawSeenLoadouts(
            host,
            [
                {
                    name: 'Tib',
                    level: 150,
                    at: now - 2 * HOUR,
                    source: 'battle_unit_fetched',
                    rows: [{ label: 'Armor', value: '62' }],
                    abilities: [{ label: 'Fireball', level: 40 }],
                },
            ],
            now,
            // An explicit empty roster: what this test is about is the line,
            // not the guild filter
            []
        );

        expect(host.textContent).toContain('Tib Lv.150');
        expect(host.textContent).toMatch(/seen /);
        expect(host.textContent).not.toContain('could not be drawn');
    });

    test('nothing seen names the gesture that would produce something', () => {
        const host = body();
        drawSeenLoadouts(host, [], now);

        expect(host.textContent).toContain('No stat sheets seen yet');
        expect(host.textContent).toContain('In Progress');
    });

    test('a reading with no abilities in it says so rather than implying none are equipped', () => {
        const host = body();
        drawSeenLoadouts(host, [{ name: 'Moo', at: now, source: 'popup', rows: [], abilities: [] }], now, []);

        expect(host.querySelector('[title]').title).toContain('not carried by this reading');
    });

    test('a captured level is shown to one decimal, not floating-point garbage', () => {
        // "BOOB Lv.151.60000000000002" reached the screen: the captured combat
        // level is a weighted average and arrives as floating point
        const host = body();
        drawSeenLoadouts(
            host,
            [{ name: 'BOOB', level: 151.60000000000002, at: now, source: 'popup', rows: [], abilities: [] }],
            now,
            []
        );

        expect(host.textContent).toContain('BOOB Lv.151.6');
        expect(host.textContent).not.toContain('151.60000000000002');
    });

    test('sightings from outside the roster are hidden and counted, never deleted', () => {
        // The reported leak: Cream and ICMeow from the guild this character
        // left, listed beside the new guild's fighters
        const host = body();
        drawSeenLoadouts(
            host,
            [
                { name: 'Rick', at: now, source: 'popup', rows: [], abilities: [] },
                { name: 'Cream', at: now, source: 'popup', rows: [], abilities: [] },
            ],
            now,
            ['Rick', 'NPD']
        );

        expect(host.textContent).toContain('Seen loadouts (1)');
        expect(host.textContent).toContain('Rick');
        expect(host.textContent).not.toContain('Cream');
        expect(host.textContent).toContain('1 sighting from outside this guild’s roster');
    });

    test('no roster known keeps everything — unknown is not “not a member”', () => {
        const { kept, hidden } = filterSeenToRoster([{ name: 'Cream' }], []);
        expect(kept).toHaveLength(1);
        expect(hidden).toBe(0);

        const filtered = filterSeenToRoster([{ name: 'Rick' }, { name: 'Cream' }, { name: 'ICMeow' }], ['rick', 'NPD']);
        expect(filtered.kept.map((player) => player.name)).toEqual(['Rick']);
        expect(filtered.hidden).toBe(2);
    });
});
