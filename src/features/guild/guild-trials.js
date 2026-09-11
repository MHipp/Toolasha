/**
 * Guild trials, while they are running.
 *
 * The game's In Progress tab shows a bar and a level. It does not say how fast
 * the bar is moving, whether the tier in front of the party is reachable before
 * the hour ends, what the tier after that will cost, or what any of it is worth
 * when the tokens are paid out on Friday. Those are the four questions a guild
 * actually argues about while a trial is live, and all four are answerable from
 * the bar plus the rules — which is what this draws.
 *
 * The rules themselves, and every formula derived from them, are pinned in
 * `guild-trials-math.js`; reading the panel is `guild-trials-scrape.js`; the
 * samples and the building levels are `guild-trials-store.js`. This file is the
 * wiring: observe the tab, take a reading every few seconds while it is open,
 * and put three blocks on the screen.
 *
 * ## What it can and cannot know
 *
 * **Rates are measured, not computed.** Nothing in the client's static data
 * gives a tier's required work or a trial boss's health, so the first reading of
 * a tier says "measuring" and the second gives a rate. That is also why samples
 * are persisted: a player who checks the tab twice a minute should not restart
 * the measurement each time.
 *
 * **Tier growth is exact, anchored on one observation.** Projecting the tier
 * after the current one needs the curve the totals grow along, which is not in
 * client data — but both kinds' curves are now known exactly (`exactTierTotal`:
 * a tenth of the first tier's work per skilling tier, `10 + level` for a combat
 * boss), and they are ratios, so the bar in hand anchors the whole ladder. The
 * fitted growth factor survives only as a fallback.
 *
 * **A skilling tier can be known from its bar alone.** The bar's target is
 * `base × (1 + 0.1 × (tier − 1)) × (1 + 0.01 × participants)`, and the base is
 * learned per skill the first time a stated tier, the target and the
 * participant count are on screen together — after which a mid-trial join on
 * the In Progress tab, which carries no tier at all, still knows which tier it
 * is watching (`tierFromWorkTarget`, `tierSource: 'work-ladder'`).
 *
 * **Tiers cleared is inferred from the tier on screen.** A trial starts at tier
 * 1 and climbs one at a time, so a trial showing tier 7 has banked six. This is
 * the only inference here that is not measured, and it is the one thing on the
 * block that nothing has ever confirmed — so the payout no longer rests on it:
 * the points come from what the cards state (below), which is checked against
 * the guild's own announcements. It still drives the "Banked N tiers" line and
 * where the pace projection starts from.
 *
 * **Token payouts are worth something, approximately.** Tokens have no market
 * price, but the guild shop trades them for guild credits and credits are priced
 * off the items that convert into them, so the payout rows carry a derived gold
 * figure labelled "via credit exchange" (`guild-token-value.js`). Without an
 * exchange rate the rows show the bare token count they always did.
 *
 * **Nothing arrives while the tab is shut.** This is the honest limit of the
 * whole feature and it is worth stating where somebody will read it: no socket
 * message carries a running trial's pool fill or a boss's health, so a reading
 * only exists because the tab was on screen when the sampler ran. A trial can
 * therefore be live, and this can have nothing to say about it, and both of
 * those can be true at once. Everything downstream — the blocks here, the
 * overlay tile in `guild-trials-row.js` — must say *that* rather than going
 * quiet, because a blank surface during a live trial is indistinguishable from a
 * broken one. It was reported as a broken one.
 *
 * **Zero is a claim, and usually the wrong one.** Three separate things used to
 * reach the screen as `0`: a tier that has not been seen because only the In
 * Progress tab was ever open (it carries no tier), a trial genuinely still on
 * its first tier, and a pace that could not be projected. The first is *unknown*
 * and the block now says which of the three it is, along with what to open to
 * fix it. A player who joins a trial midway sees the first of these until they
 * look at the Trials tab once, and it is not a failure of the arithmetic.
 *
 * **The game states what a trial has earned, and it wins.** The Trials tab's
 * cards carry an "840 pts" line, and four days of the guild's own chat
 * announcements say the sum of exactly those figures is the Guild Points the
 * guild is paid. So the payout block sums the cards. They are *Guild Points* —
 * base points with the Builder's Hall bonus already applied — which is the one
 * thing this file used to get wrong in both directions at once: it compared them
 * against the ladder's un-bonused figures and reported a disagreement on every
 * card of every week, and it looked each figure up under its own inference about
 * how many tiers were banked, missed by a tier every time, and fell back to the
 * ladder. Announced 2,880; panel said 2.4K.
 *
 * **A combat trial's DPS can be split per player.** The card's "Party DPS" is
 * measured off the boss bar and cannot say who is producing it. The fight itself
 * is an ordinary battle on the wire, so `guild-trial-damage.js` attributes it —
 * but only for fights this client is actually in, and only when the fight can be
 * shown to be the trial's.
 *
 * **Payout bonuses are 2% per level, both of them.** Guild Points scale with the
 * Builder's Hall and token payouts with the Treasury, and both in-game upgrade
 * popups confirm the same rule ("Guild Points: +20% → +22%" at Hall level 10,
 * "Guild Token Rewards: +10% → +12%" at Treasury level 5). The *levels* arrive
 * on guild traffic and are captured and persisted the moment they are seen. When
 * a level has not been seen the Builder's Hall bonus can still be recovered from
 * the cards themselves — a card states Guild Points for a tier whose base the
 * ladder knows, and the ratio is the bonus — and the Treasury, which has no such
 * shortcut, is left out of the token figures with the block saying so.
 *
 * **A combat card is health then mana.** Both bars belong to the boss, and only
 * the first is damage. The rate is accumulated across tier clears rather than
 * fitted to a falling bar, because a combat trial is a ladder of bosses and the
 * bar jumps *up* every time one dies — see `combatDamageRate`.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { formatEta } from '../../utils/progress-eta.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import {
    EXTRA_TIER_POINTS,
    TRIAL_ACTIVE_MS,
    TRIAL_MAX_LEVEL,
    TRIAL_MAX_TIER,
    TRIAL_SKILLS,
    baseWorkFromObservations,
    combatDamageRate,
    estimateGrowthPerTier,
    etaMs,
    exactTierTotal,
    inferBuildersHallBonus,
    levelFromTier,
    nextTierPreview,
    parseCurrentTrialsData,
    partialTierCredit,
    payoutProjection,
    projectPace,
    projectTierTotal,
    ratePerMs,
    participantScale,
    tierFromWorkTarget,
    tierMarginalPoints,
    trialBankedBasePoints,
    trialWeekStart,
} from './guild-trials-math.js';
import guildTrialDamage, { attributionCoverage, encounterOf, encounterOfMonster } from './guild-trial-damage.js';
import guildTrialSkilling from './guild-trial-skilling.js';
import guildTrialStatsModal from './guild-trial-stats-modal.js';
import guildLoadoutCapture from './guild-loadout-capture.js';
import guildTrialRecorder, {
    buildTrialExport,
    downloadTrialExport,
    trialExportIsEmpty,
} from './guild-trial-recorder.js';
import guildTrialScoreboard from './guild-trial-scoreboard.js';
import { guildRosterPanel } from './guild-roster-view.js';
import guildMemberSkills from './guild-member-skills.js';
import guildTrialTrace, { describeTraceStatus } from './guild-trial-trace.js';
import guildTrialAbilities from './guild-trial-abilities.js';
import guildTrialAbilitiesFeature, { openTrialAbilitiesPanel } from './guild-trial-abilities-ui.js';
import { openTrialLedgerPanel } from './guild-trial-ledger-view.js';
import { forecastTrial } from './guild-trial-forecast.js';
import { tierTimingAsForecast, tierTimingForecast } from './guild-trial-tier-timing.js';
import { renderTierBadge } from './guild-trial-tier-badge.js';
import guildTrialAlerts from '../notifications/guild-trial-alerts.js';
import { describeGuildTokenGold } from './guild-token-value.js';
import {
    NOT_A_CLOCK_RE,
    classifyReadings,
    findTrialClockMs,
    findTrialsRoot,
    inFloatingDialog,
    matchTrialHrid,
    onTrialTab,
    parseClockMs,
    readPersonalStats,
    readTrialStatus,
    readTrialTiles,
    textLines,
} from './guild-trials-scrape.js';
import {
    archiveCycle,
    emptyRecord,
    loadTrialRecord,
    loadWorkBases,
    mergeTrialRecords,
    purgeLegacyTrialRecord,
    readPayoutBonuses,
    recordProvenance,
    recordTileSample,
    saveTrialRecord,
    saveWorkBases,
    tileKey,
    tilePersonalStats,
} from './guild-trials-store.js';
import { FOREIGN_CYCLE_REASON, pastWeekLine, summariseArchivedCycle } from './guild-trial-history.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

/** Class every injected element carries, so cleanup is one query */
const CSS_CLASS = 'mwi-trial-info';

/** How often a reading is taken while the tab is open */
const SAMPLE_MS = 5000;

/** Every trial starts here, which is what makes the first tier knowable */
const FIRST_TIER = 1;

/**
 * How stale a spectated pool reading may be before it stops standing in.
 *
 * The stream ticks several times a second while the fight view is open and stops
 * dead when it closes. Ten seconds is long enough to bridge a redraw and short
 * enough that a closed view stops feeding the card a health that is no longer
 * moving — which would read as a rate of zero on a trial that is running fine.
 */
const SPECTATED_POOL_FRESH_MS = 10_000;

/**
 * How old a bar reading may be and still teach a skill's base work.
 *
 * The record's last target survives tab switches, and a tier that cleared
 * while the tab was shut would pair the *old* target with the *new* badge —
 * a wrong base learned once states wrong tiers with confidence from then on.
 * Fifteen seconds matches the skilling stream's own freshness window.
 */
const WORK_BASE_LEARN_FRESH_MS = 15_000;

/** What a card's level line looks like, for finding the node the tier badge belongs on */
const LEVEL_LINE_RE = /Lv\.\s*\d+/;

const ACCENT = '#8fd3ff';
const DIM = '#9ca3af';
const GOOD = '#4ade80';
const WARN = '#f0a830';

/**
 * First-tier totals confirmed by direct observation, as cold-start seeds.
 *
 * The learned store answers first and overrides these; the seeds exist because
 * the store cannot cross a browser profile — the user's second account, in a
 * second browser, mid-joined a trial and had base and bar in front of it with
 * no way to connect them ("tier not known yet" over a bar reading 8,276/51,360
 * = 40,000 × 1.2 × 1.07 exactly). Each entry is backed by observations this
 * codebase already carries:
 *
 * - **crafting 40,000** — two guilds and an export: 49,920 = ×1.2×1.04 (T3,
 *   4 signed), 88,920 = ×1.9×1.17 (T10, 17 signed), and a full T2–T15 ladder
 *   41,600 × (1 + 0.1(t−1)) in the recorded week.
 * - **foraging 40,000** — a live trial watched through 40,800 / 44,880 /
 *   48,960 with 2 signed up.
 * - **alchemy 40,000** — a live card at 65,280 = ×1.6×1.02 (T7, 2 signed).
 * - **Trial Chameleon 550,000** — the pool bar's own ladder 550,000 / 600,000
 *   / 650,000 / 700,000 = (100 + 10t) × 5,000, with the HP bar exactly ×1.04
 *   beside it in a 4-participant guild and ×1.03 in a 3-participant one.
 * - **Trial Badger 330,000** — a `new_guild_battle` sheet: 429,000 with 30 in
 *   the trial, 330,000 × 1.3 exactly.
 *
 * Every observed skilling base has been 40,000, on every skill it has ever
 * been checked against, so all ten skilling trials are now seeded with it
 * rather than only the three that had been watched from the inside.
 *
 * That gap was not harmless. A base is *learned* only from a live progress bar
 * ({@link GuildTrials#_learnWorkBase}), and a bar only ever streams for a trial
 * this character joined — so an unjoined Milking or Tailoring card could never
 * learn one, and "learns on its first stated-tier moment" described a moment
 * that structurally never arrived. The work ladder was therefore unavailable
 * for exactly the cards with nothing else to go on. The learned store still
 * answers first and overrides these, so a skill that turns out to differ
 * corrects itself the moment somebody joins it.
 */
const SKILLING_WORK_BASE = 40_000;

const DEFAULT_WORK_BASES = {
    ...Object.fromEntries(TRIAL_SKILLS.map((skill) => [skill, SKILLING_WORK_BASE])),
    'trial chameleon': 550_000,
    'trial badger': 330_000,
};

/**
 * Everything derivable about one trial, from its stored samples.
 *
 * Pure, and exported for tests: it takes a record and returns numbers, and never
 * touches the DOM, the clock or storage.
 *
 * @param {Object} record - A tile record from `guild-trials-store.js`
 * @param {Object} [options] - Context
 * @param {number} [options.participants] - Signed-up participants, for the next-tier caption
 * @param {number|null} [options.timeLeftMs] - Active time left in the trial
 * @param {number|null} [options.buildersHallBonus] - Builders Hall bonus fraction, for reading the card's points
 * @param {string|null} [options.phase] - `scheduled`, `live` or `completed`, for the first-tier rule
 * @param {number|null} [options.workBase] - The skill's learned first-tier work, for the work-ladder tier rung
 * @param {string|number|null} [options.characterId] - Whose personal figures the analysis reports
 * @returns {{kind: string, tier: number|null, level: number|null, tiersClearedSoFar: number,
 *   rate: number|null, rateNote: string|null, remaining: number|null, total: number|null,
 *   etaMs: number|null, growthPerTier: number|null, next: Object|null, pace: Object|null,
 *   samples: number, timeLeftMs: number|null, tiers: Array<{tier: number, total: number}>,
 *   personalByTier: Object}} Analysis
 */
export function analyseTrial(
    record,
    {
        participants = 0,
        timeLeftMs = null,
        buildersHallBonus = null,
        phase = null,
        workBase = null,
        liveTierFloor = null,
        characterId = null,
    } = {}
) {
    const samples = Array.isArray(record?.samples) ? record.samples : [];
    const kind = record?.kind === 'combat' ? 'combat' : 'skilling';

    // What the badge on the card means, which is not what this assumed.
    //
    // Watched through a live trial: after the first tier cleared the card read
    // "Lv.100, 236 pts, T1", and after the second "Lv.110, 354 pts, T2" — while
    // the pool on the In Progress tab was plainly the *third* one. So the badge
    // counts tiers **banked**, and the tier being fought is one past it. The old
    // rule (badge is the tier in progress, banked is one fewer) was wrong in
    // both directions at once and produced "Banked 1 tier" under a T2 badge.
    //
    // That also settles the completed case the same way, which is what the
    // points identity already said: a finished card's badge is what it reached.
    //
    // Before any badge exists, a running trial is on its first tier and has
    // banked nothing — every trial starts there. A card already stating points
    // is a mid-trial join and keeps the unknown-tier behaviour.
    const badge = Number.isFinite(record?.tier) ? record.tier : null;
    const statedPoints = Object.keys(record?.pointsByTier || {}).some(
        (entry) => Number(record.pointsByTier[entry]) > 0
    );
    const completed = Boolean(record?.completed);

    // Whether this trial has finished anything at all. The points are what say
    // so, and they are what tells the two readings of a badge apart:
    //
    //   "Lv.100, 0 pts, T1"   — tier one, in progress, nothing banked
    //   "Lv.100, 236 pts, T1" — tier one banked, tier two being fought
    //
    // Both were watched on the same card an hour apart. Without the points half
    // of that rule a combat card sitting at Lv.100 during the *skilling* hour
    // claimed a banked tier for a trial that had not started, and put it in the
    // payout.
    //
    // A card that *states* zero is the third reading, and it is a wipe: the
    // Hedgehog party fell before clearing tier one, so its card read "Lv.100,
    // 0 pts, Completed". Letting `completed` imply "earned" credited it the tier
    // it was fighting, and the block said "Banked 1 tier · finished" for a trial
    // that banked nothing. A stated zero outranks the completed badge; a card
    // whose points were never seen at all is unchanged.
    const statedZero = record?.points === 0;
    const earned = statedPoints || record?.points > 0 || (completed && !statedZero);
    const assumeFirst = phase === 'live' && badge === null && !earned;
    const observations = Array.isArray(record?.tiers) ? record.tiers : [];

    const history = samples.map((sample) => sample?.readings || []);
    const { bossIndex, poolIndex } = classifyReadings(history, kind);
    const index = kind === 'combat' ? bossIndex : poolIndex;
    const direction = kind === 'combat' ? -1 : 1;

    // Read ahead of the tier because the tier may now be derived *from* it: the
    // bar's target is the one thing the In Progress card does carry
    const latest = index === null ? null : samples[samples.length - 1]?.readings?.[index] || null;
    const total = Number.isFinite(latest?.max) ? latest.max : null;
    const remaining = latest ? (direction === -1 ? latest.current : Math.max(0, latest.max - latest.current)) : null;

    // The tier being fought, which is what a rate, a pace and a forecast are
    // about — from the best of four rungs, each labelled so a caption can say
    // where the number came from:
    //
    // 1. **The badge** ('card'), read as the comment above explains it.
    // 2. **The socket** ('socket'): `guild_skilling_updated.tier` states the
    //    tier in progress outright, and the store keeps it as `liveTier`.
    // 3. **The work ladder** ('work-ladder'): the bar's target identifies the
    //    tier once the skill's base work is known — see `tierFromWorkTarget`.
    //    This is what makes a mid-trial join on the In Progress tab knowable
    //    without ever opening the Trials tab.
    // 4. **The first-tier rule** ('first-tier-rule'), as before.
    //
    // ## The rungs go stale at different speeds, and that decides who wins
    //
    // Live evidence, one moment, two tabs: the In Progress bar read
    // 17,353/99,840 — a target only T15 produces — while the panel said
    // "Banked 8 tiers" and "Next tier work (T10)". A `liveTier` of 9, stated
    // hours earlier when the trial genuinely was on tier 9, had been persisted
    // and never invalidated, and the rung order let it outrank the bar in
    // front of the player until a Trials-tab visit rewrote the badge.
    //
    // So staleness is now handled twice over:
    //
    // - A socket-stated tier is only believed **for the pool it was stated
    //   with**. The update carries `targetWorkValue`, the store keeps it as
    //   `liveTierTarget`, and the moment the bar's target no longer matches,
    //   the statement is about a tier that has since cleared and is dropped.
    // - Tiers only climb, so the winner is the **largest** valid rung — the
    //   badge and the socket can lag but never lead, and the work ladder reads
    //   the bar as it is *now*. Ties go to the stated sources over the derived
    //   one.
    //
    // The work ladder no longer needs the learned store to have spoken: any
    // correctly-filed tier observation from this trial backs the base out
    // (`baseWorkFromObservations`), so a record that once knew its tier keeps
    // knowing it as later tiers clear with the tab sitting open.
    const fromBadge = badge !== null ? (completed || !earned ? badge : badge + 1) : null;

    const socketTarget = Number.isFinite(record?.liveTierTarget) ? record.liveTierTarget : null;
    const socketStale = socketTarget !== null && Number.isFinite(total) && total !== socketTarget;
    const fromSocket = !completed && !socketStale && Number.isFinite(record?.liveTier) ? record.liveTier : null;

    // Only an observation above the first tier may seed the fallback base: a
    // tier-1 observation may be the first-tier rule's own filing, and a base
    // derived from it "confirms" tier 1 by construction — an assumption
    // relabelled as arithmetic. Combat records file both of a card's bars as
    // observations and the two sit on differently-scaled ladders, so the
    // observation fallback is a skilling-only shortcut; a combat base comes
    // from the learned store.
    const anchoredObservations = observations.filter((observation) => Number(observation?.tier) >= 2);
    const ladderBase =
        Number.isFinite(workBase) && workBase > 0
            ? workBase
            : kind === 'skilling'
              ? baseWorkFromObservations(anchoredObservations, participants, kind)
              : null;

    // A combat card's *second* bar is the cleaner tier anchor: it is the
    // tier's own pool, scaling purely with the tier's level — observed live as
    // 547,970/550,000 at T1 becoming 597,970/600,000 at T2, exactly 110 → 120
    // on a 5,000-per-unit base, with no participant factor to get right. The
    // boss health (first bar) carries the 1%-per-participant scale and backs
    // out the *same* base, so it still identifies the tier when the second bar
    // is absent, at the cost of needing the participant count.
    const combatPoolTarget =
        kind === 'combat' && Number.isFinite(samples[samples.length - 1]?.readings?.[1]?.max)
            ? samples[samples.length - 1].readings[1].max
            : null;
    const fromWorkLadder = !completed
        ? ((combatPoolTarget !== null
              ? tierFromWorkTarget({ target: combatPoolTarget, baseWork: ladderBase, participants: 0, kind })
              : null) ?? tierFromWorkTarget({ target: total, baseWork: ladderBase, participants, kind }))
        : null;

    let tier = null;
    let tierSource = null;
    for (const [candidate, source] of [
        [fromBadge, 'card'],
        [fromSocket, 'socket'],
        [fromWorkLadder, 'work-ladder'],
    ]) {
        if (candidate === null || (tier !== null && candidate <= tier)) continue;
        tier = candidate;
        tierSource = source;
    }
    if (tier === null && assumeFirst && !(Number.isFinite(ladderBase) && Number.isFinite(total))) {
        // The first-tier rule stands down when the work ladder has actively
        // contradicted it: a known base and a target that fits no tier is not
        // a trial provably on tier one, whatever the rule would like to assume
        tier = FIRST_TIER;
        tierSource = 'first-tier-rule';
    }

    // The tier the spectator stream is stating *right now*, if the fight view is
    // open on this encounter. Unlike the persisted `liveTier` — which passes
    // through the staleness gate above because it may be hours old — this is
    // this render's own reading of a stream that is currently flowing, so it
    // cannot be stale: the game is saying, this instant, which tier is being
    // fought. It is applied as a floor (tiers only climb, so it can only raise
    // the count), which is what lets the In Progress fight view state the tier
    // after a refresh without waiting for a Trials-tab visit — the badge on that
    // tab is what the analysis otherwise falls back to, and it lags by a scrape.
    if (!completed && Number.isFinite(liveTierFloor) && (tier === null || liveTierFloor > tier)) {
        tier = liveTierFloor;
        tierSource = 'socket';
    }

    // What it has finished, which is what the payout is about. A trial climbs
    // one tier at a time from the first, so a stated or derived tier in
    // progress banks everything below it — that is how "Banked 2 tiers" is
    // known on a mid-trial join whose cards were never on screen.
    let bankedTiers = badge !== null && earned ? badge : 0;
    if ((tierSource === 'socket' || tierSource === 'work-ladder') && Number.isFinite(tier)) {
        bankedTiers = Math.max(bankedTiers, tier - 1);
    }

    // Everything downstream of the tier — what is banked, what the payout is
    // worth, whether a pace can be walked — is unavailable rather than zero when
    // the tier has not been seen. The In Progress card carries no tier at all,
    // so a player who only ever opens that tab is in this state permanently, and
    // reporting it as "0 banked" is what made a live trial's payout read as
    // nothing at all.
    const tierKnown = Number.isFinite(tier);
    const tiersClearedSoFar = bankedTiers;
    const pointsByTier = record?.pointsByTier && typeof record.pointsByTier === 'object' ? record.pointsByTier : {};

    const base = {
        kind,
        tier,
        tierKnown,
        // Where the tier came from, so a caption can say "assumed" or "derived
        // from the tier's work total" rather than implying the panel stated it
        tierSource,
        completed,
        // The card's own "840 pts", where it has been seen. It is Guild Points
        // rather than base points — see `trialBankedBasePoints` — so the Builders
        // Hall bonus is needed to divide it back down for the token arithmetic
        points: trialBankedBasePoints({
            type: kind,
            bankedTiers: tiersClearedSoFar,
            pointsByTier,
            buildersHallBonus,
            // Live rule since the guild patch: a card may state whole tiers plus a
            // partial one, so read the stated points as such rather than a mismatch.
            allowPartialTier: true,
        }),
        pointsByTier,
        // Set below for a combat trial whose readings straddle a tier clear
        rateNote: null,
        level: Number.isFinite(record?.level) ? record.level : null,
        tiersClearedSoFar,
        rate: null,
        remaining: null,
        total: null,
        etaMs: null,
        growthPerTier: estimateGrowthPerTier(observations),
        next: null,
        pace: null,
        samples: samples.length,
        // The record's tier observations and per-tier personal stats, carried
        // through because the forecast reads them off the analysis. It always
        // did — `analysis.tiers` and `analysis.personalByTier` — and neither
        // field existed, so the skilling forecast walked with no ladder at
        // all: its first step past the current tier found nothing, broke with
        // 'unknown-next-tier', and "On pace for 13 tiers → T13" was a walk of
        // exactly one tier presented as the hour's verdict — on both tabs,
        // because a live forecast suppresses the exact-ladder pace row. The
        // success-decline model starved the same way, silently.
        tiers: observations,
        // …and the personal half of them read for *this* character only. The
        // record is the guild's and shared between alts; the footer's figures
        // are the reader's own, and a decline fitted across two characters'
        // readings is a curve through two different players
        personalByTier: tilePersonalStats(record, characterId).personalByTier,
        // Carried through so the block can tell "no pace because no clock" from
        // "no pace because no rate yet" — they read identically on screen and
        // only one of them is something the player can do anything about
        timeLeftMs: Number.isFinite(timeLeftMs) ? timeLeftMs : null,
    };

    if (index === null) return base;

    const growthPerTier = base.growthPerTier;

    // A combat trial is a ladder of bosses, and its rate is damage rather than
    // movement along one bar: the readings straddle tier clears, where the bar
    // *rises* and the run-of-monotonic-samples fit gives up. See
    // `combatDamageRate` — this is the only reason a combat card ever produced a
    // "Party DPS" of nothing while the party was plainly killing things.
    let rate = null;
    let rateNote = null;
    if (kind === 'combat') {
        const measured = combatDamageRate(
            samples.map((sample) => ({
                t: sample?.t,
                current: sample?.readings?.[index]?.current,
                max: sample?.readings?.[index]?.max,
            })),
            { growthPerTier }
        );
        rate = measured.rate;
        if (measured.multiTier) {
            rateNote =
                'A tier cleared between two readings and the gap may have covered more than one, ' +
                'so the damage counted is a lower bound.';
        } else if (measured.boundaries > 0) {
            rateNote = 'Counted across a tier clear: what was left of the last boss plus what is off this one.';
        }
    } else {
        const series = samples
            .map((sample) => ({ t: sample?.t, value: sample?.readings?.[index]?.current }))
            .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value));
        rate = ratePerMs(series, direction);
    }

    // The bar in hand is the one anchor whose tier label has been through the
    // full rung ladder above, and one anchor is all the exact ladder needs —
    // so when it exists it anchors *alone*. The stored observations' tier
    // labels are inference-quality: a stale badge files the same total under
    // two or three successive tiers (the recorded week holds exactly that),
    // and a misfiled observation that lands on a projected tier outvotes
    // everything through the nearest-anchor rule. Observed live: "Next tier
    // work (T11) 77.3K" under a bar whose own target read 85,600 — a ladder
    // that only climbs, priced downhill by a T9 target filed at T11. The
    // observations still anchor a record with no live bar, which is the case
    // they exist for.
    const liveAnchor = Number.isFinite(tier) && Number.isFinite(total) && total > 0 ? { tier, total } : null;
    const anchors = liveAnchor ? [liveAnchor] : observations;

    // The next tier's size, off the exact ladder first — both kinds' curves are
    // known exactly, so a preview no longer waits for a fit — with the fitted
    // growth kept only as the fallback for a trial neither rule covers
    const exactNext =
        Number.isFinite(tier) && tier + 1 <= TRIAL_MAX_TIER ? exactTierTotal({ kind, anchors, tier: tier + 1 }) : null;
    const next = Number.isFinite(exactNext)
        ? {
              tier: tier + 1,
              level: levelFromTier(tier + 1),
              total: exactNext,
              participantPenalty: participantScale(participants) - 1,
              growthPerTier: null,
          }
        : Number.isFinite(tier)
          ? nextTierPreview({ observations, currentTier: tier, participants })
          : null;

    // The pace walks the same ladder the next-tier row states, so the two can
    // never disagree. The fitted-growth walk this replaces starved with fewer
    // than two observed tiers: it stopped after the tier in hand with
    // `limitedBy: 'unknown-next-tier'`, and "2 banked + the tier in hand" was
    // then presented as a time verdict — a live trial that cleared far past T3
    // had been captioned "On pace for 3 tiers → T3".
    const pace =
        Number.isFinite(tier) && Number.isFinite(remaining) && Number.isFinite(timeLeftMs)
            ? projectPace({
                  currentTier: tier,
                  remainingInTier: remaining,
                  rate,
                  timeLeftMs,
                  totalForTier: (candidate) =>
                      exactTierTotal({ kind, anchors, tier: candidate }) ??
                      projectTierTotal({ observations, tier: candidate, growthPerTier }),
                  tiersAlreadyCleared: base.tiersClearedSoFar,
              })
            : null;

    return { ...base, rate, rateNote, remaining, total, etaMs: etaMs(remaining, rate), next, pace };
}

/**
 * Participants per trial, from the sign-ups the socket reports.
 *
 * The panel does not list who is in a trial, but every guild character carries
 * the hrid they signed up for, and the tracker already keeps those. Only members
 * whose sign-up belongs to the current week are counted — a stale hrid from last
 * week would inflate the 1%-per-head penalty.
 *
 * @param {Object} [tracker] - The XP tracker, injectable for tests
 * @returns {Object<string, number>} trial hrid → participant count
 */
export function participantCounts(tracker = guildXPTracker) {
    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    const counts = {};

    for (const member of tracker?.getMemberList?.() || []) {
        const meta = tracker?.getMemberMeta?.(member.characterID) || member;
        if (currentWeek && meta?.signupWeekStartAt !== currentWeek) continue;
        for (const hrid of [meta?.signedUpSkillingTrialHrid, meta?.signedUpCombatTrialHrid]) {
            if (hrid) counts[hrid] = (counts[hrid] || 0) + 1;
        }
    }

    return counts;
}

/**
 * Whether this character is in a given trial, as far as anything can tell.
 *
 * Three answers, and the third is why this exists. A trial's progress can only
 * ever be measured for a trial the player is *in*: the In Progress tab shows
 * their own trials and nothing else, so no reading will ever arrive for the
 * others. A card for somebody else's trial that says "measuring…" is promising
 * a number that cannot come, and it said so for the whole week.
 *
 * `null` means the sign-up sheet has not been seen — the XP tracker is where
 * that comes from and it can be switched off — and a caller must keep the older,
 * vaguer wording rather than accusing the player of not joining.
 *
 * @param {string} trialName - The card's trial name
 * @param {Object} [options] - Injectables, for tests
 * @param {Object} [options.tracker] - The XP tracker
 * @param {string|number|null} [options.characterId] - This character's id
 * @param {Object} [options.skilling] - The socket's own participant list
 * @returns {boolean|null} In it, not in it, or not knowable
 */
export function ownParticipation(
    trialName,
    { tracker = guildXPTracker, characterId, skilling = guildTrialSkilling } = {}
) {
    const id = characterId ?? dataManager.getCurrentCharacterId?.() ?? null;
    if (id === null || id === undefined) return null;

    // The game's own answer, when it has given one. `guild_skilling_updated`
    // carries `participantIds` — character ids of everyone in the trial — which
    // settles this without a sign-up sheet that may never have been on screen
    const stated = skilling?.participating?.(trialName, id);
    if (stated !== null && stated !== undefined) return stated;

    // The map is keyed by whatever the socket used; an id that arrived as a
    // number and is asked for as a string is the same member
    const meta =
        tracker?.getMemberMeta?.(id) || tracker?.getMemberMeta?.(String(id)) || tracker?.getMemberMeta?.(Number(id));
    if (!meta) return null;

    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    if (currentWeek && meta.signupWeekStartAt && meta.signupWeekStartAt !== currentWeek) return false;

    const hrids = [meta.signedUpSkillingTrialHrid, meta.signedUpCombatTrialHrid].filter(Boolean);
    if (!hrids.length) return false;

    return Boolean(matchTrialHrid(trialName, hrids));
}

/**
 * Who signed up for a trial, by name.
 *
 * The estimated per-player split needs a roster to cover, and a member with no
 * captured build must be *named* as unestimated rather than dropped — a
 * leaderboard that silently omits three people reads as three people who did
 * nothing. The count of these is what `participantCounts` already returns; this
 * is the same walk keeping the names.
 *
 * @param {string} trialName - The card's trial name
 * @param {Object} [tracker] - The XP tracker, injectable for tests
 * @returns {string[]} Member names, in roster order
 */
export function signedUpMembers(trialName, tracker = guildXPTracker) {
    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    const names = [];

    for (const member of tracker?.getMemberList?.() || []) {
        const meta = tracker?.getMemberMeta?.(member.characterID) || member;
        if (currentWeek && meta?.signupWeekStartAt !== currentWeek) continue;

        const hrids = [meta?.signedUpSkillingTrialHrid, meta?.signedUpCombatTrialHrid].filter(Boolean);
        if (!hrids.length || !matchTrialHrid(trialName, hrids)) continue;

        const name = meta?.name || member?.name || null;
        if (name && !names.includes(name)) names.push(name);
    }

    return names;
}

/**
 * A number, or a dash.
 * @param {number|null} value - The number
 * @returns {string} Formatted
 */
function num(value) {
    return Number.isFinite(value) ? formatKMB(Math.round(value)) : '—';
}

/**
 * A rate, kept legible when it is small: whole-guild points tick at fractions
 * of a point per second, and rounding those to an integer printed "~0 pts/s"
 * over an ETA that plainly said otherwise.
 * @param {number|null} value - Units per second
 * @returns {string}
 */
function rateNum(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 10) return formatKMB(Math.round(value));
    return String(Number(value.toFixed(value >= 1 ? 1 : 2)));
}

/**
 * A fraction as a percentage, without trailing noise.
 * @param {number|null} value - A fraction, e.g. 0.02
 * @returns {string} e.g. `2%`
 */
function formatPercent(value) {
    if (!Number.isFinite(value)) return '2%';
    const percent = value * 100;
    return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}

/**
 * A number in full, with thousands separators, or a dash.
 *
 * The payout block uses this and not {@link num}. Everywhere else an
 * abbreviation is the right call — a rate of 5.0K dmg/s is easier to read than
 * 4,981 — but a payout is a figure the player checks against what the guild
 * announces, and "1.3K" cannot be checked against anything.
 *
 * @param {number|null} value - The number
 * @returns {string} Formatted
 */
function exact(value) {
    return Number.isFinite(value) ? formatWithSeparator(Math.round(value)) : '—';
}

/**
 * Longest a value can be before the row stacks instead of sitting in columns.
 *
 * "106 work/s" is a figure and belongs in a column beside its label. Anything
 * much longer is a phrase, and a phrase in the right-hand column of a block
 * beside a 126px card leaves nothing for the label — which produced two
 * successive reported screenshots. First a tall ragged noodle with two words per
 * line; then, after the value was told not to wrap, labels ellipsized past
 * recognition: `C… | 0 tiers → T1 (Lv.100)`, `Ban… | tier not seen yet`.
 *
 * A label cut to one letter is worse than either. So the threshold is low enough
 * that a phrase gets the full width with its label above it, and the label in
 * the column form is allowed to *wrap* rather than being cut — these are two-word
 * labels and two lines of "On pace for" reads perfectly well.
 */
const VALUE_MAX_CHARS = 16;

/**
 * Longest a label can be before its row stacks.
 *
 * "Expected" and "On pace for" fit beside a figure; "Next tier work (T3)" does
 * not, and squeezing it in is what produced a wrapped label with a single
 * letter on the second line.
 */
const LABEL_MAX_CHARS = 12;

/**
 * A row of label and value, or a label with a caption under it.
 *
 * The shape is chosen by the content rather than by the caller, so a row that is
 * usually a figure and occasionally a sentence — "Rate" is `106 work/s` on a
 * trial you are in and a full explanation on one you are not — gets the right
 * layout in both cases without every call site having to think about it.
 *
 * @param {string} label - Left side
 * @param {string} value - Right side, or the caption
 * @param {string} [color] - Value colour
 * @param {string} [title] - Tooltip
 * @returns {string} HTML
 */
function line(label, value, color = '#e8ecf5', title = '') {
    const tip = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
    const text = String(value ?? '');
    // A label that cannot fit its column stacks too. "Next tier work (T3)" has
    // no share of a narrow row worth having, and the alternative is what the
    // screenshots showed: a word broken across lines with an orphan letter
    // under it — "Expecte / d".
    const isSentence = text.length > VALUE_MAX_CHARS || String(label ?? '').length > LABEL_MAX_CHARS;

    if (isSentence) {
        return (
            `<div style="margin:2px 0;"${tip}>` +
            `<div style="color:${DIM};">${label}</div>` +
            `<div style="color:${color}; font-weight:600; line-height:1.45;">${text}</div></div>`
        );
    }

    // Neither side ever breaks mid-word — a figure split from its unit is
    // unreadable, and a label wrapped mid-phrase floats a word between rows:
    // "Party DPS | 737 dmg/s" rendered as "Party  737 dmg/s" over an orphaned
    // "DPS", which was reported. So the label holds one line too, and when the
    // row genuinely cannot fit both, the *whole value* wraps under the label
    // as its own right-aligned line — still a legible pair, never a shuffle.
    return (
        `<div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; ` +
        `gap:2px 8px;"${tip}>` +
        `<span style="color:${DIM}; flex:1 1 auto; overflow-wrap:normal; ` +
        `word-break:normal; hyphens:none; white-space:nowrap;">${label}</span>` +
        `<span style="color:${color}; font-weight:600; text-align:right; white-space:nowrap; ` +
        `flex:0 0 auto; margin-left:auto;">${text}</span></div>`
    );
}

/**
 * A token payout, with what those tokens are approximately worth beside it.
 *
 * Tokens are the whole point of a trial week and a payout of forty thousand of
 * them means nothing without a scale. They have no market price, but the guild
 * shop trades them for credits and credits do have a gold value, so a derived
 * figure exists — and is labelled as derived, because it is a chain of two
 * conversions rather than a price. With no exchange rate and no credit price to
 * be had the caption is left exactly as it was: a bare token count.
 *
 * @param {number} tokens - Tokens paid
 * @param {string} baseTitle - The tooltip the row already had
 * @returns {{value: string, title: string}} Row value and tooltip
 */
export function tokenPayoutLine(tokens, baseTitle, { showGold = true } = {}) {
    // Exact, on both halves. This block's arithmetic reproduces the guild's own
    // announcement to the token — "1,320 tokens each" — and printing it as
    // "1.3K" throws away the only thing that makes it worth checking.
    const gold = showGold ? describeGuildTokenGold(tokens, 'ask', { exact: true }) : null;
    const count = exact(tokens);
    return {
        value: gold ? `${count} (${gold.text})` : count,
        title: gold ? `${baseTitle} ${gold.title}` : baseTitle,
    };
}

/**
 * Where the tier figure came from, as a caption sentence.
 *
 * The tier drives everything on the block — the pace, the ladder, the banked
 * count — and three of its four sources are inference rather than something the
 * game wrote on this card. A caption that implies the panel stated it is
 * claiming more than is known, so each rung says what it is.
 *
 * @param {Object} analysis - From {@link analyseTrial}
 * @returns {string} A sentence to append to a tooltip, or an empty string
 */
function tierProvenance(analysis) {
    if (analysis.tierSource === 'work-ladder') {
        if (analysis.kind === 'combat') {
            return (
                ' The tier is derived from the boss’s full health: the health bar’s maximum ' +
                'uniquely identifies the tier once the encounter’s base health is known, and ' +
                'this encounter’s has been learned from an earlier reading.'
            );
        }
        return (
            ' The tier is derived from the tier’s work total: the bar’s target uniquely ' +
            'identifies the tier once the skill’s base work is known, and this skill’s has ' +
            'been learned from an earlier reading.'
        );
    }
    if (analysis.tierSource === 'socket') {
        return ' The tier was stated outright by the game’s own trial update on the socket.';
    }
    if (analysis.tierSource === 'first-tier-rule') {
        return ' The tier is assumed: every trial starts at tier 1, and nothing has said otherwise.';
    }
    return '';
}

/**
 * What the trial has banked, as one row.
 *
 * Pulled out because all three phases want it and nothing else about them is
 * the same: it is the one figure that means what it says whether the trial has
 * not started, is running, or is over.
 *
 * @param {Object} analysis - From {@link analyseTrial}
 * @returns {string} HTML
 */
function bankedRow(analysis) {
    // A trial that ended on nothing is an outcome, not a reading that has not
    // arrived — and it is answered before "tier not seen yet", because a card
    // that wiped on tier one carries no badge either. Reported from exactly
    // that: the Hedgehog party fell before clearing the first tier, so its card
    // read Completed with no points and no badge, and this said "nothing yet —
    // tier 1 in progress" underneath it
    if (analysis.completed && !analysis.tiersClearedSoFar) {
        return line(
            'Banked',
            '0 tiers — fell before tier 1',
            DIM,
            'This trial is over and its card states no points, so nothing was banked: the party did not ' +
                'finish the first tier. Zero here is a result rather than a figure still to arrive.'
        );
    }

    if (!analysis.tierKnown) {
        return line(
            'Banked',
            'tier not seen yet',
            DIM,
            'Tiers cleared are read off the tier on screen, and the In Progress card carries no tier. ' +
                'Open the Trials tab beside it once — the tier is on the card there, and everything banked ' +
                'follows from it. Nothing is lost meanwhile; this is what is not yet known, not zero.'
        );
    }

    if (analysis.tiersClearedSoFar === 0) {
        return line(
            'Banked',
            `nothing yet · tier ${analysis.tier}`,
            DIM,
            'A trial starts at tier 1, so nothing is banked until the first tier completes.' + tierProvenance(analysis)
        );
    }

    return line(
        'Banked',
        `${analysis.tiersClearedSoFar} tier${analysis.tiersClearedSoFar === 1 ? '' : 's'}` +
            (analysis.completed ? ' · finished' : ''),
        DIM,
        analysis.completed
            ? 'This trial is over, so the tier on the card is the tier it reached — and the points it ' +
                  'states are the ladder’s total for exactly that many tiers, which is what makes this ' +
                  'figure exact rather than inferred.'
            : analysis.tierSource === 'card'
              ? 'The tier on the card counts what this trial has *finished* — it read T1 after the first ' +
                'tier cleared and T2 after the second, while the pool on screen was the next one along. ' +
                'So the tier being fought is one past the badge.'
              : 'A trial climbs one tier at a time from the first, so everything below the tier in ' +
                'progress is banked.' +
                tierProvenance(analysis)
    );
}

/**
 * The block drawn under one trial tile.
 * @param {Object} analysis - From {@link analyseTrial}
 * @param {number} participants - Signed-up participants
 * @param {Object} [breakdown] - Per-player damage, from `guildTrialDamage.breakdown()`
 * ## One row set per phase
 *
 * The three states of a trial are not one layout with rows switched off. A card
 * whose trial has not started has one thing to say; a card whose trial is over
 * has results and no process; only a running trial wants the projections. Drawn
 * as a single set with per-row guards, the screen filled with variations of
 * nothing — a scheduled card stacked "scheduled — nothing running yet" over
 * "tier not seen yet" over "no trial fight seen here", and a finished one
 * offered to fit a growth curve for a next tier that will never be fought.
 *
 * So the phase picks the row set, and the participation rule composes with it:
 * a trial this character did not join, once it is over, shows the facts the
 * Trials tab states about it and no rows about data that can no longer arrive.
 *
 * @param {Object} [options] - Context
 * @param {boolean|null} [options.participating] - Whether this character is in this trial
 * @param {string|null} [options.phase] - `scheduled`, `live` or `completed`
 * @param {number|null} [options.startsInMs] - Countdown to the scheduled start
 * @param {Object|null} [options.forecast] - From `guild-trial-forecast.js`
 * @param {number|null} [options.deadlineMs] - Milliseconds of the trial's hour left, from
 *   the guild payload's own countdown rather than from a clock on the page
 * @returns {string} HTML
 */
export function renderTrialBlock(
    analysis,
    participants,
    breakdown = guildTrialDamage.breakdown(),
    {
        participating = null,
        phase = null,
        startsInMs = null,
        forecast = null,
        looseForecast = null,
        deadlineMs = null,
    } = {}
) {
    const unit = analysis.kind === 'combat' ? 'dmg' : 'work';
    const rows = [];

    // T21 is the last trial tier the game has, so a trial that has banked it can
    // never reach another one and every next-tier estimate under it is about a
    // tier that does not exist. The card in the report read "Next tier in ~a few
    // seconds", "Before it ends ~0 more tiers" and "Expected ~T21" all at once,
    // which is three ways of saying nothing.
    //
    // The banked count is what settles it rather than `analysis.tier`: the tier
    // being *fought* is one past the badge, so a trial finished with the ladder
    // reports tier 22 — a number no rung of the ladder can mean — while "banked
    // 21" is the plain fact. A trial still fighting T21 has banked 20 and keeps
    // every row: reaching the top of the ladder is a real forecast.
    const atFinalTier =
        analysis.tiersClearedSoFar >= TRIAL_MAX_TIER ||
        looseForecast?.atFinalTier === true ||
        forecast?.atFinalTier === true;
    const finalTierRow = () =>
        line(
            'Final tier',
            `T${TRIAL_MAX_TIER} — nothing above it`,
            GOOD,
            `The ladder ends at T${TRIAL_MAX_TIER} (Lv.${TRIAL_MAX_LEVEL}) and this trial has cleared it, so ` +
                'there is no next tier to time, none left to fit in the hour, and nothing further to expect. ' +
                'What it banked stands below.'
        );

    // Nothing has started. One line, the countdown the header already states —
    // and the one number that CAN be said in advance: a combat trial opens on
    // tier 1 with the whole hour ahead, so the captured loadouts price a rough
    // projection before anything is measured.
    if (phase === 'scheduled') {
        const when = Number.isFinite(startsInMs) && startsInMs > 0 ? ` — starts in ${formatEta(startsInMs)}` : '';
        const scheduledRows = [
            line(
                'Trial',
                `scheduled${when}`,
                DIM,
                'The guild panel says this cycle has not started. Nothing is measured until it does, and ' +
                    'anything this script already holds belongs to the previous cycle.'
            ),
        ];
        if (forecast && forecast.tier !== null) {
            scheduledRows.push(
                line(
                    'If it started now',
                    `~T${forecast.tiersCleared}${Number.isFinite(forecast.enragedFrom) ? ' · fully enraged' : ''}`,
                    WARN,
                    'Walked from tier 1 over a full hour, at the party damage estimated from the loadouts ' +
                        'captured so far' +
                        (forecast.coverage ? ` (${forecast.coverage.known} of ${forecast.coverage.of} members)` : '') +
                        ' — a rough shape before anything is measured, priced from the game’s own tier data.'
                )
            );
        }
        return scheduledRows.join('');
    }

    // Over. Results only: what it reached, what that is worth, and the rate it
    // ran at if one was ever measured. No next tier, no pace, no waiting.
    if (phase === 'completed') {
        if (Number.isFinite(analysis.rate)) {
            rows.push(
                line(
                    analysis.kind === 'combat' ? 'Final party DPS' : 'Final fill rate',
                    `${num(analysis.rate * 1000)}\u00a0${unit}/s`,
                    DIM,
                    'The last rate measured while this trial ran. It is not a live figure.'
                )
            );
        }
        rows.push(bankedRow(analysis));
        return rows.join('');
    }

    // A trial this character did not join sends nothing: the In Progress tab
    // carries only their own trials, so no reading for this card will ever
    // arrive. Saying "measuring…" there promises a number that cannot come.
    const notMine = participating === false && !Number.isFinite(analysis.rate);

    if (notMine) {
        // A trial you did not join has exactly one measurable signal: the times
        // its tier badges were watched changing. The stated points cannot be
        // one — they are a step function, flat between tiers and jumping at
        // each, so the points-per-second this used to print was a regression
        // over a staircase. See `guild-trial-tier-timing.js`.
        const loose = looseForecast;
        if (loose && Number.isFinite(loose.sharePerMs)) {
            const falling = Number.isFinite(loose.declinePerTier)
                ? ` (falling ~${Math.abs(loose.declinePerTier * 100).toFixed(0)}%/tier)`
                : '';
            if (Number.isFinite(loose.workPerSecond)) {
                rows.push(
                    line(
                        'Est. fill',
                        `~${rateNum(loose.workPerSecond)}\u00a0${unit}/s${falling}`,
                        ACCENT,
                        'The whole guild’s work rate on this trial, measured from how long they took to fill ' +
                            `the last tier${loose.intervals > 1 ? 's' : ''} — the pool a tier needs is derived ` +
                            'exactly, and the gap between two tier badges is watched. Not your own ' +
                            'contribution, and not a bar reading: the live per-second bar only ever streams ' +
                            'for the trials you joined.' +
                            (falling
                                ? '\nThe rate falls as the tiers climb because every participant’s success ' +
                                  'rate does, fitted across the tiers timed so far.'
                                : '')
                    )
                );
            }
            if (!atFinalTier && Number.isFinite(loose.etaMsToNextTier)) {
                rows.push(
                    line(
                        'Next tier in',
                        `~${formatEta(loose.etaMsToNextTier)}`,
                        GOOD,
                        `What is left of T${loose.currentTier}’s pool at the rate projected for T` +
                            `${loose.currentTier}. The pool is derived — each tier adds a tenth of the first ` +
                            'tier’s work — and how much of it is already done is the time since the badge ' +
                            'moved, spent at that rate.'
                    )
                );
            }
            if (!atFinalTier && Number.isFinite(loose.tiersBeforeEnd)) {
                rows.push(
                    line(
                        'Before it ends',
                        `~${loose.tiersBeforeEnd} more tier${loose.tiersBeforeEnd === 1 ? '' : 's'}`,
                        DIM,
                        'Walked one tier at a time for the rest of the hour, each priced at its own projected ' +
                            'rate — not a time divided by a flat one. A tier only counts when it fits whole.'
                    )
                );
            }
        } else {
            rows.push(
                line(
                    'Rate',
                    loose?.reason || 'only trials you join',
                    DIM,
                    'The live per-second bar only ever streams for the trials this character joined, so no ' +
                        'measured rate arrives for the others. What can be measured instead is how long the ' +
                        'guild takes to clear a tier — so this waits until two tier badges have been watched ' +
                        'appearing while the tab was open. A card’s first sighting does not count: it says ' +
                        'nothing about when that tier actually banked.\nIts tier, points and sign-ups are ' +
                        'read and shown below regardless.'
                )
            );
        }
    } else if (!Number.isFinite(analysis.rate)) {
        rows.push(line('Rate', analysis.samples < 2 ? 'measuring…' : 'no movement yet', DIM));
    } else {
        const perSecond = analysis.rate * 1000;
        const measuredFrom =
            analysis.kind === 'combat'
                ? 'Measured from the boss bar on this card — the health one; the second bar is its mana.'
                : 'Measured from the bar on this card, over its current tier only.';
        rows.push(
            line(
                analysis.kind === 'combat' ? 'Party DPS' : 'Fill rate',
                `${num(perSecond)}\u00a0${unit}/s`,
                ACCENT,
                analysis.rateNote ? `${measuredFrom}\n${analysis.rateNote}` : measuredFrom
            )
        );

        // Two independent measurements of the same party: this one off the card's
        // bar, and `guild-trial-damage.js`' off the battle feed. They should
        // agree, and where they do not this says which of them to believe —
        // which used to be left to the reader, over a caption implying the split
        // was the doubtful one. It is not. Replayed against a traced hour of
        // Trial Swarm, the split totalled 0.015% off the game's own end-of-trial
        // figures (0.7% median per player) while the bar reading ran 2.4x over,
        // for the reason in `_readPool`.
        const attributed = breakdown?.measured ? breakdown.partyDps : null;
        if (Number.isFinite(attributed) && attributed > 0 && perSecond > 0) {
            const ratio = perSecond / attributed;
            if (ratio > 1.4 || ratio < 1 / 1.4) {
                rows.push(
                    line(
                        'Split disagrees',
                        `${num(attributed)}\u00a0${unit}/s`,
                        WARN,
                        'The per-player split adds up to a different party DPS than the bar does, and the ' +
                            'split is the one to believe: it is the fight itself, tick by tick, and replayed ' +
                            'against a whole trial it landed within 0.015% of the game’s own end-of-trial ' +
                            'totals.\nThe bar reading is the tier pool sampled every five seconds, and it ' +
                            'counts a boss cleared whenever the pool jumps — so a wave that dies and ' +
                            'respawns between two samples, or a stretch where nothing was sampled at all, ' +
                            'moves it and not the split.\nThe split is also only what this client watched: ' +
                            'it counts nothing from the time the fight view was shut, where the bar spans ' +
                            'that gap regardless.'
                    )
                );
            }
        }
        rows.push(
            line(
                analysis.kind === 'combat' ? 'Kill in' : 'Tier clears in',
                analysis.etaMs === null ? '—' : formatEta(analysis.etaMs),
                GOOD,
                `${formatWithSeparator(Math.round(analysis.remaining || 0))} of ${formatWithSeparator(
                    Math.round(analysis.total || 0)
                )} left.`
            )
        );

        // The other half of "clears in 17m": whether there is still 17 minutes
        // to clear it in. The countdown is the guild's own — it rides on
        // `guild_updated` and needs no clock on the page — and set beside the
        // projection it turns an estimate into a verdict.
        if (Number.isFinite(deadlineMs)) {
            const tight = analysis.etaMs !== null && analysis.etaMs > deadlineMs;
            rows.push(
                line(
                    'Deadline',
                    formatEta(deadlineMs),
                    tight ? WARN : DIM,
                    'Left of the trial’s hour, from the guild’s own countdown rather than from a clock on ' +
                        'this tab.' +
                        (tight ? ' The projection above runs past it: this tier does not clear in time.' : '')
                )
            );
        }
    }

    if (!analysis.pace && !notMine) {
        // Silently omitting the row was indistinguishable from the feature not
        // having this idea at all — and the no-clock case was the only one that
        // said so. A pace needs four things and going quiet about the other
        // three read as the same broken row.
        const missing =
            analysis.timeLeftMs === null
                ? {
                      text: 'no clock visible',
                      why:
                          'A pace needs the time left in the trial, and no countdown was found on this tab. ' +
                          'The game draws one while a trial is in progress — open the trial tab while it is running.',
                  }
                : !analysis.tierKnown
                  ? {
                        text: 'tier not known yet',
                        why:
                            'A pace walks up the tier ladder, and the In Progress card does not say which tier ' +
                            'this is. Open the Trials tab beside it once; the tier is on the card there.',
                    }
                  : !Number.isFinite(analysis.rate)
                    ? {
                          text: analysis.samples < 2 ? 'measuring…' : 'no movement yet',
                          why:
                              'A pace needs a measured rate, and a rate needs two readings taken while the tab ' +
                              'is open. Nothing arrives while it is shut.',
                      }
                    : { text: '—', why: 'Not enough of the tier is known to project one.' };

        rows.push(line('On pace for', missing.text, DIM, missing.why));
    }

    // One prediction, unless there are genuinely two things to say.
    //
    // "On pace for 4 tiers → T4" beside "Expected ~T3" is two bare numbers
    // disagreeing, and a reader cannot tell which to believe. They are the same
    // walk up the same derived ladder; the only thing that separates them is
    // whether the player's own success rate falling with each tier has been
    // measured yet. So: no measured slowdown, one row. A measured slowdown, two
    // rows that each say what they assume — and the second being lower is then
    // the point rather than a contradiction.
    const slowdown = Number.isFinite(forecast?.decline?.perTier) ? forecast.decline : null;
    // The count and the target are the same fact stated twice, so they are
    // derived from one number. They used to be computed separately — the count
    // from the tiers banked plus those the walk completed, the target from the
    // walk's last clear *or, when it completed none, the tier being fought* —
    // and at a tier boundary that reads "on pace for 4 tiers → T5", which is
    // two different claims in one sentence. A tier the walk enters and cannot
    // finish is not a tier, and must not move the target.
    const paceCaption = () => {
        const projected = analysis.pace.tiersCleared;
        const level = levelFromTier(projected);
        const tiers = `${projected} tier${projected === 1 ? '' : 's'}`;
        const target = projected ? ` → T${projected}${level ? ` (Lv.${level})` : ''}` : '';

        // A walk cut short by an unknown ladder is a floor, never a verdict: it
        // used to render "3 tiers → T3" for a walk that had merely run out of
        // ladder to climb, and the trial then cleared far past T3
        if (analysis.pace.limitedBy === 'unknown-next-tier') return `at least ${tiers}${target}`;
        // Nothing finished is nothing to point at
        if (!projected) return tiers;
        return `${tiers}${target}`;
    };

    // The flat projection is the current rate held for the whole hour. Once a
    // slowdown has been measured, that flat number is a fiction the panel used to
    // print in green beside the real one — "21 tiers → T21" next to "~T11" — and a
    // reader cannot tell it is the one to ignore. So it is shown only when there is
    // no measured slowdown to replace it; when there is, the Expected row stands
    // alone and the flat walk lives on in its tooltip.
    if (analysis.pace && !slowdown && (!forecast || forecast.tier === null)) {
        rows.push(
            line(
                'On pace for',
                paceCaption(),
                analysis.pace.limitedBy === 'ladder' ? GOOD : WARN,
                'The rate measured now, held flat for the rest of the hour. A tier only counts when it fits ' +
                    'whole.' +
                    (analysis.pace.limitedBy === 'unknown-next-tier'
                        ? '\nThe ladder past that tier is not known yet, so the walk stopped there — “at ' +
                          'least”, because the real pace may be higher.'
                        : '')
            )
        );
    }

    if (atFinalTier) {
        rows.push(finalTierRow());
    } else if (forecast && forecast.tier !== null) {
        // Enrage is escalation, not an ending: the boss gains a stack a minute
        // to ten, each +10% accuracy and +10% damage, and then stops. A tier
        // that takes that long is dangerous rather than impossible, and what the
        // projection cannot model is the deaths it may cost.
        const margin = Number.isFinite(forecast.enragedFrom) ? ' · fully enraged' : '';
        const cleared = forecast.tiersCleared;
        // A trial you did not join is projected from its tier-clear timings
        // rather than from a bar nobody here can see, and it always states an
        // expected tier: a walk that has measured the guild's own decline is
        // not the flat-rate pace this row otherwise contrasts against.
        const timing = forecast.source === 'tier-timing';
        // The flat comparison only exists where a pace was walked, and a pace
        // needs a live bar. An unjoined card has none, and reaching for it
        // unguarded is what turned a restored Expected row into a thrown render.
        const flat = analysis.pace ? analysis.pace.tiersCleared : null;
        rows.push(
            line(
                slowdown || timing ? 'Expected' : 'On pace for',
                slowdown || timing
                    ? `~T${cleared}${margin}`
                    : `${cleared} tier${cleared === 1 ? '' : 's'}${cleared ? ` → T${cleared}` : ''}${margin}`,
                forecast.source === 'estimated' ? WARN : GOOD,
                timing
                    ? 'Walked from the work each tier actually needs — each adds a tenth of the first tier’s ' +
                          '— at the rate this guild is measured to be filling them, taken from the ' +
                          `${forecast.measured} tier badges watched appearing on this card.` +
                          (forecast.decline
                              ? `\nThe rate falls about ${Math.abs(forecast.decline.perTier * 100).toFixed(0)}% ` +
                                'a tier as every participant’s success rate does, fitted across the ' +
                                `${forecast.decline.observations} tiers timed so far. It stops falling at ` +
                                `T${TRIAL_MAX_TIER}, where the trial level caps and nobody’s success rate drops ` +
                                'any further.'
                              : '\nOne tier has been timed, so the rate is held flat — a second timed tier ' +
                                'is what turns a reading into a trend.') +
                          '\nThe whole guild’s pace, not your own contribution.'
                    : forecast.source === 'measured'
                      ? 'Walked from the work or health each tier actually needs — derived from the game’s own ' +
                        'data and rules, not fitted — at the rate this party is measured to be producing.' +
                        (slowdown
                            ? `\nAssumes your success rate keeps falling about ${Math.abs(
                                  slowdown.perTier * 100
                              ).toFixed(1)} points a tier to its 5% floor, as measured across ` +
                              `${slowdown.observations} tiers. Past that point a tier is slow rather than ` +
                              'impossible.' +
                              (Number.isFinite(flat)
                                  ? '\nThe same rate held flat, ignoring the slowdown, would reach ' +
                                    `T${flat} — which is why that flatter number is not shown as the estimate.`
                                  : '')
                            : '') +
                        (Number.isFinite(forecast.enragedFrom)
                            ? `\nA fight this long reaches full enrage from T${forecast.enragedFrom}: the ` +
                              'boss gains a stack a minute to ten, ending at +100% damage and +100% ' +
                              'accuracy. Still killable — but expect deaths to slow this beyond the ' +
                              'projection.'
                            : '')
                      : 'Estimated from the loadouts captured so far' +
                        (forecast.coverage ? ` (${forecast.coverage.known} of ${forecast.coverage.of} members)` : '') +
                        ' — a rough shape rather than a measurement, until the party’s own damage has been seen.'
            )
        );
    } else if (forecast?.reason) {
        rows.push(line('Expected', 'not projectable', DIM, `${forecast.reason}.`));
    }

    if (atFinalTier) {
        // Nothing: the final-tier line above already said why there is no next
        // tier, and a size for one would be the same claim contradicted
    } else if (analysis.next) {
        const label = analysis.kind === 'combat' ? 'Next tier HP' : 'Next tier work';
        rows.push(
            line(
                `${label} (T${analysis.next.tier})`,
                num(analysis.next.total),
                DIM,
                (analysis.next.growthPerTier
                    ? `Fitted from the tiers seen this week (×${analysis.next.growthPerTier.toFixed(2)} per tier). `
                    : analysis.kind === 'combat'
                      ? 'Derived: boss health scales with the tier’s level, a rule the recorded tiers ' +
                        'reproduce exactly, anchored on the total this trial has actually shown. '
                      : 'Derived: each tier adds a tenth of the first tier’s work, which is what the pools ' +
                        'observed on a live trial do exactly, anchored on the total this trial has shown. ') +
                    `${participants} participant${participants === 1 ? '' : 's'} already add ` +
                    `+${Math.round(analysis.next.participantPenalty * 100)}% to it.`
            )
        );
    } else if (Number.isFinite(analysis.tier) && analysis.tier < TRIAL_MAX_TIER) {
        rows.push(line('Next tier', 'awaits a full tier', DIM));
    }

    rows.push(bankedRow(analysis));

    return rows.join('');
}

/**
 * The damage breakdown as one tile may wear it.
 *
 * There is one measurement and, on a two-combat week, two combat cards — and
 * the whole breakdown used to land on both: Trial Hedgehog's panel showed
 * "Per player · 2 fights · watched" with the Chameleon fight's exact rows,
 * on a card reading "0 pts, not started". The measurement names the encounter
 * it watched, so a tile of any other encounter — or a skilling tile, whose
 * fill rate must never be compared against a fight's DPS — wears a scoped-out
 * copy: the identity facts stay, the measured figures and rows do not, and
 * the empty state says whose fight is actually being watched.
 *
 * A breakdown with no encounter of its own is passed through untouched: it
 * has not been identified yet, and "click the boss to identify" is already the
 * honest caption for that.
 *
 * @param {string} name - The tile's trial name
 * @param {Object} [breakdown] - From `guildTrialDamage.breakdown()`
 * @returns {Object} The breakdown this tile may show
 */
export function breakdownFor(name, breakdown = guildTrialDamage.breakdown()) {
    if (!breakdown || !breakdown.encounter) return breakdown;

    const encounter = encounterOf(name);
    if (encounter === breakdown.encounter) return breakdown;

    return {
        ...breakdown,
        measured: false,
        measuredSupport: false,
        players: [],
        totalDamage: 0,
        partyDps: null,
        pool: null,
        source: null,
        stale: false,
        support: { ...(breakdown.support || {}), players: [] },
        reason:
            `the watched fight is ${breakdown.bossName || breakdown.encounter}’s — ` +
            'no fights watched for this encounter',
    };
}

/**
 * Who in the party is producing the DPS the card is already showing.
 *
 * No longer drawn under the boss card itself — `renderTrialBlock` used to
 * append these rows under Party DPS / Kill in / On pace / Banked, but a
 * forty-eight-player trial turned that column into a scrolling player list
 * where the block was supposed to be a compact summary, and the per-player
 * detail already has a home of its own: the "Per-player" button opens
 * `guild-trial-scoreboard.js`'s dedicated view. Kept here, tested and
 * exported, as the narrow-column row format for wherever this compact form
 * is wanted again.
 *
 * Fed by the spectator stream: opening the In Progress fight view subscribes
 * this client to the trial's own battle ticks (`guild-trial-damage.js`). So
 * the empty state is an instruction rather than an apology — "open the fight
 * view", not "no trial fight seen here", which reads as a fight that could
 * have been seen and was not and was twice reported as a bug.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @returns {string[]} Rows of HTML, empty when there is nothing worth a row
 */
export function renderTrialPlayers(breakdown) {
    if (!breakdown) return [];

    if (!breakdown.measured) {
        // Four different nothings, and a player can act on three of them
        const watched = breakdown.source === 'spectated';
        // A fight is streaming and nothing has said which trial it is, so no
        // card may claim it. One click on the boss settles that
        const unidentified = watched && !breakdown.pool?.encounter;

        let value = 'open the fight view';
        if (breakdown.stale) value = 'last trial, not this one';
        else if (unidentified) value = 'click the boss to identify';
        else if (watched) value = 'watched, nothing attributed yet';

        let why =
            `${breakdown.reason}.\nOpen the In Progress fight view and this fills from the trial's own ` +
            'battle ticks. Until then the scoreboard estimates the split from the members\u2019 captured ' +
            'builds, and says so.';
        if (unidentified) {
            why =
                'A trial fight is being watched, but nothing has said which trial it is — the fight ' +
                'view\u2019s boss tile could not be read. Click the boss once and its figures attach to the ' +
                'right card. Until then they attach to none, rather than to every combat card that has no ' +
                'bar of its own.';
        } else if (watched) {
            why =
                'The fight is streaming but no damage tick has been attributed yet — the per-player split ' +
                'fills in as hits land on the boss. Damage taken, healing and mana come through the same ' +
                'ticks and are on the scoreboard.';
        }

        // A line rather than silence: an empty space under a combat card is
        // indistinguishable from the split having failed
        return [line('Per player', value, DIM, why)];
    }

    // How much of the party these rows actually cover. A spectated split names
    // its attacker by presence, so a member who never had a tick of their own
    // earns no row — three names at 100% under a party of seven is honest but
    // partial, and a header that says "3 of 7" is the difference between that
    // and a claim the party is three people
    const coverage = attributionCoverage(breakdown);
    const rows = [
        `<div style="margin-top:4px; color:${ACCENT}; font-weight:600;">` +
            `Per player · ${breakdown.fights} fight${breakdown.fights === 1 ? '' : 's'}` +
            `${coverage.partial ? ` · ${coverage.attributed} of ${coverage.party}` : ''}` +
            `${breakdown.source === 'spectated' ? ' · watched' : ''}</div>`,
    ];
    if (coverage.partial) {
        rows.push(
            `<div style="color:${DIM}; font-size:9px; line-height:1.4;" title="A spectated split names its ` +
                `attacker by which lone player changed on a tick the boss lost health; the other ` +
                `${coverage.party - coverage.attributed} of ${coverage.party} never had such a tick this window. ` +
                `Shares are of the attributed damage, and the party rate is a lower bound — the rest fill in as ` +
                `their hits land alone on the boss.">shares of the ${coverage.attributed} attributed; ` +
                `${coverage.party - coverage.attributed} not yet split out</div>`
        );
    }

    for (const player of breakdown.players) {
        const share = Number.isFinite(player.share) ? `${player.share.toFixed(0)}%` : '—';
        // No unit on the figure: the header names what this list is, the
        // tooltip has it in full, and in a 108px fight-view cell every saved
        // pixel is name — "B… 1.5K dmg/s · 36%" was the reported result of
        // spending them on a unit
        const dps = player.dps === null ? 'measuring…' : `${num(player.dps)}/s`;
        const deaths = player.deaths > 0 ? ` · ${player.deaths}✝` : '';

        rows.push(
            playerRow(
                player.name,
                `${dps} · ${share}${deaths}`,
                player.deaths > 0 ? WARN : GOOD,
                `${formatWithSeparator(Math.round(player.damage))} damage across ` +
                    `${formatWithSeparator(player.hits)} hits.\n` +
                    `Hit rate ${player.accuracy === null ? '—' : `${(player.accuracy * 100).toFixed(1)}%`}, ` +
                    `crit rate ${player.critRate === null ? '—' : `${(player.critRate * 100).toFixed(1)}%`}, ` +
                    `${player.deaths} death${player.deaths === 1 ? '' : 's'}.`
            )
        );
    }

    return rows;
}

/**
 * One player's row: name left, figures right, always one line.
 *
 * Not {@link line}, on purpose. That helper stacks a long *label* into a
 * full-width caption, which is right for "Next tier work (T3)" and wrong for a
 * roster: "MillenniumTest" is fourteen characters, so its figures dropped onto
 * a second line while "Orven" beside it kept one, and the list read as a
 * ragged mix of one- and two-line entries. And the column can be genuinely
 * tiny — the fight-view injection lands in a 108px grid cell — so the row is a
 * size down from the block and the name ellipsizes as tightly as it must. A
 * cut name is acceptable here and nowhere else: the tooltip opens with the
 * full name, and the figures are what the row is for.
 *
 * @param {string} name - The player
 * @param {string} value - Their figures
 * @param {string} color - Value colour
 * @param {string} title - Tooltip; the full name is prepended, for when the row cuts it
 * @returns {string} HTML
 */
function playerRow(name, value, color, title) {
    const full = `${name} — ${title}`;
    return (
        `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:4px; ` +
        `font-size:10px;" title="${full.replace(/"/g, '&quot;')}">` +
        `<span style="color:${DIM}; flex:1 1 auto; min-width:5ch; overflow:hidden; text-overflow:ellipsis; ` +
        `white-space:nowrap;">${name}</span>` +
        `<span style="color:${color}; font-weight:600; text-align:right; white-space:nowrap; ` +
        `flex:0 0 auto;">${value}</span></div>`
    );
}

/**
 * The recorded session's final per-player readings, as rows.
 *
 * The live per-player split dies with the fight view — the game tears the
 * battle down the moment the trial ends — but the recorder keeps thinned
 * snapshots of the same breakdown every fifteen seconds, persisted across
 * reloads, and the last snapshot is the final reading. Shares are recomputed
 * from the snapshot's own damage totals so the rows can never disagree with
 * themselves; a player the snapshot credits with nothing gets no row, because
 * a zero here would be a claim rather than an absence.
 *
 * Pure, and exported for tests: it takes a snapshot and returns markup, and
 * never touches the recorder, the clock or storage.
 *
 * @param {Object|null} snapshot - A `thinBreakdown` snapshot from the recorder
 * @returns {string[]} Rows of HTML; empty when nothing persisted is worth a row
 */
export function lastTrialPlayerRows(snapshot) {
    const players = Array.isArray(snapshot?.players)
        ? snapshot.players.filter((player) => Number(player?.damage) > 0 || Number(player?.deaths) > 0)
        : [];
    if (!players.length) return [];

    const total = players.reduce((sum, player) => sum + (Number(player.damage) || 0), 0);
    const seconds = Number(snapshot.seconds);
    const rows = [
        `<div style="margin-top:4px; color:${ACCENT}; font-weight:600;" title="The recorded session’s final ` +
            `per-player split — the last snapshot the trial recorder kept before the fight was torn down. ` +
            `Shares are of the damage the snapshot itself attributes.">Per player · final</div>`,
    ];

    for (const player of [...players].sort((a, b) => (Number(b.damage) || 0) - (Number(a.damage) || 0))) {
        const damage = Number(player.damage) || 0;
        const share = total > 0 ? `${((damage / total) * 100).toFixed(0)}%` : '—';
        const dps = seconds > 0 ? `${num(damage / seconds)}/s` : num(damage);
        const deaths = player.deaths > 0 ? ` · ${player.deaths}✝` : '';
        rows.push(
            playerRow(
                player.name,
                `${dps} · ${share}${deaths}`,
                player.deaths > 0 ? WARN : GOOD,
                `${formatWithSeparator(Math.round(damage))} damage across the recorded session, ` +
                    `${player.deaths || 0} death${player.deaths === 1 ? '' : 's'}. A final reading, not a live one.`
            )
        );
    }

    return rows;
}

/**
 * The one card a kind-wide footer can belong to, or nothing.
 *
 * The In Progress tab draws the player's own action stats once, in a footer,
 * with no statement of which card they are about. A bar answers it when there is
 * one; failing that the header's kind narrows it, and only a *single* match may
 * be taken — two skilling cards and a skilling header is an ambiguity, and
 * putting one trial's success rate on another's row is worse than losing it.
 *
 * @param {Array<Object>} tiles - Cards from `readTrialTiles`
 * @param {string|null} kind - From `readTrialStatus`
 * @returns {Object|null} The card, or null when it cannot be said
 */
export function soleTileOfKind(tiles, kind) {
    if (!kind) return tiles?.length === 1 ? tiles[0] : null;

    const matching = (tiles || []).filter((tile) => tile.kind === kind);
    return matching.length === 1 ? matching[0] : null;
}

/**
 * Fold the cards of a multi-enemy wave into a single tile.
 *
 * A guild combat wave can put several enemy cards on screen that share a name —
 * two "Trial Badger"s, each with its own health bar — and they are one encounter
 * with one HP pool to clear. Keyed by name (`tileKey` is kind + name), they
 * otherwise collide: `recordTileSample` drops all but the card sampled last, so
 * the clear is priced off one bar while the forecast's own wave total — summed
 * across the wave's monsters from client data — describes both. The two halves
 * disagree, and the current tier reads at roughly 1/N of its real HP.
 *
 * Summing the bar readings position-wise across same-key cards (index 0 is the
 * health bar the clear is measured from) makes the *measured* remaining and rate
 * describe the whole wave, so they line up with the forecast's summed base HP and
 * every figure downstream — kill time, tier pace, party DPS — is a wave figure.
 *
 * Same-key cards only ever appear together on the live wave; the Trials tab shows
 * one setup card per trial, so this is a no-op there.
 *
 * @param {Array<Object>} tiles - Cards from `readTrialTiles`
 * @returns {Array<Object>} One tile per wave, its readings summed across its cards
 */
export function mergeWaveTiles(tiles) {
    if (!Array.isArray(tiles) || tiles.length < 2) return tiles || [];

    const groups = new Map();
    const order = [];
    for (const tile of tiles) {
        const key = tileKey(tile);
        if (!groups.has(key)) {
            groups.set(key, [tile]);
            order.push(key);
        } else {
            groups.get(key).push(tile);
        }
    }

    return order.map((key) => {
        const group = groups.get(key);
        if (group.length === 1) return group[0];

        // Sum the bar readings position-wise: each card carries a health bar
        // (index 0, what the clear is priced from) and a mana bar, so the wave's
        // health is the sum of its enemies' health.
        const width = Math.max(...group.map((tile) => tile.readings?.length || 0));
        const readings = [];
        for (let index = 0; index < width; index += 1) {
            let current = 0;
            let max = 0;
            let seen = false;
            for (const tile of group) {
                const reading = tile.readings?.[index];
                if (!reading) continue;
                seen = true;
                current += reading.current || 0;
                max += reading.max || 0;
            }
            if (seen) readings.push({ current, max });
        }

        return {
            ...group[0],
            readings,
            // A wave is cleared only when every enemy in it is down
            completed: group.every((tile) => tile.completed),
            // The cards folded in, kept for anything that wants the members rather
            // than the summed pool (the block still anchors to the first)
            waveCards: group.map((tile) => tile.element),
            waveSize: group.length,
        };
    });
}

/**
 * Do something to the page without losing the reader's place.
 *
 * Inserting an element into a scrolling container makes the browser re-lay the
 * content out, and a container whose content changes height while the user is
 * partway down it is routinely scrolled back to the top. The trials panel
 * redraws every five seconds and on every observer burst, so "routinely" here
 * means "every few seconds, forever", which is what was reported.
 *
 * Every scrollable ancestor is recorded rather than only the nearest, because
 * the game nests scrolling boxes and it is not always the same one that moves.
 *
 * @param {Element} node - Where the change is happening
 * @param {Function} change - The mutation
 * @returns {*} Whatever `change` returned
 */
export function withScrollKept(node, change) {
    const kept = [];
    for (let el = node; el; el = el.parentElement) {
        if (typeof el.scrollTop === 'number' && el.scrollTop > 0) kept.push([el, el.scrollTop]);
    }
    const documentTop =
        typeof document !== 'undefined'
            ? document.scrollingElement?.scrollTop || document.documentElement?.scrollTop
            : 0;

    try {
        return change();
    } finally {
        for (const [el, top] of kept) {
            if (el.scrollTop !== top) el.scrollTop = top;
        }
        if (documentTop && document.scrollingElement && document.scrollingElement.scrollTop !== documentTop) {
            document.scrollingElement.scrollTop = documentTop;
        }
    }
}

/**
 * Put a card's block somewhere it takes a row of its own.
 *
 * Third attempt, and the first two are why this is a function rather than a
 * style string. Appended *into* the card, it sat under the card's own footer,
 * because a card places its last rows against its bottom edge rather than after
 * whatever it contains. Inserted after the card with `grid-column: 1 / -1`, it
 * stayed one cell wide — 126px against a 525px section — and pushed into the
 * next section's heading. The devtools screenshots say why: the cards are grid
 * items, the section labels ("Combat Trial") are *flex* items of an outer box,
 * and `-1` resolves against the **explicit** grid, so on a container whose
 * columns are implicit `1 / -1` is a single cell.
 *
 * So the container is measured rather than assumed:
 *
 * - **A grid with a real column template.** Span every track it declares —
 *   `1 / span N` rather than `1 / -1`, because that works on implicit tracks too.
 * - **A grid with no template.** There is no row to span; the block goes after
 *   the whole grid, where it is a sibling of the next section label instead of
 *   a cell squeezed between cards.
 * - **A flex container.** `flex-basis: 100%` on a wrapping row is a line of its
 *   own; on a non-wrapping one it would squash the cards, so that goes after the
 *   container too.
 * - **Anything else** is ordinary flow, where a block-level div is already a row.
 *
 * When the block ends up away from its card it is given the trial's name, since
 * "Banked 3 tiers" under a stack of cards has to say which one.
 *
 * @param {Element} root - The trials root; nothing is placed outside it
 * @param {Element} card - The card being described
 * @param {Element} block - The block to place
 * @param {string} [name] - The trial's name, for when the block lands away from its card
 * @returns {string} How it was placed: `spanned`, `after-card`, `after-container`, or `refused`
 */
/**
 * Whether a container is a non-wrapping flex row — one that squashes a block
 * added to it rather than letting it fall to its own line.
 * @param {Element} el - The container
 * @returns {boolean}
 */
function isSquashingRow(el) {
    if (!el || typeof getComputedStyle !== 'function') return false;
    const style = getComputedStyle(el);
    if (!(style?.display || '').includes('flex')) return false;
    // startsWith, not includes: 'nowrap' contains 'wrap', and reading it as a
    // wrapping row is how every squash guard in this file silently stood down
    if ((style?.flexWrap || '').startsWith('wrap')) return false;
    const direction = style?.flexDirection || 'row';
    return direction === 'row' || direction === 'row-reverse';
}

/**
 * Climb out of every nested non-wrapping flex row above an element.
 *
 * A block placed as a sibling of a card inside such a row steals the row's width
 * and squashes the card — the skilling In Progress panel nests two (`battleArea`
 * holds the roster and a `challengeArea`, both non-wrapping rows), so escaping one
 * level still lands the block in a row. This returns the highest element whose
 * parent is still a squashing row, so a block placed against it sits on its own
 * line in the first column, grid, or block ancestor. The element itself when it is
 * already in ordinary flow.
 * @param {Element} root - Nothing is escaped past this
 * @param {Element} start - Where to climb from
 * @returns {Element} The element to place a block against
 */
function escapeSquashingRows(root, start) {
    let anchor = start;
    while (anchor?.parentElement && anchor.parentElement !== root && isSquashingRow(anchor.parentElement)) {
        anchor = anchor.parentElement;
    }
    return anchor;
}

/** The shared full-width row that carries a section's forecast boxes beneath its tiles */
const BOX_ROW_CLASS = 'mwi-trial-box-row';

/**
 * The grid geometry of a multi-column grid, or null when the element is not one.
 * @param {Element} el - The candidate grid
 * @returns {{columns: number, template: string, columnGap: string}|null}
 */
function gridGeometry(el) {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (!(style?.display || '').includes('grid')) return null;
    const template = style?.gridTemplateColumns || '';
    const tracks = template && template !== 'none' ? template.trim().split(/\s+/) : [];
    if (tracks.length <= 1) return null;
    const gap = style?.columnGap && style.columnGap !== 'normal' ? style.columnGap : '8px';
    return { columns: tracks.length, template, columnGap: gap };
}

/**
 * Drop a forecast box into its section's shared row beneath the tiles.
 *
 * One box per tile as a grid item does not give a row underneath: a section
 * whose tiles do not fill the last grid row (combat has two trials in a
 * four-column grid) would see the boxes flow into the empty cells *beside* the
 * tiles. So every box in a grid goes into a single Toolasha-owned row instead —
 * a full-width cell (`1 / span N`) deferred past the tiles (`order: 1`).
 *
 * The row mirrors the tile grid's own column template and gap, so each box sits
 * in its own column directly under the matching tile (four across for skilling,
 * two for combat) rather than wrapping to some width of its own. The boxes cap
 * their width at the column (`min(260px, 100%)`), so a narrower column just
 * shrinks the box to fit rather than overflowing.
 *
 * The layout that matters lives on this container, which the panel owns and the
 * per-block style reset never touches — so it holds where a grid property set on
 * the box itself was wiped on the next pass, dropping the box back beside its tile.
 *
 * @param {Element} grid - The multi-column grid the tiles live in
 * @param {{columns: number, template: string, columnGap: string}} geometry - Its geometry
 * @param {Element} block - The forecast box
 */
function placeInBoxRow(grid, geometry, block) {
    let row = null;
    for (const child of grid.children) {
        if (child.classList?.contains(BOX_ROW_CLASS)) {
            row = child;
            break;
        }
    }
    if (!row) {
        row = grid.ownerDocument.createElement('div');
        row.className = BOX_ROW_CLASS;
        row.style.cssText =
            `grid-column:1 / span ${geometry.columns}; order:1; width:100%;` +
            `display:grid; grid-template-columns:${geometry.template};` +
            `column-gap:${geometry.columnGap}; row-gap:8px; align-items:start; margin-top:8px;`;
        grid.appendChild(row);
    }
    row.appendChild(block);
}

/**
 * The live fight's boss grid, when a card belongs to one.
 *
 * Scoped by the monsters area rather than by "is a grid": the Trials setup tab
 * is grids all the way down, and a block landing in one of those belongs in the
 * shared box row beneath the tiles, not beside a tile. Only the In Progress
 * combat view puts its unit grid inside a `BattlePanel_monstersArea`, so that
 * ancestor is what separates the two.
 *
 * The card is not always inside the grid: a composite encounter (Trial Swarm)
 * has no card of its own and stands a synthetic tile on the monsters area
 * itself, so the grid is looked up beneath it as a last resort.
 *
 * @param {Element} card - The card, or synthetic tile element, a block belongs to
 * @returns {Element|null} The combat unit grid, or null outside a live fight
 */
function fightMonsterGrid(card) {
    const monstersArea = card?.closest?.('[class*="BattlePanel_monstersArea"]');
    if (!monstersArea) return null;
    const GRID = '[class*="BattlePanel_combatUnitGrid"]';
    if (card.matches?.(GRID)) return card;
    return card.closest?.(GRID) || monstersArea.querySelector?.(GRID) || null;
}

/**
 * Whether the trials content on screen is the In Progress view — the live
 * combat fight (`BattlePanel_monstersArea`) or the live skilling row
 * (`SkillingInstancePanel_challengeArea`) — rather than the Trials tab's
 * sign-up cards. Neither container exists on the Trials tab.
 * @param {Element} root - The trials content element
 * @returns {boolean}
 */
export function isInProgressView(root) {
    return Boolean(
        root?.querySelector?.('[class*="BattlePanel_monstersArea"], [class*="SkillingInstancePanel_challengeArea"]')
    );
}

/**
 * The grid column just past the wave's boss cards — the sidecar's column.
 *
 * `grid-row:1` alone left the sidecar's column to auto-placement, and
 * auto-placement fills the *first free cell*: a wave whose boss cards carry
 * explicit columns (two Trial Badgers centred at columns 2–3) leaves column 1
 * free, and the sidecar was drawn to the LEFT of the cards. The column is
 * therefore computed per wave: boss cards with explicit grid columns state
 * where they end, auto-placed ones fill 1..n in order, and the sidecar takes
 * the column after the last of either — a single boss puts it at 2, two
 * badgers at 3 (or past their explicit columns), a four-monster swarm at 5.
 *
 * Only the game's own cards count. Our injected blocks (the sidecar itself on
 * a re-place, the payout in old DOMs) all carry an `mwi-` class and are not
 * bosses, so they must not push the column further right.
 *
 * @param {Element} grid - The `BattlePanel_combatUnitGrid` element
 * @returns {number} 1-based grid column line for the sidecar
 */
export function fightSidecarColumn(grid) {
    let autoPlaced = 0;
    let lastExplicit = 0;
    for (const child of grid?.children || []) {
        if (String(child.className || '').includes('mwi-')) continue;
        const computed = typeof getComputedStyle === 'function' ? getComputedStyle(child) : null;
        const read = (prop) => child.style?.[prop] || computed?.[prop] || '';
        let startText = read('gridColumnStart');
        let endText = read('gridColumnEnd');
        if (!startText && !endText) {
            // The `grid-column` shorthand, for engines that do not expand it
            [startText = '', endText = ''] = String(read('gridColumn')).split('/');
        }
        const start = parseInt(startText, 10);
        const end = parseInt(endText, 10);
        // `grid-column-end` is the line *after* the card; a bare start occupies one column
        if (Number.isFinite(end)) lastExplicit = Math.max(lastExplicit, end - 1);
        else if (Number.isFinite(start)) lastExplicit = Math.max(lastExplicit, start);
        else autoPlaced += 1;
    }
    return Math.max(autoPlaced, lastExplicit) + 1;
}

/**
 * How many columns the fight grid actually has.
 *
 * The used value a browser reports is a track list ("176px 176px 176px 176px");
 * an engine that hands back the authored `repeat()` is parsed rather than
 * miscounted as one column. A grid with no template at all answers 0, which
 * reads as "unknown" to every caller and leaves the old behaviour in place.
 *
 * @param {string} template - A `grid-template-columns` value
 * @returns {number} Track count, or 0 when it cannot be read
 */
export function gridColumnCount(template) {
    const text = String(template || '').trim();
    if (!text || text === 'none') return 0;
    const repeated = text.match(/^repeat\(\s*(\d+)\s*,([^)]*)\)$/);
    if (repeated) {
        const tracks = repeated[2].trim().split(/\s+/).filter(Boolean).length || 1;
        return Number(repeated[1]) * tracks;
    }
    return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Where the sidecar goes in the fight grid — beside the wave, or under it.
 *
 * A single boss leaves three of the game's four columns free and the readout
 * belongs beside it, which is what the sidecar has always done. Trial Swarm
 * fields four monsters and fills all four columns, so the same rule asked the
 * grid for a fifth: 176 × 4 + 220, past the width of the panel, and the whole
 * fight grew a horizontal scrollbar with the fight itself pushed out of view.
 *
 * So a wave that fills the grid puts the readout on the row *beneath* it,
 * spanning every column — the row auto-placement would have used anyway, but
 * stated, because the explicit row is what stops it landing in the first free
 * cell of the bosses' own row. Full width is then a long thin box rather than a
 * tall thin one, so the caller lays its rows out in columns of their own.
 *
 * @param {Element} grid - The `BattlePanel_combatUnitGrid` element
 * @returns {{row: number, column: string, wrapped: boolean}} Where to put the block
 */
export function fightSidecarPlacement(grid) {
    const column = fightSidecarColumn(grid);
    const computed = grid && typeof getComputedStyle === 'function' ? getComputedStyle(grid) : null;
    const columns = gridColumnCount(grid?.style?.gridTemplateColumns || computed?.gridTemplateColumns || '');
    // `1 / -1` spans to the end of the *explicit* grid, which is exactly the
    // track list counted above — the wave's own columns and no implicit sixth
    if (columns > 0 && column > columns) return { row: 2, column: '1 / -1', wrapped: true };
    return { row: 1, column: String(column), wrapped: false };
}

/**
 * The sidecar's own sizing, for the placement it got.
 *
 * Beside the wave it is a boss card's width: wide enough that a label and a
 * figure fit on one line, capped so it cannot stretch the panel. Under the wave
 * it may have the whole width, and a full-width column of one-line rows is a
 * long thin box for no reason — so the rows are laid out in as many columns of
 * their own as fit, which keeps the readout about as tall as it was beside the
 * bosses. `auto-fit`/`minmax` rather than a column count: the fight grid is
 * whatever width the panel is, and a number picked here would be wrong at some
 * of them.
 *
 * @param {{row: number, column: string, wrapped: boolean}} placement - From
 *   {@link fightSidecarPlacement}
 * @returns {string} Style declarations
 */
export function fightSidecarStyle(placement) {
    const cell = `grid-row:${placement.row}; grid-column:${placement.column}; clear:none; align-self:start;`;
    if (!placement.wrapped) return `${cell} width:220px; min-width:180px; max-width:220px;`;
    return (
        `${cell} width:auto; min-width:0; max-width:100%; justify-self:stretch;` +
        'display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); column-gap:16px;'
    );
}

export function placeTrialBlock(root, card, block, name = '') {
    // Belt and braces over the anchor filter in `readTrialTiles`. The reported
    // failure drew this whole block inside the boss's stat popup, which is
    // headed with a trial name over a level and so reads as a card to every
    // filter that looks at the card. Placement is the last point at which "this
    // is not the guild panel" can still be said
    if (inFloatingDialog(card)) return 'refused';

    // The live fight: the block is a sidecar in the boss grid rather than a
    // full-width strip below it, so the fight and the forecast are read
    // together. Appended, never inserted after the anchor card — a wave of
    // several bosses folds into one tile anchored on the *first* of them, and
    // the block belongs after the last. `grid-row:1` keeps it on the bosses'
    // row instead of wrapping to a line of its own, and the explicit
    // `grid-column` puts it to the RIGHT of every boss card whatever the wave
    // shape — auto-placement would drop it into the first *free* cell, which
    // for a wave of explicitly-centred cards is the column to their left.
    const fightGrid = fightMonsterGrid(card);
    if (fightGrid && root?.contains?.(fightGrid)) {
        const placement = fightSidecarPlacement(fightGrid);
        block.style.gridRow = String(placement.row);
        block.style.gridColumn = placement.column;
        fightGrid.appendChild(block);
        return 'fight-sidecar';
    }

    // The skilling In Progress challenge row: the readout belongs BESIDE the
    // card (reported preference), not exiled to its own line — the row has the
    // width for both as long as the card is protected from shrinking and the
    // block yields first. The card's flex-shrink is pinned at placement; the
    // block's own sizing rides its base style, which _placeBlock reapplies.
    const challengeRow = card?.closest?.('[class*="SkillingInstancePanel_challengeArea"]');
    if (challengeRow && root?.contains?.(challengeRow)) {
        card.style.flexShrink = '0';
        block.dataset.mwiPlacement = 'row-sidecar';
        card.insertAdjacentElement('afterend', block);
        return 'row-sidecar';
    }

    const container = card?.parentElement;
    if (!container || !root?.contains?.(container)) {
        card?.appendChild?.(block);
        return 'after-card';
    }

    const style = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
    const display = style?.display || '';

    const afterContainer = () => {
        // Escape every nested non-wrapping row, not just this one: the skilling
        // panel puts the card two rows deep, so landing after the immediate
        // container still leaves the block in a row squashing the roster and card.
        const anchor = escapeSquashingRows(root, container);
        const outer = anchor.parentElement;
        if (!outer || !root.contains(outer)) {
            card.insertAdjacentElement('afterend', block);
            return 'after-card';
        }
        // The container we escaped to can itself be the tab's multi-column tile
        // grid — each trial tile is a single-column grid nested inside it — so a
        // box landing here belongs in the shared row beneath the tiles, not the
        // next cell beside one.
        const outerGrid = gridGeometry(outer);
        if (outerGrid) {
            placeInBoxRow(outer, outerGrid, block);
            return 'row';
        }
        block.style.width = '100%';
        block.style.flexBasis = '100%';
        // Placement can run again on the same block when a remount strands it,
        // and a heading per placement is a stutter of headings
        if (name && !block.querySelector('.mwi-trial-block-heading')) {
            block.insertAdjacentHTML('afterbegin', trialBlockHeading(name));
        }
        anchor.insertAdjacentElement('afterend', block);
        return 'after-container';
    };

    if (display.includes('grid')) {
        // A fight whose unit grid could not be named (the sidecar above takes
        // every grid that could). Its enemy grid is still not a tile grid:
        // gathering the box into a mirrored row would drop it in a narrow
        // unit-card column, so it falls through to full-width below the grid.
        const inFight = !!card?.closest?.('[class*="BattlePanel_monstersArea"]');
        const geometry = inFight ? null : gridGeometry(container);
        if (geometry) {
            placeInBoxRow(container, geometry, block);
            return 'row';
        }
        return afterContainer();
    }

    if (display.includes('flex')) {
        // startsWith: 'nowrap' contains 'wrap', which sent every non-wrapping
        // row down the wrapping path — a block dropped beside the card with
        // flex-basis 100% in a row that cannot wrap just squashes the card
        const wraps = (style?.flexWrap || '').startsWith('wrap');
        if (!wraps) return afterContainer();
        block.style.flexBasis = '100%';
        block.style.width = '100%';
        card.insertAdjacentElement('afterend', block);
        return 'after-card';
    }

    block.style.width = '100%';
    card.insertAdjacentElement('afterend', block);
    return 'after-card';
}

/**
 * A heading naming the trial a detached block belongs to.
 * @param {string} name - Trial name
 * @returns {string} HTML
 */
function trialBlockHeading(name) {
    return (
        `<div class="mwi-trial-block-heading" style="color:${ACCENT}; font-weight:600; ` +
        `margin-bottom:2px;">${name}</div>`
    );
}

/**
 * Whether a block still sits where its card's placement put it.
 *
 * Every placement {@link placeTrialBlock} makes leaves the block adjacent to
 * the card or to the card's container — so "still anchored" is a cheap
 * adjacency test, and failing it means the game has moved on underneath: React
 * re-parents cards as a fresh panel settles, and tears the boss card down and
 * remounts it at every wave boundary. Both were reported as the same symptom —
 * the readout drifting to the bottom of the view on first render, and the
 * panel order flipping to [payout][DPS][boss card] after a tier cleared,
 * because the remounted card arrived *after* the block that was placed beside
 * its predecessor.
 *
 * When the card is nested in a non-wrapping flex row, the placement escapes that
 * row (see {@link escapeSquashingRows}), so the only correct position is right
 * after the outermost such row — not beside the card, which would squash it. A
 * block that lands beside the card on first paint, before the game's flex styles
 * have computed, must therefore read as displaced so it is re-placed once they
 * have; treating "beside the card" as anchored is what left the skilling card
 * squashed to 44px even after the layout settled.
 *
 * @param {Element} block - The injected block
 * @param {Element} anchor - The card it belongs beside
 * @param {Element} [root] - The trials root, for the escape test; omitted keeps the plain adjacency check
 * @returns {boolean} True while the placement still holds
 */
export function blockNearAnchor(block, anchor, root = null) {
    // A box gathered into its section's shared row is placed — its home is that
    // row, not a spot beside the tile, so adjacency to the tile is the wrong test
    // and would re-place (and re-append) it on every pass.
    if (block?.parentElement?.classList?.contains(BOX_ROW_CLASS)) {
        return !root || root.contains(block);
    }
    // A row sidecar lives beside its card by request — adjacency IS its home,
    // and the escape rule below would evict it from the very row it belongs in
    if (block?.dataset?.mwiPlacement === 'row-sidecar') {
        return !anchor?.isConnected || anchor.nextElementSibling === block;
    }
    // The live fight's sidecar is anchored on the first boss of the wave but
    // lives after the last, so adjacency to the anchor is the wrong test — it
    // reads a correctly placed sidecar as displaced and yanks it out on every
    // pass. Last child of the grid is the placement, and a boss that mounts
    // after it fails this and re-triggers placement, putting it back at the end.
    const fightGrid = fightMonsterGrid(anchor);
    if (fightGrid && block?.parentElement === fightGrid) return fightGrid.lastElementChild === block;
    if (!anchor?.isConnected) return true; // nothing to re-anchor against
    if (root) {
        const escaped = escapeSquashingRows(root, anchor);
        // Nested in a squashing row: the block belongs after that row, full width
        if (escaped !== anchor) return escaped.nextElementSibling === block;
    }
    return (
        anchor.nextElementSibling === block ||
        anchor.parentElement?.nextElementSibling === block ||
        anchor.contains(block)
    );
}

class GuildTrials {
    constructor() {
        this.initialized = false;
        /** Unregisters the `guildTrialsInfo` listener that outlives cleanup — see _watchInfoSetting() */
        this.unwatchInfoSetting = null;
        this.unregister = [];
        this.timers = createTimerRegistry();
        this.record = null;
        /** The name the record is currently keyed by; null means the `default` key */
        this.guildName = null;
        /** Guards the one-shot adoption below against a second render starting it again */
        this.adopting = false;
        /** When the sampler last ran, so a sampler that has stopped can be noticed */
        this.lastTickAt = 0;
        /** The sampler's interval id, kept so it can be re-armed */
        this.samplerId = null;
        /** Guild name seen on the socket, when the XP tracker is not the one who saw it */
        this.socketGuildName = null;
        /**
         * The last `currentTrialsData` read off `guild_updated`, with when it
         * arrived — `{combat, skilling, at}`. The one trial signal that does not
         * need the panel open; see {@link _noteCurrentTrials}.
         */
        this.currentTrials = null;
        /** The phase that message implies, used only where the page says nothing */
        this.socketPhase = null;
        /** The character whose record is in hand; a switch invalidates everything below it */
        this.characterId = null;
        /** True between a character switch and the arriving character's data landing */
        this.awaitingCharacter = false;
        /** Block key → the markup last drawn into it, so an unchanged pass touches nothing */
        this.blockHtml = new Map();
        /** When the record last went to storage; writes run at the sampling cadence, not the render one */
        this.lastRecordSaveAt = 0;
        /**
         * True while the stored record has not been read successfully — the
         * load found storage unreadable, so the in-memory record may be
         * missing everything on disk. The next save re-reads first and folds
         * the stored copy in (the write itself merges regardless).
         */
        this.recordUnread = false;
        /** Guards the re-read above against the sampler starting a second one */
        this.rereading = false;
        /** Where the cycle was last seen to be: scheduled, live or completed */
        this.phase = null;
        /** The last combat forecast, for the per-player panel to echo */
        this.lastForecast = null;
        /**
         * Learned first-tier work per skill, `{crafting: {baseWork, …}}`.
         * Game-wide rather than per guild — the base is the ladder's, confirmed
         * across guilds — so a character switch does not drop it.
         */
        this.workBases = {};
        /** The spectated pool this render is working from, and its encounter */
        this.watchedPool = null;
        /** How strong a claim the card that owns the guild-report context has */
        this.contextRank = 0;
        /** The recorder's last session, read back once for the finished-trial readout */
        this.lastSession = null;
        /** Whether that one-shot read has been made (or is in flight) */
        this.lastSessionChecked = false;
    }

    async initialize() {
        if (this.initialized) return;
        // Watched before the gate below, and never unregistered: the setting is
        // the gate, so a listener that only exists once the gate has opened can
        // never see it being opened. Turning it off used to leave every block
        // already drawn sitting on the page — `_render` returns early and takes
        // nothing down — so the overlay stayed on over a settings checkbox that
        // said it was off, with no redraw to correct it.
        this._watchInfoSetting();
        if (!config.getSetting('guildTrialsInfo', true)) return;

        registerCommand({
            name: 'Trial Damage',
            hint: 'Damage and healing per player, ranked',
            run: () => guildTrialScoreboard.toggle(),
        });

        // Both of these are buttons under the trial cards on the In Progress
        // tab, which is to say: reachable only while the thing they are about
        // is on screen. Starting a capture is the one you most want *before*
        // you have gone looking.
        registerCommand({
            name: 'Start trial capture',
            hint: 'Record this trial, as the Record button does',
            kind: 'verb',
            run: () => {
                // `start` is idempotent, so asking twice is harmless — but
                // "already recording" and "capture started" are different
                // answers and the second would be a lie. 'button' is
                // load-bearing: it marks the session manual, so only the player
                // stops it, which is what pressing a thing to start it means
                if (guildTrialRecorder.recording) return 'already recording';
                guildTrialRecorder.start('button');
                return guildTrialRecorder.recording ? 'capture started' : 'could not start a capture';
            },
        });

        registerCommand({
            name: 'Export trial JSON',
            hint: "This week's trial record, as a file",
            kind: 'verb',
            run: async () => {
                const bundle = await buildTrialExport({ guildName: this.guildName });
                // The builder never refuses — an empty week is a well-formed
                // bundle — so handing the player a file full of nulls and
                // calling it a success would be the wrong answer twice over
                if (trialExportIsEmpty(bundle)) return 'nothing recorded this week';

                const filename = downloadTrialExport(bundle);
                if (!filename) throw new Error('the download could not be started');
                return filename;
            },
        });

        // Whatever a previous life left behind is not this one's. The merge
        // below is for readings taken by a tick that beat the load, not for a
        // record from before a cleanup
        this.record = null;

        // Listeners and the sampler first, before anything is awaited.
        //
        // This ordering is the fix for a recording that produced two samples in
        // forty minutes of a live trial with the tab open. Everything below the
        // first `await` — which is to say the sampler — only exists if every
        // promise above it settles, and a rejected or slow one takes the
        // five-second reading with it while leaving the DOM observer (registered
        // first, at the time) drawing blocks. The panel therefore *looked* like
        // it was working: it drew, on whatever DOM churn or guild message
        // happened to arrive, and sampled at that cadence rather than its own.
        //
        // Nothing here needs the record, because `_render` tolerates not having
        // one yet: a tick before the load lands writes into a fresh record and
        // the load merges into it rather than replacing it.
        this._armSampler();

        // A character switch invalidates every cached answer this feature holds.
        // Registered here, above the awaits, for the same reason the sampler is:
        // a reset that only exists once storage has answered is a reset that can
        // be skipped entirely.
        this._onCharacterSwitch = (event) => this._forgetCharacter(event?.newId ?? null);
        dataManager.on?.('character_switching', this._onCharacterSwitch);
        this.unregister.push(() => dataManager.off?.('character_switching', this._onCharacterSwitch));

        // Any guild panel node at all, rather than a list of guesses at what the
        // two trial tabs are called. The In Progress tab's card carries neither
        // a tile summary nor a level, so there is no narrower class this could
        // wait for without being wrong about one of the two tabs again — and
        // `findTrialsRoot` costs two `querySelector`s to answer "not this tab".
        // Debounced, so React's render burst is one call rather than hundreds.
        // `maxWait` is what keeps the debounce from starving on the In Progress
        // tab: its bar and countdown re-arm the 100ms timer without pause, which
        // used to defer first paint all the way to the next 5s sampler tick — the
        // "slowest tab to overlay". Bounded to 400ms, the tab now draws within
        // that of opening whatever the churn, while steady state still coalesces.
        this.unregister.push(
            domObserver.onClass('GuildTrials', 'GuildPanel_', () => this._onTab(findTrialsRoot()), {
                debounce: true,
                debounceDelay: 100,
                debounceMaxWait: 400,
            })
        );

        this._refresh = (data) => {
            this._noteGuildName(data);
            this._noteCurrentTrials(data);
            this._render(findTrialsRoot());
        };
        for (const type of ['guild_updated', 'guild_characters_updated', 'guild_trial_signup_updated']) {
            webSocketHook.on(type, this._refresh);
        }
        this.unregister.push(() => {
            for (const type of ['guild_updated', 'guild_characters_updated', 'guild_trial_signup_updated']) {
                webSocketHook.off(type, this._refresh);
            }
        });

        // Both listen to the socket rather than to the panel, so they are
        // started here rather than on the tab appearing: a trial fight and a
        // unit popup both happen while the guild page is shut. `_publishTrialNames`
        // arms the damage gate from last session's record, so a fight is
        // recognised without the tab having been opened this session.
        guildTrialDamage.initialize();
        guildTrialSkilling.initialize();
        guildTrialStatsModal.initialize();
        guildTrialAlerts.initialize?.();
        guildTrialRecorder.initialize(this.guildName);
        guildMemberSkills.initialize(this.guildName).catch(() => {});
        guildTrialTrace.initialize?.();
        guildTrialAbilitiesFeature.initialize(this.guildName).catch(() => {});
        // One bucket for every character in the tab is what poisoned a guild's
        // record in the first place; nothing writes to it now, so it goes
        purgeLegacyTrialRecord().catch(() => {});

        this.initialized = true;

        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        const characterId = this.characterId;
        this.guildName = this._resolveGuildName();
        guildTrialRecorder.setGuildName(this.guildName);
        guildTrialAbilities.setGuildName?.(this.guildName);
        // Three independent storage reads, awaited together rather than one
        // after another: serially they were three IndexedDB round trips before
        // the first panel could carry stored samples, which is a visible slice
        // of the reported lag on load
        const [stored, storedBases] = await Promise.all([
            loadTrialRecord(this.guildName, Date.now(), this.characterId, { guildId: this._guildId() }),
            loadWorkBases(),
            guildLoadoutCapture.initialize(),
        ]);
        // A read that could not be made leaves the in-memory record as it is:
        // the one a tick built in the meantime, or none — never a fresh week
        // written back over the stored one.
        //
        // A switch landing in those three reads has already run
        // `_forgetCharacter`, which cleared the record and started the arriving
        // character's own read; folding this one in would put the departing
        // character's guild readings into it, and the next save files them
        // under the arriving character's key.
        // Merged under whatever a tick learned while the read was in flight, so
        // a base observed seconds after startup is not thrown away by the load.
        // Before the character check below because work bases are the game's,
        // not one character's.
        this.workBases = { ...storedBases, ...this.workBases };

        if (this.characterId !== characterId) return;
        this._adoptStored(stored);
        this._publishTrialNames();
    }

    /**
     * Follow `guildTrialsInfo` for as long as the page lives.
     *
     * Kept outside `this.unregister` because it has to outlive the cleanup that
     * would take it away: with the feature down, this listener is the only path
     * by which the setting can be turned back on without a reload. Registered
     * before the gate in `initialize` for the same reason, and the previous one
     * is dropped first so re-initialising cannot stack them.
     *
     * Turning it off takes the blocks down rather than merely stopping their
     * refresh: `_render` returns early on the same setting, so what was already
     * injected would otherwise stay on screen indefinitely, contradicting the
     * checkbox that turned it off.
     * @returns {void}
     * @private
     */
    _watchInfoSetting() {
        this.unwatchInfoSetting?.();
        this.unwatchInfoSetting = config.onSettingChange('guildTrialsInfo', (enabled) => {
            if (enabled) {
                this.initialize().catch((error) => {
                    console.error('[GuildTrials] Starting up after the setting was turned on failed:', error);
                });
                return;
            }
            try {
                document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
                document.querySelectorAll(`.${BOX_ROW_CLASS}`).forEach((row) => {
                    if (!row.querySelector(`.${CSS_CLASS}`)) row.remove();
                });
                this.blockHtml.clear();
            } catch (error) {
                console.error('[GuildTrials] Taking the trial blocks down failed:', error);
            }
        });
    }

    /**
     * Start the five-second sampler, replacing any that is already running.
     *
     * Separate from {@link initialize} so it can be re-armed: the reading only
     * exists because something took it, and an interval that has been cleared —
     * by a cleanup that raced a re-initialisation, by a browser that throttled a
     * background tab into never rescheduling it — is indistinguishable on screen
     * from a trial nobody is running.
     */
    _armSampler() {
        if (this.samplerId) clearInterval(this.samplerId);
        this.samplerId = setInterval(() => this._tick(), SAMPLE_MS);
        this.timers.registerInterval(this.samplerId, 'guildTrials.sample');
    }

    /** One sampler tick: read the tab if it is open, and note that the sampler is alive */
    _tick() {
        this.lastTickAt = Date.now();
        const el = findTrialsRoot();
        if (el?.isConnected) this._render(el);
    }

    /**
     * The tab appeared or changed.
     * @param {Element|null} el - The trials content element
     */
    _onTab(el) {
        // A tab event is also proof of life for the sampler: if ticks have
        // stopped while the panel is plainly being drawn, the interval is gone
        // and the readings with it, so it is started again
        if (this.initialized && this.lastTickAt && Date.now() - this.lastTickAt > SAMPLE_MS * 3) {
            this._armSampler();
        }
        this._render(el);
    }

    /**
     * Drop everything belonging to the character that is leaving.
     *
     * The reported bug, and it was every cache at once. Switching characters in
     * one tab left the previous guild's finished trial on the new guild's Trials
     * tab — "Guild Points banked 2,880" beside a header reading 0, "Banked 5
     * tiers" on a card reading "0 pts" — and the warning line went so far as to
     * judge the *old* record's 840 pts against the *new* guild's Builder's Hall
     * level, which is two guilds' data in one sentence.
     *
     * Nothing here is recoverable by reloading one thing: the record, the guild
     * name and its socket-seen fallback, the encounters pushed into the damage
     * gate, and the recorder's open session all belong to the character that is
     * leaving. They are dropped together, and the record for the arriving
     * character is read back once the socket says who they are.
     */
    _forgetCharacter(newId = null) {
        try {
            this.record = null;
            this.guildName = null;
            this.socketGuildName = null;
            this.characterId = newId;
            this.adopting = false;
            this.lastRecordSaveAt = 0;
            this.recordUnread = false;
            // The switch message arrives *before* the arriving character's own
            // data does, so for a moment every source of a guild name still
            // holds the departing one's. Adopting then would file the new
            // character's readings under the guild they just left — the leak,
            // one layer down. Nothing is adopted until the ids agree again.
            this.awaitingCharacter = true;

            // Nothing on screen belongs to the arriving character either, and it
            // comes off first: a later step failing must not leave the previous
            // guild's figures on a page that has already changed hands
            document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
            this.blockHtml.clear();
            guildTrialScoreboard.close?.();

            // The recorder closes its own open session first, and that close
            // folds it into the attendance ledger off the damage module's
            // still-live breakdown (`_accrue` reads `guildTrialDamage.breakdown()`
            // synchronously) — so it has to run before that breakdown is wiped
            // below, or a trial cut short by this very character switch would
            // be folded in with no encounter, no tier and no roster
            guildTrialRecorder.forget?.();
            guildTrialRecorder.setGuildName?.(null);
            // The gate's "this week's combat trials" is the old guild's answer
            guildTrialDamage.setTrialNames?.([]);
            guildTrialDamage.reset?.();
            guildTrialAbilities.setGuildName?.(null);
            guildLoadoutCapture.setGuildName?.(null)?.catch?.(() => {});
            guildTrialAlerts.reset?.();
            guildMemberSkills.forget?.();
            // The skilling socket cache is keyed by trial name alone — no guild
            // or character scoping at all, unlike everything else here — so an
            // arriving character's card can be handed the departing character's
            // guild's own "Alchemy" reading for as long as `SKILLING_FRESH_MS`
            // still calls it fresh. `_withSocketSkilling` only grafts a socket
            // reading onto a card whose bar the DOM has not drawn yet, so this
            // shows up as an occasional wrong figure rather than a permanent
            // one — the card alternates between the real bar (once the DOM has
            // it) and the stale socket answer (whenever a render catches the
            // bar before the DOM does), for up to fifteen seconds after every
            // switch. A session with several alts read as a trial that would
            // not hold still.
            guildTrialSkilling.reset?.();
            // Same leak, one module over: the captured Trial Stats modal is also
            // keyed by trial name alone, and the scoreboard reads it by that name
            guildTrialStatsModal.reset?.();
            this.phase = null;
            // The socket's own reading of the guild that has just been left.
            // `currentTrials` is the only trial signal that arrives with the
            // panel shut, and `_trialBudgetMs` counts its `budgetRemainingMs`
            // down from when it landed — so the arriving character's card draws
            // the departing guild's hour ticking away, and only stops when that
            // hour would have run out anyway. `socketPhase` is the phase that
            // same message implied, which `_noteLifecycle` falls back on
            // wherever the page says nothing.
            this.currentTrials = null;
            this.socketPhase = null;
            // The forecast the per-player panel echoes, and the render state
            // that decides which card is allowed to replace it. Rebuilt every
            // render pass from a card, so with no card of the arriving
            // character's own there is nothing to displace the old one.
            this.lastForecast = null;
            this.watchedPool = null;
            this.contextRank = 0;
            // The recorder session cached for the last-trial readout is the
            // departing character's; the arriving one is asked for afresh
            this.lastSession = null;
            this.lastSessionChecked = false;

            // Re-read for whoever arrives. Not awaited on this path — the
            // character's own id lands on the same message that triggered this
            this._adoptArrivingCharacter(newId).catch(() => {});
        } catch (error) {
            console.error('[GuildTrials] Clearing the outgoing character failed:', error);
        }
    }

    /**
     * Fold a record read from storage into the one in hand.
     *
     * `null` is a read that could not be made, not an empty week: the in-memory
     * record stands and is flagged so the next save re-reads before writing.
     * @param {Object|null} stored - What `loadTrialRecord` answered
     */
    _adoptStored(stored) {
        if (stored === null) {
            this.recordUnread = true;
            return;
        }
        this.recordUnread = false;
        this.record = mergeTrialRecords(stored, this.record);
    }

    /**
     * Write the record, re-reading first when the stored copy was never read.
     *
     * Not awaited by the sampler: the write already merges what is stored under
     * the record in hand and refuses to write blind, so all this adds is that a
     * record held since a failed load learns what is on disk the first time
     * storage answers again — one key read, only while it is needed.
     * @param {Object} [options]
     * @param {boolean} [options.overwrite=false] - Write as-is; for the cycle archive only
     * @returns {Promise<boolean>} Whether the write was queued
     */
    async _persistRecord({ overwrite = false } = {}) {
        const guildName = this.guildName;
        const characterId = this.characterId;
        const guildId = this._guildId();
        try {
            if (this.recordUnread && !overwrite && !this.rereading) {
                this.rereading = true;
                try {
                    const stored = await loadTrialRecord(guildName, Date.now(), characterId, { guildId });
                    // The world may have moved while the read was in flight
                    if (this.characterId === characterId && this.guildName === guildName) {
                        this._adoptStored(stored);
                    }
                } finally {
                    this.rereading = false;
                }
                // Still unreadable: the save would be refused on the same read
                if (this.recordUnread) return false;
            }
            if (this.characterId !== characterId || this.guildName !== guildName || !this.record) return false;
            return await saveTrialRecord(guildName, this.record, characterId, { guildId, overwrite });
        } catch (error) {
            console.error('[GuildTrials] Saving the trial record failed:', error);
            return false;
        }
    }

    /**
     * Read the arriving character's own record, once there is one to read.
     * @returns {Promise<void>}
     */
    async _adoptArrivingCharacter(characterId) {
        // Strictly the character's own record: the guild is not knowable yet, so
        // the character-scoped key is the only one that cannot be the last
        // guild's. `_adoptGuildName` merges it onto the guild's key later, once
        // a name has arrived that belongs to *this* character.
        guildTrialRecorder.setGuildName(null);
        guildTrialAbilities.setGuildName?.(null);
        const stored = await loadTrialRecord(null, Date.now(), characterId, { guildId: this._guildId() });

        // Another switch may have happened while the read was in flight
        if (this.characterId !== characterId) return;

        // Unreadable: the arriving character's record starts this week empty
        // (the departing one's is not theirs) and is folded in by the next save
        this.record = stored ?? emptyRecord(trialWeekStart(Date.now()), { guildId: this._guildId() });
        this.recordUnread = stored === null;
        this._publishTrialNames();
    }

    /**
     * The guild's name, from whichever source has it.
     *
     * Three, in order of how directly they saw it. The XP tracker is the one
     * that is *supposed* to know, and it is also the one that can be switched
     * off in settings or can simply never have received a `guild_updated` — in
     * which case it answers null for the whole session and every reading is
     * filed under the `default` key, which is what was reported. The character's
     * own init payload carries `guild.name` and is present from login; the
     * socket's own `guild_updated` carries it too and is captured here rather
     * than being asked for.
     *
     * @returns {string|null} The name, or null when nothing has seen one
     */
    _resolveGuildName() {
        // Mid-switch every source still answers with the departing character's
        // guild. The ids agreeing again is what says the arriving character's
        // own data has landed
        if (this.awaitingCharacter) {
            const current = dataManager.getCurrentCharacterId?.() ?? null;
            if (current === null || current !== this.characterId) return null;
            this.awaitingCharacter = false;
        }

        return (
            guildXPTracker.getOwnGuildName?.() || this.socketGuildName || dataManager.characterData?.guild?.name || null
        );
    }

    /**
     * Note a guild name off a guild message.
     * @param {Object} [data] - A `guild_updated`-shaped payload
     */
    _noteGuildName(data) {
        const name = data?.guild?.name;
        if (typeof name === 'string' && name.trim()) this.socketGuildName = name.trim();
    }

    /**
     * What the guild message says about the trials in progress.
     *
     * The one lifecycle signal on this feature that does not need the panel
     * open. Every other one is scraped off the Trials tab, so a trial that runs
     * its whole hour while the player is fishing is invisible to the recorder
     * and to the ability capture alike; `guild_updated` arrives regardless, and
     * `currentTrialsData` on it states whether a combat trial is in progress
     * and how much of its hour is left.
     *
     * Strictly additive. What is read here arms the things that only need to
     * know a trial is running — it never sets the phase, because a phase read
     * off the page is a phase somebody can see and this parse may be describing
     * the moment before. {@link _noteLifecycle} consults it only when the page
     * said nothing at all.
     *
     * @param {Object} [data] - A `guild_updated`-shaped payload
     */
    _noteCurrentTrials(data) {
        try {
            const read = parseCurrentTrialsData(data?.guild?.currentTrialsData ?? data?.currentTrialsData);
            if (!read) return;

            const now = Date.now();
            this.currentTrials = { ...read, at: now };

            const combat = read.combat;
            if (!combat) return;

            if (combat.inProgress && !combat.allDone) {
                // The trial is running, stated by the server. Both of these
                // debounce their own repeats, and both otherwise wait on
                // somebody opening the Trials tab.
                this.socketPhase = 'live';
                guildTrialRecorder.noteActivity?.('guild-updated', now);
                guildTrialAbilities.noteTrialActivity?.(now);
            } else if (this.socketPhase === 'live') {
                // It was running and is not any more — the status left
                // `in_progress`, or every party finished. Either is an ending,
                // and it is the only one that arrives with the panel shut.
                this.socketPhase = combat.allDone ? 'completed' : 'scheduled';
            }
        } catch (error) {
            console.error('[GuildTrials] Reading the guild’s trial status failed:', error);
        }
    }

    /**
     * How much of the trial's hour is left, as the server counts it.
     *
     * Only for a combat trial in progress, and only while the reading is fresh
     * enough to still be counting down — `budgetRemainingMs` is a snapshot, so
     * the time since it arrived is taken off it here rather than being drawn as
     * though it had stood still.
     *
     * @param {string} kind - `combat` or `skilling`
     * @param {number} [now=Date.now()] - Clock
     * @returns {number|null} Milliseconds left, or null when nothing said
     */
    _trialBudgetMs(kind, now = Date.now()) {
        const held = this.currentTrials;
        const entry = held?.[kind === 'skilling' ? 'skilling' : 'combat'];
        const stated = entry?.budgetRemainingMs;
        if (!Number.isFinite(stated) || !entry?.inProgress) return null;

        const elapsed = Number.isFinite(held.at) ? Math.max(0, now - held.at) : 0;
        // Older than the budget it stated is a reading from a trial that has
        // since ended, and counting down past zero says nothing
        if (elapsed >= stated) return null;
        return stated - elapsed;
    }

    /**
     * Move the record onto the real guild's key, once the guild is known.
     *
     * The key is resolved lazily rather than at startup because at startup it is
     * not knowable: `guildXPTracker` learns the guild name from socket traffic
     * that has not arrived when features initialise, so every session began by
     * writing its samples to `guildTrials_default` and never revisiting the
     * question. Two guilds' worth of an alt's browsing went into the same bucket,
     * and the correctly-keyed record from the last session was never read.
     *
     * Absorbing rather than replacing: whatever is stored under the real name is
     * merged with what this session has already collected under `default`, so no
     * reading is stranded in either direction. The `default` entry is left where
     * it is — it costs nothing, and deleting the only other copy of a record on
     * the strength of a name that has just arrived is not a trade worth making.
     *
     * That absorption is right for `default → a name` and wrong for `one name →
     * another`, which is the same call because the only guard was
     * `name !== this.guildName`. A character who leaves one guild and joins
     * another without reloading took the merge path and wrote the guild they
     * left's tiles under the guild they joined's key — stamped as the new
     * guild, which also defeats the `foreign` provenance check on the next
     * load. A genuine guild change therefore replaces rather than merges.
     *
     * @returns {Promise<void>}
     */
    async _adoptGuildName() {
        const name = this._resolveGuildName();
        if (!name || name === this.guildName || this.adopting) return;

        this.adopting = true;
        try {
            const changing = this.guildName !== null;
            const characterId = this.characterId;
            const stored = await loadTrialRecord(name, Date.now(), characterId, { guildId: this._guildId() });
            // The read is a storage round trip, and `_forgetCharacter` moves
            // `this.characterId` the moment a switch lands. Carrying on merged
            // the departing character's guild record into the arriving
            // character's — and then stamped it with the departing guild's name,
            // which is exactly what the `foreign` provenance check on the next
            // load reads as "own", so nothing downstream ever discards it.
            if (this.characterId !== characterId) return;
            if (changing) {
                // Nothing in hand belongs to the arriving guild. An unreadable
                // read starts the week empty and is flagged, exactly as the
                // arriving-character path does
                this.record = stored ?? emptyRecord(trialWeekStart(Date.now()), { guildId: this._guildId() });
                this.recordUnread = stored === null;
                // Same leak as the character-switch one: the skilling socket
                // cache is keyed by trial name alone, so the guild just left
                // behind can still answer for "Alchemy" on the guild just
                // joined for up to fifteen seconds
                guildTrialSkilling.reset?.();
                // …and the Trial Stats modal cache, keyed the same fragile way
                guildTrialStatsModal.reset?.();
            } else {
                // The name is adopted either way; a record under it that could
                // not be read now is folded in by the next save's re-read
                this._adoptStored(stored);
            }
            this.guildName = name;
            guildTrialRecorder.setGuildName(name);
            guildTrialAbilities.setGuildName?.(name);
            guildMemberSkills.setGuildName(name).catch(() => {});
            guildLoadoutCapture.setGuildName?.(name)?.catch?.(() => {});
            await this._persistRecord();
        } catch (error) {
            console.error('[GuildTrials] Moving the record onto the guild key failed:', error);
        } finally {
            this.adopting = false;
        }
    }

    /**
     * Take a reading and redraw.
     * @param {Element|null} root - The trials content element
     */
    _render(root) {
        try {
            if (!root?.isConnected) return;
            if (!config.getSetting('guildTrialsInfo', true)) return;

            const now = Date.now();
            const weekStart = trialWeekStart(now);
            if (!this.record || this.record.weekStart !== weekStart) {
                // A week's roll-over is a different ladder; the record for it
                // starts empty and stamped with whose it is
                this.record = emptyRecord(weekStart, { guildId: this._guildId(), guildName: this.guildName });
            }

            // Every card on either tab, bar or no bar. A Trials card carries the
            // tier, the points and the sign-ups; the In Progress card carries the
            // reading; `recordTileSample` takes a sample only from the one that
            // has something moving on it, and both write the identity of the same
            // trial under the same key.
            // Positive gate, before anything is read or written. The guild page
            // is one panel with several tabs and the root finder answers for the
            // whole of it, so "a guild panel exists" is not "a trial is on
            // screen" — which is how the payout block came to be drawn over the
            // Overview tab's notice board.
            if (!onTrialTab(root)) {
                this._reapBlocks(null, new Set());
                return;
            }

            // A multi-enemy wave draws one card per enemy under the same name;
            // fold them into a single wave tile so the clear is priced off the
            // whole HP pool rather than one bar (two "Trial Badger"s otherwise
            // collide on their key and the record keeps only one).
            const tiles = mergeWaveTiles(readTrialTiles(root));

            // One recursive text walk of the panel, shared by both readers below:
            // status and personal stats read the same root, and walking it twice
            // was a measurable slice of the per-pass cost on the live tab.
            const panelLines = textLines(root);

            // Where the cycle is decides what the record below even means. Read
            // before anything is folded in, because a stale record must not be
            // sampled into and then archived — the sample would go with it.
            const status = readTrialStatus(root, panelLines);
            this._healStaleRecord(status, tiles, now);
            // Any card actually running counts, whichever kind the header names
            const anyLive = tiles.some(
                (tile) => this._phaseFor(status, tile, this.record?.tiles?.[tileKey(tile)]) === 'live'
            );
            // The game stating that a trial has ended outranks a card that has not
            // been redrawn yet. `end_guild_battle` and `end_guild_skilling` are
            // the only signals this feature has ever had that are *certain*;
            // everything else is a phase inferred from a header or a badge
            const declaredOver = this._declaredOver(tiles);
            guildTrialRecorder.noteLifecycle?.(declaredOver ? 'completed' : anyLive ? 'live' : status.phase, now);
            // The player's own action stats live in the tab's footer rather than
            // on a card, so they are read once and attached to whichever trial
            // is the live one — the only card that can have produced them
            const personal = readPersonalStats(root, panelLines);
            const live = tiles.find((tile) => tile.readings.length > 0) || null;
            // Whose footer this is. A bar identifies the card outright, but the
            // card does not always have one — between tiers, and once the hour
            // ends, the In Progress card is a name and nothing else — and the
            // stats were then attached to no card at all, which is how a whole
            // trial's Success Rate readings never reached `personalByTier`
            const owner = live || soleTileOfKind(tiles, status.kind);
            // The spectator stream's own reading of the pool, when somebody has
            // the fight view open. Same number as the DOM bar, to the unit, but
            // per tick and with the tier stated rather than inferred
            const watched = this._spectatedPool(now);
            // Held for `_contextRank`, which decides which card the guild report
            // is about — and is asked once per card rather than once per render
            this.watchedPool = watched;
            this.contextRank = 0;
            // A composite trial (Trial Swarm) draws the In Progress fight view
            // four separately named monster cards — Beetle, Dragonfly, Wasp,
            // Firefly — none of which is a trial name, so `readTrialTiles` finds
            // no card to draw on and the tab stays blank. When a combat fight is
            // being watched and its encounter has no card of its own, stand a
            // tile in, anchored to the monsters area so its panel sits below the
            // fight, and let the watched pool graft onto it as on the Trials tab.
            if (watched?.encounter && !tiles.some((tile) => encounterOfMonster(tile.name) === watched.encounter)) {
                const monstersArea = root.querySelector('[class*="BattlePanel_monstersArea"]');
                const trialName = (guildTrialDamage.breakdown()?.trialNames || []).find(
                    (candidate) => encounterOf(candidate) === watched.encounter
                );
                if (monstersArea && trialName) {
                    tiles.push({
                        element: monstersArea,
                        name: trialName,
                        level: null,
                        tier: null,
                        kind: 'combat',
                        completed: false,
                        readings: [],
                        signups: null,
                        points: null,
                    });
                }
            }

            // Needed inside the sampling loop as well as the drawing one: the
            // work-ladder tier filing wants a participant count
            const counts = participantCounts();
            for (const tile of tiles) {
                const withPersonal = this._withSocketSkilling(
                    this._withSpectatedPool(tile === owner ? { ...tile, personal } : tile, watched),
                    now
                );
                // A running trial whose cards state nothing is on its first
                // tier, so its readings belong to T1 rather than to no tier at
                // all — which is what the growth fit needs them filed under
                const held = this.record.tiles?.[tileKey(tile)];
                const badge = Number.isFinite(withPersonal.tier) ? withPersonal.tier : held?.tier;
                // Whether the badge has anything banked behind it: an earned
                // badge counts tiers finished, so the pool on screen is one
                // past it; an unearned badge names the tier in progress itself
                const banked =
                    withPersonal.points > 0 ||
                    held?.points > 0 ||
                    Object.values(held?.pointsByTier || {}).some((points) => Number(points) > 0);

                // Which tier a live reading belongs to. The badge counts tiers
                // *finished*, so the pool on screen is the next one along; with
                // no badge yet, a running trial is on its first tier.
                const tilePhase = this._phaseFor(status, withPersonal, held);
                let readingTier = null;
                if (tilePhase === 'live' && withPersonal.readings.length) {
                    // The stream states the tier outright; failing that, the
                    // bar's own target identifies it once the skill's base work
                    // is known — the target moves the moment a tier clears,
                    // where a badge goes stale until the Trials tab is reopened
                    const ladderTier = this._workLadderTier(withPersonal, held, counts);
                    if (Number.isFinite(withPersonal.socketTier)) readingTier = withPersonal.socketTier;
                    else if (Number.isFinite(withPersonal.spectatedTier)) readingTier = withPersonal.spectatedTier;
                    else if (ladderTier !== null) readingTier = ladderTier;
                    else if (Number.isFinite(badge)) readingTier = badge + (banked ? 1 : 0);
                    else if (this._workBase(withPersonal) === null && !banked && !(held?.tiers || []).length) {
                        // Nothing has ever placed this trial on the ladder —
                        // only then may the first-tier rule file the reading.
                        // With a base or an observation in hand and no match
                        // above, filing T1 would contradict the ladder.
                        readingTier = FIRST_TIER;
                    }
                }

                // Which tier the footer's stats describe, stated rather than
                // left to fall out of the reading's tier. They only ever landed
                // on a *live* card with a bar, so a whole skilling trial's worth
                // of Success Rate readings — the input the success-decline model
                // is built from — went into the flat `personal` and never into
                // `personalByTier`, which stayed empty across two exports.
                //
                // A footer read while a tier is filling belongs to that tier; one
                // read after it clears, or on a completed card, belongs to the
                // tier the card has just banked.
                const personalTier =
                    // The socket states the tier its own figures describe
                    (Number.isFinite(withPersonal.socketTier) ? withPersonal.socketTier : null) ??
                    readingTier ??
                    (Number.isFinite(badge) ? Math.max(FIRST_TIER, badge) : null) ??
                    held?.tier ??
                    null;

                const sampled = { ...withPersonal };
                if (readingTier !== null) sampled.readingTier = readingTier;
                if (Number.isFinite(personalTier)) sampled.personalTier = personalTier;

                this.record = recordTileSample(this.record, sampled, now, this.characterId);
            }
            // Persisted at the sampling cadence, never the render cadence: the
            // observer fires on every React burst and this used to write the
            // full record — hundreds of samples per tile — to IndexedDB on
            // each one. Five seconds of samples is the most a crash can lose,
            // which is the sampling interval's own promise anyway.
            if (tiles.length && now - this.lastRecordSaveAt >= SAMPLE_MS) {
                this.lastRecordSaveAt = now;
                this._persistRecord();
            }

            // A live reading on a real trial card is evidence a trial is running,
            // and the panel is only allowed to *veto* it. Requiring the header to
            // say "In Progress" as well meant auto-record never armed: the
            // header is on the Trials tab and the readings are on the In
            // Progress one, so the two conditions were rarely true at once.
            //
            // What made that requirement necessary in the first place — a guild
            // XP bar read as a trial card on the Overview tab — is closed twice
            // over now, by `isTrialName` matching a card's whole name and by
            // `onTrialTab` refusing a tab that is legibly something else.
            const livePhase = live ? this._phaseFor(status, live, this.record?.tiles?.[tileKey(live)]) : null;
            if (live && livePhase !== 'scheduled' && livePhase !== 'completed') {
                guildTrialRecorder.noteActivity('tab-reading', now);
            }
            // A fresh tick off the spectator stream is the strongest evidence a
            // trial is running that this feature has ever had — the fight itself
            // is on the wire — and it arrives on the tab where the game draws no
            // bar for the tab-reading rule to find
            if (watched) guildTrialRecorder.noteActivity('trial-stream', now);

            this._noteLifecycle(status, tiles, now);

            // Which encounters count as a trial fight this week. Pushed rather
            // than pulled so the damage module never imports this one
            this._publishTrialNames();

            // Asked again on every render rather than once at startup: the guild
            // name arrives on socket traffic, which is usually later than this
            // feature's initialisation. Not awaited — the drawing below does not
            // depend on which key the record is stored under, and a render that
            // waited on storage would drop a frame of the tab every time.
            this._adoptGuildName().catch(() => {});

            // Nothing is removed up front. A redraw that tears its own output
            // out of the page and puts it back re-lays the panel out, and the
            // browser answers by putting the scroll back at the top — every five
            // seconds, which is what the reported "keeps scrolling to the top"
            // is. Blocks are matched by key and updated in place instead, and
            // only a block whose trial has gone is removed. See `_placeBlock`.
            const drawn = new Set();
            const timeLeftMs = this._timeLeftMs(root);
            const bonuses = this._payoutBonuses();

            // One analysis per (tile, phase) per pass. The payout loop below
            // used to re-derive the very same figures from the very same
            // record — and an analysis walks up to 800 samples, so every tick
            // and every observer burst paid for the whole arithmetic twice.
            const analyses = new Map();
            const analysisFor = (key, record, participants, phase) => {
                const liveTierFloor = this._liveTierFloor(record);
                const cacheKey = `${key}|${phase ?? ''}|${participants}|${liveTierFloor ?? ''}`;
                if (!analyses.has(cacheKey)) {
                    analyses.set(
                        cacheKey,
                        analyseTrial(record, {
                            participants,
                            timeLeftMs,
                            buildersHallBonus: bonuses.buildersHall.bonus,
                            phase,
                            workBase: this._workBase(record),
                            liveTierFloor,
                            characterId: this.characterId,
                        })
                    );
                }
                return analyses.get(cacheKey);
            };

            if (!tiles.length) {
                // No cards — but the readings did not stop being true when the
                // game tore the DOM that carried them down. The record still
                // holds the finished trial's final figures, so they are drawn
                // from it, plainly marked as finished, until the next trial has
                // cards of its own (the normal path below draws then) or the
                // record empties — a week roll-over, or `_healStaleRecord`
                // archiving when the next cycle reads Scheduled. Render-only:
                // the sampling loop above saw no tiles, so nothing was written.
                if (this._renderLastTrial(root, counts, analysisFor, now)) drawn.add('last-trial');
                if (this._renderPayout(root, this._payoutTrials(status, counts, analysisFor), null, bonuses)) {
                    drawn.add('payout');
                }
                // The archive still has last cycles' figures to show — a trial
                // tab between weeks is exactly when they are asked for
                if (this._renderHistory(root, now, bonuses)) drawn.add('history');
                this._reapBlocks(root, drawn);
                return;
            }

            for (const tile of tiles) {
                const record = this.record.tiles[tileKey(tile)];
                if (!record) continue;

                // The card's own "1/28 signed up" beats the socket count where
                // it exists: it is the number the game is showing the player,
                // and it needs no name-to-hrid match to be believed
                const hrid = matchTrialHrid(tile.name, Object.keys(counts));
                const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
                const tilePhase = this._phaseFor(status, tile, record);
                const analysis = analysisFor(tileKey(tile), record, participants, tilePhase);
                this._learnWorkBase(tile, record, analysis, participants, now);

                // The guild's own fill rate on a trial nobody here joined,
                // measured from when its tier badges were watched changing —
                // the only honest signal such a card gives. See
                // `guild-trial-tier-timing.js` for why the stated points are
                // not one.
                const timing = tierTimingForecast(record, {
                    kind: analysis.kind,
                    participants,
                    workBase: this._workBase(tile),
                    timeLeftMs,
                    now,
                    bankedTiers: analysis.tiersClearedSoFar,
                });

                // What the card itself is labelled with, published on the tile
                // so the tab-wide badge injector can read it: past the level
                // cap the level no longer identifies the tier and the banked
                // count is the better number.
                if (tile.element?.dataset)
                    tile.element.dataset.mwiTrialBanked = String(analysis.tiersClearedSoFar ?? 0);
                this._badgeTile(tile, analysis);

                const key = `tile:${tileKey(tile)}`;
                drawn.add(key);
                // In the live fight the block is a grid item beside the bosses,
                // so it takes a boss card's width rather than a panel's. The
                // sizing has to be part of the base style: `_placeBlock`
                // reapplies the stored `cssText` on every later render, which
                // wipes anything set on the element at placement time.
                const fightGrid = fightMonsterGrid(tile.element);
                const inSkillingRow = !!tile.element?.closest?.('[class*="SkillingInstancePanel_challengeArea"]');
                this._placeBlock(root, key, {
                    // The card the block belongs beside, for the re-anchoring
                    // check below — the game tears cards down and remounts
                    // them at wave boundaries
                    anchored: (block) => blockNearAnchor(block, tile.element, root),
                    // Scoped to this tile's encounter: one measurement must
                    // not dress every combat card
                    html: renderTrialBlock(analysis, participants, breakdownFor(tile.name), {
                        participating: ownParticipation(tile.name),
                        phase: tilePhase,
                        startsInMs: status?.startsInMs ?? null,
                        forecast: this._forecast(tile, analysis, participants, tilePhase, timing),
                        looseForecast: timing,
                        deadlineMs: this._trialBudgetMs(tile.kind, now),
                    }),
                    // Wide enough that a label and a figure fit on one line, and
                    // capped so it cannot stretch a whole panel — the reported
                    // screenshot was this block one card wide and a mile tall
                    // The sidecar's grid column is part of the style string on
                    // purpose: `_placeBlock` reapplies this cssText every pass,
                    // which would wipe a column set only at placement time —
                    // and recomputing it here is what keeps the column right
                    // when a wave boundary changes the boss card count without
                    // displacing the block.
                    style:
                        'position:static; display:block; box-sizing:border-box;' +
                        (fightGrid
                            ? fightSidecarStyle(fightSidecarPlacement(fightGrid))
                            : inSkillingRow
                              ? 'flex:0 1 300px; min-width:170px; max-width:300px; align-self:center; clear:none;'
                              : 'clear:both; min-width:min(260px, 100%); max-width:520px;') +
                        'margin:6px 0 8px; padding:6px 10px; background:rgba(0,0,0,0.25);' +
                        'border-radius:6px; font-size:11px; line-height:1.6;',
                    place: (block) => placeTrialBlock(root, tile.element, block, tile.name),
                });
            }

            // The payout is the *week's*, not this tab's. Summed from the record,
            // which keeps every trial's stated points whichever tab was open when
            // they were read — the two tabs were otherwise drawing the same
            // "Trial payout" title over different totals, because each summed
            // only the cards it could see.
            const trialsForPayout = this._payoutTrials(status, counts, analysisFor);

            if (this._renderPayout(root, trialsForPayout, tiles[0]?.element || null, bonuses)) {
                drawn.add('payout');
            }
            if (this._renderHistory(root, now, bonuses)) drawn.add('history');
            this._reapBlocks(root, drawn);
        } catch (error) {
            console.error('[GuildTrials] Drawing the trial panel failed:', error);
        }
    }

    /**
     * Every trial of the week, as the payout block wants them.
     *
     * From the record rather than from the cards on screen. The In Progress tab
     * shows one running pool and the Trials tab shows all the setup cards, so a
     * payout summed from what is visible said two different things under the
     * same title depending on which tab the reader was on — "banked 2,714" on
     * one and "banked 472" on the other, at the same moment. The record holds
     * every tile's stated points regardless of which tab was open when they were
     * read, which is exactly the sum wanted.
     *
     * @param {Object} status - From `readTrialStatus`
     * @param {Object} counts - Sign-ups per trial hrid
     * @param {Function} analysisFor - The render pass's shared, memoised analyser
     * @returns {Array<Object>} One entry per trial the record knows
     */
    _payoutTrials(status, counts, analysisFor) {
        const trials = [];

        for (const [key, record] of Object.entries(this.record?.tiles || {})) {
            if (!record?.name) continue;

            const hrid = matchTrialHrid(record.name, Object.keys(counts));
            const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
            const analysis = analysisFor(key, record, participants, this._phaseFor(status, record));

            trials.push({
                name: record.name,
                type: record.kind,
                banked: analysis.tiersClearedSoFar,
                projected: analysis.pace?.tiersCleared ?? analysis.tiersClearedSoFar,
                // How far into the tier beyond `projected` the pace reaches by the
                // hour's end, 0..1. Only meaningful under the test-server
                // partial-tier rule, where that leftover progress pays out.
                partialFraction: analysis.pace?.partialFraction ?? 0,
                tierKnown: analysis.tierKnown,
                points: analysis.points,
                pointsByTier: analysis.pointsByTier,
            });
        }

        return trials;
    }

    /**
     * Where the cycle is *for one kind of trial*.
     *
     * A cycle runs the skilling hour and then the combat one, and the header
     * says which it is talking about — "Skilling Trial - In Progress". Applying
     * that phase to every card meant the Trial Chameleon card rendered live rows
     * during the skilling hour: "Rate: measuring…", "Banked: nothing yet — tier
     * 1 in progress", for a trial that had not started.
     *
     * A card of the kind the header names takes the header's phase. A card of
     * the other kind is waiting, unless it has evidence of its own — its own bar
     * moving is worth more than a header about its sibling.
     *
     * @param {Object} status - From `readTrialStatus`
     * @param {Object} tile - The card
     * @returns {string|null} The phase this card is in
     */
    _phaseFor(status, tile, record = null) {
        // The card's own "Completed" badge outranks everything. It is the game
        // stating the outcome of *this* trial, where the header is about
        // whichever one is running now — so after the skilling hour a finished
        // Foraging card kept rendering "Fill rate 52 work/s / Tier clears in
        // 3m" under a header reading "Combat Trial - In Progress". A finished
        // trial shows results, and neither a live set nor a waiting one.
        if (tile?.completed || record?.completed) return 'completed';

        const phase = status?.phase || null;
        // No status header at all is the everyday state of the In Progress tab
        // — the header lives on the Trials tab — and treating it as no phase
        // starved everything downstream that asks "is this live": the
        // first-tier rule never fired, and a live pool's readings were filed
        // under the record's stale badge instead of the tier being fought. A
        // bar on a card that nothing has declared over is a trial running.
        if (!phase) return tile?.readings?.length ? 'live' : null;
        // A header that does not name a kind is the old, single-trial case
        if (!status.kind || status.kind === tile.kind) return phase;

        // The other kind, not yet finished. Its own readings are the only thing
        // that can say it is running while the header is about its sibling
        if (tile.readings?.length) return 'live';
        return 'scheduled';
    }

    /**
     * What tier this trial should reach, with where the number came from.
     *
     * @param {Object} tile - The card
     * @param {Object} analysis - From `analyseTrial`
     * @param {number} participants - Members signed up
     * @returns {Object|null} The forecast
     */
    /**
     * Put the "T17" marker beside the card's own "Lv.260".
     *
     * The tab-wide observer in `guild-credit-value.js` badges every tile
     * summary it sees; this runs on the cards the trials feature is already
     * drawing beside, so the marker arrives with the block rather than waiting
     * for the next mutation — and it carries the banked count, which is what
     * the level cannot say once the level has capped at Lv.300.
     *
     * Idempotent by construction: `renderTierBadge` rewrites the badge already
     * on the line rather than appending a second one, so a card the game
     * re-renders keeps exactly one.
     *
     * @param {Object} tile - The card
     * @param {Object} analysis - From `analyseTrial`
     */
    _badgeTile(tile, analysis) {
        try {
            const element = tile?.element;
            if (!element?.querySelector) return;

            const holdsLevel = (node) => LEVEL_LINE_RE.test(node?.textContent || '');
            const summary =
                element.querySelector('[class*="GuildPanel_tileSummary"]') ||
                [...(element.querySelectorAll('*') || [])].find(
                    (node) => holdsLevel(node) && ![...node.children].some(holdsLevel)
                );
            if (!summary) return;
            renderTierBadge(summary, { bankedTiers: analysis?.tiersClearedSoFar ?? null });
        } catch (error) {
            console.error('[GuildTrials] Badging a tile with its tier failed:', error);
        }
    }

    _forecast(tile, analysis, participants, phase = null, timing = null) {
        try {
            // Scoped exactly as the block is: a Hedgehog forecast must not run
            // on the Chameleon fight's measured DPS
            const breakdown = breakdownFor(tile.name, guildTrialDamage.breakdown?.());
            // The card's own bar first: it covers everybody in the trial, where
            // the attributed figure covers only the fights this client was in
            const measuredDps =
                analysis.kind === 'combat' && Number.isFinite(analysis.rate)
                    ? analysis.rate * 1000
                    : (breakdown?.measured && breakdown.partyDps) || null;

            const forecast = forecastTrial({
                analysis,
                clientData: dataManager.getInitClientData?.() || null,
                name: tile.name,
                participants,
                loadouts: guildLoadoutCapture.seen?.() || [],
                measuredDps,
                // A scheduled trial forecasts from tier 1 with the whole hour
                scheduled: phase === 'scheduled',
            });
            // A trial nobody here joined never streams a bar, so the skilling
            // branch of `forecastTrial` can only ever answer "not projectable"
            // for it — which is why the maintainer's Milking and Woodcutting
            // cards had no expected tier while the joined Alchemy card did.
            // Tier-clear timing is what those cards *can* be projected from,
            // and it stands in wherever it has something to say.
            if ((!forecast || forecast.tier === null) && timing) {
                const fromTiming = tierTimingAsForecast(timing);
                if (fromTiming) return fromTiming;
            }
            // Pushed to the per-player panel, which draws the same conclusion
            // beside the split rather than working it out a second time
            const rank = analysis.kind === 'combat' ? this._contextRank(tile, analysis) : 0;
            if (rank > 0 && rank >= this.contextRank) {
                this.contextRank = rank;
                this.lastForecast = forecast;
                guildTrialScoreboard.noteForecast?.(forecast);
                // What the guild-shareable report needs and cannot work out for
                // itself: which trial this is, what it banked, and how far into
                // the tier it was fighting the hour left it
                guildTrialScoreboard.noteContext?.({
                    trialName: tile.name,
                    tier: analysis.tier,
                    tiersCleared: analysis.tiersClearedSoFar,
                    // Who the estimated split has to account for. Nobody is
                    // dropped for having no captured build; they are listed
                    members: signedUpMembers(tile.name),
                    shortfall: {
                        remaining: analysis.remaining,
                        total: analysis.total,
                        unit: analysis.kind === 'combat' ? 'HP' : 'work',
                    },
                    // The archived cycles, already summarised, so the report's
                    // "Past weeks:" tail needs neither the record nor the store
                    pastWeeks: this._pastWeekSummaries(Date.now()),
                });
            }
            return forecast;
        } catch (error) {
            console.error('[GuildTrials] Forecasting the trial failed:', error);
            return null;
        }
    }

    /**
     * Throw away a record the page itself contradicts.
     *
     * The reported failure, after the storage keys were fixed: the poisoned copy
     * was already on disk and under the *new* guild's own key, so nothing about
     * provenance or keying could reach it. The page could, though — it was
     * saying "Scheduled", "0 pts" on every card and "1/22 signed up" while the
     * block above it claimed 2,880 points and five banked tiers.
     *
     * That contradiction is the signal. A cycle the game calls **scheduled**, on
     * a tab whose cards state nothing at all, cannot also be a cycle with tiers
     * banked in it — so whatever the record holds belongs to a finished cycle
     * and is archived. The same is done for a record whose provenance names
     * another guild, which is the case this can catch on its own.
     *
     * Deliberately not "delete anything that disagrees": a live trial routinely
     * has cards showing 0 pts before the first tier clears, which is why the
     * scheduled phase is required as well.
     *
     * @param {Object} status - From `readTrialStatus`
     * @param {Array<Object>} tiles - This pass's cards
     * @param {number} now - Clock
     */
    _healStaleRecord(status, tiles, now) {
        if (!this.record) return;

        const held = Object.values(this.record.tiles || {});
        if (!held.length) return;

        const provenance = recordProvenance(this.record, {
            guildId: this._guildId(),
            guildName: this.guildName,
        });
        if (provenance === 'foreign') {
            this.record = archiveCycle(this.record, FOREIGN_CYCLE_REASON, now, {
                accuracy: guildTrialDamage.accuracySummary?.({ trace: guildTrialTrace.status?.() ?? null }) || null,
            });
            this.blockHtml.clear();
            return;
        }

        // The game says the next cycle has not started; the record says a cycle
        // is under way. The game is describing what is on screen
        const scheduled = status?.phase === 'scheduled';
        const cardsStateNothing =
            tiles.length > 0 && tiles.every((tile) => !tile.readings.length && !(tile.points > 0));
        const recordClaimsProgress = held.some(
            (tile) => tile.samples?.length || tile.tier || Object.keys(tile.pointsByTier || {}).length
        );

        if (scheduled && cardsStateNothing && recordClaimsProgress) {
            console.warn('[GuildTrials] Archiving a finished cycle: the panel says the next one is scheduled');
            // Summarized before the reset below: `storedStats` outlives a reset
            // by design, but the week-guarded blob behind it is discarded the
            // moment the ladder rolls, so the archive is the last chance to
            // keep this cycle's attribution accuracy
            this.record = archiveCycle(this.record, 'a new cycle is scheduled', now, {
                accuracy: guildTrialDamage.accuracySummary?.({ trace: guildTrialTrace.status?.() ?? null }) || null,
            });
            this.blockHtml.clear();
            guildTrialDamage.reset?.();
            // The one write meant to lose tiles — they have just been archived,
            // and a merge would bring the stored copies back to life
            this._persistRecord({ overwrite: true });
        }
    }

    /**
     * Tell the recorder and the alerts where the cycle is.
     * @param {Object} status - From `readTrialStatus`
     * @param {Array<Object>} tiles - This pass's cards
     * @param {number} now - Clock
     */
    _noteLifecycle(status, tiles, now) {
        // The page first, always. `socketPhase` fills in only where the tab said
        // nothing at all — a trial that started while the guild panel was shut
        // is a real transition and the only place it can be seen is the wire.
        // It never overrides: a stale parse must not un-say what is on screen.
        const phase = status?.phase || this.socketPhase || null;
        const previous = this.phase;
        if (phase && phase !== this.phase) this.phase = phase;

        // A trial going live is the one deterministic start the capture session
        // has: without it the session began at whichever capture happened to be
        // first and expired sixty-five minutes after *that*, which is a clock
        // that can run out in the middle of the next trial. Only a transition
        // counts — a page opened onto a trial already running has `previous`
        // null and must keep the session it just restored, which is this
        // trial's. `noteTrialStart` debounces the rest.
        if (phase === 'live' && previous && previous !== 'live') {
            guildTrialAbilities.noteTrialStart?.(now);
        }

        guildTrialAlerts.noteTrialStatus?.({
            phase,
            startsInMs: status?.startsInMs ?? null,
            trials: tiles.map((tile) => tile.name),
            at: now,
        });
    }

    /** @returns {string|null} The guild's id, from whichever source has it */
    _guildId() {
        return guildXPTracker.getOwnGuildID?.() || dataManager.characterData?.guild?.id || null;
    }

    /**
     * Draw one block, without disturbing the page when it has not changed.
     *
     * The whole of the scroll fix. `innerHTML` is only assigned when the markup
     * actually differs, and an element that is already in the right place is
     * left exactly where it is — so the common case, a five-second sample that
     * moved a figure by a hundred points, touches one text node and nothing
     * else. A block that has to move is moved with the scroll position of every
     * scrollable ancestor recorded and put back, because inserting into a
     * scrolling container is the other half of the same bug.
     *
     * @param {Element} root - The trials root
     * @param {string} key - Stable identity for this block
     * @param {Object} spec - `{html, style, place, onBuild}`; `place` inserts a fresh block
     * @returns {Element} The block
     */
    _placeBlock(root, key, { html, style, place, onBuild, anchored }) {
        const existing = root.querySelector(`.${CSS_CLASS}[data-mwi-block="${key}"]`);

        // Compared against what this drew last time rather than against the
        // element's own `innerHTML`: a block that has had listeners attached to
        // appended children no longer reads back as the markup it was built
        // from, and would therefore look changed on every single pass
        const unchanged = this.blockHtml.get(key) === html;

        if (existing) {
            // The game's own nodes move underneath a block that was placed
            // correctly: cards re-parent as a fresh panel settles, and the
            // boss card remounts at every wave boundary — leaving the block
            // where the old node used to be, which is how the readout ended up
            // below the payout and how the panel order flipped after a tier
            // cleared. Each block states what "still anchored" means for it,
            // and a block that is not is re-placed against the current DOM.
            //
            // Ahead of that: a full-width block that has ended up *inside* a
            // non-wrapping flex row is stealing that row's width and squashing
            // the card beside it (the skilling In Progress tab, where a block
            // placed by the pre-styles fallback squashed the unit icon to ~42px).
            // No block's correct home is ever such a row, so this holds for every
            // block type regardless of its own anchor test, and re-places it out
            // once the game's flex styles have computed.
            // A box gathered into its section's shared row is the common case on
            // the live tab, and it can neither be stuck (the row wraps, so it
            // never squashes a card) nor mis-anchored (its home is that row,
            // guaranteed at placement). Skipping it here avoids a
            // `getComputedStyle` squash probe per box every pass — the bulk of
            // the per-pass forced reflow. Blocks that live loose in the game's
            // own layout (the payout, the In Progress card readouts) still get
            // the full check, which is what re-places one out of a squashing row.
            const inBoxRow = existing.parentElement?.classList?.contains(BOX_ROW_CLASS);
            const isSidecar = existing.dataset?.mwiPlacement === 'row-sidecar';
            if (!inBoxRow && !isSidecar) {
                const stuckInRow = existing.parentElement && isSquashingRow(existing.parentElement);
                if (stuckInRow || (anchored && !anchored(existing))) {
                    withScrollKept(root, () => place(existing));
                }
            }
            if (!unchanged) {
                existing.innerHTML = html;
                this.blockHtml.set(key, html);
                onBuild?.(existing);
            }
            if (existing.style.cssText !== style) existing.style.cssText = style;
            return existing;
        }

        const block = document.createElement('div');
        block.className = CSS_CLASS;
        block.dataset.mwiBlock = key;
        block.style.cssText = style;
        block.innerHTML = html;
        this.blockHtml.set(key, html);
        onBuild?.(block);

        withScrollKept(root, () => place(block));
        return block;
    }

    /**
     * Remove blocks whose trial is no longer on screen.
     * @param {Element} root - The trials root
     * @param {Set<string>} drawn - Keys drawn this pass
     */
    _reapBlocks(root, drawn) {
        // Every block on the page, not only those under the root being drawn
        // into. A tab switch changes which element the root finder answers with,
        // and a block left under the previous one would never be looked at
        // again — it would simply stay on screen, which is what was reported
        const scope = typeof document === 'undefined' ? root : document;
        if (!scope?.querySelectorAll) return;

        for (const block of scope.querySelectorAll(`.${CSS_CLASS}`)) {
            const key = block.dataset?.mwiBlock;
            // A block with no key is from an older build, or from a redraw that
            // failed halfway; either way it is not this pass's and goes
            if (key && drawn.has(key)) continue;
            if (key) this.blockHtml.delete(key);
            block.remove();
        }

        // A section's shared box row that lost its last box is an empty
        // full-width cell left in the tile grid; drop it so it stops reserving
        // a row underneath the tiles
        for (const row of scope.querySelectorAll(`.${BOX_ROW_CLASS}`)) {
            if (!row.querySelector(`.${CSS_CLASS}`)) row.remove();
        }
    }

    /**
     * Active time left in the running trial, from any clock on the tab.
     *
     * The game draws a countdown; when it does, that is the authority. Falling
     * back to "a trial runs an hour, and it started when this script first saw
     * it" would be wrong for every player who opened the tab late, which is most
     * of them — so without a clock on screen there is no pace projection at all.
     *
     * The named status row is tried first and is no longer required: it is as
     * unverified as the tab container was, and it was the only source of a time
     * left, so a wrong guess about it took "On pace for" off the screen with
     * nothing said. {@link findTrialClockMs} looks for the clock instead.
     *
     * @param {Element} root - The trials content element
     * @returns {number|null} Milliseconds, or null when the tab shows no clock
     */
    _timeLeftMs(root) {
        const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
        const statusText = statusRow?.textContent || '';
        // The same refusals the clock finder applies, because the status row
        // earns none of them for free: the Trials tab's header is "Skilling
        // Trial - In Progress Thu 09:00 AM", and 09:00 parses as a nine-minute
        // countdown — which made the pace walk one tier further than the tile's
        // real 5m53s allowed, on that tab only. A bar reading ("15 / 60") is
        // refused for the same reason it is in `findTrialClockMs`.
        const fromStatus =
            statusText.includes('/') || NOT_A_CLOCK_RE.test(statusText) ? null : parseClockMs(statusText);
        if (fromStatus !== null) return Math.min(fromStatus, TRIAL_ACTIVE_MS);

        return findTrialClockMs(root, TRIAL_ACTIVE_MS);
    }

    /**
     * Both payout bonuses, from the best source that has one.
     *
     * The guild's own building levels first — they ride in on guild traffic as
     * `guildBuildingLevelMap`, the data manager captures them off any message
     * that carries one and persists them, and the confirmed rule is 2% per level
     * for both buildings. Failing that, the Builders Hall bonus can be recovered
     * from the cards themselves ({@link module:./guild-trials-math.inferBuildersHallBonus}),
     * because a card states Guild Points for a tier whose base the ladder knows
     * and the ratio between them is the bonus. Nothing fills in for an unknown
     * Treasury, and the block says so rather than quietly paying it as zero.
     *
     * @returns {{buildersHall: Object, treasury: Object}} Both, with their provenance
     */
    _payoutBonuses() {
        const bonuses = readPayoutBonuses();
        if (Number.isFinite(bonuses.buildersHall.bonus)) return bonuses;

        const inferred = inferBuildersHallBonus(
            Object.values(this.record?.tiles || {}).map((tile) => ({
                type: tile?.kind === 'combat' ? 'combat' : 'skilling',
                pointsByTier: tile?.pointsByTier,
            })),
            // The building's own step and ceiling, from the game's data where it
            // is loaded, so a rebalance moves this with it
            bonuses.buildersHall.rules
        );
        if (!inferred) return bonuses;

        return {
            ...bonuses,
            buildersHall: { ...bonuses.buildersHall, level: inferred.level, bonus: inferred.bonus, source: 'cards' },
        };
    }

    /**
     * The payout block: what is banked, and what the current pace would add.
     * @param {Element} root - The trials content element
     * @param {Array<{name: string, type: string, banked: number, projected: number}>} trials - This week's trials
     * @param {Element|null} [firstTile] - The topmost trial card, for placement when there is no status row
     * @param {Object} [payoutBonuses] - From {@link _payoutBonuses}; resolved here when omitted
     * @returns {boolean} Whether a payout block is on screen
     */
    _renderPayout(root, trials, firstTile = null, payoutBonuses = null) {
        if (!trials.length) return false;

        // The In Progress tab is a glance at a running trial, so the token gold
        // valuation and the missing-Treasury nag — both about pricing tokens, not
        // about the run — are held back there and kept for the Trials tab.
        const inProgress = /inProgress/i.test(root?.className || '');

        const bonuses = payoutBonuses || this._payoutBonuses();
        const buildersHallBonus = bonuses.buildersHall.bonus;
        const treasuryBonus = bonuses.treasury.bonus;

        const banked = payoutProjection({
            trials: trials.map((trial) => ({
                ...trial,
                tiersCleared: trial.banked,
                // The card's own figure where there is one, in both units: the
                // Guild Points it states outright — four days of the guild's chat
                // announcements say the sum of exactly these is what is earned —
                // and the base points recovered from it, which is what the token
                // arithmetic runs on. `trialBankedBasePoints` decides, and says so.
                basePointsOverride: trial.points?.source === 'ladder' ? undefined : trial.points?.basePoints,
                guildPointsOverride: trial.points?.guildPoints ?? undefined,
            })),
            buildersHallBonus,
            treasuryBonus,
        });
        // The pace's figure is the banked one plus what the tiers it projects
        // would add, rather than a second ladder walk from scratch. Rebuilding
        // it from the ladder made "on pace" come out *below* "banked" whenever
        // the cards had stated more than the ladder derives, which reads as the
        // trial going backwards.
        const projected = payoutProjection({
            trials: trials.map((trial) => {
                const extraTiers = Math.max(0, (trial.projected ?? trial.banked) - trial.banked);
                const step = EXTRA_TIER_POINTS[trial.type] ?? 0;
                const fromCards = trial.points?.source !== 'ladder';
                const base = trial.points?.basePoints;
                const stated = trial.points?.guildPoints;
                // The pace ends part-way into the tier after `projected`, and that
                // leftover progress pays out (0.5% per 1%, capped at 50%). Size it
                // off that tier's marginal points. Live rule since the guild patch.
                const marginal = tierMarginalPoints(trial.type, (trial.projected ?? 0) + 1) ?? 0;
                const partialBasePoints = partialTierCredit(trial.partialFraction) * marginal;
                return {
                    ...trial,
                    tiersCleared: trial.projected,
                    partialBasePoints,
                    basePointsOverride: fromCards && Number.isFinite(base) ? base + extraTiers * step : undefined,
                    guildPointsOverride:
                        fromCards && Number.isFinite(stated)
                            ? stated + extraTiers * step * (1 + (buildersHallBonus || 0))
                            : undefined,
                };
            }),
            buildersHallBonus,
            treasuryBonus,
        });

        // Which of the three states the banked figure is in. They are three
        // different things and they all used to render as `0`, which is the one
        // reading that is never right.
        const anyTierKnown = trials.some((trial) => trial.tierKnown);
        // A card that states a points figure has already earned it — that is what
        // the chat announcement pays out — so it counts as banked even before
        // this script's own tier-on-screen inference says a tier has completed
        const anyBanked = trials.some(
            (trial) => trial.banked > 0 || Number.isFinite(trial.points?.quoted?.statedPoints)
        );

        const eligible = tokenPayoutLine(
            projected.eligibleTokens,
            'Half the total base points, paid to every member who joined before the week started.',
            { showGold: !inProgress }
        );
        const participant = tokenPayoutLine(
            projected.participantTokens,
            'The eligible payout plus a further 50% of it for participating.',
            { showGold: !inProgress }
        );

        const bankedRow = !anyTierKnown
            ? line(
                  'Guild Points banked',
                  'not known yet',
                  DIM,
                  'Banked points are counted from the tier on screen, and no card seen so far carries one — ' +
                      'the In Progress tab does not show a tier. Open the Trials tab once and this fills in. ' +
                      'It is unknown rather than zero.'
              )
            : !anyBanked
              ? line(
                    'Guild Points banked',
                    'nothing banked yet',
                    DIM,
                    'A trial pays for tiers it has finished. This appears after the first tier completes.'
                )
              : line('Guild Points banked', exact(banked.guildPoints), GOOD, this._pointsProvenance(trials));

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;">Trial payout</div>`,
            bankedRow,
            line('Guild Points on pace', exact(projected.guildPoints), ACCENT),
            line('Tokens, every eligible member', eligible.value, ACCENT, eligible.title),
            line('Tokens, if you took part', participant.value, GOOD, participant.title),
        ];

        // The partial-tier rule (an unfinished tier paying 0.5% per 1% of
        // progress) is folded into the pace and banked figures silently now — the
        // explanatory note it used to print was clutter on the In Progress card.

        // Not a mismatch at all: a total banked across a Builder's Hall upgrade.
        // Points bank live, tier by tier, at the bonus in force when each tier
        // clears — so a guild that levels its Hall mid-trial has a card that is a
        // *mixture* of two bonuses and divides cleanly by neither. Confirmed by
        // the guild it happened to; see `MAX_MID_TRIAL_UPGRADE_LEVELS`
        // Prose for the Trials tab only, like the token gold valuation above:
        // the figures it explains stay on both tabs, but three sentences of
        // ladder provenance are reading matter, not a glance at a running trial
        const upgraded = trials.find((trial) => trial.points?.interpretation === 'mid-trial-upgrade');
        if (!inProgress && upgraded?.points?.quoted) {
            const { tier, statedPoints } = upgraded.points.quoted;
            const derived = upgraded.points.ladder;
            rows.push(
                `<div style="color:${DIM}; margin-top:4px;">` +
                    `${upgraded.name} T${tier} states ${formatWithSeparator(statedPoints)} pts, which is between ` +
                    `the ladder at this guild’s current +${Math.round((buildersHallBonus || 0) * 100)}% and at a ` +
                    'level or two below it — consistent with a Builder’s Hall upgrade during the trial. Points ' +
                    'bank live, so each tier is paid at the bonus in effect when it cleared and the total is a ' +
                    `mixture of the two. The card is used exactly as stated${
                        Number.isFinite(derived) ? `; the ladder’s own base is ${formatWithSeparator(derived)}` : ''
                    }.</div>`
            );
        }

        // A card that reads above the whole-tier total by up to half the next
        // tier's step is the partial-tier rule, not a disagreement — the card is
        // used exactly as stated, and the note that used to spell that out was
        // more clutter than help on the In Progress card, so it is not printed.

        // A genuine mismatch, which is now a much rarer thing to be. The warning
        // this replaces fired on every card of every week and blamed the ladder,
        // when what was actually happening is that a card states *Guild Points*
        // — the ladder's base figure with the Builders Hall bonus already on it.
        // With that understood the two agree exactly, and a disagreement left
        // over is worth reporting again.
        const disagreement = trials.find((trial) => trial.points?.interpretation === 'disagrees');
        if (disagreement?.points?.quoted) {
            const { tier, statedPoints } = disagreement.points.quoted;
            const hallLevel = bonuses.buildersHall.level;
            rows.push(
                `<div style="color:${WARN}; margin-top:4px;">` +
                    `${disagreement.name} T${tier} states ${formatWithSeparator(statedPoints)} pts, which is ` +
                    `neither the running total nor the per-tier step once the Builders Hall bonus ` +
                    `(+${Math.round((buildersHallBonus || 0) * 100)}% at level ${hallLevel || '?'}) is taken off. ` +
                    'The card is used as stated; the tier ladder here needs checking.</div>'
            );
        }

        // Builder's Hall moves the Guild Points themselves, so a level not yet seen
        // is worth flagging. Treasury only prices tokens, and a guild with no
        // Treasury levels adds nothing — the figures are already right at 0 — so its
        // absence is left unflagged rather than nagged about.
        if (!Number.isFinite(buildersHallBonus)) {
            rows.push(
                `<div style="color:${WARN}; margin-top:4px;">` +
                    'No Builder’s Hall level seen, so the Guild Points figures leave that bonus out — ' +
                    `each level adds ${formatPercent(bonuses.buildersHall.rules?.bonusPerLevel)}. ` +
                    'Open the guild Buildings tab once and it will be picked up, or set it in Toolasha settings. ' +
                    'The Guild Points row is still exact: it is what the cards themselves state.' +
                    '</div>'
            );
        }

        if (bonuses.buildersHall.source === 'cards') {
            rows.push(
                `<div style="color:${DIM}; margin-top:4px;">` +
                    `Builder’s Hall read as level ${bonuses.buildersHall.level} ` +
                    `(+${Math.round(buildersHallBonus * 100)}%) from the cards’ own points, ` +
                    'since no building level has arrived on guild traffic yet.</div>'
            );
        }

        // Built as markup rather than inserted straight away: `_placeBlock`
        // compares it with what is already on screen and leaves the page alone
        // when nothing moved, which is what keeps the scroll where the reader
        // put it. The buttons are appended after, since they carry listeners
        // that markup cannot
        this._placeBlock(root, 'payout', {
            // The payout's own placement rule, as a check: under the status
            // row when there is one, else directly above the first card — so a
            // boss card remounting after it can never leave the payout
            // stranded mid-list
            anchored: (block) => {
                const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
                if (statusRow) return statusRow.nextElementSibling === block;
                if (firstTile?.isConnected) {
                    // A combat fight's card lives inside the boss unit grid; a
                    // payout dropped in there becomes a grid item fighting the
                    // DPS sidecar for a cell — and dropped beside the monsters
                    // area it becomes a column between the two fields, pushing
                    // the fight into overflow. Its home is above the whole
                    // battle row, full width.
                    const monstersArea = firstTile.closest?.('[class*="BattlePanel_monstersArea"]');
                    if (monstersArea) {
                        const battleRow = escapeSquashingRows(root, monstersArea);
                        return block.nextElementSibling === battleRow;
                    }
                    return block.nextElementSibling === escapeSquashingRows(root, firstTile);
                }
                return root.firstElementChild === block;
            },
            html: rows.join('') + this._controlsHTML(),
            // Flat: the title, the four figures and the buttons flow on one
            // wrapping line instead of stacking half the panel tall — each
            // line() is a self-sizing chip once the container is a wrapping row
            style:
                'display:flex; flex-wrap:wrap; align-items:center; column-gap:18px; row-gap:2px;' +
                'margin:8px 0 4px; padding:5px 12px; background:rgba(0,0,0,0.25);' +
                'border-radius:6px; font-size:12px; line-height:1.5;',
            place: (block) => {
                // Under the game's own status row when there is one. Otherwise
                // above the first card — but escaping any non-wrapping row it sits
                // in first, so the block takes its own full-width line above the
                // roster instead of squeezing in beside the card (the skilling
                // panel nests the card two rows deep).
                const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
                const monstersArea = firstTile?.closest?.('[class*="BattlePanel_monstersArea"]');
                if (statusRow) {
                    statusRow.insertAdjacentElement('afterend', block);
                } else if (monstersArea?.parentElement && root.contains(monstersArea)) {
                    // Above the whole battle row — the row holding the roster
                    // field and the fight field — never inside it: a payout
                    // inserted beside the monsters area becomes a middle
                    // column, and the fight overflows off the panel's edge
                    block.style.width = '100%';
                    const battleRow = escapeSquashingRows(root, monstersArea);
                    battleRow.insertAdjacentElement('beforebegin', block);
                } else if (firstTile?.isConnected) {
                    block.style.width = '100%';
                    escapeSquashingRows(root, firstTile).insertAdjacentElement('beforebegin', block);
                } else {
                    root.insertAdjacentElement('afterbegin', block);
                }
            },
            onBuild: (block) => this._bindControls(block),
        });

        // Kept while it is on screen: by the time the cycle reads "Completed"
        // the cards have been zeroed and there would be nothing left to report.
        // (The on-screen display no longer has that gap — `_renderLastTrial`
        // redraws the finished figures from the record — but this alert hook
        // still wants them noted while they are live.)
        guildTrialAlerts.notePayout?.({
            guildPoints: banked.guildPoints,
            eligibleTokens: projected.eligibleTokens,
            participantTokens: projected.participantTokens,
        });

        return true;
    }

    /**
     * The week's archived cycles, as summaries the line printer takes.
     *
     * Newest first, because the question is "how did we do lately". The bonuses
     * passed along are the guild's current ones — the token figure derived from
     * them is marked as derived, and `summariseArchivedCycle` refuses to apply
     * them to a cycle archived off another guild's record at all.
     *
     * @param {number} [now] - Clock
     * @param {Object} [bonuses] - From {@link _payoutBonuses}; resolved here when omitted
     * @returns {Array<Object>} One summary per archived cycle
     */
    _pastWeekSummaries(now = Date.now(), bonuses = null) {
        const history = Array.isArray(this.record?.history) ? this.record.history : [];
        if (!history.length) return [];

        const resolved = bonuses || this._payoutBonuses();
        return [...history].reverse().map((cycle) =>
            summariseArchivedCycle(cycle, {
                now,
                buildersHallBonus: resolved.buildersHall.bonus,
                treasuryBonus: resolved.treasury.bonus,
            })
        );
    }

    /**
     * The finished trial's readouts, drawn from the record after the game has
     * torn its cards down.
     *
     * When a trial ends the fight view is dismantled and the cards zeroed, and
     * every block anchored to them goes blank or goes away — while the final
     * Party DPS, the banked tiers, the stated points and the per-player split
     * are all still in persisted state (the trial record, and the recorder's
     * session snapshots). This renders those, headed as the finished trial's
     * results with when they were last read, and stands down by itself the
     * moment the next trial puts cards on screen or the record empties.
     *
     * Render-only, deliberately: a Completed-phase render must never write new
     * samples, and nothing here touches the record or the recorder.
     *
     * @param {Element} root - The trials content element
     * @param {Object} counts - Sign-ups per trial hrid
     * @param {Function} analysisFor - The render pass's shared, memoised analyser
     * @param {number} [now] - Clock
     * @returns {boolean} Whether a last-trial block is on screen
     */
    _renderLastTrial(root, counts, analysisFor, now = Date.now()) {
        const entries = Object.entries(this.record?.tiles || {}).filter(([, record]) => {
            if (!record?.name) return false;
            return Boolean(
                record.samples?.length ||
                record.pointSamples?.length ||
                Number.isFinite(record.tier) ||
                Number.isFinite(record.points) ||
                Object.keys(record.pointsByTier || {}).length
            );
        });
        if (!entries.length) return false;

        // When the figures were last read — the closest thing to an end time
        // the record carries. The trial ended at or after the last reading.
        let lastReadAt = null;
        for (const [, record] of entries) {
            for (const sample of [...(record.samples || []), ...(record.pointSamples || [])]) {
                if (Number.isFinite(sample?.t) && (lastReadAt === null || sample.t > lastReadAt)) {
                    lastReadAt = sample.t;
                }
            }
        }
        const allCompleted = entries.every(([, record]) => record.completed);
        const ago = Number.isFinite(lastReadAt) && now > lastReadAt ? formatEta(now - lastReadAt) : null;
        const when = ago ? ` · ${allCompleted ? 'ended' : 'last read'} ${ago} ago` : '';

        // The per-player split, from the recorder's persisted session. Read
        // back once; until it lands the rows are simply absent rather than
        // promised. Not attributed to a named trial — the snapshot does not
        // say whose fight it was — so it is one section after the trials.
        this._primeLastSession();

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;" ` +
                'title="The trial is over and the game has taken its cards down. These are the final ' +
                'readings this script recorded, kept until the next trial’s cards arrive. Nothing here ' +
                `is live.">Last trial — ${allCompleted ? 'finished' : 'final readings'}${when}</div>`,
        ];
        let anyCombat = false;
        for (const [key, record] of entries) {
            const hrid = matchTrialHrid(record.name, Object.keys(counts));
            const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
            const analysis = analysisFor(key, record, participants, 'completed');
            if (record.kind === 'combat') anyCombat = true;
            rows.push(trialBlockHeading(record.name));
            rows.push(renderTrialBlock(analysis, participants, breakdownFor(record.name), { phase: 'completed' }));
        }
        if (anyCombat) rows.push(...lastTrialPlayerRows(this._lastSessionSnapshot()));

        this._placeBlock(root, 'last-trial', {
            html: rows.join(''),
            style:
                'clear:both; min-width:min(260px, 100%); max-width:520px;' +
                'margin:8px 0 4px; padding:6px 10px; background:rgba(0,0,0,0.25);' +
                'border-radius:6px; font-size:11px; line-height:1.6;',
            place: (block) => root.insertAdjacentElement('beforeend', block),
        });
        return true;
    }

    /**
     * Make sure the recorder's last session has been asked for, once.
     *
     * The recorder's own open session is the freshest answer and free; the
     * persisted one needs an IndexedDB read, which must not happen per render
     * pass — so it is a one-shot, and a session that turns out not to exist is
     * remembered as checked rather than asked for again every tick.
     */
    _primeLastSession() {
        const open = guildTrialRecorder.session;
        if (open?.snapshots?.length) {
            this.lastSession = open;
            return;
        }
        if (this.lastSessionChecked) return;
        this.lastSessionChecked = true;
        // `_forgetCharacter` clears `lastSession` and re-arms this check, but a
        // read already in flight settles afterwards: the arriving character's
        // "Last trial" block then showed the departing character's final
        // readings and player rows
        const characterId = this.characterId;
        Promise.resolve(guildTrialRecorder.loadSession?.())
            .then((session) => {
                if (session && this.characterId === characterId) this.lastSession = session;
            })
            .catch(() => {});
    }

    /**
     * The last snapshot of the recorder session, when it is this week's.
     * @returns {Object|null} A `thinBreakdown` snapshot, or null
     */
    _lastSessionSnapshot() {
        const session = this.lastSession;
        if (!session) return null;
        // Another week's session is another trial's split, however well it kept
        if (Number.isFinite(session.weekStart) && session.weekStart !== this.record?.weekStart) return null;
        const snapshots = Array.isArray(session.snapshots) ? session.snapshots : [];
        return snapshots.length ? snapshots[snapshots.length - 1] : null;
    }

    /**
     * The "Past weeks" block: one compact line per archived cycle.
     *
     * The archive exists because the figures were real when they were taken and
     * a player who wants last cycle's numbers has nowhere else to get them —
     * and until this block, nowhere to read them either. Drawn under everything
     * else on the tab, and not at all when there is no history: an empty header
     * would be a promise about data that does not exist.
     *
     * @param {Element} root - The trials content element
     * @param {number} [now] - Clock
     * @param {Object} [bonuses] - From {@link _payoutBonuses}; resolved here when omitted
     * @returns {boolean} Whether a history block is on screen
     */
    _renderHistory(root, now = Date.now(), bonuses = null) {
        // The In Progress tab is the live fight or the live skilling row; past
        // cycles are the Trials tab's business. On the In Progress view the
        // block landed at the top and was stretched by the view's own layout
        // into an empty box over the live cards.
        if (isInProgressView(root)) return false;
        const summaries = this._pastWeekSummaries(now, bonuses);
        if (!summaries.length) return false;

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;" ` +
                'title="The last few finished cycles, kept when the week rolled over. Newest first. ' +
                '&quot;—&quot; is a figure that never reached this client; a zero is a real result. ' +
                'Token figures are derived from today’s building bonuses, which is what the ~ marks.">' +
                'Past weeks</div>',
        ];
        for (const summary of summaries) {
            const title = summary.reason ? ` title="Archived: ${String(summary.reason).replace(/"/g, '&quot;')}"` : '';
            rows.push(`<div style="color:${DIM};"${title}>${pastWeekLine(summary)}</div>`);
        }

        this._placeBlock(root, 'history', {
            html: rows.join(''),
            style:
                'margin:8px 0 4px; padding:8px 12px; background:rgba(0,0,0,0.25);' +
                'border-radius:6px; font-size:12px; line-height:1.7;',
            place: (block) => root.insertAdjacentElement('beforeend', block),
        });
        return true;
    }

    /**
     * The recorder's controls, and the way to the scoreboard.
     *
     * On the payout block because that is the one part of this feature the
     * player is already looking at while a trial runs. The console helper still
     * works and is still the programmatic path — the button calls the same
     * builder rather than a second copy of it, so the two cannot drift.
     *
     * @returns {string} The buttons, as markup
     */
    _controlsHTML() {
        const recording = guildTrialRecorder.recording;
        const button = (action, label, color, title) =>
            `<button data-action="${action}" title="${title.replace(/"/g, '&quot;')}" ` +
            `style="flex:1 1 auto; cursor:pointer; padding:3px 8px; border-radius:4px; font-size:11px;` +
            `border:1px solid ${color}66; background:transparent; color:${color};">${label}</button>`;

        // How good the recording is, not just that there is one. Only the
        // quality fields ride in the title, never the event count: this markup
        // is compared against the last pass to decide whether the block needs
        // rebuilding, and a figure that moves on every tick would rebuild it on
        // every tick. Gaps and reload stitches change rarely enough to be free.
        const traceQuality = describeTraceStatus(guildTrialTrace.status?.());

        return (
            '<div data-mwi-controls="1" style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">' +
            button(
                'record',
                recording ? '■ Stop recording' : '● Record trial',
                recording ? WARN : GOOD,
                recording
                    ? 'Stop the session and write it down. The export keeps it either way.'
                    : 'Start a session now. One starts by itself when a trial fight or a live reading is seen, ' +
                          'unless that is switched off in settings.'
            ) +
            button('export', '⤓ Export', ACCENT, 'Download everything captured this week as one JSON file.') +
            (config.getSetting('guildTrialDiagnosticTrace', false)
                ? button(
                      'trace',
                      '⤓ Trace',
                      ACCENT,
                      'Download the raw trial combat stream captured this session as gzipped NDJSON. Large.' +
                          (traceQuality ? `\n\n${traceQuality}` : '')
                  )
                : '') +
            button('scoreboard', 'Per-player', ACCENT, 'Damage and healing per player, ranked.') +
            button(
                'abilities',
                'Abilities',
                ACCENT,
                'Each participant’s equipped abilities and party-wide aura coverage, captured one Battle Info at a time.'
            ) +
            button(
                'roster',
                'Roster',
                ACCENT,
                'Open the guild roster — each member’s share of the week’s XP and who has gone quiet.'
            ) +
            button(
                'ledger',
                'Ledger',
                ACCENT,
                'Attendance, contribution shares and attribution accuracy across the archived trial cycles.'
            ) +
            '</div>'
        );
    }

    /**
     * Attach the controls' listeners.
     *
     * Separate from the markup because the markup is compared against the last
     * pass to decide whether the page needs touching at all — and a listener
     * cannot be compared. The recording state is *in* the markup, so pressing
     * Record changes the signature and this runs again with the new label.
     *
     * @param {Element} block - The payout block, freshly built
     */
    _bindControls(block) {
        const on = (action, handler) =>
            block.querySelector(`[data-action="${action}"]`)?.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                handler();
            });

        on('record', () => {
            if (guildTrialRecorder.recording) guildTrialRecorder.stop('button');
            else guildTrialRecorder.start('button');
            this._render(findTrialsRoot());
        });
        on('export', async () => {
            const bundle = await buildTrialExport({ guildName: this.guildName });
            downloadTrialExport(bundle);
        });
        on('trace', async () => {
            await guildTrialTrace.exportTrace();
        });
        on('abilities', () => {
            // The roster and tier feed happens at open — the panel keeps itself
            // current from capture events after that. Only a roster that exists
            // is fed: after the trial ends the fight is torn down and the
            // breakdown has nobody, and feeding the empty list would blank the
            // panel's completed view of the last trial's captures.
            const breakdown = guildTrialDamage.breakdown?.() || {};
            const roster = Object.values(breakdown.roster || {});
            if (roster.length) guildTrialAbilities.setRoster?.(roster);
            if (breakdown.tier !== null && breakdown.tier !== undefined) guildTrialAbilities.setTier?.(breakdown.tier);
            openTrialAbilitiesPanel();
        });
        on('scoreboard', () => guildTrialScoreboard.toggle());
        on('roster', () => guildRosterPanel.toggle());
        on('ledger', () => openTrialLedgerPanel());
    }

    /**
     * The pool reading the spectator stream is carrying, if it is fresh.
     *
     * A guild trial's boss health is the pool, and `guild_battle_updated` states
     * it to the unit on every tick while the In Progress fight view is open —
     * which is a better source than the DOM bar in three ways: it does not wait
     * for a redraw, it survives the card scrolling out of view, and it comes with
     * the tier attached instead of inferred from a badge.
     *
     * Only used while it is *fresh*. A stale pool would keep injecting the last
     * health the fight view showed as though it were still moving, which is a
     * rate of zero on a trial that is running fine.
     *
     * @param {number} now - Clock
     * @returns {Object|null} `{current, max, tier}` or null
     */
    _spectatedPool(now) {
        const pool = guildTrialDamage.breakdown?.()?.pool;
        if (!pool || !Number.isFinite(pool.current) || !Number.isFinite(pool.max)) return null;
        if (!Number.isFinite(pool.at) || now - pool.at > SPECTATED_POOL_FRESH_MS) return null;
        return pool;
    }

    /**
     * The tier the currently-flowing spectator stream states for a trial, or null.
     *
     * `_withSpectatedPool` only grafts the stream's *reading* onto a card that has
     * no bar of its own (the Trials tab), so on the In Progress fight view — where
     * the card carries the boss bars — the stream's stated tier never reached the
     * analysis, and the card fell back to the badge (a scrape behind) or the work
     * ladder (blind on an unseeded encounter). This hands `analyseTrial` the fresh
     * tier directly, as a floor: it is this render's reading of a live stream, so
     * unlike the persisted `liveTier` it cannot be stale.
     *
     * @param {Object} record - A trial's record, for its encounter
     * @returns {number|null}
     */
    _liveTierFloor(record) {
        const watched = this.watchedPool;
        if (!watched || !watched.encounter || !Number.isFinite(watched.tier)) return null;
        return encounterOf(record?.name) === watched.encounter ? watched.tier : null;
    }

    /**
     * Whether the game has said, outright, that the trials on screen are over.
     *
     * `end_guild_battle` and `end_guild_skilling` are the only certain lifecycle
     * signals this feature has. Everything else is a phase inferred from a
     * header that may name the other kind, or from a badge that may not have
     * been redrawn — and a session left running past the end of a trial is a
     * recording full of an hour of nothing.
     *
     * Every trial on screen has to be over, not merely one of them: a guild runs
     * the two kinds one after the other, and the skilling half ending is not the
     * hour ending.
     *
     * @param {Array<Object>} tiles - This pass's cards
     * @returns {boolean} True when nothing on screen is still running
     */
    _declaredOver(tiles) {
        if (!tiles?.length) return false;

        const combatOver = Boolean(guildTrialDamage.breakdown?.()?.endedAt);
        return tiles.every((tile) =>
            tile.kind === 'combat' ? combatOver : Boolean(guildTrialSkilling.endedFor?.(tile.name))
        );
    }

    /**
     * Put the socket's own reading of a skilling trial on its card.
     *
     * `guild_skilling_updated` states the pool, the tier, the participants and
     * the player's own action figures — every one of which this feature has
     * otherwise been scraping off a tab that has to be open, and every one of
     * which has had its own bug. Where it has spoken it is preferred: it is the
     * game's own statement, it carries the tier rather than requiring a badge
     * plus an assumption, and its personal figures arrive already attached to
     * the tier they describe.
     *
     * The DOM stays underneath all of it. Whether these messages reach a client
     * that is not looking at the trial is not something the capture can answer,
     * so this is a bonus signal and never a replacement: no socket update, and
     * the card is exactly as well served as it was.
     *
     * @param {Object} tile - A card from `readTrialTiles`
     * @param {number} now - Clock
     * @returns {Object} The card, with whatever the socket could add
     */
    _withSocketSkilling(tile, now) {
        if (tile.kind !== 'skilling') return tile;

        const ended = guildTrialSkilling.endedFor?.(tile.name) || null;
        const update = guildTrialSkilling.forTrial?.(tile.name, now) || null;
        if (!update && !ended) return tile;

        const next = { ...tile };

        // The game says it is over, and says what it banked. `end_guild_skilling`
        // arrived with tier 9 while tier 10 was in progress, which is the game's
        // own confirmation that a stated tier counts what is finished
        if (ended) {
            next.completed = true;
            if (Number.isFinite(ended.tier)) next.tier = ended.tier;
        }

        if (!update) return next;

        // The pool, to the unit. A card the game is already drawing a bar on
        // keeps its own numbers, so the two sources cannot disagree on screen
        if (update.reading && !tile.readings?.length) next.readings = [{ ...update.reading }];
        if (Number.isFinite(update.tier)) {
            next.socketTier = update.tier;
            // The pool the tier was stated with. A stated tier is only good
            // for as long as this is the bar's target — the target changes the
            // moment a tier clears, and a `liveTier` kept past that point is
            // the previous tier's answer wearing this one's label
            next.socketTierTarget = Number.isFinite(update.reading?.max) ? update.reading.max : null;
        }

        // The per-tier personal figures, which is what the DOM footer was read
        // for — and these come with their tier attached rather than inferred
        if (Object.keys(update.personal || {}).length) {
            next.personal = { ...(tile.personal || {}), ...update.personal };
        }
        return next;
    }

    /**
     * The learned first-tier total for a tile's skill or encounter.
     *
     * Keyed by the trial as the card names it — `Crafting` and the socket's
     * `/guild_skilling/crafting` both lower-case to `crafting`, and a combat
     * card's `Trial Chameleon` keys as itself. For a skilling trial the figure
     * is the skill's first-tier work; for combat it is the encounter's
     * first-tier boss health (Trial Chameleon's 550,000).
     *
     * @param {{kind: string, name: string}} tile - A card or a tile record
     * @returns {number|null} The base total, or null when it has not been learned
     */
    _workBase(tile) {
        if (tile?.kind !== 'skilling' && tile?.kind !== 'combat') return null;
        const key = String(tile?.name || '')
            .trim()
            .toLowerCase();
        const base = this.workBases[key]?.baseWork ?? DEFAULT_WORK_BASES[key];
        return Number.isFinite(base) && base > 0 ? base : null;
    }

    /**
     * The tier a live skilling bar's own target identifies, if it does.
     *
     * The participant count is resolved the way the drawing loop resolves it —
     * the card's own sign-up figure first, the tracker's sign-up sheet
     * otherwise — because the work formula needs the same count the analysis
     * uses everywhere else. The base is the learned one where the store has
     * it, and otherwise backed out of this trial's own filed observations, the
     * same way `analyseTrial` resolves it — so a record that once filed a tier
     * correctly keeps filing later tiers correctly as they clear.
     *
     * @param {Object} tile - The card, with any socket reading already folded in
     * @param {Object|null} held - The tile's stored record
     * @param {Object} counts - Sign-ups per trial hrid, from `participantCounts`
     * @returns {number|null} The tier, or null when the target fits no tier
     */
    _workLadderTier(tile, held, counts) {
        const kind = tile?.kind === 'combat' ? 'combat' : tile?.kind === 'skilling' ? 'skilling' : null;
        if (!kind) return null;

        const hrid = matchTrialHrid(tile.name, Object.keys(counts || {}));
        const participants = tile.signups?.signed ?? held?.signups?.signed ?? (hrid ? counts[hrid] : 0);
        // Tier-1 observations are excluded for the same reason `analyseTrial`
        // excludes them: they may be the first-tier rule's own filings — and
        // the observation fallback is skilling-only there for the same reason
        // it is here: a combat record's observations mix both bars' ladders
        const stated = (held?.tiers || []).filter((observation) => Number(observation?.tier) >= 2);
        const baseWork =
            this._workBase(tile) ?? (kind === 'skilling' ? baseWorkFromObservations(stated, participants, kind) : null);
        if (!Number.isFinite(baseWork) || baseWork <= 0) return null;

        // A combat card's second bar is the tier's own level-scaled pool and
        // needs no participant count; the first bar (boss health, participant-
        // scaled) is the fallback anchor, as in `analyseTrial`
        const poolTarget = kind === 'combat' && Number.isFinite(tile.readings?.[1]?.max) ? tile.readings[1].max : null;
        const fromPool =
            poolTarget !== null ? tierFromWorkTarget({ target: poolTarget, baseWork, participants: 0, kind }) : null;
        return fromPool ?? tierFromWorkTarget({ target: tile.readings?.[0]?.max, baseWork, participants, kind });
    }

    /**
     * Learn a trial's first-tier total, the moment all three inputs line up.
     *
     * The tier, the bar's target and the participant count are each on screen
     * at different times, and only a moment that has all three can state the
     * base — `target / (shape(tier) × (1 + 0.01 × p))`, on either kind's
     * ladder. Once learned it identifies the tier from the bar alone — which
     * is what lets a mid-trial join on the In Progress tab know its tier
     * without ever opening the Trials tab. A skilling trial learns its skill's
     * base work; a combat trial learns its encounter's first-tier boss health.
     *
     * Guards, because a wrong base states wrong tiers with confidence:
     *
     * - Only a tier the game stated ('card', 'socket') teaches; the assumed and
     *   the derived rungs must never feed themselves.
     * - Only a *fresh* reading teaches. The record's last target survives tab
     *   switches, and a tier that cleared while the tab was shut would pair the
     *   old target with the new badge.
     * - A base already in hand that explains the current target at any whole
     *   tier is kept: relearning on a stale badge is how a constant drifts.
     *
     * @param {Object} tile - The card
     * @param {Object} record - Its stored record
     * @param {Object} analysis - From `analyseTrial`
     * @param {number} participants - The count the analysis used
     * @param {number} now - Clock
     */
    _learnWorkBase(tile, record, analysis, participants, now) {
        try {
            const kind = tile.kind === 'combat' ? 'combat' : tile.kind === 'skilling' ? 'skilling' : null;
            if (!kind) return;
            if (analysis.tierSource !== 'card' && analysis.tierSource !== 'socket') return;
            if (!Number.isFinite(analysis.tier)) return;

            const lastSample = record?.samples?.[record.samples.length - 1];
            if (!Number.isFinite(lastSample?.t) || now - lastSample.t > WORK_BASE_LEARN_FRESH_MS) return;

            // A combat card's second bar teaches with no participant count at
            // all — it is the tier's level-scaled pool. The first bar (or a
            // skilling bar) is participant-scaled and needs the count.
            const poolTarget = kind === 'combat' ? Number(lastSample?.readings?.[1]?.max) : NaN;
            const usingPool = Number.isFinite(poolTarget) && poolTarget > 0;
            const target = usingPool ? poolTarget : analysis.total;
            if (!Number.isFinite(target)) return;
            if (!usingPool && !(participants > 0)) return;
            const scaledBy = usingPool ? 0 : participants;

            const key = String(tile.name || '')
                .trim()
                .toLowerCase();
            const held = this.workBases[key]?.baseWork;
            if (
                Number.isFinite(held) &&
                tierFromWorkTarget({ target, baseWork: held, participants: scaledBy, kind }) !== null
            ) {
                return;
            }

            const baseWork = baseWorkFromObservations([{ tier: analysis.tier, total: target }], scaledBy, kind);
            if (!Number.isFinite(baseWork) || baseWork <= 0) return;

            this.workBases = {
                ...this.workBases,
                [key]: { baseWork, tier: analysis.tier, target: analysis.total, participants, learnedAt: now },
            };
            saveWorkBases(this.workBases).catch(() => {});
        } catch (error) {
            console.error('[GuildTrials] Learning a work base failed:', error);
        }
    }

    /**
     * Whether a card is the one the watched figures belong to.
     *
     * Ranked rather than decided, because the guild-report context is pushed
     * once per combat card and the last one used to win — which on a two-combat
     * week meant the alphabetically-later trial narrated somebody else's fight.
     * A watched identity outranks everything; failing that, the card with live
     * readings; failing that, the card that has actually banked something.
     *
     * @param {Object} tile - The card
     * @param {Object} analysis - From `analyseTrial`
     * @returns {number} 0 when it has no claim at all
     */
    _contextRank(tile, analysis) {
        const watched = this.watchedPool?.encounter || null;
        if (watched) return encounterOf(tile.name) === watched ? 3 : 0;
        if (tile.readings?.length) return 2;
        return analysis?.tiersClearedSoFar > 0 ? 1 : 0;
    }

    /**
     * Put the watched pool on the combat card that has no reading of its own.
     *
     * Additive only: a card the game is already drawing a bar on keeps its own
     * numbers, so the two sources can never disagree on screen. What this covers
     * is the Trials tab, where the combat card carries a level and no bar at all
     * and every projection therefore said "measuring…" for the whole hour.
     *
     * @param {Object} tile - A card from `readTrialTiles`
     * @param {Object|null} pool - From {@link _spectatedPool}
     * @returns {Object} The card, with the reading attached when it had none
     */
    _withSpectatedPool(tile, pool) {
        if (!pool || tile.kind !== 'combat' || tile.readings?.length) return tile;
        // The reading belongs to the encounter that was watched and to no other.
        // A week with two combat trials has two barless cards, and standing in
        // for both put a Chameleon fight's pool on the Hedgehog card — which
        // then reported it under Hedgehog's name, tier ladder and banked count
        if (!pool.encounter || encounterOf(tile.name) !== pool.encounter) return tile;

        return {
            ...tile,
            readings: [{ current: pool.current, max: pool.max }],
            spectatedTier: Number.isFinite(pool.tier) ? pool.tier : null,
            // The stream states the tier the same way the skilling socket does
            // (`new_battle.tier`), and it is persisted the same way — as
            // `liveTier`, paired with the boss health it was stated for, so it
            // expires the moment a cleared tier moves the bar's maximum on.
            // Without this a spectated combat trial's stated tier reached the
            // observation filing and never the analysis, and the card read
            // "tier not seen yet" through a fight whose tier was on the wire.
            ...(Number.isFinite(pool.tier)
                ? { socketTier: pool.tier, socketTierTarget: Number.isFinite(pool.max) ? pool.max : null }
                : {}),
        };
    }

    /**
     * Where the banked points figure came from, for the tooltip.
     * @param {Array<Object>} trials - This week's trials, as `_render` built them
     * @returns {string} A sentence
     */
    _pointsProvenance(trials) {
        const sources = new Set(trials.map((trial) => trial.points?.source).filter(Boolean));
        const cards =
            'Summed from the points each trial card states — the guild’s own end-of-trial announcement is ' +
            'the sum of exactly these figures, so this is the number that will be paid. They are Guild ' +
            'Points, with the Builder’s Hall bonus already in them; the token rows divide it back out.';

        if (sources.has('game') && sources.size === 1) return cards;
        if (sources.has('game') || sources.has('mixed')) {
            // Two things put a trial in `mixed`, and both are worth a sentence:
            // a card that was never on screen, and a card whose Guild Points are
            // exact but whose *base* had to come off the ladder because the
            // total was banked across a Builder's Hall upgrade
            const upgraded = trials.some((trial) => trial.points?.interpretation === 'mid-trial-upgrade');
            return (
                `${cards} Part of this total is derived from the tier ladder instead — for trials whose card ` +
                'was never on screen' +
                (upgraded
                    ? ', and for the base points behind a card banked across a Builder’s Hall upgrade, which ' +
                      'divides cleanly by neither bonus'
                    : '') +
                '.'
            );
        }
        return (
            'Derived from the tier ladder — 200 + 100 per extra tier for skilling, 400 + 200 for combat, ' +
            'times the Builder’s Hall bonus. Open the Trials tab and the game’s own “N pts” is used instead.'
        );
    }

    /** Tell the damage tracker which encounters this week's combat trials are */
    _publishTrialNames() {
        const names = Object.values(this.record?.tiles || {})
            .filter((tile) => tile?.kind === 'combat' && tile?.name)
            .map((tile) => tile.name);
        guildTrialDamage.setTrialNames(names);
    }

    cleanup() {
        unregisterCommand('Trial Damage');
        unregisterCommand('Start trial capture');
        unregisterCommand('Export trial JSON');
        for (const unregister of this.unregister) unregister();
        this.unregister = [];
        this.timers.clearAll();
        this.samplerId = null;
        this.lastTickAt = 0;
        guildTrialDamage.cleanup();
        guildTrialSkilling.cleanup();
        guildTrialStatsModal.cleanup();
        guildTrialRecorder.cleanup();
        // Listeners only; the trace's own memory is stood down by disable(),
        // which is async and so cannot run from this synchronous teardown
        guildTrialTrace.cleanup?.();
        guildTrialAbilitiesFeature.cleanup();
        guildTrialScoreboard.close();
        // Started from `initialize()` and stopped nowhere else: `_forgetCharacter`
        // calls `reset()`, which drops the pending start timer but keeps the chat
        // listener on purpose. With the feature switched off that listener stayed
        // up, so a guild-chat line could still raise a "trial has begun" alert for
        // a feature the player had turned off.
        guildTrialAlerts.cleanup?.();
        // Before the capture's own teardown: the skills tracker's `offCaptured`
        // handle is a subscription *to* `guildLoadoutCapture`, so it gives it
        // back while there is still something to give it back to. Nothing else
        // called this — the switch path uses `forget()`, which keeps the
        // `profile_shared` listener alive on purpose, so turning Guild Trials
        // off mid-session left the tracker recording with the very path that
        // kept its captures fresh now gone.
        guildMemberSkills.cleanup();
        guildLoadoutCapture.cleanup();
        this.blockHtml.clear();
        document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
        // In-memory only: the persisted copy stays, and the next initialize
        // reads it back
        this.workBases = {};
        this.lastSession = null;
        this.lastSessionChecked = false;
        this.initialized = false;
    }
}

const guildTrials = new GuildTrials();

export default {
    name: 'Guild Trials',
    initialize: () => guildTrials.initialize(),
    // Async because the diagnostic trace has to flush the departing character's
    // pending lines under their keys and empty its memory before the arriving
    // character's initialize() reads their own manifest — a trace left in hand
    // makes `_restore()` short-circuit and the two characters share one trace.
    cleanup: async () => {
        try {
            guildTrials.cleanup();
            await guildTrialTrace.disable?.();
        } catch (error) {
            console.error('[Guild Trials] Disable failed part-way:', error);
        } finally {
            guildTrials.initialized = false;
        }
    },
};

export { guildTrials };
