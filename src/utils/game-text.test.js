/**
 * @vitest-environment happy-dom
 *
 * Each game-text constant against the real message its JSDoc quotes.
 *
 * The point is not that a string contains itself — it is that the fixture
 * messages here are copied from what the game actually rendered (the same
 * fixtures the consumers' own tests parse), so a constant that drifts from the
 * game's wording fails here first, with the expected message in the diff.
 *
 * happy-dom rather than the default node environment: {@link trialPointsPattern}
 * reads the game's locale from `localStorage`.
 */

import { describe, test, expect, afterEach } from 'vitest';

import {
    DUNGEON_BATTLE_STARTED,
    DUNGEON_BATTLE_ENDED,
    DUNGEON_KEY_COUNTS,
    DUNGEON_PARTY_FAILED,
    DUNGEON_PARTY_FAILED_RE,
    PARTY_HAS_JOINED,
    PARTY_HAS_LEFT,
    PARTY_IS_READY,
    PARTY_IS_NOT_READY,
    PARTY_STATUS_PHRASES,
    TRIAL_SIGNED_UP_RE,
    TRIAL_CARD_COMPLETED_RE,
    TRIAL_STATUS_SCHEDULED_RE,
    TRIAL_STATUS_COMPLETED_RE,
    TRIAL_STATUS_IN_PROGRESS_RE,
    TRIAL_KIND_SKILLING_RE,
    TRIAL_KIND_COMBAT_RE,
    TRIAL_LEVEL_RE,
    trialPointsPattern,
    TRIAL_TIER_RE,
    TRIAL_CLOCK_LABEL_RE,
    GUILD_EXP_TO_LEVEL,
} from './game-text.js';
import { _resetGameNumberSeparators } from './number-parser.js';

describe('dungeon party chat', () => {
    test('battle start, as the party chat writes it', () => {
        expect('[08/04 10:00:00 AM] Battle started: Chimerical Den').toContain(DUNGEON_BATTLE_STARTED);
    });

    test('battle end (canceled or fled)', () => {
        expect('[08/04 10:05:00 AM] Battle ended: Chimerical Den').toContain(DUNGEON_BATTLE_ENDED);
    });

    test('the key-count line every run is measured between', () => {
        expect('[08/04 10:00:00 AM] Key counts: [Alice - 12], [Bob - 1,234]').toContain(DUNGEON_KEY_COUNTS);
    });

    test('a party wipe names its wave', () => {
        const line = '[08/04 10:04:00 AM] Party failed on wave 7';
        expect(line).toContain(DUNGEON_PARTY_FAILED);
        expect(DUNGEON_PARTY_FAILED_RE.test(line)).toBe(true);
    });

    test('the failed-wave pattern insists on the wave number', () => {
        expect(DUNGEON_PARTY_FAILED_RE.test('Party failed on wave')).toBe(false);
    });
});

describe('party status lines', () => {
    test('all four sentence shapes', () => {
        expect('Briggsy99 has joined the party.').toContain(PARTY_HAS_JOINED);
        expect('Briggsy99 has left the party.').toContain(PARTY_HAS_LEFT);
        expect('Briggsy99 is ready.').toContain(PARTY_IS_READY);
        expect('Briggsy99 is not ready.').toContain(PARTY_IS_NOT_READY);
    });

    test('the phrase list carries exactly those four, longer phrases first', () => {
        expect(PARTY_STATUS_PHRASES).toEqual([PARTY_HAS_JOINED, PARTY_HAS_LEFT, PARTY_IS_NOT_READY, PARTY_IS_READY]);
        expect(PARTY_STATUS_PHRASES.indexOf(PARTY_IS_NOT_READY)).toBeLessThan(
            PARTY_STATUS_PHRASES.indexOf(PARTY_IS_READY)
        );
    });
});

describe('guild trial tabs', () => {
    test('sign-up counts, written both ways round', () => {
        expect(TRIAL_SIGNED_UP_RE.test('1/28 signed up')).toBe(true);
        expect(TRIAL_SIGNED_UP_RE.test('Signed Up 3/56')).toBe(true);
    });

    test('a finished card says so', () => {
        expect(TRIAL_CARD_COMPLETED_RE.test('Completed')).toBe(true);
    });

    test('the three cycle phases the header can show', () => {
        expect(TRIAL_STATUS_SCHEDULED_RE.test('Scheduled Wed 04:00 PM 2h 24m')).toBe(true);
        expect(TRIAL_STATUS_COMPLETED_RE.test('Completed Thu 09:00 AM')).toBe(true);
        expect(TRIAL_STATUS_IN_PROGRESS_RE.test('Skilling Trial - In Progress  Thu 04:00 PM')).toBe(true);
    });

    test('the header names which trial its status is about', () => {
        expect(TRIAL_KIND_SKILLING_RE.test('Skilling Trial - In Progress  Thu 04:00 PM')).toBe(true);
        expect(TRIAL_KIND_COMBAT_RE.test('Combat Trial - Scheduled Thu 05:00 PM 1h 2m')).toBe(true);
    });

    test('level, points and tier as the cards write them', () => {
        expect('Milking Lv.130'.match(TRIAL_LEVEL_RE)?.[1]).toBe('130');
        expect('600 pts'.match(trialPointsPattern())?.[1]).toBe('600');
        expect('T6'.match(TRIAL_TIER_RE)?.[1]).toBe('6');
        expect('Tier 6'.match(TRIAL_TIER_RE)?.[1]).toBe('6');
    });

    describe('trialPointsPattern, locale-grouped', () => {
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
            expect('1,600 pts'.match(trialPointsPattern())?.[1]).toBe('1,600');
        });

        test('de-DE period grouping — the bug this replaces', () => {
            // A hardcoded `[\d,]*` captures "1.600 pts" as just "1": the period
            // isn't in the class, so the match stops at the first group boundary.
            asLocale('de-DE');
            expect('1.600 pts'.match(trialPointsPattern())?.[1]).toBe('1.600');
        });
    });

    test('a countdown that says what it is', () => {
        expect(TRIAL_CLOCK_LABEL_RE.test('Time: 20m 37s')).toBe(true);
        expect(TRIAL_CLOCK_LABEL_RE.test('42:15 remaining')).toBe(true);
    });
});

describe('guild panel', () => {
    test('the exp-to-level block on the overview tab', () => {
        expect('Exp to Level Up').toContain(GUILD_EXP_TO_LEVEL);
    });
});
