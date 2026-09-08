/**
 * Game-Text Constants
 *
 * Every load-bearing English literal the script matches against text the game
 * renders, in one place. These strings are as much a part of the game's API as
 * its class names and data keys: a rewording ("Battle started:" becoming
 * "Battle begins:") silently blinds every consumer, with no error anywhere.
 * Collecting them here makes the dependency visible, greppable, and testable —
 * game-text.test.js pins each one against a real message it was seen in.
 *
 * String constants are for consumers that `includes()`/`split()`; the RegExp
 * constants preserve exactly the pattern their consumer matched with before the
 * literal moved here (word boundaries, optional spacing, case-insensitivity).
 * None carry the `g` flag, so sharing one instance across modules is safe.
 *
 * One exception: a pattern that captures a locale-grouped number is a
 * function, not a frozen `RegExp` constant, because its digit-group character
 * depends on the game's current language and a constant compiled once at
 * import time would freeze whatever locale happened to be active on first
 * load — see {@link gameDigitsSource}.
 */

import { gameDigitsSource } from './number-parser.js';

/* ------------------------------------------------------------------------- *
 * Dungeon party chat (dungeon-tracker.js, dungeon-tracker-chat-annotations.js)
 * ------------------------------------------------------------------------- */

/** Seen in: "[08/04 10:00:00 AM] Battle started: Chimerical Den" */
export const DUNGEON_BATTLE_STARTED = 'Battle started:';

/** Seen in: "[08/04 10:05:00 AM] Battle ended: Chimerical Den" (canceled/fled) */
export const DUNGEON_BATTLE_ENDED = 'Battle ended:';

/** Seen in: "[08/04 10:00:00 AM] Key counts: [Alice - 12]" */
export const DUNGEON_KEY_COUNTS = 'Key counts:';

/** Seen in: "[08/04 10:04:00 AM] Party failed on wave 7" */
export const DUNGEON_PARTY_FAILED = 'Party failed on wave';

/** The phrase above with the wave number it is always followed by. */
export const DUNGEON_PARTY_FAILED_RE = new RegExp(`${DUNGEON_PARTY_FAILED} \\d+`);

/* ------------------------------------------------------------------------- *
 * Party status lines (chat-profile-link.js)
 * ------------------------------------------------------------------------- */

/** Seen in: "Briggsy99 has joined the party." */
export const PARTY_HAS_JOINED = 'has joined the party.';

/** Seen in: "Briggsy99 has left the party." */
export const PARTY_HAS_LEFT = 'has left the party.';

/** Seen in: "Briggsy99 is ready." */
export const PARTY_IS_READY = 'is ready.';

/** Seen in: "Briggsy99 is not ready." */
export const PARTY_IS_NOT_READY = 'is not ready.';

/**
 * The four party status sentence shapes, for consumers that build a "name
 * followed by exactly one of these" matcher. Longer phrases first so an
 * alternation never lets "is ready." shadow "is not ready.".
 */
export const PARTY_STATUS_PHRASES = [PARTY_HAS_JOINED, PARTY_HAS_LEFT, PARTY_IS_NOT_READY, PARTY_IS_READY];

/* ------------------------------------------------------------------------- *
 * Guild trial tabs (guild-trials-scrape.js)
 * ------------------------------------------------------------------------- */

/** Seen in: "1/28 signed up" (and the other way round, "Signed Up 3/56") */
export const TRIAL_SIGNED_UP_RE = /signed\s*up/i;

/** Seen in: "Completed" on a finished trial card ("Lv.120, 960 pts, T3") */
export const TRIAL_CARD_COMPLETED_RE = /\bcomplet(?:e|ed)\b/i;

/** Seen in: "Scheduled Wed 04:00 PM 2h 24m" above a tab of "0 pts" cards */
export const TRIAL_STATUS_SCHEDULED_RE = /\bscheduled\b/i;

/** Seen in: "Completed Thu 09:00 AM" once the cycle is over */
export const TRIAL_STATUS_COMPLETED_RE = /\bcompleted?\b/i;

/** Seen in: "Skilling Trial - In Progress  Thu 04:00 PM" */
export const TRIAL_STATUS_IN_PROGRESS_RE = /\bin\s*progress\b/i;

/** Seen in: "Skilling Trial - In Progress" (names the hour's trial kind) */
export const TRIAL_KIND_SKILLING_RE = /\bskilling\b/i;

/** Seen in: "Combat Trial - Scheduled Thu 05:00 PM 1h 2m" */
export const TRIAL_KIND_COMBAT_RE = /\bcombat\b/i;

/** Seen in: "Milking Lv.130" on a trial card's summary line */
export const TRIAL_LEVEL_RE = /Lv\.?\s*(\d+)/i;

/**
 * Seen in: "600 pts" — what a card says clearing the trial is worth.
 *
 * A function rather than a constant: the points figure is grouped by the
 * game's current locale, and a hardcoded `[\d,]*` only matches an en-US
 * comma-grouped number — in a period-grouping locale (de-DE, fr-FR...) it
 * stops at the first group boundary, so a card worth "1.600 pts" would have
 * captured as "1" pts.
 *
 * @returns {RegExp} Matches the points figure, current locale
 */
export function trialPointsPattern() {
    return new RegExp(`(${gameDigitsSource({ decimal: false })})\\s*(?:pts?|points?)\\b`, 'i');
}

/** Seen in: "T6" (also written "Tier 6") on a card that states its tier */
export const TRIAL_TIER_RE = /\b(?:tier\s*|T)(\d{1,2})\b/i;

/** Seen in: "Time: 20m 37s" and "42:15 remaining" — a clock that says what it is */
export const TRIAL_CLOCK_LABEL_RE = /remain|left|ends?\b|until|time/i;

/* ------------------------------------------------------------------------- *
 * Guild panel (guild-xp-display.js)
 * ------------------------------------------------------------------------- */

/**
 * Seen in: "Exp to Level Up" on the guild overview's data blocks.
 *
 * Not yet imported by its consumer — guild-xp-display.js matches this label to
 * find where to append the catch-up estimate; rewire it to this constant the
 * next time that file is touched.
 */
export const GUILD_EXP_TO_LEVEL = 'Exp to';
