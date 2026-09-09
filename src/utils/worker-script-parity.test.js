/**
 * The worker scripts are built by string concatenation, which no amount of
 * linting checks. Two things can go wrong and did: the source can fail to
 * parse, and the chain inside it can drift from the one on the main thread.
 *
 * Since the matrix helper is serialised in alongside the chain — replacing an
 * `importScripts` of ~600 KB of math.js per worker — both risks now apply to
 * it too, so the generated source is parsed and run here and its answers
 * compared against the main-thread calculator's.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Each manager memoises its worker pool at module scope, and a memoised pool
// builds no Blob — so a test that only wants to READ the generated source has
// to start from a fresh module registry or `captureWorkerScript` captures
// nothing. Resetting for every test makes that independent of which tests ran
// before, rather than each test having to remember.
beforeEach(() => {
    vi.resetModules();
});

/**
 * Capture the worker source a manager hands to `new Blob([...])`.
 * @param {Function} load - Imports the manager and provokes the pool creation
 * @returns {Promise<string>} The worker script text
 */
async function captureWorkerScript(load) {
    let captured = null;
    vi.stubGlobal(
        'Blob',
        class {
            constructor(parts) {
                captured = parts[0];
            }
        }
    );
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });

    // There is no real Worker here, so pool creation throws after the Blob is
    // built — which is all this needs.
    await load().catch(() => {});

    expect(captured).toBeTruthy();
    return captured;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('generated worker sources', () => {
    test('the enhancement worker parses, pulls in no CDN library, and matches the calculator', async () => {
        const { calculateEnhancementAsync } = await import('./enhancement-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateEnhancementAsync({ enhancingLevel: 100, toolBonus: 0, itemLevel: 50, targetLevel: 5 })
        );

        expect(source).not.toContain("importScripts('http");

        // Parsing and running it is the point: a template-literal mistake in
        // the serialised helper shows up here and nowhere else.
        const calculateEnhancement = new Function('self', `${source}\n; return calculateEnhancement;`)({
            postMessage: () => {},
            onmessage: null,
        });

        const params = { enhancingLevel: 100, toolBonus: 5, itemLevel: 60, targetLevel: 10, protectFrom: 5 };
        const fromWorker = calculateEnhancement(params);

        const { calculateEnhancement: mainThread } = await import('./enhancement-calculator.js');
        const fromMain = mainThread(params);

        expect(fromWorker.attempts).toBeCloseTo(fromMain.attempts, 9);
        expect(fromWorker.protectionCount).toBeCloseTo(fromMain.protectionCount, 9);
        expect(fromWorker.perActionTime).toBeCloseTo(fromMain.perActionTime, 9);

        // The game floors an action at MIN_ACTION_TIME_SECONDS. The worker's copy of the time
        // formula was a bare 12 / speedMultiplier with no floor, so a fast enough run quoted a
        // per-action time the game will not do — the drift the serialised chain exists to stop.
        const fast = { enhancingLevel: 400, toolBonus: 0, speedBonus: 0, itemLevel: 1, targetLevel: 3 };
        expect(calculateEnhancement(fast).perActionTime).toBe(3);
        expect(calculateEnhancement(fast).perActionTime).toBeCloseTo(mainThread(fast).perActionTime, 9);
    });

    test('the networth worker parses and pulls in no CDN library', async () => {
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );

        expect(source).not.toContain("importScripts('http");

        // Parses, and the serialised matrix helper is intact inside it
        const math = new Function('self', `${source}\n; return math;`)({ postMessage: () => {}, onmessage: null });
        const identity = math.identity(3);
        expect(math.inv(identity).get([2, 2])).toBe(1);
    });

    test('the networth worker values a batch from chunk-level shared context', async () => {
        // The 2026-08-29 protocol change: priceMap and the recipe index ride
        // the message once per chunk instead of once per item, and production
        // cost reads recipes[hrid] instead of scanning every action. These are
        // the fallback chains the pruning must not have changed.
        vi.resetModules(); // the manager memoises its pool, and a memoised pool builds no Blob
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );

        const messages = [];
        const self = { postMessage: (message) => messages.push(message), onmessage: null };
        new Function('self', source)(self);

        const shared = {
            priceMap: {
                '/items/iron_sword:0': 100,
                '/items/iron_sword:3': 900,
                '/items/log:0_ask': 10,
                '/items/log:0': 10,
            },
            recipes: {
                '/items/plank': { inputItems: [{ itemHrid: '/items/log', count: 2 }], upgradeItemHrid: null },
            },
            useHighEnhancementCost: false,
            minLevel: 13,
            enhancementParams: {},
        };
        const items = [
            // Priced plain stack: unit price times count
            { itemIndex: 0, item: { itemHrid: '/items/iron_sword', enhancementLevel: 0, count: 5 }, itemDetails: {} },
            // Unpriced but craftable: production cost through the recipe index,
            // with the Artisan Tea 0.9 on inputs - 2 logs x 10 x 0.9 = 18 each
            { itemIndex: 1, item: { itemHrid: '/items/plank', enhancementLevel: 0, count: 2 }, itemDetails: {} },
            // Enhanced with a market price at its level: that price wins
            { itemIndex: 2, item: { itemHrid: '/items/iron_sword', enhancementLevel: 3, count: 1 }, itemDetails: {} },
            // Neither priced nor craftable: honestly zero
            { itemIndex: 3, item: { itemHrid: '/items/mystery', enhancementLevel: 0, count: 7 }, itemDetails: {} },
        ];

        self.onmessage({ data: { taskId: 1, data: { action: 'calculateBatch', params: { items, ...shared } } } });

        expect(messages).toHaveLength(1);
        expect(messages[0].error).toBeUndefined();
        const byIndex = new Map(messages[0].result.map((entry) => [entry.itemIndex, entry.value]));
        expect(byIndex.get(0)).toBe(500);
        expect(byIndex.get(1)).toBe(36);
        expect(byIndex.get(2)).toBe(900);
        expect(byIndex.get(3)).toBe(0);
    });

    test('production cost prices inputs at the configured mode, not always at ask', async () => {
        // Main's calculateCraftingCost prices every input through getMarketPrice,
        // which reads `networth_pricingMode`. The manager bakes that mode's price
        // into the plain `hrid:0` key of the map it ships (priceMapFor), so the
        // worker reading `hrid:0_ask` first meant a character on bid pricing had
        // every craft-cost fallback quoted on the ask side.
        vi.resetModules();
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );
        const calculateProductionCost = new Function('self', `${source}\n; return calculateProductionCost;`)({
            postMessage: () => {},
            onmessage: null,
        });

        // Bid-mode map: base key carries the mode price, `_ask` is the ask side
        const bidMap = { '/items/log:0': 6, '/items/log:0_ask': 10, '/items/log:0_bid': 6 };
        const recipes = {
            '/items/plank': { inputItems: [{ itemHrid: '/items/log', count: 2 }], upgradeItemHrid: null },
            '/items/board': {
                inputItems: [{ itemHrid: '/items/log', count: 1 }],
                upgradeItemHrid: '/items/plank',
            },
        };

        // 2 logs x 6 (the mode price) x 0.9 = 10.8 — reading ask would give 18
        expect(calculateProductionCost('/items/plank', bidMap, recipes)).toBeCloseTo(10.8, 9);
        // The upgrade item takes the same key: 1 x 6 x 0.9 + 10.8 = 16.2
        expect(calculateProductionCost('/items/board', bidMap, recipes)).toBeCloseTo(16.2, 9);

        // With the mode price absent, main falls through to the craft-cost
        // recursion rather than quietly substituting ask — so must the worker.
        const askOnlyMap = { '/items/log:0_ask': 10, '/items/log:0_bid': 6 };
        const withLogRecipe = {
            ...recipes,
            '/items/log': { inputItems: [{ itemHrid: '/items/seed', count: 1 }], upgradeItemHrid: null },
            '/items/seed': { inputItems: [], upgradeItemHrid: null },
        };
        // log prices through its own recipe (0 inputs priced) => 0, so plank is 0
        expect(calculateProductionCost('/items/plank', askOnlyMap, withLogRecipe)).toBe(0);
    });

    test('the networth worker mirrors from +2, like the path the tooltip quotes', async () => {
        // A Philosopher's Mirror combines a +(n-1) and a +(n-2) into a +n, and
        // +2 is reachable that way from a +1 and a plain +0 — which is why
        // calculateEnhancementPath's mirror pass runs from level 2. The worker
        // ran its copy of the same pass from level 3, so +2 never got the
        // mirror price and every level above it compounded the miss.
        vi.resetModules();
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );
        const calculateEnhancementCost = new Function('self', `${source}\n; return calculateEnhancementCost;`)({
            postMessage: () => {},
            onmessage: null,
        });

        // enhancingLevel === itemLevel, so the success multiplier is exactly 1
        // and the chain runs on the documented base rates: +1 at 50%, +2 at 45%.
        const priceMap = {
            '/items/test_sword:0': 100,
            '/items/test_sword:0_ask': 100,
            '/items/test_sword:0_bid': 90,
            '/items/test_material:0': 5000,
            '/items/test_material:0_ask': 5000,
            '/items/philosophers_mirror:0': 2000,
        };
        const params = {
            itemHrid: '/items/test_sword',
            enhancementParams: { enhancingLevel: 10, toolBonus: 0 },
            itemDetails: {
                itemLevel: 10,
                enhancementCosts: [{ itemHrid: '/items/test_material', count: 1 }],
                allItemDetails: {},
            },
            priceMap,
            recipes: {},
        };

        // +1 costs the base item plus two attempts' materials, and nothing can
        // mirror it — the anchor both branches agree on.
        expect(calculateEnhancementCost({ ...params, targetLevel: 1 })).toBeCloseTo(100 + 2 * 5000, 6);

        // +2 built the hard way expects 1.5 / 0.225 attempts; mirroring a +0
        // onto a +1 costs 100 + 10100 + 2000 and is far cheaper, so it wins.
        expect(calculateEnhancementCost({ ...params, targetLevel: 2 })).toBeCloseTo(12200, 6);

        // And the saving carries: +3 mirrors the now-cheaper +2 with the +1.
        expect(calculateEnhancementCost({ ...params, targetLevel: 3 })).toBeCloseTo(24300, 6);
    });

    test('an unquoted enhancement material falls back to its sell price, never to a negative one', async () => {
        // The marketplace answers "no quote" with -1 on a side, which is why the
        // worker already swaps a negative side for the positive one. When BOTH
        // sides are -1 there is nothing to swap to, and `ask || 0` handed the
        // material a price of -1 — an attempt that pays the enhancer to make it,
        // dragging the whole run's cost below the base item. Main's
        // getEnhancementMaterialPrice treats a book with no positive side as no
        // book at all and takes the item's sell price.
        vi.resetModules();
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );
        const calculateEnhancementCost = new Function('self', `${source}\n; return calculateEnhancementCost;`)({
            postMessage: () => {},
            onmessage: null,
        });

        const params = {
            itemHrid: '/items/test_sword',
            targetLevel: 1,
            enhancementParams: { enhancingLevel: 10, toolBonus: 0 },
            itemDetails: {
                itemLevel: 10,
                enhancementCosts: [{ itemHrid: '/items/test_material', count: 1 }],
                allItemDetails: { '/items/test_material': { sellPrice: 300, name: 'Test Material' } },
            },
            priceMap: {
                '/items/test_sword:0': 100,
                '/items/test_sword:0_ask': 100,
                '/items/test_sword:0_bid': 90,
                // Listed, but with no live order on either side
                '/items/test_material:0_ask': -1,
                '/items/test_material:0_bid': -1,
            },
            recipes: {},
        };

        // +1 takes two attempts on the 50% base rate, so the run is the base item
        // plus two materials at their sell price
        expect(calculateEnhancementCost(params)).toBeCloseTo(100 + 2 * 300, 6);
    });

    test('the pruned closure prices every hrid the worker can reach', async () => {
        // Differential proof that pruning is invisible: the real manager runs
        // end-to-end through a fake Worker (so the batch carries only the
        // pruned closure), and every value must match the same worker source
        // evaluated against the FULL price map and FULL recipe index. Any
        // reachable-but-unclosed hrid prices 0 only on the pruned side and
        // splits the two answers. The fixture is built to reach the deep
        // paths: a protection item priced only through a two-level production
        // chain (inputs and an upgrade item), enhancement materials read
        // through the price map, both mirrors, and a plain item priced only
        // through a transitive production input.
        vi.resetModules();

        let workerSource = null;
        vi.stubGlobal(
            'Blob',
            class {
                constructor(parts) {
                    this.text = parts[0];
                    workerSource = parts[0];
                }
            }
        );
        // Keep URL constructable (vitest internals build URLs); only the
        // object-URL statics are faked, handing the source text through
        const RealURL = globalThis.URL;
        vi.stubGlobal(
            'URL',
            class extends RealURL {
                static createObjectURL(blob) {
                    return blob.text;
                }
                static revokeObjectURL() {}
            }
        );
        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });

        const sentParams = [];
        vi.stubGlobal(
            'Worker',
            class {
                constructor(source) {
                    this._listeners = { message: new Set(), error: new Set() };
                    const workerSelf = {
                        onmessage: null,
                        postMessage: (message) => {
                            queueMicrotask(() => {
                                for (const listener of this._listeners.message) listener({ data: message });
                            });
                        },
                    };
                    new Function('self', source)(workerSelf);
                    this._self = workerSelf;
                }
                postMessage(message) {
                    sentParams.push(message.data.params);
                    queueMicrotask(() => this._self.onmessage({ data: message }));
                }
                addEventListener(type, listener) {
                    this._listeners[type].add(listener);
                }
                removeEventListener(type, listener) {
                    this._listeners[type].delete(listener);
                }
                terminate() {}
            }
        );

        const gameData = {
            actionDetailMap: {
                '/actions/craft_sword': {
                    // Two outputs: the sword, and slag as a by-product. Only an
                    // any-output index can price the slag at all.
                    outputItems: [
                        { itemHrid: '/items/iron_sword', count: 1 },
                        { itemHrid: '/items/iron_slag', count: 2 },
                    ],
                    inputItems: [{ itemHrid: '/items/iron_bar', count: 2 }],
                },
                '/actions/craft_ingot': {
                    // A batch recipe, so the per-item divide has to happen too
                    outputItems: [{ itemHrid: '/items/ingot', count: 4 }],
                    inputItems: [{ itemHrid: '/items/iron_slag', count: 3 }],
                },
                '/actions/craft_prot_orb': {
                    outputItems: [{ itemHrid: '/items/prot_orb', count: 1 }],
                    inputItems: [{ itemHrid: '/items/orb_shard', count: 3 }],
                    upgradeItemHrid: '/items/orb_core',
                },
                '/actions/craft_orb_core': {
                    outputItems: [{ itemHrid: '/items/orb_core', count: 1 }],
                    inputItems: [{ itemHrid: '/items/core_dust', count: 2 }],
                },
                '/actions/craft_mirror': {
                    outputItems: [{ itemHrid: '/items/philosophers_mirror', count: 1 }],
                    inputItems: [{ itemHrid: '/items/mirror_shard', count: 5 }],
                },
            },
            itemDetailMap: {
                '/items/iron_sword': {
                    itemLevel: 10,
                    sellPrice: 5,
                    enhancementCosts: [
                        { itemHrid: '/items/enhance_stone', count: 1 },
                        { itemHrid: '/items/coin', count: 100 },
                    ],
                    protectionItemHrids: ['/items/prot_orb'],
                },
                '/items/enhance_stone': { sellPrice: 30, name: 'Enhance Stone' },
                '/items/orb_core': { sellPrice: 3, name: 'Orb Core' },
            },
        };

        // Deliberately unpriced: prot_orb, orb_core, philosophers_mirror — the
        // worker can only price them through the recipe closure.
        const fullPriceMap = {
            '/items/iron_sword:0': 1000,
            '/items/iron_sword:0_ask': 1000,
            '/items/iron_sword:0_bid': 900,
            '/items/iron_bar:0': 100,
            '/items/iron_bar:0_ask': 100,
            '/items/enhance_stone:0': 50,
            '/items/enhance_stone:0_ask': 50,
            '/items/enhance_stone:0_bid': 40,
            '/items/orb_shard:0': 20,
            '/items/orb_shard:0_ask': 20,
            '/items/core_dust:0': 7,
            '/items/core_dust:0_ask': 7,
            '/items/mirror_shard:0': 11,
            '/items/mirror_shard:0_ask': 11,
            '/items/mirror_of_protection:0': 500000,
            '/items/mirror_of_protection:0_ask': 500000,
            '/items/mirror_of_protection:0_bid': 490000,
        };

        const configOptions = {
            useHighEnhancementCost: true,
            minLevel: 13,
            enhancementParams: { enhancingLevel: 100, toolBonus: 0 },
        };
        const items = [
            // High-enhancement: full strategy search with protection chains
            { itemHrid: '/items/iron_sword', enhancementLevel: 14, count: 1 },
            // Enhanced, no market price at its level: enhancement-cost path
            { itemHrid: '/items/iron_sword', enhancementLevel: 3, count: 1 },
            // Unpriced base item reachable only through core_dust production
            { itemHrid: '/items/orb_core', enhancementLevel: 0, count: 4 },
            // Unpriced, and reachable only through a by-product of another
            // action: slag is 2 iron_bar x 100 x 0.9 / 2 = 90, so an ingot is
            // 3 x 90 x 0.9 / 4 = 60.75 apiece
            { itemHrid: '/items/ingot', enhancementLevel: 0, count: 2 },
        ];

        const { calculateItemValueBatch, terminateItemValueWorkerPool } = await import('./networth-worker-manager.js');
        let values;
        try {
            values = await calculateItemValueBatch(items, fullPriceMap, configOptions, gameData);
        } finally {
            terminateItemValueWorkerPool();
        }

        // Control: the same worker source valuing the same items against the
        // UNPRUNED context — the full price map and the full recipe index.
        const workerCalculate = new Function('self', `${workerSource}\n; return calculateItemValue;`)({
            postMessage: () => {},
            onmessage: null,
        });
        const fullRecipes = {};
        for (const action of Object.values(gameData.actionDetailMap)) {
            // Mirrors the main thread's byAnyOutput index: any output, first
            // action wins, carrying that output's count
            for (const output of action.outputItems) {
                if (output.itemHrid in fullRecipes) continue;
                fullRecipes[output.itemHrid] = {
                    inputItems: action.inputItems || null,
                    upgradeItemHrid: action.upgradeItemHrid || null,
                    outputCount: output.count || 1,
                };
            }
        }
        const expected = items.map((item, index) => {
            const itemDetails = gameData.itemDetailMap[item.itemHrid];
            const allItemDetails = {};
            if (itemDetails?.enhancementCosts) {
                for (const material of itemDetails.enhancementCosts) {
                    const materialDetail = gameData.itemDetailMap[material.itemHrid];
                    if (materialDetail) {
                        allItemDetails[material.itemHrid] = {
                            sellPrice: materialDetail.sellPrice,
                            name: materialDetail.name,
                        };
                    }
                }
            }
            return workerCalculate({
                itemIndex: index,
                item,
                itemDetails: itemDetails ? { ...itemDetails, allItemDetails } : {},
                priceMap: fullPriceMap,
                recipes: fullRecipes,
                useHighEnhancementCost: configOptions.useHighEnhancementCost,
                minLevel: configOptions.minLevel,
                enhancementParams: configOptions.enhancementParams,
            }).value;
        });

        expect(values).toEqual(expected);
        // Pinned, so a regression in either index shows as a number rather than
        // as both sides agreeing on the same wrong answer
        expect(values[3]).toBeCloseTo(60.75 * 2, 9);
        // Nothing degenerated to zero: the deep chains actually priced
        for (const value of values) expect(value).toBeGreaterThan(0);

        // And the closure the chunk carried names the deep reaches explicitly
        expect(sentParams.length).toBeGreaterThan(0);
        const shared = sentParams[0];
        // A by-product carries its own recipe entry, with the count it is made in
        expect(shared.recipes).toHaveProperty('/items/iron_slag');
        expect(shared.recipes['/items/iron_slag'].outputCount).toBe(2);
        expect(shared.recipes['/items/ingot'].outputCount).toBe(4);
        expect(shared.recipes).toHaveProperty('/items/prot_orb');
        expect(shared.recipes).toHaveProperty('/items/orb_core');
        expect(shared.recipes).toHaveProperty('/items/philosophers_mirror');
        expect(shared.priceMap).toHaveProperty('/items/core_dust:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/orb_shard:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/mirror_shard:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/mirror_of_protection:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/enhance_stone:0_bid');
    });
});
