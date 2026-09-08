/**
 * Session history.
 *
 * A run is archived when a *different* one starts, because that is the first
 * moment it is knowable to be over — nothing on the wire announces an ending.
 * The consequences of that choice are what these test: a session seen twice must
 * not appear twice, and a combined view must merge on the item rather than on
 * the game's per-session slot key.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
const game = vi.hoisted(() => ({ characterId: 'char1' }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => game.characterId, getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    sessionKey,
    withSession,
    mergeSessionRecords,
    mergeSessions,
    combineSessions,
    describeSession,
    MAX_SESSIONS,
    loadSessions,
    archiveSession,
    clearSessions,
} = await import('./combat-session-history.js');

const session = (start, names = ['Millennium44'], loot = {}, experience = {}) => ({
    combatStartTime: start,
    durationSeconds: 600,
    players: names.map((name) => ({ name, loot, experience })),
});

describe('naming a session', () => {
    test('the roster and the start time together', () => {
        expect(sessionKey(session('2026-08-03T01:00:00Z'))).toBe(sessionKey(session('2026-08-03T01:00:00Z')));
        expect(sessionKey(session('2026-08-03T01:00:00Z'))).not.toBe(sessionKey(session('2026-08-03T02:00:00Z')));
    });

    test('the same zone with somebody gone is a different session', () => {
        const party = sessionKey(session('2026-08-03T01:00:00Z', ['A', 'B']));
        const alone = sessionKey(session('2026-08-03T01:00:00Z', ['A']));

        expect(alone).not.toBe(party);
    });

    test('a snapshot that cannot say is not named', () => {
        expect(sessionKey({ players: [] })).toBeNull();
        expect(sessionKey({ players: [{ name: 'A' }] })).toBeNull();
        expect(sessionKey(null)).toBeNull();
    });
});

describe('adding a run to the list', () => {
    test('newest first', () => {
        let history = withSession([], session('2026-08-03T01:00:00Z'));
        history = withSession(history, session('2026-08-03T02:00:00Z'));

        expect(history[0].combatStartTime).toBe('2026-08-03T02:00:00Z');
        expect(history).toHaveLength(2);
    });

    test('the same session twice replaces rather than repeats', () => {
        // The later snapshot is the more complete one — loot totals only grow —
        // so it wins, and the run appears once
        const first = session('2026-08-03T01:00:00Z');
        const later = { ...first, durationSeconds: 1200 };

        const history = withSession(withSession([], first), later);

        expect(history).toHaveLength(1);
        expect(history[0].durationSeconds).toBe(1200);
    });

    test('the list does not grow forever', () => {
        let history = [];
        for (let i = 0; i < MAX_SESSIONS + 5; i++) {
            history = withSession(history, session(`2026-08-03T${String(i).padStart(2, '0')}:00:00Z`));
        }

        expect(history).toHaveLength(MAX_SESSIONS);
    });

    test('a snapshot with no key is ignored rather than stored under one', () => {
        expect(withSession([], { players: [] })).toEqual([]);
    });
});

describe('several runs as one', () => {
    const withLoot = (start, count) => session(start, ['Millennium44'], { 7: { itemHrid: '/items/coin', count } });

    test('loot is merged on the item, not on the game’s slot key', () => {
        // Two sessions number their slots independently, so merging on the raw
        // key would put the same item in two rows
        const combined = combineSessions([
            { ...withLoot('2026-08-03T01:00:00Z', 100) },
            { ...session('2026-08-03T02:00:00Z', ['Millennium44'], { 3: { itemHrid: '/items/coin', count: 50 } }) },
        ]);

        const loot = Object.values(combined.players[0].loot);
        expect(loot).toHaveLength(1);
        expect(loot[0].count).toBe(150);
    });

    test('a character is followed by name across sessions', () => {
        // Position means nothing between runs — the same person is slot 0 in one
        // and slot 3 in the next
        const combined = combineSessions([
            session('2026-08-03T01:00:00Z', ['A', 'B']),
            session('2026-08-03T02:00:00Z', ['B', 'A']),
        ]);

        expect(combined.players.map((player) => player.name).sort()).toEqual(['A', 'B']);
    });

    test('durations add, which is what makes a rate over the lot mean anything', () => {
        const combined = combineSessions([session('2026-08-03T01:00:00Z'), session('2026-08-03T02:00:00Z')]);

        expect(combined.durationSeconds).toBe(1200);
        expect(combined.sessionCount).toBe(2);
    });

    test('experience sums across sessions instead of resetting to the first one seen', () => {
        // The accumulator starts each player at `experience: {}` (so a stale
        // first-session reading is never carried forward silently) but the
        // merge loop only ever folded loot into it, never experience — a
        // combined view of several sessions read as "no experience this week"
        // even though every session it was built from had plenty
        const combined = combineSessions([
            session('2026-08-03T01:00:00Z', ['Millennium44'], {}, { '/skills/attack': 1000 }),
            session('2026-08-03T02:00:00Z', ['Millennium44'], {}, { '/skills/attack': 500, '/skills/defense': 200 }),
        ]);

        expect(combined.players[0].experience).toEqual({ '/skills/attack': 1500, '/skills/defense': 200 });
    });

    test('nothing to combine is null rather than an empty run', () => {
        expect(combineSessions([])).toBeNull();
        expect(combineSessions([{ players: [] }])).toBeNull();
        expect(combineSessions(null)).toBeNull();
    });

    test('a player in only some of the combined sessions is timed by those sessions, not the whole span', () => {
        // A blended rate divides loot by a clock, and the clock has to be the
        // one that was actually running while that player's loot came in. B
        // sat out the second session entirely — charging B's daily rate against
        // both sessions' combined 1200s (instead of the 600s B was actually
        // there for) understates it by half, and the effect only gets worse as
        // more sessions pile up around a player who missed most of them.
        const combined = combineSessions([
            session('2026-08-03T01:00:00Z', ['A', 'B']),
            session('2026-08-03T02:00:00Z', ['A']),
        ]);

        const a = combined.players.find((player) => player.name === 'A');
        const b = combined.players.find((player) => player.name === 'B');
        expect(a.durationSeconds).toBe(1200);
        expect(b.durationSeconds).toBe(600);
        // The group total is still the sum of every session, for whatever
        // still reads it that way
        expect(combined.durationSeconds).toBe(1200);
    });
});

describe('describing one in a picker', () => {
    test('the time it started and how long it ran', () => {
        const line = describeSession(session('2026-08-03T01:00:00Z'), (s) => `${s}s`);

        expect(line).toContain('600s');
    });

    test('a session with no start time still gets a line', () => {
        expect(describeSession({ durationSeconds: 0 })).toContain('Unknown time');
    });

    test('a negative stored duration (clock skew, before it was clamped) reads as zero, not nothing', () => {
        const line = describeSession(session('2026-08-03T01:00:00Z'), (s) => `${s}s`);
        const skewed = describeSession({ ...session('2026-08-03T01:00:00Z'), durationSeconds: -2 }, (s) => `${s}s`);

        expect(line).toContain('600s');
        expect(skewed).toContain('(0s)');
    });
});

describe('the list survives a failed read and a second tab', () => {
    const KEY = 'combatSessionHistory_char1';
    const stored = () => storageMock.storeFor('combatStats').get(KEY);
    const starts = (list) => list.map((s) => s.combatStartTime);

    beforeEach(async () => {
        storageMock.reset();
        game.characterId = 'char1';
        await clearSessions();
        storageMock.reset();
    });

    test('archiving appends newest first under the character key', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        await archiveSession(session('2026-08-03T02:00:00Z'));

        expect(starts(stored())).toEqual(['2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
        expect(starts(await loadSessions())).toEqual(['2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
    });

    test('a read that cannot be made keeps the list in memory instead of one run over all', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        storageMock.unavailable = true;

        const history = await archiveSession(session('2026-08-03T02:00:00Z'));

        expect(history).toHaveLength(2);
        expect(await loadSessions()).toHaveLength(2);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        storageMock.unavailable = true;

        await archiveSession(session('2026-08-03T02:00:00Z'));

        storageMock.unavailable = false;
        expect(starts(stored())).toEqual(['2026-08-03T01:00:00Z']);
    });

    test('a save folds in runs another tab archived meanwhile', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        storageMock
            .storeFor('combatStats')
            .set(KEY, [withSession([], session('2026-08-03T03:00:00Z'))[0], ...stored()]);

        await archiveSession(session('2026-08-03T02:00:00Z'));

        expect(starts(stored())).toEqual(['2026-08-03T03:00:00Z', '2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
    });

    test('once storage reads again the next save lands everything', async () => {
        storageMock.unavailable = true;
        await archiveSession(session('2026-08-03T01:00:00Z'));
        await archiveSession(session('2026-08-03T02:00:00Z'));
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        await archiveSession(session('2026-08-03T03:00:00Z'));

        expect(starts(stored())).toEqual(['2026-08-03T03:00:00Z', '2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
    });

    test('a character switch forgets the departing character’s runs', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        game.characterId = 'char2';

        await archiveSession(session('2026-08-03T09:00:00Z'));

        expect(starts(storageMock.storeFor('combatStats').get('combatSessionHistory_char2'))).toEqual([
            '2026-08-03T09:00:00Z',
        ]);
        expect(starts(stored())).toEqual(['2026-08-03T01:00:00Z']);
    });
});

describe('two observers of one run', () => {
    // The same run seen from two devices: one watched its first hour, the other
    // only its last five minutes. Both archive it under the same key.
    const START = '2026-08-03T01:00:00Z';
    const startMs = new Date(START).getTime();

    const observation = ({ seenAt, coins, xp, deaths, consumed, rate, stack }) => ({
        combatStartTime: START,
        timestamp: startMs + seenAt * 1000,
        durationSeconds: seenAt,
        battleId: `battle-${seenAt}`,
        players: [
            {
                name: 'Millennium44',
                loot: { 7: { itemHrid: '/items/coin', count: coins } },
                experience: { '/skills/attack': xp },
                deathCount: deaths,
                consumables: [
                    {
                        itemHrid: '/items/coffee',
                        actualConsumed: consumed,
                        elapsedSeconds: seenAt,
                        consumptionRate: rate,
                        currentCount: stack,
                        inventoryAmount: stack,
                        consumed: rate * seenAt,
                    },
                ],
                combatStats: { combatDropQuantity: stack },
            },
        ],
    });

    const early = observation({ seenAt: 3600, coins: 900, xp: 400, deaths: 2, consumed: 6, rate: 0.002, stack: 90 });
    const late = observation({ seenAt: 7200, coins: 120, xp: 30, deaths: 1, consumed: 3, rate: 0.001, stack: 40 });

    const expectUnion = (merged) => {
        expect(merged.combatStartTime).toBe(START);
        expect(merged.timestamp).toBe(startMs + 7200 * 1000);
        expect(merged.durationSeconds).toBe(7200);

        const player = merged.players[0];
        expect(player.loot[7].count).toBe(900);
        expect(player.experience['/skills/attack']).toBe(400);
        expect(player.deathCount).toBe(2);

        const coffee = player.consumables[0];
        expect(coffee.actualConsumed).toBe(6);
        expect(coffee.elapsedSeconds).toBe(7200);
        // A rate is not a counter: the later observer's, and `consumed` follows
        // from it and the merged duration rather than being max'd
        expect(coffee.consumptionRate).toBe(0.001);
        expect(coffee.consumed).toBeCloseTo(7.2, 6);
        // A stack falls as it is drunk, so the later reading is the true one
        expect(coffee.currentCount).toBe(40);
        expect(player.combatStats.combatDropQuantity).toBe(40);
        expect(merged.battleId).toBe('battle-7200');
    };

    test('the counters are the max and the span is start to last seen', () => {
        expectUnion(mergeSessionRecords(early, late));
    });

    test('the argument order does not change the result', () => {
        expectUnion(mergeSessionRecords(late, early));
    });

    test('merging the lists combines the shared run instead of replacing it', () => {
        const merged = mergeSessions([{ ...early, key: sessionKey(early) }], [{ ...late, key: sessionKey(late) }]);

        expect(merged).toHaveLength(1);
        expectUnion(merged[0]);
    });

    test('a run only one side has passes through unchanged', () => {
        const other = { ...observation({ seenAt: 60, coins: 5, xp: 1, deaths: 0, consumed: 0, rate: 0, stack: 9 }) };
        other.combatStartTime = '2026-08-03T05:00:00Z';

        const merged = mergeSessions([{ ...early, key: sessionKey(early) }], [{ ...other, key: sessionKey(other) }]);

        expect(merged).toHaveLength(2);
        expect(merged.find((entry) => entry.combatStartTime === '2026-08-03T05:00:00Z')).toEqual({
            ...other,
            key: sessionKey(other),
        });
    });

    test('a player who only one device saw is kept', () => {
        const pair = {
            ...late,
            players: [...late.players, { name: 'Guest', loot: {}, experience: {}, deathCount: 0 }],
        };

        const merged = mergeSessionRecords(early, pair);

        expect(merged.players.map((player) => player.name).sort()).toEqual(['Guest', 'Millennium44']);
    });
});
