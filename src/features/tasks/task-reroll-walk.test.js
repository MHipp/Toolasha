/**
 * @vitest-environment happy-dom
 *
 * The guided reroll walk, held to the one rule that matters.
 *
 * A bulk reroller is exactly the shape of thing this fork does not ship: a
 * button that, once pressed, keeps acting on the game. So the interesting
 * assertions here are not about which card gets rerolled — they are about how
 * many of the game's buttons get clicked per press of ours, which is one, and
 * about what happens when the board is not what the label promised, which is
 * that nothing gets clicked at all.
 *
 * The second thing worth pinning down is the money. The walk stops where the
 * shield popup says to stop, and between the two prices it picks the cheaper
 * one in coins — a rule that is only useful if it says out loud which it picked
 * and why.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const stored = vi.hoisted(() => ({ values: {}, transactions: [] }));
const market = vi.hoisted(() => ({ cowbellValue: 8000 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        setSetting: (key, value) => {
            settings.values[key] = value;
        },
        isFeatureEnabled: (key) => settings.values[key] ?? false,
        COLOR_ACCENT: '#0f0',
        Z_FLOATING_PANEL: 500,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            stored.transactions.push([key]);
            return stored.values[key] ?? fallback;
        },
        getMany: async (keys) => {
            // One entry however many keys it carries: that is the whole point
            // of a batched read, and what a test counting transactions sees
            stored.transactions.push([...keys]);
            return new Map(keys.map((key) => [key, stored.values[key] ?? null]));
        },
        parseJSON: (raw, _key, fallback = null) => (raw === null ? fallback : raw),
        set: async () => {},
        getJSON: async (key, _store, fallback) => {
            stored.transactions.push([key]);
            return stored.values[key] ?? fallback;
        },
        setJSON: async () => {},
        delete: async (key) => {
            delete stored.values[key];
            return true;
        },
    },
}));
// The walk reads its thresholds through readScoped, whose adopt-once migration
// asks who owns pre-scoping data. The dialog is the consent module's business;
// here the answer is just set.
const consent = vi.hoisted(() => ({ target: null, requested: 0 }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => consent.target,
    requestAdoptionConsent: async () => {
        consent.requested += 1;
        return null;
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 7, getMooPassBuffs: () => [] },
}));
// A real little registry rather than a stub: `quests_updated` is what the walk
// re-plans on, and the post-read sort was being cancelled by exactly that
// message — invisible for as long as no test could send one
const ws = vi.hoisted(() => ({ handlers: {} }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            (ws.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            ws.handlers[event] = (ws.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
// The board watcher would re-render the widget on every DOM change a test makes;
// the tests drive the walk directly instead
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('./task-profit-calculator.js', () => ({ getCowbellValue: () => market.cowbellValue }));
const sorter = vi.hoisted(() => ({ sortTasks: vi.fn() }));
vi.mock('./task-sorter.js', () => ({ default: sorter }));

const {
    default: taskRerollWalkFeature,
    verdictForCard,
    preferredRerollOption,
    nextRerollCosts,
    chooseReroll,
} = await import('./task-reroll-walk.js');
const walk = taskRerollWalkFeature.walk;
// The shield popup's own module: the walk reads its live cap from here, so an
// edit made while a walk is armed lands on the next plan
const { default: taskRerollProtection } = await import('./task-reroll-protection.js');

/** Deliver a websocket message to whatever the walk registered for it */
const emit = (event) => {
    for (const handler of ws.handlers[event] || []) handler({});
};

const MILKING = '/actions/milking/cow';
const KEEPER = '/actions/brewing/coffee';

/** Every click the game's buttons receive, in order */
let clicks = [];

/**
 * Wire a button so pressing it is recorded.
 * @param {HTMLElement} button - The game button
 * @param {string} name - The card's task name
 * @param {string} label - The button's own label
 */
function record(button, name, label) {
    button.addEventListener('click', () => clicks.push(`${name}:${label || 'trash'}`));
}

/**
 * Put a board on the page.
 * @param {Array<{name: string, buttons: Array<string>, quest: Object|null}>} specs - One per card
 * @returns {HTMLElement} The task list
 */
function board(specs) {
    document.body.replaceChildren();
    clicks = [];

    const panel = document.createElement('div');
    panel.className = 'TasksPanel_tasksPanel__abc';
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__xyz';
    panel.appendChild(list);
    document.body.appendChild(panel);

    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const rootFiber = { child: null, sibling: null, return: null };
    let lastQuestFiber = null;

    for (const spec of specs) {
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';

        const content = document.createElement('div');
        content.className = 'RandomTask_content__2def';
        const name = document.createElement('div');
        name.className = 'RandomTask_name__3ghi';
        name.textContent = spec.name;
        const progress = document.createElement('div');
        progress.textContent = 'Progress: 0 / 100';
        content.append(name, progress);
        card.appendChild(content);

        const action = document.createElement('div');
        action.className = 'RandomTask_action__4jkl';
        for (const label of spec.buttons) {
            const button = document.createElement('button');
            button.textContent = label;
            record(button, spec.name, label);
            action.appendChild(button);
        }
        card.appendChild(action);
        list.appendChild(card);

        // A fiber above the card's buttons carrying its quest, the way the game
        // does — there is no other route to a card's identity
        const questFiber = { memoizedProps: { characterQuest: spec.quest }, return: null, child: null, sibling: null };
        let previous = null;
        for (const button of card.querySelectorAll('button')) {
            const fiber = { stateNode: button, return: questFiber, child: null, sibling: null };
            if (previous) previous.sibling = fiber;
            else questFiber.child = fiber;
            previous = fiber;
        }
        if (lastQuestFiber) lastQuestFiber.sibling = questFiber;
        else rootFiber.child = questFiber;
        lastQuestFiber = questFiber;
    }

    root._reactRootContainer = { current: rootFiber };
    return list;
}

/**
 * Put the game's "You have N unread tasks" notice at the top of the board.
 * @param {HTMLElement} list - The task list
 * @returns {HTMLElement} The notice
 */
function unreadNotice(list) {
    const notice = document.createElement('div');
    notice.className = 'TasksPanel_unreadTasks__sVdle';
    const button = document.createElement('button');
    button.textContent = 'Read';
    record(button, 'Notice', 'Read');
    notice.appendChild(button);
    list.prepend(notice);
    return notice;
}

/** A resting card's buttons: Go, Reroll and the icon-only trash can */
const AT_REST = ['Go', 'Reroll', ''];
/** The reroll chooser */
const CHOOSER = ['Back', 'MooPass Free Reroll (2)'];

/** Quests carry a unique id, and the walk's chooser-price memory keys on it */
let questSeq = 0;

/** A quest for a card, with however many rerolls have been spent on it */
const quest = (actionHrid, coinSpent = 0, cowbellSpent = 0) => ({
    id: ++questSeq,
    actionHrid,
    coinRerollCount: coinSpent,
    cowbellRerollCount: cowbellSpent,
});

/** Let the walk's own awaits settle — storage is mocked, so these are microtasks */
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** What the widget currently offers */
const chipText = () => document.querySelector('.mwi-task-reroll-walk-advance')?.textContent || '';

/**
 * The player presses a game button the walk asked for.
 *
 * The game only accepts spending presses from a real user gesture, so the walk
 * never clicks these itself — it highlights the button and listens. A test
 * click can't be `isTrusted`, so the press is recorded through the button (as
 * any real press would be) and the listener's bookkeeping is invoked directly.
 *
 * @param {HTMLElement} list - The task list
 * @param {number} slot - 1-based card position
 * @param {string} label - The button to press
 */
function userPress(list, slot, label) {
    const card = list.children[slot - 1];
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent === label);
    button.click();
    walk._manualPressed();
}

/**
 * Swap a card's action row for a different step of the flow.
 * @param {HTMLElement} list - The task list
 * @param {number} slot - 1-based card position
 * @param {Array<string>} labels - The new buttons
 */
function setButtons(list, slot, labels) {
    const card = list.children[slot - 1];
    const name = card.querySelector('[class*="RandomTask_name"]').textContent;
    const action = card.querySelector('[class*="RandomTask_action"]');
    action.replaceChildren(
        ...labels.map((label) => {
            const button = document.createElement('button');
            button.textContent = label;
            record(button, name, label);
            return button;
        })
    );
    // The fiber tree is rebuilt with the buttons, exactly as React does it
    const root = document.getElementById('root');
    const questFiber = [...list.children].reduce((found, element, index) => {
        if (index !== slot - 1) return found;
        let fiber = root._reactRootContainer.current.child;
        for (let i = 0; i < index; i++) fiber = fiber.sibling;
        return fiber;
    }, null);
    let previous = null;
    questFiber.child = null;
    for (const button of action.querySelectorAll('button')) {
        const fiber = { stateNode: button, return: questFiber, child: null, sibling: null };
        if (previous) previous.sibling = fiber;
        else questFiber.child = fiber;
        previous = fiber;
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    settings.values = {
        tasks_rerollWalk: true,
        tasks_rerollWalkCurrency: 'auto',
        tasks_rerollWalkTrashAtLimit: true,
    };
    // Cap protection on, which is what makes the thresholds below mean anything
    stored.values = { taskCapProtection_7: true };
    stored.transactions = [];
    consent.target = null;
    consent.requested = 0;
    market.cowbellValue = 8000;
    walk.protectedHrids = new Set();
    walk.state = 'idle';
    walk.step = null;
    walk.index = 0;
    walk.hidden = false;
    walk.widget = null;
    // The shield popup's defaults: nothing is blocked until the price ladder caps
    walk.coinThreshold = 320000;
    walk.cowbellThreshold = 32;
    walk.capProtectionEnabled = true;
    walk.awaitingReadSort = false;
    walk.planCap = '';
    // The shield popup's module is the live source; left uninitialised it says
    // nothing and the walk falls back to its own stored copy above
    taskRerollProtection.protection.isInitialized = false;
    taskRerollProtection.protection.protectedHrids = new Set();
    taskRerollProtection.protection.capProtectionEnabled = true;
    taskRerollProtection.protection.coinThreshold = 320000;
    taskRerollProtection.protection.cowbellThreshold = 32;
    ws.handlers = {};
    // The walk is a singleton, and the spend readout now outlives one walk
    walk.tally = { kept: 0, rerolled: 0, trashed: 0, goldSpent: 0, cowbellsSpent: 0 };
    walk.summary = '';
    walk.paidFor = null;
    walk.pendingBill = null;
    walk.chooserQuotes.clear();
    document.body.replaceChildren();
});

afterEach(() => {
    walk.stop();
    vi.useRealTimers();
});

describe('what the next reroll costs', () => {
    test('the ladder doubles per currency and caps where the game caps it', () => {
        expect(nextRerollCosts(quest(MILKING, 0, 0))).toEqual({ coin: 10000, cowbell: 1 });
        expect(nextRerollCosts(quest(MILKING, 2, 3))).toEqual({ coin: 40000, cowbell: 8 });
        expect(nextRerollCosts(quest(MILKING, 9, 9))).toEqual({ coin: 320000, cowbell: 32 });
    });

    test('a card with no readable quest has no price', () => {
        expect(nextRerollCosts(null)).toBe(null);
    });
});

describe('which reroll gets bought', () => {
    const base = { coinThreshold: 320000, cowbellThreshold: 32, cowbellValue: 8000, preference: 'auto' };

    test('a free reroll beats both prices', () => {
        expect(chooseReroll({ ...base, coin: 10000, cowbell: 1, free: true }).currency).toBe('free');
    });

    test('cowbells win when they are worth less in coins, and the label says so', () => {
        const choice = chooseReroll({ ...base, coin: 20000, cowbell: 2 });
        expect(choice.currency).toBe('cowbell');
        expect(choice.costLabel).toBe('2🔔');
        expect(choice.why).toBe('≈16.0K, cheaper than 20.0K🪙');
    });

    test('coins win when the cowbells are dearer', () => {
        const choice = chooseReroll({ ...base, coin: 10000, cowbell: 2 });
        expect(choice.currency).toBe('coin');
        expect(choice.why).toContain('cheaper than 2🔔');
    });

    test('one currency over its threshold leaves the other', () => {
        expect(chooseReroll({ ...base, coin: 20000, cowbell: 2, cowbellThreshold: 2 })).toMatchObject({
            currency: 'coin',
            why: 'cowbells blocked',
        });
        expect(chooseReroll({ ...base, coin: 20000, cowbell: 2, coinThreshold: 20000 })).toMatchObject({
            currency: 'cowbell',
            why: 'coins blocked',
        });
    });

    test('both over their thresholds is blocked, whatever they cost', () => {
        const choice = chooseReroll({ ...base, coin: 320000, cowbell: 32 });
        expect(choice.currency).toBe(null);
        expect(choice.why).toBe('both reroll options blocked');
        expect(choice.atCap).toBe(true);
    });

    test('a currency with no price at all is unknown, not over its threshold', () => {
        // The screenshot: 10K spent, so the next coin reroll is 20K against an
        // 80K cap, and the 1🔔 cap blocks every cowbell reroll there will ever
        // be. An unpriced coin option used to read exactly like a blocked one,
        // and the pair of them said "both reroll options blocked" — which is
        // the sentence that discards the task.
        const choice = chooseReroll({ ...base, coin: null, cowbell: 1, coinThreshold: 80000, cowbellThreshold: 1 });
        expect(choice.atCap).toBe(false);
        expect(choice.why).not.toBe('both reroll options blocked');
    });

    test('a currency the open chooser is not offering is paid in the other, and said so', () => {
        const choice = chooseReroll({ ...base, coin: 20000, cowbell: 1, coinOffered: false });
        expect(choice.currency).toBe('cowbell');
        expect(choice.why).toBe('coins not on offer');
    });

    test('an unoffered currency beside a capped one is nobody being at cap', () => {
        const choice = chooseReroll({
            ...base,
            coin: 20000,
            cowbell: 1,
            coinThreshold: 80000,
            cowbellThreshold: 1,
            coinOffered: false,
        });
        expect(choice.currency).toBe(null);
        expect(choice.atCap).toBe(false);
    });

    test('a preference overrides the arithmetic, but not a block', () => {
        expect(chooseReroll({ ...base, coin: 10000, cowbell: 2, preference: 'cowbell' })).toMatchObject({
            currency: 'cowbell',
            why: 'preferred',
        });
        expect(chooseReroll({ ...base, coin: 20000, cowbell: 2, preference: 'coin' })).toMatchObject({
            currency: 'coin',
            why: 'preferred',
        });
        // Asking for cowbells when cowbells are blocked still pays coins
        expect(
            chooseReroll({ ...base, coin: 20000, cowbell: 32, cowbellThreshold: 32, preference: 'cowbell' }).currency
        ).toBe('coin');
    });
});

describe('what the walk decides about one card', () => {
    const choice = { currency: 'cowbell', costLabel: '2🔔', why: 'preferred' };
    const base = { completed: false, isProtected: false, choice, trashAtLimit: true };

    test('a task the player asked to keep is left alone', () => {
        expect(verdictForCard({ ...base, isProtected: true }).action).toBe('skip');
    });

    test('a task waiting to be claimed is never rerolled out from under the reward', () => {
        expect(verdictForCard({ ...base, completed: true }).action).toBe('skip');
    });

    test('a task with an affordable reroll is rerolled, and the reason is the price', () => {
        const verdict = verdictForCard(base);
        expect(verdict.action).toBe('reroll');
        expect(verdict.reason).toBe('2🔔 (preferred)');
    });

    test('a blocked task is discarded, or skipped when that is off', () => {
        const blocked = { currency: null, costLabel: '', why: 'both reroll options blocked', atCap: true };
        expect(verdictForCard({ ...base, choice: blocked }).action).toBe('trash');
        expect(verdictForCard({ ...base, choice: blocked, trashAtLimit: false }).action).toBe('skip');
    });

    test('a task with nothing to press, but nothing proven over the cap, is never discarded', () => {
        // Discarding is for prices the player capped. A reroll the walk merely
        // cannot see a button for is not a price, and a task destroyed over one
        // is a task destroyed on a reading that was never made.
        const unoffered = { currency: null, costLabel: '', why: 'no reroll on offer', atCap: false };
        expect(verdictForCard({ ...base, choice: unoffered }).action).toBe('skip');
        // ...and it is a wait, not a fact about the task: the plan retries it
        // rather than sending the player to close the menu
        expect(verdictForCard({ ...base, choice: unoffered }).retryable).toBe(true);
    });

    test('a skip the walk is sure of is not retried', () => {
        const blocked = { currency: null, costLabel: '', why: 'both reroll options blocked', atCap: true };
        expect(verdictForCard({ ...base, completed: true }).retryable).toBeFalsy();
        expect(verdictForCard({ ...base, isProtected: true }).retryable).toBeFalsy();
        expect(verdictForCard({ ...base, choice: null }).retryable).toBeFalsy();
        expect(verdictForCard({ ...base, choice: blocked, trashAtLimit: false }).retryable).toBeFalsy();
    });

    test('a card whose price cannot be read is left alone rather than guessed at', () => {
        expect(verdictForCard({ ...base, choice: null }).action).toBe('skip');
    });
});

describe('which reroll option gets pressed', () => {
    const option = (kind, available = true) => ({ kind, available, cost: kind === 'coin' ? 10000 : 1 });

    test('free before paid', () => {
        expect(preferredRerollOption([option('coin'), option('free')]).kind).toBe('free');
    });

    test('the currency the plan priced is the button pressed', () => {
        expect(preferredRerollOption([option('coin'), option('cowbell')], 'coin').kind).toBe('coin');
        expect(preferredRerollOption([option('coin'), option('cowbell')], 'cowbell').kind).toBe('cowbell');
    });

    test('with no currency named it falls back to cowbells before coins', () => {
        expect(preferredRerollOption([option('coin'), option('cowbell')]).kind).toBe('cowbell');
    });

    test('a spent free reroll is not pressed', () => {
        expect(preferredRerollOption([option('free', false), option('coin')], 'coin').kind).toBe('coin');
    });

    test('nothing on offer is nothing pressed', () => {
        expect(preferredRerollOption([option('free', false)])).toBe(null);
    });
});

describe('planning a walk down the board', () => {
    test('it opens on the first card that needs something, priced', async () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
        ]);

        await walk.start();

        // First reroll: 10K coins against one cowbell worth ~8K
        expect(chipText()).toContain('Reroll #2 — 1🔔');
        expect(clicks).toEqual([]);
    });

    test('coins are chosen, and named, when the cowbell is the dearer of the two', async () => {
        market.cowbellValue = 30000;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        await walk.start();

        expect(chipText()).toContain('Reroll #1 — 10.0K🪙');
        expect(chipText()).toContain('cheaper than 1🔔');
    });

    test('a board of nothing but protected tasks finishes without a click', async () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
        ]);

        await walk.start();

        expect(chipText()).toBe('✓ Done — 2 kept, 0 rerolled, 0 trashed');
        expect(clicks).toEqual([]);
    });

    test('a threshold edited in the shield popup is in force for the very first plan', async () => {
        // The walk reads the thresholds at start-up and again when a walk
        // starts, to catch an edit made in the shield popup since. Planning
        // before that read has come back plans against the old numbers, and the
        // first card — the one the player is looking at while they change the
        // setting — is exactly the one that gets it wrong.
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        walk.coinThreshold = 320000;
        walk.cowbellThreshold = 32;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toBe('▶ Trash #1 (both reroll options blocked)');
    });

    test('stopping while the thresholds are still being read leaves the walk stopped', async () => {
        // `start()` became async when the threshold read was awaited, which put
        // an await between the click that starts a walk and the plan that walk
        // draws. Stop pressed inside that window used to be undone: the resumed
        // start went on to `_replan()`, which set `ready` and drew the widget
        // again, so the walk the player had just cancelled was sitting there
        // armed and the next press of it clicked a game button.
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        const starting = walk.start();
        walk.stop();
        await starting;

        expect(walk.state).toBe('idle');
        expect(walk.step).toBe(null);
        expect(document.querySelector('.mwi-task-reroll-walk-advance')).toBe(null);
    });

    test('with cap protection switched off the walk stops obeying its numbers', async () => {
        // The two thresholds belong to the shield popup's cap-protection block,
        // and that block has an on/off switch of its own. A walk that reads the
        // numbers but not the switch keeps refusing rerolls the popup itself
        // would wave through the moment the feature is turned off.
        stored.values.taskCapProtection_7 = false;
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toContain('Reroll #1');
        expect(chipText()).not.toContain('blocked');
    });

    test('a task both of whose rerolls are blocked is offered for discard', async () => {
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toBe('▶ Trash #1 (both reroll options blocked)');
    });

    test('with discard-at-limit off a blocked task is passed over instead', async () => {
        settings.values.tasks_rerollWalkTrashAtLimit = false;
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toContain('1 kept');
    });

    test('a task blocked in one currency still rerolls with the other', async () => {
        stored.values.taskCapCowbellThreshold_7 = 1;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        await walk.start();

        expect(chipText()).toContain('Reroll #1 — 10.0K🪙 (cowbells blocked)');
    });

    test('a chooser refusing one currency pays the other rather than giving up on the card', async () => {
        // While the chooser is open its own buttons are the only prices that can
        // actually be paid. Falling back to the game's price ladder for a
        // currency the chooser is *refusing* — the player cannot afford it, so
        // the game greys the button out — prices a button that does not exist to
        // press: the plan names coins, `preferredRerollOption` finds no pressable
        // coin option, and the walk waits it out and then stops on a board it
        // could have kept walking with cowbells.
        market.cowbellValue = 30000; // so coins would win on price alone
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000', '2'], quest: quest(MILKING) }]);
        [...list.querySelectorAll('button')].find((b) => b.textContent === '10,000').disabled = true;

        await walk.start();
        vi.advanceTimersByTime(5000);

        expect(chipText()).toContain('Reroll #1 — 2🔔');
        expect(clicks).toEqual([]);
    });

    test('a card whose own chooser priced it over the cap is never reopened', async () => {
        // The ladder is a prediction and the chooser is the truth. When the
        // ladder says affordable but the open chooser quoted a price over the
        // cap, the walk closes the menu — and must then remember what it read,
        // or the next plan trusts the ladder again and reopens the same menu:
        // close, reopen, close, forever.
        settings.values.tasks_rerollWalkTrashAtLimit = false;
        stored.values.taskCapCoinThreshold_7 = 20000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        taskRerollProtection.protection.isInitialized = true;
        taskRerollProtection.protection.coinThreshold = 20000;
        taskRerollProtection.protection.cowbellThreshold = 1;
        // The ladder predicts 10K for a never-rerolled task; the chooser knows better
        const list = board([
            { name: 'Milking - Cow', buttons: ['Back', 'Pay 40,000'], quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);

        await walk.start();
        expect(chipText()).toContain('Close the menu on #1');

        walk.advance();
        setButtons(list, 1, AT_REST);
        vi.advanceTimersByTime(500);

        // The remembered quote keeps #1 shut; the walk is on to the next card
        expect(chipText()).toContain('#2');
        expect(chipText()).not.toContain('#1');
    });

    test("one card's over-cap chooser cannot condemn another card carrying the same task", async () => {
        // Two cards holding the same task with the same goal are one signature,
        // and a memory keyed on the signature let the first card's over-cap
        // chooser prices stand in for the second card's untouched 10K reroll —
        // the walk offered to trash tasks it had never priced. The memory keys
        // on the quest id now, which each slot owns alone.
        settings.values.tasks_rerollWalkTrashAtLimit = false;
        taskRerollProtection.protection.isInitialized = true;
        taskRerollProtection.protection.coinThreshold = 20000;
        taskRerollProtection.protection.cowbellThreshold = 1;
        const list = board([
            { name: 'Defeat - Stabby', buttons: ['Back', 'Pay 40,000'], quest: quest(MILKING, 2, 0) },
            { name: 'Defeat - Stabby', buttons: AT_REST, quest: quest(MILKING) },
        ]);

        await walk.start();
        expect(chipText()).toContain('Close the menu on #1');

        walk.advance();
        setButtons(list, 1, AT_REST);
        vi.advanceTimersByTime(500);

        // #1 stays shut on its own remembered prices; #2 is judged on its own
        // untouched ladder, not its twin's chooser
        expect(chipText()).toContain('Reroll #2 — 10.0K🪙');
    });

    test('a card the chooser priced in one currency only is waited out, not trashed or retired', async () => {
        // The reported walk, exactly: 10.0K spent on card #1, so the next coin
        // reroll is 20K under an 80K cap, and the 1🔔 cap blocks every cowbell
        // reroll. The chooser was showing its coin option unpressable — which is
        // what it looks like for the moment after a payment — and the walk read
        // "no coin price" as "coins are over the cap", called the pair of them
        // blocked, remembered that quote, and offered to discard a task it could
        // have rerolled for 20K. Not trashing it was half the fix: the other
        // half is that a refusal this brief is not a card to retire either, and
        // "close the reroll list" is what the player was asked for instead.
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '20,000', '1'], quest: quest(MILKING, 1, 0) }]);
        const coinButton = [...list.querySelectorAll('button')].find((b) => b.textContent === '20,000');
        coinButton.disabled = true;

        await walk.start();
        expect(chipText()).not.toContain('Trash');
        expect(chipText()).not.toContain('Close the menu');

        // The game answers, the button comes back, and the walk pays the price
        // it could see all along
        coinButton.disabled = false;
        vi.advanceTimersByTime(500);

        expect(chipText()).toContain('Reroll #1 — 20.0K🪙');
        expect(chipText()).not.toContain('Trash');
        expect(clicks).toEqual([]);
    });

    test('a chooser that stays refused is given up on eventually, with its reason', async () => {
        // The wait above cannot become a wedge: a chooser that never comes back
        // is tidied away the way it always was, and the card is kept.
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '20,000', '1'], quest: quest(MILKING, 1, 0) }]);
        [...list.querySelectorAll('button')].find((b) => b.textContent === '20,000').disabled = true;

        await walk.start();
        vi.advanceTimersByTime(5000);

        expect(chipText()).toContain('Close the menu on #1 (no reroll on offer)');
    });

    test("a card given up on does not spend the next card's wait budget", async () => {
        // The retry budget used to be spent only on the card the walk was
        // parked on — an exhausted one stopped the walk there. The skip-path
        // retry made it travel: card #1's chooser never comes back, the walk
        // gives up on it and moves on with nothing left, and card #2's
        // momentary refusal — the very thing the retry exists to wait out —
        // was retired on sight instead.
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([
            { name: 'Milking - Cow', buttons: ['Back', '20,000', '1'], quest: quest(MILKING, 1, 0) },
            {
                name: 'Cooking - Stew',
                buttons: ['Back', '20,000', '1'],
                quest: quest('/actions/cooking/stew', 1, 0),
            },
        ]);
        const refused = [...list.querySelectorAll('button')].filter((button) => button.textContent === '20,000');
        refused[0].disabled = true;
        refused[1].disabled = true;

        await walk.start();
        vi.advanceTimersByTime(5000);
        expect(chipText()).toContain('Close the menu on #1 (no reroll on offer)');

        // The Back press lands, #1's chooser closes over a task that has since
        // completed, and the walk keeps it and moves to #2 — whose chooser is
        // refusing for the moment, exactly as #1's was on the first plan
        walk.advance();
        setButtons(list, 1, ['Go', 'Claim']);
        vi.advanceTimersByTime(500);

        expect(chipText()).not.toContain('Close the menu on #2');

        // and #2's button coming back is paid, not retired
        refused[1].disabled = false;
        vi.advanceTimersByTime(500);
        expect(chipText()).toContain('Reroll #2 — 20.0K🪙');
    });

    test('a card that has already paid one 10K reroll rerolls again under an 80K cap', async () => {
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 1, 0) }]);

        await walk.start();

        expect(chipText()).toContain('Reroll #1 — 20.0K🪙 (cowbells blocked)');
    });

    test('an empty board says so rather than offering a press', async () => {
        board([]);

        await walk.start();

        expect(chipText()).toContain('No tasks on the board');
    });
});

describe('the unread notice is read first', () => {
    test('unread tasks are read before anything is rerolled, one press each', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        expect(chipText()).toBe('▶ Read unread tasks');
        expect(clicks).toEqual([]);

        walk.advance();
        expect(clicks).toEqual(['Notice:Read']);

        // The game reveals the tasks and the notice goes away; the walk resumes
        notice.remove();
        vi.advanceTimersByTime(3000);
        expect(chipText()).toContain('Reroll #1');

        // A notice reappearing mid-walk is not pressed again — indexes must stay put
        unreadNotice(list);
        walk.advance();
        expect(clicks).toEqual(['Notice:Read', 'Milking - Cow:Reroll']);
    });

    test('a board that is nothing but the notice still starts, reads, and finishes', async () => {
        const list = board([]);
        const notice = unreadNotice(list);

        await walk.start();
        expect(chipText()).toBe('▶ Read unread tasks');

        walk.advance();
        expect(clicks).toEqual(['Notice:Read']);
        notice.remove();
        vi.advanceTimersByTime(3000);
        expect(chipText()).toContain('✓ Done');
    });

    test('reading respects the auto-sort setting: sort runs after the press, before the next plan', async () => {
        settings.values.taskSorter_autoSort = true;
        sorter.sortTasks.mockClear();
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        expect(sorter.sortTasks).not.toHaveBeenCalled(); // not before the board settles

        notice.remove();
        vi.advanceTimersByTime(3000);
        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
        expect(chipText()).toContain('Reroll #1');
    });

    test('with both sort settings off, reading never sorts', async () => {
        settings.values.taskSorter_autoSort = false;
        settings.values.taskSorter_sortAfterRead = false;
        sorter.sortTasks.mockClear();
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).not.toHaveBeenCalled();
    });

    test('sort-after-read is honoured, being the setting written for exactly this moment', async () => {
        // The walk's Read press goes through the React handler, so the sorter's
        // own document-level Read delegate never sees a click and never fires.
        // The walk's compensating sort is the only thing left — and it was
        // asking taskSorter_autoSort, which is the *panel opening* setting.
        // A player with "Sort tasks after reading new ones" on and auto-sort off
        // got no sort at all.
        settings.values.taskSorter_autoSort = false;
        settings.values.taskSorter_sortAfterRead = true;
        sorter.sortTasks.mockClear();
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
    });

    test('the post-read sort is forced, so a chooser left open elsewhere cannot swallow it', async () => {
        // An unforced sortTasks() returns without touching the board whenever
        // any card is mid-flow (task-sorter.js `boardHasConfirmingCard`), and a
        // reroll chooser left open is the walk's ordinary resting state: the
        // game keeps the chooser open after a reroll, and the walk only presses
        // Back on cards it is skipping. So the sort the walk asked for after
        // reading was silently dropped on exactly the boards the walk produces.
        settings.values.taskSorter_autoSort = true;
        sorter.sortTasks.mockClear();
        const list = board([
            { name: 'Milking - Cow', buttons: CHOOSER, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).toHaveBeenCalledWith(true);
    });

    test('a notice a press did not clear is offered again, a bounded few times', async () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const list = document.querySelector('[class*="TasksPanel_taskList"]');
        unreadNotice(list);

        await walk.start();

        // The notice stays: the click did not reach the game. Three presses, then on.
        for (let press = 1; press <= 3; press++) {
            expect(chipText()).toBe('▶ Read unread tasks');
            walk.advance();
            vi.advanceTimersByTime(3000);
        }
        expect(clicks).toEqual(['Notice:Read', 'Notice:Read', 'Notice:Read']);
        expect(chipText()).toContain('Reroll #1');
    });

    test('a notice already read elsewhere is walked past without a click', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        expect(chipText()).toBe('▶ Read unread tasks');

        // Someone pressed the game's own Read before the walk's press
        notice.remove();
        walk.advance();
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('Reroll #1');
    });
});

describe('one press, one game click', () => {
    test('opening the chooser is its own press, and paying is the next', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();
        expect(chipText()).toContain('open the menu');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Reroll']);

        // The game opens the chooser; the walk re-reads and offers the payment
        setButtons(list, 1, CHOOSER);
        vi.advanceTimersByTime(200);
        expect(chipText()).toBe('▶ Reroll #1 — free');

        // Nothing pressed itself while that was worked out, however long is left
        vi.advanceTimersByTime(10000);
        expect(clicks).toEqual(['Milking - Cow:Reroll']);

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Reroll', 'Milking - Cow:MooPass Free Reroll (2)']);
        expect(walk.state).toBe('waiting');
    });

    test('a reroll the game has not answered is never offered for payment a second time', async () => {
        // The board looking exactly as it did before the payment is the one
        // thing that proves the reroll has NOT landed yet: a reroll changes the
        // task. Offering the same card's Pay button again on that evidence
        // charges a second reroll while quoting the first one's price — and the
        // price the player is actually charged is the doubled one, which here is
        // over the threshold they set.
        //
        // This is reachable well inside the server settle window, because any
        // `quests_updated` at all (a combat kill ticking a task's progress will
        // do) cuts the wait to UI_SETTLE_MS.
        stored.values.taskCapCoinThreshold_7 = 20000; // the 10K reroll is allowed; the 20K it becomes is not
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) }]);

        await walk.start();
        expect(chipText()).toContain('Reroll #1 — 10.0K🪙');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:10,000']);

        // The game has not answered: same task, same chooser, same reroll count.
        // The walk waits it out — never pressing Pay again on its own — and,
        // once it has waited too long for the press to have counted, hands the
        // card to the player: their real press always counts. A press that
        // moved nothing cost nothing, and stopping the walk helped nobody.
        vi.advanceTimersByTime(10000);

        expect(clicks).toEqual(['Milking - Cow:10,000']);
        expect(chipText()).not.toContain('walk stopped');
        expect(chipText()).toContain("Press #1's highlighted 10.0K🪙");
        expect(walk.tally.goldSpent).toBe(0);

        // The chip clicks nothing on the manual fallback; the player's press
        // does the paying
        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:10,000']);
        userPress(list, 1, '10,000');
        expect(clicks).toEqual(['Milking - Cow:10,000', 'Milking - Cow:10,000']);
        expect(walk.state).toBe('waiting');
    });

    test('a card React remounted mid-payment neither bills the press nor offers Pay again', async () => {
        // A remount redraws the same quest slot into a fresh node with the
        // server having said nothing. Tracking the payment by node identity
        // read the old node's absence as the answer: the press was billed as a
        // reroll that never landed, and the Pay button was offered again at its
        // stale pre-payment price.
        const q = quest(MILKING);
        board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: q }]);

        await walk.start();
        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:10,000']);

        // Same task, same quest, same prices — brand-new nodes
        board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: q }]);
        vi.advanceTimersByTime(10000);

        expect(walk.tally.goldSpent).toBe(0);
        expect(walk.tally.rerolled).toBe(0);
        // The unanswered press goes to the player; it is never re-pressed
        expect(clicks).toEqual([]);
        expect(chipText()).toContain("Press #1's highlighted 10.0K🪙");
    });

    test('once the reroll does land the walk carries on from the task that arrived', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) }]);

        await walk.start();
        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:10,000']);

        // The reroll lands: a new task, and the game has taken its coin
        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';
        setButtons(list, 1, ['Back', '20,000']);
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest('/actions/cooking/stew', 1, 0);
        vi.advanceTimersByTime(3000);

        expect(chipText()).toContain('Reroll #1 — 20.0K🪙');
        expect(walk.state).toBe('ready');
        // And only now, with the answer on the board, is the payment billed
        expect(walk.tally.goldSpent).toBe(10000);
        expect(walk.tally.rerolled).toBe(1);
    });

    test('trashing takes two presses too, and the second is the confirm', async () => {
        stored.values.taskCapCoinThreshold_7 = 10000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:trash']);

        setButtons(list, 1, ['Confirm Discard']);
        vi.advanceTimersByTime(200);
        expect(chipText()).toBe('▶ Confirm discard #1');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:trash', 'Milking - Cow:Confirm Discard']);
        // Counted only once the card actually goes — a confirm the game
        // refuses removes nothing
        expect(walk.tally.trashed).toBe(0);
        list.replaceChildren();
        vi.advanceTimersByTime(3000);
        expect(walk.tally.trashed).toBe(1);
    });

    test('a discard confirm the game never answered goes to the player, counted once', async () => {
        // The pay press has this fallback already; the confirm did not, so a
        // build refusing the walk's synthetic confirm looped forever — one
        // phantom discard added to the tally per press.
        stored.values.taskCapCoinThreshold_7 = 10000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([{ name: 'Milking - Cow', buttons: ['Confirm Discard'], quest: quest(MILKING) }]);
        await walk.start();
        expect(chipText()).toContain('Confirm discard #1');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Confirm Discard']);

        // The card never moves: the press was refused. Nothing was trashed,
        // and the card's next confirm is asked of the player.
        vi.advanceTimersByTime(10000);
        expect(walk.tally.trashed).toBe(0);
        expect(clicks).toEqual(['Milking - Cow:Confirm Discard']);
        expect(chipText()).toContain('Press Confirm on #1 to discard');

        userPress(list, 1, 'Confirm Discard');
        list.replaceChildren();
        vi.advanceTimersByTime(3000);
        expect(walk.tally.trashed).toBe(1);
    });

    test('a chooser left open on a card being passed over is closed, one press', async () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([{ name: 'Brewing - Coffee', buttons: CHOOSER, quest: quest(KEEPER) }]);

        await walk.start();
        expect(chipText()).toBe('▶ Close the menu on #1 (protected)');

        walk.advance();
        expect(clicks).toEqual(['Brewing - Coffee:Back']);
    });

    test('a press with nothing on offer does nothing', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
    });

    test('the walk re-evaluates the task the reroll actually landed on', async () => {
        // The point of doing this one press at a time: what arrives may be
        // something the player is keeping, and the walk has to notice
        walk.protectedHrids = new Set([KEEPER]);
        const list = board([{ name: 'Milking - Cow', buttons: CHOOSER, quest: quest(MILKING) }]);
        await walk.start();
        walk.advance();
        expect(clicks).toHaveLength(1);
        expect(list).toBeTruthy();

        // The reroll lands on a protected task, chooser still open
        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Brewing - Coffee';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest(KEEPER);
        vi.advanceTimersByTime(3000);

        expect(chipText()).toBe('▶ Close the menu on #1 (protected)');
    });
});

describe('a discarded slot is done with, not walked again', () => {
    /**
     * The game's answer to a discard: the slot keeps its place and a brand new
     * task drops into it, reroll counts back to zero.
     * @param {HTMLElement} list - The task list
     * @param {number} slot - 1-based card position
     * @param {string} name - The arriving task's name
     */
    function refill(list, slot, name) {
        list.children[slot - 1].querySelector('[class*="RandomTask_name"]').textContent = name;
        let questFiber = document.getElementById('root')._reactRootContainer.current.child;
        for (let i = 0; i < slot - 1; i++) questFiber = questFiber.sibling;
        questFiber.memoizedProps.characterQuest = quest(MILKING);
        setButtons(list, slot, AT_REST);
    }

    test('the task that drops into the discarded slot is not walked as if it were the card', async () => {
        // The treadmill: with the index left on the discarded slot, the walk
        // planned the replacement's fresh 10K/1 ladder, rerolled it to the cap,
        // discarded it, and went round again — for as long as the player kept
        // pressing, never reaching card #2.
        stored.values.taskCapCoinThreshold_7 = 10000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        await walk.start();

        walk.advance();
        setButtons(list, 1, ['Confirm Discard']);
        vi.advanceTimersByTime(200);
        walk.advance();

        refill(list, 1, 'Tanning - Hide');
        vi.advanceTimersByTime(3000);

        expect(walk.tally.trashed).toBe(1);
        expect(chipText()).toContain('#2');
        expect(chipText()).not.toContain('#1');
    });

    test('the running spend stops at the task that was discarded', async () => {
        // The chip's total against the card's own "Reroll spend" line: with the
        // slot walked again the two could not agree, because the chip was
        // carrying tasks that had been discarded out of that slot.
        stored.values.taskCapCoinThreshold_7 = 20000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) }]);
        await walk.start();

        walk.advance();
        // The reroll lands: the chooser stays open, quoting the doubled price
        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Brewing - Coffee';
        document.getElementById('root')._reactRootContainer.current.child.memoizedProps.characterQuest = quest(
            MILKING,
            1,
            0
        );
        setButtons(list, 1, ['Back', '20,000']);
        vi.advanceTimersByTime(3000);
        expect(walk.tally.goldSpent).toBe(10000);

        // 20.0K is the cap now, so the task is closed up, trashed and confirmed
        walk.advance();
        setButtons(list, 1, AT_REST);
        vi.advanceTimersByTime(200);
        walk.advance();
        setButtons(list, 1, ['Confirm Discard']);
        vi.advanceTimersByTime(200);
        walk.advance();

        refill(list, 1, 'Tanning - Hide');
        vi.advanceTimersByTime(3000);

        expect(clicks.filter((click) => click.endsWith(':10,000'))).toHaveLength(1);
        expect(walk.tally.goldSpent).toBe(10000);
        expect(chipText()).toBe('✓ Done — 0 kept, 1 rerolled, 1 trashed · spent 10.0K🪙');
    });

    test('a board that got shorter instead still judges the card that moved up', async () => {
        // The other answer to a discard: the card is removed and everything
        // below it moves up a place, so the index is already on the next card
        stored.values.taskCapCoinThreshold_7 = 10000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        await walk.start();

        walk.advance();
        setButtons(list, 1, ['Confirm Discard']);
        vi.advanceTimersByTime(200);
        walk.advance();

        list.children[0].remove();
        vi.advanceTimersByTime(3000);

        expect(walk.tally.trashed).toBe(1);
        expect(chipText()).toContain('Trash #1');
        walk.advance();
        expect(clicks).toContain('Cooking - Stew:trash');
    });
});

describe('the walk replans rather than clicking the wrong thing', () => {
    test('a card that is no longer in its slot is planned again, not clicked', async () => {
        const list = board([
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        await walk.start();

        // The board is re-ordered under the plan — the sorter, a completed task
        list.prepend(list.children[1]);

        // The press clicks nothing; the walk reads the board again and carries
        // on from what is actually there. Combat ticks redraw the board many
        // times a minute, and stopping for each of those made every walk a
        // string of restarts.
        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(walk.state).toBe('ready');
        expect(chipText()).not.toContain('walk stopped');
    });

    test('a task that changed under the plan is planned again, not clicked', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(walk.state).toBe('ready');
        expect(chipText()).toContain('Reroll #1');
    });

    test('a button that has gone means no click, and another look', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        list.children[0].querySelector('[class*="RandomTask_action"]').replaceChildren();

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
    });

    test('the close button leaves the board exactly as it is', async () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        document.querySelector('.mwi-task-reroll-walk-stop').click();

        expect(document.getElementById('mwi-task-reroll-walk-chip')).toBe(null);
        expect(clicks).toEqual([]);
    });
});

describe('what the walk spent', () => {
    /**
     * Pay once on a one-card board and let the reroll land as a protected task,
     * so the walk finishes with exactly one payment behind it.
     * @param {Array<string>} buttons - The chooser's buttons
     */
    async function payOnce(buttons) {
        walk.protectedHrids = new Set([KEEPER]);
        const list = board([{ name: 'Milking - Cow', buttons, quest: quest(MILKING) }]);

        await walk.start();
        walk.advance();

        // The reroll lands, and what arrived is a task the player keeps
        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Brewing - Coffee';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest(KEEPER, 1, 0);
        vi.advanceTimersByTime(3000);

        // The game leaves the chooser open after a reroll; closing it on a card
        // being skipped is the walk's own last press
        walk.advance();
        setButtons(list, 1, AT_REST);
        vi.advanceTimersByTime(200);
    }

    test('a coin payment is billed at the price the chooser quoted, and rides the label', async () => {
        const list = board([
            { name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);

        await walk.start();
        walk.advance();

        // Nothing is billed until the board proves the server took the payment —
        // a press the shield ate, or the game refused, moved no money
        expect(walk.tally.goldSpent).toBe(0);
        expect(list).toBeTruthy();

        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Brewing - Coffee';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest(MILKING, 1, 0);
        vi.advanceTimersByTime(3000);

        expect(walk.tally.goldSpent).toBe(10000);
        expect(walk.tally.cowbellsSpent).toBe(0);
        expect(chipText()).toContain('spent 10.0K🪙');
    });

    test('cowbells are counted in cowbells, not folded into the coin total', async () => {
        settings.values.tasks_rerollWalkCurrency = 'cowbell';
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000', '2'], quest: quest(MILKING) }]);

        await walk.start();
        walk.advance();
        expect(list).toBeTruthy();

        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Brewing - Coffee';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest(MILKING, 0, 1);
        vi.advanceTimersByTime(3000);

        expect(walk.tally.goldSpent).toBe(0);
        expect(walk.tally.cowbellsSpent).toBe(2);
        expect(chipText()).toContain('spent 2🔔');
    });

    test('a free reroll costs nothing and is reported as costing nothing', async () => {
        await payOnce(CHOOSER);

        expect(walk.tally.rerolled).toBe(1);
        expect(walk.tally.goldSpent).toBe(0);
        expect(chipText()).toBe('✓ Done — 1 kept, 1 rerolled, 0 trashed');
    });

    test('the Done summary says what the walk spent as well as what it did', async () => {
        await payOnce(['Back', '10,000']);

        expect(chipText()).toBe('✓ Done — 1 kept, 1 rerolled, 0 trashed · spent 10.0K🪙');
    });

    test('hiding the widget no longer destroys the summary of the walk that just ended', async () => {
        await payOnce(['Back', '10,000']);
        const done = chipText();

        document.querySelector('.mwi-task-reroll-walk-stop').click();
        expect(document.getElementById('mwi-task-reroll-walk-chip')).toBe(null);
        walk.toggleWidget();

        expect(chipText()).toBe('▶ Reroll walk — last: 1 kept, 1 rerolled, 0 trashed · spent 10.0K🪙');
        expect(done).toContain('spent 10.0K🪙');
    });

    test('the next walk replaces the last one, and leaving the board clears it', async () => {
        await payOnce(['Back', '10,000']);
        walk.stop();
        walk.toggleWidget();
        expect(chipText()).toContain('last:');

        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();
        expect(chipText()).not.toContain('last:');
        expect(walk.tally.goldSpent).toBe(0);

        // And the board going away takes the readout with it
        walk.stop();
        document.body.replaceChildren();
        walk._syncWidget();
        expect(walk.summary).toBe('');
    });

    test('a walk that stopped early still accounts for what it spent', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) }]);

        await walk.start();
        walk.advance();
        // The board moves under the plan: the card is gone
        list.replaceChildren();
        vi.advanceTimersByTime(3000);
        walk.advance();

        expect(chipText()).toContain('spent 10.0K🪙');
        expect(walk.summary).toContain('spent 10.0K🪙');
    });
});

describe('the floating walk widget', () => {
    test('it offers to start before anything has been walked', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        walk._render();

        expect(chipText()).toBe('▶ Reroll walk');
        expect(clicks).toEqual([]);
    });

    test('the chip sits below the game modal layer so a profile opened over it wins', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        const chip = document.getElementById('mwi-task-reroll-walk-chip');
        // The game's own modals run z 200-1000; the chip must be under them.
        expect(Number(chip.style.zIndex)).toBeLessThan(200);
    });

    test('the main button becomes the next action once a walk is running', async () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-advance').click();
        // A click handler cannot await the thresholds read; the label arrives
        // with the first plan, a few microtasks later
        await flush();

        expect(chipText()).toContain('Reroll #1 —');
        // Starting a walk is not a game action; the first press only plans
        expect(clicks).toEqual([]);
    });

    test('the header 🎲 shows the widget again after it was closed', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-stop').click();
        expect(document.getElementById('mwi-task-reroll-walk-chip')).toBe(null);

        walk.toggleWidget();
        expect(document.getElementById('mwi-task-reroll-walk-chip')).not.toBe(null);
    });

    test('the gear says so when cap protection is off, rather than quoting dead numbers', () => {
        walk.capProtectionEnabled = false;
        walk.coinThreshold = 80000;
        walk.cowbellThreshold = 8;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-chip-gear').click();
        const drawer = document.querySelector('.mwi-task-reroll-walk-chip-settings');
        expect(drawer.textContent).toContain('off — nothing is blocked on price');
        expect(drawer.textContent).not.toContain('80.0K🪙 / 8🔔');
    });

    test('the gear shows the thresholds it obeys and binds its own settings', () => {
        walk.coinThreshold = 80000;
        walk.cowbellThreshold = 8;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-chip-gear').click();
        const drawer = document.querySelector('.mwi-task-reroll-walk-chip-settings');
        expect(drawer.textContent).toContain('80.0K🪙 / 8🔔');
        expect(drawer.textContent).toContain('task-protection popup');

        const box = drawer.querySelector('.mwi-widget-setting-tasks_rerollWalkTrashAtLimit');
        expect(box.checked).toBe(true);
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        expect(settings.values.tasks_rerollWalkTrashAtLimit).toBe(false);

        const pick = drawer.querySelector('.mwi-widget-setting-tasks_rerollWalkCurrency');
        pick.value = 'coin';
        pick.dispatchEvent(new Event('change'));
        expect(settings.values.tasks_rerollWalkCurrency).toBe('coin');
    });
});

describe('the control only exists when it is turned on', () => {
    test('with the setting off nothing is injected and nothing listens', async () => {
        settings.values.tasks_rerollWalk = false;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.isInitialized).toBe(false);
        taskRerollWalkFeature.cleanup();
    });

    test('with it on the panel gets the walk button, once', async () => {
        walk.isInitialized = false;
        await taskRerollWalkFeature.initialize();

        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        const parent = document.createElement('div');
        parent.appendChild(header);
        document.body.appendChild(parent);

        walk._injectButton(header);
        walk._injectButton(header);

        expect(parent.querySelectorAll('.mwi-task-reroll-walk-btn')).toHaveLength(1);
        taskRerollWalkFeature.cleanup();
    });

    test('the thresholds come from the keys the shield popup writes', async () => {
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(40000);
        expect(walk.cowbellThreshold).toBe(4);
        taskRerollWalkFeature.cleanup();
    });

    test('the cap switch comes from the same popup, and defaults to off', async () => {
        delete stored.values.taskCapProtection_7;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.capProtectionEnabled).toBe(false);
        taskRerollWalkFeature.cleanup();

        stored.values.taskCapProtection_7 = true;
        walk.isInitialized = false;
        await taskRerollWalkFeature.initialize();

        expect(walk.capProtectionEnabled).toBe(true);
        taskRerollWalkFeature.cleanup();
    });

    test('an alt does not inherit the pre-scoping thresholds, which stay for the main', async () => {
        consent.target = 'someoneElse';
        stored.values.taskCapCoinThreshold = 40000;
        stored.values.taskCapCowbellThreshold = 4;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(320000);
        expect(walk.cowbellThreshold).toBe(32);
        // Untouched: they belong to whoever the user said owns them
        expect(stored.values.taskCapCoinThreshold).toBe(40000);
        expect(stored.values.taskCapCowbellThreshold).toBe(4);
        taskRerollWalkFeature.cleanup();
    });

    test('the chosen character adopts the pre-scoping thresholds and the bare keys go', async () => {
        consent.target = 7;
        stored.values.taskCapCoinThreshold = 40000;
        stored.values.taskCapCowbellThreshold = 4;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(40000);
        expect(walk.cowbellThreshold).toBe(4);
        expect('taskCapCoinThreshold' in stored.values).toBe(false);
        expect('taskCapCowbellThreshold' in stored.values).toBe(false);
        taskRerollWalkFeature.cleanup();
    });

    test('a scoped threshold wins over a leftover bare one', async () => {
        consent.target = 7;
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCoinThreshold = 40000;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(80000);
        expect(stored.values.taskCapCoinThreshold).toBe(40000);
        taskRerollWalkFeature.cleanup();
    });
});

describe('the cap the walk obeys is the cap as it stands now', () => {
    // The regression the maintainer photographed: a chooser open on card #1
    // quoting a live "Pay 1" and "Pay 40000", and the chip reading
    // "▶ Close the menu on #1 · spent 30.0K". Nothing in the plan can produce a
    // "Close the menu" step except `verdictForCard` returning `skip` (or
    // `trash`), and on a rerollable card the only route to that is
    // `chooseReroll` finding BOTH currencies at or over their ceiling. So a
    // close-the-menu press between rerolls is always the walk believing a
    // ceiling that is not the one on screen — and the ceiling it believed was
    // the one read when the walk started, a cap edit ago.

    test('a cap raised while the walk is armed lands on the next plan, not after a reload', async () => {
        // Started under "block at 40K": the 20K reroll is allowed, the 40K one
        // it becomes is not, and with cowbells blocked outright the card is
        // retired with a Back press.
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        taskRerollProtection.protection.isInitialized = true;
        taskRerollProtection.protection.coinThreshold = 40000;
        taskRerollProtection.protection.cowbellThreshold = 1;
        const list = board([
            { name: 'Milking - Cow', buttons: ['Back', 'Pay 1', 'Pay 40,000'], quest: quest(MILKING, 2, 0) },
        ]);

        await walk.start();
        expect(chipText()).toBe('▶ Close the menu on #1 (both reroll options blocked)');

        // The player opens the shield popup and raises the cap. The popup's
        // select writes its module before the storage round-trip resolves.
        taskRerollProtection.protection.coinThreshold = 320000;
        // Any board mutation is what wakes the widget in production
        walk._syncWidget();

        expect(chipText()).toBe('▶ Reroll #1 — 40.0K🪙 (cowbells blocked)');
        expect(clicks).toEqual([]);
        expect(list.children).toHaveLength(1);
    });

    test('the cap block being switched off mid-walk unblocks the card too', async () => {
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        taskRerollProtection.protection.isInitialized = true;
        taskRerollProtection.protection.coinThreshold = 40000;
        taskRerollProtection.protection.cowbellThreshold = 1;
        board([{ name: 'Milking - Cow', buttons: ['Back', 'Pay 1', 'Pay 40,000'], quest: quest(MILKING, 2, 0) }]);

        await walk.start();
        expect(chipText()).toBe('▶ Close the menu on #1 (both reroll options blocked)');

        taskRerollProtection.protection.capProtectionEnabled = false;
        walk._syncWidget();

        expect(chipText()).toContain('Reroll #1');
    });

    test('the gear drawer quotes the live cap, not the one the walk started under', async () => {
        taskRerollProtection.protection.isInitialized = true;
        taskRerollProtection.protection.coinThreshold = 40000;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        walk.widget.setSettingsOpen(true);
        taskRerollProtection.protection.coinThreshold = 160000;
        walk._renderSettings();

        expect(walk.widget.settings.textContent).toContain('160.0K');
        expect(walk.widget.settings.textContent).not.toContain('40.0K');
    });

    test('a paid reroll whose chooser comes back refusing the coin button is waited out', async () => {
        // The maintainer's screenshot, end to end: card #1 "Crafting - Lumber",
        // 10.0K already spent on it this walk, an 80K/1🔔 cap, and the chooser
        // still open on its next prices — "Pay 1🔔" and "Pay 20,000🪙". The chip
        // read "▶ Close the menu on #1 · spent 10.0K🪙", so the walk was asking
        // for a Back press on a card it had every reason to reroll for 20K. The
        // one thing the screenshot could not show is that the coin button was
        // not pressable for that moment — which is exactly how the chooser looks
        // while the game answers the payment just made through it. Every cycle
        // cost a Back and a Reroll press, which is why the player kept being
        // asked to close the same list.
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        taskRerollProtection.protection.isInitialized = true;
        taskRerollProtection.protection.coinThreshold = 80000;
        taskRerollProtection.protection.cowbellThreshold = 1;
        const lumber = quest('/actions/crafting/lumber', 0, 0);
        const list = board([{ name: 'Crafting - Lumber', buttons: ['Back', 'Pay 1', 'Pay 10,000'], quest: lumber }]);

        await walk.start();
        expect(chipText()).toContain('Reroll #1 — 10.0K🪙 (cowbells blocked)');
        walk.advance();
        expect(clicks).toEqual(['Crafting - Lumber:Pay 10,000']);

        // The game answers: the coin count moves, the chooser redraws its new
        // prices, and its coin button is refused for the moment
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = { ...lumber, coinRerollCount: 1 };
        setButtons(list, 1, ['Back', 'Pay 1', 'Pay 20,000']);
        const coinButton = [...list.querySelectorAll('button')].find((b) => b.textContent === 'Pay 20,000');
        coinButton.disabled = true;
        emit('quests_updated');
        // Past the walk's own server-settle wait, so the plan this asserts on is
        // one drawn from the answered board rather than the pre-payment one
        vi.advanceTimersByTime(3000);

        expect(chipText()).not.toContain('Close the menu');

        // The button comes back and the next press is the next payment
        coinButton.disabled = false;
        vi.advanceTimersByTime(3000);

        expect(walk.tally.goldSpent).toBe(10000);
        expect(chipText()).toContain('Reroll #1 — 20.0K🪙 (cowbells blocked)');
        expect(clicks).toEqual(['Crafting - Lumber:Pay 10,000']);
    });

    test('a reroll that lands with the chooser still open is offered the next payment', async () => {
        // The invariant the close-the-menu step was violating: paid, answered,
        // chooser still open on the card with its new prices — the next press
        // is the next payment, not a tidy-up.
        const list = board([
            { name: 'Milking - Cow', buttons: ['Back', 'Pay 1', 'Pay 20,000'], quest: quest(MILKING, 1, 0) },
        ]);
        await walk.start();
        walk.advance();
        expect(clicks).toHaveLength(1);
        expect(list).toBeTruthy();

        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest('/actions/cooking/stew', 1, 1);
        setButtons(list, 1, ['Back', 'Pay 2', 'Pay 20,000']);
        vi.advanceTimersByTime(3000);

        expect(chipText()).toContain('Reroll #1');
        expect(chipText()).not.toContain('Close the menu');
    });
});

describe('the protected list the walk obeys is the list as it stands now', () => {
    test('a task protected in the shield popup mid-walk is skipped on the next plan', async () => {
        // The walk's own copy of the list is read from storage once at
        // start-up; the popup writes its module's set the instant a row is
        // clicked. A walk reading only its copy rerolled tasks the player had
        // protected minutes earlier.
        taskRerollProtection.protection.isInitialized = true;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        await walk.start();
        expect(chipText()).toContain('Reroll #1');

        taskRerollProtection.protection.protectedHrids.add(MILKING);
        walk._replan();

        expect(chipText()).toContain('✓ Done — 1 kept');
        expect(clicks).toEqual([]);
    });

    test('a task protected between the plan and the press is not pressed', async () => {
        // The walk's press goes through the game's React handler and dispatches
        // no DOM event, so the shield's capture listener cannot intercept it —
        // the press itself has to look at the list again.
        taskRerollProtection.protection.isInitialized = true;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        await walk.start();
        expect(chipText()).toContain('Reroll #1');

        // Protected after the step was armed; no board mutation wakes a replan
        taskRerollProtection.protection.protectedHrids.add(MILKING);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('✓ Done — 1 kept');
    });
});

describe('the post-read sort survives the message that proves the read landed', () => {
    test('a quests_updated during the wait does not cancel the forced sort', async () => {
        // The walk re-plans on `quests_updated` while it is waiting, and
        // `_replanSoon` clears the timer registry first. The post-read sort was
        // on that registry, and reading tasks is precisely what makes the game
        // send `quests_updated` — so the sort was cancelled every time, on
        // every board, and only tests (whose websocket hook sent nothing) ever
        // saw it run.
        settings.values.taskSorter_sortAfterRead = true;
        sorter.sortTasks.mockClear();
        walk.isInitialized = false;
        await walk.initialize();

        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        expect(clicks).toEqual(['Notice:Read']);

        // The game answers the read
        notice.remove();
        emit('quests_updated');
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).toHaveBeenCalledWith(true);
        expect(chipText()).toContain('Reroll #1');
    });

    test('nothing is planned until that sort has happened', async () => {
        settings.values.taskSorter_sortAfterRead = true;
        sorter.sortTasks.mockClear();
        walk.isInitialized = false;
        await walk.initialize();

        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();

        // The websocket re-plan fires long before the sort would
        emit('quests_updated');
        vi.advanceTimersByTime(200);
        expect(walk.state).toBe('waiting');
        expect(sorter.sortTasks).not.toHaveBeenCalled();

        vi.advanceTimersByTime(3000);
        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
        expect(walk.state).toBe('ready');
    });
});

describe('the widget sorts on demand', () => {
    /** @returns {HTMLElement|null} The widget's Sort control */
    const sortButton = () => document.querySelector('.mwi-task-reroll-walk-sort');

    test('one press runs the same forced sort the Sort Tasks button runs', async () => {
        sorter.sortTasks.mockClear();
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        expect(sortButton()).toBeTruthy();
        sortButton().click();

        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
        expect(sorter.sortTasks).toHaveBeenCalledWith(true);
    });

    test('one press is one sort — nothing is scheduled and no game button is clicked', async () => {
        sorter.sortTasks.mockClear();
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        sortButton().click();
        vi.advanceTimersByTime(30000);

        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
        expect(clicks).toEqual([]);
    });

    test('the ✓ Done summary carries it too', async () => {
        sorter.sortTasks.mockClear();
        // A board of one protected task walks straight to done
        walk.protectedHrids = new Set([MILKING]);
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        expect(chipText()).toContain('✓ Done');
        expect(sortButton()).toBeTruthy();
        sortButton().click();
        expect(sorter.sortTasks).toHaveBeenCalledWith(true);
    });
});

// ---------------------------------------------------------------------------
// What start-up costs
// ---------------------------------------------------------------------------

/**
 * Start-up runs a dozen features' initializers at once, and every extra
 * IndexedDB transaction one of them opens queues behind all of theirs. The
 * walk used to open five: the protected list, the widget's position, and one
 * scoped read per cap record.
 */
describe('what start-up costs the settings store', () => {
    test('the walk reads its whole stored state in one transaction', async () => {
        stored.values = {
            taskProtectedHrids_7: [MILKING],
            taskRerollWalkPanelPosition: { x: 10, y: 20 },
            taskCapProtection_7: true,
            taskCapCoinThreshold_7: 40000,
            taskCapCowbellThreshold_7: 8,
        };
        walk.isInitialized = false;
        stored.transactions = [];

        await walk.initialize();

        expect(stored.transactions).toHaveLength(1);
        expect(stored.transactions[0]).toEqual(
            expect.arrayContaining([
                'taskProtectedHrids_7',
                'taskRerollWalkPanelPosition',
                'taskCapProtection_7',
                'taskCapCoinThreshold_7',
                'taskCapCowbellThreshold_7',
            ])
        );
    });

    test('and every value is what the un-batched reads gave', async () => {
        stored.values = {
            taskProtectedHrids_7: [MILKING],
            taskRerollWalkPanelPosition: { x: 10, y: 20 },
            taskCapProtection_7: true,
            taskCapCoinThreshold_7: 40000,
            taskCapCowbellThreshold_7: 8,
        };
        walk.isInitialized = false;

        await walk.initialize();

        expect(walk.protectedHrids).toEqual(new Set([MILKING]));
        expect(walk.panelPosition).toEqual({ x: 10, y: 20 });
        expect(walk.capProtectionEnabled).toBe(true);
        expect(walk.coinThreshold).toBe(40000);
        expect(walk.cowbellThreshold).toBe(8);
    });

    test('a character with nothing stored still gets the popup’s defaults', async () => {
        stored.values = {};
        walk.isInitialized = false;

        await walk.initialize();

        expect(walk.protectedHrids).toEqual(new Set());
        expect(walk.panelPosition).toBe(null);
        expect(walk.capProtectionEnabled).toBe(false);
        expect(walk.coinThreshold).toBe(320000);
        expect(walk.cowbellThreshold).toBe(32);
    });
});
