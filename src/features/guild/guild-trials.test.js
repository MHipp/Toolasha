/** @vitest-environment happy-dom */

/**
 * The trial panel, over a faked game.
 *
 * Driven the way `guild-credit-value.test.js` is driven: build the markup the
 * game renders, let the feature's DOM observer callback fire, read the injected
 * block back out. The clock is driven rather than allowed to run, because a rate
 * needs two readings and waiting five real seconds for the second one turns a
 * millisecond test into a five-second one.
 *
 * What is worth asserting here, rather than in the math tests: that the panel
 * survives a card it does not understand, that it says "measuring" instead of
 * inventing a rate off one reading, and that an unknown building bonus reaches
 * the screen as a caption rather than as a silently-zero multiplier.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: { guildTrialsInfo: true },
    /** Listeners registered through `config.onSettingChange`, by key */
    settingListeners: {},
    settingValues: {},
    clientData: {},
    prices: {},
    buildingLevels: {},
    store: {},
    /** key → promise a `storage.tryGet` of it waits on */
    holds: {},
    observers: {},
    wsHandlers: {},
    guildName: 'Milky Way',
    currentWeek: '2026-07-31T00:00:00Z',
    members: [],
    characterId: null,
    characterData: null,
    dmHandlers: {},
    trialNames: [],
    alerts: { status: [], payouts: [], reset: 0, started: 0, stopped: 0 },
    recorder: { recording: false, activity: [], lifecycle: [], downloads: [], startedBy: null, endedBy: null },
    scoreboardToggles: 0,
    breakdown: {},
    scoreboardContext: null,
    skilling: {},
    skillingEnded: {},
    skillingResets: 0,
    traceStatus: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.settingValues ? game.settingValues[key] : fallback),
        onSettingChange: (key, callback) => {
            (game.settingListeners[key] ||= []).push(callback);
            return () => {
                game.settingListeners[key] = (game.settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));

/**
 * Flip a setting the way `config.setSetting` does: the value changes and
 * everyone watching that key hears about it.
 * @param {string} key - Setting key
 * @param {*} value - Its new value
 */
function flipSetting(key, value) {
    game.settings[key] = value;
    for (const callback of game.settingListeners[key] || []) callback(value);
}
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        // The feature watches several class names now, because the trials tab's
        // own container class is unverified — so the mock has to accept a list
        onClass: (id, classNames, callback) => {
            const names = Array.isArray(classNames) ? classNames : [classNames];
            for (const name of names) game.observers[name] = callback;
            return () => {
                for (const name of names) delete game.observers[name];
            };
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get guildBuildingLevelMap() {
            return game.buildingLevels;
        },
        getInitClientData: () => game.clientData,
        getCurrentCharacterId: () => game.characterId,
        get characterData() {
            return game.characterData;
        },
        on: (event, handler) => {
            (game.dmHandlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            game.dmHandlers[event] = (game.dmHandlers[event] || []).filter((entry) => entry !== handler);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        tryGet: async (key) => {
            // A read a test can hold open, for the switch-mid-read cases
            if (game.holds?.[key]) await game.holds[key];
            if (game.unavailable) return null;
            return key in game.store
                ? { found: true, value: structuredClone(game.store[key]) }
                : { found: false, value: null };
        },
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
        // Panel geometry, reached when a test opens the abilities panel
        getJSON: async (_key, _store, fallback = null) => fallback,
        setJSON: async () => true,
        delete: async (key) => {
            delete game.store[key];
            return true;
        },
        getAllKeys: async () => Object.keys(game.store),
    },
}));
// Token payouts are valued through the credit exchange, which prices items —
// mocked here so the real marketplace client is never pulled into this file
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, { mode } = {}) => game.prices[itemHrid]?.[mode] ?? 0,
    getItemPriceInfo: (itemHrid, { mode } = {}) => {
        const price = game.prices[itemHrid]?.[mode] ?? 0;
        return { price, source: price > 0 ? 'book' : null, estimated: false };
    },
}));
// `encounterOf` is a pure name-matcher and the feature now routes the spectated
// pool through it, so the real one is kept rather than stubbed
vi.mock('./guild-trial-damage.js', async (importOriginal) => ({
    ...(await importOriginal()),
    default: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        reset: vi.fn(),
        setTrialNames: (names) => (game.trialNames = names),
        breakdown: () => ({ measured: false, reason: 'no trial fight seen yet', players: [], ...game.breakdown }),
    },
}));
vi.mock('./guild-trial-recorder.js', () => ({
    default: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        setGuildName: vi.fn(),
        forget: () => {
            game.recorder.recording = false;
            game.recorder.forgotten = true;
        },
        noteActivity: (kind) => game.recorder.activity.push(kind),
        noteLifecycle: (phase) => game.recorder.lifecycle.push(phase),
        start: (reason) => {
            game.recorder.recording = true;
            game.recorder.startedBy = reason;
        },
        stop: (reason) => {
            game.recorder.recording = false;
            game.recorder.endedBy = reason;
        },
        get recording() {
            return game.recorder.recording;
        },
        // The finished-trial readout reads the split off the recorder's
        // persisted session — the open one first, the stored one otherwise
        get session() {
            return game.recorder.session ?? null;
        },
        loadSession: async () => game.recorder.session ?? null,
    },
    buildTrialExport: async () => game.recorder.bundle ?? { exportedAt: 'now', bundle: true },
    downloadTrialExport: (bundle) => {
        game.recorder.downloads.push(bundle);
        // Undefined unless a test says otherwise, so the default is "it worked".
        // Strictly undefined, because null is the real failure signal
        return game.recorder.downloadName === undefined
            ? 'toolasha-trial-2026-08-30T00-00-00-000Z.json'
            : game.recorder.downloadName;
    },
    trialExportIsEmpty: (bundle) => !bundle?.session && !Object.keys(bundle?.record?.tiles || {}).length,
}));
vi.mock('../notifications/guild-trial-alerts.js', () => ({
    default: {
        initialize: () => (game.alerts.started += 1),
        cleanup: () => (game.alerts.stopped += 1),
        noteTrialStatus: (status) => game.alerts.status.push(status),
        notePayout: (payout) => game.alerts.payouts.push(payout),
        reset: () => (game.alerts.reset += 1),
    },
}));
vi.mock('./guild-trial-skilling.js', () => ({
    default: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        // A real reset wipes `updates`/`ended`; this fake holds them on the
        // shared `game` object, so a reset here clears exactly what the real
        // one would — the cache a stale character or guild left behind
        reset: () => {
            game.skillingResets += 1;
            game.skilling = {};
            game.skillingEnded = {};
        },
        forTrial: (name) => game.skilling[String(name).toLowerCase()] || null,
        endedFor: (name) => game.skillingEnded[String(name).toLowerCase()] || null,
        participating: (name, id) => {
            const ids = game.skilling[String(name).toLowerCase()]?.participantIds;
            return Array.isArray(ids) ? ids.includes(Number(id)) : null;
        },
        snapshot: () => ({ updates: game.skilling, ended: game.skillingEnded }),
    },
}));
vi.mock('./guild-trial-scoreboard.js', () => ({
    default: {
        toggle: () => (game.scoreboardToggles += 1),
        close: vi.fn(),
        noteForecast: vi.fn(),
        noteContext: (context) => (game.scoreboardContext = context),
    },
}));
// Real wording, driven status: `describeTraceStatus` is what the Trace button's
// tooltip carries, and the singleton behind it otherwise reads a live stream
vi.mock('./guild-trial-trace.js', async (importOriginal) => ({
    ...(await importOriginal()),
    default: { status: () => game.traceStatus, initialize: () => {}, cleanup: () => {}, exportTrace: async () => {} },
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => game.guildName,
        getCurrentWeekStartAt: () => game.currentWeek,
        getMemberList: () => game.members,
        getMemberMeta: (id) => game.members.find((member) => member.characterID === id) || null,
    },
}));

const {
    analyseTrial,
    blockNearAnchor,
    breakdownFor,
    fightSidecarColumn,
    fightSidecarPlacement,
    fightSidecarStyle,
    gridColumnCount,
    guildTrials,
    lastTrialPlayerRows,
    mergeWaveTiles,
    ownParticipation,
    participantCounts,
    placeTrialBlock,
    renderTrialBlock,
    renderTrialPlayers,
    signedUpMembers,
    tokenPayoutLine,
    withScrollKept,
} = await import('./guild-trials.js');
const trialsFeature = (await import('./guild-trials.js')).default;
const { registeredCommands, resetCommands } = await import('../../utils/command-registry.js');
// Real, not mocked: the Abilities button feeds it, and the guard under test is
// about what the button must NOT feed it after the fight is torn down
const guildTrialAbilities = (await import('./guild-trial-abilities.js')).default;

// Real, not mocked: the leak under test is in whether this module's own cache
// is reset on a guild/character switch, which a mock would paper over
const guildTrialStatsModal = (await import('./guild-trial-stats-modal.js')).default;

// Real, not mocked: what is under test is whether this feature's teardown
// reaches the sub-module its initialize() started, and a mock is exactly the
// thing that would report a call without proving the listener went away
const guildMemberSkills = (await import('./guild-member-skills.js')).default;

const { NOTICE_BOARD_NAME } = await import('./guild-notice-board.fixture.js');
const { forecastTrial } = await import('./guild-trial-forecast.js');
const { tierTimingAsForecast, tierTimingForecast } = await import('./guild-trial-tier-timing.js');
const { badgeText } = await import('./guild-trial-tier-badge.js');
const { trialWeekStart } = await import('./guild-trials-math.js');
const { saveTrialRecord, tilePersonalStats } = await import('./guild-trials-store.js');

const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * Put the feature's singleton back to what a page load hands it.
 *
 * `cleanup()` deliberately keeps most of this — disabling the feature from the
 * settings and enabling it again must not lose the week's record, the guild the
 * record is keyed by, or the save cadence — and `initialize()` recomputes only
 * some of it. That is right in the browser, where the alternative to `cleanup()`
 * is a reload; in one test process it means the previous test decides this one.
 *
 * Three of these have been caught doing exactly that: `lastRecordSaveAt` left a
 * few seconds in the past throttles the save this test is about into never
 * happening; `awaitingCharacter` left `true` by a switch test makes
 * `_resolveGuildName()` answer null forever, so no guild name is ever adopted;
 * and a `record` left in hand is read as this test's own.
 */
function resetTrialsSingleton() {
    guildTrials.record = null;
    guildTrials.recordUnread = false;
    guildTrials.rereading = false;
    guildTrials.lastRecordSaveAt = 0;
    guildTrials.guildName = null;
    guildTrials.socketGuildName = null;
    guildTrials.characterId = null;
    guildTrials.awaitingCharacter = false;
    guildTrials.adopting = false;
    guildTrials.currentTrials = null;
    guildTrials.socketPhase = null;
    guildTrials.phase = null;
    guildTrials.lastForecast = null;
    guildTrials.workBases = {};
    guildTrials.watchedPool = null;
    guildTrials.contextRank = 0;
    guildTrials.lastTickAt = 0;
    guildTrials.lastSession = null;
    guildTrials.lastSessionChecked = false;
    guildTrials.blockHtml.clear();
}

/**
 * The hoisted `game` object stands in for every module this file mocks, and the
 * describes below only put back the fields they set themselves. `breakdown` is
 * the spectator stream's last word, and a pool left in it is fresh-dated
 * against whatever `now` the next test sets: the Trials-tab describe, which
 * asserts a barless combat card is never sampled, read a previous describe's
 * Chameleon pool as its own live reading. Put the whole of it back before every
 * test — a describe that wants one sets it in its own hook, which runs after
 * this one.
 */
beforeEach(() => {
    game.breakdown = {};
    game.scoreboardContext = null;
    game.skilling = {};
    game.skillingEnded = {};
    game.traceStatus = null;
});

/**
 * A stored tile record.
 * @param {Object} overrides - Fields to override
 * @returns {Object} Record
 */
function record(overrides = {}) {
    return {
        name: 'Trial Chameleon',
        kind: 'combat',
        level: 140,
        tier: 5,
        // A trial that has banked something: the card's points are what say a
        // badge counts finished tiers rather than the one in progress
        pointsByTier: { 5: 1200 },
        samples: [],
        tiers: [],
        ...overrides,
    };
}

describe('analyseTrial', () => {
    test('a combat trial reads its DPS off the falling bar', () => {
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
                tiers: [{ tier: 5, total: 618_000 }],
            }),
            { participants: 21, timeLeftMs: 30 * 60_000 }
        );

        expect(analysis.kind).toBe('combat');
        expect(analysis.rate).toBeCloseTo(10, 9); // 100,000 damage over 10s
        expect(analysis.remaining).toBe(518_000);
        expect(analysis.etaMs).toBeCloseTo(51_800, 6);
        // The badge counts what is banked; the tier being fought is one past it
        expect(analysis.tiersClearedSoFar).toBe(5);
    });

    test('a skilling trial reads its fill rate off the rising bar', () => {
        const analysis = analyseTrial(
            record({
                name: 'Trial Milking',
                kind: 'skilling',
                level: 110,
                tier: 2,
                samples: [
                    { t: now, readings: [{ current: 1_000_000, max: 4_000_000 }] },
                    { t: now + 20_000, readings: [{ current: 1_400_000, max: 4_000_000 }] },
                ],
            }),
            { timeLeftMs: 30 * 60_000 }
        );

        expect(analysis.rate).toBeCloseTo(20, 9); // 400,000 over 20s
        expect(analysis.remaining).toBe(2_600_000);
        expect(analysis.etaMs).toBeCloseTo(130_000, 6);
        expect(analysis.tiersClearedSoFar).toBe(2);
    });

    test('one sample is not a rate', () => {
        const analysis = analyseTrial(
            record({ samples: [{ t: now, readings: [{ current: 618_000, max: 618_000 }] }] }),
            { timeLeftMs: 60_000 }
        );

        expect(analysis.rate).toBeNull();
        expect(analysis.etaMs).toBeNull();
        expect(analysis.pace).toBeNull();
    });

    test('the pace projection climbs the exact ladder, anchored on the bar in hand', () => {
        // The party does 1,000 damage a millisecond with 100,000 left of the
        // tier in progress (T6, on a 600,000 bar). Combat boss health scales
        // with 100 + 10 × tier, so from that anchor T7 is 600,000 × 170/160 =
        // 637,500 and T8 is 675,000. In 900s: 100s + 637.5s fit, T8 does not.
        // The geometric fit this replaces would have priced T7 at 864,000.
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 200_000, max: 600_000 }] },
                    { t: now + 100_000, readings: [{ current: 100_000, max: 600_000 }] },
                ],
                tiers: [
                    { tier: 4, total: 500_000 },
                    { tier: 5, total: 600_000 },
                ],
            }),
            { participants: 20, timeLeftMs: 900_000 }
        );

        expect(analysis.rate).toBeCloseTo(1, 9);
        expect(analysis.pace.clears.map((clear) => clear.tier)).toEqual([6, 7]);
        expect(analysis.pace.tiersCleared).toBe(7); // five banked plus two projected
        // The fit is still reported — it is simply no longer what the walk runs on
        expect(analysis.growthPerTier).toBeCloseTo(1.2, 9);
    });

    test('the next tier is previewed with the party penalty spelled out', () => {
        const analysis = analyseTrial(
            record({
                samples: [{ t: now, readings: [{ current: 600_000, max: 600_000 }] }],
                tiers: [
                    { tier: 4, total: 500_000 },
                    { tier: 5, total: 600_000 },
                ],
            }),
            { participants: 21, timeLeftMs: 900_000 }
        );

        expect(analysis.next).toMatchObject({ tier: 7, level: 160 });
        // The exact combat ladder from the bar in hand — the T6 boss at
        // 600,000 — not the ×1.2 geometric fit, which said 864,000
        expect(analysis.next.total).toBeCloseTo(600_000 * (170 / 160), 3);
        expect(analysis.next.participantPenalty).toBeCloseTo(0.21, 12);
    });

    test('the first bar of a combat card is the boss, before anything has moved', () => {
        // This used to wait for one of the two bars to fall before deciding
        // which was which, and a combat card's pair is health then mana — the
        // second never falls for a reason the party controls, and across a tier
        // clear neither of them falls at all. So a live trial's card was left
        // permanently unclassified. Position is the confirmed fact here.
        const readings = [
            { current: 5, max: 10 },
            { current: 7, max: 20 },
        ];
        const analysis = analyseTrial(record({ samples: [{ t: now, readings }] }), { timeLeftMs: 60_000 });

        // One sample is still not a rate
        expect(analysis.rate).toBeNull();
        expect(analysis.remaining).toBe(5);
        expect(analysis.total).toBe(10);
    });

    test('an empty record analyses to nothing rather than throwing', () => {
        const analysis = analyseTrial({}, {});
        expect(analysis.rate).toBeNull();
        expect(analysis.tiersClearedSoFar).toBe(0);
        expect(analysis.samples).toBe(0);
    });
});

describe('a trial you did not join, read off its tier-clear timings', () => {
    const now = 1_700_000_000_000;

    /** A Trials-tab card: a level, a badge, a running total and no bar at all */
    const carded = (overrides = {}) => ({
        name: 'Milking',
        kind: 'skilling',
        level: 250,
        tier: 16,
        points: 2278,
        samples: [],
        tiers: [],
        pointsByTier: { 16: 2278 },
        ...overrides,
    });

    test('with one tier badge timed the block says it is measuring, not a rate', () => {
        const record = carded({ tierSeenAt: { 17: now } });
        const timing = tierTimingForecast(record, { timeLeftMs: 20 * 60_000, now: now + 60_000 });
        const html = renderTrialBlock(analyseTrial(record, { timeLeftMs: 20 * 60_000 }), 40, undefined, {
            participating: false,
            phase: 'live',
            looseForecast: timing,
        });

        expect(html).toContain('needs two tier clears');
        // …and nothing pretending to be a measurement
        expect(html).not.toContain('pts/s');
        expect(html).not.toContain('work/s');
    });

    test('two timed tier badges give a work rate, an ETA and an expected tier', () => {
        // T16 banked, then T17 at five minutes and T18 five and a bit later.
        const record = carded({ tierSeenAt: { 17: now, 18: now + 320_000 } });
        const timing = tierTimingForecast(record, {
            timeLeftMs: 30 * 60_000,
            now: now + 320_000,
            participants: 40,
            workBase: 40_000,
        });
        const analysis = analyseTrial(record, { timeLeftMs: 30 * 60_000, participants: 40 });
        const html = renderTrialBlock(analysis, 40, undefined, {
            participating: false,
            phase: 'live',
            looseForecast: timing,
            forecast: tierTimingAsForecast(timing),
        });

        // The rate is work, not points: the stated points are a step function
        expect(html).toContain('Est. fill');
        expect(html).toContain('work/s');
        expect(html).not.toContain('pts/s');
        expect(html).toContain('Next tier in');
        expect(html).toContain('Before it ends');

        // …and the expected tier is back, which is what an unjoined card lost
        expect(html).toContain('Expected');
        expect(html).not.toContain('not projectable');
        expect(html).toContain(`~T${timing.expectedTier}`);
        expect(timing.expectedTier).toBeGreaterThan(18);
    });

    test('the Expected row does not need a pace to draw', () => {
        // An unjoined card has no bar, so `analysis.pace` is null — and the
        // tooltip's flat-rate comparison used to read it unguarded, which threw
        // the whole block away the moment an expected tier came back.
        const record = carded({ tierSeenAt: { 17: now, 18: now + 300_000, 19: now + 640_000 } });
        const timing = tierTimingForecast(record, { timeLeftMs: 30 * 60_000, now: now + 640_000 });
        const analysis = analyseTrial(record, { timeLeftMs: 30 * 60_000 });
        expect(analysis.pace).toBeNull();

        const html = renderTrialBlock(analysis, 40, undefined, {
            participating: false,
            phase: 'live',
            looseForecast: timing,
            forecast: tierTimingAsForecast(timing),
        });
        expect(html).toContain('Expected');
        expect(html).toContain('falling');
    });

    test('a trial that has banked the last tier forecasts nothing above it', () => {
        // T21 is the end of the ladder. The reported card read "Next tier in ~a
        // few seconds", "Before it ends ~0 more tiers" and "Expected ~T21" — all
        // of them about a T22 that does not exist.
        const record = carded({
            level: 300,
            tier: 21,
            pointsByTier: { 21: 2278 },
            tierSeenAt: { 20: now, 21: now + 320_000 },
        });
        const timing = tierTimingForecast(record, {
            timeLeftMs: 30 * 60_000,
            now: now + 320_000,
            participants: 40,
            workBase: 40_000,
            bankedTiers: 21,
        });
        expect(timing.atFinalTier).toBe(true);
        expect(timing.etaMsToNextTier).toBeNull();
        expect(timing.tiersBeforeEnd).toBeNull();

        const analysis = analyseTrial(record, { timeLeftMs: 30 * 60_000, participants: 40 });
        expect(analysis.tiersClearedSoFar).toBe(21);

        const html = renderTrialBlock(analysis, 40, undefined, {
            participating: false,
            phase: 'live',
            looseForecast: timing,
            forecast: tierTimingAsForecast(timing),
        });

        expect(html).toContain('Final tier');
        expect(html).toContain('nothing above it');
        expect(html).not.toContain('Next tier in');
        expect(html).not.toContain('Before it ends');
        expect(html).not.toContain('Next tier work');
        expect(html).not.toContain('Expected');

        // The rate is a real measurement and stays, as does what it banked
        expect(html).toContain('Est. fill');
        expect(html).toContain('Banked');
    });

    test('a trial still fighting the last tier keeps every forecast row', () => {
        // Banked 20, fighting T21 — reaching the top of the ladder is a genuine
        // forecast and must not be suppressed with the finished case
        const record = carded({ level: 300, tier: 20, pointsByTier: { 20: 2278 } });
        record.tierSeenAt = { 19: now, 20: now + 320_000 };
        const timing = tierTimingForecast(record, {
            timeLeftMs: 30 * 60_000,
            now: now + 320_000,
            participants: 40,
            workBase: 40_000,
            bankedTiers: 20,
        });
        expect(timing.atFinalTier).toBeFalsy();
        expect(timing.currentTier).toBe(21);

        const html = renderTrialBlock(
            analyseTrial(record, { timeLeftMs: 30 * 60_000, participants: 40 }),
            40,
            undefined,
            {
                participating: false,
                phase: 'live',
                looseForecast: timing,
                forecast: tierTimingAsForecast(timing),
            }
        );
        expect(html).toContain('Next tier in');
        expect(html).toContain('Expected');
        expect(html).not.toContain('Final tier');
    });
});

describe('the tier badge a card wears beside its level', () => {
    test('a level identifies the tier, on the pairs read off live cards', () => {
        expect(badgeText({ level: 250 })).toBe('T16');
        expect(badgeText({ level: 260 })).toBe('T17');
        expect(badgeText({ level: 290 })).toBe('T20');
    });

    test('at the level cap the badge reads the last tier, with no "+" promising one above it', () => {
        // T21 is the last trial tier there is, so Lv.300 is T21 exactly — the
        // "+" used to advertise a ladder the game does not have
        expect(badgeText({ level: 300 })).toBe('T21');
        expect(badgeText({ level: 300 })).not.toContain('+');
    });

    test('a banked count above the ladder is clamped rather than drawn as a tier', () => {
        // Nothing can bank 24 tiers when there are 21; a miscount must not put
        // "T24" on a card
        expect(badgeText({ level: 300, bankedTiers: 24 })).toBe('T21');
    });

    test('a badge never reads below what is banked', () => {
        expect(badgeText({ level: 250, bankedTiers: 18 })).toBe('T18');
    });

    test('a level below the first trial level is not a trial tier', () => {
        // A guild *building*'s "Lv. 10 / 20" shares the tile-summary class
        expect(badgeText({ level: 20 })).toBeNull();
        expect(badgeText({ level: null })).toBeNull();
    });
});

describe('participantCounts', () => {
    const tracker = (members, week = '2026-07-31T00:00:00Z') => ({
        getCurrentWeekStartAt: () => week,
        getMemberList: () => members,
        getMemberMeta: (id) => members.find((member) => member.characterID === id) || null,
    });

    test('counts sign-ups made for the current week, per trial', () => {
        const counts = participantCounts(
            tracker([
                {
                    characterID: '1',
                    signupWeekStartAt: '2026-07-31T00:00:00Z',
                    signedUpSkillingTrialHrid: '/guild_trials/milking',
                    signedUpCombatTrialHrid: '/guild_trials/chameleon',
                },
                {
                    characterID: '2',
                    signupWeekStartAt: '2026-07-31T00:00:00Z',
                    signedUpSkillingTrialHrid: '/guild_trials/milking',
                    signedUpCombatTrialHrid: '',
                },
            ])
        );

        expect(counts).toEqual({ '/guild_trials/milking': 2, '/guild_trials/chameleon': 1 });
    });

    test('a sign-up from last week does not inflate the current penalty', () => {
        const counts = participantCounts(
            tracker([
                {
                    characterID: '1',
                    signupWeekStartAt: '2026-07-24T00:00:00Z',
                    signedUpCombatTrialHrid: '/guild_trials/chameleon',
                },
            ])
        );

        expect(counts).toEqual({});
    });

    test('no tracker at all is no counts', () => {
        expect(participantCounts({})).toEqual({});
    });

    test('the same walk keeps the names, for the estimated split to cover', () => {
        const roster = tracker([
            {
                characterID: '1',
                name: 'Tib',
                signupWeekStartAt: '2026-07-31T00:00:00Z',
                signedUpCombatTrialHrid: '/guild_trials/chameleon',
            },
            {
                characterID: '2',
                name: 'Moo',
                signupWeekStartAt: '2026-07-31T00:00:00Z',
                signedUpSkillingTrialHrid: '/guild_trials/milking',
            },
            {
                characterID: '3',
                name: 'Stale',
                signupWeekStartAt: '2026-07-24T00:00:00Z',
                signedUpCombatTrialHrid: '/guild_trials/chameleon',
            },
        ]);

        expect(signedUpMembers('Trial Chameleon', roster)).toEqual(['Tib']);
        expect(signedUpMembers('Milking', roster)).toEqual(['Moo']);
        expect(signedUpMembers('Trial Chameleon', {})).toEqual([]);
    });
});

describe('renderTrialBlock', () => {
    test('says it is measuring before there is a second reading', () => {
        const html = renderTrialBlock(analyseTrial(record({ samples: [] })), 0);
        expect(html).toContain('measuring');
    });

    test('names the rate and the ETA once there is one', () => {
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            { timeLeftMs: 30 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 21);

        expect(html).toContain('Party DPS');
        expect(html).toContain('Kill in');
        expect(html).toContain('Banked');
    });

    test('a skilling trial is captioned as a fill, not as damage', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 0, max: 1000 }] },
                    { t: now + 1000, readings: [{ current: 100, max: 1000 }] },
                ],
            }),
            { timeLeftMs: 60_000 }
        );

        expect(renderTrialBlock(analysis, 3)).toContain('Fill rate');
    });
});

describe('tokenPayoutLine', () => {
    beforeEach(() => {
        game.clientData = {};
        game.prices = {};
        game.settingValues = {};
    });

    test('an unpriceable token payout is left as the bare count it always was', () => {
        const row = tokenPayoutLine(500, 'Half the base points.');

        expect(row.value).toBe('500');
        expect(row.title).toBe('Half the base points.');
    });

    test('a priceable one carries the gold value and says it is derived', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
                '/items/bronze_bar': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };
        game.prices = { '/items/bronze_bar': { ask: 100 } };

        const row = tokenPayoutLine(500, 'Half the base points.');

        // Both halves in full: 500 tokens, and the gold they convert to
        expect(row.value).toContain('500 (');
        expect(row.value).toContain('≈1,000,000g');
        expect(row.value).toContain('via credit exchange');
        expect(row.title).toContain('Half the base points.');
    });

    test('showGold:false keeps the count and drops the gold, even when priceable', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
                '/items/bronze_bar': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };
        game.prices = { '/items/bronze_bar': { ask: 100 } };

        const row = tokenPayoutLine(500, 'Half the base points.', { showGold: false });

        expect(row.value).toBe('500');
        expect(row.value).not.toContain('via credit exchange');
        expect(row.title).toBe('Half the base points.');
    });
});

describe('ownParticipation', () => {
    // Confirmed by the user: the In Progress tab only ever shows the trials this
    // character signed up for, so a card for anybody else's trial can never
    // receive a reading. Knowing which is which is what lets the block say that
    // instead of promising a measurement that cannot arrive.
    const tracker = (meta) => ({
        getMemberMeta: (id) => (String(id) === '30404' ? meta : null),
        getCurrentWeekStartAt: () => '2026-07-31T00:00:00Z',
    });

    test('signed up for this trial, this week', () => {
        const meta = {
            signedUpCombatTrialHrid: '/guild_trials/trial_chameleon',
            signedUpSkillingTrialHrid: '',
            signupWeekStartAt: '2026-07-31T00:00:00Z',
        };
        expect(ownParticipation('Trial Chameleon', { tracker: tracker(meta), characterId: 30404 })).toBe(true);
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: 30404 })).toBe(false);
    });

    test('an id that arrived as a number and is asked for as a string is the same member', () => {
        const meta = {
            signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            signupWeekStartAt: '2026-07-31T00:00:00Z',
        };
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: '30404' })).toBe(true);
    });

    test('last week’s sign-up is not this week’s', () => {
        const meta = {
            signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            signupWeekStartAt: '2026-07-24T00:00:00Z',
        };
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: 30404 })).toBe(false);
    });

    test('signed up for nothing is not in it', () => {
        const meta = { signedUpSkillingTrialHrid: '', signedUpCombatTrialHrid: '' };
        expect(ownParticipation('Alchemy', { tracker: tracker(meta), characterId: 30404 })).toBe(false);
    });

    test('no sign-up sheet at all is unknown, not an accusation', () => {
        expect(ownParticipation('Alchemy', { tracker: tracker(null), characterId: 30404 })).toBeNull();
        expect(ownParticipation('Alchemy', { tracker: tracker({}), characterId: null })).toBeNull();
    });
});

describe('withScrollKept', () => {
    test('puts every scrolled ancestor back where it was', () => {
        document.body.innerHTML = '<div id="outer"><div id="inner"><div id="leaf"></div></div></div>';
        const outer = document.getElementById('outer');
        const inner = document.getElementById('inner');
        const leaf = document.getElementById('leaf');
        Object.defineProperty(outer, 'scrollTop', { value: 120, writable: true, configurable: true });
        Object.defineProperty(inner, 'scrollTop', { value: 40, writable: true, configurable: true });

        withScrollKept(leaf, () => {
            // What a browser does when the content it is scrolling changes height
            outer.scrollTop = 0;
            inner.scrollTop = 0;
        });

        expect(outer.scrollTop).toBe(120);
        expect(inner.scrollTop).toBe(40);
    });

    test('a page nobody has scrolled is left alone, and the return value passes through', () => {
        document.body.innerHTML = '<div id="leaf"></div>';
        const leaf = document.getElementById('leaf');

        expect(withScrollKept(leaf, () => 'done')).toBe('done');
    });

    test('a throwing change still restores the scroll', () => {
        document.body.innerHTML = '<div id="outer"><div id="leaf"></div></div>';
        const outer = document.getElementById('outer');
        const leaf = document.getElementById('leaf');
        Object.defineProperty(outer, 'scrollTop', { value: 80, writable: true, configurable: true });

        expect(() =>
            withScrollKept(leaf, () => {
                outer.scrollTop = 0;
                throw new Error('nope');
            })
        ).toThrow('nope');
        expect(outer.scrollTop).toBe(80);
    });
});

describe('mergeWaveTiles', () => {
    const tile = (name, kind, readings, extra = {}) => ({
        element: { id: `${name}-${readings?.[0]?.current ?? 'x'}` },
        name,
        kind,
        readings: readings || [],
        completed: false,
        level: null,
        tier: null,
        ...extra,
    });

    test('two same-named enemy cards fold into one wave with summed health', () => {
        const badgers = [
            tile('Trial Badger', 'combat', [
                { current: 430235, max: 479895 },
                { current: 448475, max: 448500 },
            ]),
            tile('Trial Badger', 'combat', [
                { current: 473164, max: 479895 },
                { current: 448475, max: 448500 },
            ]),
        ];

        const merged = mergeWaveTiles(badgers);
        expect(merged).toHaveLength(1);
        // Health (index 0) and mana (index 1) each summed across both cards
        expect(merged[0].readings).toEqual([
            { current: 903399, max: 959790 },
            { current: 896950, max: 897000 },
        ]);
        expect(merged[0].waveSize).toBe(2);
        expect(merged[0].name).toBe('Trial Badger');
    });

    test('different trials are left alone, in document order', () => {
        const tiles = [
            tile('Woodcutting', 'skilling', [{ current: 10, max: 100 }]),
            tile('Trial Jellyfish', 'combat', [{ current: 5, max: 50 }]),
        ];
        expect(mergeWaveTiles(tiles)).toEqual(tiles);
    });

    test('a wave is completed only once every enemy in it is down', () => {
        const one = mergeWaveTiles([
            tile('Trial Badger', 'combat', [{ current: 0, max: 100 }], { completed: true }),
            tile('Trial Badger', 'combat', [{ current: 40, max: 100 }], { completed: false }),
        ]);
        expect(one[0].completed).toBe(false);

        const both = mergeWaveTiles([
            tile('Trial Badger', 'combat', [{ current: 0, max: 100 }], { completed: true }),
            tile('Trial Badger', 'combat', [{ current: 0, max: 100 }], { completed: true }),
        ]);
        expect(both[0].completed).toBe(true);
    });

    test('a lone card, an empty list, or nothing passes straight through', () => {
        const solo = [tile('Trial Badger', 'combat', [{ current: 1, max: 2 }])];
        expect(mergeWaveTiles(solo)).toBe(solo);
        expect(mergeWaveTiles([])).toEqual([]);
        expect(mergeWaveTiles(null)).toEqual([]);
    });
});

describe('placeTrialBlock', () => {
    // Devtools, from the tab the user actually has: our block measured 126 ×
    // 152.8 as a *Grid Item* — one cell of a four-column grid, not the full-width
    // row `grid-column: 1 / -1` was supposed to give it — while the "Combat
    // Trial" section label beside it is a 525.6-wide *Flex Item* of an outer box.
    // Two different layouts in one panel, which is why this measures rather than
    // assumes.
    /**
     * A container holding two cards.
     * @param {string} css - Inline style for the container
     * @returns {{root: Element, container: Element, card: Element}} The pieces
     */
    function layout(css) {
        document.body.innerHTML =
            `<div class="GuildPanel_guildPanel__r"><div id="grid" style="${css}">` +
            '<div id="card" class="GuildPanel_tile__a">Trial Chameleon</div>' +
            '<div class="GuildPanel_tile__b">Alchemy</div></div>' +
            '<div class="GuildPanel_sectionLabel__s">Combat Trial</div></div>';
        return {
            root: document.querySelector('[class*="GuildPanel_guildPanel"]'),
            container: document.getElementById('grid'),
            card: document.getElementById('card'),
        };
    }

    /** @returns {Element} A fresh block */
    const newBlock = () => {
        const block = document.createElement('div');
        block.className = 'mwi-trial-info';
        block.innerHTML = '<div>Banked 3 tiers</div>';
        return block;
    };

    /**
     * The In Progress combat view, as the game draws it.
     * @param {number} bosses - How many boss cards the wave has
     * @returns {{root: Element, monsters: Element, grid: Element, cards: Element[]}} The pieces
     */
    function fightLayout(bosses) {
        const bossCards = Array.from(
            { length: bosses },
            (_, index) => `<div id="boss${index + 1}" class="BattlePanel_combatUnit__z">Trial Badger</div>`
        ).join('');
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r"><div class="GuildPanel_inProgressTab__i">' +
            '<div class="BattlePanel_battlePanel__p">' +
            '<div class="BattlePanel_battleArea__x" style="display:flex">' +
            '<div id="monsters" class="BattlePanel_monstersArea__y">' +
            '<div id="grid" class="BattlePanel_combatUnitGrid__g" ' +
            'style="display:grid; grid-template-columns:176px 176px 176px 176px">' +
            '<div id="payout" class="mwi-trial-info" data-mwi-block="payout">Trial payout</div>' +
            `${bossCards}</div></div></div></div></div></div>`;
        return {
            root: document.querySelector('[class*="GuildPanel_guildPanel"]'),
            monsters: document.getElementById('monsters'),
            grid: document.getElementById('grid'),
            cards: Array.from({ length: bosses }, (_, index) => document.getElementById(`boss${index + 1}`)),
        };
    }

    test('a live fight puts the block beside the last boss, in the boss grid', () => {
        // A wave of two bosses folds into one tile anchored on the *first* of
        // them, so the block must be appended past both rather than inserted
        // after the anchor — and stay on the bosses' row rather than wrapping.
        const { root, grid, cards } = fightLayout(2);
        const block = newBlock();

        expect(placeTrialBlock(root, cards[0], block, 'Trial Badger')).toBe('fight-sidecar');
        expect(grid.lastElementChild).toBe(block);
        expect(block.previousElementSibling).toBe(cards[1]);
        expect(block.style.gridRow).toBe('1');
        // Explicitly the column after the two auto-placed bosses — never left
        // to auto-placement, which fills the first free cell instead
        expect(block.style.gridColumn).toBe('3');
        // Not gathered into a mirrored row, and the payout block is left where it was
        expect(grid.querySelector('.mwi-trial-box-row')).toBeNull();
        expect(grid.firstElementChild).toBe(document.getElementById('payout'));
    });

    test('a wave that fills the grid puts the block under it rather than past its last column', () => {
        // Trial Swarm's four monsters fill the game's four columns, and asking
        // for a fifth is 176 × 4 + 220 wide — the fight grew a horizontal
        // scrollbar and pushed itself out of view.
        const { root, grid, cards } = fightLayout(4);
        const block = newBlock();

        expect(placeTrialBlock(root, cards[0], block, 'Trial Swarm')).toBe('fight-sidecar');
        // Still after the last boss in the DOM, so the anchoring check holds
        expect(grid.lastElementChild).toBe(block);
        expect(block.style.gridRow).toBe('2');
        expect(block.style.gridColumn).toBe('1 / -1');
    });

    test('the sidecar’s sizing follows its placement', () => {
        const beside = fightSidecarStyle(fightSidecarPlacement(fightLayout(1).grid));
        expect(beside).toContain('grid-row:1');
        expect(beside).toContain('width:220px');
        expect(beside).not.toContain('display:grid');

        // Under the wave it may have the whole width, so its rows take columns
        // of their own rather than making one long thin box
        const under = fightSidecarStyle(fightSidecarPlacement(fightLayout(4).grid));
        expect(under).toContain('grid-row:2');
        expect(under).toContain('grid-column:1 / -1');
        expect(under).toContain('max-width:100%');
        expect(under).toContain('minmax(190px, 1fr)');
        expect(under).not.toContain('width:220px');
    });

    test('a grid whose columns cannot be read keeps the sidecar beside the wave', () => {
        // Failing closed: no template is not "the wave fills it", and moving the
        // readout under a fight it fits beside would be a regression for every
        // layout this rule cannot measure
        const { grid } = fightLayout(4);
        grid.style.gridTemplateColumns = '';

        expect(fightSidecarPlacement(grid)).toEqual({ row: 1, column: '5', wrapped: false });
        expect(gridColumnCount('')).toBe(0);
        expect(gridColumnCount('none')).toBe(0);
        expect(gridColumnCount('176px 176px 176px 176px')).toBe(4);
        expect(gridColumnCount('repeat(4, 176px)')).toBe(4);
        expect(gridColumnCount('repeat(2, 100px 20px)')).toBe(4);
    });

    test('one to four monsters each get a placement that fits the grid', () => {
        for (const monsters of [1, 2, 3]) {
            expect(fightSidecarPlacement(fightLayout(monsters).grid).wrapped).toBe(false);
        }
        expect(fightSidecarPlacement(fightLayout(4).grid).wrapped).toBe(true);
    });

    test('a wave of explicitly-centred bosses puts the sidecar to their right, never their left', () => {
        // The live 2× Trial Badger wave: the game centres the two cards at
        // columns 2 and 3 of its four-column grid, leaving column 1 free —
        // auto-placement dropped the sidecar there, LEFT of the cards.
        const { root, cards } = fightLayout(2);
        cards[0].style.gridColumn = '2';
        cards[1].style.gridColumn = '3';
        const block = newBlock();

        expect(placeTrialBlock(root, cards[0], block, 'Trial Badger')).toBe('fight-sidecar');
        expect(block.style.gridColumn).toBe('4');
        expect(block.style.gridRow).toBe('1');
    });

    test('fightSidecarColumn reads the wave shape, ignoring our own injected blocks', () => {
        // A single auto-placed boss: the sidecar sits at column 2
        expect(fightSidecarColumn(fightLayout(1).grid)).toBe(2);
        // Four auto-placed monsters (Trial Swarm): column 5
        expect(fightSidecarColumn(fightLayout(4).grid)).toBe(5);

        // Two bosses spanning explicit columns: the sidecar follows the last line
        const spanned = fightLayout(2);
        spanned.cards[0].style.gridColumnStart = '2';
        spanned.cards[0].style.gridColumnEnd = '3';
        spanned.cards[1].style.gridColumnStart = '3';
        spanned.cards[1].style.gridColumnEnd = '5';
        expect(fightSidecarColumn(spanned.grid)).toBe(5);

        // Our own blocks in the grid (the payout in old DOMs, the sidecar
        // itself on a re-place) never push the column further right
        const crowded = fightLayout(2);
        const sidecar = newBlock();
        crowded.grid.appendChild(sidecar);
        expect(fightSidecarColumn(crowded.grid)).toBe(3);

        expect(fightSidecarColumn(null)).toBe(1);
    });

    test('a composite wave anchored on the monsters area finds the grid beneath it', () => {
        // Trial Swarm has no card of its own, so the tile stands on the monsters
        // area itself — the grid is below the anchor rather than above it.
        const { root, monsters, grid, cards } = fightLayout(4);
        const block = newBlock();

        expect(placeTrialBlock(root, monsters, block, 'Trial Swarm')).toBe('fight-sidecar');
        expect(grid.lastElementChild).toBe(block);
        expect(block.previousElementSibling).toBe(cards[3]);
    });

    test('a placed sidecar reads as anchored, and a boss mounting after it does not', () => {
        // Anchored on the first boss but living after the last: an adjacency test
        // would call every correctly placed sidecar displaced and yank it out on
        // every five-second pass.
        const { root, grid, cards } = fightLayout(4);
        const block = newBlock();
        placeTrialBlock(root, cards[0], block, 'Trial Badger');

        expect(blockNearAnchor(block, cards[0], root)).toBe(true);

        // A wave boundary remounts the bosses after the block; it has to move back
        const late = document.createElement('div');
        late.className = 'BattlePanel_combatUnit__z';
        grid.appendChild(late);
        expect(blockNearAnchor(block, cards[0], root)).toBe(false);
    });

    test('a multi-enemy fight grid places its box below the grid, like a single boss', () => {
        // The In Progress enemy grid is not a tile grid: a two-badger wave must
        // not gather its box into a narrow mirrored cell, but place it full-width
        // below the grid — the same path a single boss (a one-column grid) takes.
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="BattlePanel_battleArea__x" style="display:flex">' +
            '<div id="monsters" class="BattlePanel_monstersArea__y">' +
            '<div id="grid" style="display:grid; grid-template-columns:176px 176px 176px 176px">' +
            '<div id="card" class="BattlePanel_combatUnit__z">Trial Badger</div>' +
            '</div></div></div></div>';
        const root = document.querySelector('[class*="GuildPanel_guildPanel"]');
        const monsters = document.getElementById('monsters');
        const grid = document.getElementById('grid');
        const card = document.getElementById('card');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Badger')).toBe('after-container');
        // Below the enemy grid, in the monsters area — not a mirrored grid row,
        // and not absolutely positioned over the panel (which caused a scrollbar)
        expect(grid.querySelector('.mwi-trial-box-row')).toBeNull();
        expect(monsters.contains(block)).toBe(true);
        expect(grid.nextElementSibling).toBe(block);
        expect(block.style.width).toBe('100%');
    });

    test('a grid gathers its boxes into one full-width row beneath the tiles', () => {
        const { root, container, card } = layout('display:grid; grid-template-columns:126px 126px 126px 126px');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('row');
        // A single shared row, spanning every column and deferred past the tiles,
        // and mirroring the tile grid's own columns so the boxes line up under them
        const row = container.querySelector('.mwi-trial-box-row');
        expect(row).not.toBeNull();
        expect(row.style.gridColumn).toBe('1 / span 4');
        expect(row.style.order).toBe('1');
        expect(row.style.display).toBe('grid');
        expect(row.style.gridTemplateColumns).toBe('126px 126px 126px 126px');
        expect(row.contains(block)).toBe(true);
    });

    test('every box in the grid joins the same row, in order', () => {
        const { root, container } = layout('display:grid; grid-template-columns:126px 126px 126px 126px');
        // Two tiles, two boxes: they must share one row, not fill the cells beside the tiles
        const first = newBlock();
        const second = newBlock();
        placeTrialBlock(root, container.children[0], first, 'Trial Chameleon');
        placeTrialBlock(root, container.children[1], second, 'Alchemy');

        const rows = container.querySelectorAll('.mwi-trial-box-row');
        expect(rows).toHaveLength(1);
        expect([...rows[0].children]).toEqual([first, second]);
    });

    test('a tile nested in the tab grid joins the outer grid row, not the one-cell tile', () => {
        // The live shape: each trial tile is its own single-column grid, sitting
        // inside the tab's four-column tile grid. Anchored to the inner tile, the
        // box must land in the shared row on the *outer* grid — otherwise it fills
        // the next cell beside the tile, not the row beneath.
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div id="tabgrid" style="display:grid; grid-template-columns:126px 126px 126px 126px">' +
            '<div id="tile" style="display:grid; grid-template-columns:126px">' +
            '<div id="card" class="GuildPanel_tileBottom__t">Tailoring</div></div>' +
            '<div id="tile2" style="display:grid; grid-template-columns:126px">Brewing</div>' +
            '</div></div>';
        const root = document.querySelector('[class*="GuildPanel_guildPanel"]');
        const card = document.getElementById('card');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Tailoring')).toBe('row');
        const row = document.getElementById('tabgrid').querySelector('.mwi-trial-box-row');
        expect(row).not.toBeNull();
        expect(row.style.gridColumn).toBe('1 / span 4');
        expect(row.contains(block)).toBe(true);
    });

    test('a grid that declares no columns is left alone and the block goes after it', () => {
        // This is the reported case. `-1` resolves against the explicit grid, so
        // on a container with implicit columns `1 / -1` is a single cell — 126px
        // wide, exactly as devtools measured it.
        const { root, container, card } = layout('display:grid');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('after-container');
        expect(container.contains(block)).toBe(false);
        expect(block.previousElementSibling).toBe(container);
        // Away from its card, so it says which card it is
        expect(block.textContent).toContain('Trial Chameleon');
        // And before the next section's label, which it used to collide with
        expect(block.nextElementSibling.className).toContain('GuildPanel_sectionLabel');
    });

    test('a wrapping flex row gives it a line of its own', () => {
        const { root, card } = layout('display:flex; flex-wrap:wrap');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('after-card');
        expect(block.style.flexBasis).toBe('100%');
        expect(block.previousElementSibling).toBe(card);
    });

    test('a flex row that does not wrap would squash the cards, so it goes after', () => {
        const { root, container, card } = layout('display:flex');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Trial Chameleon')).toBe('after-container');
        expect(container.contains(block)).toBe(false);
    });

    test('a card two non-wrapping rows deep escapes both, not just one', () => {
        // The skilling In Progress panel: a column holds a battleArea row, which
        // holds the roster and a challengeArea row, which holds the card. Escaping
        // one row leaves the block in the battleArea, still squashing the roster and
        // card to 44px — it has to climb out of both to the column.
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div id="col" style="display:flex; flex-direction:column">' +
            '<div id="battle" style="display:flex; flex-direction:row">' +
            '<div id="roster">roster</div>' +
            '<div id="challenge" style="display:flex; flex-direction:row">' +
            '<div id="card" class="GuildPanel_tile__a">Cheesesmithing</div>' +
            '</div></div>' +
            '<div id="info">info</div>' +
            '</div></div>';
        const root = document.querySelector('[class*="GuildPanel_guildPanel"]');
        const card = document.getElementById('card');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block, 'Cheesesmithing')).toBe('after-container');
        // Out of both rows
        expect(document.getElementById('challenge').contains(block)).toBe(false);
        expect(document.getElementById('battle').contains(block)).toBe(false);
        // Landed in the column, right after the battle row, on its own full line
        expect(block.parentElement).toBe(document.getElementById('col'));
        expect(block.previousElementSibling).toBe(document.getElementById('battle'));
        expect(block.style.flexBasis).toBe('100%');
    });

    test('ordinary flow needs nothing but being a block', () => {
        const { root, card } = layout('');
        const block = newBlock();

        expect(placeTrialBlock(root, card, block)).toBe('after-card');
        expect(block.previousElementSibling).toBe(card);
        expect(block.style.gridColumn).toBe('');
    });

    test('a card inside a dialog is refused, not decorated', () => {
        // The boss's stat popup is headed with a trial name over a level, which
        // is what a card is recognised by — so placement is the last point at
        // which "this is not the guild panel" can still be said
        document.body.innerHTML =
            '<div id="root"><div class="Modal_modalContainer__m" role="dialog">' +
            '<div class="GuildPanel_tile__a" id="popup-card">Trial Chameleon Lv.110</div>' +
            '</div></div>';
        const block = newBlock();
        const card = document.getElementById('popup-card');

        expect(placeTrialBlock(document.getElementById('root'), card, block, 'Trial Chameleon')).toBe('refused');
        expect(card.contains(block)).toBe(false);
        expect(document.body.contains(block)).toBe(false);
    });

    test('a card with nothing around it keeps the block inside itself', () => {
        document.body.innerHTML = '<div id="lone" class="GuildPanel_tile__a">Alchemy</div>';
        const card = document.getElementById('lone');
        const block = newBlock();

        expect(placeTrialBlock(card, card, block)).toBe('after-card');
        expect(card.contains(block)).toBe(true);
    });
});

describe('_placeBlock re-homes a block stuck in a squashing row', () => {
    // The skilling In Progress layout: a column holds a battleArea row, which
    // holds a challengeArea row, which holds the unit card. A block placed by the
    // pre-styles fallback lands inside that row and squashes the unit; the guard
    // must lift it out on the next pass whatever the block's own anchor test says.
    function skillingLayout() {
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div id="col" style="display:flex; flex-direction:column">' +
            '<div id="battle" style="display:flex; flex-direction:row">' +
            '<div id="challenge" style="display:flex; flex-direction:row">' +
            '<div id="card">Tailoring</div>' +
            '</div></div></div></div>';
        return {
            root: document.querySelector('[class*="GuildPanel_guildPanel"]'),
            col: document.getElementById('col'),
            challenge: document.getElementById('challenge'),
        };
    }

    test('a block left inside a non-wrapping flex row is re-placed out of it', () => {
        const { root, col, challenge } = skillingLayout();
        // First placement drops the block beside the card, inside the row (the
        // pre-styles fallback); the second, styles up, would land it in the column.
        let placeCount = 0;
        const place = (block) => {
            placeCount += 1;
            if (placeCount === 1) challenge.appendChild(block);
            else col.appendChild(block);
        };
        const opts = { html: '<div>x</div>', style: '', place };

        const block = guildTrials._placeBlock(root, 'tile:squash-test', opts);
        expect(block.parentElement).toBe(challenge);

        // Next pass finds it stuck in the row and re-places it, no anchor test needed.
        guildTrials._placeBlock(root, 'tile:squash-test', opts);
        expect(placeCount).toBe(2);
        expect(block.parentElement).toBe(col);
    });

    test('a block already out in the column is left alone', () => {
        const { root, col } = skillingLayout();
        let placeCount = 0;
        const place = (block) => {
            placeCount += 1;
            col.appendChild(block);
        };
        const opts = { html: '<div>x</div>', style: '', place };

        guildTrials._placeBlock(root, 'tile:column-test', opts);
        guildTrials._placeBlock(root, 'tile:column-test', opts);
        expect(placeCount).toBe(1); // never re-placed
    });
});

describe('the panel, end to end', () => {
    /**
     * The In Progress tab, as markup.
     * @param {Array<Object>} cards - Cards to render
     * @returns {Element} The trials-content element
     */
    function buildTab(cards, statusText = 'In progress — 42:15 remaining') {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';

        const status = document.createElement('div');
        status.className = 'GuildPanel_eventStatusRow__b';
        status.textContent = statusText;
        root.appendChild(status);

        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__c';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__d">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__e">Lv.${card.level}</div>` +
                // A card states points once it has banked a tier, and that is
                // what tells a badge counting finished tiers from one naming the
                // tier in progress
                (Number.isFinite(card.points) ? `<div class="Card_points__p">${card.points} pts</div>` : '') +
                // The card's own decoration, which outranks the header's kind
                (card.completed ? '<div class="GuildPanel_status__q">Completed</div>' : '') +
                `<div class="ProgressBar_text__f">${card.bar}</div>`;
            root.appendChild(tile);
        }

        document.body.appendChild(root);
        return root;
    }

    /**
     * A Trials-tab card, which is where points and tiers come from.
     * @param {string} name - Trial name
     * @param {number} level - Its level
     * @param {number} points - What the card states
     * @returns {Element} The tab
     */
    function buildTrialsTabFor(name, level, points) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            `<div class="GuildPanel_tileName__d">${name}</div>` +
            `<div class="GuildPanel_tileSummary__e">Lv.${level}</div>` +
            `<div class="Card_points__g">${points} pts</div>`;
        root.appendChild(tile);
        document.body.appendChild(root);
        return root;
    }

    // The callback takes no element: it finds the root itself, so that a tab
    // whose container is called something else is still read
    const fire = () => game.observers['GuildPanel_']();
    const text = () => document.body.textContent;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        game.settings = { guildTrialsInfo: true };
        game.settingListeners = {};
        game.settingValues = {};
        game.clientData = {};
        game.prices = {};
        game.buildingLevels = {};
        game.store = {};
        game.holds = {};
        game.unavailable = false;
        game.members = [];
        game.characterId = null;
        game.characterData = null;
        game.dmHandlers = {};
        game.trialNames = [];
        game.alerts = { status: [], payouts: [], reset: 0 };
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        game.scoreboardToggles = 0;
        game.breakdown = {};
        game.scoreboardContext = null;
        game.skilling = {};
        game.skillingEnded = {};
        resetTrialsSingleton();
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('draws a block on each card and a payout block above them', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(2);
        expect(text()).toContain('Trial payout');
        expect(text()).toContain('measuring');
    });

    test('a tab whose container is called something else is still read', () => {
        // The reported bug, in one test. Everything hung off one unverified
        // class name, and if the game does not spell it `GuildPanel_trialsContent`
        // then the observer never fires, the interval never matches, no reading
        // is ever taken, and the panel block and the overlay tile are both dark
        // during a live trial — with nothing logged anywhere.
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        root.className = 'GuildPanel_whateverTheyCallItNow__z';
        fire();

        expect(document.querySelectorAll('.mwi-trial-info').length).toBeGreaterThan(0);
        expect(text()).toContain('Trial payout');
    });

    test('a card with no progress bar is identity, not a reading', () => {
        // The Trials tab's cards carry the tier and the sign-ups and no bar at
        // all. They are worth recording and must not push a sample: a sample
        // with no readings in it puts a hole in the series a rate is fitted to.
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        root.querySelector('[class*="ProgressBar_text"]').textContent = 'Sign up';
        fire();

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.tier).toBe(5);
        expect(record.samples).toHaveLength(0);
        expect(text()).toContain('Trial payout');
    });

    test('the payout block sits above the cards when there is no status row to hang it on', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        root.querySelector('[class*="GuildPanel_eventStatusRow"]').remove();
        fire();

        const payout = [...document.querySelectorAll('.mwi-trial-info')].find((el) =>
            el.textContent.includes('Trial payout')
        );
        const card = document.querySelector('[class*="GuildPanel_tile__"]');
        expect(payout.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('a second reading five seconds later produces a rate', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        root.querySelector('[class*="ProgressBar_text"]').textContent = '568,000 / 618,000';
        vi.setSystemTime(now + 10_000);
        fire(root);

        expect(text()).toContain('Party DPS');
        expect(text()).not.toContain('measuring');
    });

    test('a combat card measures damage across a tier clear', () => {
        // The recorded trial: the boss bar does not fall between these two
        // readings, it jumps to a bigger boss. Nothing fell, so nothing was
        // classified, so the card showed no DPS for the whole hour.
        const root = buildTab([{ name: 'Trial Chameleon', level: 120, bar: '23,031 / 618,000' }]);
        const bar = root.querySelector('[class*="ProgressBar_text"]');
        fire(root);

        bar.textContent = '506,273 / 669,500';
        vi.setSystemTime(now + 414_667);
        fire(root);

        expect(text()).toContain('Party DPS');
        // A non-breaking space: the unit must never be left on its own line
        expect(text()).toContain('449\u00a0dmg/s');
        // The card's own level puts both readings at tier 3, so there is no
        // second tier to fit a growth curve to and the boundary cannot be shown
        // to be a single step — said outright rather than quietly under-counted
        expect(document.body.innerHTML).toContain('lower bound');
    });

    test('the mana bar beside it is not mistaken for anything', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 120, bar: '600,000 / 618,000' }]);
        const bar = root.querySelector('[class*="ProgressBar_text"]');
        bar.textContent = '600,000 / 618,000';
        const mana = document.createElement('div');
        mana.className = 'ProgressBar_text__m';
        mana.textContent = '582,560 / 600,000';
        bar.parentElement.appendChild(mana);
        fire(root);

        bar.textContent = '500,000 / 618,000';
        mana.textContent = '644,395 / 600,000';
        vi.setSystemTime(now + 10_000);
        fire(root);

        // 100,000 off the boss in ten seconds, and not a number from the mana bar
        expect(text()).toContain('10.0K\u00a0dmg/s');
    });

    test('four tiers banked at tier 5 reach the payout block', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]);
        fire(root);

        // A card badged T5 has banked five: 400 + 200 × 4 = 1,200 base points
        // → 600 tokens for every eligible member, 900 for a participant
        expect(text()).toContain('Guild Points banked1,200');
        expect(text()).toContain('Tokens, every eligible member600');
        expect(text()).toContain('Tokens, if you took part900');
    });

    test('a token payout carries an approximate gold value when the exchange can be priced', () => {
        // 1 token → 2 credits, and a credit costs 10 bronze bars at 100 each,
        // so a token is worth 2,000 gold and 500 of them are worth 1M
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    name: 'Guild Token',
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
                '/items/bronze_bar': {
                    name: 'Bronze Bar',
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };
        game.prices = { '/items/bronze_bar': { ask: 100 } };

        fire(buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Tokens, every eligible member600 (≈1,200,000g');
        expect(text()).toContain('via credit exchange');
    });

    test('the In Progress tab drops the token gold value and the Treasury nag, keeps the count', () => {
        game.clientData = {
            itemDetailMap: {
                '/items/guild_token': {
                    guildCreditConversions: [{ creditItemHrid: '/items/guild_credit_1', itemCount: 1, creditCount: 2 }],
                },
                '/items/bronze_bar': {
                    guildCreditConversions: [
                        { creditItemHrid: '/items/guild_credit_1', itemCount: 10, creditCount: 1 },
                    ],
                },
            },
        };
        game.prices = { '/items/bronze_bar': { ask: 100 } };

        const root = buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]);
        root.className = 'GuildPanel_inProgressTab__a';
        fire();

        // The token count still shows; its gold valuation and the Treasury nag do not
        expect(text()).toContain('Tokens, every eligible member600');
        expect(text()).not.toContain('via credit exchange');
        expect(text()).not.toContain('Treasury');
        // And the roster button is offered
        expect([...document.querySelectorAll('button')].some((b) => b.textContent.includes('Roster'))).toBe(true);
    });

    test('the Abilities button keeps the last roster once the fight is torn down', () => {
        // After the trial ends the damage breakdown has nobody in it, and the
        // button used to feed that empty list in — blanking the panel's
        // completed view of the roster it had just finished capturing
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.setTier(4);
        game.breakdown = { roster: {}, tier: null };

        const button = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Abilities'));
        button.click();

        expect(guildTrialAbilities.roster.map((member) => member.name)).toEqual(['Alice', 'Bob']);
        expect(guildTrialAbilities.currentTier).toBe(4);

        // The module is a real singleton; leave it as the other tests expect it
        guildTrialAbilities.roster = [];
        guildTrialAbilities.session = null;
        guildTrialAbilities.currentTier = null;
    });

    test('a trial going live starts a fresh capture session; a page opened onto one does not', () => {
        // The capture session used to begin at whichever capture happened to be
        // first, so its sixty-five-minute clock could run out in the middle of
        // the next trial — or keep the last trial's kits alive through it
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        guildTrials.phase = null;
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(
            {
                name: 'Alice',
                characterId: 1,
                abilities: [],
                abilitiesAuthoritative: true,
                source: 'battle_unit_fetched',
            },
            { at: now, now }
        );

        // A page opened onto a trial already running keeps what it restored:
        // the session in hand is this trial's
        guildTrials._noteLifecycle({ phase: 'live' }, [], now + 1000);
        expect(Object.keys(guildTrialAbilities.session.players)).toEqual(['id:1']);

        // A trial *beginning* is the deterministic reset
        guildTrials._noteLifecycle({ phase: 'scheduled' }, [], now + 10 * 60_000);
        guildTrials._noteLifecycle({ phase: 'live' }, [], now + 20 * 60_000);
        expect(guildTrialAbilities.session.players).toEqual({});
        expect(guildTrialAbilities.session.startedAt).toBe(now + 20 * 60_000);

        guildTrials.phase = null;
        guildTrialAbilities.roster = [];
        guildTrialAbilities.session = null;
    });

    test('with nothing to price the token payout against, the bare count is all that shows', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('Tokens, every eligible member600');
        expect(text()).not.toContain('via credit exchange');
    });

    test('an unknown building bonus is captioned, not silently treated as zero', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).toContain('level seen');
        expect(text()).toContain('Builder’s Hall');
        expect(text()).toContain('each level adds 2%');
        // Treasury only prices tokens and adds nothing at 0 levels — no longer nagged
        expect(text()).not.toContain('No Treasury level seen');
    });

    test('a resolvable bonus drops the caption', () => {
        game.buildingLevels = { '/guild_buildings/builders_hall': 2, '/guild_buildings/treasury': 2 };
        game.clientData = {
            guildBuildingDetailMap: {
                '/guild_buildings/builders_hall': { bonusPerLevel: 0.05 },
                '/guild_buildings/treasury': { bonusPerLevel: 0.05 },
            },
        };
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(text()).not.toContain('Base figures');
    });

    test('redrawing does not stack blocks', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);
        fire(root);
        fire(root);

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(2);
    });

    test('a tab with no trial cards draws nothing', () => {
        document.body.innerHTML = '<div class="GuildPanel_trialsContent__a">No trials in progress</div>';
        fire(document.querySelector('[class*="GuildPanel_trialsContent"]'));

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('a skilling card and a combat card are both handled on one tab', () => {
        fire(
            buildTab([
                { name: 'Trial Milking', level: 110, bar: '1,000 / 4,000' },
                { name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' },
            ])
        );

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(3);
    });

    test('cleanup removes everything it drew', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        trialsFeature.cleanup();

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        expect(game.observers['GuildPanel_trialsContent']).toBeUndefined();
        expect(game.wsHandlers['guild_trial_signup_updated']).toBeUndefined();
    });

    test('switching it off mid-session takes what it drew off the page', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        expect(document.querySelectorAll('.mwi-trial-info').length).toBeGreaterThan(0);

        // `_render` returns early on this setting and takes nothing down, so
        // without a listener the blocks sat there over a checkbox saying off
        flipSetting('guildTrialsInfo', false);

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('switching it back on draws again without a reload', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        flipSetting('guildTrialsInfo', false);

        flipSetting('guildTrialsInfo', true);
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        expect(document.querySelectorAll('.mwi-trial-info').length).toBeGreaterThan(0);
    });

    test('the feature stays out of the way when it is switched off', async () => {
        trialsFeature.cleanup();
        game.settings = { guildTrialsInfo: false };
        await trialsFeature.initialize();

        expect(game.observers['GuildPanel_trialsContent']).toBeUndefined();
        expect(guildTrials.initialized).toBe(false);
    });

    test('an open tab is sampled every five seconds, not whenever the DOM churns', () => {
        // The reported recording: two samples in forty minutes of a live trial
        // with the tab open and the pool ticking every second. A rate cannot be
        // fitted to that, and the tile said "measuring…" for the whole event.
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        const bar = root.querySelector('[class*="ProgressBar_text"]');

        for (let step = 1; step <= 6; step += 1) {
            bar.textContent = `${18_850 + step * 100} / 65,280`;
            vi.setSystemTime(now + step * 5000);
            vi.advanceTimersByTime(5000);
        }

        const samples = guildTrials.record.tiles['skilling::alchemy'].samples;
        expect(samples).toHaveLength(6);
        expect(samples[5].readings[0].current).toBe(19_450);
    });

    test('the sampler is running before the record has finished loading', async () => {
        // The ordering that made the above possible: everything below the first
        // `await` only exists once every promise above it settles, and the
        // sampler was below all of them. A tick that beats the load writes into
        // a fresh record, and the load merges into it rather than replacing it.
        trialsFeature.cleanup();
        game.store = {};

        const pending = trialsFeature.initialize();
        buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        vi.advanceTimersByTime(5000);

        expect(guildTrials.record.tiles['skilling::alchemy'].samples).toHaveLength(1);
        await pending;
        expect(guildTrials.record.tiles['skilling::alchemy'].samples).toHaveLength(1);
    });

    test('a sampler that has stopped is started again by the next tab event', () => {
        buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        vi.advanceTimersByTime(5000);
        expect(guildTrials.record.tiles['skilling::alchemy'].samples).toHaveLength(1);

        // Whatever killed it — a cleanup racing a re-initialisation, a
        // throttled background tab — the panel being drawn is proof it should
        // be running
        clearInterval(guildTrials.samplerId);
        vi.setSystemTime(now + 60_000);
        fire();

        vi.setSystemTime(now + 65_000);
        vi.advanceTimersByTime(5000);
        expect(guildTrials.record.tiles['skilling::alchemy'].samples.length).toBeGreaterThan(2);
    });

    test('the controls sit on the payout block and drive the recorder', () => {
        // The console command is no longer the only way in. The button calls the
        // same builder, so the two cannot drift apart.
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        const buttons = [...document.querySelectorAll('button')];
        const record = buttons.find((button) => button.textContent.includes('Record trial'));
        expect(record).toBeTruthy();

        record.click();
        expect(game.recorder.recording).toBe(true);
        expect(game.recorder.startedBy).toBe('button');

        // Redrawn, the same button is now the way to stop
        const stop = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Stop'));
        expect(stop).toBeTruthy();
        stop.click();
        expect(game.recorder.recording).toBe(false);
    });

    test('the export button downloads the same bundle the console helper returns', async () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));

        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Export')).click();
        await vi.advanceTimersByTimeAsync(0);

        expect(game.recorder.downloads).toEqual([{ exportedAt: 'now', bundle: true }]);
    });

    test('the per-player button opens the panel', () => {
        fire(buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]));
        [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Per-player')).click();

        expect(game.scoreboardToggles).toBe(1);
    });

    test('a live reading tells the recorder a trial is running', () => {
        fire(buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]));
        expect(game.recorder.activity).toContain('tab-reading');
    });

    test('the tab’s own footer stats are kept with the trial that produced them', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        const footer = document.createElement('div');
        footer.innerHTML = '<div>Work Time</div><div>3.14s</div><div>Success Rate</div><div>60.8%</div>';
        root.appendChild(footer);
        fire(root);

        expect(
            tilePersonalStats(guildTrials.record.tiles['skilling::alchemy'], game.characterId).personal
        ).toMatchObject({
            'Work Time': '3.14s',
            'Success Rate': '60.8%',
        });
    });

    test('an unchanged redraw does not touch the page', () => {
        // The reported "keeps scrolling to the top": the sampler redraws every
        // five seconds and the observer redraws on every React burst, and each
        // one used to tear the blocks out and put them back. A container whose
        // content changes height while you are partway down it gets scrolled
        // back to the top, every few seconds, forever.
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        // Two passes to settle: the second reading is what turns "measuring…"
        // into a rate, so the markup legitimately changes once
        fire(root);
        vi.setSystemTime(now + 5000);
        fire(root);

        const block = document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]');
        const payout = document.querySelector('.mwi-trial-info[data-mwi-block="payout"]');
        const firstChild = block.firstElementChild;
        const payoutChild = payout.firstElementChild;

        // Two more passes with nothing whatsoever changed
        fire(root);
        fire(root);

        // The very same elements, and the very same nodes inside them: an
        // assignment to `innerHTML` rebuilds the subtree even when the markup is
        // identical, and rebuilding is what moves the scroll
        expect(document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]')).toBe(block);
        expect(document.querySelector('.mwi-trial-info[data-mwi-block="payout"]')).toBe(payout);
        expect(block.firstElementChild).toBe(firstChild);
        expect(payout.firstElementChild).toBe(payoutChild);
    });

    test('a reading that has moved updates in place rather than being replaced', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        const block = document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]');

        root.querySelector('[class*="ProgressBar_text"]').textContent = '28,850 / 65,280';
        vi.setSystemTime(now + 10_000);
        fire(root);

        // Same element — the reader's place in the page is not disturbed — with
        // new figures in it
        expect(document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]')).toBe(block);
        expect(block.textContent).toContain('Fill rate');
    });

    test('the scroll position survives a block being inserted', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        // A scrolling container around the cards, which is what the guild panel is
        root.style.cssText = 'height:80px; overflow-y:auto;';
        Object.defineProperty(root, 'scrollTop', { value: 40, writable: true, configurable: true });

        fire(root);

        expect(root.scrollTop).toBe(40);
    });

    test('a trial that leaves the tab takes its block with it', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        expect(document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')).toHaveLength(1);

        // The player switches to a tab with a different trial on it
        const swapped = buildTab([{ name: 'Milking', level: 130, bar: '1,000 / 65,280' }]);
        fire(swapped);

        const keys = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')].map(
            (block) => block.dataset.mwiBlock
        );
        expect(keys).toEqual(['tile:skilling::milking']);
    });

    test('neither boss card wears the other fight’s per-player rows — because neither wears any', () => {
        // Originally reported as: Trial Hedgehog's panel — "0 pts, not
        // started" — showed "Per player · 2 fights · watched" with the
        // Chameleon fight's exact rows. One measurement, two combat cards,
        // and it landed on both. The boss-side block no longer renders the
        // per-player split at all (it moved to the dedicated Per-player
        // popup), so this now simply asserts neither card shows it — the
        // scoping itself is `breakdownFor`'s own test, below.
        game.breakdown = {
            measured: true,
            source: 'spectated',
            encounter: 'chameleon',
            bossName: 'Trial Chameleon',
            fights: 2,
            seconds: 100,
            partyDps: 2756,
            totalDamage: 275_600,
            players: [
                {
                    index: 'NPD',
                    name: 'NPD',
                    damage: 93_000,
                    dps: 930,
                    share: 34,
                    hits: 10,
                    crits: 1,
                    misses: 0,
                    accuracy: 1,
                    critRate: 0.1,
                    deaths: 0,
                    measured: true,
                },
            ],
            support: { players: [], unattributedHealing: 0 },
        };
        const root = buildTab(
            [
                { name: 'Trial Chameleon', level: 110, bar: '476,238 / 572,000' },
                { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
            ],
            'Combat Trial - In Progress — 42:15 remaining'
        );
        root.querySelectorAll('[class*="GuildPanel_tile"]')[1]
            .querySelectorAll('[class*="ProgressBar_text"]')
            .forEach((el) => el.remove());
        fire(root);

        const blocks = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')];
        const chameleon = blocks.find((block) => block.dataset.mwiBlock.includes('chameleon'));
        const hedgehog = blocks.find((block) => block.dataset.mwiBlock.includes('hedgehog'));

        expect(chameleon.textContent).not.toContain('NPD');
        expect(chameleon.textContent).not.toContain('2 fights');
        expect(hedgehog.textContent).not.toContain('NPD');
        expect(hedgehog.textContent).not.toContain('2 fights');
    });

    test('breakdownFor scopes the measurement, and keeps an unidentified one whole', () => {
        const measured = {
            measured: true,
            source: 'spectated',
            encounter: 'chameleon',
            bossName: 'Trial Chameleon',
            partyDps: 2756,
            players: [{ name: 'NPD' }],
            support: { players: [{ name: 'NPD' }], unattributedHealing: 5 },
        };

        expect(breakdownFor('Trial Chameleon', measured)).toBe(measured);

        const scoped = breakdownFor('Trial Hedgehog', measured);
        expect(scoped.measured).toBe(false);
        expect(scoped.players).toEqual([]);
        expect(scoped.partyDps).toBeNull();
        expect(scoped.support.players).toEqual([]);
        expect(scoped.support.unattributedHealing).toBe(5);
        expect(scoped.reason).toContain('Trial Chameleon');

        // A skilling tile never wears a fight's figures either — its fill
        // rate must not be compared against a combat DPS
        expect(breakdownFor('Crafting', measured).measured).toBe(false);

        // Unidentified measurements pass through: "click the boss to
        // identify" is already the honest caption for those
        const unnamed = { ...measured, encounter: null };
        expect(breakdownFor('Trial Hedgehog', unnamed)).toBe(unnamed);
    });

    test('a block stranded by a React re-parent follows its card', () => {
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);
        const card = root.querySelector('[class*="GuildPanel_tile__"]');
        const block = document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]');
        expect(block.previousElementSibling).toBe(card);

        // The game re-parents the card into a late-mounted column, leaving
        // the block where the card's first home was — the "detached block
        // below the payout" first-render screenshot
        const column = document.createElement('div');
        column.className = 'GuildPanel_sideColumn__x';
        root.appendChild(column);
        column.appendChild(card);
        expect(block.previousElementSibling).not.toBe(card);

        fire(root);
        expect(document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]')).toBe(block);
        expect(block.previousElementSibling).toBe(card);
    });

    test('a boss card remounting after a tier clear does not flip the panel order', () => {
        // Reported: after a tier cleared the view read [payout][DPS][boss
        // card] — the game tore the CombatUnit down and remounted it after
        // the blocks that were placed beside its predecessor
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);
        const oldCard = root.querySelector('[class*="GuildPanel_tile__"]');
        const block = document.querySelector('.mwi-trial-info[data-mwi-block^="tile:"]');
        const payout = document.querySelector('.mwi-trial-info[data-mwi-block="payout"]');

        // The remount: same trial, fresh node, appended after everything
        const fresh = oldCard.cloneNode(true);
        oldCard.remove();
        root.appendChild(fresh);
        expect(block.previousElementSibling).not.toBe(fresh);

        fire(root);

        // [payout] … [boss card] [per-player block], in that document order
        expect(block.previousElementSibling).toBe(fresh);
        const following = payout.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING;
        expect(following).toBeTruthy();
    });

    test('the card block is a block of its own, never inside the card', () => {
        // Appended into the card it sat on top of the game's own footer —
        // "Completed", "1/28 signed up" — because a card places its last rows
        // against its bottom edge rather than after whatever it contains
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        const card = root.querySelector('[class*="GuildPanel_tile__"]');
        const block = [...document.querySelectorAll('.mwi-trial-info')].find((el) => el.textContent.includes('Banked'));

        expect(card.contains(block)).toBe(false);
        expect(block.previousElementSibling).toBe(card);
        expect(block.style.position).toBe('static');
    });

    test('a record the panel contradicts is archived, without anyone clearing anything', async () => {
        // The reported failure after the keying fix: the poisoned record was
        // already on disk under the *new* guild's own key, so nothing about
        // provenance could reach it. The page could — it was saying "Scheduled"
        // with every card at 0 pts while the block above claimed banked tiers.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'New Guild';
        game.store = {};
        await trialsFeature.initialize();

        // A cycle's worth of readings, as an older build would have left them
        guildTrials.record = {
            weekStart: guildTrials.record.weekStart,
            tiles: {
                'skilling::milking': {
                    name: 'Milking',
                    kind: 'skilling',
                    tier: 6,
                    pointsByTier: { 6: 840 },
                    samples: [{ t: now - 60_000, readings: [{ current: 100, max: 200 }] }],
                    tiers: [],
                },
            },
        };

        // The panel the user actually has: scheduled, and every card at nothing
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Scheduled Wed 04:00 PM 2h 24m</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Milking</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.130</div><div>0 pts</div>' +
            '<div>1/22 signed up</div></div>';
        document.body.appendChild(root);
        fire();

        // The phantom cycle is gone from the record and from the screen — and
        // kept, because the figures were real when they were taken
        // The old cycle's tier and its 840 are gone; what is left is what this
        // cycle's card actually states, which is nothing yet
        expect(guildTrials.record.tiles['skilling::milking']?.pointsByTier?.[6]).toBeUndefined();
        expect(guildTrials.record.tiles['skilling::milking']?.samples).toEqual([]);
        expect(guildTrials.record.history).toHaveLength(1);
        expect(guildTrials.record.history[0].tiles['skilling::milking'].pointsByTier).toEqual({ 6: 840 });
        expect(text()).not.toContain('840');
        expect(text()).not.toContain('Banked5 tiers');
    });

    describe('the record cannot be wiped by a failed read or a stale copy', () => {
        const KEY = 'guildTrials_Milky Way';
        const sample = (t) => ({ t, readings: [{ current: t % 1000, max: 4000 }] });
        const storedRecord = (times) => ({
            weekStart: trialWeekStart(now),
            guildName: 'Milky Way',
            tiles: {
                'skilling::milking': {
                    name: 'Milking',
                    kind: 'skilling',
                    tier: 2,
                    samples: times.map(sample),
                    tiers: [],
                },
            },
        });
        const storedTimes = () => (game.store[KEY]?.tiles['skilling::milking']?.samples || []).map((s) => s.t);
        const memoryTimes = () => (guildTrials.record?.tiles['skilling::milking']?.samples || []).map((s) => s.t);

        beforeEach(async () => {
            // The guild name is a fixture field earlier tests move; this block
            // is about one guild's record under its own key
            trialsFeature.cleanup();
            game.guildName = 'Milky Way';
            game.characterId = null;
            resetTrialsSingleton();
            await trialsFeature.initialize();
        });

        test('a load while storage is unavailable keeps the record in hand rather than starting the week over', async () => {
            trialsFeature.cleanup();
            game.store[KEY] = storedRecord([now - 20_000]);
            game.unavailable = true;
            await trialsFeature.initialize();

            // Nothing could be read, and nothing in hand: no fresh week invented
            // that a save could write back over the stored one
            expect(guildTrials.record).toBeNull();
            expect(guildTrials.recordUnread).toBe(true);

            // A tick records, and its save is refused while storage is dark
            buildTab([{ name: 'Milking', level: 110, bar: '1,000 / 4,000' }]);
            fire();
            await vi.advanceTimersByTimeAsync(10);
            expect(memoryTimes()).toEqual([now]);
            expect(storedTimes()).toEqual([now - 20_000]);
        });

        test('a save merges what is stored under the record in hand, so another writer’s samples survive', async () => {
            // Samples this tab never loaded: another tab's, written in between
            game.store[KEY] = storedRecord([now - 20_000]);
            guildTrials.record = storedRecord([now - 10_000]);

            // The singleton remembers its last save across tests; this one is due
            guildTrials.lastRecordSaveAt = 0;
            buildTab([{ name: 'Milking', level: 110, bar: '1,000 / 4,000' }]);
            fire();
            await vi.advanceTimersByTimeAsync(10);

            expect(storedTimes()).toEqual([now - 20_000, now - 10_000, now]);
        });

        test('once storage is back, the next save folds the stored record in and lands everything', async () => {
            trialsFeature.cleanup();
            game.store[KEY] = storedRecord([now - 20_000]);
            game.unavailable = true;
            await trialsFeature.initialize();
            buildTab([{ name: 'Milking', level: 110, bar: '1,000 / 4,000' }]);
            fire();
            await vi.advanceTimersByTimeAsync(10);
            expect(storedTimes()).toEqual([now - 20_000]);

            game.unavailable = false;
            vi.setSystemTime(now + 5_000);
            fire();
            await vi.advanceTimersByTimeAsync(10);

            expect(storedTimes()).toEqual([now - 20_000, now, now + 5_000]);
            // And the record in hand has learned what was on disk all along
            expect(memoryTimes()).toEqual([now - 20_000, now, now + 5_000]);
            expect(guildTrials.recordUnread).toBe(false);
        });

        test('archiving a cycle is the one save that may lose tiles, and a stale copy cannot bring them back', async () => {
            guildTrials.record = storedRecord([now - 20_000]);
            guildTrials.lastRecordSaveAt = 0;
            game.store[KEY] = storedRecord([now - 20_000]);

            document.body.innerHTML = '';
            const root = document.createElement('div');
            root.className = 'GuildPanel_trialsContent__a';
            root.innerHTML =
                '<div class="GuildPanel_eventStatusRow__b">Scheduled Wed 04:00 PM 2h 24m</div>' +
                '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Milking</div>' +
                '<div class="GuildPanel_tileSummary__e">Lv.130</div><div>0 pts</div></div>';
            document.body.appendChild(root);
            fire();
            await vi.advanceTimersByTimeAsync(10);

            expect(game.store[KEY].tiles['skilling::milking']).toBeUndefined();
            expect(game.store[KEY].history).toHaveLength(1);

            // A tab that never archived writes its copy: the tile stays archived
            await saveTrialRecord('Milky Way', storedRecord([now - 20_000]));
            expect(game.store[KEY].tiles['skilling::milking']).toBeUndefined();
            expect(game.store[KEY].history).toHaveLength(1);
        });
    });

    test('nothing is drawn on the guild Overview tab', () => {
        // Reported from the user's main guild: the payout block and a side block
        // sat over the Overview tab's notice board, on a page with no trial
        // cards at all
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="TabsComponent_tab__x TabsComponent_selected__y">Overview</div>' +
            '<div class="GuildPanel_notice__n">Welcome! We are milking at Level 90 if anyone wants to join.</div>' +
            '<div class="GuildPanel_dataBlock__d"><div>Exp to Next Level</div><div>4,120 / 20,000</div></div>' +
            '</div>';
        fire();

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        expect(text()).not.toContain('Trial payout');
    });

    test('blocks drawn on the trials tab do not survive the switch away from it', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        expect(document.querySelectorAll('.mwi-trial-info').length).toBeGreaterThan(0);

        // The player clicks Overview. The root finder now answers with a
        // different element, so a block left under the old one would never be
        // looked at again — it would simply stay on screen
        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__r">' +
            '<div class="TabsComponent_tab__x TabsComponent_selected__y">Overview</div>' +
            '<div class="GuildPanel_dataBlock__d"><div>Exp to Next Level</div><div>4,120 / 20,000</div></div></div>';
        fire();

        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('a reading on a tab with no header of its own still arms the recorder', () => {
        // The live failure: the status header is on the Trials tab and the
        // readings are on the In Progress one, so requiring both meant
        // auto-record never armed and the user pressed Record by hand
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        root.querySelector('[class*="GuildPanel_eventStatusRow"]')?.remove();
        fire(root);

        expect(game.recorder.activity).toContain('tab-reading');
    });

    test('during the skilling hour a combat card waits rather than pretending to run', () => {
        // Reported: the Trial Chameleon card rendered "Rate: measuring…" and
        // "Banked: nothing yet — tier 1 in progress" during the skilling hour.
        // The header says which kind it is about.
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="ProgressBar_text__f">876 / 40,800</div></div>' +
            '<div class="GuildPanel_tile__d"><div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.100</div></div>';
        document.body.appendChild(root);
        fire();

        const blocks = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')];
        const chameleon = blocks.find((block) => block.dataset.mwiBlock.includes('chameleon'));
        const foraging = blocks.find((block) => block.dataset.mwiBlock.includes('foraging'));

        expect(chameleon.textContent).toContain('scheduled');
        expect(chameleon.textContent).not.toContain('measuring');
        expect(chameleon.textContent).not.toContain('nothing yet');
        // …while the kind that is running is live as ever
        expect(foraging.textContent).toContain('Rate');
    });

    test('a combat card that has not started claims no banked tier', () => {
        // Reported from the new build: both combat cards read "Banked: 1 tier"
        // during the skilling hour, on cards stating 0 pts. A card at its own
        // base level with nothing stated has banked nothing.
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="ProgressBar_text__f">876 / 40,800</div></div>' +
            '<div class="GuildPanel_tile__d"><div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.100</div><div>0 pts</div></div>';
        document.body.appendChild(root);
        fire();

        const chameleon = [...document.querySelectorAll('.mwi-trial-info[data-mwi-block^="tile:"]')].find((block) =>
            block.dataset.mwiBlock.includes('chameleon')
        );

        expect(chameleon.textContent).not.toContain('Banked');
        expect(chameleon.textContent).not.toContain('measuring');
        expect(chameleon.textContent).toContain('scheduled');

        // …and it contributes nothing to the payout either
        expect(text()).toContain('Guild Points banked');
        expect(text()).not.toContain('Guild Points banked400');
    });

    test('the payout is the week’s, whichever tab is open', () => {
        // Reported: the Trials tab read "banked 2,714" while the In Progress tab
        // read "banked 472" at the same moment, because each summed the cards it
        // could see
        const trialsTab = buildTrialsTabFor('Alchemy', 170, 1080);
        fire(trialsTab);
        const fromTrialsTab = text().match(/Guild Points banked([\d,]+)/)?.[1];
        expect(fromTrialsTab).toBeTruthy();

        // Now the In Progress tab, which shows only the running pool
        document.body.innerHTML = '';
        const live = document.createElement('div');
        live.className = 'GuildPanel_trialsContent__a';
        live.innerHTML =
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(live);
        vi.setSystemTime(now + 5000);
        fire();

        expect(text().match(/Guild Points banked([\d,]+)/)?.[1]).toBe(fromTrialsTab);
    });

    test('the live pool files under the tier being fought, not the badge', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.110</div><div>354 pts</div>' +
            '<div class="ProgressBar_text__f">24,382 / 48,960</div></div>';
        document.body.appendChild(root);
        fire();

        const tile = guildTrials.record.tiles['skilling::foraging'];
        // Lv.110 badges T2, so 48,960 is T3's pool
        expect(tile.tier).toBe(2);
        expect(tile.tiers).toEqual([{ tier: 3, total: 48_960 }]);
    });

    test('the first pool of a live trial is filed under tier one', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 04:00 PM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Foraging</div>' +
            '<div class="ProgressBar_text__f">876 / 40,800</div></div>';
        document.body.appendChild(root);
        fire();

        const tile = guildTrials.record.tiles['skilling::foraging'];
        // No badge yet, so the reading is the first tier's
        expect(tile.tiers).toEqual([{ tier: 1, total: 40_800 }]);
    });

    test('a panel that says the cycle is over vetoes it', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - Completed Thu 09:00 AM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(root);
        fire();

        expect(game.recorder.activity).not.toContain('tab-reading');
    });

    test('a reading on a running trial does start one', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">In Progress — 42:15 remaining</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(root);
        fire();

        expect(game.recorder.activity).toContain('tab-reading');
        expect(game.recorder.lifecycle).toContain('live');
    });

    test('the legacy shared bucket is purged at startup', async () => {
        trialsFeature.cleanup();
        game.store = { guildTrials_default: { weekStart: 1, tiles: { a: {} } } };
        await trialsFeature.initialize();
        await vi.advanceTimersByTimeAsync(0);

        // One bucket for every character in the tab is what poisoned a guild's
        // record in the first place
        expect(game.store.guildTrials_default).toBeUndefined();
    });

    test('a live trial whose cards are still at zero is not mistaken for a stale record', () => {
        // The guard on the guard: a running trial routinely shows 0 pts before
        // the first tier clears, so "0 pts" alone must not throw anything away
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        fire(root);
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeTruthy();

        vi.setSystemTime(now + 5000);
        fire(root);

        expect(guildTrials.record.tiles['skilling::alchemy'].samples.length).toBeGreaterThan(1);
        expect(guildTrials.record.history || []).toHaveLength(0);
    });

    /**
     * An archived cycle, as `archiveCycle` leaves one in `record.history`.
     * @param {Object} overrides - Fields to override
     * @returns {Object} The cycle
     */
    const archivedWeek = (overrides = {}) => ({
        archivedAt: now - 5 * 24 * 60 * 60 * 1000,
        reason: 'a new cycle is scheduled',
        weekStart: trialWeekStart(now) - 7 * 24 * 60 * 60 * 1000,
        tiles: {
            'combat::trial chameleon': {
                name: 'Trial Chameleon',
                kind: 'combat',
                tier: 5,
                points: 960,
                pointsByTier: { 5: 960 },
                completed: true,
                samples: [],
                tiers: [],
            },
            'skilling::milking': {
                name: 'Milking',
                kind: 'skilling',
                tier: 6,
                points: 840,
                pointsByTier: { 6: 840 },
                completed: true,
                samples: [],
                tiers: [],
            },
        },
        ...overrides,
    });

    test('archived cycles come back as one “Past weeks” line each, newest first', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        guildTrials.record = {
            ...guildTrials.record,
            history: [
                archivedWeek({
                    weekStart: trialWeekStart(now) - 14 * 24 * 60 * 60 * 1000,
                    tiles: {
                        'combat::trial hedgehog': {
                            name: 'Trial Hedgehog',
                            kind: 'combat',
                            points: 0,
                            completed: true,
                            pointsByTier: {},
                            samples: [],
                            tiers: [],
                        },
                    },
                }),
                archivedWeek(),
            ],
        };
        fire(root);

        expect(text()).toContain('Past weeks');
        // No building level has been seen, so the token figure is a dash — the
        // stated points are repeated exactly as the cards said them
        expect(text()).toContain('Last week · combat T5 · skilling T6 · 1,800 pts · — tokens each');
        // A failed week is a real outcome and prints its zeros, and the half
        // that never stated anything is a dash rather than one of them
        expect(text()).toContain('2 weeks ago · combat T0 · skilling — · 0 pts · — tokens each');
        // Newest first
        expect(text().indexOf('Last week')).toBeLessThan(text().indexOf('2 weeks ago'));
    });

    test('a past week’s tokens are derived once the buildings are known, and marked as derived', () => {
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        guildTrials.record = { ...guildTrials.record, history: [archivedWeek()] };
        fire(root);

        // 1,800 stated ÷ 1.2 is 1,500 base; half of it at +10% Treasury is 825
        expect(text()).toContain('~825 tokens each');
    });

    test('a week archived off another guild’s record is labelled, not mixed in', () => {
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        guildTrials.record = {
            ...guildTrials.record,
            history: [archivedWeek({ reason: 'belongs to another guild' })],
        };
        fire(root);

        expect(text()).toContain('another guild’s week');
        // …and this guild's buildings are never applied to it
        expect(text()).not.toContain('~825');
    });

    test('no history renders no “Past weeks” header at all', () => {
        fire(buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]));
        expect(text()).not.toContain('Past weeks');
    });

    test('the In Progress view never draws “Past weeks” — past cycles are the Trials tab’s', () => {
        const root = buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        // The live skilling row marks the In Progress view; on the Trials tab it
        // does not exist. The block used to land at the top of this view,
        // stretched by its layout into an empty box over the live cards.
        const challenge = document.createElement('div');
        challenge.className = 'SkillingInstancePanel_challengeArea__x';
        root.appendChild(challenge);
        guildTrials.record = { ...guildTrials.record, history: [archivedWeek()] };
        fire(root);

        expect(text()).not.toContain('Past weeks');
    });

    test('a finished cycle stops projecting a future', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Completed Thu 09:00 AM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.170</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div></div>';
        document.body.appendChild(root);

        fire();
        root.querySelector('[class*="ProgressBar_text"]').textContent = '28,850 / 65,280';
        vi.setSystemTime(now + 10_000);
        fire();

        // The rate is still shown — it happened — but nothing is projected from it
        expect(text()).toContain('Final fill rate');
        expect(text()).not.toContain('Tier clears in');
        expect(text()).not.toContain('On pace for');
    });

    test('the lifecycle is passed to the alerts', () => {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Scheduled Wed 04:00 PM 2h 24m</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Milking</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.130</div><div>0 pts</div></div>';
        document.body.appendChild(root);
        fire();

        expect(game.alerts.status.at(-1)).toMatchObject({
            phase: 'scheduled',
            startsInMs: 2 * 3600_000 + 24 * 60_000,
        });
    });

    test('switching character in the same tab leaves nothing of the old one behind', async () => {
        // Live-tested and reported: a fresh character in a different guild was
        // shown the previous guild's finished trial — "Guild Points banked
        // 2,880" beside a header reading 0, and a warning that judged the old
        // record's 840 pts against the new guild's Builder's Hall level.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'Old Guild';
        game.store = {};
        await trialsFeature.initialize();

        fire(buildTab([{ name: 'Alchemy', level: 170, bar: '18,850 / 65,280' }]));
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeTruthy();
        expect(game.trialNames).toBeDefined();

        // The switch message arrives before the arriving character's own data,
        // so every source of a guild name still answers with the old one
        game.characterId = 111;
        game.dmHandlers.character_switching.forEach((handler) => handler({ oldId: 111, newId: 222 }));
        await vi.advanceTimersByTimeAsync(0);

        // Nothing of the old character's survives, on screen or in hand
        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        expect(guildTrials.guildName).toBeNull();
        expect(guildTrials.record?.tiles?.['skilling::alchemy']).toBeUndefined();
        expect(game.trialNames).toEqual([]);
        expect(game.recorder.forgotten).toBe(true);

        // And the old guild's name is not adopted while the ids still disagree
        expect(guildTrials._resolveGuildName()).toBeNull();

        // Once the arriving character's data lands, it is their own guild
        game.characterId = 222;
        game.guildName = 'New Guild';
        expect(guildTrials._resolveGuildName()).toBe('New Guild');
    });

    test('a character switch clears the skilling socket cache, so the arriving guild’s bar cannot bounce against the departing one’s', async () => {
        // Reported live: "Fill rate" and the bar's own current/max flipped
        // between two values, repeatedly, over a long session running several
        // alts — and a page refresh cured it. `guild-trial-skilling.js` keeps
        // its last `guild_skilling_updated` reading per trial *name only* —
        // no guild or character scoping — and `_withSocketSkilling` grafts
        // that cached reading onto any card whose own bar the DOM has not
        // drawn yet (a card that has just mounted, or one caught between
        // renders). Without a reset on the switch, the departing character's
        // guild's own "Alchemy" pool — a completely different trial, at a
        // completely different size — kept answering for up to fifteen
        // seconds after the arriving character's, so a render that caught the
        // bar-less moment drew the old guild's number, and the very next
        // render, once the DOM had painted, drew the real one: two figures
        // for the one card, alternating.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'Old Guild';
        game.store = {};
        await trialsFeature.initialize();

        // Old Guild's own Alchemy trial, mid-run and nothing like New Guild's
        game.skilling.alchemy = {
            trial: { kind: 'skilling', key: 'alchemy', name: 'Alchemy' },
            tier: 9,
            reading: { current: 120_000, max: 400_000 },
            personal: {},
            participantIds: [111],
            at: now,
        };
        fire(buildTab([{ name: 'Alchemy', level: 170, bar: '120,000 / 400,000' }]));
        expect(guildTrials.record.tiles['skilling::alchemy'].samples.at(-1).readings[0]).toEqual({
            current: 120_000,
            max: 400_000,
        });

        game.dmHandlers.character_switching.forEach((handler) => handler({ oldId: 111, newId: 222 }));
        await vi.advanceTimersByTimeAsync(0);
        game.characterId = 222;
        game.guildName = 'New Guild';

        // The cache is gone the moment the old character leaves — proof the
        // reset ran rather than an accident of timing
        expect(game.skillingResets).toBeGreaterThan(0);
        expect(game.skilling.alchemy).toBeUndefined();

        // New Guild's own Alchemy card, caught before its bar has painted —
        // exactly the moment `_withSocketSkilling` is free to fill in from
        // the cache
        const root = buildTab([{ name: 'Alchemy', level: 40, bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        // Nothing of Old Guild's pool reached the new character's card
        const tile = guildTrials.record.tiles['skilling::alchemy'];
        const reading = tile?.samples?.at(-1)?.readings?.[0];
        expect(reading).not.toEqual({ current: 120_000, max: 400_000 });
    });

    test('a guild switch clears the captured Trial Stats modal, so a same-named trial cannot inherit the old guild’s member figures', async () => {
        // Same class of leak as the skilling socket cache: guild-trial-stats-modal.js
        // keys its capture of the game's own post-trial "Combat Trial Stats" modal
        // by trial NAME alone ("Trial Chameleon"), with no guild or character
        // scoping. Two guilds running the same combat trial in the same week is
        // routine, and the scoreboard's reconciliation reads straight off this
        // cache by trial name — so a guild switch that leaves it standing hands
        // the new guild's scoreboard the old guild's captured member totals under
        // names that mean nothing there.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'Testmaxxing';
        game.store = {};
        await trialsFeature.initialize();

        guildTrialStatsModal.statsByTrial.set('Trial Chameleon', {
            kind: 'combat',
            columns: ['damage', 'healing', 'damageTaken'],
            members: [{ name: 'OldGuildMember', values: { damage: 999, healing: 0, damageTaken: 0 } }],
            at: now,
        });

        game.guildName = 'SuperMoo';
        fire(buildTab([{ name: 'Milking', level: 130, bar: '0 / 65,280' }]));
        await vi.advanceTimersByTimeAsync(0);

        expect(guildTrials.guildName).toBe('SuperMoo');
        expect(guildTrialStatsModal.getStats('Trial Chameleon')).toBeNull();
    });

    test('a character switch clears the captured Trial Stats modal cache', async () => {
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'Old Guild';
        game.store = {};
        await trialsFeature.initialize();

        guildTrialStatsModal.statsByTrial.set('Trial Chameleon', {
            kind: 'combat',
            columns: ['damage', 'healing', 'damageTaken'],
            members: [{ name: 'OldGuildMember', values: { damage: 999, healing: 0, damageTaken: 0 } }],
            at: now,
        });

        game.dmHandlers.character_switching.forEach((handler) => handler({ oldId: 111, newId: 222 }));
        await vi.advanceTimersByTimeAsync(0);
        game.characterId = 222;
        game.guildName = 'New Guild';

        expect(guildTrialStatsModal.getStats('Trial Chameleon')).toBeNull();
    });

    test('the fresh character draws its own empty state, not the last one’s', async () => {
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = null;
        game.store = {};
        await trialsFeature.initialize();

        // Character A banks a trial
        buildTrialsTabFor('Alchemy', 170, 1080);
        fire();
        expect(text()).toContain('Guild Points banked');

        game.dmHandlers.character_switching.forEach((handler) => handler({ oldId: 111, newId: 222 }));
        game.characterId = 222;
        await vi.advanceTimersByTimeAsync(0);

        // Character B's guild has run nothing: its cards state nothing, and the
        // panel must say nothing rather than the previous guild's total
        buildTrialsTabFor('Milking', 130, 0);
        fire();

        expect(text()).not.toContain('1,080');
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeUndefined();
    });

    test('the guild name is taken off a guild message when the XP tracker never saw one', async () => {
        // Reported: every session filed its samples under `guildTrials_default`
        // because the tracker answered null all the way through — it can be
        // switched off, and it only ever learns the name from traffic it may not
        // have received.
        trialsFeature.cleanup();
        game.guildName = null;
        game.store = {};
        await trialsFeature.initialize();

        buildTab([{ name: 'Alchemy', level: 130, bar: '18,850 / 65,280' }]);
        game.wsHandlers.guild_updated({ guild: { name: 'Milky Way', experience: 10 } });
        await vi.advanceTimersByTimeAsync(0);

        expect(guildTrials.guildName).toBe('Milky Way');
        expect(Object.keys(game.store)).toContain('guildTrials_Milky Way');
        game.guildName = 'Milky Way';
    });

    test('changing guild without changing character does not carry the tiles across', async () => {
        // The same leak as the loadouts one, one module over: `_adoptGuildName`
        // merged whatever was in hand onto the arriving guild's key, and its
        // only guard was that the name had changed — which is exactly what a
        // guild switch is
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = 'Testmaxxing';
        game.store = {};
        await trialsFeature.initialize();

        fire(buildTab([{ name: 'Alchemy', level: 170, bar: '18,850 / 65,280' }]));
        await vi.advanceTimersByTimeAsync(0);
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeTruthy();

        game.guildName = 'SuperMoo';
        fire(buildTab([{ name: 'Milking', level: 130, bar: '0 / 65,280' }]));
        await vi.advanceTimersByTimeAsync(0);

        expect(guildTrials.guildName).toBe('SuperMoo');
        expect(guildTrials.record.tiles['skilling::alchemy']).toBeUndefined();
        expect(game.store['guildTrials_SuperMoo']?.tiles?.['skilling::alchemy']).toBeUndefined();
    });

    test('a character switch during the guild adoption read does not merge one guild into another', async () => {
        // `_adoptGuildName`'s read is a storage round trip and it had no
        // re-check on the far side. A switch landing inside it folded the
        // departing character's guild record into the arriving character's —
        // and stamped it with the departing guild's name, which is what the
        // `foreign` provenance check on the next load reads as "own", so
        // nothing downstream ever discards it again.
        trialsFeature.cleanup();
        game.characterId = 111;
        game.guildName = null;
        game.store = {};
        await trialsFeature.initialize();

        game.store['guildTrials_Testmaxxing'] = {
            weekStart: trialWeekStart(now),
            guildName: 'Testmaxxing',
            tiles: { 'skilling::alchemy': { name: 'Alchemy', kind: 'skilling', samples: [] } },
        };
        game.guildName = 'Testmaxxing';

        let release;
        game.holds['guildTrials_Testmaxxing'] = new Promise((resolve) => {
            release = resolve;
        });

        const adopting = guildTrials._adoptGuildName();
        await Promise.resolve();

        game.characterId = 222;
        game.guildName = null;
        guildTrials._forgetCharacter(222);

        release();
        await adopting;
        await vi.advanceTimersByTimeAsync(0);

        expect(guildTrials.guildName).toBeNull();
        expect(guildTrials.record?.tiles?.['skilling::alchemy']).toBeUndefined();
    });

    test('a character switch drops the departing guild’s socket reading of its trials', async () => {
        // `currentTrialsData` off `guild_updated` is the one trial signal that
        // does not need the panel open, and `_trialBudgetMs` counts its stated
        // budget down from when it arrived. Carried across a switch it is the
        // guild that has just been left: the arriving character's card draws
        // that guild's hour ticking away, and stops only once the hour it
        // stated would have elapsed. `socketPhase` says a trial is live for as
        // long as the page says nothing to the contrary.
        guildTrials.currentTrials = { combat: { inProgress: true, budgetRemainingMs: 600_000 }, at: now };
        guildTrials.socketPhase = 'live';
        guildTrials.lastForecast = { tier: 3, points: 900 };

        guildTrials._forgetCharacter(222);

        expect(guildTrials.currentTrials).toBeNull();
        expect(guildTrials.socketPhase).toBeNull();
        expect(guildTrials.lastForecast).toBeNull();
        expect(guildTrials._trialBudgetMs('combat', now)).toBeNull();
    });

    test('a watched fight feeds the pool to a card the game draws no bar on', async () => {
        // The Trials tab's combat card carries a level and no bar at all, so
        // every projection said "measuring…" for the whole hour. The spectator
        // stream states the same pool to the unit, and the tier with it
        game.breakdown = { pool: { current: 454_807, max: 618_000, tier: 2, at: now, encounter: 'chameleon' } };
        const root = buildTab([{ name: 'Trial Chameleon', level: 110, points: 400, bar: '' }]);
        root.querySelector('[class*="ProgressBar_text"]').remove();
        fire(root);

        game.breakdown = {
            pool: { current: 453_402, max: 618_000, tier: 2, at: now + 10_000, encounter: 'chameleon' },
        };
        vi.setSystemTime(now + 10_000);
        fire(root);

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.samples.length).toBeGreaterThan(1);
        // The tier is the stream's own, not the badge plus one
        expect(record.tiers.some((entry) => entry.tier === 2 && entry.total === 618_000)).toBe(true);
        expect(text()).toContain('Party DPS');
    });

    test('a composite fight (Trial Swarm) with no card of its own stands a tile in over the monsters area', () => {
        // Trial Swarm draws four separately named monster cards, none a trial
        // name, so the In Progress tab has no Swarm card. A watched swarm pool
        // plus the fight view's monsters area is enough to stand one in.
        game.breakdown = {
            pool: { current: 246_735, max: 270_400, tier: 3, at: now, encounter: 'swarm' },
            trialNames: ['Trial Swarm'],
        };
        const root = buildTab([]);
        const monsters = document.createElement('div');
        monsters.className = 'BattlePanel_monstersArea__x';
        root.appendChild(monsters);

        fire();

        // The stand-in records the swarm fight the same way the Trials tab would,
        // and a panel is drawn over the monsters area.
        expect(guildTrials.record.tiles['combat::trial swarm']?.samples.length).toBeGreaterThan(0);
        expect(document.querySelector('.mwi-trial-info')).not.toBeNull();
    });

    test('a stale pool stops standing in, rather than reading as a rate of zero', async () => {
        game.breakdown = {
            pool: { current: 454_807, max: 618_000, tier: 2, at: now - 60_000, encounter: 'chameleon' },
        };
        const root = buildTab([{ name: 'Trial Chameleon', level: 110, points: 400, bar: '' }]);
        root.querySelector('[class*="ProgressBar_text"]').remove();
        fire(root);

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.samples).toHaveLength(0);
    });

    test('a card the game is drawing a bar on keeps its own numbers', async () => {
        // Two sources must never disagree on screen
        game.breakdown = { pool: { current: 1, max: 618_000, tier: 2, at: now, encounter: 'chameleon' } };
        const root = buildTab([{ name: 'Trial Chameleon', level: 140, bar: '618,000 / 618,000' }]);
        fire(root);

        const record = guildTrials.record.tiles['combat::trial chameleon'];
        expect(record.samples[0].readings[0]).toMatchObject({ current: 618_000 });
    });

    test('with two combat trials the watched pool goes to one card, not both', async () => {
        // Reported: a week with two combat trials, both cards barless, and the
        // Chameleon fight's pool was injected into the Hedgehog card too — so
        // the guild report read "Trial Hedgehog — cleared 0 tiers … 490,871 of
        // 721,000 HP left" about a fight nobody had with a hedgehog
        game.breakdown = { pool: { current: 490_871, max: 721_000, tier: 3, at: now, encounter: 'chameleon' } };
        const root = buildTab([
            { name: 'Trial Chameleon', level: 120, points: 944, bar: '' },
            { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
        ]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const chameleon = guildTrials.record.tiles['combat::trial chameleon'];
        const hedgehog = guildTrials.record.tiles['combat::trial hedgehog'];

        expect(chameleon.samples.length).toBeGreaterThan(0);
        expect(chameleon.tiers.some((entry) => entry.tier === 3 && entry.total === 721_000)).toBe(true);
        // And the trial nobody watched stays empty rather than inheriting it
        expect(hedgehog.samples).toHaveLength(0);
        expect(hedgehog.tiers).toEqual([]);
    });

    test('an unidentified fight attaches to no card at all', async () => {
        // Better "no data" on both than the right number on the wrong trial
        game.breakdown = { pool: { current: 490_871, max: 721_000, tier: 3, at: now, encounter: null } };
        const root = buildTab([
            { name: 'Trial Chameleon', level: 120, points: 944, bar: '' },
            { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
        ]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        expect(guildTrials.record.tiles['combat::trial chameleon'].samples).toHaveLength(0);
        expect(guildTrials.record.tiles['combat::trial hedgehog'].samples).toHaveLength(0);
    });

    test('the guild report is about the trial that was watched', async () => {
        game.breakdown = {
            source: 'spectated',
            pool: { current: 490_871, max: 721_000, tier: 3, at: now, encounter: 'chameleon' },
        };
        const root = buildTab([
            // Chameleon has banked two tiers; Hedgehog has banked nothing and
            // sorts later, so it used to win the context by being last
            { name: 'Trial Chameleon', level: 110, points: 708, bar: '' },
            { name: 'Trial Hedgehog', level: 100, points: 0, bar: '' },
        ]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        expect(game.scoreboardContext?.trialName).toBe('Trial Chameleon');
        expect(game.scoreboardContext?.tiersCleared).toBe(2);
    });

    /**
     * The In Progress tab: a bar, and the footer of stats beneath it.
     * @param {boolean} [live] - Whether the card still carries a bar
     * @returns {Element} The tab
     */
    function buildInProgress(live = true) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress 42:15 remaining</div>' +
            '<div class="GuildPanel_tile__c">' +
            '<div class="GuildPanel_tileName__d">Foraging</div>' +
            // Between tiers the bar is gone and the card is a name and its points
            (live
                ? '<div class="ProgressBar_text__f">20,500 / 57,120</div>'
                : '<div class="Card_points__p">590 pts</div>') +
            '</div>' +
            '<div class="GuildPanel_footer__g">' +
            '<div>Work Power</div><div>146</div>' +
            '<div>Success Rate</div><div>49.6%</div>' +
            // The per-minute session log the game draws beside them
            '<div>59m</div><div>5s</div>' +
            '<div>1m</div><div>3s</div>' +
            '<div>Time</div><div>1s</div>' +
            '</div>';
        document.body.appendChild(root);
        return root;
    }

    /** Seed the record as the Trials tab would have left it */
    function seedForaging(extra = {}) {
        guildTrials.record.tiles['skilling::foraging'] = {
            name: 'Foraging',
            kind: 'skilling',
            level: 130,
            tier: 4,
            points: 590,
            pointsByTier: { 1: 236, 2: 354, 3: 472, 4: 590 },
            samples: [],
            tiers: [],
            ...extra,
        };
    }

    test('a stats read during a tier lands under that tier', async () => {
        // Reported from two exports: `personal` had 61 entries and
        // `personalByTier` was empty for the whole trial, so the success-decline
        // model — which is built from exactly this — had nothing to fit
        const root = buildInProgress();
        seedForaging();
        fire(root);

        const tile = tilePersonalStats(guildTrials.record.tiles['skilling::foraging'], game.characterId);
        // Four banked, so the readings are the fifth tier's
        expect(tile.personalByTier['5']).toMatchObject({ 'Success Rate': '49.6%' });
        expect(tile.personal['Success Rate']).toBe('49.6%');
    });

    test('a stats read on a card with no bar still lands under the banked tier', async () => {
        // The join used to ride on the *reading's* tier, which is null the
        // moment a card stops being live — so a footer read between tiers, or
        // after the hour, went nowhere
        const root = buildInProgress(false);
        seedForaging();
        fire(root);

        const tile = tilePersonalStats(guildTrials.record.tiles['skilling::foraging'], game.characterId);
        expect(tile.personalByTier['4']).toMatchObject({ 'Success Rate': '49.6%' });
    });

    test('the per-minute time list is not a stat sheet', async () => {
        // The exact junk from the export: "59m": "5s" … "1m": "3s", "Time": "1s"
        const root = buildInProgress();
        seedForaging();
        fire(root);

        const tile = tilePersonalStats(guildTrials.record.tiles['skilling::foraging'], game.characterId);
        expect(Object.keys(tile.personal)).toEqual(['Work Power', 'Success Rate']);
        expect(tile.personal['59m']).toBeUndefined();
        expect(tile.personal['1m']).toBeUndefined();
        expect(tile.personal.Time).toBeUndefined();
    });

    test('a completed card that banked nothing says so as a result', async () => {
        // The Hedgehog party wiped before clearing tier one, so its card read
        // Completed with no points and no badge — and the block said "nothing
        // yet — tier 1 in progress" under a trial that was over
        const root = buildTab(
            [{ name: 'Trial Hedgehog', level: 100, points: 0, bar: '721,000 / 721,000', completed: true }],
            'Combat Trial - Completed'
        );
        fire(root);

        expect(text()).toContain('0 tiers — fell before tier 1');
        expect(text()).not.toContain('in progress');
        expect(text()).not.toContain('tier not seen yet');
    });

    test('a guild notice board makes no tile, no stats and no recording', async () => {
        // The whole failure, end to end. On a live 106-member guild the notice
        // became a tile: two Discord channel ids in it read as a progress bar,
        // the Overview tab's guild statistics were attached to it as the
        // player's own action stats, and it was live enough to start the
        // recorder — that session reads `startedBy: "tab-reading"`
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            `<div class="GuildPanel_tileName__d">${NOTICE_BOARD_NAME.replace(/</g, '')}</div>` +
            '<div class="ProgressBar_text__f">' +
            'https://discord.com/channels/1234500000000000001/1525000000000000321</div>' +
            '<div>Guild Level</div><div>127</div>' +
            '<div>Guild Members</div><div>106</div>';
        root.appendChild(tile);
        document.body.appendChild(root);
        fire(root);

        expect(Object.keys(guildTrials.record.tiles)).toEqual([]);
        expect(game.recorder.activity).toEqual([]);
        expect(game.recorder.recording).toBe(false);
        // And no block was drawn over somebody's notice board
        expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
    });

    test('the socket fills a skilling card the DOM has nothing on', async () => {
        // `guild_skilling_updated` states the pool, the tier and the player's own
        // action figures — every one of which was otherwise scraped off a tab
        // that has to be open, and each of which has had its own bug
        game.skilling.crafting = {
            trial: { kind: 'skilling', key: 'crafting', name: 'Crafting' },
            tier: 10,
            reading: { current: 21_608, max: 88_920 },
            personal: { 'Success Rate': '8.0%', 'Work Power': '161' },
            participantIds: [910007],
            at: now,
        };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const tile = guildTrials.record.tiles['skilling::crafting'];
        expect(tile.samples).toHaveLength(1);
        expect(tile.samples[0].readings[0]).toEqual({ current: 21_608, max: 88_920 });
        // The tier is the payload's own, not a badge plus an assumption
        expect(tile.tiers).toContainEqual({ tier: 10, total: 88_920 });
        expect(tilePersonalStats(tile, game.characterId).personalByTier['10']).toMatchObject({
            'Success Rate': '8.0%',
        });
    });

    test('the socket-stated tier reaches the panel, not only the observation filing', async () => {
        // The four-minute "tier not known yet" over a stream stating the tier:
        // `socketTier` fed `readingTier` and stopped there — the record never
        // kept it, so the analysis derived its tier from a badge that was not
        // on screen. It is persisted as `liveTier` now, and the block says the
        // tier and the tiers banked below it straight off the socket.
        game.skilling.crafting = {
            trial: { kind: 'skilling', key: 'crafting', name: 'Crafting' },
            tier: 3,
            reading: { current: 3_741, max: 49_920 },
            personal: {},
            participantIds: [1, 2, 3, 4],
            at: now,
        };
        const root = buildTab([{ name: 'Crafting', level: '', bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        expect(guildTrials.record.tiles['skilling::crafting'].liveTier).toBe(3);
        // …paired with the pool it was stated for, so it can expire when the
        // bar's target moves on to the next tier's
        expect(guildTrials.record.tiles['skilling::crafting'].liveTierTarget).toBe(49_920);
        expect(text()).not.toContain('tier not seen yet');
        expect(text()).toContain('2 tiers');
    });

    test('a spectated combat trial’s stated tier persists the same way', async () => {
        // `new_battle.tier` rides on the watched pool; it used to reach only
        // the observation filing, and the combat card said "tier not seen yet"
        // through a fight whose tier was on the wire
        game.breakdown = {
            pool: { current: 476_238, max: 572_000, tier: 2, at: now, encounter: 'chameleon' },
        };
        const root = buildTab([{ name: 'Trial Chameleon', level: '', bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const tile = guildTrials.record.tiles['combat::trial chameleon'];
        expect(tile.liveTier).toBe(2);
        expect(tile.liveTierTarget).toBe(572_000);
        expect(text()).not.toContain('tier not seen yet');
        expect(text()).toContain('1 tier');
    });

    test('a card the game is drawing a bar on keeps its own numbers', async () => {
        game.skilling.crafting = {
            trial: { kind: 'skilling', key: 'crafting', name: 'Crafting' },
            tier: 10,
            reading: { current: 1, max: 88_920 },
            personal: {},
            participantIds: [],
            at: now,
        };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '21,608 / 88,920' }]);
        fire(root);

        expect(guildTrials.record.tiles['skilling::crafting'].samples[0].readings[0].current).toBe(21_608);
    });

    test('the end message stamps the card completed at the tier it banked', async () => {
        // `end_guild_skilling` states tier 9 while tier 10 is in progress — the
        // game's own confirmation that a stated tier counts what is finished
        game.skillingEnded.crafting = { tier: 9, at: now };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '' }]);
        root.querySelectorAll('[class*="ProgressBar_text"]').forEach((el) => el.remove());
        fire(root);

        const tile = guildTrials.record.tiles['skilling::crafting'];
        expect(tile.completed).toBe(true);
        expect(tile.tier).toBe(9);
    });

    test('the game declaring a trial over ends the recording, certainly', async () => {
        // The only lifecycle signal this feature has ever had that is certain.
        // Everything else is a phase inferred from a header that may name the
        // other kind, or from a badge that may not have been redrawn
        game.skillingEnded.crafting = { tier: 9, at: now };
        const root = buildTab([{ name: 'Crafting', level: 190, points: 1100, bar: '21,608 / 88,920' }]);
        fire(root);

        expect(game.recorder.lifecycle).toContain('completed');
    });

    test('one kind ending is not the hour ending', async () => {
        // A guild runs the two kinds one after the other, so the skilling half
        // finishing while a combat trial is still live is not the end of anything
        game.skillingEnded.crafting = { tier: 9, at: now };
        const root = buildTab([
            { name: 'Crafting', level: 190, points: 1100, bar: '21,608 / 88,920' },
            { name: 'Trial Badger', level: 100, points: 400, bar: '429,000 / 429,000' },
        ]);
        fire(root);

        expect(game.recorder.lifecycle).not.toContain('completed');
    });

    test('a card wearing a Completed badge shows results, whatever the header says', async () => {
        // Reported: the header read "Combat Trial - In Progress" while the
        // skilling cards below it were decorated "Completed" — and the Foraging
        // block went on drawing a fill rate, a pace and a tier-clears-in for an
        // hour that had ended. The card's own badge is the per-card signal.
        const live = 'Combat Trial - In Progress — 42:15 remaining';
        const root = buildTab(
            [{ name: 'Trial Foraging', level: 130, points: 590, bar: '30,000 / 57,120', completed: true }],
            live
        );
        fire(root);

        // A second reading, so there is a rate to report as final
        root.querySelector('[class*="ProgressBar_text"]').textContent = '30,500 / 57,120';
        vi.setSystemTime(now + 10_000);
        fire(root);

        // The payout block is one of these too, so take the card's own
        const block = [...document.querySelectorAll('.mwi-trial-info')].find(
            (el) => !el.textContent.includes('Trial payout')
        );
        expect(block).toBeTruthy();
        const body = block.textContent;

        // Results, not a forecast and not a waiting room
        expect(body).toContain('Final fill rate');
        expect(body).toContain('Banked');
        expect(body).not.toContain('On pace for');
        expect(body).not.toContain('Tier clears in');
        expect(body).not.toContain('scheduled');
    });

    describe('the finished trial outlives its cards', () => {
        /** Sample a live combat trial twice, so the record holds a rate and points */
        const runTrial = () => {
            const root = buildTab([{ name: 'Trial Chameleon', level: 140, points: 1200, bar: '618,000 / 618,000' }]);
            fire(root);
            root.querySelector('[class*="ProgressBar_text"]').textContent = '518,000 / 618,000';
            vi.setSystemTime(now + 10_000);
            fire(root);
        };

        /** The game tears the cards down: the tab is a trials tab with nothing on it */
        const tearDown = (at = now + 60_000) => {
            document.body.innerHTML = '<div class="GuildPanel_trialsContent__a">No trials in progress</div>';
            vi.setSystemTime(at);
            fire();
        };

        test('the readouts survive the cards being torn down', () => {
            runTrial();
            tearDown();

            // The final readings, from the record — headed as finished business
            expect(text()).toContain('Last trial');
            expect(text()).toContain('Final party DPS');
            expect(text()).toContain('Trial Chameleon');
            expect(text()).toContain('Banked');
            expect(text()).toContain('ago');
            // The payout strip survives too, with the stated points intact
            expect(text()).toContain('Trial payout');
            expect(text()).toContain('Guild Points banked1,200');
            // And nothing pretends to be live
            expect(text()).not.toContain('On pace for');
            expect(text()).not.toContain('measuring');
        });

        test('a completed-phase render writes no new samples', () => {
            runTrial();
            const record = guildTrials.record.tiles['combat::trial chameleon'];
            const samples = record.samples.length;
            const pointSamples = record.pointSamples.length;

            tearDown();
            tearDown(now + 120_000);

            const after = guildTrials.record.tiles['combat::trial chameleon'];
            expect(after.samples).toHaveLength(samples);
            expect(after.pointSamples).toHaveLength(pointSamples);
        });

        test('the next trial’s cards replace the summary', () => {
            runTrial();
            tearDown();
            expect(text()).toContain('Last trial');

            vi.setSystemTime(now + 120_000);
            fire(buildTab([{ name: 'Milking', level: 110, bar: '1,000 / 4,000' }]));

            expect(text()).not.toContain('Last trial');
            expect(text()).toContain('Trial payout');
        });

        test('an empty record still draws nothing on an empty tab', () => {
            tearDown();
            expect(document.querySelectorAll('.mwi-trial-info')).toHaveLength(0);
        });

        test('the per-player split comes back from the recorder session', () => {
            game.recorder.session = {
                weekStart: trialWeekStart(now),
                startedAt: now,
                endedAt: now + 50_000,
                snapshots: [
                    {
                        t: now + 50_000,
                        seconds: 100,
                        totalDamage: 120_000,
                        players: [
                            { name: 'Orven', damage: 90_000, deaths: 0 },
                            { name: 'MillenniumTest', damage: 30_000, deaths: 1 },
                        ],
                    },
                ],
            };
            runTrial();
            tearDown();

            expect(text()).toContain('Per player · final');
            expect(text()).toContain('Orven');
            expect(text()).toContain('75%');
            expect(text()).toContain('MillenniumTest');
            expect(text()).toContain('1✝');
        });

        test('another week’s session is not borrowed for the split', () => {
            game.recorder.session = {
                weekStart: trialWeekStart(now) - 7 * 24 * 3600_000,
                snapshots: [{ t: now, seconds: 10, totalDamage: 100, players: [{ name: 'Ghost', damage: 100 }] }],
            };
            runTrial();
            tearDown();

            expect(text()).toContain('Last trial');
            expect(text()).not.toContain('Per player · final');
            expect(text()).not.toContain('Ghost');
        });
    });
});

/**
 * The two tabs as the live client actually draws them.
 *
 * Transcribed from screenshots of a running trial, which is the only reason this
 * file knows any of it. The shapes matter more than the exact strings: the
 * Trials tab has cards with no progress bar and the In Progress tab has a bar
 * with no level, so anything that requires both on one card records nothing on
 * either tab — which is what shipped, twice.
 */
describe('the two trial tabs, as the game draws them', () => {
    /**
     * The Trials tab: the setup cards, their sign-ups, and a countdown.
     * @returns {Element} The guild panel
     */
    function buildTrialsTab() {
        document.body.innerHTML = '';
        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__root';
        panel.innerHTML = `
            <div class="GuildPanel_header__h">Skilling Trial - In Progress Thu 09:00 AM</div>
            <div class="GuildPanel_setTime__s">Set Time</div>
            <div class="GuildPanel_tile__a">
                <div class="GuildPanel_tileName__n">Milking</div>
                <div class="GuildPanel_tileSummary__s">Lv.130<span class="mwi-trial-tier">T4</span></div>
                <div class="GuildPanel_points__p">600 pts</div>
                <div class="GuildPanel_signups__u">1/28 signed up</div>
                <div class="GuildPanel_clock__c">20m 53s</div>
            </div>
            <div class="GuildPanel_tile__b">
                <div class="GuildPanel_tileName__n">Foraging</div>
                <div class="GuildPanel_points__p">0 pts</div>
                <div class="GuildPanel_signups__u">0/28 signed up</div>
            </div>
            <div class="GuildPanel_tile__c">
                <div class="GuildPanel_tileName__n">Alchemy</div>
                <div class="GuildPanel_tileSummary__s">Lv.150<span class="mwi-trial-tier">T6</span></div>
                <div class="GuildPanel_points__p">840 pts</div>
                <div class="GuildPanel_signups__u">2/28 signed up</div>
                <div class="GuildPanel_clock__c">20m 53s</div>
            </div>
            <div class="GuildPanel_tile__d">
                <div class="GuildPanel_tileName__n">Trial Chameleon</div>
                <div class="GuildPanel_points__p">0 pts</div>
                <div class="GuildPanel_signups__u">Signed Up 3/56</div>
            </div>`;
        document.body.appendChild(panel);
        return panel;
    }

    /**
     * The In Progress tab: one card with the pool reading, and the footer.
     * @param {string} [reading] - What the bar says
     * @returns {Element} The guild panel
     */
    function buildInProgressTab(reading = '18,850 / 65,280') {
        document.body.innerHTML = '';
        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__root';
        panel.innerHTML = `
            <div class="GuildPanel_card__a">
                <div class="GuildPanel_cardName__n">Alchemy</div>
                <div class="ProgressBar_text__t">${reading}</div>
            </div>
            <div class="GuildPanel_member__m"><div>MillenniumTest</div><div>Working</div></div>
            <div class="GuildPanel_footer__f">
                <div>Work Power 229</div>
                <div>Work Time 3.14s</div>
                <div>Success Rate 60.8%</div>
                <div>Time: 20m 37s</div>
            </div>`;
        document.body.appendChild(panel);
        return panel;
    }

    const fire = () => game.observers['GuildPanel_']();

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        game.settings = { guildTrialsInfo: true };
        game.settingListeners = {};
        game.settingValues = {};
        game.clientData = {};
        game.prices = {};
        game.buildingLevels = {};
        game.store = {};
        game.holds = {};
        game.unavailable = false;
        game.members = [];
        game.characterId = null;
        game.characterData = null;
        game.dmHandlers = {};
        game.trialNames = [];
        game.alerts = { status: [], payouts: [], reset: 0 };
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        game.scoreboardToggles = 0;
        resetTrialsSingleton();
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('the Trials tab gives the tier, the points and the sign-ups, and no samples', () => {
        buildTrialsTab();
        fire();

        const milking = guildTrials.record.tiles['skilling::milking'];
        expect(milking).toMatchObject({ level: 130, tier: 4, points: 600 });
        expect(milking.signups).toEqual({ signed: 1, total: 28 });
        // Nothing on this tab moves, so nothing here is a reading
        expect(milking.samples).toHaveLength(0);
    });

    test('the tier survives this script having written a badge into the level line', () => {
        // `guild-credit-value.js` appends `T4` inside the very element holding
        // "Lv.130", and a leaf-element text walk drops any element that has
        // acquired a child — so the level vanished from every card the moment
        // this script annotated it
        buildTrialsTab();
        fire();

        expect(guildTrials.record.tiles['skilling::alchemy'].tier).toBe(6);
    });

    test('a sign-up ratio is never sampled as a progress bar', () => {
        // "1/28 signed up" and "Signed Up 3/56" have exactly the shape of a
        // reading, and a pool that fills and empties as members join would be
        // measured as a rate
        buildTrialsTab();
        fire();

        for (const tile of Object.values(guildTrials.record.tiles)) {
            expect(tile.samples).toHaveLength(0);
        }
    });

    test('a combat card written "Signed Up 3/56" is read the other way round too', () => {
        buildTrialsTab();
        fire();

        expect(guildTrials.record.tiles['combat::trial chameleon'].signups).toEqual({ signed: 3, total: 56 });
    });

    test('the In Progress tab gives the reading, from a card with no level on it', () => {
        buildInProgressTab();
        fire();

        const alchemy = guildTrials.record.tiles['skilling::alchemy'];
        expect(alchemy.samples).toHaveLength(1);
        expect(alchemy.samples[0].readings).toEqual([{ current: 18_850, max: 65_280 }]);
    });

    test('neither the members nor the footer is mistaken for a trial', () => {
        buildInProgressTab();
        fire();

        expect(Object.keys(guildTrials.record.tiles)).toEqual(['skilling::alchemy']);
    });

    test('the two tabs join into one trial: tier from Trials, rate from In Progress', () => {
        // The whole point. Neither tab is sufficient and the name is the join.
        buildTrialsTab();
        fire();

        buildInProgressTab('18,850 / 65,280');
        fire();

        vi.setSystemTime(now + 60_000);
        buildInProgressTab('28,850 / 65,280');
        fire();

        const alchemy = guildTrials.record.tiles['skilling::alchemy'];
        expect(alchemy.tier).toBe(6);
        expect(alchemy.samples).toHaveLength(2);

        const analysis = analyseTrial(alchemy, { timeLeftMs: 20 * 60_000 });
        expect(analysis.rate).toBeCloseTo(10_000 / 60_000, 9);
        // The badge counts what is banked, so a T6 card has six behind it
        expect(analysis.tiersClearedSoFar).toBe(6);
        expect(analysis.tier).toBe(7);
    });

    test('the countdown is read off either tab, and the footer stats are not clocks', () => {
        // "Work Time 3.14s" is a decimal, "Success Rate 60.8%" is a percentage,
        // and "Thu 09:00 AM" is a time of day that reads as nine minutes
        buildInProgressTab();
        fire();
        expect(guildTrials._timeLeftMs(document.querySelector('[class*="GuildPanel"]'))).toBe(20 * 60_000 + 37_000);

        buildTrialsTab();
        expect(guildTrials._timeLeftMs(document.querySelector('[class*="GuildPanel"]'))).toBe(20 * 60_000 + 53_000);
    });

    test('the pace block appears once a rate and a clock are both in hand', () => {
        buildTrialsTab();
        fire();
        buildInProgressTab('18,850 / 65,280');
        fire();
        vi.setSystemTime(now + 60_000);
        buildInProgressTab('28,850 / 65,280');
        fire();

        expect(document.body.textContent).toContain('On pace for');
        expect(document.body.textContent).not.toContain('no clock visible');
    });

    test('a tier observation needs both tabs, and is recorded from both', () => {
        // The total comes off the In Progress bar and the tier off the Trials
        // card. Requiring one card to carry both means the ladder is never
        // anchored and "Next tier work" never appears. The badge counts tiers
        // *finished* — Alchemy's T6 has 840 pts banked behind it — so the pool
        // on the In Progress tab is T7's, and that is the tier it files under:
        // 65,280 is exactly 40,800 × 1.6, the seventh rung of a 40,800 ladder.
        buildTrialsTab();
        fire();
        buildInProgressTab();
        fire();

        expect(guildTrials.record.tiles['skilling::alchemy'].tiers).toContainEqual({ tier: 7, total: 65_280 });
    });

    test('the sign-up count off the card is what the panel counts as participants', () => {
        buildTrialsTab();
        fire();
        buildInProgressTab();
        fire();

        // Two members signed up for Alchemy on the Trials tab, and no socket
        // sign-up traffic has been seen at all — the old count would be zero
        expect(participantCounts()).toEqual({});
        expect(guildTrials.record.tiles['skilling::alchemy'].signups.signed).toBe(2);
        expect(document.body.textContent).toContain('Trial payout');
    });

    test('the skill’s base work is learned the moment tier, target and party line up', async () => {
        // Trials tab: Alchemy T6 banked (840 pts), 2 signed up. In Progress:
        // the T7 pool at 65,280 — which is 40,000 × 1.6 × 1.02, so the base
        // falls out exactly, and is written down for every later trial
        buildTrialsTab();
        fire();
        buildInProgressTab();
        fire();

        expect(guildTrials.workBases.alchemy?.baseWork).toBeCloseTo(40_000, 6);
        // The write re-reads storage first, so it lands a few microtasks later
        await vi.advanceTimersByTimeAsync(0);
        expect(game.store.guildTrialsWorkBases?.alchemy?.baseWork).toBeCloseTo(40_000, 6);
    });

    test('a learned base lets the In Progress tab alone state the tier', async () => {
        // The user's explicit goal: the live view must know the tier RIGHT
        // AWAY, without a Trials tab visit. The bar's target is on screen the
        // whole time, and with the base learned it identifies the tier alone.
        trialsFeature.cleanup();
        game.store = {
            guildTrialsWorkBases: {
                alchemy: { baseWork: 40_000, tier: 7, target: 65_280, participants: 2, learnedAt: now },
            },
        };
        // The participant count comes from the sign-up sheet when no card has
        // stated one — the In Progress tab carries none
        game.members = [
            {
                characterID: '1',
                signupWeekStartAt: game.currentWeek,
                signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            },
            {
                characterID: '2',
                signupWeekStartAt: game.currentWeek,
                signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            },
        ];
        await trialsFeature.initialize();

        buildInProgressTab();
        fire();

        // The reading files under the tier the target identifies, and the
        // panel states the tier instead of "tier not seen yet"
        expect(guildTrials.record.tiles['skilling::alchemy'].tiers).toContainEqual({ tier: 7, total: 65_280 });
        expect(document.body.textContent).not.toContain('tier not seen yet');
        expect(document.body.textContent).toContain('6 tiers');
    });

    test('a seeded base serves a completely cold store — the second character’s first look', async () => {
        // A second account in a second browser profile shares no IndexedDB
        // with the first, so nothing learned ever reaches it. The seeded
        // crafting base plus the joint (tier, participants) solve make the In
        // Progress tab knowable with an empty store, no sign-up sheet and no
        // Trials-tab visit — the exact live state that read "tier not known
        // yet" over a bar only T3-with-7 produces.
        trialsFeature.cleanup();
        game.store = {};
        game.members = [];
        await trialsFeature.initialize();

        document.body.innerHTML = '';
        const panel = document.createElement('div');
        panel.className = 'GuildPanel_guildPanel__root';
        panel.innerHTML =
            '<div class="GuildPanel_card__a"><div class="GuildPanel_cardName__n">Crafting</div>' +
            '<div class="ProgressBar_text__t">8,276 / 51,360</div></div>' +
            '<div class="GuildPanel_footer__f"><div>Time: 20m 37s</div></div>';
        document.body.appendChild(panel);
        fire();

        expect(guildTrials.record.tiles['skilling::crafting'].tiers).toContainEqual({ tier: 3, total: 51_360 });
        expect(document.body.textContent).not.toContain('tier not seen yet');
        expect(document.body.textContent).toContain('2 tiers');
    });

    test('the In Progress tab stays correct on its own as tiers clear under it', async () => {
        // The user's requirement, verbatim: correct continuously, with no
        // Trials-tab visit — including after a tier clears while the tab sits
        // open. The bar's target moving from T14's to T15's is the whole
        // signal, and it is enough.
        trialsFeature.cleanup();
        game.store = {
            guildTrialsWorkBases: {
                alchemy: { baseWork: 40_000, tier: 7, target: 65_280, participants: 2, learnedAt: now },
            },
        };
        game.members = [
            {
                characterID: '1',
                signupWeekStartAt: game.currentWeek,
                signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            },
            {
                characterID: '2',
                signupWeekStartAt: game.currentWeek,
                signedUpSkillingTrialHrid: '/guild_trials/alchemy',
            },
        ];
        await trialsFeature.initialize();

        // T14's pool with 2 signed up: 40,000 × 2.3 × 1.02
        buildInProgressTab('90,000 / 93,840');
        fire();
        expect(document.body.textContent).toContain('13 tiers');

        // The tier clears while the tab sits open: the bar resets onto T15's
        // target, 40,000 × 2.4 × 1.02
        vi.setSystemTime(now + 5_000);
        buildInProgressTab('1,200 / 97,920');
        fire();

        expect(document.body.textContent).toContain('14 tiers');
        expect(document.body.textContent).not.toContain('13 tiers');
        // And both pools were filed under the tier their own target names
        expect(guildTrials.record.tiles['skilling::alchemy'].tiers).toContainEqual({ tier: 14, total: 93_840 });
        expect(guildTrials.record.tiles['skilling::alchemy'].tiers).toContainEqual({ tier: 15, total: 97_920 });
    });

    test('a status row carrying a time of day is not a nine-minute countdown', () => {
        // "Skilling Trial - In Progress Thu 09:00 AM" — 09:00 read as a clock
        // gave the Trials tab a nine-minute deadline against a tile clock of
        // 5m53s, and the pace walked one tier further than the hour allowed:
        // "15 tiers → T15" there against a correct "14 tiers → T14" on the
        // refreshed In Progress view, at the same moment.
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        root.innerHTML =
            '<div class="GuildPanel_eventStatusRow__b">Skilling Trial - In Progress Thu 09:00 AM</div>' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Crafting</div>' +
            '<div class="GuildPanel_tileSummary__e">Lv.230</div><div class="GuildPanel_clock__f">5m 53s</div></div>';
        document.body.appendChild(root);

        expect(guildTrials._timeLeftMs(root)).toBe(5 * 60_000 + 53_000);
    });
});

describe('zero is a claim, and usually the wrong one', () => {
    /**
     * A record from the In Progress tab alone: a reading, and no tier anywhere.
     * @returns {Object} A tile record
     */
    const inProgressOnly = () => ({
        name: 'Alchemy',
        kind: 'skilling',
        level: null,
        tier: null,
        samples: [
            { t: now, readings: [{ current: 18_850, max: 65_280 }] },
            { t: now + 10_000, readings: [{ current: 28_850, max: 65_280 }] },
        ],
        tiers: [],
    });

    test('a tier that was never on screen is unknown, not nought banked', () => {
        const analysis = analyseTrial(inProgressOnly(), { timeLeftMs: 20 * 60_000 });

        expect(analysis.tierKnown).toBe(false);
        expect(analysis.tiersClearedSoFar).toBe(0);

        const html = renderTrialBlock(analysis, 0, { measured: false, reason: 'nothing' });
        expect(html).toContain('tier not seen yet');
        expect(html).not.toContain('0 tiers');
    });

    test('a live spectator tier floors the count past a stale badge (In Progress after refresh)', () => {
        // The reported case: mid-trial refresh with the fight view open. The
        // persisted badge is a scrape behind (T1, 0 pts → earned false), the
        // encounter is unseeded so the work ladder is blind, and the card read
        // "tier 1, banked nothing" until a Trials-tab visit. The stream is stating
        // tier 2 this instant — that floors both the tier and the banked count.
        const record = {
            name: 'Trial Hedgehog',
            kind: 'combat',
            tier: 1,
            points: 0,
            samples: [
                {
                    t: now,
                    readings: [
                        { current: 300_000, max: 494_400 },
                        { current: 400_000, max: 480_000 },
                    ],
                },
            ],
            tiers: [],
        };

        const stale = analyseTrial(record, { timeLeftMs: 20 * 60_000 });
        expect(stale.tier).toBe(1);
        expect(stale.tiersClearedSoFar).toBe(0);

        const live = analyseTrial(record, { timeLeftMs: 20 * 60_000, liveTierFloor: 2 });
        expect(live.tier).toBe(2);
        expect(live.tierSource).toBe('socket');
        expect(live.tiersClearedSoFar).toBe(1);
    });

    test('the live tier floor only raises, never lowers, the tier', () => {
        // A card already reading T5 is not dragged down by a lagging stream tier.
        const record = {
            name: 'Trial Hedgehog',
            kind: 'combat',
            tier: 5,
            points: 4_000,
            samples: [{ t: now, readings: [{ current: 300_000, max: 900_000 }] }],
            tiers: [],
        };
        const analysis = analyseTrial(record, { timeLeftMs: 20 * 60_000, liveTierFloor: 2 });
        expect(analysis.tier).toBeGreaterThanOrEqual(5);
    });

    test('the first tier in progress says so rather than reading as a failure', () => {
        // Pre-badge: a trial on its first tier has banked nothing, and the badge
        // that would say otherwise has not appeared yet
        const analysis = analyseTrial(
            {
                name: 'Alchemy',
                kind: 'skilling',
                tier: null,
                samples: [{ t: now, readings: [{ current: 10, max: 100 }] }],
                tiers: [],
            },
            { timeLeftMs: 60_000, phase: 'live' }
        );

        expect(analysis.tier).toBe(1);
        expect(renderTrialBlock(analysis, 0)).toContain('nothing yet');
    });

    test('a pace that cannot be projected says which of the four things is missing', () => {
        // No clock
        expect(renderTrialBlock(analyseTrial(inProgressOnly(), {}), 0)).toContain('no clock visible');

        // A clock, but no tier to walk the ladder from
        expect(renderTrialBlock(analyseTrial(inProgressOnly(), { timeLeftMs: 60_000 }), 0)).toContain(
            'tier not known yet'
        );

        // A clock and a tier, and one reading
        const oneSample = analyseTrial(
            { name: 'Alchemy', kind: 'skilling', tier: 3, samples: [{ t: now, readings: [{ current: 1, max: 10 }] }] },
            { timeLeftMs: 60_000 }
        );
        expect(renderTrialBlock(oneSample, 0)).toContain('measuring');
    });
});

describe('the side block’s shape', () => {
    // Reported from a screenshot: the two-column rows wrapped badly on a narrow
    // card — "Rate | no data — only trials you join can be measured" became a
    // tall ragged column, and "Next tier | needs a second tier to fit the curve"
    // broke mid-phrase. A caption is a sentence, not a value.
    test('a sentence gets the full width, under its label', () => {
        const analysis = analyseTrial(record({ tier: 6, samples: [] }), {});
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: false });

        // Not squeezed into a right-hand column
        expect(html).not.toMatch(
            /justify-content:space-between[^>]*>\s*<span[^>]*>Rate<\/span>\s*<span[^>]*>only trials/
        );
        expect(html).toContain('only trials you join');
    });

    test('a real figure stays a two-column row', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 1000, max: 65_280 }] },
                    { t: now + 10_000, readings: [{ current: 2060, max: 65_280 }] },
                ],
            }),
            {}
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' });

        expect(html).toMatch(/justify-content:space-between/);
        expect(html).toContain('Fill rate');
        expect(html).toContain('\u00a0work/s');
    });
});

describe('the first tier of a running trial', () => {
    // Live evidence: a trial visibly on its first tier (0 pts everywhere, first
    // pool 876/40,800) reported "tier not known yet", "On pace for: tier not
    // known yet" and "Expected: not projectable" for the whole hour. Every
    // trial starts at tier 1; the In Progress tab simply never says so.
    const running = (extra = {}) => ({
        name: 'Foraging',
        kind: 'skilling',
        samples: [
            { t: now, readings: [{ current: 876, max: 40_800 }] },
            { t: now + 10_000, readings: [{ current: 1756, max: 40_800 }] },
        ],
        tiers: [],
        ...extra,
    });

    test('a live trial with nothing banked is on tier one', () => {
        const analysis = analyseTrial(running(), { phase: 'live', timeLeftMs: 40 * 60_000 });

        expect(analysis.tier).toBe(1);
        expect(analysis.tierKnown).toBe(true);
        expect(analysis.tierSource).toBe('first-tier-rule');
        expect(analysis.tiersClearedSoFar).toBe(0);
    });

    test('and a pace can be walked from the start of it', () => {
        const analysis = analyseTrial(running({ tiers: [{ tier: 1, total: 40_800 }] }), {
            phase: 'live',
            timeLeftMs: 40 * 60_000,
        });

        expect(analysis.pace).not.toBeNull();
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });
        expect(html).not.toContain('tier not known yet');
        expect(html).not.toContain('tier not seen yet');
    });

    test('a card that already states points is not assumed to be on tier one', () => {
        // Joining midway: the trial has banked something and the tier badge is
        // the only thing that can say which one
        const analysis = analyseTrial(running({ pointsByTier: { 5: 840 } }), {
            phase: 'live',
            timeLeftMs: 40 * 60_000,
        });

        expect(analysis.tier).toBeNull();
        expect(analysis.tierKnown).toBe(false);
    });

    test('a scheduled or unknown phase assumes nothing', () => {
        expect(analyseTrial(running(), { phase: 'scheduled' }).tier).toBeNull();
        expect(analyseTrial(running(), {}).tier).toBeNull();
    });

    test('the card’s own tier always wins over the rule', () => {
        // A badge with points behind it counts banked tiers, so the one being
        // fought is the next
        const banked = analyseTrial(running({ tier: 6, pointsByTier: { 6: 700 } }), { phase: 'live' });
        expect(banked.tier).toBe(7);
        expect(banked.tiersClearedSoFar).toBe(6);

        // A badge with no points behind it is the tier in progress, banking nothing
        const started = analyseTrial(running({ tier: 6 }), { phase: 'live' });
        expect(started.tier).toBe(6);
        expect(started.tiersClearedSoFar).toBe(0);
        expect(banked.tierSource).toBe('card');
    });
});

describe('the tier from the bar alone', () => {
    // The live trial this was built from: a mid-trial join with the In
    // Progress view open the whole time — target 49,920 on screen throughout —
    // and the panel said "tier not known yet" for four minutes, until the
    // Trials tab was visited. The target identifies the tier by itself once
    // the skill's base work is known.
    const midJoin = (max, readings = null) => ({
        name: 'Crafting',
        kind: 'skilling',
        tier: null,
        samples: readings || [
            { t: now, readings: [{ current: 1_000, max }] },
            { t: now + 10_000, readings: [{ current: 5_050, max }] },
        ],
        tiers: [],
    });

    test('a learned base and the bar’s target state the tier, and the tiers banked below it', () => {
        const analysis = analyseTrial(midJoin(49_920), { participants: 4, phase: 'live', workBase: 40_000 });

        expect(analysis.tier).toBe(3);
        expect(analysis.tierKnown).toBe(true);
        expect(analysis.tierSource).toBe('work-ladder');
        // A trial climbs one tier at a time, so T3 in progress banks two
        expect(analysis.tiersClearedSoFar).toBe(2);
    });

    test('the second confirmed guild: 17 participants at T10, same base', () => {
        const analysis = analyseTrial(midJoin(88_920), { participants: 17, phase: 'live', workBase: 40_000 });

        expect(analysis.tier).toBe(10);
        expect(analysis.tiersClearedSoFar).toBe(9);
    });

    test('a target the ladder cannot place stays unknown — and mutes the first-tier rule', () => {
        // The rule would claim T1, but a known base and a target that fits no
        // tier is evidence against it, not an absence of evidence
        const analysis = analyseTrial(midJoin(51_000), { participants: 4, phase: 'live', workBase: 40_000 });

        expect(analysis.tier).toBeNull();
        expect(analysis.tierKnown).toBe(false);
    });

    test('without a learned base the first-tier rule stands as before', () => {
        const analysis = analyseTrial(midJoin(49_920), { participants: 4, phase: 'live' });

        expect(analysis.tier).toBe(1);
        expect(analysis.tierSource).toBe('first-tier-rule');
    });

    test('an unknown party size is solved jointly — the second character’s mid-join', () => {
        // MillenniumTestIC, a different guild, In Progress only: the tab
        // states no sign-up count, and the bar read 8,276/51,360 — which is
        // 40,000 × 1.2 × 1.07, tier 3 with 7 signed up, and no other (t, p)
        // produces it. "tier not known yet" was the panel's answer.
        const analysis = analyseTrial(
            midJoin(51_360, [
                { t: now, readings: [{ current: 4_066, max: 51_360 }] },
                { t: now + 10_000, readings: [{ current: 8_276, max: 51_360 }] },
            ]),
            { participants: 0, phase: 'live', workBase: 40_000 }
        );

        expect(analysis.tier).toBe(3);
        expect(analysis.tierSource).toBe('work-ladder');
        expect(analysis.tiersClearedSoFar).toBe(2);
    });

    test('a target that factors two ways stays unknown even with the base in hand', () => {
        // 65,280 with no count is T7 with 2 signed *and* T3 with 36 — the
        // joint search refuses to pick, and the panel stays honest
        const analysis = analyseTrial(midJoin(65_280), { participants: 0, phase: 'live', workBase: 40_000 });

        expect(analysis.tier).toBeNull();
        expect(analysis.tierKnown).toBe(false);
    });

    test('a socket-stated tier reaches the analysis, and outranks the derived rung', () => {
        // `guild_skilling_updated.tier` states the tier in progress outright;
        // the store keeps it as `liveTier`. It used to feed only the
        // observation filing, never the analysis — the "tier not known yet"
        // panel over a stream stating the tier every second.
        const analysis = analyseTrial(
            { ...midJoin(49_920), liveTier: 3 },
            { participants: 4, phase: 'live', timeLeftMs: 30 * 60_000 }
        );

        expect(analysis.tier).toBe(3);
        expect(analysis.tierSource).toBe('socket');
        expect(analysis.tiersClearedSoFar).toBe(2);
    });

    test('the banked caption says the tier was derived from the work total', () => {
        const analysis = analyseTrial(midJoin(49_920), { participants: 4, phase: 'live', workBase: 40_000 });
        const html = renderTrialBlock(analysis, 4, { measured: false, reason: 'none' }, { phase: 'live' });

        expect(html).toContain('derived from the tier’s work total');
        expect(html).not.toContain('tier not seen yet');
    });

    test('the observed trial end to end: known at once, and paced far past T3', () => {
        // The fixture as the screen showed it 90 seconds before the tier
        // cleared: 41,385 / 49,920, filling at 405 work/s, 54m45s left
        const analysis = analyseTrial(
            midJoin(49_920, [
                { t: now, readings: [{ current: 37_335, max: 49_920 }] },
                { t: now + 10_000, readings: [{ current: 41_385, max: 49_920 }] },
            ]),
            { participants: 4, phase: 'live', timeLeftMs: 54.75 * 60_000, workBase: 40_000 }
        );

        expect(analysis.tier).toBe(3);
        expect(analysis.tiersClearedSoFar).toBe(2);
        expect(analysis.rate * 1000).toBeCloseTo(405, 9);
        // The exact ladder from the bar in hand: T4 is 49,920 × 1.3 / 1.2 —
        // not the 59.0K a misfiled observation once produced
        expect(analysis.next.total).toBeCloseTo(54_080, 6);
        // The walk clears most of the ladder instead of stopping at T3
        expect(analysis.pace.limitedBy).toBe('time');
        expect(analysis.pace.tiersCleared).toBe(18);
        expect(analysis.pace.finalTier).toBe(18);

        const html = renderTrialBlock(analysis, 4, { measured: false, reason: 'none' }, { phase: 'live' });
        expect(html).toContain('18 tiers → T18 (Lv.270)');
        expect(html).toContain('Next tier work (T4)');
        expect(html).toContain('54.1K');
        expect(html).toContain('2 tiers');
    });

    test('a walk still cut short by an unknown ladder reads “at least”, never a verdict', () => {
        const analysis = analyseTrial(
            midJoin(49_920, [
                { t: now, readings: [{ current: 37_335, max: 49_920 }] },
                { t: now + 10_000, readings: [{ current: 41_385, max: 49_920 }] },
            ]),
            { participants: 4, phase: 'live', timeLeftMs: 54.75 * 60_000, workBase: 40_000 }
        );
        analysis.pace.limitedBy = 'unknown-next-tier';
        analysis.pace.tiersCleared = 3;
        const html = renderTrialBlock(analysis, 4, { measured: false, reason: 'none' }, { phase: 'live' });

        expect(html).toContain('at least 3 tiers → T3');
        expect(html).toContain('ladder past that tier is not known');
    });
});

describe('the rungs go stale at different speeds', () => {
    // Live evidence, one moment, two tabs: the In Progress bar read
    // 17,353/99,840 — a target only T15 produces — while the panel said
    // "Banked 8 tiers", "Next tier work (T10)" and a payout of 1,080 against a
    // Trials tab stating T14, 1,800 pts and "Banked 14 tiers". A liveTier of 9
    // and a badge of 8, both true earlier in the hour, outranked the bar in
    // front of the player until a Trials-tab visit rewrote the badge.
    const staleRecord = (extra = {}) => ({
        name: 'Crafting',
        kind: 'skilling',
        tier: null,
        samples: [
            { t: now, readings: [{ current: 15_613, max: 99_840 }] },
            { t: now + 10_000, readings: [{ current: 17_353, max: 99_840 }] },
        ],
        tiers: [],
        ...extra,
    });

    test('a socket tier is only believed for the pool it was stated with', () => {
        // liveTier 9 arrived with T9's 74,880; the bar has since moved on
        const analysis = analyseTrial(
            staleRecord({ liveTier: 9, liveTierTarget: 74_880, tiers: [{ tier: 9, total: 74_880 }] }),
            { participants: 4, phase: 'live', workBase: 40_000 }
        );

        expect(analysis.tier).toBe(15);
        expect(analysis.tierSource).toBe('work-ladder');
        expect(analysis.tiersClearedSoFar).toBe(14);
    });

    test('and still believed while the target matches', () => {
        const analysis = analyseTrial(
            {
                ...staleRecord({ liveTier: 9, liveTierTarget: 74_880 }),
                samples: [{ t: now, readings: [{ current: 10_000, max: 74_880 }] }],
            },
            { participants: 4, phase: 'live' }
        );

        expect(analysis.tier).toBe(9);
        expect(analysis.tierSource).toBe('socket');
    });

    test('the live regression, end to end: badge, socket and payout all heal off the bar', () => {
        const analysis = analyseTrial(
            staleRecord({
                tier: 8,
                points: 1080,
                pointsByTier: { 8: 1080 },
                liveTier: 9,
                liveTierTarget: 74_880,
                tiers: [{ tier: 9, total: 74_880 }],
            }),
            {
                participants: 4,
                phase: 'live',
                timeLeftMs: 4 * 60_000 + 12_000,
                buildersHallBonus: 0.2,
                workBase: 40_000,
            }
        );

        // The bar wins: 99,840 = 40,000 × 2.4 × 1.04 is T15 and nothing else
        expect(analysis.tier).toBe(15);
        expect(analysis.tierSource).toBe('work-ladder');
        expect(analysis.tiersClearedSoFar).toBe(14);
        // The payout heals with it: the T8 card topped up six ladder steps
        expect(analysis.points.basePoints).toBeCloseTo(1_500, 9);
        expect(analysis.points.guildPoints).toBeCloseTo(1_800, 9);
        // And the next tier states T16 off the live anchor: 99,840 × 2.5/2.4
        expect(analysis.next.tier).toBe(16);
        expect(analysis.next.total).toBeCloseTo(104_000, 6);
        // 82,487 left at 174 work/s is 7.9 minutes against 4m12s: no clear
        // fits, so the pace is the fourteen banked — as the corrected view read
        expect(analysis.rate * 1000).toBeCloseTo(174, 9);
        expect(analysis.pace.tiersCleared).toBe(14);

        const html = renderTrialBlock(analysis, 4, { measured: false, reason: 'none' }, { phase: 'live' });
        expect(html).toContain('14 tiers');
        expect(html).not.toContain('8 tiers');
    });

    test('the record’s own observations recover the base when the store has none', () => {
        const analysis = analyseTrial(staleRecord({ tiers: [{ tier: 9, total: 74_880 }] }), {
            participants: 4,
            phase: 'live',
        });

        expect(analysis.tier).toBe(15);
        expect(analysis.tierSource).toBe('work-ladder');
    });

    test('a tier-1 observation cannot smuggle the first-tier rule in as arithmetic', () => {
        // The first-tier rule files (1, target); a base derived from that very
        // observation would "confirm" tier 1 by construction
        const analysis = analyseTrial(
            {
                ...staleRecord({ tiers: [{ tier: 1, total: 49_920 }] }),
                samples: [{ t: now, readings: [{ current: 1_000, max: 49_920 }] }],
            },
            { participants: 4, phase: 'live' }
        );

        expect(analysis.tierSource).toBe('first-tier-rule');
        expect(analysis.tier).toBe(1);
    });

    test('a fresh badge agreeing with the ladder keeps its label', () => {
        const analysis = analyseTrial(staleRecord({ tier: 14, points: 1800, pointsByTier: { 14: 1800 } }), {
            participants: 4,
            phase: 'live',
            buildersHallBonus: 0.2,
            workBase: 40_000,
        });

        expect(analysis.tier).toBe(15);
        expect(analysis.tierSource).toBe('card');
    });
});

describe('the ladder only climbs — the IC screen, in full', () => {
    // One live screenshot, three provable inconsistencies: bar 68,419/85,600
    // filling at 409 work/s, badge banked-9 from a stale Trials visit, 35m29s
    // on the clock — and the panel said "Next tier work (T11) 77.3K" (below
    // the bar's own target), "On pace for 10 tiers → T10" (the walk never left
    // the current tier), "Banked 9 tiers". The bar factors uniquely: 85,600 =
    // 40,000 × 2.0 × 1.07 is T11 with 7 signed up and nothing else.
    const screen = () => ({
        name: 'Crafting',
        kind: 'skilling',
        tier: 9,
        points: 1_500,
        pointsByTier: { 9: 1_500 },
        samples: [
            { t: now, readings: [{ current: 64_329, max: 85_600 }] },
            { t: now + 10_000, readings: [{ current: 68_419, max: 85_600 }] },
        ],
        // The observations as a stale badge files them: real targets pinned a
        // tier or two low, including one landing exactly on a tier the
        // projection will ask about — a T9 target (77,040) filed at T11
        tiers: [
            { tier: 9, total: 81_320 },
            { tier: 10, total: 85_600 },
            { tier: 11, total: 77_040 },
        ],
    });
    const options = { participants: 7, phase: 'live', timeLeftMs: 35 * 60_000 + 29_000, workBase: 40_000 };

    test('the work ladder outvotes the stale badge — T11, not T10', () => {
        const analysis = analyseTrial(screen(), options);

        expect(analysis.rate * 1000).toBeCloseTo(409, 9);
        expect(analysis.tier).toBe(11);
        expect(analysis.tierSource).toBe('work-ladder');
        expect(analysis.tiersClearedSoFar).toBe(10);
    });

    test('…and with no participant count at all, the joint solve reads the same bar', () => {
        const analysis = analyseTrial(screen(), { ...options, participants: 0 });
        expect(analysis.tier).toBe(11);
    });

    test('the next tier is never priced below the bar in hand', () => {
        // 77.3K under an 85,600 bar was a misfiled observation outvoting the
        // live anchor through the nearest-anchor rule; the live bar now
        // anchors alone, and T12 is 85,600 × 2.1/2.0
        const analysis = analyseTrial(screen(), options);

        expect(analysis.next.tier).toBe(12);
        expect(analysis.next.total).toBeCloseTo(89_880, 6);
        expect(analysis.next.total).toBeGreaterThan(analysis.total);
    });

    test('the pace walks the half hour, not one tier', () => {
        // 17,181 left of T11 at 409 work/s, then 89,880 / 94,160 / … per the
        // exact ladder: the 870,761 work the clock buys clears T11 through T19
        const analysis = analyseTrial(screen(), options);

        expect(analysis.pace.limitedBy).toBe('time');
        expect(analysis.pace.finalTier).toBe(19);
        expect(analysis.pace.tiersCleared).toBe(19);

        const html = renderTrialBlock(analysis, 7, { measured: false, reason: 'none' }, { phase: 'live' });
        expect(html).toContain('19 tiers → T19');
        expect(html).not.toContain('→ T10');
        expect(html).toContain('10 tiers');
    });
});

describe('the forecast walks the same ladder as the pace', () => {
    // The second IC screen, both tabs at once: banked 12 (the Lv.210 card,
    // whose 1,664 pts is the twelve-tier base at +28% exactly), bar
    // 67,158/94,160 filling at 316 work/s, 26m44s left — and both tabs read
    // "On pace for 13 tiers → T13". The forecast row *replaces* the pace row
    // whenever a forecast exists, and the forecast had starved: it read
    // `analysis.tiers`, a field the analysis never carried, found no ladder
    // past the current tier, and its one-tier walk rendered as the hour's
    // verdict with no "at least" — that caption belongs to the pace row it
    // was suppressing.
    const screen = (extra = {}) => ({
        ...extra,
        name: 'Crafting',
        kind: 'skilling',
        tier: 12,
        points: 1_664,
        pointsByTier: { 12: 1_664 },
        samples: [
            { t: now, readings: [{ current: 63_998, max: 94_160 }] },
            { t: now + 10_000, readings: [{ current: 67_158, max: 94_160 }] },
        ],
        tiers: [],
    });
    const options = { participants: 7, phase: 'live', timeLeftMs: 26 * 60_000 + 44_000, workBase: 40_000 };

    test('the rendered block projects T17 — and both tabs share this exact path', () => {
        const analysis = analyseTrial(screen(), options);
        expect(analysis.tier).toBe(13);
        expect(analysis.rate * 1000).toBeCloseTo(316, 9);
        expect(analysis.next.total).toBeCloseTo(98_440, 6);

        // The analysis now carries what the forecast reads off it
        expect(analysis.tiers).toEqual([]);
        expect(analysis.personalByTier).toEqual({});

        // 85s finishes T13; 98,440 / 102,720 / 107,000 / 111,280 fit in the
        // remaining ~25 minutes and T18's 115,560 does not — seventeen tiers
        const forecast = forecastTrial({ analysis, participants: 7 });
        expect(forecast.tiersCleared).toBe(17);
        expect(forecast.limitedBy).toBe('time');
        // …and the two walks, now on one anchor, agree to the tier
        expect(analysis.pace.tiersCleared).toBe(17);

        const html = renderTrialBlock(analysis, 7, { measured: false, reason: 'none' }, { phase: 'live', forecast });
        expect(html).toContain('17 tiers → T17');
        expect(html).not.toContain('13 tiers');
    });

    test('the personal figures the analysis carries are the reading character’s', () => {
        // The record is the guild's and both alts write to it; the footer's
        // figures are the reader's own, and a decline fitted across two
        // characters' readings is a curve through two different players
        const shared = screen({
            personalByCharacter: {
                111: { personal: {}, personalByTier: { 13: { 'Success Rate': '49.6%' } } },
                222: { personal: {}, personalByTier: { 13: { 'Success Rate': '8.0%' } } },
            },
        });

        expect(analyseTrial(shared, { ...options, characterId: 111 }).personalByTier).toEqual({
            13: { 'Success Rate': '49.6%' },
        });
        expect(analyseTrial(shared, { ...options, characterId: 222 }).personalByTier).toEqual({
            13: { 'Success Rate': '8.0%' },
        });
        expect(analyseTrial(shared, { ...options, characterId: 333 }).personalByTier).toEqual({});
    });
});

describe('the combat tier from the card alone', () => {
    // The spectated Trial Chameleon that never learned its tier: the fight
    // view's bars read 476,238/572,000 (boss health, participant-scaled) and
    // 547,970/550,000 (the tier's own pool, level-scaled only) while the card
    // said "tier not seen yet" throughout.
    const fight = (extra = {}) => ({
        name: 'Trial Chameleon',
        kind: 'combat',
        tier: null,
        samples: [
            {
                t: now,
                readings: [
                    { current: 500_000, max: 572_000 },
                    { current: 547_000, max: 550_000 },
                ],
            },
            {
                t: now + 10_000,
                readings: [
                    { current: 476_238, max: 572_000 },
                    { current: 547_970, max: 550_000 },
                ],
            },
        ],
        tiers: [],
        ...extra,
    });

    test('the pool bar identifies the tier with no participant count needed', () => {
        // A wrong participant count is handed in on purpose: the second bar
        // carries no participant factor, so it cannot be led astray by one
        const analysis = analyseTrial(fight(), { participants: 17, phase: 'live', workBase: 550_000 });

        expect(analysis.tier).toBe(1);
        expect(analysis.tierSource).toBe('work-ladder');
        expect(analysis.tiersClearedSoFar).toBe(0);
    });

    test('the boss health anchors it too, when the pool bar is absent', () => {
        const oneBar = {
            ...fight(),
            samples: [{ t: now, readings: [{ current: 476_238, max: 572_000 }] }],
        };
        const analysis = analyseTrial(oneBar, { participants: 4, phase: 'live', workBase: 550_000 });

        expect(analysis.tier).toBe(1);
        expect(analysis.tierSource).toBe('work-ladder');
    });

    test('the spectated stream’s stated tier persists like the skilling socket’s', () => {
        const analysis = analyseTrial(fight({ liveTier: 2, liveTierTarget: 572_000 }), {
            participants: 4,
            phase: 'live',
        });

        // 572,000 is still the bar in hand, so the statement holds
        expect(analysis.tier).toBe(2);
        expect(analysis.tierSource).toBe('socket');
        expect(analysis.tiersClearedSoFar).toBe(1);
    });

    test('the combat caption names the boss’s health rather than a work total', () => {
        const analysis = analyseTrial(fight(), { participants: 4, phase: 'live', workBase: 550_000 });
        const html = renderTrialBlock(analysis, 4, { measured: false, reason: 'none' }, { phase: 'live' });

        expect(html).toContain('derived from the boss’s full health');
        expect(html).not.toContain('tier not seen yet');
    });
});

describe('a trial that banked nothing', () => {
    test('a stated zero outranks the completed badge', () => {
        // The wipe case: "Lv.100, 0 pts, Completed" is a party that fell before
        // clearing tier one, not a party that finished the tier it was fighting
        const analysis = analyseTrial(
            record({ kind: 'combat', tier: 1, level: 100, points: 0, pointsByTier: { 1: 0 }, completed: true }),
            {}
        );

        expect(analysis.tiersClearedSoFar).toBe(0);
        expect(analysis.tier).toBe(1);
        expect(analysis.points.basePoints).toBe(0);
    });

    test('a completed card whose points were never seen is unchanged', () => {
        // Absent is not zero, and a card read only on the In Progress tab has
        // never stated its points at all
        const analysis = analyseTrial(record({ kind: 'combat', tier: 3, completed: true, points: undefined }), {});
        expect(analysis.tiersClearedSoFar).toBe(3);
    });

    test('and it contributes nothing to the payout rather than a tier’s worth', () => {
        const wiped = analyseTrial(
            record({ kind: 'combat', tier: 1, level: 100, points: 0, pointsByTier: { 1: 0 }, completed: true }),
            {}
        );
        expect(wiped.points.basePoints).toBe(0);

        const banked = analyseTrial(
            record({ kind: 'combat', tier: 1, level: 100, points: 400, pointsByTier: { 1: 400 }, completed: true }),
            {}
        );
        expect(banked.points.basePoints).toBeGreaterThan(0);
    });
});

describe('the badge counts what is banked', () => {
    // The live sequence that settled it: after the first clear the card read
    // "Lv.100, 236 pts, T1"; after the second, "Lv.110, 354 pts, T2" — while the
    // pool on the In Progress tab was visibly the third one. So the badge is
    // tiers finished and the tier being fought is one past it.
    test('a T2 badge means two banked and the third in progress', () => {
        const analysis = analyseTrial(record({ kind: 'skilling', tier: 2 }), { phase: 'live' });

        expect(analysis.tiersClearedSoFar).toBe(2);
        expect(analysis.tier).toBe(3);
    });

    test('a finished card is what it reached, with nothing in progress', () => {
        const analysis = analyseTrial(record({ kind: 'combat', tier: 3, completed: true }), { phase: 'completed' });

        expect(analysis.tiersClearedSoFar).toBe(3);
        expect(analysis.tier).toBe(3);
    });

    test('the block says two banked under a T2 badge, not one', () => {
        const analysis = analyseTrial(record({ kind: 'skilling', tier: 2 }), { phase: 'live' });
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        expect(html).toContain('2 tiers');
    });
});

describe('the narrow block beside a card', () => {
    // The reported screenshot, row for row: labels ellipsized to stubs — "C… |
    // 0 tiers → T1 (Lv.100)", "Expe… | not projectable", "Ban… | tier not seen
    // yet" — in the ~250px block that sits beside a 126px card. A label cut to
    // one letter is worse than a wrapped one.
    const rowsOf = (html) => html.split('</div>').filter((part) => part.includes('span'));

    test('no label is ever cut off', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                tier: null,
                samples: [
                    { t: now, readings: [{ current: 876, max: 40_800 }] },
                    { t: now + 10_000, readings: [{ current: 1756, max: 40_800 }] },
                ],
            }),
            { phase: 'live', timeLeftMs: 40 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        // Nothing truncates, and nothing breaks inside a word: "Expecte / d"
        // with an orphan letter under it was the reported result of the last fix
        expect(html).not.toContain('text-overflow:ellipsis');
        expect(html).not.toContain('overflow-wrap:anywhere');
        expect(html).toContain('word-break:normal');
        for (const row of rowsOf(html)) expect(row).not.toMatch(/white-space:nowrap;">[^<]{1,4}…/);

        // And the labels are whole words
        expect(html).toContain('On pace for');
        expect(html).toContain('Banked');
    });

    test('a long value takes the full width with its label above it', () => {
        // "0 tiers → T1 (Lv.100)" has no business sharing a line with a label in
        // a block this narrow — it is the row the screenshot showed as "C… | 0
        // tiers → T1 (Lv.100)"
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                tier: 1,
                tiers: [
                    { tier: 1, total: 40_800 },
                    { tier: 2, total: 44_880 },
                ],
                samples: [
                    { t: now, readings: [{ current: 876, max: 40_800 }] },
                    { t: now + 10_000, readings: [{ current: 1756, max: 40_800 }] },
                ],
            }),
            { phase: 'live', timeLeftMs: 40 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        const pace = html.split('</div>').find((part) => part.includes('→'));
        expect(pace).toBeTruthy();
        // Stacked: the value is its own full-width line, not a squeezed column
        expect(pace).not.toContain('justify-content:space-between');
        // With the whole label above it
        expect(html).toContain('>On pace for</div>');
    });

    test('a short figure still sits beside its label', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 1000, max: 65_280 }] },
                    { t: now + 10_000, readings: [{ current: 1880, max: 65_280 }] },
                ],
            }),
            { phase: 'live' }
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { phase: 'live' });

        const rate = html.split('</div>').find((part) => part.includes('Fill rate'));
        expect(rate).toContain('justify-content:space-between');
        expect(rate).toContain('\u00a0work/s');
    });
});

describe('one row set per phase', () => {
    /** Nothing attributed, which is the usual case for a trial nobody joined */
    const breakdown = { measured: false, reason: 'no trial fight seen yet', players: [] };

    // Reported from two screenshots. A scheduled card stacked three rows all
    // saying variations of "nothing yet"; a finished card offered to fit a
    // growth curve for a tier that will never be fought, and told a player who
    // was not in the trial that its rate was "not measured".
    const combat = (extra = {}) => analyseTrial(record({ kind: 'combat', tier: 4, completed: true, ...extra }), {});

    test('a scheduled card is one line, with the countdown', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 6 }), {}), 3, breakdown, {
            phase: 'scheduled',
            startsInMs: 2 * 3600_000 + 24 * 60_000,
        });

        expect(html).toContain('scheduled');
        expect(html).toContain('2h');
        // And none of the three rows that used to sit under it
        expect(html).not.toContain('Banked');
        expect(html).not.toContain('Per player');
        expect(html).not.toContain('Next tier');
    });

    test('a scheduled card with no countdown still says only that', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 6 }), {}), 3, breakdown, { phase: 'scheduled' });
        expect(html).toContain('scheduled');
        expect(html).not.toContain('Banked');
    });

    test('a completed card is results only', () => {
        const analysis = combat({
            samples: [
                { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
            ],
        });
        const html = renderTrialBlock(analysis, 3, breakdown, { phase: 'completed' });

        expect(html).toContain('Final party DPS');
        expect(html).toContain('Banked');
        // Nothing about a future that is not coming
        expect(html).not.toContain('Next tier');
        expect(html).not.toContain('On pace for');
        expect(html).not.toContain('Kill in');
        expect(html).not.toContain('Per player');
    });

    test('a completed trial nobody joined shows the facts and no absences', () => {
        // "Final fill rate | not measured" beside "no trial fight seen here" is
        // two ways of saying the same nothing
        const html = renderTrialBlock(
            analyseTrial(record({ kind: 'combat', tier: 4, completed: true }), {}),
            3,
            breakdown,
            {
                phase: 'completed',
                participating: false,
            }
        );

        expect(html).not.toContain('not measured');
        expect(html).not.toContain('Per player');
        expect(html).not.toContain('only trials you join');
        // What is known is still shown
        expect(html).toContain('Banked');
        expect(html).toContain('4 tiers');
    });

    test('a live card keeps the full set', () => {
        const analysis = analyseTrial(
            record({
                kind: 'skilling',
                samples: [
                    { t: now, readings: [{ current: 1000, max: 65_280 }] },
                    { t: now + 10_000, readings: [{ current: 2060, max: 65_280 }] },
                ],
            }),
            { timeLeftMs: 20 * 60_000 }
        );
        const html = renderTrialBlock(analysis, 3, breakdown, { phase: 'live' });

        expect(html).toContain('Fill rate');
        expect(html).toContain('Banked');
        expect(html).toContain('On pace for');
    });

    test('a value never gives up its unit', () => {
        const analysis = analyseTrial(
            record({
                kind: 'combat',
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            {}
        );
        const html = renderTrialBlock(analysis, 3, breakdown, { phase: 'live' });

        // Non-breaking space between the number and its unit, and a value
        // column that does not wrap or shrink
        expect(html).toContain('\u00a0dmg/s');
        expect(html).toMatch(/white-space:nowrap; *flex:0 0 auto;/);
    });
});

describe('the arrow points at the count', () => {
    /** Nothing attributed */
    const breakdown = { measured: false, reason: 'no trial fight seen yet', players: [] };

    /**
     * A skilling trial four tiers deep, part way into a fifth.
     * @param {number} timeLeftMs - What is left of the hour
     * @returns {Object} The analysis
     */
    const atBoundary = (timeLeftMs) =>
        analyseTrial(
            record({
                name: 'Trial Foraging',
                kind: 'skilling',
                level: 130,
                // The badge counts what is banked: four, with the fifth running
                tier: 4,
                pointsByTier: { 4: 590 },
                tiers: [
                    { tier: 4, total: 53_040 },
                    { tier: 5, total: 57_120 },
                ],
                samples: [
                    { t: now, readings: [{ current: 20_000, max: 57_120 }] },
                    // 500 work in ten seconds — 50 a second
                    { t: now + 10_000, readings: [{ current: 20_500, max: 57_120 }] },
                ],
            }),
            { participants: 2, timeLeftMs, phase: 'live' }
        );

    test('a tier entered and not finished does not move the target', () => {
        // 36,620 work left at 50/s is twelve minutes, and there are five. So
        // four tiers are banked and four is where this ends — the panel used to
        // draw "4 tiers → T5" here, pointing at the tier being worked on
        const analysis = atBoundary(5 * 60_000);
        expect(analysis.tier).toBe(5);
        expect(analysis.tiersClearedSoFar).toBe(4);
        expect(analysis.pace.tiersCleared).toBe(4);

        const html = renderTrialBlock(analysis, 2, breakdown, { phase: 'live' });
        expect(html).toContain('4 tiers → T4 (Lv.130)');
        expect(html).not.toContain('→ T5');
    });

    test('once the fifth fits, both numbers move together', () => {
        const analysis = atBoundary(20 * 60_000);
        expect(analysis.pace.tiersCleared).toBe(5);

        const html = renderTrialBlock(analysis, 2, breakdown, { phase: 'live' });
        expect(html).toContain('5 tiers → T5 (Lv.140)');
        expect(html).not.toContain('→ T4');
    });
});

describe('the expected-tier row', () => {
    /** Nothing attributed */
    const breakdown = { measured: false, reason: 'no trial fight seen yet', players: [] };

    test('with no measured slowdown there is one prediction, not two', () => {
        // "On pace for 4 tiers → T4" beside "Expected ~T3" is two bare numbers
        // disagreeing; a reader cannot tell which to believe
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: { tier: 4, tiersCleared: 4, source: 'measured', limitedBy: 'time', coverage: null },
        });

        expect(html).toContain('On pace for');
        expect(html).toContain('4 tiers → T4');
        expect(html).not.toContain('Expected');
        expect(html).toContain('derived from the game');
    });

    test('a measured slowdown shows only the Expected row, flat number in its tooltip', () => {
        const html = renderTrialBlock(
            analyseTrial(
                record({
                    kind: 'skilling',
                    tier: 2,
                    tiers: [
                        { tier: 2, total: 44_880 },
                        { tier: 3, total: 48_960 },
                    ],
                    samples: [
                        { t: now, readings: [{ current: 1000, max: 44_880 }] },
                        { t: now + 10_000, readings: [{ current: 2000, max: 44_880 }] },
                    ],
                }),
                { timeLeftMs: 40 * 60_000, phase: 'live' }
            ),
            3,
            breakdown,
            {
                phase: 'live',
                forecast: {
                    tier: 4,
                    tiersCleared: 4,
                    source: 'measured',
                    limitedBy: 'time',
                    decline: { perTier: -0.08, rate: 0.576, atTier: 3, observations: 3 },
                },
            }
        );

        // Only the realistic row is shown; the flat projection is not printed as a
        // second figure, but its number survives in the Expected row's tooltip
        expect(html).not.toContain('On pace (flat)');
        expect(html).not.toContain('Expected (slowing)');
        expect(html).toContain('Expected');
        expect(html).toContain('8.0 points a tier');
        expect(html).toContain('held flat, ignoring the slowdown');
    });

    test('an estimated one says how many loadouts it rests on', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 8, breakdown, {
            phase: 'live',
            forecast: {
                tier: 4,
                tiersCleared: 4,
                source: 'estimated',
                limitedBy: 'time',
                coverage: { known: 3, of: 8 },
            },
        });

        expect(html).toContain('4 tiers → T4');
        expect(html).toContain('3 of 8 members');
        expect(html).toContain('rough shape rather than a measurement');
    });

    test('a long fight is reported as enraged, not as impossible', () => {
        // Enrage is a stacking buff — one stack a minute to ten, +10% accuracy
        // and +10% damage each — so a fight past ten minutes is dangerous
        // rather than unwinnable. The projection keeps its tier and says what
        // it cannot model: the deaths.
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: {
                tier: 5,
                tiersCleared: 5,
                source: 'measured',
                limitedBy: 'time',
                enragedFrom: 4,
                coverage: null,
            },
        });

        expect(html).toContain('fully enraged');
        expect(html).toContain('→ T5');
        expect(html).toContain('+100% damage and +100% accuracy');
        expect(html).toContain('expect deaths to slow this');
        expect(html).not.toContain('wall');
    });

    test('a fight inside ten minutes says nothing about enrage', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: { tier: 4, tiersCleared: 4, source: 'measured', limitedBy: 'time', enragedFrom: null },
        });

        expect(html).not.toContain('enrage');
    });

    test('nothing to project says which kind of nothing', () => {
        const html = renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
            phase: 'live',
            forecast: { tier: null, source: 'none', reason: 'no clock on the tab' },
        });

        expect(html).toContain('not projectable');
        expect(html).toContain('no clock on the tab');
    });

    test('a finished or scheduled card does not carry one at all', () => {
        const forecast = { tier: 6, source: 'measured', limitedBy: 'time' };
        expect(
            renderTrialBlock(analyseTrial(record({ tier: 2 }), {}), 3, breakdown, {
                phase: 'scheduled',
                forecast,
            })
        ).not.toContain('Expected');
        expect(
            renderTrialBlock(analyseTrial(record({ tier: 2, completed: true }), {}), 3, breakdown, {
                phase: 'completed',
                forecast,
            })
        ).not.toContain('Expected');
    });
});

describe('renderTrialPlayers', () => {
    const breakdown = {
        measured: true,
        fights: 3,
        players: [
            {
                name: 'Tib',
                damage: 750_000,
                dps: 5000,
                share: 75,
                hits: 120,
                crits: 12,
                misses: 5,
                accuracy: 0.96,
                critRate: 0.1,
                deaths: 0,
            },
            {
                name: 'Moo',
                damage: 250_000,
                dps: 1600,
                share: 25,
                hits: 60,
                crits: 0,
                misses: 40,
                accuracy: 0.6,
                critRate: 0,
                deaths: 2,
            },
        ],
    };

    test('a line per player, with the share and the deaths', () => {
        const html = renderTrialPlayers(breakdown).join('');

        expect(html).toContain('Tib');
        expect(html).toContain('75%');
        expect(html).toContain('Moo');
        expect(html).toContain('2✝');
        expect(html).toContain('3 fights');
    });

    test('a partial split says how much of the party it covers', () => {
        // The spectated Chameleon export: seven on the roster, two with a damage
        // row because the stream carried no other player's counters. The header
        // must say "2 of 7" and the caption must scope the shares, or the two
        // names summing to 100% read as a claim the party is two people
        const partial = {
            ...breakdown,
            source: 'spectated',
            participants: 7,
            roster: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
        };
        const html = renderTrialPlayers(partial).join('');

        expect(html).toContain('2 of 7');
        expect(html).toContain('shares of the 2 attributed');
        expect(html).toContain('5 not yet split out');
    });

    test('a fully covered party gets no coverage annotation', () => {
        const full = { ...breakdown, source: 'spectated', participants: 2 };
        const html = renderTrialPlayers(full).join('');

        expect(html).toContain('3 fights');
        expect(html).not.toContain('of 2');
        expect(html).not.toContain('not yet split out');
    });

    test('the row spends its pixels on the name, not on a unit', () => {
        // In a 108px fight-view cell "B… 1.5K dmg/s · 36%" was the reported
        // result of spending them on a unit the header already implies. The
        // name is guaranteed a readable minimum; the tooltip has it all.
        const html = renderTrialPlayers(breakdown).join('');

        expect(html).toContain('5.0K/s');
        expect(html).not.toContain('dmg/s');
        expect(html).toContain('min-width:5ch');
    });

    test('a long name shares its row with its figures instead of pushing them off it', () => {
        // Reported from a fight-view screenshot: "Orven 273 dmg/s · 38%" held
        // one line while "MillenniumTest" dropped its figures onto a second —
        // the row builder stacked any name longer than a label. The injected
        // panel can be as narrow as a 108px combat-unit cell, so the name
        // ellipsizes on its own row rather than stacking, and the full name
        // moves into the tooltip where a cut one can be read back.
        const longName = {
            ...breakdown,
            players: [{ ...breakdown.players[0], name: 'MillenniumTest' }],
        };
        const html = renderTrialPlayers(longName).join('');
        const row = html.split('</div>').find((part) => part.includes('MillenniumTest'));

        // A flex pair, never the stacked caption form
        expect(row).toContain('justify-content:space-between');
        expect(row).toContain('text-overflow:ellipsis');
        // The full name survives in the tooltip even when the row cuts it
        expect(html).toMatch(/title="MillenniumTest — /);
    });

    test('nothing measured is an instruction, not an apology', () => {
        // "no trial fight seen here" reads as a fight that could have been seen
        // and was not, and was reported as a bug twice on that basis. The fight
        // is real and streams to whoever opens the In Progress fight view
        const html = renderTrialPlayers({ measured: false, reason: 'the monsters are not this week’s trial' }).join('');

        expect(html).toContain('Per player');
        expect(html).toContain('open the fight view');
        expect(html).toContain('fills from the trial');
        expect(html).not.toContain('no trial fight seen here');
    });

    test('a watched fight with nothing attributed yet says exactly that', () => {
        const html = renderTrialPlayers({
            measured: false,
            source: 'spectated',
            reason: 'watched',
            pool: { encounter: 'chameleon' },
        }).join('');

        expect(html).toContain('watched, nothing attributed yet');
        expect(html).toContain('fills in as hits land');
        // The support figures did arrive, and the line must not imply otherwise
        expect(html).toContain('Damage taken, healing and mana come through');
    });

    test('a watched fight nothing has identified asks for one click', () => {
        // No card may claim it until it is named — better "no data" on both
        // combat cards than the right number on the wrong trial
        const html = renderTrialPlayers({
            measured: false,
            source: 'spectated',
            reason: 'watched',
            pool: { encounter: null },
        }).join('');

        expect(html).toContain('click the boss to identify');
        expect(html).toContain('attach to none');
    });

    test('a measured split says it was watched', () => {
        const html = renderTrialPlayers({
            measured: true,
            source: 'spectated',
            fights: 2,
            players: [
                {
                    name: 'ICMeow',
                    damage: 1000,
                    dps: 100,
                    share: 100,
                    hits: 4,
                    crits: 1,
                    accuracy: 1,
                    critRate: 0.25,
                    deaths: 0,
                },
            ],
        }).join('');

        expect(html).toContain('2 fights · watched');
        expect(html).toContain('ICMeow');
    });

    test('a stale trial says it is the last one', () => {
        const html = renderTrialPlayers({ measured: false, stale: true, reason: 'old' }).join('');
        expect(html).toContain('last trial, not this one');
    });

    test('no breakdown at all draws nothing rather than throwing', () => {
        expect(renderTrialPlayers(null)).toEqual([]);
    });

    test('the two ways of measuring party DPS are checked against each other', () => {
        // The bar says one thing and the battle feed says another. They measure
        // the same quantity by different routes, so a large gap means one of
        // them is watching the wrong fight — worth a line rather than two
        // numbers on screen that quietly differ.
        const combat = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            {}
        );
        expect(combat.rate * 1000).toBeCloseTo(10_000, 6);

        const disagreeing = renderTrialBlock(combat, 0, { ...breakdown, partyDps: 1000 });
        expect(disagreeing).toContain('Split disagrees');

        const agreeing = renderTrialBlock(combat, 0, { ...breakdown, partyDps: 9500 });
        expect(agreeing).not.toContain('Split disagrees');

        // Nothing attributed is nothing to check against
        expect(renderTrialBlock(combat, 0, { measured: false, reason: 'none' })).not.toContain('Split disagrees');
    });

    test('a trial this character is not in says so, instead of measuring forever', () => {
        // Reported: cards for other people's trials sat on "measuring…" and
        // "tier not known yet" all week. No reading can ever arrive for them —
        // the In Progress tab shows only this character's own trials.
        const analysis = analyseTrial(record({ tier: 6, samples: [] }), {});
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: false });

        expect(html).toContain('only trials you join');
        expect(html).not.toContain('measuring…');
        expect(html).not.toContain('On pace for');
        // What the Trials tab does say about it is still shown
        expect(html).toContain('Banked');
    });

    test('not knowing whether they are in it keeps the older wording', () => {
        const analysis = analyseTrial(record({ tier: 6, samples: [] }), {});
        const unknown = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: null });

        expect(unknown).toContain('measuring…');
        expect(unknown).not.toContain('only trials you join');
    });

    test('a trial they are in that has a reading is measured as ever', () => {
        const analysis = analyseTrial(
            record({
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
            }),
            {}
        );
        const html = renderTrialBlock(analysis, 3, { measured: false, reason: 'none' }, { participating: true });

        expect(html).toContain('Party DPS');
        expect(html).not.toContain('only trials you join');
    });

    test('the completed card makes the banked count exact', () => {
        // The settled question. Trial Chameleon finished reading "Lv.120, 960
        // pts, T3", and 960 is the ladder's three-tier total at +20% — so on a
        // finished card the badge is the tiers earned, and "Banked 2 tiers"
        // beside it was one short.
        const finished = analyseTrial(
            record({ kind: 'combat', level: 120, tier: 3, completed: true, pointsByTier: { 3: 960 } }),
            { buildersHallBonus: 0.2 }
        );

        expect(finished.tiersClearedSoFar).toBe(3);
        expect(finished.points.guildPoints).toBe(960);
        expect(finished.points.basePoints).toBeCloseTo(800, 6);
        expect(renderTrialBlock(finished, 3, { measured: false, reason: 'none' })).toContain('3 tiers · finished');

        // Still an inference while the trial runs, and it does not claim the
        // tier the party is currently fighting
        const running = analyseTrial(record({ kind: 'combat', level: 120, tier: 3, completed: false }), {});
        expect(running.tiersClearedSoFar).toBe(3);
        expect(renderTrialBlock(running, 3, { measured: false, reason: 'none' })).not.toContain('· finished');
    });

    test('neither a combat block nor a skilling one carries the per-player split', () => {
        // The boss-side block is a summary — Party DPS / Kill in / On pace /
        // Banked — and stays that way even with a measured breakdown in hand;
        // the per-player detail lives only in the dedicated Per-player popup
        // (`guild-trial-scoreboard.js`), reached through its own button.
        const combat = analyseTrial(record({ samples: [{ t: now, readings: [{ current: 1, max: 2 }] }] }), {});
        expect(renderTrialBlock(combat, 0, breakdown)).not.toContain('Per player');

        const skilling = analyseTrial(
            record({ kind: 'skilling', samples: [{ t: now, readings: [{ current: 1, max: 2 }] }] }),
            {}
        );
        expect(renderTrialBlock(skilling, 0, breakdown)).not.toContain('Per player');
    });
});

describe('lastTrialPlayerRows', () => {
    test('rows come off the snapshot, damage-sorted, shares of its own total', () => {
        const rows = lastTrialPlayerRows({
            t: now,
            seconds: 200,
            totalDamage: 100_000,
            players: [
                { name: 'Mill', damage: 25_000, deaths: 2 },
                { name: 'Orven', damage: 75_000, deaths: 0 },
            ],
        });

        const html = rows.join('');
        expect(html).toContain('Per player · final');
        // Sorted by damage, not input order
        expect(html.indexOf('Orven')).toBeLessThan(html.indexOf('Mill'));
        // Shares of the snapshot's own attributed total
        expect(html).toContain('75%');
        expect(html).toContain('25%');
        // Damage over the snapshot's seconds, and deaths marked
        expect(html).toContain('375/s');
        expect(html).toContain('2✝');
    });

    test('nothing persisted is no rows, never a header over nothing', () => {
        expect(lastTrialPlayerRows(null)).toEqual([]);
        expect(lastTrialPlayerRows({ players: [] })).toEqual([]);
        // A roster of zeroes is an absence, not a leaderboard of nothing
        expect(lastTrialPlayerRows({ seconds: 10, players: [{ name: 'Idle', damage: 0, deaths: 0 }] })).toEqual([]);
    });

    test('a snapshot with no clock still states the damage', () => {
        const html = lastTrialPlayerRows({ players: [{ name: 'Orven', damage: 12_345, deaths: 0 }] }).join('');
        expect(html).toContain('Orven');
        expect(html).toContain('12.3K');
        expect(html).toContain('100%');
    });
});

describe('the payout block, audited', () => {
    /**
     * The Trials tab, whose cards carry a tier, a points line and sign-ups and
     * no progress bar at all.
     * @param {...Object} cards - Each `{name, level, points, signups}`
     * @returns {Element} The tab
     */
    function buildTrialsTab(...cards) {
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';

        for (const card of cards) {
            const tile = document.createElement('div');
            tile.className = 'GuildPanel_tile__c';
            tile.innerHTML =
                `<div class="GuildPanel_tileName__d">${card.name}</div>` +
                `<div class="GuildPanel_tileSummary__e">Lv.${card.level}</div>` +
                `<div class="Card_points__g">${card.points} pts</div>` +
                `<div class="Card_signups__h">${card.signups} signed up</div>` +
                (card.completed ? '<div class="Card_state__j">Completed</div>' : '') +
                '<div class="Card_clock__i">20m 53s</div>';
            root.appendChild(tile);
        }

        document.body.appendChild(root);
        return root;
    }

    const fire = () => game.observers['GuildPanel_']();
    const text = () => document.body.textContent;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        game.settings = { guildTrialsInfo: true };
        game.settingListeners = {};
        game.settingValues = {};
        game.clientData = {};
        game.prices = {};
        game.buildingLevels = {};
        game.store = {};
        game.holds = {};
        game.unavailable = false;
        game.members = [];
        game.characterId = null;
        game.characterData = null;
        game.dmHandlers = {};
        game.trialNames = [];
        game.alerts = { status: [], payouts: [], reset: 0 };
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        game.scoreboardToggles = 0;
        game.breakdown = {};
        game.scoreboardContext = null;
        game.skilling = {};
        game.skillingEnded = {};
        resetTrialsSingleton();
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    test('an In Progress card alone says the banked figure is unknown, not zero', () => {
        // The reported screenshot: joined the alchemy trial midway, opened only
        // the In Progress tab, and every payout line read 0
        document.body.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'GuildPanel_trialsContent__a';
        const tile = document.createElement('div');
        tile.className = 'GuildPanel_tile__c';
        tile.innerHTML =
            '<div class="GuildPanel_tileName__d">Alchemy</div>' +
            '<div class="ProgressBar_text__f">18,850 / 65,280</div>';
        root.appendChild(tile);
        document.body.appendChild(root);

        fire();

        expect(text()).toContain('not known yet');
        // The remedy is in the tooltip, where a caption this long belongs
        expect(document.body.innerHTML).toContain('Open the Trials tab');
    });

    test('the cards’ own points are what the guild is paid', () => {
        // The day this was calibrated on. The guild's chat announced "2880
        // Guild Points earned" and the three cards read 840, 1,080 and 960 —
        // the sum, exactly. The panel used to report 2.4K, because it looked
        // each figure up under its own inference about how many tiers were
        // banked, missed by one tier on every trial, and fell through to the
        // ladder.
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };

        buildTrialsTab(
            { name: 'Alchemy', level: 170, points: 1080, signups: '3/56' },
            { name: 'Trial Chameleon', level: 120, points: 960, signups: '3/56' }
        );
        fire();

        expect(guildTrials.record.tiles['skilling::alchemy'].pointsByTier).toEqual({ 8: 1080 });
        expect(guildTrials.record.tiles['combat::trial chameleon'].pointsByTier).toEqual({ 3: 960 });

        // 1,080 + 960 = 2,040 Guild Points banked; base 1,700 at the Builder's
        // Hall's +20%, and half of that at the Treasury's +10% is 935 tokens
        expect(text()).toContain('Guild Points banked2,040');
        expect(text()).toContain('Tokens, every eligible member935');
        expect(text()).toContain('Tokens, if you took part1,403');
        expect(text()).not.toContain('needs checking');
    });

    test('a finished card banks the tier it names, and the block says so', () => {
        // End to end on the settled question: the completed Trial Chameleon
        // read "Lv.120, 960 pts, T3, Completed", and 960 is exactly the
        // ladder's three-tier total once the Builder's Hall +20% is off it
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };

        buildTrialsTab({
            name: 'Trial Chameleon',
            level: 120,
            points: 960,
            signups: '3/56',
            completed: true,
        });
        fire();

        expect(guildTrials.record.tiles['combat::trial chameleon'].completed).toBe(true);
        expect(text()).toContain('3 tiers · finished');
        expect(text()).toContain('Guild Points banked960');
        // 800 of base, half of it at the Treasury's +10%
        expect(text()).toContain('Tokens, every eligible member440');
    });

    test('a card the ladder cannot explain even after the bonus is reported', () => {
        // 1,337 at combat T5 is 1,114 of base against a +20% Builder's Hall,
        // and the ladder says 1,200 cumulative or 200 marginal. That is a real
        // disagreement — unlike every card of every week, which is what the
        // warning this replaces was firing on
        game.buildingLevels = { '/guild_buildings/builders_hall': 10, '/guild_buildings/treasury': 5 };
        buildTrialsTab({ name: 'Trial Chameleon', level: 140, points: 1337, signups: '3/56' });
        fire();

        expect(text()).toContain('neither the running total');
        expect(text()).toContain('needs checking');
    });

    test('a card banked across a Hall upgrade says so, rather than blaming the ladder', () => {
        // MilkMaxxing's own T10 Milking card. The guild levelled its Builder's
        // Hall 5 → 6 during the skilling hour, and points bank live: 500 of base
        // at +10% and 600 at +12% is 1,222 exactly. Today's +12% alone predicts
        // 1,232, so the card divides cleanly by neither bonus
        game.buildingLevels = { '/guild_buildings/builders_hall': 6, '/guild_buildings/treasury': 5 };
        buildTrialsTab({ name: 'Milking', level: 190, points: 1222, signups: '12/106' });
        fire();

        expect(text()).toContain('consistent with a Builder’s Hall upgrade during the trial');
        expect(text()).toContain('Points bank live');
        expect(text()).toContain('used exactly as stated');
        // And it is not the warning about a figure nothing can explain
        expect(text()).not.toContain('neither the running total');
        expect(text()).not.toContain('needs checking');
        // The card is what the guild is paid, unchanged
        expect(text()).toContain('Guild Points banked1,222');
        // …but the tokens are paid on *base*, and dividing 1,222 by today's
        // +12% recovers 1,091 where the tier actually banked 1,100. Half of
        // 1,100 at the Treasury's +10% is 605; the division would have said 600
        expect(text()).toContain('Tokens, every eligible member605');
        // And the banked row's tooltip says where the base came from
        expect(document.body.innerHTML).toContain('banked across a Builder’s Hall upgrade');
    });

    test('the mid-trial-upgrade explainer is Trials-tab prose; In Progress keeps only the figures', () => {
        // The same MilkMaxxing card, seen from the In Progress tab: the payout
        // numbers are wanted at a glance there, the three sentences of ladder
        // provenance are not
        game.buildingLevels = { '/guild_buildings/builders_hall': 6, '/guild_buildings/treasury': 5 };
        const root = buildTrialsTab({ name: 'Milking', level: 190, points: 1222, signups: '12/106' });
        root.className = 'GuildPanel_inProgressTab__a';
        fire();

        expect(text()).not.toContain('consistent with a Builder’s Hall upgrade during the trial');
        expect(text()).not.toContain('used exactly as stated');
        // The figures the prose explained are untouched
        expect(text()).toContain('Guild Points banked1,222');
        expect(text()).toContain('Tokens, every eligible member605');
    });

    test('switching tabs with the payout already drawn re-gates the explainer both ways', () => {
        // The gate reads the tab off the root's class on every pass, and the
        // block is only replaced when its markup moved — so the case worth
        // pinning is the one the initial-draw test cannot reach: a block
        // already on screen when the reader changes tab
        game.buildingLevels = { '/guild_buildings/builders_hall': 6, '/guild_buildings/treasury': 5 };
        const root = buildTrialsTab({ name: 'Milking', level: 190, points: 1222, signups: '12/106' });
        fire();
        expect(text()).toContain('used exactly as stated');

        root.className = 'GuildPanel_inProgressTab__a';
        fire();
        expect(text()).not.toContain('used exactly as stated');
        expect(text()).toContain('Guild Points banked1,222');

        root.className = 'GuildPanel_trialsContent__a';
        fire();
        expect(text()).toContain('used exactly as stated');
    });

    test('with no building level anywhere, the bonus is read back out of the cards', () => {
        // No Buildings tab has been opened and no guild traffic has carried a
        // level, but three cards state Guild Points for tiers whose base the
        // ladder knows — and 840/700, 1,080/900 and 960/800 are all 1.2, which
        // is the Builder's Hall at level 10 recovered from the cards themselves
        game.buildingLevels = {};
        buildTrialsTab(
            { name: 'Milking', level: 150, points: 840, signups: '3/56' },
            { name: 'Alchemy', level: 170, points: 1080, signups: '3/56' }
        );
        fire();

        expect(text()).toContain('Builder’s Hall read as level 10');
        expect(text()).toContain('+20%');
        // Treasury is no longer nagged about — a guild with no levels is right at 0
        expect(text()).not.toContain('No Treasury level seen');
    });
});

describe('the guild message says a trial is running', () => {
    const now = new Date('2026-08-19T12:00:00Z').getTime();

    const message = (over = {}) => ({
        guild: {
            currentTrialsData: JSON.stringify({
                combat: {
                    status: 'in_progress',
                    budgetRemainingMs: 1_800_000,
                    parties: { 1: { done: false } },
                    ...over,
                },
            }),
        },
    });

    beforeEach(() => {
        guildTrials.currentTrials = null;
        guildTrials.socketPhase = null;
    });

    test('a combat trial in progress is read off the payload', () => {
        vi.setSystemTime(now);
        guildTrials._noteCurrentTrials(message());

        expect(guildTrials.currentTrials.combat.inProgress).toBe(true);
        expect(guildTrials.socketPhase).toBe('live');
        expect(guildTrials._trialBudgetMs('combat', now)).toBe(1_800_000);
    });

    test('the deadline counts down from when it was stated', () => {
        vi.setSystemTime(now);
        guildTrials._noteCurrentTrials(message());

        expect(guildTrials._trialBudgetMs('combat', now + 60_000)).toBe(1_740_000);
        // Older than the budget it stated: that trial is over, and counting
        // down past zero says nothing
        expect(guildTrials._trialBudgetMs('combat', now + 40 * 60_000)).toBeNull();
    });

    test('every party done ends it, and so does the status leaving in_progress', () => {
        vi.setSystemTime(now);
        guildTrials._noteCurrentTrials(message());
        guildTrials._noteCurrentTrials(message({ parties: { 1: { done: true } } }));
        expect(guildTrials.socketPhase).toBe('completed');

        guildTrials.socketPhase = null;
        guildTrials._noteCurrentTrials(message());
        guildTrials._noteCurrentTrials(message({ status: '' }));
        expect(guildTrials.socketPhase).toBe('scheduled');
    });

    test('a malformed payload is survived and changes nothing', () => {
        guildTrials._noteCurrentTrials({ guild: { currentTrialsData: '{broken' } });
        guildTrials._noteCurrentTrials({ guild: {} });
        guildTrials._noteCurrentTrials(undefined);

        expect(guildTrials.currentTrials).toBeNull();
        expect(guildTrials.socketPhase).toBeNull();
        expect(guildTrials._trialBudgetMs('combat', now)).toBeNull();
    });

    test('the page beats the parse, and the parse fills a silent page', () => {
        vi.setSystemTime(now);
        guildTrials._noteCurrentTrials(message());

        // Nothing on the tab: the socket's own answer is used
        guildTrials.phase = null;
        guildTrials._noteLifecycle({ phase: null }, [], now);
        expect(guildTrials.phase).toBe('live');

        // The tab says otherwise: what is on screen wins
        guildTrials._noteLifecycle({ phase: 'completed' }, [], now + 1000);
        expect(guildTrials.phase).toBe('completed');
    });

    test('the block draws a deadline, and warns when the projection runs past it', () => {
        const analysis = analyseTrial(
            {
                name: 'Trial Badger',
                kind: 'combat',
                tier: 2,
                samples: [
                    { t: now, readings: [{ current: 618_000, max: 618_000 }] },
                    { t: now + 10_000, readings: [{ current: 518_000, max: 618_000 }] },
                ],
                tiers: [],
                pointsByTier: {},
            },
            { timeLeftMs: 20 * 60_000 }
        );
        const roomy = renderTrialBlock(analysis, 5, undefined, {
            participating: true,
            phase: 'live',
            deadlineMs: 30 * 60_000,
        });
        expect(roomy).toContain('Deadline');
        expect(roomy).not.toContain('does not clear in time');

        const tight = renderTrialBlock(analysis, 5, undefined, {
            participating: true,
            phase: 'live',
            deadlineMs: 1000,
        });
        expect(tight).toContain('does not clear in time');
    });
});

describe('the Trace button', () => {
    beforeEach(() => {
        game.settings.guildTrialDiagnosticTrace = true;
        game.traceStatus = null;
    });
    afterEach(() => {
        delete game.settings.guildTrialDiagnosticTrace;
        game.traceStatus = null;
    });

    test('is absent while the trace setting is off', () => {
        game.settings.guildTrialDiagnosticTrace = false;
        expect(guildTrials._controlsHTML()).not.toContain('data-action="trace"');
    });

    test('carries how good the recording is, not just what it downloads', () => {
        game.traceStatus = {
            running: true,
            traceId: 't1',
            chunkCount: 2,
            gapsOver5s: 3,
            maxGapMs: 40_000,
            startedMidFight: true,
            resumedAcrossReloads: true,
        };
        const html = guildTrials._controlsHTML();

        expect(html).toContain('data-action="trace"');
        expect(html).toContain('Recording — 2 stored chunks.');
        expect(html).toContain('3 gaps over 5s, longest 40s');
        expect(html).toContain('the opening of the tier is not in the file');
        expect(html).toContain('across a page reload');
    });

    test('says only what it downloads while nothing has been traced', () => {
        game.traceStatus = { running: false, traceId: null, chunkCount: 0, gapsOver5s: 0, maxGapMs: null };
        const html = guildTrials._controlsHTML();

        expect(html).toContain('data-action="trace"');
        expect(html).toContain('gzipped NDJSON');
        expect(html).not.toContain('stored chunk');
    });
});

/**
 * Both trial verbs stand in for buttons that live under the trial cards on the
 * In Progress tab — which is to say, reachable only once you have already found
 * the thing they are about. Starting a capture is the one you most want before
 * you have gone looking.
 */
describe('the trial palette verbs', () => {
    /**
     * @param {string} name - As registered
     * @returns {Object|undefined} The verb, as the palette would see it
     */
    const verb = (name) => registeredCommands().find((entry) => entry.name === name);

    beforeEach(async () => {
        resetCommands();
        game.recorder = {
            recording: false,
            activity: [],
            lifecycle: [],
            downloads: [],
            startedBy: null,
            endedBy: null,
        };
        trialsFeature.cleanup();
        resetTrialsSingleton();
        await trialsFeature.initialize();
    });

    afterEach(() => {
        trialsFeature.cleanup();
        resetCommands();
    });

    test('both are offered, as verbs', () => {
        expect(verb('Start trial capture')?.kind).toBe('verb');
        expect(verb('Export trial JSON')?.kind).toBe('verb');
    });

    test('switching the feature off takes both out of the palette', () => {
        trialsFeature.cleanup();
        expect(verb('Start trial capture')).toBeUndefined();
        expect(verb('Export trial JSON')).toBeUndefined();
    });

    test('starting a capture starts it, and marks the session manual', async () => {
        expect(await verb('Start trial capture').run()).toBe('capture started');
        expect(game.recorder.recording).toBe(true);
        // 'button' is what tells the recorder only the player stops this one
        expect(game.recorder.startedBy).toBe('button');
    });

    test('a capture already running is said so, not silently restarted', async () => {
        game.recorder.recording = true;
        game.recorder.startedBy = 'auto';

        expect(await verb('Start trial capture').run()).toBe('already recording');
        // Untouched: a restart would have thrown away what was already recorded
        expect(game.recorder.startedBy).toBe('auto');
    });

    test('exporting answers with the filename it saved under', async () => {
        game.recorder.bundle = { record: { tiles: { 1: {} }, history: [] } };
        game.recorder.downloadName = 'toolasha-trial-2026-08-30T12-00-00-000Z.json';

        expect(await verb('Export trial JSON').run()).toBe('toolasha-trial-2026-08-30T12-00-00-000Z.json');
        expect(game.recorder.downloads).toHaveLength(1);
    });

    test('an empty week is said, not handed over as a file full of nulls', async () => {
        game.recorder.bundle = { record: { tiles: {}, history: [] }, session: null };

        expect(await verb('Export trial JSON').run()).toBe('nothing recorded this week');
        expect(game.recorder.downloads).toEqual([]);
        // Still listed while it has nothing to export
        expect(verb('Export trial JSON')).toBeDefined();
    });

    test('a download that will not start is a failure, not a quiet success', async () => {
        game.recorder.bundle = { record: { tiles: { 1: {} }, history: [] } };
        game.recorder.downloadName = null;

        await expect(verb('Export trial JSON').run()).rejects.toThrow('the download could not be started');
    });
});

/**
 * The sub-modules `initialize()` starts, and whether the teardown reaches them.
 *
 * `initialize()` starts eight things that are not themselves registered
 * features. Seven of them are stood back down by `cleanup()`; `guildMemberSkills`
 * was not, and its `cleanup()` had no caller anywhere in the tree. The switch
 * path hides it — `_forgetCharacter` calls `forget()`, which empties the
 * captures but deliberately keeps the `profile_shared` listener, because the
 * roster panel may still be open. So the gap only shows on a *settings* toggle:
 * turn Guild Trials off and the tracker keeps listening and keeps filing
 * captures, while the `forget()` that kept them character-fresh is gone with
 * the feature — and every later switch files another guild's profiles under the
 * departed guild's key.
 */
describe('the sub-modules initialize() started, when the feature is switched off', () => {
    beforeEach(() => {
        trialsFeature.cleanup();
        guildMemberSkills.cleanup();
        guildMemberSkills.forget();
        resetTrialsSingleton();
        delete game.wsHandlers.profile_shared;
    });

    afterEach(() => {
        trialsFeature.cleanup();
        guildMemberSkills.cleanup();
        guildMemberSkills.forget();
        resetTrialsSingleton();
    });

    test('turning the feature off takes the member-skills profile listener with it', async () => {
        await trialsFeature.initialize();
        // The premise: without this the assertion below would pass on a tracker
        // that had simply never started
        expect(game.wsHandlers.profile_shared, 'the skills tracker never started').toBeTypeOf('function');

        trialsFeature.cleanup();

        expect(game.wsHandlers.profile_shared).toBeUndefined();
        expect(guildMemberSkills.initialized).toBe(false);
    });

    test('and the tracker still re-arms for the roster panel, which can outlive the feature', async () => {
        await trialsFeature.initialize();
        trialsFeature.cleanup();

        // `cleanup()` is a teardown, not a kill switch: `progress()` re-arms on
        // first look, which is what makes it safe for one of two callers to
        // stand the tracker down
        guildMemberSkills.progress();

        expect(game.wsHandlers.profile_shared).toBeTypeOf('function');
    });

    test('and the guild-chat alert listener goes with it too', async () => {
        // Same shape, same file: `_forgetCharacter` calls `reset()`, which drops
        // the pending start timer and keeps the chat listener, so only the
        // teardown can stop it saying "a trial has begun" for a feature that is
        // switched off.
        game.alerts.started = 0;
        game.alerts.stopped = 0;

        await trialsFeature.initialize();
        expect(game.alerts.started).toBe(1);

        trialsFeature.cleanup();

        expect(game.alerts.stopped).toBe(1);
    });

    test('tearing down a tracker that never started, or twice over, is not an error', () => {
        expect(() => guildMemberSkills.cleanup()).not.toThrow();
        expect(() => guildMemberSkills.cleanup()).not.toThrow();
        expect(game.wsHandlers.profile_shared).toBeUndefined();
    });
});
