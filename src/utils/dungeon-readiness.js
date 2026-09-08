/**
 * Dungeon party readiness
 *
 * What can honestly be checked *before* the party enters, and — just as
 * importantly — what cannot.
 *
 * ## The shape of the problem
 *
 * A dungeon run is the one combat activity where stopping halfway is expensive:
 * the entry key is already spent, and the member who ran out of food takes the
 * whole party's clear down with them. So the useful moment to check is the
 * lobby, before the key is committed. The trouble is that the lobby is also the
 * moment the client knows least.
 *
 * The pre-run payload (`characterData.partyInfo`) carries member IDs, names,
 * the selected dungeon and its tier. It carries **no** equipment, **no**
 * consumables and **no** levels for anybody. Everything richer arrives with
 * `new_battle`, which is to say after the key is spent. A cached profile — one
 * the player happened to open in game at some point — can fill in a member's
 * gear, abilities and skills, and nothing can fill in their food.
 *
 * The one exception is entry keys. The game broadcasts a key-count message to
 * party chat naming every member and the keys they have left; the dungeon
 * tracker parses it and holds it for the run. That is server-stated, not
 * inferred, so a member's key line is as exact as the player's own — and it is
 * the only member figure that exists without a captured profile. Food and
 * drinks stay unknowable, and a member with keys read and food unread is
 * **not** a member who has been read.
 *
 * ## So this module reports three states, never two
 *
 * Every line is `known`, `unknown` or absent, and `unknown` carries the reason.
 * The alternative — quietly treating an unknown as fine — is the failure mode
 * that makes a readiness check worse than no readiness check: a green card that
 * means "I could not see four of the five people" reads exactly like a green
 * card that means "everyone is stocked".
 *
 * Pure throughout. Party rosters, inventories, profiles and run history all
 * arrive as arguments; nothing here imports game state.
 */

import { levelGapDebuff } from './dungeon-level-gap.js';

/** Why a member's supplies could not be read */
export const UNKNOWN_CONSUMABLES = 'not in party data';

/** Why a member's level could not be read */
export const UNKNOWN_LEVEL = 'no captured profile';

/** Why a member's entry keys could not be read */
export const UNKNOWN_KEYS = 'no key count in party chat yet';

/** One entry key per clear — the one dungeon quantity that needs no measuring */
export const KEYS_PER_RUN = 1;

/**
 * The largest run count the plan will accept.
 *
 * A hundred thousand runs is over a year of continuous dungeoning at the
 * ten-minute run lengths this card measures, so nothing above it is a plan —
 * it is a typo, and a typo that would price a shortfall in the trillions and
 * paint every line red. The bound is deliberately far above the largest figure
 * anybody has actually held (a food pile good for a few thousand runs), so it
 * rejects nonsense without ever refusing an honest number.
 */
export const MAX_RUNS_PLANNED = 100000;

/**
 * A typed run count, or nothing.
 *
 * Rejects rather than clamps: silently turning a mistyped 1000000 into 100000
 * would answer a question the player did not ask, and the caller's contract is
 * that a rejected entry leaves the stored plan exactly as it was. Separators
 * are tolerated because the card prints them, so "2,753" is what a player
 * copying a figure off their own card will type back.
 *
 * @param {string|number} raw - Whatever was typed
 * @returns {number|null} A whole run count in 1..{@link MAX_RUNS_PLANNED}, or null
 */
export function parseRunsPlanned(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const text = String(raw)
        .trim()
        .replace(/[,\s_]/g, '');
    // `Number('')` is 0 and `Number('0x10')` is 16; neither is a run count
    if (!/^\d+$/.test(text)) return null;
    const runs = Number(text);
    if (!Number.isFinite(runs) || runs < 1 || runs > MAX_RUNS_PLANNED) return null;
    return Math.floor(runs);
}

/**
 * The next preset above where the plan is now.
 *
 * Strictly greater rather than "the step after this one's index", because a
 * typed count is usually not a step at all: from 2,753 the index lookup misses
 * and the old cycle restarted at the first step, which reads as the button
 * having forgotten the number the player just typed. Stepping up past the
 * current value keeps the cycle monotone from wherever it starts, and the wrap
 * back to the smallest step is then the one deliberate jump.
 *
 * @param {number} current - The plan now, typed or cycled
 * @param {Array<number>} steps - The presets, ascending
 * @returns {number} The next preset, wrapping at the top
 */
export function nextRunStep(current, steps) {
    const ladder = (steps || []).filter((step) => Number.isFinite(step) && step > 0).sort((a, b) => a - b);
    if (!ladder.length) return Math.max(1, Math.floor(Number(current) || 1));
    const now = Number(current) || 0;
    return ladder.find((step) => step > now) ?? ladder[0];
}

/**
 * Buying the missing keys against crafting them.
 *
 * The shortfall figure on the key line says how many keys are not in the bag,
 * and until now it implied a purchase. Entry keys have a recipe, and on a thin
 * key market the materials are routinely cheaper than the key — so the figure
 * worth showing is both totals and which one wins.
 *
 * Nothing here decides which route to take: `cost` arrives from
 * `utils/key-cost.js`, which already priced both sides **on one basis** and
 * named the route its `cheaper` field carries. Re-deciding it would be the
 * exact failure the own-use line was fixed for — one side quoted at ask, the
 * other at the user's mode — and would let this card disagree with the ROI
 * board about the same key. It would also overrule the craft pricing mode,
 * whose whole point is to take the craft cost where the market undercuts it.
 *
 * `costBasis` says which of those two happened, so the card can word the line
 * as a comparison or as a stated preference rather than always claiming the
 * cheaper route won. `saves` is only filled in when the route taken really is
 * the cheaper of the two; on the craft basis it can be the dearer one, and
 * "saving" would then be a lie about the reader's own gold.
 *
 * A route that cannot be priced is null, never zero. When neither can be, the
 * whole plan is null and the card says the key cannot be costed: a free craft
 * is the one answer that would send somebody to a bench for nothing.
 *
 * @param {Object} input - The shortfall and what a key costs
 * @param {number} input.shortfall - Keys missing, from `keyReadiness`
 * @param {Object|null} input.cost - From `describeKeyCost`
 * @returns {{shortfall: number, buyEach: number|null, craftEach: number|null, buyTotal: number|null,
 *   craftTotal: number|null, cheaper: 'buy'|'craft'|null, total: number|null, saves: number|null,
 *   priceBasis: 'ask'|'bid', costBasis: 'market'|'craft', craftSeconds: number|null}|null} Null when
 *   there is no shortfall to price; a plan with `cheaper: null` when neither route could be priced
 */
export function keyShortfallCost({ shortfall = 0, cost = null } = {}) {
    const missing = Math.max(0, Math.floor(Number(shortfall) || 0));
    if (!missing) return null;

    const each = (value) => (Number.isFinite(value) && value > 0 ? value : null);
    const buyEach = each(cost?.buyPrice);
    const craftEach = each(cost?.craftCost);
    const priceBasis = cost?.pricingMode === 'bid' ? 'bid' : 'ask';
    const costBasis = cost?.basis === 'craft' ? 'craft' : 'market';
    const times = (value) => (value === null ? null : value * missing);

    const plan = {
        shortfall: missing,
        buyEach,
        craftEach,
        buyTotal: times(buyEach),
        craftTotal: times(craftEach),
        cheaper: null,
        total: null,
        saves: null,
        priceBasis,
        costBasis,
        craftSeconds: null,
    };

    if (buyEach === null && craftEach === null) return plan;

    // A tie goes to buying, the way `describeKeyCost` calls it: the two cost
    // the same gold and only one of them also costs the player an afternoon
    const cheapest = craftEach === null ? 'buy' : buyEach === null ? 'craft' : craftEach < buyEach ? 'craft' : 'buy';
    // The costing's own verdict wins, but only where it names a route this
    // shortfall could actually be filled by: a stale or unpriceable side would
    // otherwise put a null total on the line.
    const stated = cost?.cheaper === 'craft' ? craftEach !== null : cost?.cheaper === 'buy' ? buyEach !== null : false;
    plan.cheaper = stated ? cost.cheaper : cheapest;
    plan.total = plan.cheaper === 'craft' ? plan.craftTotal : plan.buyTotal;
    if (buyEach !== null && craftEach !== null && plan.cheaper === cheapest) {
        plan.saves = Math.abs(plan.buyTotal - plan.craftTotal);
    }
    if (plan.cheaper === 'craft' && Number.isFinite(cost?.craftSeconds) && cost.craftSeconds > 0) {
        plan.craftSeconds = cost.craftSeconds * missing;
    }
    return plan;
}

/**
 * How many whole runs a stock covers, given how long a run takes.
 *
 * Whole runs, floored: half a run of food is not a run, and a party that stops
 * on wave six has spent the key either way.
 *
 * @param {number} secondsLeft - Until the stock runs out; `Infinity` when unused
 * @param {number|null} runSeconds - How long one run takes
 * @returns {number|null} Whole runs, or null when either side is unknown
 */
export function runsCovered(secondsLeft, runSeconds) {
    if (!(runSeconds > 0)) return null;
    if (!Number.isFinite(secondsLeft)) return null;
    if (!(secondsLeft >= 0)) return null;
    return Math.floor(secondsLeft / runSeconds);
}

/**
 * A dungeon's typical run length, from this character's own recorded runs.
 *
 * The median rather than the mean, because a run history contains disconnects
 * and afk restarts, and one four-hour "run" drags a mean far enough to make the
 * coverage figure useless.
 *
 * @param {Array<Object>} runs - Stored runs (`{dungeonName, tier, duration}`, ms)
 * @param {Object} [match] - Which runs count
 * @param {string} [match.dungeonName] - The dungeon
 * @param {number|null} [match.tier] - Its tier; runs with no tier recorded still count
 * @returns {{seconds: number, samples: number}|null} Null without usable history
 */
export function typicalRunSeconds(runs, { dungeonName, tier = null } = {}) {
    if (!dungeonName || dungeonName === 'Unknown') return null;

    const durations = [];
    for (const run of runs || []) {
        if (!run || run.dungeonName !== dungeonName) continue;
        if (tier !== null && tier !== undefined && run.tier !== null && run.tier !== undefined && run.tier !== tier) {
            continue;
        }
        const ms = Number(run.duration ?? run.totalTime);
        if (Number.isFinite(ms) && ms > 0) durations.push(ms);
    }

    if (!durations.length) return null;

    durations.sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const median = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];

    return { seconds: median / 1000, samples: durations.length };
}

/**
 * The key line: what is held against what the plan wants.
 *
 * @param {Object} input - The key situation
 * @param {string|null} input.itemHrid - The dungeon's entry key
 * @param {string} [input.itemName] - Its display name
 * @param {number} input.held - How many are in the inventory
 * @param {number} input.runsPlanned - How many runs the player intends
 * @returns {{itemHrid: string|null, itemName: string, held: number, runsPlanned: number,
 *   runsCovered: number, shortfall: number, enough: boolean}|null} Null outside a dungeon
 */
export function keyReadiness({ itemHrid, itemName = '', held = 0, runsPlanned = 1 } = {}) {
    if (!itemHrid) return null;

    const stock = Math.max(0, Number(held) || 0);
    const planned = Math.max(0, Math.floor(Number(runsPlanned) || 0));
    const covered = Math.floor(stock / KEYS_PER_RUN);

    return {
        itemHrid,
        itemName: itemName || itemHrid.split('/').pop(),
        held: stock,
        runsPlanned: planned,
        runsCovered: covered,
        shortfall: Math.max(0, planned * KEYS_PER_RUN - stock),
        enough: covered >= planned,
    };
}

/**
 * One party member's line.
 *
 * A member whose consumables were never visible gets `runsCovered: null` and a
 * reason, not a zero and not an optimistic blank. Their keys are a separate
 * reading with a separate unknown, because the two arrive from different places
 * and one of them can be known while the other is not: `unknown` stays set for
 * a member whose keys were counted but whose food was never seen, so nothing
 * downstream can mistake a half-read member for a read one.
 *
 * @param {Object} input - What is known about them
 * @param {string} input.name - Their name
 * @param {boolean} [input.isSelf] - Whether this is the logged-in character
 * @param {Array<Object>|null} [input.forecasts] - Their consumables as
 *   `consumable-forecast` normalised them, or null when never seen
 * @param {number|null} [input.combatLevel] - Their combat level, where known
 * @param {number|null} [input.runSeconds] - How long one run takes
 * @param {string} [input.measuredFrom] - Where the consumable reading came from
 * @param {number|null} [input.keysHeld] - Entry keys they hold, where stated
 * @param {string} [input.keyName] - What to call the key on their line
 * @param {string} [input.keysFrom] - Where the key count came from
 * @returns {{name: string, isSelf: boolean, combatLevel: number|null, runsCovered: number|null,
 *   secondsLeft: number|null, limitedBy: string|null, unknown: string|null, measuredFrom: string|null,
 *   keysHeld: number|null, keyRunsCovered: number|null, keyName: string, keysUnknown: string|null,
 *   keysFrom: string|null}}
 */
export function memberReadiness({
    name,
    isSelf = false,
    forecasts = null,
    combatLevel = null,
    runSeconds = null,
    measuredFrom = null,
    keysHeld = null,
    keyName = '',
    keysFrom = null,
} = {}) {
    const keys = Number.isFinite(keysHeld) && keysHeld >= 0 ? Math.floor(keysHeld) : null;
    const row = {
        name: name || 'Unknown player',
        isSelf: Boolean(isSelf),
        combatLevel: Number.isFinite(combatLevel) && combatLevel > 0 ? combatLevel : null,
        runsCovered: null,
        secondsLeft: null,
        limitedBy: null,
        unknown: UNKNOWN_CONSUMABLES,
        measuredFrom: null,
        keysHeld: keys,
        keyRunsCovered: keys === null ? null : Math.floor(keys / KEYS_PER_RUN),
        keyName: keyName || 'entry keys',
        keysUnknown: keys === null ? UNKNOWN_KEYS : null,
        keysFrom: keys === null ? null : keysFrom,
    };

    if (!Array.isArray(forecasts) || !forecasts.length) return row;

    // A run ends on the first empty slot, so the member's figure is the minimum
    // over slots that are actually being consumed — a slot with no rate is not
    // "lasts forever", it is "not measured", and must not win a minimum
    let soonest = null;
    for (const entry of forecasts) {
        if (!Number.isFinite(entry?.secondsLeft)) continue;
        if (!soonest || entry.secondsLeft < soonest.secondsLeft) soonest = entry;
    }

    if (!soonest) return row;

    row.unknown = null;
    row.measuredFrom = measuredFrom;
    row.secondsLeft = soonest.secondsLeft;
    row.limitedBy = soonest.name || soonest.itemHrid || null;
    row.runsCovered = runsCovered(soonest.secondsLeft, runSeconds);
    return row;
}

/**
 * Who is short of entry keys, and by how much.
 *
 * The card already says the party is short. The question at the party screen is
 * *which* member, and the answer has to be one somebody can paste into party
 * chat — so this is per member, not a total, and it is worded from the member's
 * point of view rather than the reader's.
 *
 * A member whose key count was never stated is `has: null`, never zero. Nobody
 * has sent a key-count message naming them, which is not the same as them
 * holding nothing, and asking somebody for three keys they already have is the
 * one way this line could waste the party's time. Their `short` is null for the
 * same reason: an absent number is not a shortfall.
 *
 * Members at or above the requirement are dropped. A list that named everybody
 * would put the reader back where they started — reading five lines to find the
 * one that matters.
 *
 * @param {Object} input - The party and the plan
 * @param {Array<Object>} input.members - From {@link memberReadiness}
 * @param {number} [input.runsPlanned] - How many runs the party intends
 * @returns {Array<{name: string, has: number|null, needs: number, short: number|null}>} Short
 *   members first, by shortfall descending; members whose count is unknown last
 */
export function keyShortfalls({ members = [], runsPlanned = 1 } = {}) {
    const needs = Math.max(0, Math.floor(Number(runsPlanned) || 0)) * KEYS_PER_RUN;

    const rows = [];
    for (const member of members || []) {
        if (!member) continue;
        const has = Number.isFinite(member.keysHeld) && member.keysHeld >= 0 ? Math.floor(member.keysHeld) : null;
        if (has !== null && has >= needs) continue;
        rows.push({
            name: member.name || 'Unknown player',
            has,
            needs,
            short: has === null ? null : needs - has,
        });
    }

    // Unknown sorts last rather than as a large or a small shortfall: it is not
    // a shortfall at all, and ranking it against real ones would put a member
    // nobody has heard from above a member who is genuinely eight keys down
    return rows.sort((a, b) => {
        if (a.short === null && b.short === null) return 0;
        if (a.short === null) return 1;
        if (b.short === null) return -1;
        return b.short - a.short;
    });
}

/**
 * One shortfall as a line to paste into party chat.
 *
 * @param {{name: string, has: number|null, needs: number, short: number|null}} row - From
 *   {@link keyShortfalls}
 * @returns {string} e.g. `bun needs 3 more keys (has 12 of 15)`
 */
export function formatKeyShortfall(row) {
    if (!row) return '';
    if (row.short === null) return `${row.name} key count unknown (needs ${row.needs})`;
    return `${row.name} needs ${row.short} more key${row.short === 1 ? '' : 's'} (has ${row.has} of ${row.needs})`;
}

/**
 * The whole list as text, which is what the card's copy button puts on the clipboard.
 *
 * @param {Array<Object>} rows - From {@link keyShortfalls}
 * @returns {string} One line per member, newline separated; '' when nobody is listed
 */
export function formatKeyShortfalls(rows) {
    return (rows || [])
        .map((row) => formatKeyShortfall(row))
        .filter(Boolean)
        .join('\n');
}

/**
 * The soonest thing that stops this member, out of what is actually known.
 *
 * Two readings can bind: the food that empties first, and the keys that run
 * out. Keys are compared only when both are counted in runs — with no recorded
 * run length the food figure is a duration and the key figure is a count, and
 * picking a winner between them would be arithmetic on two different units.
 *
 * A tie goes to food: both stop the same run, and food is the reading the
 * panel above can already do something about.
 *
 * @param {Object} row - From `memberReadiness`
 * @returns {{runs: number|null, secondsLeft: number|null, label: string|null,
 *   source: 'food'|'keys'|null}} `source: null` when nothing about them was read
 */
export function memberLimit(row) {
    const food = row && row.unknown === null && Number.isFinite(row.secondsLeft) ? row : null;
    const keyRuns = Number.isFinite(row?.keyRunsCovered) ? row.keyRunsCovered : null;
    const keys = { runs: keyRuns, secondsLeft: null, label: row?.keyName || 'entry keys', source: 'keys' };

    if (!food) return keyRuns === null ? { runs: null, secondsLeft: null, label: null, source: null } : keys;
    if (keyRuns !== null && Number.isFinite(food.runsCovered) && keyRuns < food.runsCovered) return keys;
    return { runs: food.runsCovered, secondsLeft: food.secondsLeft, label: food.limitedBy, source: 'food' };
}

/**
 * Who runs dry first, among the members something could actually be read for.
 *
 * Scoped to the readable ones on purpose: "you stop first" is a different claim
 * from "you stop first out of the one person I could see", and the card says
 * which by reporting how many were counted — `known` for the members whose food
 * was measured, `partial` for the ones only a key count exists for. A member in
 * `partial` is not a member who was read: their keys can only put a ceiling on
 * their runs, and their food could stop them long before it.
 *
 * @param {Array<Object>} rows - From `memberReadiness`
 * @returns {{name: string, runsCovered: number|null, secondsLeft: number|null,
 *   limitedBy: string|null, source: 'food'|'keys', known: number, partial: number,
 *   total: number}|null}
 */
export function whoStopsFirst(rows) {
    const list = (rows || []).filter(Boolean);
    const read = list.filter((row) => row.unknown === null && Number.isFinite(row.secondsLeft));
    const partial = list.filter((row) => row.unknown !== null && Number.isFinite(row.keyRunsCovered));

    const counts = { known: read.length, partial: partial.length, total: list.length };

    const food = read.length ? read.reduce((worst, row) => (row.secondsLeft < worst.secondsLeft ? row : worst)) : null;
    const keyed = list.filter((row) => Number.isFinite(row.keyRunsCovered));
    const keys = keyed.length
        ? keyed.reduce((worst, row) => (row.keyRunsCovered < worst.keyRunsCovered ? row : worst))
        : null;

    // Units again: a food figure with no run length behind it cannot be ranked
    // against a key count, so the key row keeps to its own line rather than
    // being promoted on a comparison that was never made
    const byKeys =
        keys && (!food || (Number.isFinite(food.runsCovered) && keys.keyRunsCovered < food.runsCovered)) ? keys : null;

    if (!byKeys && !food) return null;

    if (byKeys) {
        return {
            name: byKeys.name,
            runsCovered: byKeys.keyRunsCovered,
            secondsLeft: null,
            limitedBy: byKeys.keyName,
            source: 'keys',
            ...counts,
        };
    }

    return {
        name: food.name,
        runsCovered: food.runsCovered,
        secondsLeft: food.secondsLeft,
        limitedBy: food.limitedBy,
        source: 'food',
        ...counts,
    };
}

/**
 * The roster to draw, from the party slot map plus the names the run itself named.
 *
 * `partySlotMap` empties out once the battle starts — mid-run it is `{}` while
 * the party is plainly still there — so the slot map alone cannot be the
 * roster. The key-count message and the battle payload both name every member,
 * and a name is exactly what a slot that has gone blank is missing.
 *
 * A slot with no name carries nothing else either, so each external name is
 * taken to account for one of them; only a surplus of nameless slots survives,
 * as the "Unknown player" it honestly is.
 *
 * @param {Array<Object>} slotMembers - `partySlotMap`'s values, in party order
 * @param {Array<string>} names - Member names from the run, best source first
 * @returns {Array<{characterID: string|null, characterName: string}>}
 */
export function mergePartyRoster(slotMembers = [], names = []) {
    const slots = (slotMembers || []).filter(Boolean);
    const named = slots.filter((member) => member.characterName);
    const seen = new Set(named.map((member) => member.characterName));

    const extra = [];
    for (const name of names || []) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        extra.push({ characterID: null, characterName: name });
    }

    const nameless = slots.length - named.length;
    const stillUnknown = Math.max(0, nameless - extra.length);
    return [
        ...named,
        ...extra,
        ...Array.from({ length: stillUnknown }, () => ({ characterID: null, characterName: '' })),
    ];
}

/**
 * Level-gap warnings for the roster, in party order.
 *
 * Members whose level is unknown are excluded from the comparison rather than
 * counted as low — the top of the party decides everyone else's penalty, and an
 * absent member could be the top.
 *
 * @param {Array<Object>} rows - From `memberReadiness`
 * @returns {{warnings: Array<{name: string, debuff: number}>, unknownLevels: Array<string>}}
 */
export function levelGapWarnings(rows) {
    const list = rows || [];
    const levels = list.map((row) => row?.combatLevel).filter((level) => Number.isFinite(level) && level > 0);
    const unknownLevels = list.filter((row) => !Number.isFinite(row?.combatLevel)).map((row) => row?.name || '?');

    if (levels.length < 2) return { warnings: [], unknownLevels };

    const topLevel = Math.max(...levels);
    const warnings = [];
    for (const row of list) {
        if (!Number.isFinite(row?.combatLevel)) continue;
        const debuff = levelGapDebuff(row.combatLevel, topLevel);
        if (typeof debuff === 'number' && debuff < 0) warnings.push({ name: row.name, debuff });
    }

    return { warnings, unknownLevels };
}

/**
 * The footnotes the card is obliged to carry.
 *
 * Built from what the model actually turned out to be missing rather than
 * printed unconditionally, so a card with nothing unknown does not spend four
 * lines apologising for gaps it does not have.
 *
 * @param {Object} model - From `buildReadiness`
 * @returns {Array<string>}
 */
export function readinessFootnotes(model) {
    const notes = [];
    const members = model?.members || [];

    if (members.some((row) => row.unknown === UNKNOWN_CONSUMABLES && !row.isSelf)) {
        notes.push(
            "A party member's food and drinks are only in the battle payload, which arrives after the key is " +
                'spent — before the run there is no source for them, cached or otherwise.'
        );
    }
    if (members.some((row) => !row.isSelf && Number.isFinite(row.keyRunsCovered))) {
        notes.push(
            "Party key counts come from the game's own key-count message in party chat — stated by the server, " +
                'and the only supply figure for anyone else that exists at all.'
        );
    }
    if (members.some((row) => row.unknown === UNKNOWN_CONSUMABLES && row.isSelf)) {
        notes.push('Your own supplies need a measured rate: fight something with food or drinks equipped first.');
    }
    if (!model?.runSeconds) {
        notes.push(
            'Coverage is in time rather than runs — no finished run of this dungeon is on record to say how ' +
                'long one takes.'
        );
    }
    if (model?.levelGap?.unknownLevels?.length) {
        notes.push(
            `Level gap could not be checked for ${model.levelGap.unknownLevels.join(', ')} — a member's level ` +
                'is only readable from a profile you opened in game.'
        );
    }
    if (model?.lintScope) notes.push(model.lintScope);

    return notes;
}

/**
 * The whole card, assembled.
 *
 * @param {Object} input - Everything already resolved by the caller
 * @param {Object} input.dungeon - `{actionHrid, name, tier}`
 * @param {number} input.runsPlanned - The plan
 * @param {Object|null} input.keys - From `keyReadiness`
 * @param {Object|null} [input.keyCost] - From `utils/key-cost.js`'s `describeKeyCost`, for
 *   the shortfall's buy-versus-craft line; pricing is game state, so it arrives from the caller
 * @param {Array<Object>} input.members - From `memberReadiness`
 * @param {Array<string>} [input.lint] - Gear/aura warnings, already worded
 * @param {string} [input.lintScope] - What the lint was allowed to look at
 * @param {{seconds: number, samples: number}|null} [input.runLength] - From `typicalRunSeconds`
 * @returns {Object} The model a renderer draws without deciding anything
 */
export function buildReadiness({
    dungeon,
    runsPlanned = 1,
    keys = null,
    keyCost = null,
    members = [],
    lint = [],
    lintScope = '',
    runLength = null,
} = {}) {
    const model = {
        dungeon: dungeon || null,
        runsPlanned: Math.max(0, Math.floor(Number(runsPlanned) || 0)),
        runSeconds: runLength?.seconds ?? null,
        runSamples: runLength?.samples ?? 0,
        keys,
        keyPlan: keyShortfallCost({ shortfall: keys?.shortfall ?? 0, cost: keyCost }),
        keyShortfalls: keyShortfalls({ members, runsPlanned }),
        members: members || [],
        lint: lint || [],
        lintScope,
        levelGap: levelGapWarnings(members),
        stopsFirst: whoStopsFirst(members),
    };

    model.footnotes = readinessFootnotes(model);
    return model;
}

export default {
    UNKNOWN_CONSUMABLES,
    UNKNOWN_LEVEL,
    UNKNOWN_KEYS,
    KEYS_PER_RUN,
    MAX_RUNS_PLANNED,
    parseRunsPlanned,
    nextRunStep,
    keyShortfallCost,
    runsCovered,
    typicalRunSeconds,
    keyReadiness,
    memberReadiness,
    keyShortfalls,
    formatKeyShortfall,
    formatKeyShortfalls,
    memberLimit,
    whoStopsFirst,
    mergePartyRoster,
    levelGapWarnings,
    readinessFootnotes,
    buildReadiness,
};
