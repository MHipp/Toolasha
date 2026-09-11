/**
 * The build score across a character switch.
 *
 * One score is two equipment passes — combat, then skiller — and the combat one
 * awaits an enhancement worker batch that runs for seconds on a long chain.
 * Everything about the *character doing the enhancing* has to be taken once,
 * before that suspension: `getEnhancingParams()` with auto-detect on reads the
 * live loadout and enhancing level, so re-reading it for the second pass priced
 * the two halves of one score object against two different enhancers.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    clientData: null,
    settings: {},
    /** Successive answers from `getEnhancingParams`, as a switch would give them */
    paramsQueue: [],
    paramsCalls: 0,
    workerTasks: [],
    /** Called once the first worker batch is in flight, to stand in for the switch */
    onBatch: null,
}));

vi.mock('../../utils/ability-cost-calculator.js', () => ({
    explainAbilityCost: () => ({ books: 0, bookPrice: null, total: null }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateBattleHousesCost: () => ({ totalCost: 0, breakdown: [] }),
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => mocks.clientData } }));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => {
        const index = Math.min(mocks.paramsCalls, mocks.paramsQueue.length - 1);
        mocks.paramsCalls += 1;
        return mocks.paramsQueue[index];
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 0,
    getItemPrices: () => null,
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => mocks.settings[key] ?? null } }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({
    calculateEnhancementBatch: async (tasks) => {
        mocks.workerTasks.push(...tasks);
        // The switch lands here: the combat pass is suspended on the worker and
        // the skiller pass has not started reading anything yet.
        if (mocks.onBatch) {
            const fire = mocks.onBatch;
            mocks.onBatch = null;
            fire();
        }
        return tasks.map(() => null);
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: () => ({ price: 0 }),
    getRealisticBaseItemPrice: (hrid) => (hrid === '/items/philosophers_mirror' ? 1e12 : 0),
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
vi.mock('../../utils/server-gate.js', () => ({ isMarketplacePatchLive: () => true }));
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: () => ({}),
    priceGuildCreditCosts: () => ({ lines: [], total: null, unpriced: [] }),
}));

const { calculateCombatScore } = await import('./score-calculator.js');

const HELMET = '/items/a_helmet';

/** An enhancer's kit, as `getEnhancingParams` reports one. */
function kit(enhancingLevel) {
    return { enhancingLevel, toolBonus: 0, speedBonus: 0, teas: { blessed: false }, guzzlingBonus: 0 };
}

beforeEach(() => {
    mocks.settings = {};
    mocks.paramsQueue = [kit(100)];
    mocks.paramsCalls = 0;
    mocks.workerTasks = [];
    mocks.onBatch = null;
    mocks.clientData = {
        itemDetailMap: {
            // No level requirements, so it is scored by both the combat pass and
            // the skiller one — the two passes this is about
            [HELMET]: { name: 'A Helmet', itemLevel: 50, equipmentDetail: { levelRequirements: [] } },
        },
        guildBuffDetailMap: {},
    };
});

/** A profile wearing one unpriceable +2 helmet, which is what makes worker tasks. */
function profile() {
    return {
        profile: {
            wearableItemMap: { head: { itemHrid: HELMET, enhancementLevel: 2 } },
            characterHouseRoomMap: {},
        },
    };
}

describe('character switch during the enhancement worker batch', () => {
    test('both equipment passes price against the enhancer the score started with', async () => {
        // The switch: every read after the first hands back the arriving
        // character's kit, an enhancing level 99 lower than the one the combat
        // half was priced with.
        mocks.paramsQueue = [kit(100), kit(1)];
        mocks.onBatch = () => {
            /* the switch has landed; the next read would answer kit(1) */
        };

        await calculateCombatScore(profile());

        // Two passes, so two batches of tasks for the same +2 helmet
        expect(mocks.workerTasks.length).toBeGreaterThan(1);
        const levels = [...new Set(mocks.workerTasks.map((task) => task.enhancingLevel))];
        // Pre-fix this was [100, 1]: the skiller half re-read the params after
        // the combat half's await and priced against whoever had arrived.
        expect(levels).toEqual([100]);
    });

    test('the enhancing kit is read once per score, before anything suspends', async () => {
        await calculateCombatScore(profile());
        expect(mocks.paramsCalls).toBe(1);
    });
});
