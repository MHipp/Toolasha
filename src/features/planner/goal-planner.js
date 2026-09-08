/**
 * Goal Planner engine
 *
 * You say where you want to end up; this says what to do first.
 *
 * Every number here already exists somewhere in Toolasha — the enhancement
 * Markov chain, the buy-vs-craft comparison, the profit-per-hour calculators,
 * the house upgrade costs. What none of them can answer on their own is the
 * ordinary question a player actually has: *"I want Sinister Cape +10 — what
 * does that cost me, and in what order?"* Answering it means putting four
 * calculators end to end and admitting that the third one's bill has to be paid
 * out of the first one's income.
 *
 * ## Why this module is pure
 *
 * Nothing here reads the game, the market or the DOM. Everything arrives in a
 * context object — levels, coins, prices, and a handful of provider functions
 * that wrap the real calculators (see `goal-planner-context.js`). That split is
 * not tidiness: the interesting behaviour is *the choice between two costed
 * options*, and a choice is only testable when the fixture can put its thumb on
 * the scale. "Buying the base is cheaper than crafting it" and "crafting it is
 * cheaper" are the same code down two price fixtures, and there is no way to
 * write the second test against a live market.
 *
 * ## Steps carry their prerequisites
 *
 * A plan is not a list, it is a partial order. Coins have to be earned before
 * they are spent, and a craft that needs Crafting 70 has to wait for Crafting
 * 70. Each step names the steps it waits on and {@link orderSteps} flattens
 * that into the sequence to read top to bottom, so the ordering rule lives in
 * one place rather than in four `push()` calls that happen to be in the right
 * order today.
 *
 * ## Satisfied steps are marked, not dropped
 *
 * A plan re-costed against a character who has since bought the base item
 * should show the acquisition step struck through, not silently one step
 * shorter. The struck-through step is the evidence the plan is the same plan.
 *
 * ## A rate is only a rate while its inputs last
 *
 * The single largest source of nonsense a planner can produce is treating a
 * one-shot margin as an hourly income. Decomposing a Sundering Crossbow ★ you
 * happen to own might net 850M in seven seconds; extrapolated that is 437
 * *billion* an hour, and a funding step that quotes it tells you a 900M goal
 * takes seven seconds. It does — once. You own one crossbow.
 *
 * So every rate may carry a {@link https://en.wikipedia.org/wiki/Working_capital
 * sustainability cap}: `rate.sustainable.gold` is the most gold that method can
 * produce before the thing it consumes runs out. {@link planEarnings} then
 * spends the shortfall down the ranking — take the best rate up to its cap,
 * then the next — so a plan reads "decompose the one crossbow you have, then
 * grind" rather than "decompose crossbows for seven seconds". A rate with no
 * cap (gathering, production, combat: their inputs are gathered or bought at
 * ask) is unbounded and covers whatever is left in one leg.
 *
 * A leg that cannot last {@link RATE_HORIZON_HOURS} is not described as a rate
 * at all, because "per hour" is a claim about an hour. It is described as what
 * it is: a fixed number of units for a fixed number of coins.
 *
 * ## And you only own the crossbow once
 *
 * The cap above is per plan, and a player has several. Two goals planned
 * independently will both decompose the same crossbow, both spend the same coins
 * in hand, and between them promise 1.7B out of an 851M item. Each plan is right
 * and the pair is nonsense.
 *
 * So {@link planGoals} runs the goals through a {@link createResourceLedger
 * ledger}: goals are planned in the order they are shown, each one against what
 * the ones above it have already claimed. The first goal takes the crossbow, the
 * second sees a rate with nothing left and falls through to the next-best method
 * — which is exactly what the sustainability cap already does when a stack runs
 * out, so there is one fallback rule rather than two.
 *
 * A silent re-rank would be worse than the bug, though. "Milk a Cow" appearing
 * where "Decompose Sundering Crossbow ★" was reads as the planner changing its
 * mind. So the step that lost its inputs says who took them:
 * *Sundering Crossbow ★ already spent by 'Cheesesmithing 108'*.
 */

import { formatKMB } from '../../utils/formatters.js';
import { calculateMultiLevelProgress } from '../../utils/experience-calculator.js';

/** The goal kinds this version plans, and what to call them */
export const GOAL_TYPES = {
    gold: 'Gold target',
    equipment: 'Equipment target',
    skill: 'Skill level target',
    house: 'House room target',
};

/** Highest enhancement level the game allows */
const MAX_ENHANCEMENT_LEVEL = 20;
/** Highest house room level the game allows */
const MAX_HOUSE_LEVEL = 8;

/**
 * How long a method has to last before "per hour" is a fair way to say it.
 *
 * Quoting X/hr for something whose inputs are gone in seven seconds is the bug
 * this number exists to prevent. Under an hour a leg is described as the fixed
 * thing it is — so many units, so many coins, once.
 */
export const RATE_HORIZON_HOURS = 1;

/** How many legs a step's own sentence names before it says "then more" */
const LEGS_IN_SENTENCE = 2;

let idCounter = 0;

/**
 * A finite number, or a fallback.
 * @param {*} value - Anything
 * @param {number} [fallback] - Returned when `value` is not a usable number
 * @returns {number} A finite number
 */
function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Clamp to a range, defaulting when the value is unusable.
 * @param {*} value - Anything
 * @param {number} min - Lower bound
 * @param {number} max - Upper bound
 * @param {number} fallback - Used when the value is not a number
 * @returns {number} An integer in [min, max]
 */
function clampInt(value, min, max, fallback) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

/**
 * Call a context provider without letting it take the plan down with it.
 *
 * The providers wrap live calculators that reach the market and the game's own
 * data, and any one of them can be missing an answer. A goal whose enhancement
 * provider throws should lose its enhancement step and say so, not lose the
 * whole plan.
 *
 * @param {Object} context - The planning context
 * @param {string} name - Provider name on the context
 * @param {Array} args - Arguments to pass
 * @param {*} fallback - Returned on absence or failure
 * @returns {*} The provider's answer, or the fallback
 */
function ask(context, name, args = [], fallback = null) {
    const provider = context?.[name];
    if (typeof provider !== 'function') return fallback;
    try {
        const answer = provider(...args);
        return answer === undefined ? fallback : answer;
    } catch (error) {
        console.error(`[GoalPlanner] Context provider ${name} failed:`, error);
        return fallback;
    }
}

/**
 * Coins with a sign, as a step description says them.
 * @param {number} value - Coins
 * @returns {string} e.g. "12.5M"
 */
function coins(value) {
    return formatKMB(Math.round(num(value))) ?? '0';
}

/**
 * Build a plan step.
 * @param {Object} spec - Step fields; see the module doc for the shape
 * @returns {Object} A step
 */
function makeStep(spec) {
    return {
        id: spec.id,
        kind: spec.kind,
        description: spec.description,
        goldDelta: num(spec.goldDelta),
        timeHours: spec.timeHours === null ? null : num(spec.timeHours),
        prerequisites: Array.isArray(spec.prerequisites) ? [...spec.prerequisites] : [],
        details: spec.details || {},
        done: Boolean(spec.done),
        progress: spec.progress || null,
    };
}

/**
 * Flatten a step graph into the order to do it in.
 *
 * Kahn's algorithm, kept stable on insertion order so two steps that do not
 * depend on each other stay in the order the planner emitted them — a plan that
 * reshuffles its own middle between two identical refreshes reads as broken
 * even when it is correct. Prerequisites naming a step that is not in the list
 * are ignored rather than treated as unsatisfiable; a cycle (which the planners
 * cannot currently produce) degrades to insertion order rather than dropping
 * steps on the floor.
 *
 * @param {Array<Object>} steps - Steps in emission order
 * @returns {Array<Object>} The same steps, in dependency order
 */
export function orderSteps(steps) {
    const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
    const byId = new Map(list.map((step) => [step.id, step]));

    const remaining = new Map();
    for (const step of list) {
        remaining.set(
            step.id,
            step.prerequisites.filter((id) => byId.has(id) && id !== step.id)
        );
    }

    const ordered = [];
    const placed = new Set();

    let progressed = true;
    while (progressed && placed.size < list.length) {
        progressed = false;
        for (const step of list) {
            if (placed.has(step.id)) continue;
            if (remaining.get(step.id).some((id) => !placed.has(id))) continue;
            ordered.push(step);
            placed.add(step.id);
            progressed = true;
        }
    }

    // A cycle would leave steps unplaced; keep them rather than lose them
    for (const step of list) {
        if (!placed.has(step.id)) ordered.push(step);
    }

    return ordered;
}

/**
 * What the outstanding part of a plan costs.
 *
 * Steps already satisfied are excluded from the totals but kept in the plan:
 * the point of a total is what is left to do, and the point of a struck-through
 * step is that it used to be part of it.
 *
 * @param {Array<Object>} steps - The plan's steps
 * @returns {Object} `{goldEarn, goldSpend, netGold, timeHours, timeKnown, stepsDone, stepCount}`
 */
export function summarize(steps) {
    const list = Array.isArray(steps) ? steps : [];
    let goldEarn = 0;
    let goldSpend = 0;
    let timeHours = 0;
    let timeKnown = true;
    let stepsDone = 0;

    for (const step of list) {
        if (step.done) {
            stepsDone += 1;
            continue;
        }
        if (step.goldDelta > 0) goldEarn += step.goldDelta;
        else goldSpend += -step.goldDelta;
        if (step.timeHours === null) timeKnown = false;
        else timeHours += step.timeHours;
    }

    return {
        goldEarn,
        goldSpend,
        netGold: goldEarn - goldSpend,
        timeHours,
        timeKnown,
        stepsDone,
        stepCount: list.length,
    };
}

/**
 * Turn whatever was stored or typed into a goal the planners can read.
 *
 * Returns null rather than a half-built goal: a stored goal whose item no
 * longer exists should disappear from the list, not plan itself into a step
 * costing NaN coins.
 *
 * @param {Object} raw - A goal from storage or the creation form
 * @returns {Object|null} A normalised goal, or null when it cannot be one
 */
export function normalizeGoal(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.type;
    if (!GOAL_TYPES[type]) return null;

    idCounter += 1;
    const base = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : `goal-${type}-${Date.now()}-${idCounter}`,
        type,
        createdAt: num(raw.createdAt, Date.now()),
    };

    switch (type) {
        case 'gold': {
            const amount = Math.max(0, num(raw.amount));
            return amount > 0 ? { ...base, amount } : null;
        }
        case 'equipment': {
            if (typeof raw.itemHrid !== 'string' || !raw.itemHrid) return null;
            return {
                ...base,
                itemHrid: raw.itemHrid,
                enhancementLevel: clampInt(raw.enhancementLevel, 0, MAX_ENHANCEMENT_LEVEL, 0),
            };
        }
        case 'skill': {
            if (typeof raw.skillHrid !== 'string' || !raw.skillHrid) return null;
            const targetLevel = clampInt(raw.targetLevel, 1, 200, 0);
            return targetLevel > 0 ? { ...base, skillHrid: raw.skillHrid, targetLevel } : null;
        }
        case 'house': {
            if (typeof raw.roomHrid !== 'string' || !raw.roomHrid) return null;
            const targetLevel = clampInt(raw.targetLevel, 1, MAX_HOUSE_LEVEL, 0);
            return targetLevel > 0 ? { ...base, roomHrid: raw.roomHrid, targetLevel } : null;
        }
        default:
            return null;
    }
}

/**
 * The activity that earns the most, out of what the character can actually do.
 *
 * "Can actually do" now includes having something left to do it with: a rate
 * whose cap has already been spent to zero — no crossbows left to decompose —
 * is not an option, and offering it as the top of the ranking is the whole bug.
 *
 * @param {Object} context - The planning context
 * @returns {{rates: Array<Object>, best: Object|null}} All rates and the winner
 */
function goldRates(context) {
    const rates = ask(context, 'goldRates', [], []) || [];
    const usable = rates.filter((rate) => rate && num(rate.goldPerHour) > 0 && sustainableGold(rate) > 0);
    usable.sort((a, b) => num(b.goldPerHour) - num(a.goldPerHour));
    return { rates: usable, best: usable[0] || null };
}

/**
 * The most gold a method can produce before what it consumes runs out.
 *
 * A rate that says nothing about its inputs is unbounded, which is the right
 * default: gathering consumes nothing, and production and combat buy their
 * inputs at ask inside the same margin they report. Only a method that eats
 * something you own — alchemy eats the item itself — has a ceiling.
 *
 * @param {Object} rate - A gold rate
 * @returns {number} Coins, or `Infinity` when nothing limits it
 */
export function sustainableGold(rate) {
    const cap = rate?.sustainable;
    if (!cap || cap.unbounded) return Number.POSITIVE_INFINITY;
    // An absent ceiling is unbounded, not zero: Number(null) is 0, and a cap of
    // 0 removes the rate from the ranking entirely — the opposite of "nothing
    // limits it". A *measured* 0 (an empty stack) still comes through as 0.
    if (cap.gold === null || cap.gold === undefined) return Number.POSITIVE_INFINITY;
    const gold = Number(cap.gold);
    return Number.isFinite(gold) ? Math.max(0, gold) : Number.POSITIVE_INFINITY;
}

/**
 * A key that means "the same method" across two goals' plans.
 *
 * Rates arrive from four providers and none of them carries an id. What makes
 * two rates the same *resource* is the action and the item it eats — alchemy
 * quotes many rates against one action hrid, so the item has to be in the key —
 * and the label is a last resort for anything that has neither.
 *
 * @param {Object} rate - A gold rate
 * @returns {string} A key, stable for as long as the rate is
 */
function rateKey(rate) {
    if (!rate) return '';
    return [rate.kind || '', rate.actionHrid || '', rate.itemHrid || '', rate.label || ''].join('|');
}

/**
 * What one method has left, once the goals above have taken their share.
 *
 * The ledger is deliberately not clever. It allocates greedily down the goal
 * list — the order the goals are displayed in, which is the order the player put
 * them in — and each goal simply plans against the remainder. There is no
 * attempt to find the allocation that minimises total time across goals: that is
 * a different and much larger question, and an answer nobody can check by
 * reading it is worse here than an answer that is obviously "the top goal wins".
 *
 * Two resources are contested:
 *
 * - **windfall inputs** — a rate with a finite `sustainable.gold` eats something
 *   out of the bag, and there is only one bagful;
 * - **coins in hand** — a plan that spends 30M of your 50M leaves 20M, not 50M,
 *   for the plan below it. A *gold* goal claims what it is holding towards its
 *   target for the same reason: you cannot both keep 500M and spend it.
 *
 * @param {number} startingGold - Coins in hand before any goal has claimed any
 * @returns {{view: Function, record: Function}} A ledger
 */
export function createResourceLedger(startingGold = 0) {
    /** @type {Map<string, Object>} rate key → what has been taken from it, and by whom */
    const claims = new Map();
    /** @type {Array<{title: string, gold: number}>} coins committed, and to what */
    const goldClaims = [];
    let goldClaimed = 0;

    /**
     * The same rate, with what earlier goals took already gone from its ceiling.
     * @param {Object} rate - A gold rate
     * @returns {Object} The rate, or a copy of it with a smaller cap
     */
    function afterClaims(rate) {
        const cap = sustainableGold(rate);
        // Nothing limits it, so nothing can be taken from it
        if (!Number.isFinite(cap)) return rate;

        const claim = claims.get(rateKey(rate));
        if (!claim || !(claim.claimed > 0)) return rate;

        const remaining = Math.max(0, cap - claim.claimed);
        const goldPerUnit = num(rate.sustainable?.goldPerUnit);
        return {
            ...rate,
            sustainable: {
                ...rate.sustainable,
                gold: remaining,
                ...(goldPerUnit > 0 ? { units: remaining / goldPerUnit } : {}),
            },
        };
    }

    return {
        /**
         * The context the next goal plans against.
         *
         * The decorated rate list is built once per goal rather than once per
         * call: `goldRates` is asked twice or three times inside one plan, and
         * re-deriving it each time would turn the ledger into a cost that scales
         * with how many providers happen to ask.
         *
         * @param {Object} context - The planning context
         * @returns {Object} A context with the remainder in it
         */
        view(context) {
            let decorated = null;
            let unaffordable = [];

            /**
             * The rates this goal can both reach and *afford to start*.
             *
             * A method whose inputs have to be bought is not available to
             * somebody who cannot buy them, however well it pays. The planner
             * recommended one — the failure being fixed here is a recommendation
             * the player literally cannot act on — so a rate whose cost to run
             * once exceeds the coins left after the goals above have claimed
             * theirs is not offered, and says why rather than vanishing.
             *
             * One action's worth, not an hour's: the question is whether you can
             * start, and a method you can start you can compound into.
             * @returns {void}
             */
            function build() {
                const available = Math.max(0, startingGold - goldClaimed);
                const affordable = [];
                unaffordable = [];

                for (const rate of ask(context, 'goldRates', [], []) || []) {
                    const claimed = afterClaims(rate);
                    const upfront = num(claimed.upfrontCost);
                    if (upfront > available) {
                        unaffordable.push({
                            label: claimed.label || 'that method',
                            goldPerHour: num(claimed.goldPerHour),
                            upfront,
                            available,
                        });
                        continue;
                    }
                    affordable.push(claimed);
                }
                decorated = affordable;
            }

            return {
                ...context,
                gold: Math.max(0, startingGold - goldClaimed),
                goldRates: () => {
                    if (!decorated) build();
                    return decorated;
                },
                capitalBlocks: () => {
                    if (!decorated) build();
                    return unaffordable.map((entry) => ({ ...entry }));
                },
                // What the planner needs to say *why* a rate it would have used is
                // not on offer. Read only by the steps that do the earning.
                rateClaims: () =>
                    [...claims.values()].map((claim) => ({
                        label: claim.label,
                        goldPerHour: claim.goldPerHour,
                        claimed: claim.claimed,
                        remaining: Math.max(0, claim.cap - claim.claimed),
                        goals: [...claim.goals],
                    })),
                goldClaims: () => goldClaims.map((claim) => ({ ...claim })),
            };
        },

        /**
         * Take what a finished plan spends out of the pot.
         *
         * Read off the plan rather than returned by the planners, because the
         * legs are already the record of what was consumed and a second channel
         * for the same fact is a second thing to keep in step.
         *
         * @param {Object} plan - A plan from {@link planGoal}
         */
        record(plan) {
            if (!plan) return;

            for (const step of plan.steps || []) {
                if (step.done) continue;
                for (const leg of step.details?.legs || []) {
                    const cap = sustainableGold(leg?.rate);
                    if (!Number.isFinite(cap) || !(num(leg.gold) > 0)) continue;

                    const key = rateKey(leg.rate);
                    const claim = claims.get(key) || {
                        // The cap as the *first* goal to reach it saw it, which is the
                        // whole cap: later goals see a decorated copy, so reading the
                        // cap off them would ratchet it down twice
                        cap,
                        label: leg.rate.sustainable?.unitLabel || leg.rate.itemName || leg.rate.label || 'that method',
                        goldPerHour: num(leg.rate.goldPerHour),
                        claimed: 0,
                        goals: [],
                    };
                    claim.claimed += num(leg.gold);
                    if (!claim.goals.includes(plan.title)) claim.goals.push(plan.title);
                    claims.set(key, claim);
                }
            }

            const available = Math.max(0, startingGold - goldClaimed);
            // A gold goal holds coins rather than spending them, and holding is
            // just as exclusive: the same 50M cannot be both kept and spent
            const wanted = plan.type === 'gold' ? num(plan.goal?.amount) : num(plan.totals?.goldSpend);
            const used = Math.min(available, wanted);
            if (used > 0) {
                goldClaimed += used;
                goldClaims.push({ title: plan.title, gold: used });
            }
        },
    };
}

/**
 * What an earning step should say about the goals above it.
 *
 * Only about methods that would otherwise have won. A crossbow already spent by
 * the goal above is worth a line on a step that is now milking cows; a spent
 * stack that was never going to beat the method actually chosen is noise.
 *
 * @param {Object} context - The planning context, as decorated by the ledger
 * @param {Object|null} best - The rate this step is actually using
 * @returns {Array<string>} Notes, in claim order
 */
function ledgerNotes(context, best) {
    const notes = [];
    const floor = num(best?.goldPerHour);

    for (const claim of ask(context, 'rateClaims', [], []) || []) {
        // `>=` rather than `>`: a stack that is only *partly* spent is still the
        // rate this step is using, and "500M of it left here" is the whole point
        if (!(num(claim.goldPerHour) >= floor)) continue;
        const who = claim.goals.map((title) => `'${title}'`).join(' and ');
        notes.push(
            claim.remaining > 0
                ? `${claim.label} partly spent by ${who} — ${coins(claim.remaining)} of it left here`
                : `${claim.label} already spent by ${who}`
        );
    }

    const committed = (ask(context, 'goldClaims', [], []) || []).filter((claim) => num(claim.gold) > 0);
    if (committed.length) {
        const total = committed.reduce((sum, claim) => sum + num(claim.gold), 0);
        const who = committed.map((claim) => `'${claim.title}'`).join(' and ');
        notes.push(`${coins(total)} of your coins is already committed to ${who}`);
    }

    // Same shape as a spent stack: a cap with a reason. A method you cannot
    // start is the one thing worse than a method that runs out, because the
    // plan reads as though you could begin it today.
    for (const blocked of ask(context, 'capitalBlocks', [], []) || []) {
        if (!(num(blocked.goldPerHour) >= floor)) continue;
        notes.push(
            `${blocked.label} needs ~${coins(blocked.upfront)} upfront to start — you have ${coins(blocked.available)}`
        );
    }

    return notes;
}

/**
 * How one leg of an earning plan says itself.
 *
 * Two sentences, and which one is used is the whole point. A method that can be
 * run for {@link RATE_HORIZON_HOURS} is an income and is quoted per hour. One
 * that cannot is a windfall and is quoted as the thing you actually do —
 * "Decompose 1 Sundering Crossbow ★ (+851.2M one-off)" — because there is no
 * hour in which you earn 437.9B, and printing that number is worse than
 * printing nothing.
 *
 * The test is on the *method*, not on this leg: a windfall reads as a windfall
 * whether it is the only leg or the first of three.
 *
 * @param {Object} leg - From {@link planEarnings}
 * @returns {string} A phrase
 */
export function describeLeg(leg) {
    const rate = leg?.rate || {};
    const cap = rate.sustainable || {};

    // A bound the number was already reduced by belongs beside the number. A
    // reader who sees 1.2M/hr for a method they know is worth billions will
    // assume the planner is broken unless it says what it took off.
    const bounds = (rate.limits || []).map((limit) => limit?.note).filter(Boolean);
    const because = bounds.length ? ` — ${bounds.join(', ')}` : '';

    if (leg?.oneOff) {
        const noun = cap.unitLabel || rate.itemName || rate.label || 'unit';
        const units = leg.units > 0 ? `${formatKMB(Math.ceil(leg.units))} ` : '';
        const what = cap.verb ? `${cap.verb} ${units}${noun}` : `${units}${noun}`.trim() || rate.label;
        return `${what} (+${coins(leg.gold)} one-off)${because}`;
    }

    const label = rate.label || 'an unnamed activity';
    const rest = leg?.exhausts ? `, for ${coins(leg.gold)}` : '';
    return `${label} at ${coins(rate.goldPerHour)}/hr${rest}${because}`;
}

/**
 * How a shortfall actually gets earned, best method first, each until it runs dry.
 *
 * Greedy down the ranking, which is right because the legs do not interact:
 * decomposing what you own does not make milking pay less, so taking the
 * highest-paying method first and moving on when it is exhausted is optimal for
 * total time as well as obvious to read.
 *
 * @param {Array<Object>} rates - Gold rates, any order
 * @param {number} amount - Coins to raise
 * @returns {{legs: Array<Object>, gold: number, hours: number|null, covered: boolean}}
 *   The legs in order, what they raise between them, how long that takes, and
 *   whether they cover the amount at all
 */
export function planEarnings(rates, amount) {
    const wanted = Math.max(0, num(amount));
    const usable = (Array.isArray(rates) ? rates : [])
        .filter((rate) => rate && num(rate.goldPerHour) > 0 && sustainableGold(rate) > 0)
        .sort((a, b) => num(b.goldPerHour) - num(a.goldPerHour));

    const legs = [];
    let remaining = wanted;
    let hours = 0;

    for (const rate of usable) {
        if (remaining <= 0) break;

        const cap = sustainableGold(rate);
        const gold = Math.min(remaining, cap);
        const perHour = num(rate.goldPerHour);
        const legHours = perHour > 0 ? gold / perHour : 0;
        const goldPerUnit = num(rate.sustainable?.goldPerUnit);
        const exhausts = Number.isFinite(cap) && gold >= cap;

        // How long the method could be run for if you wanted the whole of it.
        //
        // *This* is what decides whether "per hour" is a fair way to say it, and
        // it used to be `exhausts && legHours < horizon` — which only fired when
        // the leg drained the stack. A goal that needed 877.9M of a charm stack
        // worth 900M did not drain it, so the one-off rule never applied and the
        // step read "Master Tailoring Charm at 134.3B/hr" beside a duration of
        // 24 seconds. Whether a fallback leg happens to follow says nothing
        // about whether the first leg is an income.
        const capHours = Number.isFinite(cap) && perHour > 0 ? cap / perHour : Number.POSITIVE_INFINITY;

        legs.push({
            rate,
            gold,
            hours: legHours,
            units: goldPerUnit > 0 ? gold / goldPerUnit : null,
            exhausts,
            // A method whose entire remaining stock is gone inside an hour is a
            // windfall however much of it this leg draws; a method that never
            // runs out is an income however short this slice of it is
            oneOff: capHours < RATE_HORIZON_HOURS,
        });

        remaining -= gold;
        hours += legHours;

        // An uncapped method covers everything after it; nothing below it in
        // the ranking can improve on that
        if (!Number.isFinite(cap)) break;
    }

    return {
        legs,
        gold: wanted - remaining,
        hours: remaining > 0 ? null : hours,
        covered: remaining <= 0 && wanted > 0,
    };
}

/**
 * The legs of an earning plan, as one line of a step description.
 * @param {Object} plan - From {@link planEarnings}
 * @returns {string} e.g. "Decompose 1 Crossbow ★ (+851.2M one-off), then Milk a Cow at 12.4M/hr"
 */
function describeEarning(plan) {
    const named = plan.legs.slice(0, LEGS_IN_SENTENCE).map(describeLeg);
    const extra = plan.legs.length - named.length;
    if (extra > 0) named.push(`${extra} more method${extra === 1 ? '' : 's'}`);
    return named.join(', then ');
}

/**
 * The funding step a plan needs, if it needs one.
 *
 * A plan that spends more than the character holds is not wrong, it is
 * incomplete: the missing part is the grind that pays for it, and leaving it
 * out is what makes a "12M" price tag look affordable to somebody with 3M. The
 * step becomes a prerequisite of everything that spends, so it sorts to the top
 * on its own rather than by being pushed first.
 *
 * @param {Object} context - The planning context
 * @param {number} spend - Coins the rest of the plan spends
 * @param {Array<string>} spenderIds - Steps that do the spending
 * @returns {{step: Object|null, warnings: Array<string>}} The step, if needed
 */
function fundingStep(context, spend, spenderIds) {
    const have = num(context?.gold);
    const shortfall = Math.max(0, spend - have);
    if (shortfall <= 0) return { step: null, warnings: [] };

    const { best, rates } = goldRates(context);
    const earning = planEarnings(rates, shortfall);
    const warnings = [];
    if (!best) {
        warnings.push('No earning rate could be measured, so the time to raise the shortfall is unknown.');
    } else if (!earning.covered) {
        warnings.push(
            `Nothing you can do covers the whole ${coins(shortfall)} — the methods ranked here run out of ` +
                `what they consume after ${coins(earning.gold)}.`
        );
    }

    const step = makeStep({
        id: 'fund',
        kind: 'earn',
        description: earning.legs.length
            ? `Earn ${coins(shortfall)} more coins — ${describeEarning(earning)}`
            : `Earn ${coins(shortfall)} more coins`,
        goldDelta: shortfall,
        timeHours: earning.hours,
        details: {
            have,
            spend,
            shortfall,
            rate: best || null,
            legs: earning.legs,
            covered: earning.covered,
            alternatives: rates.slice(0, 5),
            spenders: spenderIds,
            ledgerNotes: ledgerNotes(context, best),
        },
        progress: { current: have, target: spend, ratio: spend > 0 ? Math.min(1, have / spend) : 1 },
    });

    return { step, warnings };
}

/**
 * Attach the funding step to everything that spends, and return the full list.
 * @param {Object|null} funding - From {@link fundingStep}
 * @param {Array<Object>} steps - The spending steps
 * @returns {Array<Object>} Steps including the funding step, wired up
 */
function withFunding(funding, steps) {
    if (!funding) return steps;
    for (const step of steps) {
        if (step.goldDelta < 0 && !step.done) step.prerequisites.push(funding.id);
    }
    return [funding, ...steps];
}

/**
 * Plan "have N coins".
 * @param {Object} goal - A normalised gold goal
 * @param {Object} context - The planning context
 * @returns {{steps: Array<Object>, warnings: Array<string>, satisfied: boolean}}
 */
function planGoldGoal(goal, context) {
    const have = num(context?.gold);
    const target = num(goal.amount);
    const shortfall = Math.max(0, target - have);
    const satisfied = shortfall <= 0;

    const { best, rates } = goldRates(context);
    const earning = planEarnings(rates, shortfall);
    const warnings = [];
    if (!satisfied && !best) {
        warnings.push('No earning rate could be measured — train a gathering or production skill first.');
    } else if (!satisfied && !earning.covered) {
        warnings.push(
            `Nothing you can do covers the whole ${coins(shortfall)} — the methods ranked here run out of ` +
                `what they consume after ${coins(earning.gold)}.`
        );
    }

    const step = makeStep({
        id: 'earn',
        kind: 'earn',
        description: satisfied
            ? `Already holding ${coins(have)} coins`
            : earning.legs.length
              ? `Earn ${coins(shortfall)} coins — ${describeEarning(earning)}`
              : `Earn ${coins(shortfall)} coins`,
        goldDelta: satisfied ? 0 : shortfall,
        timeHours: satisfied ? 0 : earning.hours,
        details: {
            target,
            have,
            shortfall,
            rate: best || null,
            legs: satisfied ? [] : earning.legs,
            covered: earning.covered,
            alternatives: rates.slice(0, 5),
            ledgerNotes: satisfied ? [] : ledgerNotes(context, best),
        },
        done: satisfied,
        progress: { current: Math.min(have, target), target, ratio: target > 0 ? Math.min(1, have / target) : 1 },
    });

    return { steps: [step], warnings, satisfied };
}

/** Coins cannot be bought off the marketplace, so they never belong on a shopping list */
const COIN_HRID = '/items/coin';

/**
 * What an enhancement run would have you buy, as a list somebody can shop from.
 *
 * The path optimiser's bill is an *expectation*: the counts come out of the same
 * Markov chain the cost does, so they are the mean of a distribution rather than
 * a number of trips to the marketplace. Rounded up here because you cannot buy
 * 41.3 charms, and labelled as an estimate wherever it is offered.
 *
 * One base copy is dropped, because the plan already has a step that buys or
 * already holds it. That matters for a mirrored path, whose bill names several
 * copies — the plan really does need all of them, and the enhance step is where
 * the extras belong.
 *
 * @param {Object|null} run - An enhancement run from the `enhance` provider
 * @returns {Array<{itemHrid: string, name: string, count: number}>} What to buy, or an empty list
 */
function enhancementShoppingList(run) {
    const bill = Array.isArray(run?.materialBill) ? run.materialBill : [];

    const list = [];
    for (const line of bill) {
        if (!line?.itemHrid || line.itemHrid === COIN_HRID) continue;
        const count = line.kind === 'base' ? num(line.count) - 1 : num(line.count);
        if (!(count > 0)) continue;
        list.push({
            itemHrid: line.itemHrid,
            name: line.name || line.itemHrid.split('/').pop(),
            count: Math.ceil(count),
        });
    }
    return list;
}

/**
 * Plan "own this item at +N".
 *
 * Two decisions, in order. The base item is bought or crafted, whichever the
 * current book says is cheaper — and that answer flips with the market, which
 * is exactly why it is re-asked on every refresh rather than decided once. Then
 * the enhancement run, costed from the player's own bench unless they have
 * asked to see a professional's.
 *
 * @param {Object} goal - A normalised equipment goal
 * @param {Object} context - The planning context
 * @returns {{steps: Array<Object>, warnings: Array<string>, satisfied: boolean}}
 */
function planEquipmentGoal(goal, context) {
    const { itemHrid } = goal;
    const target = num(goal.enhancementLevel);
    const name = ask(context, 'itemName', [itemHrid], null) || itemHrid.split('/').pop();
    const owned = num(ask(context, 'ownedEnhancementLevel', [itemHrid], -1), -1);

    const warnings = [];
    if (owned >= target) {
        return {
            steps: [
                makeStep({
                    id: 'own',
                    kind: 'acquire',
                    description: `Already own ${name}${target > 0 ? ` +${target}` : ''}`,
                    done: true,
                }),
            ],
            warnings,
            satisfied: true,
        };
    }

    const steps = [];
    const haveBase = owned >= 0;

    // --- The base item -----------------------------------------------------
    const acquisition = ask(context, 'acquire', [itemHrid], null);
    if (!haveBase && !acquisition) {
        warnings.push(`No price or recipe could be found for ${name}, so its cost is unknown.`);
    }

    // A craft the character cannot yet perform is a level goal hiding inside an
    // equipment goal; it has to be said out loud or the plan quotes a cost for
    // something that cannot be started.
    const requires = Array.isArray(acquisition?.requires) ? acquisition.requires : [];
    const unmet = [];
    for (const requirement of requires) {
        const current = num(ask(context, 'skill', [requirement.skillHrid], null)?.level, 0);
        if (current < num(requirement.level)) unmet.push({ ...requirement, current });
    }

    const trainIds = [];
    if (!haveBase && acquisition?.strategy === 'craft') {
        for (const requirement of unmet) {
            const id = `train-${requirement.skillHrid.split('/').pop()}`;
            trainIds.push(id);
            const skillLabel = ask(context, 'skillName', [requirement.skillHrid], null) || requirement.skillHrid;
            const sub = planSkillGoal(
                { skillHrid: requirement.skillHrid, targetLevel: requirement.level },
                context,
                id
            );
            warnings.push(...sub.warnings);
            // Only the training step: the funding this plan needs is worked out
            // once at the end, over everything it spends rather than per sub-plan
            const trainStep = sub.steps.find((step) => step.kind === 'train');
            if (!trainStep) continue;
            trainStep.prerequisites = [];
            trainStep.description = `Reach ${skillLabel} ${requirement.level} to craft ${name}`;
            steps.push(trainStep);
        }
    }

    if (!haveBase) {
        const cost = num(acquisition?.totalCost, num(acquisition?.unitCost));
        const strategy = acquisition?.strategy === 'craft' ? 'Craft' : 'Buy';
        const rival =
            acquisition?.strategy === 'craft'
                ? acquisition?.buyPrice != null
                    ? `buying would cost ${coins(acquisition.buyPrice)}`
                    : 'it cannot be bought'
                : acquisition?.craftCost != null
                  ? `crafting would cost ${coins(acquisition.craftCost)}`
                  : 'it has no recipe';

        steps.push(
            makeStep({
                id: 'base',
                kind: 'acquire',
                description: `${strategy} ${name} for ${coins(cost)} — ${rival}`,
                goldDelta: -cost,
                timeHours: num(acquisition?.timeHours),
                prerequisites: trainIds,
                // The name rides along so anything that offers to go and buy
                // this can say what it is buying without re-deriving it
                details: { itemHrid, itemName: name, ...(acquisition || {}) },
            })
        );
    } else {
        steps.push(
            makeStep({
                id: 'base',
                kind: 'acquire',
                description: `Already hold ${name}${owned > 0 ? ` +${owned}` : ''}`,
                done: true,
                details: { itemHrid, ownedEnhancementLevel: owned },
            })
        );
    }

    // --- The enhancement run -----------------------------------------------
    if (target > 0) {
        const startLevel = Math.max(0, owned);
        const run = ask(context, 'enhance', [{ itemHrid, targetLevel: target, startLevel }], null);
        if (!run) {
            warnings.push(`${name} could not be costed to +${target} — it may not be enhanceable.`);
        }

        // The path calculator quotes a total that already contains a base item;
        // this plan buys that separately, so counting it here would charge for
        // it twice.
        const runCost = Math.max(0, num(run?.totalCost) - num(run?.baseCost));
        const bill = enhancementShoppingList(run);
        steps.push(
            makeStep({
                id: 'enhance',
                kind: 'enhance',
                description: run
                    ? `Enhance ${name} +${startLevel} → +${target} — ${Math.round(num(run.attempts))} attempts, ` +
                      `${coins(runCost)} in materials${run.protectFrom > 0 ? ` (protect from +${run.protectFrom})` : ''}`
                    : `Enhance ${name} +${startLevel} → +${target}`,
                goldDelta: -runCost,
                timeHours: run ? num(run.totalTimeSeconds) / 3600 : null,
                prerequisites: ['base'],
                details: { itemHrid, startLevel, targetLevel: target, ...(run || {}), shoppingList: bill },
            })
        );
    }

    const spend = steps.reduce((sum, step) => (step.done ? sum : sum + Math.max(0, -step.goldDelta)), 0);
    const { step: funding, warnings: fundingWarnings } = fundingStep(
        context,
        spend,
        steps.filter((step) => step.goldDelta < 0).map((step) => step.id)
    );
    warnings.push(...fundingWarnings);

    return { steps: withFunding(funding, steps), warnings, satisfied: false };
}

/**
 * Plan "get this skill to level N".
 *
 * The action is chosen on experience per hour among what the level already
 * allows, and the climb is handed to `calculateMultiLevelProgress` rather than
 * divided out by hand — efficiency rises a point per level as you go, so a flat
 * division overstates the grind by more the longer it is.
 *
 * @param {Object} goal - A normalised skill goal
 * @param {Object} context - The planning context
 * @param {string} [stepId] - Step id to use, for a training step embedded in another plan
 * @returns {{steps: Array<Object>, warnings: Array<string>, satisfied: boolean}}
 */
function planSkillGoal(goal, context, stepId = 'train') {
    const { skillHrid } = goal;
    const target = num(goal.targetLevel);
    const label = ask(context, 'skillName', [skillHrid], null) || skillHrid.split('/').pop();
    const state = ask(context, 'skill', [skillHrid], null) || {};
    const level = num(state.level, 1);
    const experience = num(state.experience);

    const warnings = [];
    if (level >= target) {
        return {
            steps: [
                makeStep({
                    id: stepId,
                    kind: 'train',
                    description: `${label} is already ${level}`,
                    done: true,
                    details: { skillHrid, level, targetLevel: target },
                    progress: { current: level, target, ratio: 1 },
                }),
            ],
            warnings,
            satisfied: true,
        };
    }

    const rates = (ask(context, 'xpRates', [skillHrid], []) || []).filter(
        (rate) => rate && num(rate.xpPerHour) > 0 && num(rate.requiredLevel, 1) <= level
    );
    rates.sort((a, b) => num(b.xpPerHour) - num(a.xpPerHour));
    const best = rates[0] || null;

    const table = Array.isArray(context?.levelExperienceTable) ? context.levelExperienceTable : null;
    if (!best) warnings.push(`No ${label} action could be costed at this level.`);
    if (!table) warnings.push('The game has not sent the experience table yet, so the grind cannot be timed.');

    let timeHours = null;
    let actionsNeeded = null;
    if (best && table) {
        if (best.flatRate) {
            // Enhancing gains no efficiency repeats as it levels, so the
            // level-by-level climb below would quietly shorten the grind
            const remaining = Math.max(0, num(table[target]) - experience);
            timeHours = num(best.xpPerHour) > 0 ? remaining / num(best.xpPerHour) : null;
            actionsNeeded = num(best.xpPerAction) > 0 ? remaining / num(best.xpPerAction) : null;
        } else {
            const progress = calculateMultiLevelProgress(
                level,
                experience,
                target,
                num(best.totalEfficiency),
                num(best.actionTime),
                num(best.xpPerAction),
                table
            );
            timeHours = num(progress.timeNeeded) / 3600;
            actionsNeeded = num(progress.actionsNeeded);
        }
    }

    // Training is usually not free and occasionally pays; either way it is the
    // same number, so it rides on the step as a signed delta rather than being
    // dropped because production skills would make it negative.
    const goldDelta = timeHours !== null && best ? num(best.goldPerHour) * timeHours : 0;

    // The gold on a training step is a rate multiplied by a duration, and both
    // are estimates. Naming the rate is what makes an implausible total
    // attributable — "+523.2M" alone reads as a promise, "+523.2M at 7.4B/hr"
    // reads as the broken rate it came from.
    const goldNote = best && goldDelta !== 0 ? `, ${coins(best.goldPerHour)}/hr` : '';

    const step = makeStep({
        id: stepId,
        kind: 'train',
        description: best
            ? `Train ${label} ${level} → ${target} — ${best.label}` +
              (actionsNeeded !== null ? `, ${formatKMB(Math.round(actionsNeeded))} actions` : '') +
              goldNote
            : `Train ${label} ${level} → ${target}`,
        goldDelta,
        timeHours,
        details: {
            skillHrid,
            level,
            targetLevel: target,
            rate: best,
            actionsNeeded,
            alternatives: rates.slice(0, 5),
        },
        progress: { current: level, target, ratio: target > 0 ? Math.min(1, level / target) : 1 },
    });

    const steps = [step];
    const spend = Math.max(0, -step.goldDelta);
    const { step: funding, warnings: fundingWarnings } = fundingStep(context, spend, [step.id]);
    warnings.push(...fundingWarnings);

    return { steps: withFunding(funding, steps), warnings, satisfied: false };
}

/**
 * Plan "get this house room to level N".
 * @param {Object} goal - A normalised house goal
 * @param {Object} context - The planning context
 * @returns {{steps: Array<Object>, warnings: Array<string>, satisfied: boolean}}
 */
function planHouseGoal(goal, context) {
    const { roomHrid } = goal;
    const target = num(goal.targetLevel);
    const name = ask(context, 'houseRoomName', [roomHrid], null) || roomHrid.split('/').pop();
    const level = num(ask(context, 'houseLevel', [roomHrid], 0));

    const warnings = [];
    if (level >= target) {
        return {
            steps: [
                makeStep({
                    id: 'build',
                    kind: 'build',
                    description: `${name} is already level ${level}`,
                    done: true,
                    details: { roomHrid, level, targetLevel: target },
                    progress: { current: level, target, ratio: 1 },
                }),
            ],
            warnings,
            satisfied: true,
        };
    }

    const cost = ask(context, 'houseCost', [roomHrid, level, target], null);
    if (!cost) warnings.push(`The upgrade cost for ${name} could not be read.`);

    const materials = Array.isArray(cost?.materials) ? cost.materials : [];
    const materialValue = materials.reduce((sum, material) => sum + num(material.totalValue), 0);
    const coinCost = num(cost?.coins);

    const steps = [];

    if (materials.length) {
        // Materials the character already holds are not a purchase, and a plan
        // that bills for them is a plan that sends somebody shopping for what is
        // already in their bag.
        const shortfall = materials
            .map((material) => {
                // What this goal may plan against: the bag less every OTHER
                // plan's claim on it, never its own — see the `owned` provider
                const held = num(ask(context, 'owned', [material.itemHrid, goal.id], 0));
                const missing = Math.max(0, num(material.count) - held);
                const unit = num(material.marketPrice, num(material.totalValue) / Math.max(1, num(material.count)));
                return { ...material, held, missing, missingValue: missing * unit };
            })
            .filter((material) => material.missing > 0);

        const missingValue = shortfall.reduce((sum, material) => sum + material.missingValue, 0);

        // A bag that looks full and a plan that says it is short is a mystery
        // unless the plan says who took the stock
        for (const material of shortfall) {
            const note = ask(context, 'reservationNote', [material.missing, material.itemHrid, goal.id], '');
            if (!note) continue;
            const itemName = ask(context, 'itemName', [material.itemHrid], null) || material.itemHrid;
            warnings.push(`${itemName}: ${note}`);
        }

        steps.push(
            makeStep({
                id: 'materials',
                kind: 'acquire',
                description: shortfall.length
                    ? `Buy ${shortfall.length} material${shortfall.length === 1 ? '' : 's'} for ${name} ` +
                      `${level} → ${target} — ${coins(missingValue)}`
                    : `Materials for ${name} ${level} → ${target} are already held`,
                goldDelta: -missingValue,
                done: shortfall.length === 0,
                details: { roomHrid, materials: shortfall, allMaterials: materials, fullValue: materialValue },
            })
        );
    }

    steps.push(
        makeStep({
            id: 'build',
            kind: 'build',
            description: `Upgrade ${name} ${level} → ${target} — ${coins(coinCost)} in coins`,
            goldDelta: -coinCost,
            prerequisites: materials.length ? ['materials'] : [],
            details: {
                roomHrid,
                fromLevel: level,
                toLevel: target,
                coins: coinCost,
                totalValue: num(cost?.totalValue),
            },
            progress: { current: level, target, ratio: target > 0 ? Math.min(1, level / target) : 1 },
        })
    );

    const spend = steps.reduce((sum, step) => (step.done ? sum : sum + Math.max(0, -step.goldDelta)), 0);
    const { step: funding, warnings: fundingWarnings } = fundingStep(
        context,
        spend,
        steps.filter((step) => step.goldDelta < 0).map((step) => step.id)
    );
    warnings.push(...fundingWarnings);

    return { steps: withFunding(funding, steps), warnings, satisfied: false };
}

/**
 * A one-line name for a goal, for the goal list and the plan header.
 * @param {Object} goal - A normalised goal
 * @param {Object} [context] - The planning context, for item and skill names
 * @returns {string} The title
 */
export function describeGoal(goal, context = {}) {
    if (!goal) return 'Unknown goal';
    switch (goal.type) {
        case 'gold':
            return `Have ${coins(goal.amount)} coins`;
        case 'equipment': {
            const name = ask(context, 'itemName', [goal.itemHrid], null) || goal.itemHrid.split('/').pop();
            return `Own ${name}${goal.enhancementLevel > 0 ? ` +${goal.enhancementLevel}` : ''}`;
        }
        case 'skill': {
            const name = ask(context, 'skillName', [goal.skillHrid], null) || goal.skillHrid.split('/').pop();
            return `${name} ${goal.targetLevel}`;
        }
        case 'house': {
            const name = ask(context, 'houseRoomName', [goal.roomHrid], null) || goal.roomHrid.split('/').pop();
            return `${name} ${goal.targetLevel}`;
        }
        default:
            return 'Unknown goal';
    }
}

/**
 * Plan one goal.
 *
 * @param {Object} rawGoal - A goal, normalised or not
 * @param {Object} context - The planning context; see the module doc
 * @returns {Object|null} `{goalId, type, title, steps, totals, satisfied, confidence, warnings}`,
 *   or null when the goal is not one this version can plan
 */
export function planGoal(rawGoal, context = {}) {
    const goal = normalizeGoal(rawGoal);
    if (!goal) return null;

    let result;
    try {
        switch (goal.type) {
            case 'gold':
                result = planGoldGoal(goal, context);
                break;
            case 'equipment':
                result = planEquipmentGoal(goal, context);
                break;
            case 'skill':
                result = planSkillGoal(goal, context);
                break;
            case 'house':
                result = planHouseGoal(goal, context);
                break;
            default:
                return null;
        }
    } catch (error) {
        console.error('[GoalPlanner] Planning a goal failed:', error);
        result = {
            steps: [],
            warnings: [`This goal could not be planned: ${error.message}`],
            satisfied: false,
        };
    }

    const steps = orderSteps(result.steps);
    const totals = summarize(steps);

    return {
        goalId: goal.id,
        goal,
        type: goal.type,
        title: describeGoal(goal, context),
        steps,
        totals,
        satisfied: Boolean(result.satisfied),
        confidence: {
            // Every figure below leans on the order book except a pure level
            // grind, and even that is priced when it earns or spends
            priceDependent: true,
            note:
                context?.pricingNote ||
                'Costs are priced against the market data now loaded, and move with it. Re-price before committing.',
            warnings: result.warnings.filter(Boolean),
        },
        warnings: result.warnings.filter(Boolean),
        computedAt: num(context?.now, Date.now()),
    };
}

/**
 * Owner-id prefix the planner claims stock under, one owner per goal.
 *
 * Here rather than beside the context so it survives a caller that doubles the
 * context module: it is the identity every `goal:` claim in the ledger is
 * written and swept under, and a mocked-away prefix would sweep nothing.
 */
export const RESERVATION_OWNER_PREFIX = 'goal:';

/**
 * What a finished plan claims of the bag, for the reservation ledger.
 *
 * The FULL requirement of each acquire step, not the shortfall: a goal that
 * needs 500 logs has claimed 500 logs whether or not it is holding them, and
 * claiming only the part it is short of would leave the part it holds looking
 * free to every other plan — which is the bug the ledger exists to stop.
 *
 * @param {Object} plan - A plan from {@link planGoal}
 * @returns {Array<{itemHrid: string, count: number}>} Lines to reserve
 */
export function reservationLines(plan) {
    const lines = [];
    for (const step of plan?.steps || []) {
        if (step?.done) continue;
        const materials = step?.details?.allMaterials || step?.details?.materials;
        for (const material of Array.isArray(materials) ? materials : []) {
            const count = Math.floor(num(material?.count));
            if (!material?.itemHrid || !(count > 0)) continue;
            lines.push({ itemHrid: material.itemHrid, count });
        }
    }
    return lines;
}

/**
 * Plan a list of goals, sharing one bagful of inputs and one pile of coins between them.
 *
 * ## What this costs
 *
 * Nothing that shows. The expensive half of a refresh is
 * `buildPlannerContext` — a few hundred profit calculations to rank every
 * activity — and that still happens exactly once, before this is called. What
 * the ledger adds is one pass over the rate list per goal (to subtract what has
 * been claimed) plus a walk of each finished plan's steps, so replanning N goals
 * is O(N × rates) on top of the O(N) planning that was already happening. With
 * the rate list capped in the low hundreds and goal lists in the low tens, that
 * is microseconds against a refresh measured in seconds.
 *
 * Which is why every goal is replanned whenever any goal changes rather than
 * patched: the plans are no longer independent, and the memoised providers on
 * the context mean the second pass over the same goals costs almost nothing.
 *
 * @param {Array<Object>} goals - Goals, normalised or not, in the order they are displayed
 * @param {Object} context - The planning context
 * @returns {Array<Object>} One plan per goal that could be planned
 */
export function planGoals(goals, context = {}) {
    const list = Array.isArray(goals) ? goals : [];
    const ledger = createResourceLedger(num(context?.gold));

    const plans = [];
    for (const goal of list) {
        const plan = planGoal(goal, ledger.view(context));
        if (!plan) continue;
        ledger.record(plan);
        plans.push(plan);
    }
    return plans;
}

export default {
    GOAL_TYPES,
    RATE_HORIZON_HOURS,
    normalizeGoal,
    describeGoal,
    planGoal,
    planGoals,
    reservationLines,
    RESERVATION_OWNER_PREFIX,
    planEarnings,
    describeLeg,
    sustainableGold,
    createResourceLedger,
    orderSteps,
    summarize,
};
