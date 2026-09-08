/**
 * What the character-select screen decides from a stored projection.
 *
 * The arithmetic worth testing here is not the durations — those come from Action Time Display,
 * which has its own tests — but the judgement laid on top of them: when a record is too old to
 * believe, when the offline cap becomes the real deadline, and when the honest answer is that
 * there is no answer.
 */

import { describe, test, expect } from 'vitest';
import {
    computeSlotDisplayState,
    resolveDisplayProjection,
    findSegmentAtTime,
    formatActivityLine,
    isRecordExpired,
    formatStaleness,
} from './character-activity-display.js';
import { MAX_RECORD_AGE_MS } from './character-activity-storage.js';

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const PREFS = { enabled: true, dateFormat: 'MM-DD', timeFormat: '24hour' };

/**
 * A record whose queue ends `endsInMs` from `NOW`.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function record({ endsInMs = 4 * HOUR, terminalCause = 'queue', observedAt = NOW, offline = null, segments } = {}) {
    const terminalAt = endsInMs === null ? null : NOW + endsInMs;
    return {
        version: 1,
        characterId: '1234',
        characterName: 'Bessie',
        observedAt,
        offline: offline || { hourCap: null, mooPassExpireTime: null },
        projection: {
            segments: segments || [
                {
                    actionHrid: '/actions/milking/cow',
                    actionName: 'Cow',
                    actionTypeHrid: '/action_types/milking',
                    startAt: NOW,
                    endAt: terminalAt,
                    queuedIndex: 0,
                    certainty: 'trustworthy',
                    stopCause: 'count',
                },
            ],
            terminalCause,
            terminalAt,
            certainty: 'trustworthy',
        },
    };
}

describe('staleness and expiry', () => {
    test('a character never observed says so, and says what to do about it', () => {
        const state = computeSlotDisplayState(null, { id: '1' }, PREFS, NOW);

        expect(state.firstLineText).toBe('No activity data yet');
        expect(state.limiterColor).toBe('neutral');
    });

    test('a record older than the maximum age is expired rather than shown as fact', () => {
        const old = record({ observedAt: NOW - MAX_RECORD_AGE_MS - 1 });
        const state = computeSlotDisplayState(old, { id: '1' }, PREFS, NOW);

        expect(state.firstLineText).toBe('Activity status expired');
        expect(state.limiterColor).toBe('neutral');
        expect(state.limiterText).toContain('last seen');
    });

    test('a record just inside the maximum age is still shown', () => {
        const nearly = record({ observedAt: NOW - MAX_RECORD_AGE_MS + HOUR, endsInMs: 4 * HOUR });
        const state = computeSlotDisplayState(nearly, { id: '1' }, PREFS, NOW);

        expect(state.firstLineText).toBe('Cow');
        expect(state.limiterColor).toBe('green');
    });

    test('a character that went offline after we observed it has moved on without us', () => {
        const state = computeSlotDisplayState(
            record({ observedAt: NOW - HOUR }),
            { id: '1', lastOfflineTime: NOW - HOUR + 60_000 },
            PREFS,
            NOW
        );

        expect(state.firstLineText).toBe('Activity status outdated');
        expect(state.limiterText).toBe('Open character to refresh · last seen 1h 00m 00s ago');
    });

    test('a few seconds of clock skew is not treated as a whole missed session', () => {
        const state = computeSlotDisplayState(
            record({ observedAt: NOW - HOUR }),
            { id: '1', lastOfflineTime: NOW - HOUR + 2000 },
            PREFS,
            NOW
        );

        expect(state.firstLineText).toBe('Cow');
    });

    test('isRecordExpired refuses a record with no timestamp at all', () => {
        expect(isRecordExpired({ observedAt: undefined }, NOW)).toBe(true);
        expect(isRecordExpired({ observedAt: NOW }, NOW)).toBe(false);
    });

    test('formatStaleness never goes negative, even against clock skew that puts the record in the future', () => {
        expect(formatStaleness(NOW + HOUR, NOW)).toBe('0s');
    });

    test('formatStaleness reads the same units timeReadable uses elsewhere', () => {
        expect(formatStaleness(NOW - HOUR, NOW)).toBe('1h 00m 00s');
        expect(formatStaleness(NOW - MAX_RECORD_AGE_MS - HOUR, NOW)).toContain('day');
    });
});

describe('offline cap overlay', () => {
    test('an endless chain with no cap has no deadline to claim', () => {
        const resolved = resolveDisplayProjection(record({ endsInMs: null, terminalCause: 'infinite' }), null);

        expect(resolved.terminalCause).toBe('unknown');
        expect(resolved.terminalAt).toBeNull();
    });

    test('an endless chain under a cap ends when offline progress does', () => {
        const wentOffline = NOW - HOUR;
        const resolved = resolveDisplayProjection(
            record({ endsInMs: null, terminalCause: 'infinite', offline: { hourCap: 8, mooPassExpireTime: null } }),
            wentOffline
        );

        expect(resolved.terminalCause).toBe('offline');
        expect(resolved.terminalAt).toBe(wentOffline + 8 * HOUR);
    });

    test('a queue that ends before the cap keeps its own deadline', () => {
        const resolved = resolveDisplayProjection(
            record({ endsInMs: 2 * HOUR, offline: { hourCap: 8, mooPassExpireTime: null } }),
            NOW
        );

        expect(resolved.terminalCause).toBe('queue');
        expect(resolved.terminalAt).toBe(NOW + 2 * HOUR);
    });

    test('a cap that lands first replaces the queue’s own deadline', () => {
        const resolved = resolveDisplayProjection(
            record({ endsInMs: 20 * HOUR, offline: { hourCap: 8, mooPassExpireTime: null } }),
            NOW
        );

        expect(resolved.terminalCause).toBe('offline');
        expect(resolved.terminalAt).toBe(NOW + 8 * HOUR);
    });

    test('a MooPass expiring inside the offline window fails closed instead of reassuring', () => {
        const resolved = resolveDisplayProjection(
            record({
                endsInMs: null,
                terminalCause: 'infinite',
                offline: { hourCap: 24, mooPassExpireTime: NOW + 2 * HOUR },
            }),
            NOW
        );

        expect(resolved.terminalCause).toBe('unknown');
        expect(resolved.terminalAt).toBeNull();
    });

    test('a MooPass that expired before the offline window began leaves the cap trusted (TLA-025B)', () => {
        const wentOffline = NOW;
        const resolved = resolveDisplayProjection(
            record({
                endsInMs: null,
                terminalCause: 'infinite',
                offline: { hourCap: 24, mooPassExpireTime: wentOffline - HOUR },
            }),
            wentOffline
        );

        expect(resolved.terminalCause).toBe('offline');
        expect(resolved.terminalAt).toBe(wentOffline + 24 * HOUR);
    });

    test('an already-uncertain projection is never turned into a claim by the cap', () => {
        const resolved = resolveDisplayProjection(
            record({ endsInMs: null, terminalCause: 'unknown', offline: { hourCap: 8, mooPassExpireTime: null } }),
            NOW
        );

        expect(resolved.terminalCause).toBe('unknown');
    });
});

describe('the two lines a slot shows', () => {
    test('plenty of runway is green and names the action', () => {
        const state = computeSlotDisplayState(record({ endsInMs: 4 * HOUR }), { id: '1' }, PREFS, NOW);

        expect(state.limiterColor).toBe('green');
        expect(state.firstLineText).toBe('Cow');
        expect(state.limiterText).toContain('Queue ends');
    });

    test('under an hour left is amber', () => {
        const state = computeSlotDisplayState(record({ endsInMs: 30 * 60 * 1000 }), { id: '1' }, PREFS, NOW);

        expect(state.limiterColor).toBe('yellow');
    });

    test('a deadline already past is red and in the past tense', () => {
        const state = computeSlotDisplayState(record({ endsInMs: -HOUR }), { id: '1' }, PREFS, NOW);

        expect(state.limiterColor).toBe('red');
        expect(state.limiterText).toContain('Queue ended');
        expect(state.firstLineText).toBe('No active action expected');
    });

    test('an idle character is red and says only that', () => {
        const idle = record({ endsInMs: 0, terminalCause: 'idle', segments: [] });
        const state = computeSlotDisplayState(idle, { id: '1' }, PREFS, NOW);

        expect(state.limiterColor).toBe('red');
        expect(state.limiterText).toBe('Character is idle');
    });

    test('an uncertain action names itself but claims no end time', () => {
        const combat = record({
            endsInMs: null,
            terminalCause: 'unknown',
            segments: [
                {
                    actionHrid: '/actions/combat/fly',
                    actionName: 'Fly',
                    actionTypeHrid: '/action_types/combat',
                    startAt: NOW,
                    endAt: null,
                    queuedIndex: 0,
                    certainty: 'uncertain',
                    stopCause: 'unknown',
                },
            ],
        });
        const state = computeSlotDisplayState(combat, { id: '1' }, PREFS, NOW);

        expect(state.firstLineText).toBe('Fly');
        expect(state.limiterText).toBe('End time unavailable');
        expect(state.limiterColor).toBe('neutral');
    });

    test('what is still queued behind the running action is counted', () => {
        const queued = record({
            endsInMs: 6 * HOUR,
            segments: [
                { actionName: 'Cow', actionTypeHrid: '/action_types/milking', startAt: NOW, endAt: NOW + HOUR },
                { actionName: 'Cheese', actionTypeHrid: '/action_types/cheesesmithing', endAt: NOW + 3 * HOUR },
                { actionName: 'Bread', actionTypeHrid: '/action_types/cooking', endAt: NOW + 6 * HOUR },
            ],
        });
        const state = computeSlotDisplayState(queued, { id: '1' }, PREFS, NOW);

        expect(state.firstLineText).toBe('Cow +2 queued');
    });

    test('the reported action type is whichever segment is actually running, not the first queued', () => {
        const segments = [
            { actionName: 'Cow', actionTypeHrid: '/action_types/milking', startAt: NOW, endAt: NOW + HOUR },
            { actionName: 'Cheese', actionTypeHrid: '/action_types/cheesesmithing', endAt: NOW + 3 * HOUR },
        ];

        const stillOnFirst = computeSlotDisplayState(record({ endsInMs: 3 * HOUR, segments }), { id: '1' }, PREFS, NOW);
        expect(stillOnFirst.actionTypeHrid).toBe('/action_types/milking');

        const movedToSecond = computeSlotDisplayState(
            record({ endsInMs: 3 * HOUR, segments }),
            { id: '1' },
            PREFS,
            NOW + 2 * HOUR
        );
        expect(movedToSecond.firstLineText).toBe('Cheese');
        expect(movedToSecond.actionTypeHrid).toBe('/action_types/cheesesmithing');
    });
});

describe('segment helpers', () => {
    test('the covering segment is the first that has not ended', () => {
        const segments = [{ endAt: 10 }, { endAt: 20 }, { endAt: null }];

        expect(findSegmentAtTime(segments, 5).index).toBe(0);
        expect(findSegmentAtTime(segments, 15).index).toBe(1);
        expect(findSegmentAtTime(segments, 999).index).toBe(2);
    });

    test('every segment ended means no covering segment', () => {
        expect(findSegmentAtTime([{ endAt: 10 }], 99)).toBeNull();
    });

    test('a paused segment is marked as such', () => {
        expect(formatActivityLine({ actionName: 'Cow' }, true, 2)).toBe('Cow ⏸ +2 queued');
    });
});
