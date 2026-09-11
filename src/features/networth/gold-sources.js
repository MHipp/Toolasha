/**
 * Gold source attribution.
 *
 * ## The question
 *
 * The net worth history says the account is worth eight hundred million more
 * than it was a week ago. It does not say where that came from, and the honest
 * answer is that nothing in this script knows for certain: net worth is a
 * valuation of everything owned, and it moves when the market moves as readily
 * as when the player earns anything.
 *
 * What the script *does* have is several independent recordings of activity —
 * the loot log, the alchemy session stores, the enhancement sessions, the trade
 * ledger, and (new, alongside this) a per-day production recorder. Each of them
 * can be turned into a number of coins. Adding them up gives a figure that
 * explains *some* of the net worth delta.
 *
 * ## The residual is the point
 *
 * The difference between the measured net worth delta and the sum of the
 * attributed sources is reported as a residual and never distributed across the
 * sources to make the table balance. A residual is real information:
 *
 * - market movement — everything owned repriced, which no activity caused;
 * - activity older than a recorder's coverage window (the loot log keeps five
 *   hundred entries, the combat session history twenty runs);
 * - activity nothing records at all (quests, task rewards, chest opens,
 *   guild contributions, gifts);
 * - valuation drift, because every source here is priced at *today's* market,
 *   not at the price on the day it happened.
 *
 * A balancing plug hides all four. The residual names them.
 *
 * ## Naming them is not the same as reading them
 *
 * A single grey number still cannot say WHICH of the four it was, and two
 * readings alongside it can:
 *
 * - the **category decomposition** ({@link categoryBreakdown}) differences the
 *   per-asset fields of the same two closes the day's delta comes from, so a
 *   day reads "the whole change is item valuation" or "coins arrived from
 *   something nothing records" rather than only "unexplained";
 * - the **market movement estimate** ({@link marketMovement}) uses the
 *   item-level detail snapshots, each of which priced its holdings at the time
 *   it was taken, to measure price drift on stock held through the last day —
 *   the one thing the today's-prices caveat says this cannot see.
 *
 * Neither is subtracted from anything. The residual stays exactly as large as
 * it falls out.
 *
 * ## Combat has three recordings, and no drop is counted twice
 *
 * - the **battle feed, recorded live** (`combat-loot-recorder.js`): every
 *   `new_battle` carries the run's running loot total, and it is read whenever
 *   the game is open, whatever panel is showing;
 * - the **loot log**, the game's own record, but only sent while its Loot & XP
 *   Log panel is open — so often a stale early snapshot of a run, or nothing;
 * - the **archived runs**, the twenty most recent, plus the one in progress.
 *
 * All three are readings of the same running total — the game counts a run's
 * loot from its `combatStartTime`, and the loot log counts an action's drops
 * from the same start — so they are gathered under the run they recorded and
 * each run is costed as the most any of them had seen by each instant (see
 * {@link combatLootByDay}). Whichever saw furthest into a stretch of time
 * answers for it and the others add only what it missed: the live feed for
 * the hours the tab was open, the loot log or archive for the tail after it
 * closed. A run's total is the most one recording saw, never a sum of two.
 *
 * The offline period belongs to the offline row: the Welcome Back summary is
 * the server's own item delta for it, drops and food included, and a combat
 * recording that ran through it carries the same drops. Every combat recording
 * leaves its share of an offline window to that row.
 *
 * Days no recording covers are counted and reported rather than left to look
 * like days of no combat, and what they were worth stays in the residual.
 *
 * ## Days are local
 *
 * A day here means the day the user experienced, midnight to midnight in
 * their own timezone — the same keying the net worth calendar uses. Storage
 * still CHUNKS some histories by UTC day (`utils/chunked-history.js`), but a
 * chunk id is where a record lives, not what day its own timestamp belongs
 * to; every entry is re-bucketed here from its timestamp.
 *
 * ## Purity
 *
 * Nothing here reads storage, the DOM or the market. Prices arrive as a
 * `price(itemHrid, enhancementLevel)` callback and the recordings arrive as
 * plain arrays, so the arithmetic that decides what a week of play was worth is
 * testable without a game running behind it.
 */

/** Milliseconds in a day */
import { localDayKey, localDayStart } from './networth-calendar.js';

/**
 * How many archived combat runs the history keeps, when the caller does not
 * say. The real bound is `MAX_SESSIONS` in `combat-session-history.js`; it is
 * passed in rather than imported so this module stays free of storage, and
 * mirrored here so a caller that forgets still reports an honest limit.
 */
export const DEFAULT_SESSION_CAP = 20;

/** Gathering action types, whose loot log entries are gathered output */
export const GATHERING_ACTION_TYPES = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

/** The attributed sources, in the order the panel stacks and lists them */
export const SOURCE_KEYS = [
    'combat',
    'gathering',
    'production',
    'tasks',
    'chests',
    'alchemy',
    'enhancement',
    'marketplace',
    'offline',
    'consumables',
    'marketTax',
];

/** Display names, and what each one is actually measuring */
export const SOURCE_META = {
    combat: {
        label: 'Combat drops',
        measured: true,
        source: 'Battle feed recorded live, with the loot log and archived runs for what it missed',
        note:
            'Your own share of every combat drop, priced at today’s market. The battle feed is recorded whenever ' +
            'the game is open; the loot log (only sent while its panel is open) and the twenty most recent ' +
            'archived runs fill in what the feed did not see. Each run counts the most any one of them saw, never ' +
            'two added together, and time spent offline is left to the offline row. The live record is ' +
            'forward-only — it starts the day it was installed.',
    },
    gathering: {
        label: 'Gathering',
        measured: true,
        source: 'Loot log history',
        note: 'Milking, foraging and woodcutting drops from the loot log, priced at today’s market.',
    },
    production: {
        label: 'Production',
        measured: false,
        source: 'Production income recorder',
        note:
            'Outputs minus inputs for cooking, brewing, crafting, tailoring and cheesesmithing, ' +
            'estimated from the recipe and the number of actions completed — rare extras are not counted.',
    },
    tasks: {
        label: 'Tasks',
        measured: true,
        source: 'Task completion tracker',
        note:
            'What the task board actually paid: the coins, task tokens and items itemised in the reward payload of ' +
            'every task you claimed while the tracker was listening. Tokens and items are priced at today’s market; ' +
            'the coins are face value. Only the last eight weeks of claims are kept.',
    },
    chests: {
        label: 'Chests opened',
        measured: true,
        source: 'Chest opening recorder',
        note:
            'What came out of the chests you opened, less what the chests themselves were worth. An unopened ' +
            'chest is already priced at its expected value in your net worth, so opening one only moves the ' +
            'account by the difference between what it owed and what it paid: this row is realised luck against ' +
            'expectation, and it is as often negative as positive.',
    },
    alchemy: {
        label: 'Alchemy',
        measured: true,
        source: 'Alchemy session stores',
        note: 'Recorded transmute, decompose and coinify results, less the items and catalysts consumed.',
    },
    enhancement: {
        label: 'Enhancement',
        measured: true,
        source: 'Enhancement sessions',
        note: 'What each item gained in value by being enhanced, less the materials, coins and protections spent.',
    },
    marketplace: {
        label: 'Marketplace',
        measured: true,
        source: 'Trade ledger',
        note: 'Realised profit on your own filled listings, before tax — average-cost matched against recorded buys.',
    },
    offline: {
        label: 'Offline progress',
        measured: true,
        source: 'Production income recorder',
        note: 'The Welcome Back summary, recorded as it arrives. Nothing before the recorder existed can be recovered.',
    },
    consumables: {
        label: 'Consumables',
        measured: true,
        source: 'Combat session history',
        note: 'Food and drinks consumed in recorded combat runs. Only the twenty most recent runs are kept.',
    },
    marketTax: {
        label: 'Market tax',
        measured: true,
        source: 'Trade ledger',
        note: 'Tax paid on every filled sell listing, shown apart from the marketplace profit it is deducted from.',
    },
};

/**
 * The LOCAL calendar day a timestamp falls in — the day the user experienced.
 * Delegates to the net worth calendar's keying so the two can never disagree.
 * @param {number} t - Milliseconds since the epoch
 * @returns {string} `YYYY-MM-DD`
 */
export function localDayId(t) {
    return localDayKey(Number.isFinite(t) ? t : 0);
}

/**
 * Local midnight at the start of a day id.
 * @param {string} dayId - `YYYY-MM-DD`
 * @returns {number} Milliseconds since the epoch
 */
export function dayStart(dayId) {
    return localDayStart(dayId);
}

/**
 * How much of a time span falls in each local day it touches.
 *
 * A zero-length span (a session with no recorded duration) is its start day,
 * whole. Days step by calendar date, so DST days weigh their real length.
 *
 * @param {number} from - Span start, epoch ms
 * @param {number} to - Span end, epoch ms
 * @returns {Array<{day: string, share: number}>} Shares summing to 1
 */
export function daySharesOfSpan(from, to) {
    if (!Number.isFinite(from)) return [];
    if (!Number.isFinite(to) || to <= from) return [{ day: localDayId(from), share: 1 }];

    const total = to - from;
    const shares = [];
    const cursor = new Date(dayStart(localDayId(from)));
    while (cursor.getTime() < to) {
        const start = cursor.getTime();
        cursor.setDate(cursor.getDate() + 1);
        const overlap = Math.min(to, cursor.getTime()) - Math.max(from, start);
        if (overlap > 0) shares.push({ day: localDayId(start), share: overlap / total });
    }
    return shares;
}

/**
 * The day ids a window covers, oldest first.
 * @param {number} from - Window start
 * @param {number} to - Window end
 * @returns {Array<string>} Day ids
 */
export function daysBetween(from, to) {
    const days = [];
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return days;
    // Stepped by calendar date rather than 24h, so a DST day (23 or 25 hours)
    // neither repeats nor skips an id
    const cursor = new Date(dayStart(localDayId(from)));
    while (cursor.getTime() <= to) {
        days.push(localDayId(cursor.getTime()));
        cursor.setDate(cursor.getDate() + 1);
    }
    return days;
}

/**
 * Split a loot log drop key into its item and enhancement level.
 * @param {string} key - `/items/foo` or `/items/foo::3`
 * @returns {{itemHrid: string, enhancementLevel: number}} The pair
 */
export function splitDropKey(key) {
    const match = /^(.*)::(\d+)$/.exec(String(key || ''));
    if (!match) return { itemHrid: String(key || ''), enhancementLevel: 0 };
    return { itemHrid: match[1], enhancementLevel: Number(match[2]) || 0 };
}

/** @returns {number} `value` when it is a usable number, else 0 */
function num(value) {
    return Number.isFinite(value) ? value : 0;
}

/**
 * When an alchemy or enhancement session was last seen running.
 *
 * The alchemy trackers keep `lastActivityTime`; the enhancement recorder has
 * always kept `lastUpdateTime` (its last attempt) and `endTime` (set when the
 * target is reached), so it needs nothing new. The latest of whichever exist
 * is the far end of the span. A session stored before any of them existed has
 * none, and gets its start instant back — a zero-length span, which is its
 * start day whole.
 *
 * @param {Object} session - A stored alchemy or enhancement session
 * @param {number} start - The session's start, epoch ms
 * @returns {number} The span end, never earlier than `start`
 */
function sessionSpanEnd(session, start) {
    const end = Math.max(num(session?.lastActivityTime), num(session?.lastUpdateTime), num(session?.endTime));
    return end > start ? end : start;
}

/**
 * A blank per-source tally.
 * @returns {Object} Every source key at zero
 */
function emptyTally() {
    const tally = {};
    for (const key of SOURCE_KEYS) tally[key] = 0;
    return tally;
}

/** Coin dropped as loot is coins - face value, no market lookup */
const COIN_HRID = '/items/coin';

/**
 * One drop's unit worth: coin at face value, everything else at market.
 *
 * The pricer knows no price for coin (it has no order book), which silently
 * valued every combat coin drop at nothing and left it in the residual.
 * Face value here rather than in the shared pricer, because the alchemy and
 * enhancement paths already carry their coins through `totalCoinsEarned` and
 * a pricer-level coin would count those twice.
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @param {string} itemHrid
 * @param {number} enhancementLevel
 * @returns {number}
 */
function dropUnitValue(price, itemHrid, enhancementLevel) {
    if (itemHrid === COIN_HRID) return 1;
    return num(price(itemHrid, enhancementLevel));
}

/**
 * What a loot log entry's drops are worth.
 * @param {Object} entry - A loot log entry
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {number} Coins
 */
export function lootEntryValue(entry, price) {
    let total = 0;
    for (const [key, count] of Object.entries(entry?.drops || {})) {
        const { itemHrid, enhancementLevel } = splitDropKey(key);
        total += dropUnitValue(price, itemHrid, enhancementLevel) * num(count);
    }
    return total;
}

/**
 * The archived run's own player.
 *
 * A run is a party's run and its `players` array holds everybody in it, but the
 * gold attribution is one character's ledger: counting the party's loot would
 * credit this account with four people's drops. The current player is flagged,
 * and a solo run recorded before the flag existed falls back to the only player
 * there is — which is exactly how the consumables row scopes itself, and the
 * two rows must not disagree about whose run it was.
 *
 * @param {Object} session - An archived combat run
 * @returns {Object|null} The player entry, or null
 */
export function ownCombatPlayer(session) {
    const players = session?.players || [];
    return players.find((player) => player?.isCurrentPlayer) || players[0] || null;
}

/**
 * What one archived combat run's loot was worth to this character.
 *
 * The run's loot map is keyed by the game's own slot key with the item inside,
 * so two slots of one item are two entries; every entry is priced the way
 * {@link lootEntryValue} prices a loot log drop — at today's market, with no
 * tax deducted, because the loot log side does not deduct one either and a row
 * fed from both sources must not change character with its source.
 *
 * `items` is how many priced-or-not loot entries the run held, which is what
 * separates "this run dropped nothing worth anything" from "this run recorded
 * no loot at all" — the second is a gap and gets said out loud.
 *
 * @param {Object} session - An archived combat run
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {{value: number, items: number}} Coins, and how many loot entries there were
 */
export function combatSessionLootValue(session, price) {
    const me = ownCombatPlayer(session);
    let value = 0;
    let items = 0;
    for (const entry of Object.values(me?.loot || {})) {
        if (!entry?.itemHrid) continue;
        items += 1;
        value += dropUnitValue(price, entry.itemHrid, num(entry.enhancementLevel)) * num(entry.count);
    }
    return { value, items };
}

/**
 * What one alchemy session added to the account.
 *
 * Outputs less the inputs consumed and the catalysts spent. Transmute and
 * decompose record their outputs item by item; coinify records the coins it
 * produced. Every session records attempts, and an attempt consumes one input
 * whether or not it succeeded — which is exactly why alchemy can lose money and
 * why counting only the outputs would be a lie.
 *
 * An input with no market price is not a free one: `price()` returning null
 * for it used to fall through `num()` to zero cost, so a session run on an
 * unpriceable material reported its whole gross output as profit — the exact
 * overstatement the production recorder exists to avoid, here for the other
 * ingredient. So a session that spent at least one unpriceable input is not
 * valued at all, the same way an unpriceable enhancement run is not.
 *
 * @param {Object} session - A stored alchemy session, tagged with `kind`
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {number|null} Coins, which may be negative, or null when the input
 *   consumed could not be priced
 */
export function alchemySessionNet(session, price, basisPrice = price) {
    if (!session) return 0;

    let outputs = num(session.totalCoinsEarned);
    for (const [itemHrid, result] of Object.entries(session.results || {})) {
        const count = num(result?.count);
        if (count <= 0) continue;
        // The same basis fallback the input gets, or the books don't balance:
        // transmuting a cape into another unpriced cape charged the full
        // material cost going in and credited nothing coming out, so cycling
        // one cape three times read as three capes lost. Priced symmetrically,
        // a returned item cancels a consumed one and only the real loss nets.
        let unit = price(itemHrid, 0);
        if (!Number.isFinite(unit)) unit = basisPrice(itemHrid, 0);
        outputs += Number.isFinite(unit) ? unit * count : num(result?.totalValue);
    }

    const attempts = num(session.totalAttempts);
    // The input consumed is a cost basis, so it gets the deeper fallback: a
    // transmuted cape with no market of its own still has a material cost,
    // and pricing it there beats sending the whole session to the residual
    const inputUnit = basisPrice(session.inputItemHrid, num(session.enhancementLevel));
    if (attempts > 0 && !Number.isFinite(inputUnit)) return null;
    const inputs = attempts * num(inputUnit);

    const catalysts =
        num(session.catalystOfCoinificationUsed) * num(price('/items/catalyst_of_coinification', 0)) +
        num(session.catalystOfDecompositionUsed) * num(price('/items/catalyst_of_decomposition', 0)) +
        num(session.catalystOfTransmutationUsed) * num(price('/items/catalyst_of_transmutation', 0)) +
        num(session.primeCatalystUsed) * num(price('/items/prime_catalyst', 0));

    return outputs - inputs - catalysts;
}

/**
 * What one enhancement session added to the account.
 *
 * The item is worth more at a higher level, and the run cost materials, coins
 * and protections to get there. Both halves are needed: a session that spent
 * two hundred million to add a hundred and fifty million of item value made the
 * account poorer, and reporting only the level gained would show it as income.
 *
 * A session whose item cannot be priced at one of its two levels — high
 * enhancement levels frequently have no market at all — returns null rather
 * than a number built on a missing half.
 *
 * A level the market cannot price still gets the cost-basis fallback, the
 * same one the alchemy input gets: net worth itself carries an unpriced BASE
 * item at its material cost, so measuring the run against that basis is
 * exactly the net worth movement the run caused — a craftable item nobody
 * lists is not a session the panel has to give up on. The basis pricer only
 * answers at level 0 (an expected value or a material cost is a base-item
 * figure and a +8 is worth far more than its +0 materials), so an unpriced
 * HIGH level still nulls the session rather than being mis-valued.
 *
 * @param {Object} session - A stored enhancement session
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @param {Function} [basisPrice] - Deeper cost-basis lookup, tried where the
 *   market is silent
 * @returns {number|null} Coins, which may be negative, or null when unpriceable
 */
export function enhancementSessionNet(session, price, basisPrice = price) {
    if (!session?.itemHrid) return null;

    const startLevel = num(session.startLevel);
    const endLevel = num(session.currentLevel ?? session.startLevel);
    let from = price(session.itemHrid, startLevel);
    if (!Number.isFinite(from)) from = basisPrice(session.itemHrid, startLevel);
    let to = price(session.itemHrid, endLevel);
    if (!Number.isFinite(to)) to = basisPrice(session.itemHrid, endLevel);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

    return to - from - num(session.totalCost);
}

/**
 * Realised marketplace profit and tax paid, per local day.
 *
 * Average-cost matched per item and enhancement level, chronologically over the
 * *whole* ledger rather than the window — a sell inside the window was very
 * often bought before it, and starting the pool at the window edge would call
 * that whole sale profit.
 *
 * The profit reported is before tax, and the tax is reported beside it, so the
 * two lines sum to what actually landed. Sells with no recorded buy behind them
 * realise nothing: calling untracked cost zero would fake a total margin.
 *
 * @param {Array<Object>} fills - Trade ledger fill records, any order
 * @param {number} marketTax - Sell tax rate, e.g. 0.05
 * @returns {Object<string, {realisedGross: number, tax: number}>} Keyed by day id
 */
export function marketplaceByDay(fills, marketTax) {
    const sorted = (Array.isArray(fills) ? fills.filter((fill) => fill && fill.itemHrid) : []).slice();
    sorted.sort((a, b) => num(a.t) - num(b.t));

    const pools = new Map();
    const byDay = {};

    const dayFor = (t) => {
        const id = localDayId(t);
        if (!byDay[id]) byDay[id] = { realisedGross: 0, tax: 0 };
        return byDay[id];
    };

    for (const fill of sorted) {
        const key = `${fill.itemHrid}:${num(fill.enhancementLevel)}`;
        let pool = pools.get(key);
        if (!pool) {
            pool = { qty: 0, cost: 0 };
            pools.set(key, pool);
        }

        const quantity = num(fill.quantity);
        if (quantity <= 0) continue;

        if (fill.side === 'buy') {
            pool.qty += quantity;
            pool.cost += num(fill.coins);
            continue;
        }
        if (fill.side !== 'sell') continue;

        // `coins` on a sell is already net of tax; the gross is what the
        // listing was worth before the market took its cut
        const net = num(fill.coins);
        const gross = num(fill.price) * quantity;
        const tax = Math.max(0, gross - net) || gross * num(marketTax);

        const day = dayFor(fill.t);
        day.tax += tax;

        const matched = Math.min(quantity, pool.qty);
        if (matched > 0) {
            const avgCost = pool.cost / pool.qty;
            const costOut = avgCost * matched;
            pool.qty -= matched;
            pool.cost -= costOut;
            day.realisedGross += gross * (matched / quantity) - costOut;
        }
    }

    return byDay;
}

/**
 * The net worth measured at the end of each day in a window.
 *
 * The last snapshot of a day is that day's closing figure, and a day's delta is
 * its close against the previous day's. A day with no snapshot at all — the
 * player did not log in — has no close, and the next day that does have one
 * carries the whole gap rather than the gap being invented for the silent day.
 *
 * @param {Array<Object>} series - Net worth snapshots `{t, total}`, any order
 * @returns {Object<string, number>} day id → closing total
 */
export function dailyCloses(series) {
    const closes = {};
    for (const [day, snapshot] of Object.entries(dailyCloseSnapshots(series))) closes[day] = snapshot.total;
    return closes;
}

/**
 * The whole closing snapshot of each day, not just its total.
 *
 * The category decomposition needs the per-asset fields beside the total, and
 * they only mean anything when they come off the same snapshot the total does.
 *
 * @param {Array<Object>} series - Net worth snapshots `{t, total, ...}`, any order
 * @returns {Object<string, Object>} day id → the day's last snapshot
 */
export function dailyCloseSnapshots(series) {
    const closes = {};
    const seen = {};
    for (const point of Array.isArray(series) ? series : []) {
        if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.total)) continue;
        const id = localDayId(point.t);
        if (seen[id] !== undefined && seen[id] > point.t) continue;
        seen[id] = point.t;
        closes[id] = point;
    }
    return closes;
}

/**
 * Which snapshot fields make up each of the three things a residual can be.
 *
 * `guildShrines` is deliberately optional even on a current snapshot — the
 * tracker writes it only when the calculator actually costed the shrines — so a
 * group is read field by field rather than all-or-nothing.
 */
export const CATEGORY_FIELDS = {
    gold: ['gold'],
    items: ['inventory', 'equipment', 'listings'],
    fixed: ['house', 'abilities', 'guildShrines'],
};

/** The three category keys, in the order the panel says them */
export const CATEGORY_KEYS = ['gold', 'items', 'fixed'];

/**
 * One category's change between two closes, or null when it cannot be measured.
 *
 * Three states per field, and they are not the same thing:
 *
 * - in **both** closes — a real delta, and it counts;
 * - in **neither** — the account has never recorded it (an account with no
 *   guild shrines, a build before the field existed), so it is skipped rather
 *   than counted as a zero that did not move;
 * - in **exactly one** — the record itself is discontinuous across this pair,
 *   and any number built on it would be the missing side reported as a gain or
 *   a loss. The whole group is null.
 *
 * A group whose every field is absent from both closes is null too: nothing was
 * measured, and zero would be a claim that nothing moved.
 *
 * @param {Object} open - The earlier close
 * @param {Object} close - The later close
 * @param {Array<string>} fields - The snapshot fields in this category
 * @returns {number|null} Coins, or null when unmeasurable
 */
export function categoryDelta(open, close, fields) {
    if (!open || !close) return null;
    let total = 0;
    let measured = 0;
    for (const field of fields) {
        const before = open[field];
        const after = close[field];
        const hasBefore = Number.isFinite(before);
        const hasAfter = Number.isFinite(after);
        if (hasBefore !== hasAfter) return null;
        if (!hasBefore) continue;
        total += after - before;
        measured += 1;
    }
    return measured > 0 ? total : null;
}

/**
 * What the day's measured change was made of, by asset category.
 *
 * The residual is a single grey number and it hides the one distinction that
 * matters most: a residual that is entirely `items` is the market repricing
 * stock that never moved, and a residual that is entirely `gold` is coins
 * arriving from something nothing here records. The sources are deliberately
 * NOT subtracted from these — a marketplace fill moves gold and items at once,
 * production consumes items to make items, and any split of them across the
 * three would be an invention. These are the raw category deltas, reported
 * beside the residual rather than instead of it.
 *
 * `sum` is the three added up, which is the non-excluded net worth: `total`
 * also carries whatever the user excluded from their net worth, so the two can
 * differ and the panel says so rather than pretending they balance.
 *
 * @param {Object|null} open - The earlier close snapshot
 * @param {Object|null} close - The later close snapshot
 * @returns {{gold: number|null, items: number|null, fixed: number|null,
 *   sum: number|null, total: number|null}|null} The breakdown, or null with no pair
 */
export function categoryBreakdown(open, close) {
    if (!open || !close) return null;

    const breakdown = { gold: null, items: null, fixed: null, sum: null, total: null };
    let sum = 0;
    let complete = true;
    for (const key of CATEGORY_KEYS) {
        const value = categoryDelta(open, close, CATEGORY_FIELDS[key]);
        breakdown[key] = value;
        if (value === null) complete = false;
        else sum += value;
    }
    breakdown.sum = complete ? sum : null;
    if (Number.isFinite(open.total) && Number.isFinite(close.total)) breakdown.total = close.total - open.total;
    return breakdown;
}

/**
 * Coins keep their face value forever, so they cannot revalue.
 * @param {string} key - A detail snapshot key
 * @returns {boolean} True when the key is a tradeable item holding
 */
function isPriceableDetailKey(key) {
    const id = String(key || '');
    if (id.startsWith('/items/coin:')) return false;
    // Only genuine `itemHrid:enhancementLevel` holdings. `house:`, `ability:`,
    // `abilitybook:` and `listing:` entries either are not priced from an order
    // book at all or pack several rows into one count, and value/count on those
    // is not a unit price
    return id.startsWith('/items/');
}

/**
 * How much of the recent window's change was the market repricing what was
 * already owned.
 *
 * The panel's standing caveat is that everything is priced at today's market and
 * so it cannot see price drift. For the span the item-level detail snapshots
 * cover — about a day — it can: each snapshot records `value` and `count` per
 * holding AT THE TIME IT WAS TAKEN, so `value / count` is that holding's unit
 * price then, and the same item's price now is the other end of the same line.
 *
 * Only stock held THROUGH the window is counted: `min(countThen, countNow)`
 * shares. Anything bought or sold inside it changed hands at prices this has no
 * record of, and counting the extra shares would mix a trade into a price
 * figure. An item that appeared or disappeared entirely contributes nothing.
 *
 * @param {Array<Object>} snapshots - Detail snapshots `{t, items: {key: {count, value}}}`
 * @returns {{from: number, to: number, hours: number, value: number, heldItems: number,
 *   movedItems: number}|null} The estimate, or null when there is no pair to measure
 */
export function marketMovement(snapshots) {
    const usable = (Array.isArray(snapshots) ? snapshots : [])
        .filter((snapshot) => snapshot && Number.isFinite(snapshot.t) && snapshot.items)
        .sort((a, b) => a.t - b.t);
    if (usable.length < 2) return null;

    const then = usable[0];
    const now = usable[usable.length - 1];
    if (!(now.t > then.t)) return null;

    let value = 0;
    let heldItems = 0;
    let movedItems = 0;

    for (const [key, before] of Object.entries(then.items)) {
        if (!isPriceableDetailKey(key)) continue;
        const after = now.items[key];
        if (!after) continue;

        const countThen = num(before.count);
        const countNow = num(after.count);
        if (!(countThen > 0) || !(countNow > 0)) continue;

        const priceThen = num(before.value) / countThen;
        const priceNow = num(after.value) / countNow;
        if (!Number.isFinite(priceThen) || !Number.isFinite(priceNow)) continue;

        heldItems += 1;
        const move = Math.min(countThen, countNow) * (priceNow - priceThen);
        if (move !== 0) movedItems += 1;
        value += move;
    }

    return {
        from: then.t,
        to: now.t,
        hours: (now.t - then.t) / (60 * 60 * 1000),
        value,
        heldItems,
        movedItems,
    };
}

/**
 * What a day of chest opening did to the account.
 *
 * An unopened chest is already carried in net worth at its expected value, so
 * opening it exchanges one valuation for another and the only thing that moves
 * is the gap between them: the loot at market, less the chests' own price.
 *
 * A chest with no price of its own cannot be netted against anything, so the
 * whole opening is left out and counted rather than reported as pure gross
 * income — the mistake the production recorder had to be fixed for. A gained
 * item with no price is counted too, and the day's figure is short by it.
 *
 * @param {Object} row - A recorder row `{d, openings: {chestHrid: {count, gained}}}`
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {{value: number, unpricedItems: number, unpricedChests: number}} The day
 */
export function chestOpeningDayValue(row, price, basisPrice = price) {
    let value = 0;
    let unpricedItems = 0;
    let unpricedChests = 0;

    for (const [chestHrid, entry] of Object.entries(row?.openings || {})) {
        const count = num(entry?.count);
        if (count <= 0) continue;

        // The chest is the cost basis of its own opening, so the deeper
        // fallback applies: a labyrinth box with no market price still has an
        // expected value, and netting the contents against that is the
        // "expected vs real return" the row is for
        const chestPrice = basisPrice(chestHrid, 0);
        if (!Number.isFinite(chestPrice)) {
            unpricedChests += count;
            continue;
        }

        let loot = 0;
        for (const [itemHrid, gained] of Object.entries(entry?.gained || {})) {
            const amount = num(gained);
            if (amount === 0) continue;
            const unit = itemHrid === COIN_HRID ? 1 : price(itemHrid, 0);
            if (!Number.isFinite(unit)) {
                unpricedItems += 1;
                continue;
            }
            loot += unit * amount;
        }

        value += loot - chestPrice * count;
    }

    return { value, unpricedItems, unpricedChests };
}

/**
 * What one claimed task paid, in coins.
 *
 * Coins at face value, tokens and item rewards at today's market — the same
 * convention every other row here uses. The reward payload is itemised on the
 * wire and recorded verbatim at the moment of the claim, so this is a
 * measurement and not an inference from an inventory diff.
 *
 * @param {Object} entry - A task completion record
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {number} Coins
 */
export function taskCompletionValue(entry, price) {
    if (!entry) return 0;
    let total = num(entry.coins);
    total += num(entry.tokens) * num(price('/items/task_token', 0));
    for (const item of entry.items || []) {
        if (!item?.itemHrid) continue;
        total += num(price(item.itemHrid, 0)) * num(item.count);
    }
    return total;
}

/**
 * The earliest timestamp in a list, or null when there is none.
 * @param {Array<*>} items - Anything
 * @param {Function} timeOf - `(item) => number|NaN`
 * @returns {number|null} Milliseconds since the epoch
 */
function earliest(items, timeOf) {
    let best = null;
    for (const item of Array.isArray(items) ? items : []) {
        const t = timeOf(item);
        if (!Number.isFinite(t)) continue;
        if (best === null || t < best) best = t;
    }
    return best;
}

/**
 * The earlier of two timestamps, either of which may be missing.
 * @param {number|null} a - Milliseconds, or null
 * @param {number|null} b - Milliseconds, or null
 * @returns {number|null} The earlier one, or whichever exists
 */
function earlierOf(a, b) {
    if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null;
    if (!Number.isFinite(b)) return a;
    return Math.min(a, b);
}

/**
 * How far apart a loot log entry's start and a run's `combatStartTime` may be
 * and still be the same run. Both are the server's timestamp of the combat
 * action starting and normally agree exactly; the nearest start within this
 * wins, so two runs started close together cannot trade entries.
 */
export const SAME_RUN_SLACK_MS = 2 * 60 * 1000;

/** Which recording a tie is credited to, most direct first */
const RECORDING_RANK = { live: 0, log: 1, archive: 2 };

/**
 * A span with the offline windows taken out of it.
 * @param {number} from - Span start, epoch ms
 * @param {number} to - Span end, epoch ms
 * @param {Array<Array<number>>} offline - `[from, to]` windows
 * @returns {Array<Array<number>>} The online pieces, in order
 */
export function onlinePieces(from, to, offline) {
    let pieces = to > from ? [[from, to]] : [];
    for (const window of offline || []) {
        const [a, b] = Array.isArray(window) ? window : [];
        if (!(b > a)) continue;
        const next = [];
        for (const [start, end] of pieces) {
            if (b <= start || a >= end) {
                next.push([start, end]);
                continue;
            }
            if (a > start) next.push([start, a]);
            if (b < end) next.push([b, end]);
        }
        pieces = next;
    }
    return pieces;
}

/**
 * Spread a value across the days of a span by time, handing the part that fell
 * in an offline window to the offline row instead.
 *
 * The Welcome Back summary is the server's own item delta for the offline
 * period and the offline row counts it whole. A combat recording spanning that
 * period carries the same drops (and the same food) in its running total, so
 * its share inside the window goes to `onCeded` rather than `onDay`: counted
 * once, by the row that measured it.
 *
 * A zero-length span is its instant, whole.
 *
 * @param {number} value - What to spread
 * @param {number} from - Span start, epoch ms
 * @param {number} to - Span end, epoch ms
 * @param {Array<Array<number>>} offline - `[from, to]` offline windows
 * @param {Function} onDay - `(dayId, value)`, for the online share
 * @param {Function} [onCeded] - `(dayId, value)`, for the offline share
 */
export function spreadOnline(value, from, to, offline, onDay, onCeded = () => {}) {
    if (!Number.isFinite(value) || value === 0 || !Number.isFinite(from)) return;
    if (!(to > from)) {
        const offlineThen = (offline || []).some((window) => from >= window?.[0] && from < window?.[1]);
        (offlineThen ? onCeded : onDay)(localDayId(from), value);
        return;
    }

    const total = to - from;
    const pay = (start, end, sink) => {
        if (!(end > start)) return;
        const part = value * ((end - start) / total);
        for (const { day, share } of daySharesOfSpan(start, end)) sink(day, part * share);
    };
    let cursor = from;
    for (const [start, end] of onlinePieces(from, to, offline)) {
        pay(cursor, start, onCeded);
        pay(start, end, onDay);
        cursor = end;
    }
    pay(cursor, to, onCeded);
}

/**
 * What one combat run was worth on each day, from every recording of it.
 *
 * Each recording of a run — a battle feed reading, the archived snapshot, a
 * loot log entry — reads the SAME running total, counted from the same start.
 * So they are points on one rising curve, and the honest curve through them is
 * the most any of them had seen by each instant: a drop two recordings both saw
 * raises it once.
 *
 * Between two points the rise is spread by time — exact across a midnight the
 * feed watched, and the uniform estimate every session here uses across a
 * stretch nobody watched. A reading lower than the high point so far (a stale
 * loot log entry) raises nothing. One that ties it later moves the start of the
 * next rise up to it, because the total is then known not to have moved until
 * that instant.
 *
 * The run's total is therefore the most any one recording saw — never a sum of
 * two, and never more than the most complete of them.
 *
 * @param {number} start - The run's start, epoch ms
 * @param {Array<{t: number, value: number, kind: string}>} readings - The
 *   running total's worth at each instant, and which recording (`live`, `log`
 *   or `archive`) read it
 * @param {Array<Array<number>>} [offline] - Offline windows, left to the offline row
 * @returns {{days: Map<string, {value: number, live: number, log: number, archive: number}>,
 *   ceded: Map<string, number>, total: number}} What the run added each day and
 *   which recording raised it there; what fell in offline time; the run's total
 */
export function combatRunDayValues(start, readings, offline = []) {
    const points = (readings || [])
        .filter((reading) => reading && Number.isFinite(reading.t) && Number.isFinite(reading.value))
        .map((reading) => ({ ...reading, t: Math.max(reading.t, start) }))
        .sort(
            (a, b) => a.t - b.t || a.value - b.value || (RECORDING_RANK[a.kind] ?? 9) - (RECORDING_RANK[b.kind] ?? 9)
        );

    const days = new Map();
    const ceded = new Map();
    let high = 0;
    let since = start;
    for (const point of points) {
        // Two recordings of the same drops can add them in a different order
        const tolerance = 1e-9 * Math.max(1, high);
        if (point.value > high + tolerance) {
            const { kind } = point;
            spreadOnline(
                point.value - high,
                since,
                point.t,
                offline,
                (day, value) => {
                    const held = days.get(day) || { value: 0, live: 0, log: 0, archive: 0 };
                    held.value += value;
                    if (kind in RECORDING_RANK) held[kind] += value;
                    days.set(day, held);
                },
                (day, value) => ceded.set(day, (ceded.get(day) || 0) + value)
            );
            high = point.value;
            since = point.t;
        } else if (point.value >= high - tolerance) {
            since = point.t;
        }
    }
    return { days, ceded, total: high };
}

/**
 * What a battle feed reading's running total is worth.
 * @param {Object<string, number>} loot - Drop key → count
 * @param {Function} price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {{value: number, items: number}} Coins, and how many kinds of drop
 */
function lootCountsValue(loot, price) {
    let value = 0;
    let items = 0;
    for (const [key, count] of Object.entries(loot || {})) {
        const { itemHrid, enhancementLevel } = splitDropKey(key);
        if (!itemHrid) continue;
        items += 1;
        value += dropUnitValue(price, itemHrid, enhancementLevel) * num(count);
    }
    return { value, items };
}

/**
 * Whether two spans are the same stretch of time rather than neighbours: they
 * overlap by more than the slack, or one is an instant well inside the other.
 * @returns {boolean}
 */
function sharesTime(aFrom, aTo, bFrom, bTo) {
    if (Math.min(aTo, bTo) - Math.max(aFrom, bFrom) > SAME_RUN_SLACK_MS) return true;
    const inside = (t, from, to) => t > from + SAME_RUN_SLACK_MS && t < to - SAME_RUN_SLACK_MS;
    return (aTo === aFrom && inside(aFrom, bFrom, bTo)) || (bTo === bFrom && inside(bFrom, aFrom, aTo));
}

/**
 * What combat dropped on each day, from all three recordings, each drop once.
 *
 * ## Which recording answers for a stretch of time
 *
 * None of them for a whole day. Every recording is gathered under the run it
 * recorded — the battle feed's readings and the archived snapshot by the run's
 * `combatStartTime`, a loot log entry by the run whose start it shares — and
 * each run is costed by {@link combatRunDayValues}: the most any recording of it
 * had seen by each instant. For any stretch of time the answer is whichever saw
 * furthest into it, and the others add only what it missed — in practice the
 * live feed for every hour the tab was open, the loot log or archive for the
 * tail after it closed, and the offline row for time spent offline.
 *
 * A loot log entry sharing no run's start is a run nobody else recorded, and
 * counts whole over its own span. One that lies across a DIFFERENT run's time
 * is set aside and counted: one action cannot be two runs, and adding it would
 * count the other run's drops a second time.
 *
 * @param {Object} input
 * @param {Array<Object>} [input.liveDays] - Combat loot recorder rows
 * @param {Array<Object>} [input.sessions] - Archived combat runs, and the live one
 * @param {Array<{start: number, end: number, value: number}>} [input.entries] - Combat loot log entries
 * @param {Array<Array<number>>} [input.offline] - Offline windows
 * @param {Function} input.price - `(itemHrid, enhancementLevel) => number|null`
 * @returns {{byDay: Map<string, {value: number, live: number, log: number, archive: number}>,
 *   cededByDay: Map<string, number>, coveredDays: Set<string>, watchedDays: Set<string>,
 *   liveSince: number|null, ambiguousEntries: number}} Per-day value and what raised it,
 *   the offline share handed on, the days some recording covered, the days the live feed
 *   watched, where the live record starts, and the entries set aside
 */
export function combatLootByDay({ liveDays = [], sessions = [], entries = [], offline = [], price = () => null } = {}) {
    const runs = new Map();
    const runAt = (start) => {
        let run = runs.get(start);
        if (!run) {
            run = { start, readings: [], end: start, items: 0, watched: false, logged: false };
            runs.set(start, run);
        }
        return run;
    };

    let liveSince = null;
    for (const row of liveDays || []) {
        for (const [key, held] of Object.entries(row?.runs || {})) {
            const start = Date.parse(key);
            if (!Number.isFinite(start)) continue;
            const run = runAt(start);
            const readings = (held?.stretches || []).flatMap((stretch) => [stretch?.first, stretch?.last]);
            for (const reading of readings) {
                if (!Number.isFinite(reading?.t)) continue;
                const { value, items } = lootCountsValue(reading.loot, price);
                run.readings.push({ t: reading.t, value, kind: 'live' });
                run.items = Math.max(run.items, items);
                run.end = Math.max(run.end, reading.t);
                run.watched = true;
                if (liveSince === null || reading.t < liveSince) liveSince = reading.t;
            }
        }
    }

    for (const session of sessions || []) {
        const start = Date.parse(session?.combatStartTime);
        if (!Number.isFinite(start)) continue;
        const loot = combatSessionLootValue(session, price);
        const end = start + Math.max(0, num(session?.durationSeconds)) * 1000;
        const run = runAt(start);
        run.readings.push({ t: end, value: loot.value, kind: 'archive' });
        run.items = Math.max(run.items, loot.items);
        run.end = Math.max(run.end, end);
    }

    // Each run's own feed-and-archive span, before any entry joins it: what an
    // entry is checked against for belonging to a different run
    const spans = [...runs.values()].map((run) => ({ run, from: run.start, to: run.end }));

    const logRuns = [];
    let ambiguousEntries = 0;
    for (const entry of entries || []) {
        if (!Number.isFinite(entry?.start)) continue;
        const end = Number.isFinite(entry.end) && entry.end > entry.start ? entry.end : entry.start;
        let home = null;
        for (const run of runs.values()) {
            const gap = Math.abs(run.start - entry.start);
            if (gap <= SAME_RUN_SLACK_MS && (!home || gap < Math.abs(home.start - entry.start))) home = run;
        }
        if (spans.some(({ run, from, to }) => run !== home && sharesTime(entry.start, end, from, to))) {
            ambiguousEntries += 1;
            continue;
        }
        const reading = { t: end, value: num(entry.value), kind: 'log' };
        if (home) {
            home.readings.push(reading);
            home.end = Math.max(home.end, end);
            home.logged = true;
        } else {
            logRuns.push({ start: entry.start, readings: [reading], end, items: 0, watched: false, logged: true });
        }
    }

    const byDay = new Map();
    const cededByDay = new Map();
    const coveredDays = new Set();
    const watchedDays = new Set();
    for (const run of [...runs.values(), ...logRuns]) {
        const result = combatRunDayValues(run.start, run.readings, offline);
        for (const [day, part] of result.days) {
            const held = byDay.get(day) || { value: 0, live: 0, log: 0, archive: 0 };
            for (const key of Object.keys(held)) held[key] += part[key];
            byDay.set(day, held);
        }
        for (const [day, value] of result.ceded) cededByDay.set(day, (cededByDay.get(day) || 0) + value);

        // A run that recorded loot, or that the live feed or the loot log was
        // watching, covers the days it ran. One whose only record is an empty
        // loot map does not, and stays a counted gap
        const spanDays = daySharesOfSpan(run.start, run.end).map(({ day }) => day);
        if (run.watched) for (const day of spanDays) watchedDays.add(day);
        if (run.watched || run.logged || run.items > 0) for (const day of spanDays) coveredDays.add(day);
    }

    return { byDay, cededByDay, coveredDays, watchedDays, liveSince, ambiguousEntries };
}

/**
 * Split a window's net worth delta across the activity that is recorded for it.
 *
 * @param {Object} input - Everything the attribution reads
 * @param {number} input.from - Window start, milliseconds
 * @param {number} input.to - Window end, milliseconds
 * @param {Array<Object>} [input.series] - Net worth snapshots `{t, total}`
 * @param {Array<Object>} [input.lootEntries] - Loot log entries
 * @param {Function} [input.actionType] - `(actionHrid) => string|null`
 * @param {Array<Object>} [input.productionDays] - Recorder rows
 *   `{d, outputValue, inputValue, offlineProfit, unpricedActions}`
 * @param {Array<Object>} [input.alchemySessions] - Stored alchemy sessions
 * @param {Array<Object>} [input.enhancementSessions] - Stored enhancement sessions
 * @param {Array<Object>} [input.tradeFills] - Trade ledger fill records
 * @param {Array<Object>} [input.combatSessions] - Archived combat runs
 * @param {Array<Object>} [input.combatLootDays] - Combat loot recorder rows `{d, runs, offline}`
 * @param {Array<Object>} [input.taskCompletions] - Claimed task records `{completedAt, coins, tokens, items}`
 * @param {Array<Object>} [input.chestDays] - Chest opening recorder rows `{d, openings}`
 * @param {Array<Object>} [input.detailSnapshots] - Item-level snapshots `{t, items}`
 * @param {number} [input.sessionCap] - How many runs the history keeps
 * @param {Function} input.price - `(itemHrid, enhancementLevel) => number|null`
 * @param {number} [input.marketTax] - Sell tax rate
 * @returns {{
 *   from: number, to: number,
 *   days: Array<{day: string, sources: Object, explained: number, delta: number|null, residual: number|null,
 *     categories: Object|null}>,
 *   totals: {sources: Object, explained: number, delta: number|null, residual: number|null, categories: Object|null},
 *   marketMovement: Object|null,
 *   coverage: Object<string, number|null>,
 *   unpricedAlchemySessions: number,
 *   unpricedEnhancementSessions: number,
 *   unpricedProductionActions: number,
 *   combatBasis: {lootLogDays: number, sessionDays: number, liveDays: number, archiveDays: number,
 *     uncoveredDays: number, sessions: number, emptySessions: number, sessionsHeld: number,
 *     sessionCap: number, capReached: boolean, liveSince: number|null, lastLootLog: number|null,
 *     offlineCombat: number, ambiguousEntries: number, combatRan: boolean}
 * }} The attribution
 */
export function attributeGoldSources(input) {
    const {
        from,
        to,
        series = [],
        lootEntries = [],
        actionType = () => null,
        productionDays = [],
        alchemySessions = [],
        enhancementSessions = [],
        tradeFills = [],
        combatSessions = [],
        combatLootDays = [],
        taskCompletions = [],
        chestDays = [],
        detailSnapshots = [],
        sessionCap = DEFAULT_SESSION_CAP,
        price = () => null,
        // Cost-basis lookups fall further than income ones: an alchemy input
        // or an opened chest with no market price can still have a material
        // cost or an expected value, and "what did this consume" is exactly
        // the question those answer. Defaults to the plain pricer.
        basisPrice = price,
        marketTax = 0.05,
    } = input || {};

    const days = daysBetween(from, to);
    const inWindow = new Set(days);
    const tallies = new Map(days.map((day) => [day, emptyTally()]));

    /**
     * @param {string} day - Day id
     * @param {string} key - Source key
     * @param {number} value - Coins to add
     */
    const add = (day, key, value) => {
        if (!inWindow.has(day) || !Number.isFinite(value) || value === 0) return;
        tallies.get(day)[key] += value;
    };

    // When the character was offline, from the Welcome Back summaries the
    // combat recorder kept. The offline row counts those periods' gains whole,
    // so the combat recordings leave them to it
    const offlineWindows = [];
    for (const row of combatLootDays || []) {
        for (const window of row?.offline || []) {
            if (Array.isArray(window) && window[1] > window[0]) offlineWindows.push([window[0], window[1]]);
        }
    }

    // Loot log: combat and gathering. Production actions are deliberately not
    // read from here — the log records what an action produced but not what it
    // consumed, and the production recorder below has both halves.
    //
    // Gathering is added straight away; combat is held aside, because the same
    // run is usually in the battle feed as well, and the two are reconciled run
    // by run below rather than added. An entry's end is when its drops were
    // current, which is what makes it a reading of the run at that instant
    const combatEntries = [];
    let lastCombatLootLog = null;
    for (const entry of lootEntries || []) {
        const t = Date.parse(entry?.startTime);
        if (!Number.isFinite(t)) continue;
        const type = actionType(entry.actionHrid);
        if (type === '/action_types/combat') {
            if (lastCombatLootLog === null || t > lastCombatLootLog) lastCombatLootLog = t;
            const end = Date.parse(entry.endTime);
            combatEntries.push({
                start: t,
                end: Number.isFinite(end) && end > t ? end : t,
                value: lootEntryValue(entry, price),
            });
            continue;
        }
        if (!GATHERING_ACTION_TYPES.includes(type)) continue;
        add(localDayId(t), 'gathering', lootEntryValue(entry, price));
    }

    // Production recorder: already per day, already valued
    let unpricedProductionActions = 0;
    for (const row of productionDays || []) {
        if (!row?.d) continue;
        add(row.d, 'production', num(row.outputValue) - num(row.inputValue));
        add(row.d, 'offline', num(row.offlineProfit));
        // Actions the recorder could not value at all, because one of their
        // items has no market price. They are in the residual, not the
        // production row, and the panel says so rather than letting the
        // production figure look complete
        if (inWindow.has(row.d)) unpricedProductionActions += num(row.unpricedActions);
    }

    // Task claims: the reward payload as the server itemised it, per local day
    for (const entry of taskCompletions || []) {
        const t = num(entry?.completedAt);
        if (!t) continue;
        add(localDayId(t), 'tasks', taskCompletionValue(entry, price));
    }

    // Chest openings: already per day, and netted against what the chests were
    // themselves worth
    let unpricedChestItems = 0;
    let unpricedChests = 0;
    for (const row of chestDays || []) {
        if (!row?.d) continue;
        const day = chestOpeningDayValue(row, price, basisPrice);
        add(row.d, 'chests', day.value);
        if (!inWindow.has(row.d)) continue;
        unpricedChestItems += day.unpricedItems;
        unpricedChests += day.unpricedChests;
    }

    // Alchemy and enhancement runs are spread over the days they ran, for the
    // same reason the combat runs below are: an AFK grind is one session that
    // lasts as long as the queue does, and booking its whole net to the day it
    // began put a multi-day run entirely outside every window that was asking
    // about it. Which day each attempt really landed on is unknowable from a
    // session total, so the uniform-by-time share is the honest estimate, and
    // it is exact for the common one-day session. A session recorded before
    // the trackers kept an end has no span at all, and `daySharesOfSpan` gives
    // it its start day whole — which is what it always got.
    let unpricedAlchemySessions = 0;
    for (const session of alchemySessions || []) {
        const t = num(session?.startTime);
        if (!t) continue;
        const shares = daySharesOfSpan(t, sessionSpanEnd(session, t));
        const net = alchemySessionNet(session, price, basisPrice);
        if (net === null) {
            if (shares.some(({ day }) => inWindow.has(day))) unpricedAlchemySessions += 1;
            continue;
        }
        for (const { day, share } of shares) add(day, 'alchemy', net * share);
    }

    let unpricedEnhancementSessions = 0;
    for (const session of enhancementSessions || []) {
        const t = num(session?.startTime);
        if (!t) continue;
        const shares = daySharesOfSpan(t, sessionSpanEnd(session, t));
        const net = enhancementSessionNet(session, price, basisPrice);
        if (net === null) {
            if (shares.some(({ day }) => inWindow.has(day))) unpricedEnhancementSessions += 1;
            continue;
        }
        for (const { day, share } of shares) add(day, 'enhancement', net * share);
    }

    const market = marketplaceByDay(tradeFills, marketTax);
    for (const [day, figures] of Object.entries(market)) {
        add(day, 'marketplace', figures.realisedGross);
        add(day, 'marketTax', -figures.tax);
    }

    // The archived runs pay for the consumables row: the food and drinks each
    // burned, SPREAD across the days it ran by time, because booking a
    // twelve-day AFK grind to its start day put it outside every window. Food
    // eaten while offline is in the Welcome Back summary's item delta, and so
    // already in the offline row; that stretch of a run is left to it.
    let sessionsInWindow = 0;
    let emptyLootSessions = 0;
    let consumablesAttributed = false;
    let earliestSession = null;
    for (const session of combatSessions || []) {
        const t = Date.parse(session?.combatStartTime);
        if (!Number.isFinite(t)) continue;
        if (earliestSession === null || t < earliestSession) earliestSession = t;

        const me = ownCombatPlayer(session);
        let cost = 0;
        for (const consumable of me?.consumables || []) {
            const consumed = num(consumable?.consumed);
            if (consumed <= 0) continue;
            cost += consumed * num(price(consumable.itemHrid, 0));
        }

        const spanEnd = t + Math.max(0, num(session?.durationSeconds)) * 1000;
        spreadOnline(-cost, t, spanEnd, offlineWindows, (day, value) => add(day, 'consumables', value));

        if (!daySharesOfSpan(t, spanEnd).some(({ day }) => inWindow.has(day))) continue;
        sessionsInWindow += 1;
        if (cost > 0) consumablesAttributed = true;
        if (combatSessionLootValue(session, price).items === 0) emptyLootSessions += 1;
    }

    // The drops, from all three recordings reconciled run by run — see
    // `combatLootByDay` for which one answers for which stretch of time
    const combatLoot = combatLootByDay({
        liveDays: combatLootDays,
        sessions: combatSessions,
        entries: combatEntries,
        offline: offlineWindows,
        price,
    });

    // What fed each day, so the panel can say so rather than calling a fallback
    // and a gap alike "Measured"
    let lootLogCombatDays = 0;
    let sessionCombatDays = 0;
    let liveCombatDays = 0;
    let archiveCombatDays = 0;
    let uncoveredCombatDays = 0;
    let offlineCombat = 0;
    const combatRan =
        sessionsInWindow > 0 || consumablesAttributed || days.some((day) => combatLoot.watchedDays.has(day));
    for (const day of days) {
        const part = combatLoot.byDay.get(day);
        if (part && part.value !== 0) {
            add(day, 'combat', part.value);
            if (part.log > 0) lootLogCombatDays += 1;
            if (part.live > 0 || part.archive > 0) sessionCombatDays += 1;
            if (part.live > 0) liveCombatDays += 1;
            if (part.archive > 0) archiveCombatDays += 1;
        }
        offlineCombat += combatLoot.cededByDay.get(day) || 0;
        // Only a gap when something proves combat happened this window at all;
        // a character who does not fight has no gap, it has no combat
        if (combatRan && !combatLoot.coveredDays.has(day)) uncoveredCombatDays += 1;
    }

    // The net worth each day closed at, and what the day before closed at, so a
    // day's delta is a measurement rather than a difference of interpolations
    const closeSnapshots = dailyCloseSnapshots(series);
    const closes = {};
    for (const [id, snapshot] of Object.entries(closeSnapshots)) closes[id] = snapshot.total;

    /**
     * The last day's close before a day, as the whole snapshot.
     * @param {string} day - Day id
     * @returns {Object|null} The snapshot, or null
     */
    const snapshotBefore = (day) => {
        let best = null;
        const start = dayStart(day);
        for (const [id, snapshot] of Object.entries(closeSnapshots)) {
            const t = dayStart(id);
            if (t >= start) continue;
            if (best === null || t > best.t) best = { t, snapshot };
        }
        return best?.snapshot ?? null;
    };

    const rows = [];
    const totalsSources = emptyTally();
    let totalExplained = 0;

    for (const day of days) {
        const sources = tallies.get(day);
        let explained = 0;
        for (const key of SOURCE_KEYS) {
            explained += sources[key];
            totalsSources[key] += sources[key];
        }
        totalExplained += explained;

        const closeSnapshot = closeSnapshots[day] || null;
        const previousSnapshot = snapshotBefore(day);
        const close = closes[day];
        const previous = previousSnapshot?.total ?? null;
        const delta = Number.isFinite(close) && Number.isFinite(previous) ? close - previous : null;

        rows.push({
            day,
            sources,
            explained,
            delta,
            residual: delta === null ? null : delta - explained,
            // What the day's change was made of, by asset category — null on a
            // day with only one close, because there is no pair to difference
            categories: delta === null ? null : categoryBreakdown(previousSnapshot, closeSnapshot),
        });
    }

    // The window's delta is measured end to end, not summed from the days: a
    // day with no snapshot has no delta of its own, and summing would silently
    // drop whatever happened across it.
    //
    // The baseline is the last close before the window, and failing that the
    // first close inside it — a window that reaches back further than the
    // history does still has a measurable change, just a shorter one than it
    // was asked for.
    const firstDay = days[0];
    const closedDays = days.filter((day) => Number.isFinite(closes[day]));
    let openingSnapshot = firstDay ? snapshotBefore(firstDay) : null;
    let firstClosed = 0;
    if (openingSnapshot === null && closedDays.length > 0) {
        openingSnapshot = closeSnapshots[closedDays[0]];
        firstClosed = 1;
    }
    const closingSnapshot = closedDays.length > firstClosed ? closeSnapshots[closedDays[closedDays.length - 1]] : null;
    const openingClose = openingSnapshot?.total ?? null;
    const lastClose = closingSnapshot?.total ?? null;
    const windowDelta = Number.isFinite(lastClose) && Number.isFinite(openingClose) ? lastClose - openingClose : null;

    return {
        from,
        to,
        days: rows,
        totals: {
            sources: totalsSources,
            explained: totalExplained,
            delta: windowDelta,
            residual: windowDelta === null ? null : windowDelta - totalExplained,
            categories: windowDelta === null ? null : categoryBreakdown(openingSnapshot, closingSnapshot),
        },
        // Price drift on stock held through the detail snapshots' own window,
        // which is about a day and is NOT one of the local days above. Reported
        // on its own for exactly that reason
        marketMovement: marketMovement(detailSnapshots),
        coverage: {
            // Split the same way the attribution loop above splits them: the
            // loot log holds both, and answering "combat has been recorded
            // since" with the date of a foraging entry claims coverage for a
            // source that has never been seen.
            //
            // Combat now has two recordings, so its coverage is the earlier of
            // them: a character who never opened the loot log is covered from
            // its oldest archived run, and saying "nothing recorded" there
            // would be as wrong as the zero this replaced
            combat: earlierOf(
                earlierOf(
                    earliest(lootEntries, (entry) =>
                        actionType(entry?.actionHrid) === '/action_types/combat' ? Date.parse(entry?.startTime) : NaN
                    ),
                    earliestSession
                ),
                combatLoot.liveSince
            ),
            gathering: earliest(lootEntries, (entry) =>
                GATHERING_ACTION_TYPES.includes(actionType(entry?.actionHrid)) ? Date.parse(entry?.startTime) : NaN
            ),
            production: earliest(productionDays, (row) => dayStart(row?.d)),
            tasks: earliest(taskCompletions, (entry) => num(entry?.completedAt) || NaN),
            chests: earliest(chestDays, (row) => dayStart(row?.d)),
            offline: earliest(productionDays, (row) => (row?.offlineProfit ? dayStart(row?.d) : NaN)),
            alchemy: earliest(alchemySessions, (session) => num(session?.startTime) || NaN),
            enhancement: earliest(enhancementSessions, (session) => num(session?.startTime) || NaN),
            marketplace: earliest(tradeFills, (fill) => num(fill?.t) || NaN),
            marketTax: earliest(tradeFills, (fill) => num(fill?.t) || NaN),
            consumables: earliest(combatSessions, (session) => Date.parse(session?.combatStartTime)),
        },
        unpricedAlchemySessions,
        unpricedEnhancementSessions,
        unpricedProductionActions,
        unpricedChestItems,
        unpricedChests,
        // What actually fed the combat row, so the panel can say so rather than
        // calling a fallback and a gap alike "Measured"
        combatBasis: {
            lootLogDays: lootLogCombatDays,
            // The battle feed, live or archived — the panel's one word for both
            sessionDays: sessionCombatDays,
            liveDays: liveCombatDays,
            archiveDays: archiveCombatDays,
            uncoveredDays: uncoveredCombatDays,
            sessions: sessionsInWindow,
            emptySessions: emptyLootSessions,
            sessionsHeld: (combatSessions || []).length,
            sessionCap,
            // The archive's run bound only limits a window the live record
            // does not reach back to the start of
            capReached:
                (combatSessions || []).length >= sessionCap &&
                !(Number.isFinite(combatLoot.liveSince) && combatLoot.liveSince <= from),
            liveSince: combatLoot.liveSince,
            lastLootLog: lastCombatLootLog,
            // Combat loot inside offline windows, handed to the offline row
            offlineCombat,
            ambiguousEntries: combatLoot.ambiguousEntries,
            combatRan,
        },
    };
}
