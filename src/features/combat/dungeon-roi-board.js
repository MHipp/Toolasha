/**
 * Dungeon ROI board
 *
 * Every dungeon at every tier, side by side, in gold per hour.
 *
 * The run history answers "how fast do I clear this", the combat sim answers
 * "how fast would I clear that", the key costing says what a door costs, the
 * chest EV says what a chest is worth and the shop valuation says what a token
 * buys. Each lives in its own module and each is right about its own thing;
 * what nobody did was put them in one row. This does, and says for every
 * figure where it came from — a measured clear time and a simulated one do not
 * carry the same weight, and a board that blurred them would be confidently
 * wrong about the dungeons the player has never run.
 *
 * ## Measured against simulated
 *
 * - **Clear time**: the median of recorded runs for the dungeon and tier. The
 *   median rather than the mean because a run where somebody went for dinner is
 *   in the history too. With no runs, the all-zones snapshot's completions per
 *   simulated hour, marked `sim`. With neither, nothing — per-run economics
 *   still show, the hourly ones do not.
 * - **Consumables and XP**: the combat stats session history, where a session
 *   in this dungeon has been archived (measured, per dungeon — sessions do not
 *   carry the tier); else the snapshot's simulated figures, marked `sim`.
 * - **Keys, tokens, chests**: always priced — these depend on the reward table
 *   and the market, not on having run the place.
 *
 * ## What this does not re-derive
 *
 * Reward counts per completion come through the same expected-drop routine the
 * sim's revenue uses, handed in by the caller; chest value is the expected-value
 * calculator's; a token is worth its best shop line; a key costs the cheaper of
 * buying and crafting. This module only multiplies and divides.
 *
 * Pure and DOM-free so the arithmetic is testable: every price and every
 * reward table arrives through `input`, and the DOM side (`dungeon-roi-board-ui.js`)
 * is only responsible for gathering them.
 */

import { DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import { isRefinementChest } from '../../utils/dungeon-chest-luck.js';
import { ownPlayer } from '../../utils/combat-players.js';

/** Runs at or above which a measured figure is treated as settled */
export const HIGH_CONFIDENCE_RUNS = 20;
/** Runs at or above which a measured figure is more than anecdote */
export const MEDIUM_CONFIDENCE_RUNS = 5;

/** Sort keys the board understands, with the direction a first click should take */
export const ROI_SORT_COLUMNS = {
    dungeon: { asc: true },
    runs: { asc: false },
    clearSeconds: { asc: true },
    wavesPerMinute: { asc: false },
    keyCostPerRun: { asc: true },
    tokenValuePerRun: { asc: false },
    chestEvPerRun: { asc: false },
    consumableCostPerRun: { asc: true },
    netPerRun: { asc: false },
    netPerHour: { asc: false },
    xpPerHour: { asc: false },
};

/**
 * The median of a list of numbers, ignoring anything that is not one.
 * @param {Array<number>} values - Samples
 * @returns {number|null} Null when there is nothing to take a median of
 */
export function median(values) {
    const sorted = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * How much to trust a row, from how many runs stand behind it.
 *
 * @param {number} runs - Recorded runs on the row
 * @param {boolean} hasSim - Whether the sim had anything to say when runs did not
 * @returns {{label: string, tone: 'good'|'ok'|'dim'|'sim'|'none'}}
 */
export function confidenceTag(runs, hasSim) {
    if (runs >= HIGH_CONFIDENCE_RUNS) return { label: 'high', tone: 'good' };
    if (runs >= MEDIUM_CONFIDENCE_RUNS) return { label: 'medium', tone: 'ok' };
    if (runs > 0) return { label: 'low', tone: 'dim' };
    if (hasSim) return { label: 'sim', tone: 'sim' };
    return { label: 'none', tone: 'none' };
}

/**
 * A run's tier, where the record carries one.
 * @param {Object} run - A stored run
 * @returns {number|null}
 */
function runTier(run) {
    if (run?.tier === null || run?.tier === undefined || run.tier === '') return null;
    const tier = Number(run.tier);
    return Number.isInteger(tier) && tier >= 0 ? tier : null;
}

/**
 * How many were in the party for a run.
 * @param {Object} run - A stored run
 * @returns {number} At least 1
 */
export function runPartySize(run) {
    if (Array.isArray(run?.team) && run.team.length) return run.team.length;
    if (typeof run?.teamKey === 'string' && run.teamKey) return run.teamKey.split(',').filter(Boolean).length || 1;
    return 1;
}

/**
 * A run's length in milliseconds, whichever field the recording route used.
 * @param {Object} run - A stored run
 * @returns {number|null}
 */
function runDurationMs(run) {
    const ms = Number(run?.duration ?? run?.totalTime);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The most common value in a list, ties to the larger.
 * @param {Array<number>} values - Samples
 * @returns {number|null}
 */
function mode(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    let best = null;
    for (const [value, count] of counts) {
        if (best === null || count > best.count || (count === best.count && value > best.value)) {
            best = { value, count };
        }
    }
    return best ? best.value : null;
}

/**
 * Group stored runs by dungeon name and tier.
 *
 * Runs recorded without a tier (the chat backfill route never sees one) go under
 * `null`, which the board draws as its own "T?" row rather than guessing which
 * tier they were.
 *
 * @param {Array<Object>} runs - Stored runs, already narrowed to the character
 * @returns {Map<string, Map<number|null, Array<Object>>>} dungeonName → tier → runs
 */
export function groupRunsByDungeonTier(runs) {
    const byName = new Map();
    for (const run of runs || []) {
        if (!run?.dungeonName || run.dungeonName === 'Unknown') continue;
        if (!byName.has(run.dungeonName)) byName.set(run.dungeonName, new Map());
        const byTier = byName.get(run.dungeonName);
        const tier = runTier(run);
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(run);
    }
    return byName;
}

/**
 * What the session history measured for one dungeon: consumables and XP per
 * hour for the character, over every archived session in that zone.
 *
 * Sessions name the action but not the tier, so the figure is per dungeon.
 *
 * @param {Array<Object>} sessions - From `combat-session-history`'s `loadSessions`
 * @param {string} dungeonHrid - The dungeon action
 * @param {Function} consumablePrice - `(itemHrid) => number|null`
 * @returns {{hours: number, consumableCostPerHour: number, xpPerHour: number, sessions: number}|null}
 */
export function measuredSessionRates(sessions, dungeonHrid, consumablePrice) {
    let seconds = 0;
    let cost = 0;
    let xp = 0;
    let count = 0;

    for (const session of sessions || []) {
        if (!session || session.actionHrid !== dungeonHrid) continue;
        const duration = Number(session.durationSeconds);
        if (!(duration > 0)) continue;
        const me = ownPlayer(session.players);
        if (!me) continue;

        seconds += duration;
        count += 1;
        for (const consumable of me.consumables || []) {
            const consumed = Number(consumable?.consumed) || 0;
            if (consumed <= 0) continue;
            const price = Number(consumablePrice(consumable.itemHrid)) || 0;
            cost += consumed * price;
        }
        for (const value of Object.values(me.experience || {})) xp += Number(value) || 0;
    }

    if (!(seconds > 0)) return null;
    const hours = seconds / 3600;
    return { hours, consumableCostPerHour: cost / hours, xpPerHour: xp / hours, sessions: count };
}

/**
 * The snapshot's simulated reading for one dungeon and tier, when the run that
 * made it recorded the dungeon figures (older snapshots carry only profit and XP).
 *
 * @param {Object|null} snapshot - From `loadAllZonesSnapshot`
 * @param {string} dungeonHrid - The dungeon action
 * @param {number} tier - Difficulty tier
 * @returns {{clearSeconds: number|null, partySize: number|null, consumableCostPerHour: number|null,
 *   xpPerHour: number|null, deathsPerHour: number|null}|null}
 */
export function simReading(snapshot, dungeonHrid, tier) {
    const zone = (snapshot?.zones || []).find(
        (entry) => entry?.zoneHrid === dungeonHrid && (entry.difficultyTier ?? 0) === tier
    );
    if (!zone) return null;

    const dungeon = zone.dungeon || null;
    const completions = Number(dungeon?.completions) || 0;
    const simHours = Number(dungeon?.simHours) || 0;

    return {
        clearSeconds: completions > 0 && simHours > 0 ? (simHours * 3600) / completions : null,
        partySize: Number.isFinite(dungeon?.partySize) && dungeon.partySize > 0 ? dungeon.partySize : null,
        consumableCostPerHour: Number.isFinite(dungeon?.consumableCostPerHour) ? dungeon.consumableCostPerHour : null,
        xpPerHour: Number.isFinite(zone.xpPerHour) ? zone.xpPerHour : null,
        deathsPerHour: Number.isFinite(dungeon?.deathsPerHour) ? dungeon.deathsPerHour : null,
    };
}

/**
 * Price one completion's rewards: tokens, chests and anything else the table pays.
 *
 * @param {Map<string, number>} rewards - itemHrid → expected count per completion
 * @param {Object} pricing - The caller's price functions
 * @param {Function} pricing.valueOf - `(itemHrid) => number|null`, net sell value of a reward
 * @param {Function} pricing.tokenValue - `(itemHrid) => number|null`, shop valuation of a token
 * @param {Function} pricing.isToken - `(itemHrid) => boolean`
 * @returns {{tokensPerRun: number, tokenHrid: string|null, tokenValuePerRun: number, chestsPerRun: number,
 *   refinementChestsPerRun: number, chestEvPerRun: number, otherValuePerRun: number,
 *   items: Array<{itemHrid: string, count: number, unitValue: number|null, value: number, kind: string}>}}
 */
export function priceRewards(rewards, pricing) {
    const out = {
        tokensPerRun: 0,
        tokenHrid: null,
        tokenValuePerRun: 0,
        chestsPerRun: 0,
        refinementChestsPerRun: 0,
        chestEvPerRun: 0,
        otherValuePerRun: 0,
        items: [],
    };

    for (const [itemHrid, count] of rewards || []) {
        if (!(count > 0)) continue;

        let kind = 'other';
        let unitValue = null;
        if (pricing.isToken?.(itemHrid)) {
            kind = 'token';
            unitValue = pricing.tokenValue?.(itemHrid) ?? null;
            out.tokensPerRun += count;
            out.tokenHrid = out.tokenHrid || itemHrid;
        } else if (DUNGEON_CHEST_CHEST_KEYS[itemHrid]) {
            kind = 'chest';
            unitValue = pricing.valueOf?.(itemHrid) ?? null;
            if (isRefinementChest(itemHrid)) out.refinementChestsPerRun += count;
            else out.chestsPerRun += count;
        } else {
            unitValue = pricing.valueOf?.(itemHrid) ?? null;
        }

        const value = Number.isFinite(unitValue) && unitValue > 0 ? unitValue * count : 0;
        if (kind === 'token') out.tokenValuePerRun += value;
        else if (kind === 'chest') out.chestEvPerRun += value;
        else out.otherValuePerRun += value;

        out.items.push({ itemHrid, count, unitValue, value, kind });
    }

    return out;
}

/**
 * What the keys for one completion cost: one entry key to get in, one chest key
 * per chest the completion pays (refinement chests included — they take a chest
 * key to open like any other).
 *
 * @param {string} dungeonHrid - The dungeon action
 * @param {Object} rewards - From `priceRewards`
 * @param {Object} input - Key lookups
 * @param {Function} input.entryKeyFor - `(dungeonHrid) => itemHrid|null`
 * @param {Function} input.keyCost - `(keyHrid) => number|null`
 * @returns {{total: number|null, entries: Array<{itemHrid: string, count: number, unitCost: number|null}>}}
 */
export function priceKeys(dungeonHrid, rewards, { entryKeyFor, keyCost }) {
    const entries = [];
    let total = 0;
    let anyPriced = false;
    // entryKeyFor returning null means "no key could be identified for this
    // dungeon", not "this dungeon needs no key" - every dungeon takes an entry
    // key. Track that gap separately so an unresolvable key still trips
    // `complete` below, even though it has no entry to compare unitCost on.
    let unresolvedEntryKey = false;

    const entryKey = entryKeyFor?.(dungeonHrid) ?? null;
    if (entryKey) {
        const unitCost = keyCost?.(entryKey) ?? null;
        entries.push({ itemHrid: entryKey, count: 1, unitCost });
        if (Number.isFinite(unitCost)) {
            total += unitCost;
            anyPriced = true;
        }
    } else {
        unresolvedEntryKey = true;
    }

    // Which chest key: every chest this dungeon pays answers to the same one
    let chestKeyHrid = null;
    for (const item of rewards.items) {
        const key = DUNGEON_CHEST_CHEST_KEYS[item.itemHrid];
        if (key) {
            chestKeyHrid = key;
            break;
        }
    }
    const chests = rewards.chestsPerRun + rewards.refinementChestsPerRun;
    if (chestKeyHrid && chests > 0) {
        const unitCost = keyCost?.(chestKeyHrid) ?? null;
        entries.push({ itemHrid: chestKeyHrid, count: chests, unitCost });
        if (Number.isFinite(unitCost)) {
            total += unitCost * chests;
            anyPriced = true;
        }
    }

    // Complete only when nothing was left out: an entry with no price is a cost
    // the total does not carry, and a net built on it would read as profit.
    // An empty `entries` array is vacuously "every priced", so an unresolved
    // entry key (no entry pushed for it at all) must fail this explicitly.
    const complete = !unresolvedEntryKey && entries.every((entry) => Number.isFinite(entry.unitCost));
    return { total: anyPriced ? total : null, entries, complete };
}

/**
 * Build the board.
 *
 * @param {Object} input - Everything the board reads
 * @param {Array<{hrid: string, name: string, maxWaves: number, maxDifficulty: number}>} input.dungeons -
 *   Every dungeon the game data knows, in display order
 * @param {Array<Object>} input.runs - Stored runs, already narrowed to the character
 * @param {Array<Object>} [input.sessions] - Combat session history, for measured consumables and XP
 * @param {Object|null} [input.snapshot] - The all-zones sim snapshot, for the simulated side
 * @param {Object} [input.filters] - `{tier: 'all'|number, partySize: 'all'|number}`
 * @param {number} [input.dropQuantity] - The character's combat drop quantity bonus, as a fraction
 * @param {Object} input.pricing - Price and reward functions
 * @param {Function} input.pricing.rewardsPerRun - `(dungeonHrid, tier, partySize, dropQuantity) => Map<itemHrid, count>`
 * @param {Function} input.pricing.valueOf - `(itemHrid) => number|null`
 * @param {Function} input.pricing.tokenValue - `(itemHrid) => number|null`
 * @param {Function} input.pricing.isToken - `(itemHrid) => boolean`
 * @param {Function} input.pricing.keyCost - `(keyHrid) => number|null`
 * @param {Function} input.pricing.entryKeyFor - `(dungeonHrid) => itemHrid|null`
 * @param {Function} input.pricing.consumablePrice - `(itemHrid) => number|null`
 * @returns {Array<Object>} Rows, sorted by net gold per hour, best first
 */
export function buildDungeonRoiRows(input) {
    const {
        dungeons = [],
        runs = [],
        sessions = [],
        snapshot = null,
        filters = {},
        dropQuantity = 0,
        pricing = {},
    } = input || {};

    const tierFilter = filters.tier === 'all' || filters.tier === undefined ? 'all' : Number(filters.tier);
    const partyFilter =
        filters.partySize === 'all' || filters.partySize === undefined ? 'all' : Number(filters.partySize);

    const narrowed = partyFilter === 'all' ? runs : runs.filter((run) => runPartySize(run) === partyFilter);
    const grouped = groupRunsByDungeonTier(narrowed);
    const rows = [];

    for (const dungeon of dungeons) {
        if (!dungeon?.hrid) continue;
        const byTier = grouped.get(dungeon.name) || new Map();
        const measured = measuredSessionRates(sessions, dungeon.hrid, pricing.consumablePrice || (() => null));

        const tiers = [];
        for (let tier = 0; tier <= (dungeon.maxDifficulty || 0); tier++) tiers.push(tier);
        // Runs recorded without a tier get a row of their own, priced as T0
        if (byTier.has(null)) tiers.push(null);

        for (const tier of tiers) {
            if (tierFilter !== 'all' && tier !== tierFilter) continue;

            const tierRuns = byTier.get(tier) || [];
            const economicsTier = tier ?? 0;
            const sim = tier === null ? null : simReading(snapshot, dungeon.hrid, tier);

            const durations = tierRuns.map(runDurationMs).filter(Boolean);
            const measuredClearSeconds = durations.length ? median(durations) / 1000 : null;
            const clearSeconds = measuredClearSeconds ?? sim?.clearSeconds ?? null;
            const clearSource = measuredClearSeconds !== null ? 'measured' : sim?.clearSeconds ? 'sim' : null;

            let partySize;
            let partySizeSource;
            if (partyFilter !== 'all') {
                partySize = partyFilter;
                partySizeSource = 'filter';
            } else if (tierRuns.length) {
                partySize = mode(tierRuns.map(runPartySize)) || 1;
                partySizeSource = 'runs';
            } else if (sim?.partySize) {
                partySize = sim.partySize;
                partySizeSource = 'sim';
            } else {
                partySize = 1;
                partySizeSource = 'default';
            }

            let rewardMap = new Map();
            try {
                rewardMap = pricing.rewardsPerRun?.(dungeon.hrid, economicsTier, partySize, dropQuantity) || new Map();
            } catch (error) {
                console.error(`[DungeonRoiBoard] Reward table for ${dungeon.hrid} T${economicsTier} failed:`, error);
            }
            const rewards = priceRewards(rewardMap, pricing);
            const keys = priceKeys(dungeon.hrid, rewards, pricing);

            const revenuePerRun = rewards.tokenValuePerRun + rewards.chestEvPerRun + rewards.otherValuePerRun;

            let consumableCostPerHour = null;
            let consumableSource = null;
            if (measured && Number.isFinite(measured.consumableCostPerHour)) {
                consumableCostPerHour = measured.consumableCostPerHour;
                consumableSource = 'measured';
            } else if (sim && Number.isFinite(sim.consumableCostPerHour)) {
                consumableCostPerHour = sim.consumableCostPerHour;
                consumableSource = 'sim';
            }

            let xpPerHour = null;
            let xpSource = null;
            if (measured && Number.isFinite(measured.xpPerHour) && measured.xpPerHour > 0) {
                xpPerHour = measured.xpPerHour;
                xpSource = 'measured';
            } else if (sim && Number.isFinite(sim.xpPerHour)) {
                xpPerHour = sim.xpPerHour;
                xpSource = 'sim';
            }

            const runsPerHour = clearSeconds > 0 ? 3600 / clearSeconds : null;
            const consumableCostPerRun =
                consumableCostPerHour !== null && runsPerHour ? consumableCostPerHour / runsPerHour : null;

            // Net per run is what a completion leaves after its keys and its
            // consumables — and only when both are actually known. Treating an
            // unpriced key or an unknown food bill as zero turned a cost the
            // board could not see into profit it reported, which is the one
            // number nobody should have to second-guess.
            const costGap = !keys.complete ? 'keys' : consumableCostPerRun === null ? 'consumables' : null;
            const costComplete = costGap === null;
            const netPerRun = costComplete ? revenuePerRun - (keys.total || 0) - consumableCostPerRun : null;
            const netPerHour = costComplete && runsPerHour ? netPerRun * runsPerHour : null;
            const wavesPerMinute =
                clearSeconds > 0 && dungeon.maxWaves > 0 ? dungeon.maxWaves / (clearSeconds / 60) : null;

            rows.push({
                key: `${dungeon.hrid}::T${tier === null ? '?' : tier}`,
                dungeonHrid: dungeon.hrid,
                dungeonName: dungeon.name,
                tier,
                tierLabel: tier === null ? 'T?' : `T${tier}`,
                tierAssumed: tier === null,
                maxWaves: dungeon.maxWaves || 0,
                runs: tierRuns.length,
                partySize,
                partySizeSource,
                clearSeconds,
                clearSource,
                wavesPerMinute,
                keyCostPerRun: keys.total,
                keyEntries: keys.entries,
                tokenHrid: rewards.tokenHrid,
                tokensPerRun: rewards.tokensPerRun,
                tokenValuePerRun: rewards.tokenValuePerRun,
                chestsPerRun: rewards.chestsPerRun,
                refinementChestsPerRun: rewards.refinementChestsPerRun,
                chestEvPerRun: rewards.chestEvPerRun,
                otherValuePerRun: rewards.otherValuePerRun,
                rewardItems: rewards.items,
                revenuePerRun,
                consumableCostPerHour,
                consumableCostPerRun,
                consumableSource,
                netPerRun,
                runsPerHour,
                netPerHour,
                costComplete,
                costGap,
                xpPerHour,
                xpSource,
                simDeathsPerHour: sim?.deathsPerHour ?? null,
                confidence: confidenceTag(tierRuns.length, Boolean(sim?.clearSeconds)),
            });
        }
    }

    return sortRoiRows(rows, 'netPerHour', false);
}

/**
 * Order rows by a column, nulls last whichever way the sort runs.
 *
 * @param {Array<Object>} rows - From `buildDungeonRoiRows`
 * @param {string} column - A key of `ROI_SORT_COLUMNS`
 * @param {boolean} asc - Ascending
 * @returns {Array<Object>} A new array
 */
export function sortRoiRows(rows, column, asc) {
    const list = [...(rows || [])];
    const dir = asc ? 1 : -1;

    list.sort((a, b) => {
        if (column === 'dungeon') {
            const byName = String(a.dungeonName).localeCompare(String(b.dungeonName));
            if (byName !== 0) return byName * dir;
            return ((a.tier ?? 99) - (b.tier ?? 99)) * dir;
        }

        const av = a[column];
        const bv = b[column];
        const aMissing = !Number.isFinite(av);
        const bMissing = !Number.isFinite(bv);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (av === bv) return 0;
        return (av - bv) * dir;
    });

    return list;
}
