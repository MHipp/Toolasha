/**
 * Loot log analytics
 *
 * What the actions in the loot log actually paid, added up.
 *
 * Every other XP/hr and gold/hr figure in this script is *predicted*: a rate the
 * action calculators derive from game data and a character's buffs. This is the
 * one view built the other way round — from what the game recorded happening,
 * across the current session and everything storage still holds. When the two
 * disagree the calibration panel says whether the model is wrong; this says what
 * the action paid, which is a different question and the one asked first.
 *
 * Aggregation only. Nothing here touches the DOM, storage or game data — callers
 * resolve names, icons and prices from the hrids on the rows that come back — so
 * the arithmetic can be tested without a page around it.
 */

/** Total Level is the sum of the others; counting it would double every XP figure */
const EXCLUDED_XP_SKILL_HRID = '/skills/total_level';

/**
 * Real elapsed time for one loot log entry.
 *
 * `totalActiveMillis` is what the game's own Duration display uses, and it
 * excludes the gaps where the action was queued but not running — so a run
 * paused overnight does not read as twelve hours of zero income. Older entries
 * predate the field, hence the wall-clock fallback.
 *
 * @param {Object} entry - A loot log entry as the game sent it
 * @returns {number} Milliseconds, or 0 when neither is resolvable
 */
function getEntryDurationMs(entry) {
    if (entry?.totalActiveMillis > 0) return entry.totalActiveMillis;
    if (!entry?.startTime || !entry?.endTime) return 0;
    const ms = new Date(entry.endTime) - new Date(entry.startTime);
    return ms > 0 ? ms : 0;
}

/**
 * Union the current session's entries with stored history, deduplicated by
 * `characterActionId`.
 *
 * The current session wins on overlap: an action still running has its
 * `endTime` and `actionCount` rewritten with every loot message, and the copy
 * in storage is however stale the last debounced write left it.
 *
 * @param {Array} currentEntries - From the live `loot_log_updated` message
 * @param {Array} historicalEntries - From `lootLogHistory`
 * @returns {Array} One entry per action
 */
function mergeCurrentAndHistoricalEntries(currentEntries, historicalEntries) {
    const seen = new Map();
    for (const entry of historicalEntries || []) {
        if (entry?.characterActionId != null) seen.set(entry.characterActionId, entry);
    }
    for (const entry of currentEntries || []) {
        if (entry?.characterActionId != null) seen.set(entry.characterActionId, entry);
    }
    return Array.from(seen.values());
}

/**
 * The grouping key: the action, kept separate per difficulty tier.
 *
 * A dungeon's tiers are the same action hrid at wildly different rates, and
 * folding them into one row would report an average nobody can run.
 *
 * @param {Object} entry - A loot log entry
 * @returns {string}
 */
function buildActionGroupKey(entry) {
    return `${entry.actionHrid}::${entry.difficultyTier ?? ''}`;
}

/**
 * Group loot log entries by action (and difficulty tier) and sum time, actions,
 * drops and XP.
 *
 * Enhancing is excluded, as it is everywhere else in the loot log feature: an
 * enhancing entry's "drops" are the one item that came back out, and averaging
 * that against elapsed time says nothing.
 *
 * @param {Array} entries - Merged current + historical entries
 * @returns {Array<Object>} One row per distinct action/tier combination
 */
function aggregatePivotRows(entries) {
    const rows = new Map();

    for (const entry of entries || []) {
        if (!entry?.actionHrid) continue;
        if (entry.actionHrid === '/actions/enhancing/enhance') continue;

        const key = buildActionGroupKey(entry);
        let row = rows.get(key);
        if (!row) {
            row = {
                actionHrid: entry.actionHrid,
                difficultyTier: entry.difficultyTier ?? null,
                entryCount: 0,
                actionCount: 0,
                totalTimeMs: 0,
                drops: {},
                xpGains: {},
                earliestStartMs: null,
                latestEndMs: null,
            };
            rows.set(key, row);
        }

        row.entryCount += 1;
        row.actionCount += entry.actionCount || 0;
        row.totalTimeMs += getEntryDurationMs(entry);

        for (const [dropHrid, count] of Object.entries(entry.drops || {})) {
            row.drops[dropHrid] = (row.drops[dropHrid] || 0) + count;
        }

        for (const [skillHrid, amount] of Object.entries(entry.xpGains || {})) {
            if (skillHrid === EXCLUDED_XP_SKILL_HRID) continue;
            row.xpGains[skillHrid] = (row.xpGains[skillHrid] || 0) + amount;
        }

        if (entry.startTime) {
            const startMs = new Date(entry.startTime).getTime();
            if (!Number.isNaN(startMs) && (row.earliestStartMs == null || startMs < row.earliestStartMs)) {
                row.earliestStartMs = startMs;
            }
        }
        if (entry.endTime) {
            const endMs = new Date(entry.endTime).getTime();
            if (!Number.isNaN(endMs) && (row.latestEndMs == null || endMs > row.latestEndMs)) {
                row.latestEndMs = endMs;
            }
        }
    }

    return Array.from(rows.values());
}

/**
 * Per-hour rates for one aggregated row.
 *
 * A row with no resolvable elapsed time reports zeroes rather than infinities:
 * an entry the game has not yet given a duration is common (a run that started
 * this second), and one of them must not turn every rate in the table into
 * `Infinity`.
 *
 * @param {Object} row - From `aggregatePivotRows`
 * @param {number} askTotal - Drop value at ask, resolved by the caller
 * @param {number} bidTotal - Drop value at bid
 * @param {Function} [sortIndexOf] - `(skillHrid) => number`, the game's own display order
 * @returns {Object} `{hours, goldPerHourAsk, goldPerHourBid, xpEntries, totalXp, totalXpPerHour}`
 */
function computeRowRates(row, askTotal, bidTotal, sortIndexOf = () => 0) {
    const hours = (row?.totalTimeMs || 0) / 3_600_000;
    const perHour = (amount) => (hours > 0 ? amount / hours : 0);

    const xpEntries = Object.entries(row?.xpGains || {})
        .sort(([a], [b]) => sortIndexOf(a) - sortIndexOf(b))
        .map(([skillHrid, amount]) => ({ skillHrid, amount, perHour: perHour(amount) }));

    // Combat and Labyrinth pay several skills per run, and no single skill's
    // line answers "what is this worth per hour" for them
    const totalXp = xpEntries.reduce((sum, xp) => sum + xp.amount, 0);

    return {
        hours,
        goldPerHourAsk: perHour(askTotal || 0),
        goldPerHourBid: perHour(bidTotal || 0),
        xpEntries,
        totalXp,
        totalXpPerHour: perHour(totalXp),
    };
}

export {
    EXCLUDED_XP_SKILL_HRID,
    getEntryDurationMs,
    mergeCurrentAndHistoricalEntries,
    buildActionGroupKey,
    aggregatePivotRows,
    computeRowRates,
};
