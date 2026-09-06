/**
 * What the task board has actually paid out.
 *
 * Nothing in this script recorded a finished task. The reroll tracker records
 * what a task cost to look at, the statistics panel reads the board as it stands
 * this second, and both of them forget a task the moment it leaves the board —
 * which is the moment it is worth remembering, because that is when it pays. So
 * the Task Tokens tile could say what the board *will* be worth and could not
 * say what an hour of tasks *is* worth. This is the missing half.
 *
 * ## What counts as a completion
 *
 * A task leaves the board three ways, and only one of them is income:
 *
 * - **Claimed.** The server sends the quest back with
 *   `/quest_status/claimed`, and `data-manager` drops claimed quests from
 *   `characterQuests` on the strength of exactly that field — so it is the one
 *   signal here with a second witness in the codebase. That is a completion.
 * - **Discarded.** The trash can. The quest leaves in_progress without ever
 *   being claimed, and pays nothing.
 * - **Rerolled.** The quest *keeps its id* and gets a new monster or action, a
 *   new goal and new rewards, with `coinRerollCount`/`cowbellRerollCount` one
 *   higher. It never leaves in_progress, so a tracker watching only for
 *   disappearance would count the reroll as a completion and then count the
 *   real completion again later.
 *
 * Only the claim is recorded. Nothing is inferred from a quest that merely
 * vanishes: a claim always arrives as a message while the script is listening,
 * and the live map is memory-only, so a quest that disappears across a reload
 * has no snapshot to be inferred from anyway. Inference would buy nothing and
 * would risk booking a trashed task as income.
 *
 * ## Why the rates are wall-clock
 *
 * A completion carries no duration. The time a task took is the time between
 * getting it and turning it in, which includes every hour the tab was shut, and
 * nothing cheap distinguishes those from the hours spent working on it — the
 * only per-task duration in the codebase comes out of `calculateTaskProfit`,
 * which is a market pass per task. So the rate is measured between the first and
 * last completion in the window and is labelled as wall-clock wherever it is
 * shown. The clock starts at the first completion, so its rewards are not
 * counted: n completions span n-1 intervals, and dividing all n by that span is
 * how a fresh pair of tasks reads as double the rate it really is.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { createChunkedHistory } from '../../utils/chunked-history.js';

const STORE_NAME = 'rerollSpending';

/**
 * One record per ISO week.
 *
 * Completions are rare — a handful a day at the very most — so an hourly or
 * daily record would be one key per entry, which is the key explosion that the
 * chunking exists to avoid. Eight weekly records per character is the whole
 * history.
 */
const RECORD_PREFIX = 'taskCompletionRec';

const TASK_CATEGORY = '/quest_category/random_task';
const STATUS_IN_PROGRESS = '/quest_status/in_progress';
const STATUS_CLAIMED = '/quest_status/claimed';
const MONSTER_QUEST_TYPE = '/quest_type/monster';
const COIN_HRID = '/items/coin';
const TOKEN_HRID = '/items/task_token';

/** How much history is kept */
export const WINDOW_WEEKS = 8;
const WINDOW_MS = WINDOW_WEEKS * 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The ISO week a timestamp falls in, as a sortable id.
 *
 * ISO rather than "seven days from January 1st", because the record key is the
 * only thing that says which entries belong together and a week that shifts
 * between years would split one week's entries across two records. UTC, for the
 * reason `timeChunkId` is UTC: a key written in one timezone has to be found
 * again from another.
 *
 * @param {number} t - Milliseconds since the epoch
 * @returns {string} `YYYY-Www`
 */
export function weekChunkId(t) {
    const date = new Date(Number.isFinite(t) ? t : 0);
    const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // Monday = 0; the Thursday of a week is what names its year
    thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);

    const isoYear = thursday.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);

    const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * What a quest's rewards are, split into the two currencies and everything else.
 *
 * The rewards are JSON on the wire. A payload that will not parse is reported
 * and treated as no rewards rather than dropping the completion — that a task
 * was finished is worth recording even when what it paid cannot be read.
 *
 * @param {string} itemRewardsJSON - The quest's `itemRewardsJSON`
 * @returns {{coins: number, tokens: number, items: Array<{itemHrid: string, count: number}>}}
 */
export function parseRewards(itemRewardsJSON) {
    const result = { coins: 0, tokens: 0, items: [] };
    if (!itemRewardsJSON) return result;

    try {
        const rewards = JSON.parse(itemRewardsJSON);
        for (const reward of Array.isArray(rewards) ? rewards : []) {
            const count = Number(reward?.count) || 0;
            if (reward?.itemHrid === COIN_HRID) result.coins += count;
            else if (reward?.itemHrid === TOKEN_HRID) result.tokens += count;
            else if (reward?.itemHrid) result.items.push({ itemHrid: reward.itemHrid, count });
        }
    } catch (error) {
        console.error('[TaskCompletionTracker] A task’s rewards could not be read:', error);
    }

    return result;
}

/**
 * What a task is called and which skill it belongs to.
 *
 * Resolved at capture rather than at display: an hrid is stable but the name
 * beside it comes from client data that may not be loaded when the history is
 * read back, and a completion list of raw hrids is not a list anyone reads.
 *
 * @param {Object} quest - A quest record
 * @returns {{name: string, category: string, taskHrid: string}}
 */
export function taskIdentity(quest) {
    const clientData = dataManager.getInitClientData?.() || null;
    const monsterHrid = quest?.monsterHrid || '';
    const actionHrid = quest?.actionHrid || '';

    if (quest?.type === MONSTER_QUEST_TYPE || monsterHrid) {
        const name = clientData?.combatMonsterDetailMap?.[monsterHrid]?.name || monsterHrid.split('/').pop() || '';
        return { name, category: 'combat', taskHrid: monsterHrid };
    }

    const details = clientData?.actionDetailMap?.[actionHrid];
    const name = details?.name || actionHrid.split('/').pop()?.replace(/_/g, ' ') || '';
    const category = details?.type?.split('/').pop() || actionHrid.split('/')[2] || 'unknown';
    return { name, category, taskHrid: actionHrid };
}

/**
 * The parts of a quest this tracker keeps while it is still on the board.
 *
 * @param {Object} quest - A quest record from the wire
 * @returns {Object} A snapshot
 */
export function questSnapshot(quest) {
    const { name, category, taskHrid } = taskIdentity(quest);
    const { coins, tokens, items } = parseRewards(quest?.itemRewardsJSON);

    return {
        questId: quest?.id,
        name,
        category,
        taskHrid,
        tokens,
        coins,
        items,
        goalCount: Number(quest?.goalCount) || 0,
        currentCount: Number(quest?.currentCount) || 0,
        coinRerollCount: Number(quest?.coinRerollCount) || 0,
        cowbellRerollCount: Number(quest?.cowbellRerollCount) || 0,
    };
}

/**
 * Did this quest id become a different task?
 *
 * A reroll keeps the id and replaces everything the id stood for. Either half is
 * enough on its own: the reroll counts rise on every reroll, and the target
 * changes on all but the unlucky reroll that lands on the same thing again —
 * which the counts still catch.
 *
 * @param {Object} previous - The snapshot held for this id
 * @param {Object} next - The snapshot just seen
 * @returns {boolean} True when the id is now a different task
 */
export function isReroll(previous, next) {
    if (!previous || !next) return false;
    if (next.coinRerollCount > previous.coinRerollCount) return true;
    if (next.cowbellRerollCount > previous.cowbellRerollCount) return true;
    return next.taskHrid !== previous.taskHrid || next.goalCount !== previous.goalCount;
}

/**
 * Entries inside the rolling window, oldest first.
 *
 * @param {Array<Object>} entries - Completions
 * @param {number} now - Milliseconds since the epoch
 * @param {number} [windowMs] - How far back to keep
 * @returns {Array<Object>} The survivors
 */
export function pruneEntries(entries, now, windowMs = WINDOW_MS) {
    const cutoff = now - windowMs;
    return (entries || [])
        .filter((entry) => Number.isFinite(entry?.completedAt) && entry.completedAt >= cutoff)
        .sort((a, b) => a.completedAt - b.completedAt);
}

/**
 * A rate over one window of completions.
 *
 * The clock starts at the first completion in the window and its rewards are
 * excluded — see the module doc. Fewer than two completions, or two that landed
 * in the same millisecond, is no rate at all rather than a very large one.
 *
 * @param {Array<Object>} entries - Completions inside the window, oldest first
 * @returns {{completions: number, tokens: number, coins: number, spanMs: number,
 *   tokensPerHour: number|null, coinsPerHour: number|null, basis: string}}
 */
export function rateOver(entries) {
    const list = entries || [];
    const totals = list.reduce(
        (sum, entry) => ({ tokens: sum.tokens + (entry.tokens || 0), coins: sum.coins + (entry.coins || 0) }),
        { tokens: 0, coins: 0 }
    );

    const summary = {
        completions: list.length,
        tokens: totals.tokens,
        coins: totals.coins,
        spanMs: 0,
        tokensPerHour: null,
        coinsPerHour: null,
        basis: 'wall-clock',
    };

    if (list.length < 2) return summary;

    const spanMs = list[list.length - 1].completedAt - list[0].completedAt;
    summary.spanMs = spanMs > 0 ? spanMs : 0;
    if (spanMs <= 0) return summary;

    // The first completion starts the clock, so it is not one of the ones the
    // clock measures
    const measured = list
        .slice(1)
        .reduce((sum, entry) => ({ tokens: sum.tokens + (entry.tokens || 0), coins: sum.coins + (entry.coins || 0) }), {
            tokens: 0,
            coins: 0,
        });

    const hours = spanMs / HOUR_MS;
    summary.tokensPerHour = measured.tokens / hours;
    summary.coinsPerHour = measured.coins / hours;
    return summary;
}

/**
 * The two windows the tile and the popup report.
 *
 * "Session" is today's completions — the local day, because the player's idea of
 * today is the one on their wall — and "week" is the last seven days rolling.
 *
 * @param {Array<Object>} entries - Completions, any order
 * @param {number} [now] - Milliseconds since the epoch
 * @returns {{session: Object, week: Object, total: Object}}
 */
export function computeRates(entries, now = Date.now()) {
    const sorted = [...(entries || [])]
        .filter((entry) => Number.isFinite(entry?.completedAt))
        .sort((a, b) => a.completedAt - b.completedAt);

    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const dayStart = midnight.getTime();
    const weekStart = now - 7 * DAY_MS;

    return {
        session: rateOver(sorted.filter((entry) => entry.completedAt >= dayStart)),
        week: rateOver(sorted.filter((entry) => entry.completedAt >= weekStart)),
        total: rateOver(sorted),
    };
}

class TaskCompletionTracker {
    constructor() {
        /** questId → the snapshot last seen in progress; memory only, by design */
        this.live = new Map();
        /** The window's completions, oldest first — the truth between writes */
        this.entries = [];
        /** questIds already recorded, so a re-delivered claim is not income twice */
        this.recordedIds = new Set();
        /** Callbacks told about newly-recorded completions, e.g. the claim toast */
        this.subscribers = new Set();
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this._loaded = false;
        /** The write in flight, if any */
        this._pending = null;
        /**
         * Bumped by `forget()` on every character switch. `load()` crosses an
         * IndexedDB read, and a switch landing mid-read must not let the stale
         * continuation overwrite `entries`/`recordedIds` with the departing
         * character's rows once someone new is current — without this, a
         * completion recorded for the arriving character while that read was
         * still in flight would end up saved under the arriving character's
         * key alongside the departing character's entire history.
         */
        this._generation = 0;

        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            legacyKey: (charId) => `taskCompletions_${charId}`,
            groupOf: (entry) => weekChunkId(entry?.completedAt),
            compare: (a, b) => (a?.completedAt || 0) - (b?.completedAt || 0),
            label: 'TaskCompletionTracker',
        });
    }

    /**
     * Start listening. Idempotent — several task features may want the tracker
     * running and none of them owns it.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        try {
            await this._wire();
        } catch (error) {
            // Called from module scope by the overlay tile, so a rejection here
            // would surface as an unhandled promise and take nothing with it
            // but this tracker
            console.error('[TaskCompletionTracker] Starting the tracker failed:', error);
        }
    }

    /**
     * Attach the listeners and read the history.
     * @returns {Promise<void>}
     * @private
     */
    async _wire() {
        const questsHandler = (data) => {
            if (Array.isArray(data?.endCharacterQuests)) this.ingest(data.endCharacterQuests);
        };
        webSocketHook.on('quests_updated', questsHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('quests_updated', questsHandler));

        const initHandler = (data) => {
            // The board as it stands is the baseline the next claim is measured
            // against; nothing in a state is an event
            if (Array.isArray(data?.characterQuests)) {
                this.ingest(data.characterQuests, Date.now(), { record: false });
            }
            this.load();
        };
        dataManager.on?.('character_initialized', initHandler);
        this.unregisterHandlers.push(() => dataManager.off?.('character_initialized', initHandler));

        const switchHandler = () => this.forget();
        dataManager.on?.('character_switching', switchHandler);
        this.unregisterHandlers.push(() => dataManager.off?.('character_switching', switchHandler));

        if (Array.isArray(dataManager.characterQuests) && dataManager.characterQuests.length > 0) {
            this.ingest(dataManager.characterQuests, Date.now(), { record: false });
        }

        await this.load();
    }

    /** Stop listening and drop this character's rows. */
    cleanup() {
        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.forget();
        this.isInitialized = false;
    }

    disable() {
        this.cleanup();
    }

    /** Whose completions, or null before login */
    _charId() {
        return dataManager.getCurrentCharacterId?.() || null;
    }

    /**
     * Read this character's history into memory.
     * @returns {Promise<Array<Object>>} The window's completions, oldest first
     */
    async load() {
        const charId = this._charId();
        if (!charId) return [];

        const generation = this._generation;

        try {
            const stored = await this._store.load(charId);
            // A switch landed while the read was in flight: these rows are the
            // departing character's, and `forget()` has already reset the
            // fields this would otherwise refill for whoever is current now
            if (this._generation !== generation) return [];
            this.entries = pruneEntries(stored, Date.now());
            this.recordedIds = new Set(this.entries.map((entry) => entry.questId));
            this._loaded = true;

            // A load that pruned anything owes storage the pruning
            if (this.entries.length !== stored.length) await this._store.save(charId, this.entries);
        } catch (error) {
            console.error('[TaskCompletionTracker] Reading the completions failed:', error);
        }

        return this._generation === generation ? [...this.entries] : [];
    }

    /**
     * Forget everything held for the character that is leaving.
     *
     * Both halves matter: the departing character's completions must not be
     * served to the arriving one, and the live map must not let a claim by the
     * arriving character be recorded with the departing one's rewards.
     */
    forget() {
        this._generation += 1;
        this.live.clear();
        this.entries = [];
        this.recordedIds = new Set();
        this._loaded = false;
        this._store.forget();
    }

    /**
     * Take a batch of quest records and record whatever finished.
     *
     * A claim is an event, and only `quests_updated` carries events. The board
     * that arrives with the character is a *state*, and if the server ever puts
     * an already-claimed quest in it — nothing stops it; `data-manager` filters
     * claimed quests out of the live list precisely because they turn up — then
     * recording from it would book a task claimed last week as income at the
     * moment of login, again on the next login, and at whatever rate a series of
     * logins implies. So a full board is taken as the baseline the next claim is
     * measured against, and nothing more.
     *
     * @param {Array<Object>} quests - Quests from `characterQuests` or `endCharacterQuests`
     * @param {number} [now] - Milliseconds since the epoch, for tests
     * @param {Object} [options] - How to read this batch
     * @param {boolean} [options.record] - False for a whole-board state rather than an update
     * @returns {Array<Object>} The completions recorded by this batch
     */
    ingest(quests, now = Date.now(), { record = true } = {}) {
        const recorded = [];

        for (const quest of quests || []) {
            if (quest?.category !== TASK_CATEGORY) continue;
            if (quest?.id === undefined || quest?.id === null) continue;

            const snapshot = questSnapshot(quest);

            if (quest.status === STATUS_IN_PROGRESS) {
                // A reroll replaces the task this id stands for; the old
                // snapshot is not a completion and must not become one
                this.live.set(quest.id, snapshot);
                continue;
            }

            const previous = this.live.get(quest.id);
            this.live.delete(quest.id);

            if (quest.status !== STATUS_CLAIMED) continue; // Discarded, or a status we do not know
            if (!record) continue;
            const entry = this._record(snapshot, previous, now);
            if (entry) recorded.push(entry);
        }

        if (recorded.length > 0) {
            this._pending = this._persist();
            this._notify(recorded);
        }
        return recorded;
    }

    /**
     * Be told about completions as they are recorded.
     *
     * Fired synchronously from `ingest`, with the batch that call recorded —
     * almost always one entry, since claims arrive one WebSocket message at a
     * time. A subscriber's own failure is caught here rather than left to
     * escape from inside a WebSocket handler.
     *
     * @param {(entries: Array<Object>) => void} callback
     * @returns {() => void} Unsubscribe
     */
    onCompletion(callback) {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    /**
     * Tell every subscriber about a batch of newly-recorded completions.
     * @param {Array<Object>} entries
     * @private
     */
    _notify(entries) {
        for (const callback of this.subscribers) {
            try {
                callback(entries);
            } catch (error) {
                console.error('[TaskCompletionTracker] A completion subscriber failed:', error);
            }
        }
    }

    /**
     * Wait for the write a completion started.
     *
     * The write is deliberately not awaited where it is started — a WebSocket
     * handler must not be held for a debounce — so this is how anything that
     * needs storage to have caught up asks for it.
     * @returns {Promise<void>}
     */
    async flush() {
        await this._pending;
    }

    /**
     * Turn a claimed quest into a history entry.
     *
     * The claimed record is preferred and the last in-progress snapshot is the
     * fallback: the server has been seen to send the claim back with the rewards
     * intact, but a claim that arrived stripped of them would otherwise book a
     * finished task as having paid nothing.
     *
     * @param {Object} snapshot - The claimed quest
     * @param {Object} [previous] - What was last seen in progress under this id
     * @param {number} now - Milliseconds since the epoch
     * @returns {Object|null} The entry, or null when it was already recorded
     * @private
     */
    _record(snapshot, previous, now) {
        if (this.recordedIds.has(snapshot.questId)) return null;

        const paying = snapshot.tokens > 0 || snapshot.coins > 0 || snapshot.items.length > 0 ? snapshot : previous;
        const source = paying || snapshot;
        const goalCount = snapshot.goalCount || previous?.goalCount || 0;
        const currentCount = Math.max(snapshot.currentCount, previous?.currentCount || 0);

        const entry = {
            questId: snapshot.questId,
            name: source.name || previous?.name || '',
            category: source.category || previous?.category || 'unknown',
            taskHrid: source.taskHrid || previous?.taskHrid || '',
            tokens: source.tokens || 0,
            coins: source.coins || 0,
            items: source.items?.length ? source.items : [],
            goalCount,
            // What the board says was done, kept so a completion can be told
            // apart from whatever a future game update decides "claimed" means
            progressMet: goalCount === 0 || currentCount >= goalCount,
            completedAt: now,
        };

        this.entries.push(entry);
        this.recordedIds.add(entry.questId);
        return entry;
    }

    /**
     * Write the window out, dropping whatever has aged out of it.
     *
     * Not awaited by `ingest`: the write is debounced, so awaiting it would hold
     * a WebSocket handler for the debounce delay. `storage.flushAll()` on unload
     * is what lands the last one.
     * @returns {Promise<void>}
     * @private
     */
    async _persist() {
        const charId = this._charId();
        if (!charId) return;
        // Nothing that follows can be stored, and the entries are still in
        // memory for as long as the tab lives
        if (storage.isQuotaExceeded?.()) return;

        const generation = this._generation;

        try {
            // A save hands the store the whole history, and the store deletes
            // every record the handed list does not mention. Writing before the
            // first read would therefore delete the weeks already on disk, so a
            // claim that beats the initial read waits for it and is merged on
            // top of what came back.
            if (!this._loaded) {
                const pending = this.entries;
                await this.load();
                // A switch landed while this read was in flight. `this.entries`
                // is now whoever is current's, not this call's own character's
                // — grafting `pending` onto it would hand the arriving
                // character a completion that is not theirs, and the save below
                // would write the mix back under *this* call's `charId`, which
                // is the departing character's key gaining an entry that
                // belongs to whoever arrived. Dropping the pending completion
                // here is the same trade the other recorders make on this race
                // (see production-income-recorder.js): a corrupted history is
                // worse than one entry recorded a moment late by the next claim.
                if (this._generation !== generation) return;
                for (const entry of pending) {
                    if (this.recordedIds.has(entry.questId)) continue;
                    this.entries.push(entry);
                    this.recordedIds.add(entry.questId);
                }
            }

            if (this._generation !== generation) return;
            this.entries = pruneEntries(this.entries, Date.now());
            this.recordedIds = new Set(this.entries.map((entry) => entry.questId));
            await this._store.save(charId, this.entries);
        } catch (error) {
            console.error('[TaskCompletionTracker] Storing the completions failed:', error);
        }
    }

    /**
     * The completions this character has on record, oldest first.
     * @returns {Promise<Array<Object>>}
     */
    async getCompletions() {
        if (!this._loaded) await this.load();
        return [...this.entries];
    }

    /**
     * The rates, from what is already in memory.
     *
     * Synchronous because the overlay tile redraws about once a second and
     * cannot await a database; the entries were read at initialization and every
     * completion since has gone through this object.
     *
     * @param {number} [now] - Milliseconds since the epoch
     * @returns {{session: Object, week: Object, total: Object}}
     */
    rates(now = Date.now()) {
        return computeRates(this.entries, now);
    }

    /**
     * Everything the popup shows: the rates, the recent completions and the
     * totals behind them.
     *
     * @param {number} [now] - Milliseconds since the epoch
     * @returns {Promise<{rates: Object, recent: Array<Object>, total: Object}>}
     */
    async summary(now = Date.now()) {
        const entries = await this.getCompletions();
        const rates = computeRates(entries, now);
        return {
            rates,
            recent: [...entries].reverse(),
            total: rates.total,
        };
    }

    /**
     * Forget this character's completions, on disk as well as in memory.
     *
     * The in-memory copy is only dropped once the stored one is gone: a store
     * that could not be listed still holds the records, and forgetting them
     * here would just have the next read bring them back.
     * @returns {Promise<boolean>} Whether the completions are gone; false when
     *   nothing was deleted, which a caller must not report as a clear
     */
    async clear() {
        const charId = this._charId();
        if (!charId) return false;
        const cleared = await this._store.clear(charId);
        if (cleared) this.forget();
        return cleared;
    }
}

const taskCompletionTracker = new TaskCompletionTracker();

export default taskCompletionTracker;
