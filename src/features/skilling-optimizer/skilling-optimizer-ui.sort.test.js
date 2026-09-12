/** @vitest-environment happy-dom */
/**
 * Coverage for the Equipment Progression sort control.
 *
 * Rows used to render in a fixed slot order, so a two-year-payback item looked exactly as
 * prominent as a genuinely good upgrade. The sort ranks each slot by the same first-beats-
 * baseline upgrade the row itself displays; "Best Value" follows the skill's own optimization
 * goal (XP/hr bought per gold for XP skills, payback for Gold-goal gathering skills).
 *
 * The engine is mocked (as in skilling-optimizer-ui.character-switch.test.js) so each slot's
 * cost is stated as data, letting the ordering be checked by hand.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => ({ costs: {} }));

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#22c55e', COLOR_INFO: '#38bdf8', COLOR_PROFIT: '#22c55e', getSetting: () => true },
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => () => {},
}));
vi.mock('./skilling-optimizer-engine.js', () => ({
    calculateSkillPerformance: () => null,
    getSkillActionsForDisplay: () => [],
    getItemsForSlot: () => [],
    getSkillDrinkItems: () => [],
    getPlayerSkillLevel: () => 50,
    optimizeSkill: () => null,
    findOptimalTeas: () => null,
    calculateSlotUpgradeCost: (itemHrid) => engine.costs[itemHrid] ?? null,
    SKILL_NAMES: ['Woodcutting'],
    SKILLING_LOCATIONS: [],
    SLOT_DISPLAY_NAMES: {},
    SKILL_TOOL_LOCATION: {},
}));
vi.mock('../../utils/tea-optimizer.js', () => ({
    scoreEquipmentSetup: () => 0,
}));
vi.mock('../../utils/house-roi.js', () => ({
    // The House Rooms board is its own module with its own tests; these files are about the
    // equipment list, and the real board would reach for a house and an action queue they
    // do not stand up.
    rankHouseRoomUpgrades: () => ({ rows: [], excluded: [], skills: [], offBoardRooms: 0 }),
    compareHouseRoiRows: () => 0,
}));
vi.mock('../../utils/loadout-scraper.js', () => ({
    buildEnhancementLevelMap: () => new Map(),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [] },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => null,
    dataManager: null,
}));

const { skillingSimulatorUI: ui } = await import('./skilling-optimizer-ui.js');

const XP_BASELINE = 1000;
const GOLD_BASELINE = 1000;

/**
 * One slot whose single breakpoint recommends `itemName` for the stated gains.
 * @param {string} itemName
 * @param {number} xpGain
 * @param {number} goldGain
 * @returns {[string, Object]} [locationHrid, slotData] pair, as optimizeSkill() returns them
 */
function slot(itemName, xpGain, goldGain) {
    return [
        `/item_locations/${itemName}`,
        {
            name: itemName,
            candidateCount: 1,
            progression: [
                {
                    breakpoint: 0,
                    enhancementLevel: 0,
                    itemHrid: `/items/${itemName}`,
                    itemName,
                    score: XP_BASELINE + xpGain,
                    xpScore: XP_BASELINE + xpGain,
                    goldScore: GOLD_BASELINE + goldGain,
                    isChange: true,
                },
            ],
        },
    ];
}

/**
 * Render a result and read back the order the slot rows came out in.
 * @param {Array} slotPairs
 * @param {string} goal
 * @returns {Array<string>} Slot names, in rendered order
 */
function renderedOrder(slotPairs, goal) {
    const container = document.createElement('div');
    ui._renderOptimizerResults(
        container,
        {
            skill: 'Woodcutting',
            playerLevel: 50,
            goal,
            xpBaseline: XP_BASELINE,
            goldBaseline: GOLD_BASELINE,
            slots: Object.fromEntries(slotPairs),
            goldHasMissingPrices: false,
        },
        null,
        null
    );
    return [...container.querySelectorAll('div')]
        .map((el) => el.textContent)
        .filter((text) => slotPairs.some(([, data]) => text.startsWith(data.name)))
        .map((text) => slotPairs.find(([, data]) => text.startsWith(data.name))[1].name)
        .filter((name, index, all) => all.indexOf(name) === index);
}

// cheap: small cost, small gain. rich: big cost, big gain. dud: big cost, tiny gain.
const SLOTS = [slot('cheap', 100, 100), slot('rich', 1000, 1000), slot('dud', 10, 10)];

beforeEach(() => {
    engine.costs = {
        '/items/cheap': 1_000_000,
        '/items/rich': 5_000_000,
        '/items/dud': 9_000_000,
    };
    ui.optimizerSortMode = 'value';
});

describe('Equipment Progression sort control', () => {
    test('offers every sort mode, defaulting to Best Value', () => {
        const container = document.createElement('div');
        const control = ui._makeSortControl(container, { goal: 'xp' }, null, null);
        const select = control.querySelector('select');
        expect([...select.options].map((o) => o.value)).toEqual([
            'value',
            'payback',
            'cost',
            'xpGain',
            'goldGain',
            'slot',
        ]);
        expect(select.value).toBe('value');
    });

    test('Best Value on an XP-goal skill ranks by XP bought per gold', () => {
        // cheap buys 100 XP/hr for 1M; rich 200 per 1M; dud ~1.1 per 1M
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Best Value on a Gold-goal skill ranks by payback instead', () => {
        // payback hours: cheap 10K, rich 5K, dud 900K
        expect(renderedOrder(SLOTS, 'gold')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Payback sorts fastest first regardless of the skill goal', () => {
        ui.optimizerSortMode = 'payback';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Cost sorts cheapest first', () => {
        ui.optimizerSortMode = 'cost';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['cheap', 'rich', 'dud']);
    });

    test('XP Gain % sorts the largest percentage gain first', () => {
        ui.optimizerSortMode = 'xpGain';
        expect(renderedOrder(SLOTS, 'gold')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Gold Gain % sorts the largest percentage gain first', () => {
        ui.optimizerSortMode = 'goldGain';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['rich', 'cheap', 'dud']);
    });

    test('Slot Order leaves the engine order untouched', () => {
        ui.optimizerSortMode = 'slot';
        expect(renderedOrder(SLOTS, 'xp')).toEqual(['cheap', 'rich', 'dud']);
    });

    test('an unpriceable slot sorts last under every cost-denominated mode', () => {
        engine.costs = { '/items/cheap': 1_000_000, '/items/rich': 5_000_000 }; // dud unpriced
        for (const mode of ['value', 'payback', 'cost']) {
            ui.optimizerSortMode = mode;
            expect(renderedOrder(SLOTS, 'xp').at(-1), mode).toBe('dud');
        }
    });

    test('changing the control re-renders in the new order', () => {
        const container = document.createElement('div');
        const result = {
            skill: 'Woodcutting',
            playerLevel: 50,
            goal: 'xp',
            xpBaseline: XP_BASELINE,
            goldBaseline: GOLD_BASELINE,
            slots: Object.fromEntries(SLOTS),
            goldHasMissingPrices: false,
        };
        ui._renderOptimizerResults(container, result, null, null);

        const select = container.querySelector('select');
        select.value = 'cost';
        select.dispatchEvent(new Event('change'));

        expect(container.querySelector('select').value).toBe('cost');
        expect(ui.optimizerSortMode).toBe('cost');
    });
});

describe('_sortValueFor', () => {
    const metrics = {
        entry: {},
        cost: 2_000_000,
        xpPct: 12,
        goldPct: 4,
        xpPerMillion: 500,
        paybackHours: 40,
    };

    test('a slot with nothing actionable sorts last in every mode', () => {
        const nothing = { entry: null, cost: null, xpPct: 0, goldPct: 0, xpPerMillion: null, paybackHours: null };
        for (const mode of ['value', 'payback', 'cost', 'xpGain', 'goldGain']) {
            expect(ui._sortValueFor(nothing, 'xp', mode), mode).toBe(Infinity);
        }
    });

    test('percentage modes sort descending, so their key is negated', () => {
        expect(ui._sortValueFor(metrics, 'xp', 'xpGain')).toBe(-12);
        expect(ui._sortValueFor(metrics, 'xp', 'goldGain')).toBe(-4);
    });

    test('Best Value follows the goal: XP-per-gold for xp, payback for gold', () => {
        expect(ui._sortValueFor(metrics, 'xp', 'value')).toBe(-500);
        expect(ui._sortValueFor(metrics, 'gold', 'value')).toBe(40);
    });

    test('a missing ratio sorts last rather than reading as the best possible score', () => {
        const unpriced = { ...metrics, cost: null, xpPerMillion: null, paybackHours: null };
        expect(ui._sortValueFor(unpriced, 'xp', 'value')).toBe(Infinity);
        expect(ui._sortValueFor(unpriced, 'gold', 'value')).toBe(Infinity);
        expect(ui._sortValueFor(unpriced, 'xp', 'cost')).toBe(Infinity);
        expect(ui._sortValueFor(unpriced, 'xp', 'payback')).toBe(Infinity);
    });
});
