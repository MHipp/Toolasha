/**
 * Reading the guild trial tabs.
 *
 * ## There are two of them, and they hold different halves of the answer
 *
 * Confirmed from a live client, which is what this file spent its first two
 * revisions guessing at. The guild page's nav is Overview, Members,
 * Applications, **Trials**, **In Progress**, Buildings, Shop, Icons — and the
 * two trial tabs are not two views of one thing:
 *
 * - **Trials** is the setup tab. Its cards carry the trial's name and level
 *   ("Milking Lv.130"), what clearing it is worth ("600 pts"), how many members
 *   have signed up ("1/28 signed up"), and a countdown ("20m 53s"). There is no
 *   progress bar anywhere on it.
 * - **In Progress** is the live tab. Its card carries the reading everything
 *   here exists to measure — "Alchemy 18,850 / 65,280" — beside the members
 *   working on it, and a footer with the trial's own clock ("Time: 20m 37s").
 *   It carries no level and no tier.
 *
 * So neither tab is sufficient. The rate comes from In Progress, the tier and
 * the participant count come from Trials, and they are joined by the one thing
 * both cards carry: the trial's name. Sampling either tab writes into the same
 * record under the same key, and a card with nothing moving on it updates the
 * trial's identity without pushing a reading — see `recordTileSample`.
 *
 * The cost of getting this wrong was two revisions of a feature that recorded
 * nothing: the first required a container class the game does not use, and the
 * second required every card to carry a progress bar, which is true of exactly
 * one of the two tabs.
 *
 * The trial state a member can see is on the screen, and — as far as anything
 * this script can observe — only on the screen. The socket carries who signed up
 * (`guild_trial_signup_updated`, and `signedUpSkillingTrialHrid` /
 * `signedUpCombatTrialHrid` on every guild character) and when the week started
 * (`guild.currentWeekStartAt`), but nothing that has been seen carries a running
 * trial's pool fill or a trial boss's health. A participant's own client gets
 * `new_battle` and `battle_updated` for the fight they are in; everybody else in
 * the guild gets the panel. So the panel is what is read, and the socket is used
 * where it is authoritative.
 *
 * ## Why this parses shapes rather than class names
 *
 * The one class name this can lean on is `GuildPanel_tileSummary`, which is
 * already load-bearing elsewhere in the codebase (`guild-credit-value.js` tags
 * tier badges onto it) and carries the `Lv.<n>` the tier is derived from. The
 * rest of the tab's class names have not been verified against a live client, so
 * everything else is found by shape: a tile is whatever element holds a summary,
 * a progress reading is any `<n> / <n>` in the tile's text, and the two readings
 * on a combat card are told apart by which of them *moves which way* over time
 * rather than by which comes first in the markup.
 *
 * That caution turned out to be warranted and not cautious enough. The whole
 * feature was hung off one *unverified* container class — `GuildPanel_trialsContent`
 * — and if the game does not spell it that way, every reading, every projection
 * and the overlay tile that reads from them are all dark at once, silently,
 * with no error anywhere: the observer simply never fires and the interval's
 * `querySelector` simply never matches. Which is what was reported during a live
 * trial. So the container is now *found* rather than named ({@link findTrialsRoot}),
 * and a card is found by its contents rather than by its container.
 *
 * What keeps that from reading the rest of the guild page as trials is the one
 * part of a card that is not a number: `isTrialName` knows the five encounters
 * and the ten skills a trial can be run in, and a card whose name is not one of
 * them is not a trial — not a building, not a guild XP bar, not a member row.
 * That is a stronger filter than the level ladder it replaces, and unlike the
 * ladder it survives a card that carries no level at all, which is every card on
 * the In Progress tab.
 *
 * That last one matters: the observed combat card shows both a small falling
 * number over a large one (boss health) and a large rising number over a round
 * one. Assuming an order would silently invert every rate the moment the game
 * reflowed the card. Direction cannot be got wrong.
 *
 * Nothing here mutates the DOM — it only reads. The feature module does the
 * drawing.
 */

import { COMBAT_ENCOUNTERS, TRIAL_MAX_TIER, isTrialName, tierFromLevel } from './guild-trials-math.js';
import {
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
} from '../../utils/game-text.js';
import { parseGameNumber, gameDigitsSource } from '../../utils/number-parser.js';

/** Suffix multipliers on abbreviated numbers the game renders in bars */
const SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * A number as the game writes it: `618000`, `618,000`, `618K`, `1.2M` — and,
 * in a period-grouping locale, `618.000` or `1,2M`.
 *
 * Built from {@link gameDigitsSource} rather than a hardcoded `[\d,]*\.?\d+`,
 * which only recognises a comma-grouped number; in de-DE or fr-FR the group
 * character is a period or a space, and the old pattern either mis-split the
 * figure at the first group boundary or, worse, read the group separator as
 * this locale's decimal point.
 *
 * @param {string} raw - Text
 * @returns {number|null} The number, or null when it is not one
 */
export function parseAmount(raw) {
    if (typeof raw !== 'string') return null;
    const match = raw.trim().match(new RegExp(`^(${gameDigitsSource()})\\s*([kmbt])?$`, 'i'));
    if (!match) return null;

    const value = parseGameNumber(match[1]);
    if (!Number.isFinite(value)) return null;

    const suffix = match[2]?.toLowerCase();
    return suffix ? value * SUFFIXES[suffix] : value;
}

/**
 * Every `current / max` reading in a blob of text, in the order they appear.
 *
 * Text rather than elements because the readings have been seen both inside a
 * progress-bar label and as loose text beside one, and a reading that is only
 * found in one of those two placements is a reading that vanishes on a redesign.
 *
 * @param {string} text - Text to scan
 * @returns {Array<{current: number, max: number}>} Readings, in document order
 */
export function parseBarReadings(text) {
    if (typeof text !== 'string') return [];

    const readings = [];
    const amount = `${gameDigitsSource()}\\s*[kmbt]?`;
    const pattern = new RegExp(`(${amount})\\s*\\/\\s*(${amount})`, 'gi');
    let match = pattern.exec(text);
    while (match) {
        const current = parseAmount(match[1]);
        const max = parseAmount(match[2]);
        if (isPlausibleReading(current, max)) readings.push({ current, max });
        match = pattern.exec(text);
    }
    return readings;
}

/**
 * The largest pool or health bar a trial can have.
 *
 * The biggest real figure on the ladder is the top tier's boss health, which is
 * a few million; a hundred million is two orders of magnitude of headroom and
 * still refuses the thing this exists for.
 *
 * A guild notice board carrying `https://discord.com/channels/1234500000000000001/
 * 1525000000000000321` has exactly the shape of a progress bar, and those two
 * nineteen-digit channel ids were recorded as a trial's pool — then sampled
 * every five seconds, and used to arm the recorder. Numbers that large are not
 * a bar whatever else they are.
 */
export const MAX_PLAUSIBLE_READING = 1e8;

/**
 * Whether a `current / max` pair can be a progress bar at all.
 *
 * @param {number} current - The left-hand figure
 * @param {number} max - The right-hand figure
 * @returns {boolean} True when it is worth recording
 */
export function isPlausibleReading(current, max) {
    if (!Number.isFinite(current) || !Number.isFinite(max)) return false;
    // A max of zero is a bar that has not been populated, not a full one
    if (max <= 0 || current < 0) return false;
    if (max > MAX_PLAUSIBLE_READING || current > MAX_PLAUSIBLE_READING) return false;

    // Past nine or so significant digits a double stops being able to hold the
    // figure exactly, and every such number this has ever seen was an id
    return Number.isSafeInteger(Math.round(max)) && Math.round(max) < MAX_PLAUSIBLE_READING;
}

/** A line saying how many members have signed up, either way round */
const SIGNUP_PATTERN = TRIAL_SIGNED_UP_RE;

/**
 * A card that says the trial is over.
 *
 * Worth reading because it settles the one inference on the block that nothing
 * else confirms. While a trial runs, the tier on the card is the tier being
 * fought and the tiers *earned* are one fewer; on a finished card the two are
 * the same number — the completed Trial Chameleon read "Lv.120, 960 pts, T3",
 * and 960 is the ladder's three-tier total with the Builder's Hall bonus on it.
 * So "Completed" is what makes the banked count exact rather than inferred.
 */
const COMPLETED_PATTERN = TRIAL_CARD_COMPLETED_RE;

/**
 * How many members have signed up for a trial, from its card.
 *
 * The Trials tab writes it both ways round — "1/28 signed up" under a skilling
 * card and "Signed Up 3/56" under a combat one — so the ratio is looked for in a
 * line that says what it is rather than at a fixed position.
 *
 * This matters twice over. It is a better participant count than the socket's,
 * because it is the number the game itself is showing; and a ratio that is *not*
 * recognised as a sign-up count is a catastrophe rather than a gap, since
 * "1 / 28" has exactly the shape of a progress bar and would be sampled as one.
 *
 * @param {string} text - A card line
 * @returns {{signed: number, total: number}|null} The count, or null when the line is not one
 */
export function parseSignups(text) {
    if (typeof text !== 'string' || !SIGNUP_PATTERN.test(text)) return null;

    // Sign-up counts are always whole numbers, so no decimal tail — a
    // hardcoded `\d[\d,]*` only recognises comma grouping, which reads
    // "1.234/5.000" as "1/5" in a period-grouping locale.
    const digits = gameDigitsSource({ decimal: false });
    const match = text.match(new RegExp(`(${digits})\\s*\\/\\s*(${digits})`));
    if (!match) return null;

    const signed = parseGameNumber(match[1]);
    const total = parseGameNumber(match[2]);
    return Number.isFinite(signed) && Number.isFinite(total) ? { signed, total } : null;
}

/**
 * What a trial's card says clearing it is worth, from its "600 pts".
 * @param {string} text - A card line
 * @returns {number|null} Points, or null when the line does not carry any
 */
export function parsePoints(text) {
    const match = typeof text === 'string' ? text.match(trialPointsPattern()) : null;
    if (!match) return null;
    const points = parseGameNumber(match[1]);
    return Number.isFinite(points) ? points : null;
}

/**
 * The trial level a tile is showing, from its `Lv.<n>` summary.
 * @param {string} text - Tile text
 * @returns {number|null} Level, or null when the tile does not carry one
 */
export function parseTrialLevel(text) {
    const match = typeof text === 'string' ? text.match(TRIAL_LEVEL_RE) : null;
    if (!match) return null;
    const level = Number(match[1]);
    return Number.isFinite(level) ? level : null;
}

/**
 * The tier a card states outright, from its `T6` or `Tier 6` badge.
 *
 * The tier used to be derived from the level and only from the level, which
 * meant a card that states its tier and not its level — which is how the Trials
 * tab's cards were found to be drawn — recorded no tier at all. Everything the
 * tier unlocks went with it: `tiers` stayed empty so no growth curve could be
 * fitted, `pointsByTier` stayed empty because filing a points figure requires a
 * tier to file it under, and the banked-points arithmetic reported "unknown"
 * beside a card that was plainly showing T6.
 *
 * Bounded by the ladder rather than accepting any `T<n>`: a stray "T3" in prose
 * is not a tier, and a tier above {@link module:./guild-trials-math.TRIAL_MAX_TIER}
 * is not one either.
 *
 * @param {string} text - A card line
 * @returns {number|null} The tier, or null when the line does not state one
 */
export function parseTrialTier(text) {
    const match = typeof text === 'string' ? text.match(TRIAL_TIER_RE) : null;
    if (!match) return null;
    const tier = Number(match[1]);
    return Number.isFinite(tier) && tier >= 1 && tier <= TRIAL_MAX_TIER ? tier : null;
}

/**
 * A `mm:ss` or `h:mm:ss` clock, in milliseconds.
 * @param {string} text - Text to scan
 * @returns {number|null} Milliseconds, or null when there is no clock in it
 */
export function parseClockMs(text) {
    const match = typeof text === 'string' ? text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})\b/) : null;
    if (!match) return null;

    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (![hours, minutes, seconds].every(Number.isFinite)) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * A duration written in words — `42m 15s`, `1h 3m`, `58 sec`.
 *
 * The clock is only ever *seen* as `mm:ss` on the observed tab, but the game
 * writes durations both ways in different places and the whole point of this
 * search is that the named row it used to read may not exist. A second spelling
 * costs one regex and removes one more single point of failure.
 *
 * @param {string} text - Text to scan
 * @returns {number|null} Milliseconds, or null when no unit-marked duration is in it
 */
export function parseWordyDurationMs(text) {
    if (typeof text !== 'string') return null;

    const units = { h: 3600_000, m: 60_000, s: 1000 };
    const pattern = /(\d+)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi;

    let total = null;
    let match = pattern.exec(text);
    while (match) {
        const unit = units[match[2][0].toLowerCase()];
        if (unit) total = (total ?? 0) + Number(match[1]) * unit;
        match = pattern.exec(text);
    }
    return total;
}

/**
 * Text that must never be read as a countdown, however clock-shaped it is.
 *
 * A decimal ("Work Time 3.14s"), a percentage ("Success Rate 60.8%"), a time
 * of day ("Thu 09:00 AM" — which a colon-clock parser reads as *nine minutes*)
 * or a weekday disqualify the whole line. Exported because the status-row
 * shortcut in `guild-trials.js` needs the same refusal: the Trials tab's
 * header is "Skilling Trial - In Progress Thu 09:00 AM", and reading it as a
 * nine-minute deadline made the pace walk one tier further than the real
 * 5m53s allowed — "15 tiers → T15" on the Trials tab against a correct
 * "14 tiers → T14" on In Progress, at the same moment.
 */
export const NOT_A_CLOCK_RE = /\d+\.\d|%|\b(?:am|pm)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)/i;

/**
 * The trial countdown, found anywhere on the tab.
 *
 * `GuildPanel_eventStatusRow` is as unverified as the tab container was, and it
 * is the *only* thing that ever produced a time left — so when it is missing,
 * `projectPace` never runs and "On pace for" silently never appears, which is
 * the same class of invisible failure as the tab itself. This looks for the
 * clock instead of being told where it is.
 *
 * Both live tabs carry one: "20m 53s" on each Trials card, and "Time: 20m 37s"
 * in the In Progress footer. Both are written in units rather than as a colon
 * clock, which is fortunate, because the page also carries text that a colon
 * clock reader would swallow whole — see the guards.
 *
 * What keeps it from reading a countdown out of something that is not one, which
 * matters because the root may be a whole guild panel:
 *
 * - **Per element, never the welded `textContent`.** Joining siblings invents
 *   digit runs that were never on screen, the same way it invents levels.
 * - **Nothing containing a `/`.** A trial's bar reads `582,115 / 600,000`, and
 *   `15 / 60` would otherwise parse as fifteen minutes.
 * - **No times of day.** The Trials tab's header reads "Skilling Trial - In
 *   Progress Thu 09:00 AM". As a colon clock that is nine minutes, it sits in a
 *   line saying "in progress", and it would have won — a confident, wrong
 *   deadline. A weekday or an am/pm anywhere in the line disqualifies it.
 * - **No decimals or percentages.** The In Progress footer reads "Work Time
 *   3.14s, Success Rate 60.8%". A countdown is never written with a decimal
 *   point, and "Work Time" is exactly the sort of line a label test would like.
 * - **Plausible as a trial clock or not at all.** A trial runs an hour, so
 *   anything above that or at zero is something else. Rejected rather than
 *   clamped: clamping an hour and a half down to an hour would turn a wrong
 *   reading into a confident one.
 *
 * Candidates are then ranked rather than taken first-come: a duration written in
 * units beats a colon clock, since only the latter is ambiguous with a time of
 * day, and a line that says what it is ("remaining", "Time:") beats a bare one.
 *
 * @param {Element} root - The trials root, from {@link findTrialsRoot}
 * @param {number} maxMs - Longest a trial can run; anything longer is not this clock
 * @returns {number|null} Milliseconds left, or null when no clock is on the page
 */
export function findTrialClockMs(root, maxMs) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;

    const plausible = (value) => Number.isFinite(value) && value > 0 && value <= maxMs;
    const labelled = TRIAL_CLOCK_LABEL_RE;

    // [labelled units, bare units, labelled colon, bare colon]
    const ranked = [null, null, null, null];
    for (const line of textLines(root)) {
        if (line.includes('/') || NOT_A_CLOCK_RE.test(line)) continue;

        const wordy = parseWordyDurationMs(line);
        const value = plausible(wordy) ? wordy : parseClockMs(line);
        if (!plausible(value)) continue;

        const rank = (plausible(wordy) ? 0 : 2) + (labelled.test(line) ? 0 : 1);
        if (ranked[rank] === null) ranked[rank] = value;
    }
    return ranked.find((value) => value !== null) ?? null;
}

/**
 * Whether a trial name is one of the five combat encounters.
 * @param {string} name - Trial name, e.g. `Trial Chameleon`
 * @returns {boolean} True for a combat trial
 */
export function isCombatTrialName(name) {
    const lowered = String(name || '').toLowerCase();
    return COMBAT_ENCOUNTERS.some((encounter) => lowered.includes(encounter));
}

/**
 * Match a displayed trial name against the hrids the socket reports sign-ups for.
 *
 * The sign-up messages carry hrids (`signedUpCombatTrialHrid`) and the panel
 * carries names, and nothing carries both. Comparing the hrid's last segment to
 * the name with everything but letters stripped joins them without needing a
 * table that would go stale the first time a trial was renamed.
 *
 * @param {string} name - Displayed name
 * @param {string[]} hrids - Candidate hrids
 * @returns {string|null} The matching hrid, or null
 */
export function matchTrialHrid(name, hrids) {
    const normalise = (value) =>
        String(value || '')
            .toLowerCase()
            .replace(/[^a-z]/g, '');
    const target = normalise(name);
    if (!target) return null;

    for (const hrid of hrids || []) {
        const tail = normalise(String(hrid).split('/').pop());
        if (!tail) continue;
        if (target.includes(tail) || tail.includes(target)) return hrid;
    }
    return null;
}

/**
 * Class names the trials tab might carry, most specific first.
 *
 * Two spellings rather than one because only the *shape* of the tab has been
 * observed, not its markup: the members tab is `GuildPanel_membersTab` and the
 * overview `GuildPanel_overviewTab`, so `trialsTab` is at least as likely as the
 * `trialsContent` this was written against.
 */
const TRIALS_ROOT_CLASSES = [
    'GuildPanel_trialsContent',
    'GuildPanel_trialsTab',
    'GuildPanel_inProgressTab',
    'GuildPanel_inProgressContent',
];

/**
 * Where to look for trial cards.
 *
 * The named container when the game has one, and the guild panel as a whole when
 * it does not — which is the case that actually happens, since none of the four
 * names above has ever been seen on a live client. What makes the fallback safe
 * is not the container but the filter: {@link readTrialTiles} only accepts a card
 * whose name is a trial's.
 *
 * The guild panel is only handed back when something trial-shaped is on it, so
 * the Members tab is not scraped every five seconds for nothing. Two shapes
 * qualify, because the two tabs look nothing alike: a tile summary, which the
 * Trials tab's cards carry, or an `n / m` reading, which is all the In Progress
 * tab's card has.
 *
 * `querySelector` returns the first match in document order, and an ancestor
 * always precedes its descendants — so the guild-panel fallback is the outermost
 * `GuildPanel_*` element rather than whichever small child happens to match.
 *
 * @param {Document|Element} [scope] - Where to look
 * @returns {Element|null} The narrowest container known to hold the cards, or null
 */
export function findTrialsRoot(scope = typeof document === 'undefined' ? null : document) {
    if (!scope || typeof scope.querySelector !== 'function') return null;

    for (const className of TRIALS_ROOT_CLASSES) {
        const named = scope.querySelector(`[class*="${className}"]`);
        if (named) return named;
    }

    const panel = scope.querySelector('[class*="GuildPanel"]');
    if (!panel) return null;

    // A cheap existence probe, and the one place the welded `textContent` is the
    // right thing to read: whether *some* reading is on the panel does not
    // depend on which element holds it, and the cards themselves are read line
    // by line further down
    const hasSummary = Boolean(panel.querySelector('[class*="GuildPanel_tileSummary"]'));
    const hasReading = new RegExp(`${gameDigitsSource()}\\s*\\/\\s*\\d`).test(panel.textContent || '');
    return hasSummary || hasReading ? panel : null;
}

/**
 * Class fragments and attributes that mark a floating dialog.
 *
 * The game's own modal structure — a close cross, a dotted drag handle, a
 * backdrop — is drawn inside an element whose class carries one of these.
 * `guild-loadout-capture.js` already watches `Modal_modalContent`, so the first
 * of them is confirmed on a live client rather than guessed at.
 */
const DIALOG_CLASSES = ['Modal_', 'Dialog', 'Popup', 'Popover', 'Tooltip', 'Overlay'];

/**
 * Whether an element is inside a floating dialog rather than the panel behind it.
 *
 * Reported live, and it is the worst kind of bug because it looks deliberate:
 * clicking the boss in the trial fight view opens a stat popup headed **"Trial
 * Chameleon - Lv.110"**, and this feature drew its whole block — Rate, On pace,
 * Banked, Per player — *inside* that popup, above the boss's own stat lines. The
 * popup's title is a trial name over a level, which is precisely the shape a
 * card is recognised by, so every filter this file has said yes.
 *
 * The fix is not a better card filter; it is a statement about *where* a card is
 * allowed to be. A trial card lives in the guild panel's tab content. Anything
 * inside a modal is something else, however card-shaped it reads.
 *
 * @param {Element|null} el - Any element
 * @returns {boolean} True when a floating dialog is an ancestor
 */
export function inFloatingDialog(el) {
    for (let node = el; node; node = node.parentElement) {
        if (node.getAttribute?.('role') === 'dialog') return true;
        if (node.getAttribute?.('aria-modal') === 'true') return true;

        const className = typeof node.className === 'string' ? node.className : '';
        if (className && DIALOG_CLASSES.some((fragment) => className.includes(fragment))) return true;
    }
    return false;
}

/**
 * Whether the guild page is showing a trial tab at all.
 *
 * A second, independent gate on top of "are there trial cards here", and it
 * exists because the first one was fooled: a notice board that mentions a skill,
 * beside a guild XP bar that reads `4,120 / 20,000`, was enough to build a card
 * out of prose and draw the payout block over the **Overview** tab.
 * {@link module:./guild-trials-math.isTrialName} is the fix for that particular
 * paragraph; this is the fix for the next one.
 *
 * Deliberately permissive about not knowing. The tab strip's class name is
 * unverified — the command palette leans on `TabsComponent_tab` and nothing
 * else does — so a page where no tab strip can be found is *allowed*, and only a
 * page where the selected tab is legible and is plainly something else is
 * refused. A gate that fails closed on an unrecognised tab strip would take the
 * whole feature off the screen the day the game renames a class, which is the
 * failure this file already has two scars from.
 *
 * @param {Element|null} root - The trials root
 * @returns {boolean} False only when the selected tab is legibly not a trial tab
 */
export function onTrialTab(root) {
    const panel = root?.closest?.('[class*="GuildPanel"]') || root;
    if (!panel || typeof panel.querySelectorAll !== 'function') return true;

    const tabs = [...panel.querySelectorAll('[class*="TabsComponent_tab"], [role="tab"]')];
    if (!tabs.length) return true;

    const selected = tabs.filter(
        (tab) =>
            tab.getAttribute?.('aria-selected') === 'true' ||
            (typeof tab.className === 'string' && /selected|active/i.test(tab.className))
    );
    // Nothing marked as selected is the same as no tab strip: unreadable, so
    // not a reason to withhold anything
    if (!selected.length) return true;

    return selected.some((tab) => /trial|progress/i.test(tab.textContent || ''));
}

/**
 * Where the trial cycle currently is, from the header the game writes.
 *
 * The page says it plainly and this feature had never read it: **"Scheduled Wed
 * 04:00 PM 2h 24m"** above a tab whose cards all read "0 pts", or **"Completed
 * Thu 09:00 AM"**, or a running clock. Three states, and each one changes what
 * the figures below mean:
 *
 * - `scheduled` — the next cycle has not started. Anything the record still
 *   holds is the *previous* cycle's and is finished business.
 * - `completed` — this cycle is over. The last samples are a photograph, so a
 *   live-sounding "Tier clears in 11m" projected from them is describing an
 *   event nobody is running.
 * - `live` — the normal case, and what everything here already assumed.
 *
 * Found by words rather than by class name, in the first lines of the tab, and
 * only where the line is short enough to be a status rather than prose that
 * happens to contain the word. The countdown beside it — "2h 24m" — is read
 * with the same parser the trial clock uses.
 *
 * @param {Element} root - The trials root
 * @returns {{phase: 'scheduled'|'completed'|'live'|null, kind: 'skilling'|'combat'|null, text: string,
 *   startsInMs: number|null}} The status
 */
export function readTrialStatus(root, allLines = null) {
    const none = { phase: null, kind: null, text: '', startsInMs: null };
    if (!root || typeof root.querySelectorAll !== 'function') return none;

    // The status is a *run* of text, and the game splits it across elements —
    // "Skilling Trial - In Progress" arrives as separate nodes on the live tab.
    // Neighbouring runs are therefore considered together as well as alone, so
    // the words being in two spans does not hide them. `allLines` lets the caller
    // hand in a panel walk it already did — the render reads status and personal
    // stats off the same root and used to walk it twice.
    const lines = (allLines || textLines(root)).slice(0, STATUS_LINE_LIMIT);
    const candidates = [];
    for (let index = 0; index < lines.length; index += 1) {
        candidates.push(lines[index]);
        if (lines[index + 1]) candidates.push(`${lines[index]} ${lines[index + 1]}`);
    }

    for (const line of candidates) {
        if (line.length > STATUS_MAX_CHARS) continue;

        const phase = TRIAL_STATUS_SCHEDULED_RE.test(line)
            ? 'scheduled'
            : TRIAL_STATUS_COMPLETED_RE.test(line)
              ? 'completed'
              : TRIAL_STATUS_IN_PROGRESS_RE.test(line)
                ? 'live'
                : null;
        if (!phase) continue;

        const startsInMs = phase === 'scheduled' ? parseWordyDurationMs(line) : null;
        // The header names the trial it is about — "Skilling Trial - In
        // Progress" — and a cycle runs the two kinds one after the other, so a
        // status without its kind attached says the combat trial is under way
        // during the skilling hour. Which is what it did.
        const kind = TRIAL_KIND_SKILLING_RE.test(line) ? 'skilling' : TRIAL_KIND_COMBAT_RE.test(line) ? 'combat' : null;
        return { phase, kind, text: line, startsInMs: Number.isFinite(startsInMs) ? startsInMs : null };
    }

    return none;
}

/**
 * How far into the tab a status line can be before it is something else.
 *
 * Raised from a dozen once the live header turned out to be
 * "Skilling Trial - In Progress  Thu 04:00 PM" — a kind prefix, a status and a
 * timestamp, spread across several runs, and sitting below whatever the tab
 * draws above it.
 */
const STATUS_LINE_LIMIT = 40;

/** Longer than this and the line is prose, not a status */
const STATUS_MAX_CHARS = 60;

/**
 * The labelled numbers the In Progress tab puts in its footer.
 *
 * "Work Time 3.14s, Success Rate 60.8%" — the player's *own* action stats for
 * the trial they are in, which is the only personal skilling figure anything on
 * the wire or the screen offers. No socket message carries a success chance
 * (the enhancement one in this codebase is a different mechanic entirely), so
 * this is it, and it exists only while the tab is open, like every other trial
 * reading.
 *
 * Read as label/number pairs rather than as a list of known stats: whatever the
 * game decides to show lands in the record without this file having to have
 * heard of it, and a stat that is added later is captured on the day it appears.
 *
 * @param {Element} root - The trials root
 * @returns {Object<string, string>} Label → the value as the game wrote it
 */
export function readPersonalStats(root, allLines = null) {
    const stats = {};
    if (!root || typeof root.querySelectorAll !== 'function') return stats;

    const lines = allLines || textLines(root);
    const digits = gameDigitsSource();
    const value = new RegExp(`^[+-]?(?:${digits})\\s*(%|s|ms|x)?$`, 'i');
    const inline = new RegExp(`^(.+?)[:\\s]\\s*([+-]?(?:${digits})\\s*(?:%|s|ms|x)?)$`, 'i');

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // A reading is a bar, not a stat, and a sign-up ratio is neither
        if (line.includes('/')) continue;

        const pair = line.match(inline);
        if (pair && isStatLabel(pair[1])) {
            stats[pair[1].trim()] = pair[2].trim();
            continue;
        }

        // Label on one run, number on the next, which is how the game draws most
        // of them
        const next = lines[index + 1];
        if (!next || !value.test(next) || value.test(line) || !isStatLabel(line)) continue;
        stats[line.replace(/[:\s]+$/, '')] = next.trim();
        index += 1;
    }
    return stats;
}

/**
 * Generic words that are a heading or a clock rather than the name of a stat.
 *
 * A denylist of exactly the words that turned up as labels, kept small on
 * purpose: the open-ended capture is the point of this reader, and anything
 * longer starts refusing stats the game has not invented yet.
 */
const NON_STAT_LABELS = /^(time|total|elapsed|duration|remaining|left|now)$/i;

/**
 * A label that is a number with an optional unit — `59m`, `12`, `3ms`.
 * Rebuilt from {@link gameDigitsSource} on every call, not a frozen constant,
 * so a period-grouped "1.234m" is recognised as numeric (and therefore
 * excluded from stats) under a period-grouping locale too.
 * @returns {RegExp}
 */
function numericLabelPattern() {
    return new RegExp(`^(?:${gameDigitsSource()})\\s*[a-z]{0,2}$`, 'i');
}

/**
 * Whether a run of text is the name of a stat rather than something beside one.
 *
 * The reader is deliberately open-ended — whatever the game shows lands in the
 * record without this file having heard of it — and that is what let a **time
 * list** in. The exported footer carried `"59m": "5s"`, `"58m": "2s"` … down to
 * `"1m": "3s"` and `"Time": "1s"`: a per-minute session log, fifty-eight rows of
 * it, read as stats and stored beside Work Power and Success Rate. It also
 * carried `"Lv.100": "6"`.
 *
 * So the capture stays open and gains a floor. A stat's name is a *word*: it has
 * a run of at least three letters, it is not a number with a unit stuck to it,
 * and it is not one of the handful of generic headings that are a clock rather
 * than a measurement. "Work Power", "Double Progress", "Ranged Accuracy" and
 * anything shaped like them pass; "59m", "Lv.100" and a bare "Time" do not.
 *
 * @param {string} label - The candidate label
 * @returns {boolean} True when it may name a stat
 */
export function isStatLabel(label) {
    const text = String(label || '')
        .replace(/[:\s]+$/, '')
        .trim();
    if (!text) return false;
    if (numericLabelPattern().test(text)) return false;
    if (NON_STAT_LABELS.test(text)) return false;

    // A letter-word of three, which "Lv.100" and "T3" do not have
    return /[a-z]{3,}/i.test(text);
}

/**
 * Whether the tab on screen is the **Trials** setup tab rather than In Progress.
 *
 * Both tabs live under the same panel and {@link findTrialsRoot} deliberately
 * cannot tell them apart — it is looking for trial cards, and both tabs have
 * some. Anything that belongs to one tab specifically has to ask.
 *
 * Told apart by what the cards carry, which is the one difference confirmed from
 * a live client: the In Progress tab's card is a *reading* and the Trials tab's
 * cards have no progress bar anywhere on them, carrying sign-ups and points
 * instead. So the setup tab is "trial cards, at least one of which says what it
 * is worth or who signed up, and not one of which is a bar".
 *
 * The sign-up roster was being drawn on In Progress because it asked
 * `findTrialsRoot` and that answers for either tab — reported after a trial
 * advanced a tier, which is exactly when the In Progress tab redraws.
 *
 * @param {Element|null} root - The trials root
 * @returns {boolean} True on the Trials tab
 */
export function isTrialsSetupTab(root) {
    const tiles = readTrialTiles(root);
    if (!tiles.length) return false;
    if (tiles.some((tile) => tile.readings.length > 0)) return false;
    return tiles.some((tile) => tile.signups !== null || Number.isFinite(tile.points) || Number.isFinite(tile.tier));
}

/** How far to climb from a reading before giving up on finding its card */
const CARD_CLIMB_LIMIT = 6;

/**
 * An element's own text, without its children's.
 *
 * The difference is the whole reason cards can be found at all: `textContent`
 * welds a card's runs into one string that parses as numbers nobody displayed,
 * while own text says what *this* element is showing — which is what makes it an
 * anchor or not.
 *
 * @param {Element} el - The element
 * @returns {string} Its own text, trimmed
 */
function ownText(el) {
    let text = '';
    for (const child of el?.childNodes || []) {
        if (child.nodeType === 3) text += child.textContent || '';
    }
    return text.trim();
}

/**
 * The card an element belongs to.
 *
 * By class where the game offers one, and otherwise by climbing until the
 * subtree holds a name as well as the number that was climbed from. Trial cards
 * on the In Progress tab carry no class this file can name and no level, so
 * "the smallest ancestor that has both a name and a reading" is what a card
 * *is* there — and it is the definition that survives a redesign, since it
 * describes the card rather than its markup.
 *
 * @param {Element} start - The element the number was found on
 * @param {Element} root - Never climb past this
 * @returns {Element} The card, or the starting element when nothing better is found
 */
function cardFor(start, root) {
    const named = start.closest?.('[class*="GuildPanel_tile"]:not([class*="GuildPanel_tileSummary"])');
    if (named) return named;

    let node = start;
    for (let step = 0; step < CARD_CLIMB_LIMIT; step += 1) {
        if (textLines(node).some((line) => isTrialName(line))) return node;
        if (!node.parentElement || node === root) break;
        node = node.parentElement;
    }
    return start;
}

/**
 * The trial cards on either trial tab.
 *
 * Cards are found by what they contain rather than by what they are called: a
 * tile summary (the Trials tab's setup cards) or a progress reading (the In
 * Progress tab's live card). Everything after that is per-card text, and
 * everything a card does not carry comes back null rather than being guessed —
 * a Trials card has a level and no reading, the In Progress card has a reading
 * and no level, and the record joins them by name.
 *
 * The filter that makes this safe against a whole-panel root is the name: a card
 * whose name is not a trial's is dropped, which excludes guild buildings, member
 * rows and the guild's own XP bar without needing to know what any of them look
 * like.
 *
 * @param {Element} root - The trials root, from {@link findTrialsRoot}
 * @returns {Array<{element: Element, name: string, level: number|null, tier: number|null,
 *   kind: 'combat'|'skilling', completed: boolean, readings: Array<{current: number, max: number}>,
 *   signups: {signed: number, total: number}|null, points: number|null}>} Cards, in document order
 */
export function readTrialTiles(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];

    // What a card is anchored by: the level line that the Trials tab's cards
    // carry, or the reading that is all the In Progress tab's card has. Own text
    // rather than `textContent`, so an anchor is the element that actually holds
    // the run — and so that a level line this script has appended a tier badge
    // to is still found.
    const anchors = [...root.querySelectorAll('*')].filter((el) => {
        // Cheap positive tests first, ancestor walks last: the two exclusions
        // below each climb to the panel root, so running them on every element
        // was O(elements × depth) over the whole guild panel. A tile summary is
        // a card outright; otherwise a card is anchored by a level, a bar, a
        // stated tier or a points line in the element's *own* text — and an
        // element with no direct text of its own can be none of those, so it is
        // dropped before the regexes run.
        const isTileSummary = typeof el.className === 'string' && el.className.includes('GuildPanel_tileSummary');
        if (!isTileSummary) {
            const own = ownText(el);
            // A stated tier or a points line anchors a card too. Without them a
            // Trials card that carries neither a level nor a bar — which is how
            // the live tab was found to draw them, "840 pts" over "T6" — has
            // nothing to be found by. Everything found here is still filtered by
            // `isTrialName` below, so a stray "T3" in prose costs one climb.
            if (
                !own ||
                (parseTrialLevel(own) === null &&
                    parseBarReadings(own).length === 0 &&
                    parseTrialTier(own) === null &&
                    parsePoints(own) === null)
            ) {
                return false;
            }
        }

        // Now the climbs, for the handful of candidates that got this far.
        // Never this script's own output: the per-card block is appended to the
        // card it describes, so a careless anchor list reads it straight back.
        if (el.closest?.('[class*="mwi-"]')) return false;
        // And never a floating dialog. The boss's stat popup is headed with a
        // trial name over a level, which is exactly what a card is anchored by.
        if (inFloatingDialog(el)) return false;
        return true;
    });

    const tiles = [];
    const seen = new Set();

    for (const anchor of anchors) {
        const tile = cardFor(anchor, root);
        if (seen.has(tile)) continue;
        seen.add(tile);

        // Per element, never off the whole card. `textContent` welds siblings
        // together with no separator: a card holding "Lv.110" beside a bar
        // holding "1.2M / 4M" reads as `Lv.1101.2M / 4M`, which parses as level
        // 1,101 and a current of 1,101,200,000. Both wrong, neither obviously so.
        const lines = textLines(tile);
        const name = readTileName(tile, anchor, lines);
        // The one filter standing between this and the rest of the guild page
        if (!isTrialName(name)) continue;

        const level = lines.map(parseTrialLevel).find((candidate) => candidate !== null) ?? null;
        const signups = lines.map(parseSignups).find((candidate) => candidate !== null) ?? null;
        // A stated tier beats a derived one, and is available on a card that
        // carries no level at all. `textLines` skips this script's own elements,
        // so the `T<n>` badge `guild-credit-value.js` writes into the level line
        // is never read back as if the game had said it — confirmed against a
        // with-Toolasha-disabled screenshot: the game's own trial card prints
        // **no tier badge at all**, only "Crafting Lv.210, 1,664 pts". The
        // level is therefore the card rung's real ground truth, and
        // `tierFromLevel(level)` counts tiers *banked*: Lv.210 sits beside
        // 1,664 pts, which is the twelve-tier base of 1,300 at a +28% hall
        // exactly — a whole number of 2% steps at no other banked count.
        const statedTier = lines.map(parseTrialTier).find((candidate) => candidate !== null) ?? null;

        tiles.push({
            element: tile,
            name,
            level,
            completed: lines.some((candidate) => COMPLETED_PATTERN.test(candidate)),
            tier: statedTier ?? (level === null ? null : tierFromLevel(level)),
            kind: isCombatTrialName(name) ? 'combat' : 'skilling',
            // Sign-up counts are excluded rather than filtered afterwards:
            // "1/28 signed up" has precisely the shape of a progress bar, and a
            // trial sampled against a sign-up ratio would report a pool that
            // fills and empties as members join
            readings: lines.filter((line) => !SIGNUP_PATTERN.test(line)).flatMap(parseBarReadings),
            signups,
            points: lines.map(parsePoints).find((candidate) => candidate !== null) ?? null,
        });
    }

    return tiles;
}

/**
 * A card's text, one entry per run the game rendered.
 *
 * Text *nodes* rather than leaf elements, which is a correction rather than a
 * refinement: this script appends a `T<n>` tier badge inside the very element
 * that carries "Lv.130" (`guild-credit-value.js`), and a leaf-element walk skips
 * any element that has acquired a child — so the level line disappeared from
 * every card the moment the badge was added to it, and the tier could not be
 * read from a card this script had itself annotated. Walking text nodes keeps
 * the two runs apart *and* keeps them both.
 *
 * Joining them, which is what `textContent` does, is the other failure: a card
 * holding "Lv.110" beside a bar holding "1.2M / 4M" reads as `Lv.1101.2M / 4M`.
 *
 * Anything this script injected is skipped. A card's own block is appended to
 * the card, so without that the panel would read its own output back — "Next
 * tier work (T5)" is not something the game said.
 *
 * @param {Element} tile - The tile
 * @returns {string[]} Trimmed, non-empty runs of text, in document order
 */
export function textLines(tile) {
    const lines = [];
    if (!tile || typeof tile !== 'object') return lines;

    const ours = (node) => typeof node.className === 'string' && node.className.includes('mwi-');
    const walk = (node) => {
        for (const child of node.childNodes || []) {
            // 3 is a text node, 1 an element; anything else (comments) is not text
            if (child.nodeType === 3) {
                const text = (child.textContent || '').trim();
                if (text) lines.push(text);
            } else if (child.nodeType === 1 && !ours(child)) {
                walk(child);
            }
        }
    };

    walk(tile);
    return lines;
}

/**
 * A tile's trial name.
 *
 * Taken from a name element when the markup offers one. Failing that, from the
 * line that carries the level marker with words in front of it — "Trial
 * Jellyfish Lv.170" — because that is where a name provably is, whereas "the
 * first line that is not the summary" is only where a name usually is: on a card
 * whose summary holds both the name and the level, that rule picks up the
 * progress bar instead and calls the trial "1.2M / 4M", which then classifies as
 * skilling and matches no sign-up hrid. Only when neither is available does it
 * fall back to the first line that is not the summary.
 *
 * @param {Element} tile - The tile
 * @param {Element} summary - Its summary element
 * @param {string[]} lines - The card's text lines, from {@link textLines}
 * @returns {string} The name, or an empty string
 */
function readTileName(tile, summary, lines) {
    const named = tile.querySelector?.('[class*="GuildPanel_tileName"], [class*="GuildPanel_name"]');
    if (named?.textContent?.trim()) return named.textContent.trim();

    // `TRIAL_LEVEL_RE` carries a capture group, which `split` would interleave
    // into its output; only the [0] "before the marker" piece is read, which is
    // the same either way
    const levelMarker = TRIAL_LEVEL_RE;
    for (const line of lines) {
        if (!levelMarker.test(line)) continue;
        const beforeLevel = line.split(levelMarker)[0].trim();
        if (beforeLevel) return beforeLevel;
    }

    const summaryText = summary?.textContent?.trim() || '';
    const first = lines.find((line) => line !== summaryText) || summaryText;
    return first.split(levelMarker)[0].trim() || first;
}

/**
 * Which reading on a tile is the boss health and which is the shared pool.
 *
 * ## A combat card is health then mana, and that is confirmed
 *
 * The two readings on the In Progress combat card are the boss's **health** and
 * the boss's **mana**, in that order — checked against a live client. Neither is
 * a pool, and the second one is not a rate of anything the party is doing.
 *
 * They used to be told apart by which of them *fell* over successive samples,
 * which was the cautious rule when the card had only been seen in a screenshot.
 * It cannot work, and the recording of a real trial says why: a combat trial is
 * a ladder of bosses, so between two readings the health bar can rise (a fresh,
 * larger boss) while the mana bar rises too. Nothing fell, so nothing was
 * classified, so a combat card never produced a rate at all — for the entire
 * hour of a live trial. Position is the reliable fact here and movement is not.
 *
 * A skilling card carries one pool, and is still read by movement.
 *
 * @param {Array<Array<{current: number, max: number}>>} history - Readings per sample, oldest first
 * @param {'combat'|'skilling'} kind - What the trial is
 * @returns {{bossIndex: number|null, poolIndex: number|null}} Indices into a tile's readings
 */
export function classifyReadings(history, kind) {
    const samples = (history || []).filter(Array.isArray);
    const width = samples.reduce((max, sample) => Math.max(max, sample.length), 0);
    if (width === 0) return { bossIndex: null, poolIndex: null };

    // The boss's health is the first bar and the second is its mana, which is
    // not a pool and is not sampled for anything
    if (kind === 'combat') return { bossIndex: 0, poolIndex: null };

    // A skilling card carries exactly one bar, and it is the pool by
    // construction — movement cannot reclassify it. Reading it by movement
    // mislabelled the one moment continuity matters most: across a tier clear
    // the pool *falls* (a reset onto the next tier's target), the lone bar was
    // then classified as a boss, and the analysis dropped the bar — target,
    // tier and all — right as the next tier began.
    if (width === 1) return { bossIndex: null, poolIndex: 0 };

    let bossIndex = null;
    let poolIndex = null;

    for (let index = 0; index < width; index += 1) {
        let fell = 0;
        let rose = 0;
        for (let step = 1; step < samples.length; step += 1) {
            const before = samples[step - 1][index]?.current;
            const after = samples[step][index]?.current;
            if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
            if (after < before) fell += 1;
            if (after > before) rose += 1;
        }
        if (fell > rose && bossIndex === null) bossIndex = index;
        if (rose > fell && poolIndex === null) poolIndex = index;
    }

    // No movement yet. One reading on a card is unambiguous from its kind; two
    // are not, and a coin flip here would invert a rate.
    if (bossIndex === null && poolIndex === null && width === 1) {
        if (kind === 'combat') bossIndex = 0;
        else poolIndex = 0;
    }

    return { bossIndex, poolIndex };
}
