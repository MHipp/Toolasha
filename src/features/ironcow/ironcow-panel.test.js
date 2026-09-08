/**
 * @vitest-environment happy-dom
 *
 * The panel's rendering, exercised rather than reasoned about.
 *
 * The arithmetic is pinned in `starfruit-loop.test.js` and the plan derivation
 * in `ironcow-plan.test.js`. What is pinned here is the dullest thing and the
 * only thing those two cannot catch: **every section draws, and none of them
 * reports a failure**. A method called and never written, a helper renamed, a
 * property read off something that stopped having it — the panel catches each
 * one per section and prints "could not be drawn" rather than blanking, so that
 * string on screen is the assertion.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const plan = vi.hoisted(() => ({ state: null, stages: [] }));
const loop = vi.hoisted(() => ({ result: null, warnings: [], pricing: null, offline: null, pending: null }));
const store = vi.hoisted(() => ({ overrides: {}, snapshot: null, written: [], collapsed: false, collapses: [] }));
const walk = vi.hoisted(() => ({ started: [], succeeds: true }));
// Mutable so the character-switch race test can move the active character
// mid-flight, the way a real switch does.
const characterId = vi.hoisted(() => ({ current: 'charA' }));

vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 9000, getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => characterId.current,
    },
}));

// Geometry and the stage ticks both live in IndexedDB, which is not what this
// file is about
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

vi.mock('./ironcow-store.js', () => ({
    loadOverrides: async () => store.overrides,
    loadSnapshot: async () => store.snapshot,
    saveSnapshot: async (value) => {
        store.snapshot = value;
    },
    loadPlanCollapsed: async () => store.collapsed,
    setPlanCollapsed: async (value) => {
        store.collapses.push(value);
        store.collapsed = value;
    },
    setOverride: async (id, ticked) => {
        store.written.push([id, ticked]);
        if (ticked) store.overrides[id] = true;
        else delete store.overrides[id];
        return store.overrides;
    },
}));

vi.mock('./ironcow-plan.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        readCharacterState: () => {
            if (plan.state instanceof Error) throw plan.state;
            return plan.state;
        },
    };
});

// Only the three entry points that read the game are stubbed. `balanceBatch`
// and the two bell conversions are the real ones — the queue helper's numbers
// are the loop module's own, not a second opinion grown inside a test.
vi.mock('./starfruit-loop.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        calculateStarfruitLoop: async () => {
            if (loop.pending) await loop.pending;
            if (loop.result instanceof Error) throw loop.result;
            return loop.result;
        },
        cowbellPricing: () => loop.pricing,
        loopWarnings: () => loop.warnings,
        offlineWindow: () => loop.offline,
    };
});

vi.mock('./ironcow-queue-walk.js', () => ({
    startQueueWalk: (costed, batch) => {
        walk.started.push(batch);
        return walk.succeeds;
    },
}));

const { ironCowFarmPanel } = await import('./ironcow-panel.js');

const text = () => ironCowFarmPanel.panel?.textContent ?? '';
const FAILED = 'could not be drawn';

/** A character part-way through the plan, as `readCharacterState` returns one */
function character(overrides = {}) {
    return {
        levels: { milking: 80, woodcutting: 80, cheesesmithing: 80, foraging: 80, alchemy: 65, crafting: 34 },
        held: new Set(['/items/necklace_of_efficiency']),
        rooms: { '/house_rooms/garden': 3, '/house_rooms/laboratory': 0 },
        coins: 10_000_000,
        queueLength: 3,
        gameMode: 'ironcow',
        alchemyTarget: 65,
        alchemyTargetAssumed: false,
        ...overrides,
    };
}

/** A costed loop, as `calculateStarfruitLoop` returns one */
function costedLoop(overrides = {}) {
    return {
        items: { starfruitName: 'Star Fruit', essenceName: 'Foraging Essence', essencePerDecompose: 5 },
        missing: [],
        basis: { gold: 'coinify', sells: false, note: 'An iron cow sells nothing.' },
        fruitPerHour: 360,
        fruitPerForageAction: 1,
        forageActionsPerHour: 360,
        decomposeBulk: 1,
        essencePerFruit: 3,
        decomposeRate: 0.6,
        coinifyRate: 0.7,
        decomposeActionsPerHour: 180,
        coinifyActionsPerHour: 180,
        coinifyBulk: 10,
        coinsPerSuccess: 15_000,
        goldInPerFruit: 3150,
        goldOutPerFruit: 375,
        netPerFruit: 2775,
        hoursPerFruit: 0.01,
        timeShare: { forage: 10 / 36, decompose: 20 / 36, coinify: 6 / 36 },
        goldPerHour: 277_500,
        goldPerDay: 6_660_000,
        alchemyFeePerHour: 37_500,
        bellPrice: 950_000,
        bellPricing: { price: 950_000, source: 'bag', loose: 1_000_000, bag: 950_000, pricingMode: 'ask' },
        bells: { perHour: 0.2921, perDay: 7.01, perWeek: 49.08 },
        pricingMode: 'hybrid',
        computedAt: Date.parse('2026-08-04T09:00:00Z'),
        ...overrides,
    };
}

beforeEach(() => {
    plan.state = character();
    loop.result = costedLoop();
    loop.warnings = [];
    loop.pricing = { price: 950_000, source: 'bag', loose: 1_000_000, bag: 950_000, pricingMode: 'ask' };
    loop.offline = { hours: 16, assumed: true };
    loop.pending = null;
    characterId.current = 'charA';
    store.overrides = {};
    store.snapshot = null;
    store.written = [];
    store.collapsed = false;
    store.collapses = [];
    walk.started = [];
    walk.succeeds = true;
});

afterEach(() => {
    // A panel remembers what it costed between openings, which is right for a
    // panel and wrong for a test
    ironCowFarmPanel.hide({ remember: false });
    ironCowFarmPanel.loop = null;
    ironCowFarmPanel.pricedAt = null;
    ironCowFarmPanel.overrides = {};
    ironCowFarmPanel.loaded = null;
    ironCowFarmPanel.busy = false;
    ironCowFarmPanel.batchHours = 16;
    ironCowFarmPanel.batchUnit = 'h';
});

describe('drawing', () => {
    test('every section draws, and none of them fails', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('Iron Bell Farming');
        expect(text()).toContain('The plan');
        expect(text()).toContain('The loop');
        expect(text()).toContain('Cowbells');
        expect(text()).toContain('Check');
        expect(text()).not.toContain(FAILED);
    });

    test('the plan is all six stages, whatever state it is in', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        expect(text()).toContain('Milking, Woodcutting, Cheesesmithing to 80');
        expect(text()).toContain('Foraging to 80');
        expect(text()).toContain('Alchemy to 65');
        expect(text()).toContain('Crafting to 34');
        expect(text()).toContain('Craft the gathering jewelry');
        expect(text()).toContain('Optional: Garden and Laboratory');
        expect(text()).toContain('The endless loop');
        expect(text()).not.toContain(FAILED);
    });

    test('the finished stages are struck through and the unfinished are not', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        const headings = [...ironCowFarmPanel.panel.querySelectorAll('span')].filter((element) =>
            /^\d\. /.test(element.textContent)
        );
        const struck = (prefix) =>
            headings.find((element) => element.textContent.startsWith(prefix))?.style.textDecoration;

        expect(struck('1. Milking')).toBe('line-through');
        // Two of the three pieces are missing, so stage 5 is not done
        expect(struck('5. Craft the gathering jewelry')).toBe('none');
    });

    test('a loop that has not been costed says so rather than showing nothing', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        expect(text()).toContain('Press Refresh to cost the loop');
        expect(text()).not.toContain(FAILED);
    });

    test('an uncostable loop names what it could not cost', async () => {
        loop.result = { items: { starfruitName: 'Star Fruit' }, missing: ['coinifying Foraging Essence'] };
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('coinifying Foraging Essence');
        expect(text()).not.toContain(FAILED);
    });

    test('a character the game data has not caught up with still draws', async () => {
        plan.state = null;
        loop.result = null;
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('Game data has not loaded yet');
        expect(text()).not.toContain(FAILED);
    });

    test('a state that throws is caught by its own section, not by the panel', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        plan.state = new Error('half-loaded');
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        // The plan cannot be drawn, but the loop figures still are
        expect(text()).toContain('277.5K');
        expect(text()).not.toContain(FAILED);
        vi.restoreAllMocks();
    });
});

describe('what it says', () => {
    test('quotes the loop in gold and in bells, and names the pricing mode', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('Gold / hour');
        expect(text()).toContain('277.5K');
        expect(text()).toContain('Bells / hour');
        expect(text()).toContain('A week of this');
        expect(text()).toContain('Pricing mode: hybrid');
    });

    test('says where the gold comes from, because that is the whole constraint', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();
        expect(text()).toContain('An iron cow sells nothing');
    });

    test('says which way of buying bells is cheaper', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();
        expect(text()).toContain('in bags of ten');

        loop.result = costedLoop({
            bellPricing: { price: 900_000, source: 'loose', loose: 900_000, bag: 950_000, pricingMode: 'ask' },
        });
        await ironCowFarmPanel.refresh();
        expect(text()).toContain('loose');
    });

    test('shows the realistic daily figure against the offline window', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();
        expect(text()).toContain('Realistic / day (16h queued)');
    });

    test('an unpriced cowbell is said, not guessed at', async () => {
        loop.result = costedLoop({ bellPrice: null, bellPricing: { price: null }, bells: null });
        loop.pricing = { price: null };
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('No market price for a cowbell yet');
        expect(text()).not.toContain(FAILED);
    });

    test('the warnings the loop raises are printed', async () => {
        loop.warnings = [
            { id: 'gold', severity: 'warn', text: 'Gold buffer is under 3,000,000.' },
            { id: 'offline', severity: 'info', text: 'Queue enough for about 16h.' },
        ];
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('Gold buffer is under 3,000,000.');
        expect(text()).toContain('Queue enough for about 16h.');
    });
});

describe('who it is for', () => {
    test('an iron cow is not told the plan is for an iron cow', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();
        expect(text()).not.toContain('The plan below is written for one');
    });

    test('anyone else is told, and told why the figures are conservative', async () => {
        plan.state = character({ gameMode: 'standard' });
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        expect(text()).toContain('This character is standard');
        expect(text()).toContain('nothing is ever sold');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the manual tick', () => {
    test('is offered only for a stage the character state could not answer', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        const tickable = [...ironCowFarmPanel.panel.querySelectorAll('button')].filter((element) =>
            ['☐', '☑'].includes(element.textContent)
        );
        // Jewelry and the rooms are both unfinished here; the four finished
        // levelling stages derived their own done and are not offered a tick
        expect(tickable).toHaveLength(2);
    });

    test('ticking one stores it and redraws', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();
        await ironCowFarmPanel.toggleStage('rooms', true);

        expect(store.written).toEqual([['rooms', true]]);
        expect(text()).not.toContain(FAILED);
    });
});

describe('lifecycle', () => {
    test('opening twice does not build a second panel', async () => {
        ironCowFarmPanel.show();
        ironCowFarmPanel.show();
        expect(document.querySelectorAll('#toolasha-ironcow-farm-panel')).toHaveLength(1);
    });

    test('closing takes it off the page', async () => {
        ironCowFarmPanel.show();
        ironCowFarmPanel.hide();
        expect(document.querySelector('#toolasha-ironcow-farm-panel')).toBeNull();
    });

    test('a costing that throws leaves the panel up and says so', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        loop.result = new Error('nope');
        await ironCowFarmPanel.refresh();

        expect(ironCowFarmPanel.panel).not.toBeNull();
        expect(text()).not.toContain(FAILED);
        expect(ironCowFarmPanel.busy).toBe(false);
        vi.restoreAllMocks();
    });

    test("a character switch to one with no snapshot of their own does not inherit the last character's costed loop", async () => {
        // Character A costs the loop; the store now holds A's snapshot.
        await ironCowFarmPanel.load();
        await ironCowFarmPanel.refresh();
        expect(ironCowFarmPanel.loop).not.toBeNull();
        expect(ironCowFarmPanel.pricedAt).not.toBeNull();

        // feature-registry tears the panel down on character_switching...
        ironCowFarmPanel.disable();
        // ...and character B, who has never pressed Refresh, has no snapshot.
        store.snapshot = null;

        // load() is feature-registry's re-initialize entry point on character_switched.
        await ironCowFarmPanel.load();

        expect(ironCowFarmPanel.loop).toBeNull();
        expect(ironCowFarmPanel.pricedAt).toBeNull();
    });

    test("a character switch mid-costing does not apply the departing character's loop to the arriving one", async () => {
        // Character B has already loaded and has no snapshot of their own.
        characterId.current = 'charB';
        await ironCowFarmPanel.load();
        expect(ironCowFarmPanel.loop).toBeNull();

        // B presses Refresh; the costing is slow and still in flight...
        let releaseCosting;
        loop.pending = new Promise((resolve) => {
            releaseCosting = resolve;
        });
        const refreshing = ironCowFarmPanel.refresh();

        // ...and the player switches to character A before it resolves.
        characterId.current = 'charA';
        releaseCosting();
        await refreshing;

        // B's panel must not be showing (or have saved under A's key) a loop
        // that was costed for a character who is no longer even logged in.
        expect(ironCowFarmPanel.loop).toBeNull();
        expect(ironCowFarmPanel.pricedAt).toBeNull();
        expect(store.snapshot).toBeNull();
    });
});

describe('percentages', () => {
    test('the time split reads as a share of the loop, not a hundred times one', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        // 10/36, 20/36, 6/36 of the loop's time — a split whose three parts sum to 100%.
        expect(text()).toContain('forage 28% · decompose 56% · coinify 17%');
    });

    test('the success rates read as rates, not as hundreds of percent', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        const titles = [...ironCowFarmPanel.panel.querySelectorAll('[title]')].map((element) => element.title);
        expect(titles.some((title) => title.includes('60.0% decompose success'))).toBe(true);
        expect(titles.some((title) => title.includes('coinified at 70.0% success'))).toBe(true);
    });
});

describe('the plan section folds away', () => {
    test('is open by default, so an upgrade changes nothing on screen', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        expect(text()).toContain('The endless loop');
        expect(text()).not.toContain(FAILED);
    });

    test('a character who shut it gets it shut, with the count still on the bar', async () => {
        store.collapsed = true;
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        expect(text()).not.toContain('The endless loop');
        // Four of the six gating stages are done for this character; the loop
        // itself is stage seven and is counted as ready, not as done.
        expect(text()).toContain('4 of 6 stages done · the loop is ready');
        expect(text()).not.toContain(FAILED);
    });

    test('shutting it stores the choice and redraws without the stages', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        const toggle = [...ironCowFarmPanel.panel.querySelectorAll('button')].find((element) =>
            element.textContent.includes('The plan')
        );
        expect(toggle).toBeTruthy();
        toggle.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(store.collapses).toEqual([true]);
        expect(text()).not.toContain('The endless loop');
        expect(text()).not.toContain(FAILED);
    });

    test('a shut plan does not take the sections after it with it', async () => {
        store.collapsed = true;
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();
        await ironCowFarmPanel.refresh();

        expect(text()).toContain('The loop');
        expect(text()).toContain('Cowbells');
        expect(text()).toContain('Check');
        expect(text()).not.toContain(FAILED);
    });
});

describe('the queue helper', () => {
    /** The helper's own inputs, in the order the card builds them */
    const boxes = () => [...ironCowFarmPanel.panel.querySelectorAll('input[type="number"]')];

    test('sizes the three counts so each leg eats what the leg before it grew', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        // 16h of this loop is 1,600 fruit: 1,600 forages, 1,600 decomposes,
        // and 480 coinifies at ten essence an action.
        expect(text()).toContain('Queue helper');
        expect(text()).toContain('1,600');
        expect(text()).toContain('480');
        expect(text()).not.toContain(FAILED);
    });

    test('the duration is pre-filled from the offline window the plan already assumes', async () => {
        loop.offline = { hours: 16, assumed: true };
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        expect(boxes()[0].value).toBe('16');
    });

    test('typing a duration moves the bell target with it', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();
        const [hours, bellTarget] = boxes();

        hours.value = '8';
        hours.dispatchEvent(new Event('input', { bubbles: true }));

        // 8h at 277.5K/h, bells at 950K each
        expect(Number(bellTarget.value)).toBe(Math.round((277_500 * 8) / 950_000));
        expect(text()).toContain('800');
    });

    test('typing a bell target moves the duration with it', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();
        const [hours, bellTarget] = boxes();

        bellTarget.value = '10';
        bellTarget.dispatchEvent(new Event('input', { bubbles: true }));

        expect(Number(hours.value)).toBeCloseTo((10 * 950_000) / 277_500, 1);
    });

    test('a preset is one press', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        const week = [...ironCowFarmPanel.panel.querySelectorAll('button')].find(
            (element) => element.textContent === '1 week'
        );
        week.click();

        expect(ironCowFarmPanel.batchHours).toBe(168);
        expect(boxes()[0].value).toBe('168');
    });

    test('with no cowbell price the bell field disables itself and says why, and the duration still works', async () => {
        loop.result = costedLoop({ bellPrice: null, bellPricing: { price: null }, bells: null });
        loop.pricing = { price: null };
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        const [hours, bellTarget] = boxes();
        expect(bellTarget.disabled).toBe(true);
        // Never a blank that reads as an empty target, nor a zero that reads as a real one
        expect(bellTarget.value).toBe('');
        expect(text()).toContain('No cowbell price yet');

        expect(hours.disabled).toBe(false);
        hours.value = '8';
        hours.dispatchEvent(new Event('input', { bubbles: true }));
        expect(text()).toContain('800');
        expect(text()).not.toContain(FAILED);
    });

    test('Walk it hands the current batch to the guided walk', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.refresh();

        const go = [...ironCowFarmPanel.panel.querySelectorAll('button')].find((element) =>
            element.textContent.startsWith('Walk it')
        );
        go.click();

        expect(walk.started).toHaveLength(1);
        expect(walk.started[0]).toMatchObject({ forageActions: 1600, decomposeActions: 1600, coinifyActions: 480 });
    });

    test('an uncosted loop offers no counts to type in', async () => {
        ironCowFarmPanel.show();
        await ironCowFarmPanel.load();

        expect(text()).toContain('Cost the loop to size a batch');
        expect(text()).not.toContain(FAILED);
    });
});
