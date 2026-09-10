/**
 * Guild trial alerts.
 *
 * Driven the way the community-buff alerts are driven: a faked settings reader,
 * a faked notification service, and the status pushed in by hand — because in
 * production it is pushed in by the trials feature rather than watched for here.
 *
 * What is worth asserting is the transitions. A scheduled cycle re-reads its own
 * countdown every few seconds while the panel is open, so "announce once" is the
 * whole difficulty, and a cycle that finishes has already had its cards zeroed
 * by the time it says so — which is why the payout is kept as it goes past.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ settings: {}, values: {}, sent: [], wsHandlers: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.values ? game.values[key] : fallback),
        onSettingChange: () => {},
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
// Reassigned per-test (see "a delivery that reaches no channel...") so a test
// can simulate `notify()` failing to deliver without a second mock module.
let notifyImpl = (eventKey, message, options) => {
    game.sent.push({ eventKey, message, options });
    return { fired: true, channels: ['toast'] };
};

vi.mock('./notification-service.js', () => ({
    default: {
        notify: (...args) => notifyImpl(...args),
    },
}));

const {
    DEFAULT_LEAD_MINUTES,
    guildTrialAlerts,
    leadMinutes,
    MAX_LEAD_MINUTES,
    MIN_LEAD_MINUTES,
    RESULTS_SETTING,
    resultsMessage,
    START_SETTING,
} = await import('./guild-trial-alerts.js');

const now = Date.parse('2026-08-05T15:00:00Z');

beforeEach(() => {
    game.settings = { [START_SETTING]: true, [RESULTS_SETTING]: true };
    game.values = {};
    game.sent = [];
    game.wsHandlers = {};
    notifyImpl = (eventKey, message, options) => {
        game.sent.push({ eventKey, message, options });
        return { fired: true, channels: ['toast'] };
    };
    guildTrialAlerts.initialized = false;
    guildTrialAlerts.reset();
    guildTrialAlerts.initialize();
});

describe('leadMinutes', () => {
    test('the setting, clamped to what the control offers', () => {
        expect(leadMinutes(() => 25)).toBe(25);
        expect(leadMinutes(() => 0)).toBe(MIN_LEAD_MINUTES);
        expect(leadMinutes(() => 9999)).toBe(MAX_LEAD_MINUTES);
        expect(leadMinutes(() => 'soon')).toBe(DEFAULT_LEAD_MINUTES);
    });
});

describe('a trial about to start', () => {
    test('nothing is said while it is further off than the lead time', () => {
        guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: 2 * 3600_000, at: now });
        expect(game.sent).toEqual([]);
    });

    test('it is announced once inside the lead time, not on every redraw', () => {
        for (let tick = 0; tick < 5; tick += 1) {
            guildTrialAlerts.noteTrialStatus({
                phase: 'scheduled',
                startsInMs: 5 * 60_000 - tick * 1000,
                trials: ['Milking'],
                at: now + tick * 1000,
            });
        }

        expect(game.sent).toHaveLength(1);
        expect(game.sent[0].message).toContain('Guild trial starts in');
        expect(game.sent[0].message).toContain('Milking');
        // Five minutes, read as five minutes. `timeReadable` takes seconds, and
        // the countdown is milliseconds — handed over unconverted it announced
        // a ten-minute warning as "6 days 22 hours"
        expect(game.sent[0].message).toContain('5m');
        expect(game.sent[0].message).not.toMatch(/day/i);
    });

    test('a start seen once fires at the lead moment even after the panel shuts', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(now);
            // Seen half an hour out, well beyond the ten-minute lead: nothing yet,
            // and no further readings — the panel is closed from here on
            guildTrialAlerts.noteTrialStatus({
                phase: 'scheduled',
                startsInMs: 30 * 60_000,
                trials: ['Cheesesmithing'],
            });
            expect(game.sent).toEqual([]);

            // Time crosses into the lead window with no reading to prompt it
            vi.advanceTimersByTime(20 * 60_000);

            expect(game.sent).toHaveLength(1);
            expect(game.sent[0].message).toContain('Guild trial starts in');
            expect(game.sent[0].message).toContain('Cheesesmithing');
            expect(game.sent[0].message).toContain('10m');
        } finally {
            vi.useRealTimers();
        }
    });

    test('the scheduled timer stays quiet once the trial has already started', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(now);
            guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: 30 * 60_000 });
            // The game announces the start over chat before the lead timer fires
            guildTrialAlerts.noteChatLine('The guild trials have begun!');
            game.sent = [];

            vi.advanceTimersByTime(30 * 60_000);
            expect(game.sent).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('the moment it actually starts is its own announcement', () => {
        guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: 3 * 3600_000, at: now });
        guildTrialAlerts.noteTrialStatus({ phase: 'live', trials: ['Alchemy'], at: now + 1000 });

        expect(game.sent).toHaveLength(1);
        expect(game.sent[0].message).toContain('has started');
        expect(game.sent[0].message).toContain('Alchemy');
    });

    test('a redraw of a running trial is not a start', () => {
        guildTrialAlerts.noteTrialStatus({ phase: 'live', at: now });
        guildTrialAlerts.noteTrialStatus({ phase: 'live', at: now + 5000 });
        expect(game.sent).toEqual([]);
    });

    test('a delivery that reaches no channel is retried on the next reading', () => {
        // Delivery failed once — no browser permission, tab not visible, no
        // toast surface — and notify() said so. The flag guarding "announce
        // once" must not be set from that failed attempt, or the cycle goes
        // silent for good even though the player was never actually told.
        notifyImpl = () => ({ fired: false, channels: [], reason: 'no channel available' });

        guildTrialAlerts.noteTrialStatus({
            phase: 'scheduled',
            startsInMs: 5 * 60_000,
            trials: ['Milking'],
            at: now,
        });
        expect(game.sent).toEqual([]);

        notifyImpl = (eventKey, message, options) => {
            game.sent.push({ eventKey, message, options });
            return { fired: true, channels: ['toast'] };
        };

        guildTrialAlerts.noteTrialStatus({
            phase: 'scheduled',
            startsInMs: 5 * 60_000 - 1000,
            trials: ['Milking'],
            at: now + 1000,
        });

        expect(game.sent).toHaveLength(1);
        expect(game.sent[0].message).toContain('Guild trial starts in');
    });

    test('switched off, nothing is announced', () => {
        game.settings = { [START_SETTING]: false };
        guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: 60_000, at: now });
        guildTrialAlerts.noteTrialStatus({ phase: 'live', at: now + 1000 });
        expect(game.sent).toEqual([]);
    });
});

describe('the guild chat line', () => {
    // The signal the user asked for: it arrives whatever page they are on,
    // where the panel's own status is only read while somebody is looking at it
    test('the game saying so is the start', () => {
        game.wsHandlers.chat_message_received({ message: { m: 'The guild trials have begun!' } });

        expect(game.sent).toHaveLength(1);
        expect(game.sent[0].message).toContain('has started');
    });

    test('the panel agreeing a moment later does not announce it twice', () => {
        guildTrialAlerts.noteChatLine('The guild trials have begun!');
        guildTrialAlerts.noteTrialStatus({ phase: 'live', at: now + 1000 });

        expect(game.sent).toHaveLength(1);
    });

    test('ordinary chat is not a trial starting', () => {
        for (const line of ['begun the raid', 'anyone want to do trials later?', '']) {
            guildTrialAlerts.noteChatLine(line);
        }
        expect(game.sent).toEqual([]);
    });

    test('switched off, the line passes quietly', () => {
        game.settings = { [START_SETTING]: false };
        guildTrialAlerts.noteChatLine('The guild trials have begun!');
        expect(game.sent).toEqual([]);
    });
});

describe('the results', () => {
    test('carry what the panel worked out, points and both token figures', () => {
        expect(resultsMessage({ guildPoints: 2880, eligibleTokens: 1320, participantTokens: 1980 })).toBe(
            'Guild trial finished — 2,880 Guild Points, 1,320 tokens for every eligible member, 1,980 if you took part.'
        );
    });

    test('a payout nobody measured still says the trial finished', () => {
        expect(resultsMessage(null)).toBe('The guild trial has finished.');
    });

    test('announced on the transition to completed, from the payout kept while it ran', () => {
        guildTrialAlerts.noteTrialStatus({ phase: 'live', at: now });
        guildTrialAlerts.notePayout({ guildPoints: 2880, eligibleTokens: 1320, participantTokens: 1980 });

        // The cards are zeroed by the time the header says Completed, so a
        // payout read at that moment would be nothing
        guildTrialAlerts.notePayout({ guildPoints: 0, eligibleTokens: 0, participantTokens: 0 });
        guildTrialAlerts.noteTrialStatus({ phase: 'completed', at: now + 60_000 });

        expect(game.sent).toHaveLength(1);
        expect(game.sent[0].message).toContain('2,880 Guild Points');
        expect(game.sent[0].options.title).toBe('Guild trial finished');
    });

    test('a panel that was already showing completed announces nothing', () => {
        guildTrialAlerts.noteTrialStatus({ phase: 'completed', at: now });
        expect(game.sent).toEqual([]);
    });

    test('switched off, the transition passes quietly', () => {
        game.settings = { [RESULTS_SETTING]: false };
        guildTrialAlerts.noteTrialStatus({ phase: 'live', at: now });
        guildTrialAlerts.noteTrialStatus({ phase: 'completed', at: now + 1000 });
        expect(game.sent).toEqual([]);
    });
});

describe('resetting', () => {
    test('a character switch forgets the cycle, so the next one announces cleanly', () => {
        guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: 60_000, at: now });
        expect(game.sent).toHaveLength(1);

        guildTrialAlerts.reset();
        guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: 60_000, at: now + 600_000 });

        expect(game.sent).toHaveLength(2);
    });

    test('nonsense in is nothing out', () => {
        expect(guildTrialAlerts.noteTrialStatus()).toBeNull();
        expect(guildTrialAlerts.noteTrialStatus({ phase: 'scheduled', startsInMs: null })).toBeNull();
        expect(game.sent).toEqual([]);
    });
});

/**
 * The teardown half, which had no caller at all until Guild Trials grew one.
 *
 * The chat listener is what makes the "a trial has begun" alert work with the
 * guild page shut, so nothing on the character-switch path removes it —
 * `reset()` drops the pending start timer and deliberately leaves the listener
 * up. That makes `cleanup()` the only thing that can stop it, and for a while
 * nothing called it: turning Guild Trials off left the alert firing.
 */
describe('stopping the alerts', () => {
    test('cleanup takes the chat listener off', () => {
        expect(game.wsHandlers.chat_message_received).toBeTypeOf('function');

        guildTrialAlerts.cleanup();

        expect(game.wsHandlers.chat_message_received).toBeUndefined();
        expect(guildTrialAlerts.initialized).toBe(false);
    });

    test('cleaning up twice, or before anything started, is not an error', () => {
        expect(() => guildTrialAlerts.cleanup()).not.toThrow();
        expect(() => guildTrialAlerts.cleanup()).not.toThrow();
    });

    test('and it can be started again afterwards', () => {
        guildTrialAlerts.cleanup();
        guildTrialAlerts.initialize();

        expect(game.wsHandlers.chat_message_received).toBeTypeOf('function');
    });
});
