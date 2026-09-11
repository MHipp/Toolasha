/**
 * Everything the gold attribution reads, gathered from where it lives.
 *
 * The arithmetic is in `gold-sources.js` and knows nothing about storage; this
 * is the half that does. Keeping the two apart is what lets a week of play be
 * costed in a test with no IndexedDB, no market and no game.
 *
 * Every source is read defensively and independently: a store that will not
 * answer contributes nothing and leaves its line at zero rather than taking the
 * whole panel down with it. A missing source shows up honestly in the residual,
 * which is the behaviour the panel is built around.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import tradeLedgerStore from '../market/trade-ledger-store.js';
import {
    loadSessions as loadCombatSessions,
    sessionKey,
    MAX_SESSIONS,
} from '../combat-stats/combat-session-history.js';
// These four records are fed in OTHER bundles (the collector in combat, the
// rest in ui — both load after this one), so the direct imports below bind
// bundle-local copies that are stale or empty in the packaged build: the
// collector's never hears the websocket, the task tracker's never hears a
// character switch, the loot log's is frozen at its first read, and the
// enhancement sessions lag a debounce window. The bridge accessors reach the
// live copies at call time; the imports stay as the standalone build's answer,
// where they ARE the live copies.
import {
    combatStatsDataCollector as liveCombatStatsCollector,
    taskCompletionTracker as liveTaskCompletionTracker,
    lootLogHistory as liveLootLogHistory,
    enhancementSessionStore,
} from '../../utils/bundle-bridge.js';
import bundledCombatStatsCollector from '../combat-stats/combat-stats-data-collector.js';
import * as bundledEnhancementStorage from '../enhancement/enhancement-storage.js';
import { createAlchemySessionStore, NO_CHARACTER } from '../alchemy/alchemy-session-store.js';
import bundledLootLogHistory from '../actions/loot-log-history.js';
import bundledTaskCompletionTracker from '../tasks/task-completion-tracker.js';
import networthHistory from './networth-history.js';
import productionIncomeRecorder from './production-income-recorder.js';
import chestOpeningRecorder from './chest-opening-recorder.js';
import combatLootRecorder from './combat-loot-recorder.js';
import itemFlowRecorder from './item-flow-recorder.js';
import { getItemPrice } from '../../utils/market-data.js';
import { calculateCraftingCost, networthUnitValue } from './networth-calculator.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
import { characterKey } from '../../utils/character-key.js';

/**
 * Where the task reroll tracker keeps the tasks that have left the board, and
 * what rerolling each one cost: `HISTORY_KEY` and `STORE_NAME` in
 * `task-reroll-tracker.js`, which `scoped-data-repair.js` names too.
 *
 * Read straight from storage because the tracker lives in the ui bundle with no
 * bridge accessor, and a bundle-local copy never hears a character switch — its
 * record would fold the last character's history into this one's. A plain
 * scoped read, not `readScoped`: that migrates a legacy key when it finds one,
 * and a reader has no business writing.
 */
const REROLL_HISTORY = { base: 'taskRerollHistory', store: 'rerollSpending' };

/** The three alchemy trackers, and the tag the attribution reads them under */
const ALCHEMY_STORES = [
    { kind: 'transmute', baseKey: 'transmuteSessions' },
    { kind: 'decompose', baseKey: 'decomposeSessions' },
    { kind: 'coinify', baseKey: 'coinifySessions' },
];

/**
 * A memoised pricer at the user's net worth pricing mode.
 *
 * The same handful of items are priced hundreds of times over a month of loot
 * entries, and `getItemPrice` goes through the override table and the market
 * reconciliation on every call.
 *
 * @returns {Function} `(itemHrid, enhancementLevel) => number|null`
 */
export function createPricer() {
    const cache = new Map();
    return (itemHrid, enhancementLevel = 0) => {
        if (!itemHrid) return null;
        const key = `${itemHrid}:${enhancementLevel || 0}`;
        if (cache.has(key)) return cache.get(key);
        let price = null;
        try {
            price = getItemPrice(itemHrid, { enhancementLevel: enhancementLevel || 0, context: 'networth' });
        } catch {
            price = null;
        }
        cache.set(key, price);
        return price;
    };
}

/**
 * The deeper pricer for cost-basis lookups, memoised like `createPricer`.
 *
 * Market price first; failing that, an openable's expected value (the chest
 * you consumed was worth what it was expected to pay out); failing that, the
 * material cost of crafting one (the transmuted cape with no market of its own
 * still cost its materials). Still null when none of the three can say — that
 * session or opening stays in the residual, footnoted.
 *
 * @param {Function} price - The plain pricer to try first
 * @returns {Function} `(itemHrid, enhancementLevel) => number|null`
 */
export function createBasisPricer(price = createPricer()) {
    const cache = new Map();
    return (itemHrid, enhancementLevel = 0) => {
        const direct = price(itemHrid, enhancementLevel);
        if (Number.isFinite(direct)) return direct;
        if (!itemHrid) return null;

        // Both fallbacks below price the BASE item: an expected value and a
        // material cost know nothing about enhancement levels, and a +8 input
        // is worth far more than its +0 materials — decompose exists to
        // salvage exactly those. Answering an enhanced lookup with the base
        // figure would silently mis-cost the session, which is worse than the
        // counted "could not be valued" that null produces.
        if ((enhancementLevel || 0) > 0) return null;

        const key = `${itemHrid}:${enhancementLevel || 0}`;
        if (cache.has(key)) return cache.get(key);

        let fallback = null;
        try {
            const details = dataManager.getItemDetails?.(itemHrid);
            if (details?.isOpenable && expectedValueCalculator.isInitialized) {
                const ev = expectedValueCalculator.calculateExpectedValue(itemHrid);
                if (ev?.expectedValue > 0) fallback = ev.expectedValue;
            }
            if (fallback === null) {
                const crafting = calculateCraftingCost(itemHrid);
                if (crafting > 0) fallback = crafting;
            }
        } catch {
            fallback = null;
        }
        cache.set(key, fallback);
        return fallback;
    };
}

/**
 * What net worth carries an item at, for gains the market cannot price.
 *
 * A drop, a task reward or a chest's contents raise net worth by exactly the
 * valuation net worth gives them — the market first, then an openable's
 * expected value, a material cost or a shop price, and the currencies at theirs
 * (coin at face, task tokens at the shop, cowbells at a tenth of a bag). Priced
 * at the market alone, a gain the market had no order for was worth nothing to
 * the attribution while net worth rose by it, and the difference sat in the
 * residual. Memoised like `createPricer`.
 *
 * @param {Function} price - The plain pricer to try first
 * @returns {Function} `(itemHrid, enhancementLevel) => number|null`
 */
export function createHoldingPricer(price = createPricer()) {
    const cache = new Map();
    return (itemHrid, enhancementLevel = 0) => {
        const direct = price(itemHrid, enhancementLevel);
        if (Number.isFinite(direct)) return direct;
        if (!itemHrid) return null;

        const key = `${itemHrid}:${enhancementLevel || 0}`;
        if (cache.has(key)) return cache.get(key);
        let value = null;
        try {
            const held = networthUnitValue(itemHrid, enhancementLevel || 0);
            value = held > 0 ? held : null;
        } catch {
            value = null;
        }
        cache.set(key, value);
        return value;
    };
}

/**
 * Run a read that is allowed to fail.
 * @param {string} what - What was being read, for the log line
 * @param {Function} read - `() => Promise<*>`
 * @param {*} fallback - What to return when it fails
 * @returns {Promise<*>} The value or the fallback
 */
async function attempt(what, read, fallback) {
    try {
        const value = await read();
        return value ?? fallback;
    } catch (error) {
        console.error(`[GoldSources] Reading ${what} failed:`, error);
        return fallback;
    }
}

/**
 * Every alchemy session this character has, from all three trackers.
 * @returns {Promise<Array<Object>>} Sessions, each tagged with its `kind`
 */
async function collectAlchemySessions() {
    const charId = dataManager.getCurrentCharacterId?.() || NO_CHARACTER;
    const sessions = [];

    for (const { kind, baseKey } of ALCHEMY_STORES) {
        const store = createAlchemySessionStore(baseKey, 'GoldSources');
        const rows = await attempt(`${kind} sessions`, () => store.load(charId), []);
        for (const session of rows) if (session) sessions.push({ ...session, kind });
    }

    return sessions;
}

/**
 * Gather every recording the attribution needs.
 *
 * @param {Object} [options] - Overrides
 * @param {Function} [options.price] - A pricer, for tests
 * @returns {Promise<Object>} The `attributeGoldSources` input, minus the window
 */
export async function collectGoldSourceInputs({ price = createPricer() } = {}) {
    const [
        lootEntries,
        productionDays,
        alchemySessions,
        enhancementSessions,
        combatSessions,
        taskCompletions,
        chestDays,
        combatLootDays,
        taskRerolls,
        itemFlowDays,
    ] = await Promise.all([
        attempt(
            'the loot log',
            () => (liveLootLogHistory() || bundledLootLogHistory).getHistoricalEntries(new Set()),
            []
        ),
        attempt('the production recorder', () => productionIncomeRecorder.load(), []),
        collectAlchemySessions(),
        attempt(
            'the enhancement sessions',
            () => (enhancementSessionStore() || bundledEnhancementStorage).loadSessions(),
            {}
        ),
        attempt('the combat session history', () => loadCombatSessions(), []),
        // The task board's own payout record. No new recorder is needed: the
        // completion tracker already stores the reward payload the server
        // itemised at the moment of each claim, per character, on an eight-week
        // rolling window
        attempt(
            'the task completions',
            () => (liveTaskCompletionTracker() || bundledTaskCompletionTracker).getCompletions(),
            []
        ),
        attempt('the chest openings', () => chestOpeningRecorder.load(), []),
        // The battle feed as it was recorded live — same bundle, so this is the
        // copy the recorder writes to
        attempt('the combat loot recorder', () => combatLootRecorder.load(), []),
        attempt(
            'the task reroll history',
            async () => {
                const history = await storage.get(characterKey(REROLL_HISTORY.base), REROLL_HISTORY.store, []);
                return Array.isArray(history) ? history : [];
            },
            []
        ),
        // Same bundle as the recorder, so this is the copy it writes to
        attempt('the item flow recorder', () => itemFlowRecorder.load(), []),
    ]);

    const tradeFills = await attempt(
        'the trade ledger',
        async () => (tradeLedgerStore.isReady?.() ? tradeLedgerStore.getRecords() : []),
        []
    );

    // The run in progress. A session is only archived when the NEXT one starts,
    // so a character deep in one long fight has today's whole loot in no
    // archived session at all — the combat row read 0 while the residual
    // carried the day. Keyed the same way the archive keys, so the moment this
    // run IS archived it stops being counted twice.
    //
    // The last run whatever its age, not `getLatestData`: that withholds a run
    // restored from storage once it has ended, and a run that ended before a
    // reload is not archived until the character next fights — so it was in
    // neither list, and its loot left the combat row for as long as they did
    // something else.
    const liveSession = await attempt(
        'the live combat session',
        async () => {
            const collector = liveCombatStatsCollector() || bundledCombatStatsCollector;
            const live = collector.getLastRun ? collector.getLastRun() : collector.getLatestData?.();
            if (!live?.players?.length) return null;
            const key = sessionKey(live);
            if (key && combatSessions.some((session) => session?.key === key)) return null;
            return live;
        },
        null
    );
    if (liveSession) combatSessions.push(liveSession);

    return {
        series: networthHistory.getHistory?.() || [],
        // The item-level window, which prices each holding at the moment its
        // snapshot was taken and so is the only record here that can separate a
        // price change from a quantity change
        detailSnapshots: networthHistory.detailWindow?.() || [],
        taskCompletions,
        taskRerolls,
        chestDays,
        lootEntries,
        actionType: (actionHrid) => dataManager.getActionDetails?.(actionHrid)?.type || null,
        productionDays,
        alchemySessions,
        enhancementSessions: Object.values(enhancementSessions || {}),
        tradeFills,
        combatSessions,
        combatLootDays,
        itemFlowDays,
        // The bound the archived runs are kept under, carried through so the
        // panel can say how far the combat fallback actually reaches back
        sessionCap: MAX_SESSIONS,
        price,
        basisPrice: createBasisPricer(price),
        holdingPrice: createHoldingPricer(price),
        marketTax: MARKET_TAX,
    };
}
