/**
 * Guided task reroll walk.
 *
 * Working a full task board down to something worth doing is a lot of clicking:
 * open a card's chooser, pay, look at what arrived, decide, pay again, and on
 * to the next card. This walks that for you — but it walks it, it does not run
 * it.
 *
 * **One user click is one game action, always.** Pressing the walk's button
 * performs exactly one click on exactly one of the game's own buttons and then
 * stops and tells you what the next press would do. Nothing is chained, nothing
 * is queued, nothing fires on a timer or off a websocket message: opening a
 * card's chooser is one press, paying for the reroll is the next, closing the
 * chooser is another. The only work this module does between presses is reading
 * the board and writing a label.
 *
 * The presses that spend — a reroll payment, the free reroll, a discard
 * confirm — go through the game's own React handler (`clickThroughReact`),
 * because their handlers refuse a plain DOM click without `isTrusted`. Should
 * a payment ever go unanswered anyway, that one card falls back to a manual
 * step: the walk highlights the exact button and asks the player for the
 * press, whose real click always counts.
 *
 * The rules come from what the player has already configured elsewhere:
 *
 *  - the reroll-protection list (the shield popup) — a protected task is left
 *    exactly where it is, and the walk moves past it;
 *  - that same popup's "Block rerolls at &lt;coins&gt; &lt;cowbells&gt;"
 *    thresholds — the walk stops rerolling a task the moment its *next* reroll
 *    would cost that much or more. There is no second reroll budget to keep in
 *    step with it: a walk that gave up after three rerolls while the shield
 *    popup was still happy to pay, or the reverse, was two rules for one
 *    decision and the player had to hold both;
 *  - `tasks_rerollWalkCurrency` — which of the two currencies to spend, when
 *    both are still under their threshold;
 *  - `tasks_rerollWalkTrashAtLimit` — what to do with a task whose reroll
 *    options are both blocked: offer the trash can, or move past it.
 *
 * ## What the next reroll costs
 *
 * The game doubles a task's reroll price each time it is used, per currency and
 * per task: 10K → 20K → 40K → 80K → 160K → 320K coins, and 1 → 2 → 4 → 8 → 16 →
 * 32 cowbells, each capped at the last step. That formula is what prices a card
 * whose chooser is shut. When the chooser is open its own Pay buttons are the
 * source of truth instead — they are what the click will actually spend, and a
 * build that changes the progression changes them first.
 *
 * The two prices are then compared in the one unit that makes them comparable:
 * coins. A cowbell is valued the way the task profit display values it (through
 * the Bag of 10 Cowbells on the market), so "2🔔" and "20K🪙" can be put side by
 * side and the cheaper one picked — and the label says which and why, because a
 * walk quietly spending cowbells is a walk you find out about later.
 *
 * ## What it has spent
 *
 * The walk keeps a running total of the coins and cowbells it has paid, priced
 * from the chooser button each payment actually pressed, and says it on the
 * label and in the finished summary. It is a readout and nothing more: no
 * budget, no governor, no second stopping rule — that decision is settled
 * above and stays settled. The total exists because the alternative was
 * reconstructing it from your coin balance afterwards.
 *
 * Before every click the board is re-read and compared against what was
 * planned. If the card in that slot is not the card the label is about — the
 * game re-ordered the board, a task completed, a reroll landed differently than
 * expected — the walk clicks nothing and plans again from what is actually
 * there, so a board the combat ticks redraw constantly never turns one walk
 * into a string of restarts.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { GAME } from '../../utils/selectors.js';
import { formatKMB } from '../../utils/formatters.js';
import { clickThroughReact } from '../../utils/react-click.js';
import taskSorter from './task-sorter.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { characterKey, readScopedFrom } from '../../utils/character-key.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';
import {
    createFloatingWidget,
    widgetCheckboxRow,
    widgetDivider,
    widgetNote,
    widgetReadOnlyRow,
    widgetSelectRow,
} from '../../utils/floating-widget.js';
import { cardTaskKey } from './task-card-state.js';
import { questForTaskCard } from './task-card-quest.js';
import taskRerollProtection from './task-reroll-protection.js';
import { getCowbellValue } from './task-profit-calculator.js';
import { findRerollOptions } from './task-reroll-options.js';

const CHIP_ID = 'mwi-task-reroll-walk-chip';
const BUTTON_CLASS = 'mwi-task-reroll-walk-btn';
const PROTECTED_KEY_PREFIX = 'taskProtectedHrids';
const PANEL_POSITION_KEY = 'taskRerollWalkPanelPosition';

// The chip sits below the game's own modal layer (its modals run z 200-1000)
// so opening a profile or any dialog over it wins — the shared floating-panel
// z (1100) otherwise leaves the chip covering a focused modal.
const CHIP_Z_INDEX = 150;

/** The board's "You have N unread tasks" notice, whose one button reads them */
const UNREAD_NOTICE = '[class*="TasksPanel_unreadTasks"]';

/** How many Read presses to offer before walking on past a notice that will not clear */
const READ_PRESS_LIMIT = 3;

/** How long the walk waits for the game to redraw a card after a UI-only click */
const UI_SETTLE_MS = 120;
/** How long it waits for a reroll or discard to come back from the server */
const SERVER_SETTLE_MS = 2500;

/** The game's reroll price ladder: the first coin reroll, doubling, and its ceiling */
const COIN_REROLL_BASE = 10000;
const COIN_REROLL_CAP = 320000;
/** The same ladder in cowbells, which starts at one */
const COWBELL_REROLL_CAP = 32;

/** The shield popup's defaults, so a character who never opened it is not blocked early */
const DEFAULT_COIN_THRESHOLD = 320000;
const DEFAULT_COWBELL_THRESHOLD = 32;

/** The shield popup's three cap records, which this walk reads but never writes */
const CAP_BASES = ['taskCapProtection', 'taskCapCoinThreshold', 'taskCapCowbellThreshold'];

/**
 * Every key a scoped read of the cap records can touch, for one `getMany`.
 *
 * Both forms of each: `readScopedFrom` resolves the scoped key first and falls
 * back to the bare one for a pre-scoping install, and a key missing from the
 * batch reads as absent.
 * @returns {Array<string>} Scoped and bare keys, in that order per record
 */
function capKeys() {
    return CAP_BASES.flatMap((base) => [characterKey(base), base]);
}

/** @returns {string} The protected-task list's key for the current character */
function protectedStorageKey() {
    const charId = dataManager.getCurrentCharacterId() || 'default';
    return `${PROTECTED_KEY_PREFIX}_${charId}`;
}

/**
 * @param {number} coins - An amount of coins
 * @returns {string} The amount with its icon
 */
function coinLabel(coins) {
    return `${formatKMB(coins)}\u{1FA99}`;
}

/**
 * @param {number} cowbells - An amount of cowbells
 * @returns {string} The amount with its icon
 */
function cowbellLabel(cowbells) {
    return `${cowbells}\u{1F514}`;
}

/**
 * What the task's next reroll costs in each currency, by the game's own ladder.
 *
 * Each currency doubles independently and caps: paying coins five times does
 * not make the first cowbell reroll any dearer.
 *
 * @param {Object|null} quest - The card's characterQuest
 * @returns {{coin: number, cowbell: number}|null} Costs, or null when unreadable
 */
export function nextRerollCosts(quest) {
    if (!quest) return null;
    const coinCount = Number(quest.coinRerollCount) || 0;
    const cowbellCount = Number(quest.cowbellRerollCount) || 0;
    return {
        coin: Math.min(COIN_REROLL_BASE * Math.pow(2, coinCount), COIN_REROLL_CAP),
        cowbell: Math.min(Math.pow(2, cowbellCount), COWBELL_REROLL_CAP),
    };
}

/**
 * What the open chooser says the next reroll costs, which beats the formula.
 *
 * @param {Array<Object>} options - From `findRerollOptions`
 * @returns {{coin: number|null, cowbell: number|null, free: boolean}}
 */
export function costsFromChooser(options) {
    const costs = { coin: null, cowbell: null, free: false };
    for (const option of options || []) {
        if (!option.available) continue;
        if (option.kind === 'free') {
            costs.free = true;
        } else if (option.cost !== null && option.cost !== undefined) {
            costs[option.kind] = option.cost;
        }
    }
    return costs;
}

/**
 * Which reroll to buy, and why — or that both are blocked.
 *
 * "Blocked" is exactly what the shield popup means by it: a cost at or above
 * the threshold that popup was set to. The comparison between the two live
 * options is done in coins, because that is the only unit both are quotable in;
 * a free reroll skips all of it, being cheaper than everything.
 *
 * Three states, not two, and the third is what `atCap` exists to keep apart: an
 * option can be over the player's cap, or it can simply not be buyable this
 * instant — no price for it, or an open chooser refusing it. Only the first is
 * a verdict about the task, and only the first may end in a discard. Reading
 * the second as the first is how a card with 10K spent, a 20K next coin reroll
 * and an 80K cap was announced as "both reroll options blocked" and offered up
 * for the trash.
 *
 * @param {Object} params - Prices, limits and taste
 * @param {number|null} params.coin - Next coin reroll's cost
 * @param {number|null} params.cowbell - Next cowbell reroll's cost
 * @param {boolean} [params.free] - Is a free reroll on offer right now?
 * @param {number} params.coinThreshold - Block coins at this cost
 * @param {number} params.cowbellThreshold - Block cowbells at this cost
 * @param {number} params.cowbellValue - What one cowbell is worth in coins
 * @param {string} [params.preference] - 'auto', 'cowbell' or 'coin'
 * @param {boolean} [params.coinOffered=true] - Is a coin option pressable right now?
 * @param {boolean} [params.cowbellOffered=true] - Is a cowbell option pressable right now?
 * @returns {{currency: string|null, cost: number|null, costLabel: string, why: string, atCap: boolean}}
 */
export function chooseReroll({
    coin,
    cowbell,
    free,
    coinThreshold,
    cowbellThreshold,
    cowbellValue,
    preference,
    coinOffered = true,
    cowbellOffered = true,
}) {
    if (free) return { currency: 'free', cost: 0, costLabel: 'free', why: '', atCap: false };

    const coinPriced = coin !== null && coin !== undefined;
    const cowbellPriced = cowbell !== null && cowbell !== undefined;
    const coinCapped = coinPriced && coin >= coinThreshold;
    const cowbellCapped = cowbellPriced && cowbell >= cowbellThreshold;
    const coinOk = coinPriced && !coinCapped && coinOffered !== false;
    const cowbellOk = cowbellPriced && !cowbellCapped && cowbellOffered !== false;

    if (!coinOk && !cowbellOk) {
        // Both priced and both over the cap is the player's own ceiling saying
        // no, which a discard may answer. Anything else is the walk not being
        // able to see, which it may not.
        const atCap = coinCapped && cowbellCapped;
        return {
            currency: null,
            cost: null,
            costLabel: '',
            why: atCap ? 'both reroll options blocked' : 'no reroll on offer',
            atCap,
        };
    }

    const takeCoin = (why) => ({ currency: 'coin', cost: coin, costLabel: coinLabel(coin), why, atCap: false });
    const takeCowbell = (why) => ({
        currency: 'cowbell',
        cost: cowbell,
        costLabel: cowbellLabel(cowbell),
        why,
        atCap: false,
    });

    if (!coinOk) return takeCowbell(coinCapped ? 'coins blocked' : 'coins not on offer');
    if (!cowbellOk) return takeCoin(cowbellCapped ? 'cowbells blocked' : 'cowbells not on offer');
    if (preference === 'cowbell') return takeCowbell('preferred');
    if (preference === 'coin') return takeCoin('preferred');

    // Both are live and neither is blocked, so it comes down to what they cost
    const cowbellCoins = cowbell * (Number(cowbellValue) || 0);
    if (cowbellCoins <= coin) {
        return takeCowbell(`≈${formatKMB(cowbellCoins)}, cheaper than ${coinLabel(coin)}`);
    }
    return takeCoin(`cheaper than ${cowbellLabel(cowbell)} ≈${formatKMB(cowbellCoins)}`);
}

/**
 * The reroll option a walk should press, out of what the chooser is offering.
 *
 * Free first, because it costs nothing. After that the currency the plan priced
 * is pressed, so the button clicked is the button the label named; with no
 * currency named it falls back to cowbells before coins, which is what a player
 * setting out to reroll a whole board is normally spending.
 *
 * @param {Array<{kind: string, available: boolean}>} options - What the chooser offers
 * @param {string|null} [currency] - The currency the plan chose
 * @returns {Object|null} The option to press, or null when none is available
 */
export function preferredRerollOption(options, currency = null) {
    const usable = (options || []).filter((option) => option.available);
    const free = usable.find((option) => option.kind === 'free');
    if (free) return free;
    if (currency && currency !== 'free') {
        return usable.find((option) => option.kind === currency) || null;
    }
    for (const kind of ['cowbell', 'coin']) {
        const match = usable.find((option) => option.kind === kind);
        if (match) return match;
    }
    return null;
}

/**
 * What the walk should do about one card.
 *
 * @param {Object} params - The card's situation
 * @param {boolean} params.completed - Is it waiting to be claimed?
 * @param {boolean} params.isProtected - Is it on the protected list?
 * @param {Object|null} params.choice - From `chooseReroll`, or null when unreadable
 * @param {boolean} params.trashAtLimit - Discard a task whose options are both blocked?
 * @returns {{action: string, reason: string, retryable?: boolean}} 'reroll', 'trash' or
 *   'skip', why, and whether the skip is a moment's state rather than a fact about the task
 */
export function verdictForCard({ completed, isProtected, choice, trashAtLimit }) {
    if (completed) return { action: 'skip', reason: 'ready to claim' };
    if (isProtected) return { action: 'skip', reason: 'protected' };
    // A card whose price cannot be read cannot be judged either, and guessing is
    // how a walk rerolls something the player was keeping
    if (!choice) return { action: 'skip', reason: 'unreadable' };
    if (!choice.currency) {
        // Only `atCap` — both options priced, both at or over the player's own
        // ceiling — may end a task. Nothing to press is a card to come back to,
        // not a card to destroy.
        if (trashAtLimit && choice.atCap) return { action: 'trash', reason: choice.why || 'blocked' };
        // Not at cap means the walk could not *see* a buyable option, which is
        // what an open chooser looks like for the moment the game spends
        // answering the last payment. That is a wait, not a verdict about the
        // task — see the retry in `_plan`.
        return { action: 'skip', reason: choice.why || 'blocked', retryable: !choice.atCap };
    }
    return { action: 'reroll', reason: choice.costLabel + (choice.why ? ` (${choice.why})` : '') };
}

/** How many short waits a chooser may stay unpressable before the walk gives up on it */
const PENDING_RETRY_LIMIT = 12;

/**
 * How many short waits a paid reroll may go unanswered before the walk stops.
 *
 * Longer than {@link PENDING_RETRY_LIMIT} and past {@link SERVER_SETTLE_MS},
 * because this one is waiting on the server rather than on a React re-render.
 */
const PAID_WAIT_LIMIT = 25;

class TaskRerollWalk {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        /**
         * The post-read sort's own timer, kept out of {@link timerRegistry}.
         *
         * Every re-plan clears that registry, and a `quests_updated` — which
         * reading tasks is guaranteed to produce — re-plans. The sort was
         * therefore cancelled by the very message that proved the read had
         * worked, on every board, every time.
         */
        this.sortTimerRegistry = createTimerRegistry();
        this.protectedHrids = new Set();
        /** The cap ceiling the current step was planned under */
        this.planCap = '';
        /** idle | ready | waiting | done | stopped */
        this.state = 'idle';
        /** Set by a plan that found the chooser drawn but unpressable; cleared each plan */
        this.pending = false;
        this.pendingRetries = 0;
        /** The card a `pay` press was just made on, and how it looked at the time */
        this.paidFor = null;
        this.paidWaits = 0;
        /** A payment the player pressed, billed only once the server answers it */
        this.pendingBill = null;
        /**
         * What each card's own open chooser quoted, by task signature.
         *
         * The ladder is a prediction and the chooser is the truth, and when the
         * two disagree on a card near the threshold the walk used to oscillate:
         * predict affordable, open, read blocked, close, predict affordable
         * again. Once a chooser has spoken, its prices stand in for the ladder
         * until that quest slot's reroll counts move.
         *
         * Keyed by quest id and reroll counts, NOT by the card's task signature:
         * two cards can carry the same task with the same goal, and a
         * name-keyed memory let one card's over-cap prices condemn the other's
         * fresh 10K reroll — the walk offered to trash tasks it had never even
         * priced. The quest id is the slot's own; the counts retire the entry
         * the moment a reroll (or anything else) moves them.
         */
        this.chooserQuotes = new Map();
        /** The game button a manual step is asking the player to press */
        this.highlightedButton = null;
        /**
         * Task signatures whose payment the walk pressed and the game never
         * answered. The walk's press goes through the React handler with a
         * synthetic event; if a build ever refuses that, the card's next
         * attempt is asked of the player instead — their real press always
         * counts — rather than pressed again into the void.
         */
        this.manualFor = new Set();
        /** Read presses made on the unread-tasks notice this walk */
        this.readPresses = 0;
        /** True between a Read press and the sort that follows it */
        this.awaitingReadSort = false;
        /** Whether any card press has been made — after that, Read is never offered */
        this.walkBegun = false;
        this.step = null;
        this.message = '';
        this.index = 0;
        /**
         * What the walk did and what it cost. The counts were always here; the
         * two spend totals are what the player was otherwise left to reconstruct
         * from their coin balance afterwards.
         */
        this.tally = { kept: 0, rerolled: 0, trashed: 0, goldSpent: 0, cowbellsSpent: 0 };
        /** The last finished walk's summary, kept after its widget goes away */
        this.summary = '';
        /** Bumped by every start and every stop, so an in-flight start can tell it was abandoned */
        this.startGeneration = 0;
        this.coinThreshold = DEFAULT_COIN_THRESHOLD;
        this.cowbellThreshold = DEFAULT_COWBELL_THRESHOLD;
        /** The shield popup's cap-block switch — the thresholds mean nothing without it */
        this.capProtectionEnabled = false;
        this.widget = null;
        this.panelPosition = null;
        /** The ✕ puts the widget away until the header 🎲 asks for it back */
        this.hidden = false;
        this.boardWatcher = null;
    }

    /** Set the walk up; its widget appears with the task board. */
    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('tasks_rerollWalk')) return;
        this.isInitialized = true;

        // The protected list, the widget's position and the six cap records in
        // one readonly transaction rather than five awaited round trips: at
        // startup a dozen features open their own reads at once, and each
        // transaction queues behind every one of theirs. Keys are built here,
        // before the read, so a switch landing inside it cannot make the read
        // and whatever is done with it name different characters.
        // A character switch tearing the feature down while this read is in
        // flight used to leave the resumed tail pushing its four
        // registrations into the `unregisterHandlers` array `disable()` had
        // already emptied — live handlers and observers with no handle to
        // remove them by. Three of the four redo idempotent work and self-heal
        // at the next switch's teardown, but the duplicate
        // `document.addEventListener('click', spendHandler, true)` is not: a
        // real click on the highlighted spend button would call
        // `_manualPressed()` once per leaked listener, visibly double-advancing
        // the walk on a single press.
        const ticket = captureOwner(this);
        try {
            const protectedKey = protectedStorageKey();
            const batch = await storage.getMany([protectedKey, PANEL_POSITION_KEY, ...capKeys()], 'settings');
            this.protectedHrids = new Set(storage.parseJSON(batch.get(protectedKey), protectedKey, []));
            await this._loadThresholds(batch);
            this.panelPosition = batch.get(PANEL_POSITION_KEY) ?? null;
        } catch (error) {
            console.error('[TaskRerollWalk] Loading the walk’s stored state failed:', error);
        }
        if (!stillOurs(ticket)) return;

        const unregisterPanel = domObserver.onClass('TaskRerollWalk-Panel', 'TasksPanel_taskSlotCount', (panel) => {
            this._injectButton(panel);
        });
        this.unregisterHandlers.push(unregisterPanel);

        // The widget belongs to the Tasks page: it appears with the board and
        // goes when the board does, rather than following the player around the
        // game offering to reroll something that is not on screen.
        this.boardWatcher = createMutationWatcher(
            document.body,
            (mutations) => {
                // Our own widget's writes must not feed back into this watcher:
                // a render that set a label fired the observer, which rendered,
                // which set the label… and the Tasks page froze solid
                const own = this.widget?.element;
                if (own && mutations.every((m) => own.contains(m.target))) return;
                this._syncWidget();
            },
            { childList: true, subtree: true }
        );
        this.unregisterHandlers.push(() => this.boardWatcher?.());
        this._syncWidget();

        // The only listener the walk has, and it does not click anything: it
        // reads the board again once the game has answered for the click the
        // player made, so the next label describes the task that actually
        // arrived rather than the one that was there before.
        const questHandler = () => {
            if (this.state === 'waiting') this._replanSoon(UI_SETTLE_MS);
        };
        webSocketHook.on('quests_updated', questHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('quests_updated', questHandler));

        // The game accepts a reroll payment only from a real user gesture — a
        // synthetic click on Pay lands as if it never happened (verified live
        // 2026-08-31; the open and Back presses still take synthetic clicks).
        // So a spend step is the player's press, not the walk's: the walk
        // highlights the button, and this listener is how it hears the press it
        // asked for. Capture phase, read-only — it never blocks or redirects
        // the click, it only does the walk's bookkeeping alongside it.
        const spendHandler = (event) => {
            if (this.state !== 'ready' || !this.step?.manual) return;
            if (!event.isTrusted) return;
            // Re-derived rather than trusted from the plan: the board redraws
            // between the plan and the press, and the confirm step never had a
            // button to carry in the first place
            const button = this._buttonFor(this.step);
            if (!button || !(button === event.target || button.contains(event.target))) return;
            this._manualPressed();
        };
        document.addEventListener('click', spendHandler, true);
        this.unregisterHandlers.push(() => document.removeEventListener('click', spendHandler, true));
    }

    /**
     * Read the shield popup's cap block — the same keys it writes, per
     * character and through the same adopt-once migration, so the two features
     * cannot drift apart and an alt cannot inherit the main's thresholds.
     *
     * All three keys, switch included. The two numbers are the cap block's
     * settings, not standing rules of their own: with the block switched off
     * the popup itself lets every reroll through, and a walk that read only the
     * numbers went on refusing them.
     * @private
     */
    async _loadThresholds(prefetched = null) {
        try {
            // One transaction for all six records, not three scoped reads of
            // up to two apiece. `prefetched` lets `initialize` fold them into
            // the batch it was opening anyway.
            const caps = prefetched ?? (await storage.getMany(capKeys(), 'settings'));
            this.capProtectionEnabled = Boolean(await readScopedFrom('taskCapProtection', caps, 'settings', false));
            this.coinThreshold =
                Number(await readScopedFrom('taskCapCoinThreshold', caps, 'settings', DEFAULT_COIN_THRESHOLD)) ||
                DEFAULT_COIN_THRESHOLD;
            this.cowbellThreshold =
                Number(await readScopedFrom('taskCapCowbellThreshold', caps, 'settings', DEFAULT_COWBELL_THRESHOLD)) ||
                DEFAULT_COWBELL_THRESHOLD;
        } catch (error) {
            console.error('[TaskRerollWalk] Failed to read the block-reroll thresholds:', error);
        }
    }

    /**
     * The cap block as it stands *now*, not as it stood when the walk started.
     *
     * The shield popup owns these three values and can change them at any
     * moment, including while a walk is armed with its next press already
     * labelled. `_loadThresholds` runs at start-up and at `start()` and nowhere
     * else, so an edit made after that was invisible to the walk until the page
     * was reloaded — the walk went on blocking at the old ceiling, decided
     * "both reroll options blocked" on a card whose chooser was quoting prices
     * the player had just allowed, and retired the card with a Back press
     * labelled "Close the menu on #N (both reroll options blocked)".
     *
     * The popup's own module is the live copy: its selects write to it the
     * instant they change, before the storage round-trip even resolves. The
     * walk's stored copy stays as the fallback for a board where reroll
     * protection is switched off and never loaded anything.
     *
     * @returns {{enabled: boolean, coin: number, cowbell: number}}
     * @private
     */
    _liveCapBlock() {
        // The import is the feature's export wrapper; the object the popup's
        // selects actually write is the instance it exposes as `.protection`.
        // The wrapper never carries `isInitialized`, so reading it here fell
        // back to the stored copy on every call — the reload-to-apply bug this
        // method exists to fix.
        const instance = taskRerollProtection?.protection;
        const live = instance?.isInitialized ? instance : this;
        return {
            enabled: Boolean(live.capProtectionEnabled),
            coin: Number(live.coinThreshold) || DEFAULT_COIN_THRESHOLD,
            cowbell: Number(live.cowbellThreshold) || DEFAULT_COWBELL_THRESHOLD,
        };
    }

    /**
     * The protected-task list as it stands *now*.
     *
     * The shield popup writes its own module's set the instant a row is
     * clicked, before the storage round-trip resolves; the walk's copy is read
     * from storage once at start-up and stays as the fallback for a session
     * where reroll protection is switched off (whose popup cannot edit the
     * list anyway).
     *
     * @returns {Set<string>}
     * @private
     */
    _liveProtectedHrids() {
        const instance = taskRerollProtection?.protection;
        return instance?.isInitialized ? instance.protectedHrids : this.protectedHrids;
    }

    /**
     * The prices the plan blocks at right now.
     *
     * With the cap block switched off nothing is blocked on price — the walk
     * still stops at the end of the board, and every reroll is still one press
     * the player makes deliberately.
     *
     * @returns {{coinThreshold: number, cowbellThreshold: number}}
     * @private
     */
    _blockThresholds() {
        const cap = this._liveCapBlock();
        if (!cap.enabled) return { coinThreshold: Infinity, cowbellThreshold: Infinity };
        return { coinThreshold: cap.coin, cowbellThreshold: cap.cowbell };
    }

    /**
     * Add the walk's control to the task panel header.
     *
     * It shows and hides the widget rather than starting anything: the widget's
     * own button is what starts a walk, and a header icon that begins spending
     * cowbells is not a header icon anyone wants to brush past.
     *
     * @param {HTMLElement} panel - The TasksPanel_taskSlotCount element
     * @private
     */
    _injectButton(panel) {
        const parent = panel?.parentElement;
        if (!parent || parent.querySelector(`.${BUTTON_CLASS}`)) return;

        const button = document.createElement('span');
        button.className = BUTTON_CLASS;
        button.textContent = '\u{1F3B2}';
        button.title =
            'Reroll walk: show or hide the walk panel. The walk steps down the board one click at a time, ' +
            'leaves protected tasks alone, and stops rerolling a task once the shield popup would block the ' +
            'next reroll.';
        button.style.cssText = 'cursor:pointer; font-size:16px; margin-left:6px; opacity:0.7; transition:opacity 0.1s;';
        button.addEventListener('mouseover', () => {
            button.style.opacity = '1';
        });
        button.addEventListener('mouseout', () => {
            button.style.opacity = '0.7';
        });
        button.addEventListener('click', () => this.toggleWidget());

        parent.appendChild(button);
    }

    // ---------------------------------------------------------------- reading

    /**
     * The board's cards, in the order it draws them.
     * @returns {Array<HTMLElement>}
     * @private
     */
    _cards() {
        const list = document.querySelector(GAME.TASK_LIST);
        if (!list) return [];
        return Array.from(list.querySelectorAll(GAME.TASK_CARD));
    }

    /**
     * The Read button on the board's "You have N unread tasks" notice, when the
     * notice is showing. Found by the notice's own class, not its wording.
     * @returns {HTMLElement|null}
     * @private
     */
    _readButton() {
        const list = document.querySelector(GAME.TASK_LIST);
        return list?.querySelector(`${UNREAD_NOTICE} button`) || null;
    }

    /**
     * The card's own Reroll button — the one that opens the chooser.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _rerollButton(card) {
        return [...card.querySelectorAll('button')].find((b) => /^reroll$/i.test((b.textContent || '').trim())) || null;
    }

    /**
     * The trash can: the game's only button on a resting card with no words on it.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _trashButton(card) {
        const buttons = [...card.querySelectorAll('button')];
        return (
            buttons.find((b) => !(b.textContent || '').trim() && !b.closest('[class^="mwi-"], [class*=" mwi-"]')) ||
            null
        );
    }

    /**
     * The Confirm Discard button, however this build words it.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _discardButton(card) {
        return [...card.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent || '')) || null;
    }

    /**
     * The chooser's Back button.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _backButton(card) {
        return [...card.querySelectorAll('button')].find((b) => /^back$/i.test((b.textContent || '').trim())) || null;
    }

    /**
     * Is this card waiting to be claimed rather than done with?
     * @param {HTMLElement} card - A task card
     * @returns {boolean}
     * @private
     */
    _isCompleted(card) {
        return [...card.querySelectorAll('button')].some((b) => /claim/i.test(b.textContent || ''));
    }

    // --------------------------------------------------------------- planning

    /**
     * What the next reroll on this card costs: the chooser's own Pay buttons
     * when it is open, the game's price ladder when it is not.
     *
     * @param {Object|null} quest - The card's quest
     * @param {Array<Object>} chooser - From `findRerollOptions`
     * @returns {{coin: number|null, cowbell: number|null, free: boolean}|null}
     * @private
     */
    _costsFor(quest, chooser) {
        const live = costsFromChooser(chooser);
        const ladder = nextRerollCosts(quest);

        // Nothing pressable and no ladder: either the chooser is shut and the
        // quest is unreadable, or there is nothing here to judge at all.
        if (!ladder && !chooser.length) return null;

        // An open chooser with something pressable in it says which currencies
        // can be *paid* right now, and that is the only question the pressing
        // side of the plan may ask of it: pricing a currency the chooser is
        // refusing — the button is there and greyed out — at the ladder's price
        // had the plan name coins, `preferredRerollOption` find no pressable
        // coin option, and the walk wait the chooser out and stop on a card it
        // could have rerolled with the other currency.
        //
        // It is not the question the *cap* asks. A refused option has no quoted
        // price, and "no price" is not "over the player's cap" — read as one it
        // condemned a card whose next coin reroll was 20K under an 80K cap. So
        // the ladder still prices what the chooser will not, and the refusal
        // travels separately as `offered`.
        const offering = (chooser || []).some((option) => option.available);
        return {
            coin: live.coin ?? ladder?.coin ?? null,
            cowbell: live.cowbell ?? ladder?.cowbell ?? null,
            free: live.free,
            coinOffered: !offering || live.coin !== null,
            cowbellOffered: !offering || live.cowbell !== null,
        };
    }

    /**
     * What one cowbell is worth in coins, priced the way the task profit display
     * prices it. Wrapped so a market with nothing in it cannot throw the plan.
     * @returns {number}
     * @private
     */
    _cowbellValue() {
        try {
            return Number(getCowbellValue()) || 0;
        } catch (error) {
            console.error('[TaskRerollWalk] Pricing a cowbell failed:', error);
            return 0;
        }
    }

    /**
     * The next thing a press would do, skipping past every card that needs
     * nothing.
     *
     * Skipping is bookkeeping, not a game action, so several cards can be
     * passed over inside one plan — no click happens for any of them.
     *
     * @returns {Object|null} The step, or null when the board is walked (or the walk gave up)
     * @private
     */
    _plan() {
        // Unread tasks first: the board can be carrying a "You have N unread
        // tasks" notice whose Read press reveals them, and rerolling around
        // hidden tasks walks an incomplete board. Offered only before any card
        // press — after that the card indexes must stay put — and re-offered a
        // bounded few times when a press did not clear it, since the notice
        // still standing is the only proof the click reached the game.
        if (!this.walkBegun && this.readPresses < READ_PRESS_LIMIT) {
            const readButton = this._readButton();
            if (readButton) {
                return {
                    kind: 'read',
                    card: readButton.closest(UNREAD_NOTICE) || readButton,
                    slot: 0,
                    label: 'Read unread tasks',
                    button: null,
                    signature: '',
                };
            }
        }

        // A payment or discard confirm is billed here, once the board proves the
        // server answered it — the press itself is no proof, since the shield's
        // lockdown (or the game refusing a click) leaves the card exactly as it
        // was. Either the card is gone, or its task or a reroll count moved.
        if (this.pendingBill && this.paidFor) {
            const paidCard = this._paidCard();
            // Re-pointed: React remounts card nodes freely, and the fingerprint
            // below must be read off the node that carries the slot now
            if (paidCard) this.paidFor.card = paidCard;
            const now = paidCard ? this._rerollFingerprint(paidCard) : null;
            const answered =
                !now ||
                now.signature !== this.paidFor.signature ||
                now.coin !== this.paidFor.coin ||
                now.cowbell !== this.paidFor.cowbell;
            if (answered) {
                const { kind, currency, cost } = this.pendingBill;
                if (kind === 'trash') {
                    this.tally.trashed += 1;
                    this._retireDiscardedSlot(this.pendingBill);
                } else {
                    this.tally.rerolled += 1;
                    if (Number.isFinite(cost) && cost > 0) {
                        if (currency === 'coin') this.tally.goldSpent += cost;
                        else if (currency === 'cowbell') this.tally.cowbellsSpent += cost;
                    }
                }
                this.pendingBill = null;
            }
        }

        const trashAtLimit = Boolean(config.getSetting('tasks_rerollWalkTrashAtLimit'));
        const preference = String(config.getSettingValue('tasks_rerollWalkCurrency', 'auto') || 'auto');
        const cowbellValue = this._cowbellValue();
        const { coinThreshold, cowbellThreshold } = this._blockThresholds();
        // What ceiling this plan was drawn under, so a cap edited while the
        // walk sits armed can be noticed and the label redrawn against it
        this.planCap = `${coinThreshold}/${cowbellThreshold}`;
        const cards = this._cards();

        while (this.index < cards.length) {
            const card = cards[this.index];
            const slot = this.index + 1;
            const quest = questForTaskCard(card);
            const hrid = quest?.actionHrid || quest?.monsterHrid || '';

            const chooser = findRerollOptions(card);
            const signature = cardTaskKey(card);
            let costs = this._costsFor(quest, chooser);
            // An open chooser is the truth about this task's prices; remember it
            // so a closed card is re-judged on what its chooser actually said
            // rather than on the ladder's prediction. The disagreement between
            // the two is what used to reopen a card the chooser had already
            // priced over the cap — close, predict affordable, open, read
            // blocked, close again, forever. A card whose quest cannot be read
            // remembers nothing: a memory that cannot name its owner is exactly
            // the cross-card poisoning this key exists to prevent.
            const questKey = quest?.id
                ? `${quest.id}:${Number(quest.coinRerollCount) || 0}:${Number(quest.cowbellRerollCount) || 0}`
                : null;
            //
            // Prices only: which options that chooser happened to be offering
            // is true of one moment, not of the task, and remembering it turned
            // a chooser that momentarily refused its coin button — which is how
            // it looks while the game answers a payment — into a card that
            // stayed "both reroll options blocked" for the rest of the walk.
            if (questKey && chooser.some((option) => option.available)) {
                this.chooserQuotes.set(questKey, { coin: costs.coin, cowbell: costs.cowbell, free: costs.free });
            } else if (questKey && !chooser.length && this.chooserQuotes.has(questKey)) {
                costs = { ...this.chooserQuotes.get(questKey), coinOffered: true, cowbellOffered: true };
            }
            const choice = costs
                ? chooseReroll({
                      ...costs,
                      coinThreshold,
                      cowbellThreshold,
                      cowbellValue,
                      preference,
                  })
                : null;

            const verdict = verdictForCard({
                completed: this._isCompleted(card),
                isProtected: Boolean(hrid && this._liveProtectedHrids().has(hrid)),
                choice,
                trashAtLimit,
            });

            const discardOpen = this._discardButton(card);

            if (verdict.action === 'skip') {
                // A card being left behind with its menu still open is tidied
                // first — one press, and it is the same press a person makes
                const back = chooser.length || discardOpen ? this._backButton(card) : null;
                // An open chooser refusing the one currency the cap allows is
                // not a card to retire: it is how the chooser looks while the
                // game answers the payment just made on it, and the button
                // comes back a moment later. Retiring it there cost a Back and
                // a Reroll press per cycle and put "Close the menu on #1" in
                // front of a player whose 20K reroll was well under their 80K
                // cap. The same refusal inside the reroll branch has always
                // been waited out; this is that wait, on the other verdict.
                // Protected, completed and unreadable are facts about the card,
                // and they close the menu at once as before.
                if (back && chooser.length && verdict.retryable && this.pendingRetries < PENDING_RETRY_LIMIT) {
                    this.pendingRetries += 1;
                    this.pending = true;
                    return null;
                }
                if (back) return this._step('back', card, slot, `Close the menu on #${slot} (${verdict.reason})`);
                this.tally.kept += 1;
                this.index += 1;
                // The wait budget belongs to the card that spent it. Before the
                // retry above existed, an exhausted budget always stopped the
                // walk on the same card, so it never travelled; now a card given
                // up on is kept and the walk moves on, and a budget carried with
                // it retired the *next* card's momentary refusal on sight — the
                // exact behaviour the retry was added to end, one card later.
                this.pendingRetries = 0;
                continue;
            }

            if (verdict.action === 'trash') {
                if (discardOpen) {
                    // A confirm already pressed and unanswered is waited out
                    // the way a payment is; one the game evidently refused goes
                    // to the player, whose real press always counts — pressing
                    // it again into the void counted a discard per press
                    if (this._rerollStillInFlight(card)) {
                        if (this.paidWaits < PAID_WAIT_LIMIT) {
                            this.paidWaits += 1;
                            this.pending = true;
                            return null;
                        }
                        this.manualFor.add(questKey || signature);
                        this.paidFor = null;
                        this.pendingBill = null;
                    }
                    const manual = this.manualFor.has(questKey || signature);
                    return this._step(
                        'confirmDiscard',
                        card,
                        slot,
                        manual ? `Press Confirm on #${slot} to discard` : `Confirm discard #${slot}`,
                        null,
                        { manual }
                    );
                }
                if (chooser.length) {
                    const back = this._backButton(card);
                    if (back) return this._step('back', card, slot, `Close the menu on #${slot} (${verdict.reason})`);
                }
                if (!this._trashButton(card)) {
                    this.message = `Slot ${slot} has no discard button — walk stopped.`;
                    return null;
                }
                return this._step('trash', card, slot, `Trash #${slot} (${verdict.reason})`);
            }

            // A reroll: open the chooser, then pay. Two presses, on purpose.
            if (chooser.length) {
                const option = preferredRerollOption(chooser, choice.currency);
                if (!option) {
                    // Options drawn but none pressable is what the chooser looks
                    // like while the game is still answering the last payment —
                    // the buttons come back a moment later. A wait, then; a stop
                    // only once it has stayed that way too long to be that
                    if (this.pendingRetries < PENDING_RETRY_LIMIT) {
                        this.pendingRetries += 1;
                        this.pending = true;
                        return null;
                    }
                    this.message = `No reroll on offer for #${slot} — walk stopped.`;
                    return null;
                }
                this.pendingRetries = 0;

                // A payment was made on this card and the card has not moved
                // since: same task, same reroll counts. A reroll that had landed
                // would have changed one of them, so this is the previous
                // payment still in flight and the chooser is showing its
                // *pre-payment* prices. Offering the Pay button again here
                // charges a second reroll while quoting the first one's price,
                // and what the game actually takes is the doubled one — which
                // may be over the threshold the player set. Wait for the answer
                // instead. Reachable well inside SERVER_SETTLE_MS because any
                // `quests_updated` cuts that wait to UI_SETTLE_MS, and a combat
                // kill ticking a task's progress sends one.
                if (this._rerollStillInFlight(card)) {
                    if (this.paidWaits < PAID_WAIT_LIMIT) {
                        this.paidWaits += 1;
                        this.pending = true;
                        return null;
                    }
                    // The card never moved, so the press evidently never took —
                    // the shield's lockdown ate it, or the game refused it.
                    // Nothing was spent (the bill only lands when the card
                    // moves), so forget the payment — and hand this card's next
                    // attempt to the player, whose real press always counts —
                    // rather than stopping the walk or pressing into the void.
                    this.manualFor.add(questKey || signature);
                    this.paidFor = null;
                    this.pendingBill = null;
                }
                this.paidFor = null;

                // The cost travels with the step, because this is the moment it
                // is known: an open chooser prices itself, so `choice.cost` here
                // is the number on the very button the press is about to click,
                // not the ladder's guess at it.
                //
                // The walk presses this itself, through the game's React
                // handler (see react-click.js — the spend buttons check the
                // event's isTrusted flag, so a plain DOM click lands as if it
                // never happened). Manual is the fallback for a card whose
                // payment already went unanswered once: that step highlights
                // the button and asks the player for the press instead.
                const payManually = this.manualFor.has(questKey || signature);
                return this._step(
                    'pay',
                    card,
                    slot,
                    payManually
                        ? `Press #${slot}'s highlighted ${choice.costLabel} button`
                        : `Reroll #${slot} — ${verdict.reason}`,
                    option.button,
                    {
                        currency: choice.currency,
                        cost: choice.cost,
                        manual: payManually,
                    }
                );
            }
            if (!this._rerollButton(card)) {
                this.message = `Slot ${slot} has no reroll button — walk stopped.`;
                return null;
            }
            return this._step('open', card, slot, `Reroll #${slot} — ${verdict.reason}, open the menu`, null, {
                currency: choice.currency,
            });
        }

        return null;
    }

    /**
     * Record a planned press, with everything needed to prove the board has not
     * moved under it.
     * @param {string} kind - What the press does
     * @param {HTMLElement} card - The card it acts on
     * @param {number} slot - The card's 1-based position
     * @param {string} label - What the widget says
     * @param {HTMLElement} [button] - The exact button, when the plan picked one
     * @param {Object} [extra] - Anything else the press needs, such as the currency
     * @returns {Object} The step
     * @private
     */
    _step(kind, card, slot, label, button = null, extra = {}) {
        return { kind, card, slot, label, button, signature: cardTaskKey(card), ...extra };
    }

    /**
     * What a card looks like, for the purpose of noticing that a reroll landed.
     *
     * A reroll changes the task, and the server's answer raises that currency's
     * count, so either moving is proof the payment was answered.
     *
     * @param {HTMLElement} card - A task card
     * @returns {{signature: string, coin: number, cowbell: number}}
     * @private
     */
    _rerollFingerprint(card) {
        const quest = questForTaskCard(card);
        return {
            signature: cardTaskKey(card),
            coin: Number(quest?.coinRerollCount) || 0,
            cowbell: Number(quest?.cowbellRerollCount) || 0,
        };
    }

    /**
     * Track a press the server has to answer, so it is billed only once the
     * card proves the answer arrived. A press the shield's lockdown ate, or
     * one the game refused, leaves the card unmoved — and a press that moved
     * nothing cost nothing and trashed nothing.
     *
     * @param {Object} planned - The pay or confirmDiscard step just pressed
     * @private
     */
    _armSettle(planned) {
        this.pendingBill =
            planned.kind === 'pay'
                ? { kind: 'reroll', currency: planned.currency, cost: Number(planned.cost) }
                : // The slot and how long the board was are what
                  // `_retireDiscardedSlot` needs to tell a refilled slot from a
                  // removed one once the discard lands
                  { kind: 'trash', currency: null, cost: 0, slot: planned.slot, cardCount: this._cards().length };
        this.paidFor = {
            card: planned.card,
            questId: questForTaskCard(planned.card)?.id ?? null,
            ...this._rerollFingerprint(planned.card),
        };
        this.paidWaits = 0;
    }

    /**
     * Walk past a slot whose task has just been discarded.
     *
     * A discard is the end of the walk's business with that slot, and the game
     * refills it in place with a brand new task. Leaving the index where it was
     * made the very next plan judge that replacement as if it were the card the
     * walk had set out to price: a fresh 10K/1 ladder, rerolled up to the cap,
     * discarded, refilled, and round again — one press each, so never a runaway,
     * but an endless treadmill on one slot. The running spend piled up tasks
     * that no longer existed, which is why the chip's total could read three
     * times the card's own "Reroll spent" line.
     *
     * A board that got *shorter* is the other case: the card was removed rather
     * than replaced, everything below it moved up a place, and the index already
     * points at the next card to judge.
     *
     * @param {{slot: number, cardCount: number}} bill - The discard that just settled
     * @private
     */
    _retireDiscardedSlot({ slot, cardCount }) {
        if (!Number.isFinite(slot)) return;
        if (this._cards().length < cardCount) return;
        this.index = Math.max(this.index, slot);
    }

    /**
     * The card the in-flight payment was made on, found again when React has
     * remounted its node.
     *
     * A remount redraws the same quest slot into a fresh element without the
     * server having said anything, and a payment tracked by node identity read
     * the old node's absence as the answer — billing a press the game may have
     * refused, and offering the Pay button again at its stale pre-payment
     * price. The quest id is the slot's own and survives the remount.
     *
     * @returns {HTMLElement|null} The card, or null when the slot itself is gone
     * @private
     */
    _paidCard() {
        const paid = this.paidFor;
        if (!paid) return null;
        if (document.contains(paid.card)) return paid.card;
        if (paid.questId === null || paid.questId === undefined) return null;
        return this._cards().find((card) => questForTaskCard(card)?.id === paid.questId) || null;
    }

    /**
     * Is the payment already made on this card still unanswered?
     *
     * @param {HTMLElement} card - The card the plan is about to offer a payment on
     * @returns {boolean}
     * @private
     */
    _rerollStillInFlight(card) {
        const paid = this.paidFor;
        if (!paid) return false;
        const samePlace =
            paid.card === card ||
            (paid.questId !== null && paid.questId !== undefined && questForTaskCard(card)?.id === paid.questId);
        if (!samePlace) return false;
        const now = this._rerollFingerprint(card);
        return now.signature === paid.signature && now.coin === paid.coin && now.cowbell === paid.cowbell;
    }

    // --------------------------------------------------------------- the walk

    /**
     * Start a walk at the top of the board.
     * @returns {Promise<void>} Resolved once the first press is planned
     */
    async start() {
        // Which start this is. `_loadThresholds` awaits storage, so between the
        // reset below and the plan at the bottom the player can press Stop — or
        // press Start again — and the resumed half of an abandoned start would
        // otherwise plan anyway, setting `ready` and drawing the widget over a
        // walk that had just been cancelled.
        const generation = ++this.startGeneration;
        this.index = 0;
        this.pendingRetries = 0;
        this.pending = false;
        this.paidFor = null;
        this.paidWaits = 0;
        this.pendingBill = null;
        this.chooserQuotes.clear();
        this.manualFor.clear();
        this.readPresses = 0;
        this.awaitingReadSort = false;
        this.walkBegun = false;
        this.tally = { kept: 0, rerolled: 0, trashed: 0, goldSpent: 0, cowbellsSpent: 0 };
        // A new walk is what finally replaces the last one's summary
        this.summary = '';
        this.message = '';
        this.hidden = false;
        this.timerRegistry.clearAll();
        this.sortTimerRegistry.clearAll();
        // Awaited, because the plan below is what obeys these numbers. Read
        // fire-and-forget they landed *after* the first plan was drawn, so a
        // threshold edited in the shield popup seconds earlier — the case this
        // re-read exists for — missed the very card the player was looking at
        // while they edited it.
        await this._loadThresholds();
        // Stopped, or superseded by a later start, while that read was in
        // flight: this walk is not the one the player is waiting on any more
        if (generation !== this.startGeneration) return;

        if (!this._cards().length && !this._readButton()) {
            this.state = 'stopped';
            this.message = 'No tasks on the board.';
            this._render();
            return;
        }

        this._replan();
    }

    /** Stop, leaving the board exactly as it is, and put the widget away. */
    stop() {
        // Bumped so a start still awaiting its thresholds cannot come back and
        // re-arm the walk this call just cancelled
        this.startGeneration += 1;
        this.state = 'idle';
        this.step = null;
        this.hidden = true;
        this._highlightButton(null);
        // Nothing is in flight once the walk has stopped waiting for it
        this.paidFor = null;
        this.paidWaits = 0;
        this.pendingBill = null;
        this.awaitingReadSort = false;
        this.timerRegistry.clearAll();
        this.sortTimerRegistry.clearAll();
        this._removeWidget();
    }

    /** The header 🎲: show the widget again, or put it away. */
    toggleWidget() {
        this.hidden = !this.hidden;
        if (this.hidden) this._removeWidget();
        else this._render();
    }

    /**
     * Re-read the board and work out the next press.
     * @private
     */
    _replan() {
        // Held while the post-read sort is still to come: planning against a
        // board that is about to be reordered names the wrong slot
        if (this.awaitingReadSort) {
            this.state = 'waiting';
            this._render();
            return;
        }
        this.pending = false;
        this.step = this._plan();
        if (this.step) {
            this.state = 'ready';
        } else if (this.pending) {
            // The board is mid-answer; look again shortly rather than ending
            this.state = 'waiting';
            this._replanSoon(UI_SETTLE_MS);
        } else {
            this.state = this.message ? 'stopped' : 'done';
            this.summary = this._summaryText();
        }
        this._render();
    }

    /**
     * Re-plan once the game has finished redrawing.
     * @param {number} delay - How long to leave it
     * @private
     */
    _replanSoon(delay) {
        this.timerRegistry.clearAll();
        const timeout = setTimeout(() => this._replan(), delay);
        this.timerRegistry.registerTimeout(timeout);
    }

    /**
     * Perform the one game click the widget is currently offering.
     *
     * Exactly one click leaves this method, on exactly the button the label
     * named, and only after the board has been checked against the plan. There
     * is no path through it that clicks twice, and nothing it schedules clicks
     * at all — the timer it sets only re-reads the board and rewrites the label.
     *
     * @returns {boolean} Whether the click was made
     */
    advance() {
        if (this.state !== 'ready' || !this.step) return false;

        const planned = this.step;

        // The Read press acts on the unread notice, not a task card, so the
        // slot and signature checks below do not apply to it — the button being
        // findable right now is the whole proof the notice is still there.
        if (planned.kind === 'read') {
            const readButton = this._readButton();
            if (!readButton) {
                // Read elsewhere already — nothing to press, walk on
                this._replan();
                return false;
            }
            clickThroughReact(readButton, { reactFirst: true });
            this.readPresses += 1;
            this.state = 'waiting';
            this._render();
            // Reading reveals tasks appended unsorted; a player who asked for a
            // sorted board expects them ordered, and the walk plans against
            // whatever order it finds — so sort first, then replan against the
            // settled board.
            //
            // This is the *only* sort that happens here. The sorter's own
            // sort-after-read is a delegated document click listener, and the
            // press above went through the game's React handler
            // (`clickThroughReact(…, { reactFirst: true })`), which dispatches
            // no DOM event at all — so that listener never fires for a walk.
            //
            // Hence both settings: `taskSorter_sortAfterRead` is the one written
            // for this exact moment, and asking only `taskSorter_autoSort` (the
            // *panel opening* setting) left anyone with sort-after-read on and
            // auto-sort off with a board that never re-sorted.
            //
            // And forced, for the same reason the Sort Tasks button forces. An
            // unforced pass returns without touching the board while any card is
            // mid-flow, and a reroll chooser left open is the walk's ordinary
            // resting state — the game keeps the chooser open after a reroll and
            // the walk only presses Back on cards it skips. Nothing is pulled out
            // from under a click by it: the walk owns the pressing here, it re-reads
            // the board in the `_replan()` on the next line, and `advance()` proves
            // the slot and the task again before any click.
            //
            // And on a timer of its own. `_replanSoon` clears `timerRegistry`
            // before every re-plan, and the walk re-plans on `quests_updated`
            // while it is waiting — which is exactly what reading tasks sends.
            // Sharing the registry meant the message proving the read had
            // landed was also the message that cancelled the sort, so the
            // forced sort never ran outside a test (where the websocket hook is
            // stubbed and no such message arrives). The sort is not a click and
            // nothing is planned off it, so it does not belong to the walk's
            // press timer in the first place.
            //
            // Nothing is planned until that sort has happened, either: a plan
            // drawn first names a slot the sort is about to move a different
            // card into, and the next press would abort with "Slot 1 is not the
            // card it was". So the `quests_updated` re-plan is held off until
            // the board is in its final order.
            this.awaitingReadSort = true;
            this.sortTimerRegistry.clearAll();
            this.sortTimerRegistry.registerTimeout(
                setTimeout(() => {
                    this.awaitingReadSort = false;
                    if (config.getSetting('taskSorter_sortAfterRead') || config.getSetting('taskSorter_autoSort')) {
                        try {
                            taskSorter.sortTasks(true);
                        } catch (error) {
                            console.error('[TaskRerollWalk] Post-read sort failed:', error);
                        }
                    }
                    this._replan();
                }, SERVER_SETTLE_MS)
            );
            this.timerRegistry.clearAll();
            return true;
        }

        const cards = this._cards();

        // A board that moved under the plan is not a reason to stop — the plan
        // was drawn from a snapshot and the snapshot went stale, which the
        // combat ticks alone do many times a minute. Read it again and say what
        // the next press really is; stopping here is what left the chip saying
        // "Close the menu" about a menu that had already closed.
        if (cards[planned.slot - 1] !== planned.card || !document.contains(planned.card)) {
            this._replan();
            return false;
        }
        if (cardTaskKey(planned.card) !== planned.signature) {
            this._replan();
            return false;
        }

        const button = this._buttonFor(planned);
        if (!button || !planned.card.contains(button)) {
            this._replan();
            return false;
        }

        // Protection is re-checked at the press, not only at the plan: the
        // walk's click goes through the game's React handler and dispatches no
        // DOM event, so the shield's capture listener never sees it. A task
        // protected between the plan and the press is caught here or nowhere.
        // Back is exempt — closing a menu destroys nothing.
        if (planned.kind !== 'back') {
            const quest = questForTaskCard(planned.card);
            const hrid = quest?.actionHrid || quest?.monsterHrid || '';
            if (hrid && this._liveProtectedHrids().has(hrid)) {
                this._replan();
                return false;
            }
        }

        // A manual step is the player's press, not the walk's: the game refuses
        // synthetic clicks on the buttons that spend or destroy, so the chip
        // can only bring the button to the player. The spend listener does the
        // bookkeeping when their press lands.
        if (planned.manual) {
            try {
                planned.card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch {
                planned.card.scrollIntoView?.();
            }
            return false;
        }

        clickThroughReact(button, { reactFirst: true });
        this.walkBegun = true;

        if (planned.kind === 'pay' || planned.kind === 'confirmDiscard') this._armSettle(planned);

        // A press the server has to answer for waits for its answer; a press
        // that only opened or closed a menu is React state and is back within a
        // frame. Either way what comes back is a label, not another click.
        const serverBound = planned.kind === 'pay' || planned.kind === 'confirmDiscard';
        this.state = 'waiting';
        this._render();
        this._replanSoon(serverBound ? SERVER_SETTLE_MS : UI_SETTLE_MS);
        return true;
    }

    /**
     * The player made the press a manual step asked for — do the bookkeeping
     * the walk used to do around its own click.
     * @private
     */
    _manualPressed() {
        const planned = this.step;
        if (!planned?.manual) return;
        this.walkBegun = true;

        if (planned.kind === 'pay' || planned.kind === 'confirmDiscard') this._armSettle(planned);

        this.state = 'waiting';
        this._render();
        this._replanSoon(SERVER_SETTLE_MS);
    }

    /**
     * Point at the button a manual step wants pressed, and only that one.
     * @param {HTMLElement|null} button - The button, or null to clear
     * @private
     */
    _highlightButton(button) {
        if (this.highlightedButton === button) return;
        if (this.highlightedButton) {
            try {
                this.highlightedButton.style.outline = '';
                this.highlightedButton.style.outlineOffset = '';
            } catch {
                // A button that left the DOM has nothing to clear
            }
        }
        this.highlightedButton = button || null;
        if (button) {
            button.style.outline = '3px solid #ffb020';
            button.style.outlineOffset = '2px';
        }
    }

    /**
     * Re-derive the button a planned press acts on, from the card as it is now.
     * @param {Object} planned - The step
     * @returns {HTMLElement|null}
     * @private
     */
    _buttonFor(planned) {
        const card = planned.card;
        if (planned.kind === 'open') return this._rerollButton(card);
        if (planned.kind === 'back') return this._backButton(card);
        if (planned.kind === 'trash') return this._trashButton(card);
        if (planned.kind === 'confirmDiscard') return this._discardButton(card);
        if (planned.kind === 'pay') {
            const option = preferredRerollOption(findRerollOptions(card), planned.currency);
            if (!option) return null;
            if (planned.manual) {
                // The player presses whatever button is on screen, and the board
                // redraws freely between the plan and the press — so the guard
                // is that the button still costs what the label says, not that
                // it is the same DOM element
                if (Number.isFinite(option.cost) && Number.isFinite(planned.cost) && option.cost !== planned.cost) {
                    return null;
                }
                return option.button;
            }
            // The chooser must still be offering exactly what the label priced
            if (planned.button && option.button !== planned.button) return null;
            return option.button;
        }
        return null;
    }

    /**
     * Stop the walk without clicking anything.
     * @param {string} message - Why
     * @returns {boolean} Always false
     * @private
     */
    _abort(message) {
        this.state = 'stopped';
        this.message = message;
        this.step = null;
        // A walk that stopped early still spent whatever it spent, and that
        // account outlives the widget the same way a finished one's does
        this.summary = this._summaryText();
        this._render();
        return false;
    }

    // ----------------------------------------------------------------- widget

    /**
     * What the walk has spent so far, in the currencies it actually spent.
     *
     * A readout, not a rule: nothing here stops or slows the walk, and the
     * module's one stopping rule is still the shield popup's. It exists because
     * the alternative was reading it off your coin balance afterwards.
     *
     * @returns {string} `120K🪙 + 3🔔`, or empty when nothing has been paid
     */
    spendLabel() {
        const parts = [];
        if (this.tally.goldSpent > 0) parts.push(coinLabel(this.tally.goldSpent));
        if (this.tally.cowbellsSpent > 0) parts.push(cowbellLabel(this.tally.cowbellsSpent));
        return parts.join(' + ');
    }

    /**
     * What one finished walk did, and what it cost.
     * @returns {string}
     * @private
     */
    _summaryText() {
        const { kept, rerolled, trashed } = this.tally;
        const spent = this.spendLabel();
        return `${kept} kept, ${rerolled} rerolled, ${trashed} trashed` + (spent ? ` · spent ${spent}` : '');
    }

    /**
     * What the widget's main button says right now.
     * @returns {string}
     */
    chipLabel() {
        const spent = this.spendLabel();
        // The running total rides along with the next action, so a walk that has
        // been paying for a while says so before the next payment, not after
        const running = spent ? ` · spent ${spent}` : '';
        if (this.state === 'ready' && this.step) {
            return `${this.step.manual ? '👉' : '▶'} ${this.step.label}${running}`;
        }
        if (this.state === 'waiting') return `⏳ Waiting for the game…${running}`;
        if (this.state === 'stopped') return `⚠ ${this.message}${running}`;
        // Idle carries the last walk's summary while there is one: the ✕ takes
        // the widget away, and taking the readout with it meant the one press
        // that ends a walk is also the press that destroys its only account of
        // what it spent
        if (this.state === 'idle') return this.summary ? `▶ Reroll walk — last: ${this.summary}` : '▶ Reroll walk';
        return `✓ Done — ${this._summaryText()}`;
    }

    /**
     * Show the widget while the board is on screen, and take it away when the
     * player leaves the Tasks page.
     * @private
     */
    _syncWidget() {
        if (!document.querySelector(GAME.TASK_LIST)) {
            this.widget?.remove();
            this.widget = null;
            // The board is gone: the last walk's readout has nowhere to be read
            // and no longer describes what is on screen
            this.summary = '';
            return;
        }
        // The shield popup's cap can move while the walk sits armed, and the
        // step on the label was decided under the old one. Re-planning here
        // rather than only in `_render` is what makes an edit land on the very
        // next label instead of after a reload; `_render` is called from
        // `_replan`, so the check belongs on this side of it.
        if (this.state === 'ready' && this._capSignature() !== this.planCap) {
            this._replan();
            return;
        }
        // A board redraw can retire the armed step — the menu it wanted closed
        // closes, the task it priced rerolls, the card unmounts. Re-plan the
        // moment the step stops matching what is on screen, so the chip never
        // goes on asking for a press the board has already outgrown.
        if (this.state === 'ready' && this.step?.card) {
            const stale =
                !document.contains(this.step.card) ||
                cardTaskKey(this.step.card) !== this.step.signature ||
                !this._buttonFor(this.step);
            if (stale) {
                this._replan();
                return;
            }
        }
        this._render();
    }

    /**
     * The ceiling a plan is drawn under, as one comparable string.
     * @returns {string}
     * @private
     */
    _capSignature() {
        const { coinThreshold, cowbellThreshold } = this._blockThresholds();
        return `${coinThreshold}/${cowbellThreshold}`;
    }

    /**
     * Build the widget if it is wanted and not already up.
     * @returns {Object|null} The widget, or null when it is hidden
     * @private
     */
    _ensureWidget() {
        if (this.hidden) {
            this._removeWidget();
            return null;
        }
        if (this.widget && document.body.contains(this.widget.element)) return this.widget;

        const widget = createFloatingWidget({
            id: CHIP_ID,
            top: '110px',
            right: '24px',
            accent: config.COLOR_ACCENT || '#8ecfff',
            positionKey: PANEL_POSITION_KEY,
            position: this.panelPosition,
            zIndex: CHIP_Z_INDEX,
            mainClass: 'mwi-task-reroll-walk-advance',
            closeClass: 'mwi-task-reroll-walk-stop',
        });
        widget.main.addEventListener('click', () => this._onMainClick());
        widget.extras.appendChild(this._buildSortButton());
        widget.close.title = 'Hide the walk. A run in progress stops here, and the board is left exactly as it is.';
        widget.close.addEventListener('click', () => this.stop());
        // After the shell's own toggle, so the drawer is rebuilt with whatever
        // the shield popup's thresholds say the moment it is opened
        widget.gear.addEventListener('click', () => this._renderSettings());

        document.body.appendChild(widget.element);
        this.widget = widget;
        this._renderSettings();
        return widget;
    }

    /**
     * The widget's Sort control.
     *
     * One press, one sort, and nothing else: it runs the same forced pass the
     * board's own Sort Tasks button runs, with no walk state touched and no
     * timer set. It is deliberately not automation — the walk sorts by itself
     * only after a Read, and a board that shuffles between rerolls is the thing
     * the sorter's module header refuses to do. What it is for is the middle of
     * a walk, where a card has just been rerolled into something that belongs
     * somewhere else and the player wants to see it there.
     *
     * It sits beside the main button in every state, the ✓ Done summary
     * included, because a finished walk is exactly when a board wants tidying.
     *
     * @returns {HTMLElement} The button
     * @private
     */
    _buildSortButton() {
        const button = document.createElement('button');
        button.className = 'mwi-task-reroll-walk-sort';
        button.textContent = '↕ Sort';
        button.title =
            'Sort the board now, the same way the Sort Tasks button does. One press, one sort — nothing is ' +
            'automated and the walk is not disturbed.';
        button.style.cssText =
            'border:0; border-radius:5px; background:rgba(255,255,255,0.08); color:#e0e0e0; font-size:11px; ' +
            'line-height:1; padding:3px 6px; cursor:pointer; font-family:inherit; white-space:nowrap;';
        button.addEventListener('mousedown', (event) => event.stopPropagation());
        button.addEventListener('pointerdown', (event) => event.stopPropagation());
        button.addEventListener('click', () => {
            try {
                taskSorter.sortTasks(true);
            } catch (error) {
                console.error('[TaskRerollWalk] Sorting from the widget failed:', error);
            }
            // A sort moves cards between slots, and the armed step names a
            // slot. Re-reading the board here re-binds the label to the card
            // that is actually there, rather than leaving the next press to
            // abort with "Slot N is not the card it was".
            if (this.state === 'ready') this._replan();
        });
        return button;
    }

    /** @private */
    _onMainClick() {
        if (this.state === 'ready') {
            this.advance();
            return;
        }
        if (this.state === 'waiting') return;
        // A click handler cannot await; the walk's own state is what the press
        // after this one reads, and a failed read leaves the thresholds as they
        // were rather than stopping the walk
        this.start().catch((error) => console.error('[TaskRerollWalk] Starting the walk failed:', error));
    }

    /**
     * The walk's own settings, plus the two numbers it obeys but does not own.
     * @private
     */
    _renderSettings() {
        const widget = this.widget;
        if (!widget || !widget.settingsOpen) return;

        const cap = this._liveCapBlock();
        widget.settings.replaceChildren();
        widget.settings.append(
            widgetDivider(),
            widgetNote('The walk rerolls a task until the shield popup would block the next reroll.'),
            widgetReadOnlyRow({
                label: 'Block rerolls at',
                value: cap.enabled
                    ? `${coinLabel(cap.coin)} / ${cowbellLabel(cap.cowbell)}`
                    : 'off — nothing is blocked on price',
                hint: 'Edited in the 🛡 task-protection popup, not here.',
                title: cap.enabled
                    ? 'A reroll costing this much or more is blocked, exactly as the shield popup blocks it.'
                    : 'Cap protection is switched off in the shield popup, so the walk blocks nothing on ' +
                      `price either. Its numbers, for when it is switched back on: ${coinLabel(cap.coin)} / ` +
                      `${cowbellLabel(cap.cowbell)}.`,
            }),
            widgetSelectRow({
                key: 'tasks_rerollWalkCurrency',
                fallback: 'auto',
                label: 'Pay with',
                options: [
                    { value: 'auto', label: 'cheapest' },
                    { value: 'cowbell', label: 'cowbells' },
                    { value: 'coin', label: 'coins' },
                ],
                title:
                    'Cheapest compares the two prices in coins, valuing a cowbell through the Bag of 10 Cowbells. ' +
                    'A free reroll is always taken first.',
                onChange: () => {
                    if (this.state === 'ready') this._replan();
                },
            }),
            widgetCheckboxRow({
                key: 'tasks_rerollWalkTrashAtLimit',
                label: 'Discard a task once both reroll options are blocked',
                title: 'Offer the red trash can rather than leaving the task on the board. Off: the walk moves past it.',
                onChange: () => {
                    if (this.state === 'ready') this._replan();
                },
            })
        );
    }

    /** @private */
    _render() {
        // The highlight follows the armed manual step and nothing else — it is
        // how the player knows which press the label is asking for
        const manualButton =
            this.state === 'ready' && this.step?.manual && document.contains(this.step.card)
                ? this._buttonFor(this.step)
                : null;
        this._highlightButton(manualButton);

        const widget = this._ensureWidget();
        if (!widget) return;

        // Idempotent on purpose: a DOM write here is a mutation, and this is
        // called from a mutation watcher
        const label = this.chipLabel();
        if (widget.main.textContent !== label) widget.main.textContent = label;
        const disabled = this.state === 'waiting';
        if (widget.main.disabled !== disabled) widget.main.disabled = disabled;
        const color =
            this.state === 'waiting' ? '#999' : this.state === 'stopped' ? '#ffb74d' : config.COLOR_ACCENT || '#8ecfff';
        if (widget.main.style.color !== color) widget.main.style.color = color;
        const title =
            this.state === 'ready'
                ? this.step?.manual
                    ? 'The game only accepts this press straight from you — press the highlighted button on the card. This chip scrolls it into view.'
                    : 'One press, one game action. Nothing else happens until you press again.'
                : this.state === 'idle'
                  ? 'Start at the top of the board. Every press does one thing, then says what the next would do.'
                  : 'Press to walk the board again from the top.';
        if (widget.main.title !== title) widget.main.title = title;
    }

    /** @private */
    _removeWidget() {
        this.widget?.remove();
        this.widget = null;
        document.getElementById(CHIP_ID)?.remove();
    }

    /** Take the walk's control and widget off the page and stop listening. */
    cleanup() {
        noteTeardown(this);
        this.stop();
        this.timerRegistry.clearAll();
        this.sortTimerRegistry.clearAll();
        for (const unregister of this.unregisterHandlers) {
            try {
                unregister();
            } catch (error) {
                console.error('[TaskRerollWalk] Cleanup failed:', error);
            }
        }
        this.unregisterHandlers = [];
        this.boardWatcher = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        this.state = 'idle';
        this.step = null;
        this.index = 0;
        this.hidden = false;
        this.summary = '';
        this.isInitialized = false;
    }

    /** Same as cleanup; the feature registry calls one or the other. */
    disable() {
        this.cleanup();
    }
}

const taskRerollWalk = new TaskRerollWalk();

export default {
    name: 'Task Reroll Walk',
    initialize: async () => {
        await taskRerollWalk.initialize();
    },
    cleanup: () => {
        taskRerollWalk.disable();
    },
    disable: () => {
        try {
            taskRerollWalk.disable();
        } catch (error) {
            console.error('[Task Reroll Walk] Disable failed part-way:', error);
        } finally {
            taskRerollWalk.isInitialized = false;
        }
    },
    /** The walk itself, for tests and for anything that wants to drive it */
    walk: taskRerollWalk,
};
