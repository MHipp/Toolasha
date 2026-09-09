/**
 * Fold a stored player map under the in-memory one, series by series.
 *
 * The union of samples per `category_player`, by timestamp, replayed through
 * {@link pushXP} so the thinning rules hold over the merged series exactly as
 * they would over one recorded in a single tab.
 * @param {Object} stored - key → samples, as read back
 * @param {Object} memory - key → samples, as held
 * @returns {Object} The merged map
 */
function mergePlayerXP(stored, memory) {
    const union = mergeSeriesMaps(
        (sample) => sample?.t,
        (a, b) => a.t - b.t
    )(stored, memory);
    const out = {};
    for (const [key, samples] of Object.entries(union)) {
        if (key.startsWith(RANK_PREFIX)) {
            // Rank readings are a plain list, capped — no XP thinning applies
            out[key] = samples.slice(-RANK_READINGS_KEPT);
            continue;
        }
        const replayed = [];
        for (const sample of samples) pushXP(replayed, sample);
        out[key] = replayed;
    }
    return out;
}

/**
 * Leaderboard XP Tracker
 * Records player XP over time from leaderboard WebSocket messages.
 * Stores history in IndexedDB for XP/hr rate calculations on the Leaderboard panel.
 *
 * Data sources:
 * - leaderboard_updated (non-guild categories) — XP for players on leaderboard
 */

import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import { createPersistedRecord, mergeSeriesMaps } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORE_NAME = 'leaderboardHistory';

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({ store: STORE_NAME, key: 'playerXP', merge: mergePlayerXP, label: 'Leaderboard XP' });

const WINDOW_10M = 10 * 60 * 1000;
const WINDOW_1H = 60 * 60 * 1000;
const WINDOW_1D = 24 * 60 * 60 * 1000;
const WINDOW_1W = 7 * 24 * 60 * 60 * 1000;

/**
 * The board refreshes every 20 minutes. A reading that finds the same value
 * as the last one inside that window has learned nothing — the board has not
 * moved yet — but the same value after a full refresh is a real zero: the
 * player was not doing the skill. Only the second kind is recorded.
 */
const BOARD_REFRESH_MS = 20 * 60 * 1000;

/**
 * Rank readings live beside the value series under their own keys, per board
 * AND per filter — the All / Standard / Ironcow / Casual views of one board
 * rank the same guild differently, and "moved up ten" across two views of
 * the same moment is not a move.
 */
const RANK_PREFIX = 'rank|';
const RANK_READINGS_KEPT = 20;

// ─── History compaction helpers ──────────────────────────────────────────────

function pushXP(arr, d) {
    if (arr.length === 0 || d.xp >= arr[arr.length - 1].xp) {
        arr.push(d);
    } else {
        // A drop is a board that reset (the weekly guild boards start over
        // each week; XP itself never goes down). A series that ignored it
        // stayed stuck at the old high until the new count climbed past it,
        // with no rate in between — start the series over instead.
        arr.splice(0, arr.length, d);
        return;
    }

    if (arr.length <= 2) return;

    let recentLength = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (d.t - arr[i].t <= WINDOW_10M) {
            recentLength++;
        } else {
            break;
        }
    }
    if (recentLength > 2) {
        arr.splice(arr.length - recentLength + 1, recentLength - 2);
    }

    let sameLength = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].xp === d.xp) {
            sameLength++;
        } else {
            break;
        }
    }
    if (sameLength > 2) {
        // An idle run keeps its first and last reading — the span of the zero
        // is the information; the readings in between are not
        arr.splice(arr.length - sameLength + 1, sameLength - 2);
    }

    let oldLength = 0;
    for (let i = 0; i < arr.length; i++) {
        if (d.t - arr[i].t > WINDOW_1W) {
            oldLength++;
        } else {
            break;
        }
    }
    if (oldLength > 0) {
        arr.splice(0, oldLength);
    }
}

function inLastInterval(arr, interval) {
    const now = Date.now();
    const result = [];
    for (let i = arr.length - 1; i >= 0; i--) {
        if (now - arr[i].t <= interval) {
            result.unshift(arr[i]);
        } else {
            break;
        }
    }
    return result;
}

function calcXPH(prev, cur) {
    const tDeltaMs = cur.t - prev.t;
    if (tDeltaMs <= 0) return 0;
    return ((cur.xp - prev.xp) / tDeltaMs) * 3600000;
}

/**
 * Rates for one series, with the provenance a reader needs to trust them.
 *
 * A reading is taken only when the player opens that board, and the board
 * itself moves every 20 minutes — so two readings can be 20 minutes apart or
 * three weeks apart, and "Last XP/h" over three weeks is not the same fact as
 * over 20 minutes. The spans and the count come back alongside the rates so
 * the display can say which it is, and say *why* a cell is empty instead of
 * leaving it blank.
 *
 * @param {Array<{t: number, xp: number}>} arr - One series
 * @returns {{lastXPH: number, lastHourXPH: number, lastDayXPH: number, samples: number,
 *   lastSeenAt: number|null, lastSpanMs: number, daySpanMs: number, dayReadings: number}}
 */
function calcStats(arr) {
    const samples = Array.isArray(arr) ? arr.length : 0;
    const lastSeenAt = samples ? arr[samples - 1].t : null;
    const empty = {
        lastXPH: 0,
        lastHourXPH: 0,
        lastDayXPH: 0,
        samples,
        lastSeenAt,
        lastSpanMs: 0,
        daySpanMs: 0,
        dayReadings: 0,
        lastWeekXPH: 0,
        weekSpanMs: 0,
        weekReadings: 0,
    };
    if (samples < 2) return empty;

    const lastXPH = calcXPH(arr[samples - 2], arr[samples - 1]);
    const lastSpanMs = arr[samples - 1].t - arr[samples - 2].t;

    const last1h = inLastInterval(arr, WINDOW_1H);
    const lastHourXPH = last1h.length >= 2 ? calcXPH(last1h[0], last1h[last1h.length - 1]) : 0;

    // A window holding one reading still knows its rate when the reading
    // before the window carries the same value — an idle run keeps only its
    // first and last reading, so a player idle for three days has no second
    // reading inside the day, and the answer is still a known zero
    const idleInto = (window) =>
        window.length === 1 && arr[samples - 2].xp === arr[samples - 1].xp
            ? [arr[samples - 2], arr[samples - 1]]
            : window;

    const last1d = idleInto(inLastInterval(arr, WINDOW_1D));
    const lastDayXPH = last1d.length >= 2 ? calcXPH(last1d[0], last1d[last1d.length - 1]) : 0;
    const daySpanMs = last1d.length >= 2 ? last1d[last1d.length - 1].t - last1d[0].t : 0;

    const last1w = idleInto(inLastInterval(arr, WINDOW_1W));
    const lastWeekXPH = last1w.length >= 2 ? calcXPH(last1w[0], last1w[last1w.length - 1]) : 0;
    const weekSpanMs = last1w.length >= 2 ? last1w[last1w.length - 1].t - last1w[0].t : 0;

    return {
        lastXPH,
        lastHourXPH,
        lastDayXPH,
        lastWeekXPH,
        samples,
        lastSeenAt,
        lastSpanMs,
        daySpanMs,
        dayReadings: last1d.length,
        weekSpanMs,
        weekReadings: last1w.length,
    };
}

/**
 * Boards whose number is a level rather than XP or points — Total Level only.
 * (The Guilds tab's Level board stays on experience: a guild's XP per hour is
 * a figure people compare; a guild level a week is not.) Its series hold the
 * level.
 * @param {string} category - `leaderboardCategory`
 * @returns {boolean}
 */
export function isLevelBoard(category) {
    return category === 'total_level';
}

/**
 * Boards that reset every week (the Guilds tab's "Weekly …" boards): a week
 * is their whole life, so they read in days and weeks rather than hours.
 * @param {string} category - `leaderboardCategory`
 * @returns {boolean}
 */
export function isWeeklyBoard(category) {
    return typeof category === 'string' && category.includes('weekly');
}

/**
 * The view of a board a message describes: the player boards' Standard /
 * Ironcow tabs (`gameModeFilter`), the guild boards' All / Standard / Ironcow
 * / Casual (`guildTypeFilter`), the trial boards' trial (`trialFilter`).
 * @param {Object} data - A `leaderboard_updated` message
 * @returns {string} A stable key, 'all' when nothing narrows the view
 */
export function filterKeyOf(data) {
    if (!data || typeof data !== 'object') return 'all';
    // Every narrowing the message carries, not a fixed list: the live server
    // has Standard (Steam) / Ironcow (Steam) cohort boards the test server
    // does not, and whatever field names that cohort, it must split the rank
    // series too — ranks read across two views of one board are not moves.
    // `leaderboardType` is included for the same reason; the category and the
    // revision are not filters.
    const parts = Object.keys(data)
        .filter((key) => key === 'leaderboardType' || /Filter$/.test(key))
        .sort()
        .map((key) => [key, data[key]])
        .filter(([, value]) => typeof value === 'string' && value && value !== 'all')
        .map(([, value]) => value);
    return parts.length ? parts.join('/') : 'all';
}

// ─── Tracker class ──────────────────────────────────────────────────────────

class LeaderboardXPTracker {
    constructor() {
        this.initialized = false;
        // `${category}_${playerName}` → [{t, xp}], one record for the whole
        // account, kept so a failed read cannot blank it and a second tab
        // cannot overwrite it
        this.history = createPersistedRecord({
            base: 'playerXP',
            store: STORE_NAME,
            scoped: false,
            empty: () => ({}),
            merge: mergePlayerXP,
            label: 'LeaderboardXPTracker',
        });
        this.lastLeaderboardCategory = null;
        this.lastFilterKey = 'all';
        this.unregisterHandlers = [];
    }

    /** @returns {Object} `${category}_${playerName}` → [{t, xp}] — the live in-memory record */
    get playerXPHistory() {
        return this.history.get();
    }

    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('leaderboardXPTracker', true)) return;

        // Load history BEFORE registering WS listener to avoid race condition where
        // leaderboard_updated arrives before storage resolves, causing history to be overwritten.
        // An unreadable store keeps whatever is in memory rather than blanking it.
        //
        // The ticket is taken before that read and checked after it. A
        // `character_switching` teardown landing inside the read used to leave a
        // live `leaderboard_updated` handler and `initialized = true` behind it,
        // and the switch's own re-initialise then early-returned on that flag —
        // no board reading was recorded again until the page was reloaded.
        const ticket = captureOwner(this);
        await this.history.load();
        if (!stillOurs(ticket)) return;
        // Readings of 0 are the one-column boards as recorded before the value
        // column was read correctly; left in place they would pair with the
        // first real reading into a rate from nothing. Dropped once, here.
        const map = this.history.get();
        let purged = false;
        for (const [key, series] of Object.entries(map)) {
            if (!Array.isArray(series) || !series.length || key.startsWith(RANK_PREFIX)) continue;
            const category = key.slice(0, key.lastIndexOf('_'));
            // Level-board series recorded before they tracked the level hold
            // XP sums — a level is never in the millions
            const xpOnALevelBoard = isLevelBoard(category) && series.some((sample) => sample?.xp > 100000);
            // …and guild Level series briefly recorded as levels hold three-digit
            // numbers where a guild's XP runs to billions
            const levelOnTheGuildBoard = category === 'guild' && series.every((sample) => sample?.xp < 10000);
            if (series.every((sample) => !(sample?.xp > 0)) || xpOnALevelBoard || levelOnTheGuildBoard) {
                delete map[key];
                purged = true;
            }
        }
        if (purged) this.history.save({ overwrite: true });

        this._boundOnLeaderboardUpdated = (data) => this._onLeaderboardUpdated(data);
        webSocketHook.on('leaderboard_updated', this._boundOnLeaderboardUpdated);
        this.unregisterHandlers.push(() => webSocketHook.off('leaderboard_updated', this._boundOnLeaderboardUpdated));

        this.initialized = true;
    }

    /**
     * Handle leaderboard_updated — record player XP for non-guild leaderboard categories.
     * @param {Object} data - leaderboard_updated message
     */
    _onLeaderboardUpdated(data) {
        // Every board is recorded, the guild Level board included — it used to
        // be skipped for having "its own tracker", but that one follows only
        // the player's guild, and the rate columns on the Guilds tab need every
        // guild on the page.

        // The player's own row rides beside the page as `personalRow` — it is
        // not in `rows` unless they happen to rank on that page — and was never
        // recorded, so the one player whose rate you most want had none
        const rows = [...(data.leaderboard?.rows || []), ...(data.personalRow ? [data.personalRow] : [])];
        if (rows.length === 0) return;

        const t = Date.now();
        this.lastLeaderboardCategory = data.leaderboardCategory;
        this.lastFilterKey = filterKeyOf(data);
        let changed = false;

        // The board's number is its LAST value column: Level/Experience boards
        // carry two (level in value1, XP in value2); Guild Points, Buildings,
        // Task Points and the like carry one, in value1 — reading value2 there
        // recorded zero for every row, and those boards never had a rate
        const columns = Array.isArray(data.leaderboard?.columnNames) ? data.leaderboard.columnNames.length : 0;
        // …except Total Level, where the level is the thing: it tracks value1,
        // so its rates are levels per day and week rather than XP per hour
        // over sums in the billions
        const valueField = isLevelBoard(data.leaderboardCategory)
            ? 'value1'
            : columns > 0
              ? `value${columns}`
              : 'value2';

        for (const row of rows) {
            const name = row.name;
            const xp = row[valueField] ?? row.value2 ?? row.value1;
            if (!name || xp === undefined || xp === null) continue;

            const key = `${data.leaderboardCategory}_${name}`;
            if (!this.playerXPHistory[key]) {
                this.playerXPHistory[key] = [];
            }
            const history = this.playerXPHistory[key];
            const last = history[history.length - 1];
            // A changed value is always a reading. An unchanged one is a
            // reading too — a real zero — once the board has had time to move
            // (see BOARD_REFRESH_MS); inside that window it is the same
            // snapshot seen twice and says nothing. Idle players used to
            // never get a second reading at all, and sat on "1 reading"
            // forever instead of the 0/h that was the truth.
            if (!last || last.xp !== xp || t - last.t >= BOARD_REFRESH_MS) {
                pushXP(history, { t, xp });
                changed = true;
            }

            // The rank, per board and filter, whenever it moved or a refresh
            // has passed — what "since the previous reading" compares against
            const rank = Number.isFinite(row.rank) ? row.rank : undefined;
            if (rank !== undefined) {
                const rankKey = `${RANK_PREFIX}${data.leaderboardCategory}|${this.lastFilterKey}_${name}`;
                const ranks = this.playerXPHistory[rankKey] || (this.playerXPHistory[rankKey] = []);
                const lastRank = ranks[ranks.length - 1];
                if (!lastRank || lastRank.r !== rank || t - lastRank.t >= BOARD_REFRESH_MS) {
                    ranks.push({ t, r: rank });
                    if (ranks.length > RANK_READINGS_KEPT) ranks.splice(0, ranks.length - RANK_READINGS_KEPT);
                    changed = true;
                }
            }
        }

        if (changed) {
            this.history.save();
        }
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Get XP/hr stats for a player on the leaderboard.
     * @param {string} playerName
     * @param {string} category - Leaderboard category (e.g. 'foraging', 'enhancing')
     * @returns {{lastXPH: number, lastHourXPH: number, lastDayXPH: number}}
     */
    getPlayerStats(playerName, category) {
        const key = `${category}_${playerName}`;
        return calcStats(this.playerXPHistory[key]);
    }

    /**
     * The rank the row held at the reading before the latest, with when that
     * was — for "moved up two since last time".
     * @param {string} playerName
     * @param {string} category
     * @returns {{rank: number, at: number}|null} Null without two readings carrying ranks
     */
    getPreviousRank(playerName, category, filterKey = this.lastFilterKey || 'all') {
        const series = this.playerXPHistory[`${RANK_PREFIX}${category}|${filterKey}_${playerName}`];
        if (!Array.isArray(series) || series.length < 2) return null;
        const previous = series[series.length - 2];
        return Number.isFinite(previous?.r) ? { rank: previous.r, at: previous.t } : null;
    }

    /**
     * The latest recorded value (XP, points) for a row on a board.
     * @param {string} playerName
     * @param {string} category
     * @returns {number|null}
     */
    getLatestValue(playerName, category) {
        const series = this.playerXPHistory[`${category}_${playerName}`];
        return Array.isArray(series) && series.length ? series[series.length - 1].xp : null;
    }

    /**
     * Get the most recently seen leaderboard category.
     * @returns {string|null}
     */
    getLastLeaderboardCategory() {
        return this.lastLeaderboardCategory;
    }

    disable() {
        noteTeardown(this);
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];
        this.history.reset();
        this.lastLeaderboardCategory = null;
        this.initialized = false;
    }
}

const leaderboardXPTracker = new LeaderboardXPTracker();

export default {
    name: 'Leaderboard XP Tracker',
    initialize: () => leaderboardXPTracker.initialize(),
    cleanup: () => {
        try {
            return leaderboardXPTracker.disable();
        } catch (error) {
            console.error('[Leaderboard XP Tracker] Disable failed part-way:', error);
        } finally {
            leaderboardXPTracker.initialized = false;
        }
    },
};

export { leaderboardXPTracker };
