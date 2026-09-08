/**
 * Crafting Plan Calculator
 * Computes the optimal buy-vs-craft plan for a target item by recursively
 * comparing market price against crafting cost at each material tier.
 */

import dataManager from '../../core/data-manager.js';
import marketPriceStore from '../market/mooket/market-price-store.js';
import { getItemPrice } from '../../utils/market-data.js';
import { getShopCoinCost } from '../../utils/game-lookups.js';
import { findProducingAction } from '../../utils/production-index.js';
import { parseArtisanBonus, getDrinkConcentration } from '../../utils/tea-parser.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { calculateEfficiencyMultiplier } from '../../utils/efficiency.js';

const MAX_DEPTH = 15;

/**
 * Default "how many are listed at the best ask" lookup, read from mooket's
 * pooled order-book cache at enhancement level 0 (recipe materials are always
 * plain items). Returns the synchronously-cached askQty, or null when mooket
 * has no sighting for the item (store not loaded, mooket disabled, or the item
 * was never seen in an order book).
 *
 * Only order-book sightings carry a size; the periodic marketplace.json
 * snapshot stores askQty 0. A returned 0 therefore means "no depth known", not
 * "zero listed", which is why {@link isThinForLeg} requires a strictly positive
 * askQty before it will act — the feature never force-crafts on absent data.
 *
 * @param {string} itemHrid - Item
 * @returns {number|null} Units resting at the best ask, or null when unknown
 */
function defaultGetAskQty(itemHrid) {
    try {
        const entry = marketPriceStore.get(itemHrid, 0);
        return entry && typeof entry.askQty === 'number' ? entry.askQty : null;
    } catch {
        return null;
    }
}

/**
 * Whether a buy leg is "thin": mooket positively reports fewer units resting at
 * the best ask than this leg needs.
 *
 * The signal is top-of-book only — the units at the single best ask price, not
 * summed depth, because mooket does not carry deeper levels. That is exactly the
 * reported failure (the plan buys an intermediate priced off a lone unit), and
 * summing depth is neither possible here nor what the complaint is about.
 *
 * Requires askQty > 0: a null (no sighting) or 0 (snapshot-only, depth unknown)
 * reading is not a positive "too few are listed" signal, so the buy stands.
 *
 * @param {string} itemHrid - Item the leg would buy
 * @param {number} quantity - Units this leg needs
 * @param {Function} getAskQty - (itemHrid) => number|null
 * @returns {boolean}
 */
function isThinForLeg(itemHrid, quantity, getAskQty) {
    const askQty = getAskQty(itemHrid);
    return typeof askQty === 'number' && askQty > 0 && askQty < quantity;
}

/**
 * Find the production action that creates a given item.
 * @param {string} itemHrid
 * @returns {{ actionHrid: string, action: Object, outputCount: number } | null}
 */
function findProductionAction(itemHrid) {
    const producer = findProducingAction(itemHrid);
    if (!producer) return null;
    return { actionHrid: producer.actionHrid, action: producer.action, outputCount: producer.output.count || 1 };
}

/**
 * Get artisan tea material reduction bonus for an action type.
 *
 * Exported so other consumers of a recipe's inputs — `craft-arbitrage-adapter.js`
 * in particular — apply the exact same reduction to the exact same inputs as the
 * plan itself does, rather than reporting the printed (undiscounted) counts next
 * to a cost that already assumes the discount.
 *
 * @param {string} actionType - e.g. '/action_types/brewing'
 * @returns {number} Reduction as decimal (e.g. 0.112 for 11.2%)
 */
export function getArtisanBonus(actionType) {
    try {
        const gameData = dataManager.getInitClientData();
        const equipment = dataManager.getEquipment();
        const itemDetailMap = gameData?.itemDetailMap || {};
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
        const activeDrinks = dataManager.getActionDrinkSlots(actionType);
        return parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
    } catch {
        return 0;
    }
}

/**
 * Compute the optimal crafting plan for an item.
 * At each node, decides whether buying from market or crafting is cheaper.
 *
 * @param {string} itemHrid - Target item
 * @param {number} quantity - How many needed
 * @param {string} [mode='ask'] - Pricing mode for market lookups
 * @param {Set} [visited] - Circular dependency guard
 * @param {Map} [memo] - Memoization cache (unit cost per itemHrid)
 * @param {number} [depth=0] - Current recursion depth
 * @param {number} [maxDepth=MAX_DEPTH] - Maximum recursion depth (1 = buy all sub-materials)
 * @param {boolean} [buyRawOnly=false] - When true, always craft items that have a recipe; only buy uncraftable items
 * @param {boolean} [forceRootCraft=false] - When true, forces the root item (depth 0) to be crafted
 * @param {number} [timeCostPerHour=0] - Gold value per hour of player time (0 = disabled)
 * @param {boolean} [skipProcessing=false] - When true, forces buy for processing actions (single input, no upgrade)
 * @param {boolean} [thinMarket=false] - When true, a leg the plan would buy is re-routed to craft when mooket
 *   positively reports fewer units at the best ask than the leg needs, provided the item is craftable and crafting
 *   it is permitted by the other modes. Acts only on a positive signal; falls through to the buy when mooket has no
 *   depth for the item.
 * @param {Function} [getAskQty=defaultGetAskQty] - (itemHrid) => number|null; best-ask size lookup, injectable for tests
 * @returns {CraftingPlanNode}
 */
export function computeBestCraftingPlan(
    itemHrid,
    quantity = 1,
    mode = 'ask',
    visited = new Set(),
    memo = new Map(),
    depth = 0,
    maxDepth = MAX_DEPTH,
    buyRawOnly = false,
    forceRootCraft = false,
    timeCostPerHour = 0,
    skipProcessing = false,
    thinMarket = false,
    getAskQty = defaultGetAskQty
) {
    const itemDetails = dataManager.getItemDetails(itemHrid);
    const itemName = itemDetails?.name || itemHrid.split('/').pop();
    const isTradable = itemDetails?.isTradable ?? false;

    // Get market buy price (min of market ask and shop cost).
    // Only pass mode through when it is a raw price type — profit-context modes
    // like 'hybrid' are resolved by getItemPrice via context/side instead.
    let buyPrice = null;
    if (isTradable) {
        const rawMode = mode === 'ask' || mode === 'bid' || mode === 'average' ? mode : undefined;
        const marketPrice = getItemPrice(itemHrid, { mode: rawMode, context: 'profit', side: 'buy' });
        if (marketPrice !== null && marketPrice > 0) {
            buyPrice = marketPrice;
        }
    }
    const shopCost = getShopCoinCost(itemHrid);
    if (shopCost > 0 && (buyPrice === null || shopCost < buyPrice)) {
        buyPrice = shopCost;
    }

    // Coins always cost 1 each
    if (itemHrid === '/items/coin') {
        return {
            itemHrid,
            itemName: 'Coin',
            quantity,
            strategy: 'buy',
            unitCost: 1,
            totalCost: quantity,
            buyPrice: 1,
            craftCost: null,
            actionHrid: null,
            actionsNeeded: 0,
            children: [],
        };
    }

    // Circular dependency or depth limit — must buy. Checked BEFORE the memo:
    // the memo path re-expands a cached craft's children through this same
    // function, and that re-expansion carries neither node in `visited` — two
    // recipes memoised as 'craft' that consume each other would otherwise
    // reconstruct one another forever (depth grows but was never re-checked
    // after a memo hit).
    if (visited.has(itemHrid) || depth >= maxDepth) {
        return {
            itemHrid,
            itemName,
            quantity,
            strategy: 'buy',
            unitCost: buyPrice ?? Infinity,
            totalCost: (buyPrice ?? Infinity) * quantity,
            buyPrice,
            craftCost: null,
            actionHrid: null,
            actionsNeeded: 0,
            children: [],
        };
    }

    // Check memo for previously computed unit cost.
    // The memo holds the NORMAL, quantity-independent decision. A thin-market
    // reroute is per-leg (it depends on THIS leg's quantity), so a cached 'buy'
    // for a craftable item (craftCost !== null) must be re-evaluated against
    // this leg's need rather than served blindly: when it is thin here, fall
    // through to a full recompute so the leg is crafted. A cached 'craft' is
    // already the more-available path and is reused as-is.
    const memoThinReroute =
        memo.has(itemHrid) &&
        thinMarket &&
        memo.get(itemHrid).strategy === 'buy' &&
        memo.get(itemHrid).craftCost !== null &&
        isThinForLeg(itemHrid, quantity, getAskQty);
    if (memo.has(itemHrid) && !memoThinReroute) {
        const cachedUnitCost = memo.get(itemHrid);
        return {
            itemHrid,
            itemName,
            quantity,
            strategy: cachedUnitCost.strategy,
            unitCost: cachedUnitCost.unitCost,
            totalCost: cachedUnitCost.unitCost * quantity,
            buyPrice,
            craftCost: cachedUnitCost.craftCost,
            actionHrid: cachedUnitCost.actionHrid,
            actionsNeeded:
                cachedUnitCost.strategy === 'craft' ? Math.ceil(quantity / (cachedUnitCost.outputCount || 1)) : 0,
            children:
                cachedUnitCost.strategy === 'craft'
                    ? cachedUnitCost.childrenTemplate.map((c) =>
                          computeBestCraftingPlan(
                              c.itemHrid,
                              c.qtyPerUnit * quantity,
                              mode,
                              visited,
                              memo,
                              depth + 1,
                              maxDepth,
                              buyRawOnly,
                              forceRootCraft,
                              timeCostPerHour,
                              skipProcessing,
                              thinMarket,
                              getAskQty
                          )
                      )
                    : [],
        };
    }

    // Find production action
    const production = findProductionAction(itemHrid);
    if (!production) {
        // No recipe — must buy. Use Infinity like the other buy-only paths so an
        // unpriceable item propagates as "unknown cost" instead of a free material.
        const unitCost = buyPrice ?? Infinity;
        memo.set(itemHrid, {
            strategy: 'buy',
            unitCost,
            craftCost: null,
            actionHrid: null,
            outputCount: 1,
            childrenTemplate: [],
        });
        return {
            itemHrid,
            itemName,
            quantity,
            strategy: 'buy',
            unitCost,
            totalCost: unitCost * quantity,
            buyPrice,
            craftCost: null,
            actionHrid: null,
            actionsNeeded: 0,
            children: [],
        };
    }

    // Skip processing actions if flag is set
    // Processing = material conversion actions (milk → cheese, fiber → fabric, log → lumber)
    // Identified by category ending in /material or /lumber (vs equipment crafting like /feet, /crossbow)
    const isProcessingAction =
        production.action.category?.endsWith('/material') || production.action.category?.endsWith('/lumber');
    if (skipProcessing && isProcessingAction) {
        const unitCost = buyPrice ?? Infinity;
        memo.set(itemHrid, {
            strategy: 'buy',
            unitCost,
            craftCost: null,
            actionHrid: null,
            outputCount: 1,
            childrenTemplate: [],
        });
        return {
            itemHrid,
            itemName,
            quantity,
            strategy: 'buy',
            unitCost,
            totalCost: unitCost * quantity,
            buyPrice,
            craftCost: null,
            actionHrid: null,
            actionsNeeded: 0,
            children: [],
        };
        // No-processing is an explicit directive to buy this material, so a thin
        // market cannot re-route it — crafting it is exactly what the user
        // forbade. The buy stands: physical availability is a constraint, not a
        // licence to override a mode the user selected. (No thin flag here — the
        // memo reconstructs this leg elsewhere in the tree without it, so a flag
        // set only on the first sighting would be inconsistent.)
    }

    // Recurse into crafting
    visited.add(itemHrid);
    const { actionHrid, action, outputCount } = production;
    const artisanBonus = getArtisanBonus(action.type);
    const actionsForOne = 1 / outputCount; // actions per 1 output item

    let craftCostPerUnit = 0;
    const childrenTemplate = []; // { itemHrid, qtyPerUnit } for memo reconstruction

    // Input items (affected by artisan bonus)
    if (action.inputItems) {
        for (const input of action.inputItems) {
            const inputCountPerAction = input.count || 1;
            const reducedCount = inputCountPerAction * (1 - artisanBonus);
            const qtyPerUnit = reducedCount * actionsForOne;

            const inputQty = Math.ceil(reducedCount * Math.ceil(quantity / outputCount));
            const childPlan = computeBestCraftingPlan(
                input.itemHrid,
                inputQty,
                mode,
                visited,
                memo,
                depth + 1,
                maxDepth,
                buyRawOnly,
                forceRootCraft,
                timeCostPerHour,
                skipProcessing,
                thinMarket,
                getAskQty
            );

            craftCostPerUnit += childPlan.unitCost * qtyPerUnit;
            childrenTemplate.push({ itemHrid: input.itemHrid, qtyPerUnit });
        }
    }

    // Upgrade item (NOT affected by artisan bonus)
    if (action.upgradeItemHrid) {
        const qtyPerUnit = actionsForOne; // 1 upgrade per action
        const upgradeQty = Math.ceil(quantity / outputCount);
        const upgradePlan = computeBestCraftingPlan(
            action.upgradeItemHrid,
            upgradeQty,
            mode,
            visited,
            memo,
            depth + 1,
            maxDepth,
            buyRawOnly,
            forceRootCraft,
            timeCostPerHour,
            skipProcessing,
            thinMarket,
            getAskQty
        );

        craftCostPerUnit += upgradePlan.unitCost * qtyPerUnit;
        childrenTemplate.push({ itemHrid: action.upgradeItemHrid, qtyPerUnit });
    }

    visited.delete(itemHrid);

    // Add time cost to craft cost if enabled
    if (timeCostPerHour > 0) {
        const gameData = dataManager.getInitClientData();
        const actionDetails = gameData?.actionDetailMap?.[actionHrid];
        if (actionDetails) {
            const stats = calculateActionStats(actionDetails, {
                skills: dataManager.getSkills(),
                equipment: dataManager.getEquipment(),
                itemDetailMap: gameData.itemDetailMap,
            });
            const effMultiplier = calculateEfficiencyMultiplier(stats.totalEfficiency);
            const timePerUnit = (stats.actionTime / effMultiplier) * actionsForOne;
            craftCostPerUnit += timePerUnit * (timeCostPerHour / 3600);
        }
    }

    // Buy vs craft decision
    // When buyRawOnly is true, always craft (we only reach here if a recipe exists)
    // When forceRootCraft is true and depth === 0, always craft the root item
    const normalShouldBuy =
        !buyRawOnly && !(forceRootCraft && depth === 0) && buyPrice !== null && buyPrice <= craftCostPerUnit;

    // Thin-market re-route. Reaching this decision at all means crafting THIS
    // item is permitted: buyRawOnly and forceRootCraft@0 make normalShouldBuy
    // false (so they never leave a buy to re-route), and no-processing on a
    // processing action returned above — so a permitted buy that lands here can
    // always be crafted instead. When the setting is on and mooket positively
    // says fewer units rest at the best ask than this leg needs, craft it.
    // The recursion above already built craftCostPerUnit through the same
    // depth/visited-guarded path, so a re-route cannot loop and terminates at
    // raw materials; the re-routed leg is costed at that craft cost, not the
    // unachievable buy price.
    const thinReroute = normalShouldBuy && thinMarket && isThinForLeg(itemHrid, quantity, getAskQty);
    const shouldBuy = normalShouldBuy && !thinReroute;
    const strategy = shouldBuy ? 'buy' : 'craft';
    const unitCost = shouldBuy ? buyPrice : craftCostPerUnit;

    // Cache the NORMAL (quantity-independent) decision, never the thin re-route:
    // the re-route depends on this leg's quantity, so caching it would force the
    // same craft (or the same buy) onto another leg with a different need. Each
    // leg re-applies the thin check itself, on the memo path above and here.
    memo.set(itemHrid, {
        strategy: normalShouldBuy ? 'buy' : 'craft',
        unitCost: normalShouldBuy ? buyPrice : craftCostPerUnit,
        craftCost: craftCostPerUnit,
        actionHrid: normalShouldBuy ? null : actionHrid,
        outputCount,
        childrenTemplate: normalShouldBuy ? [] : childrenTemplate,
    });

    // Build children for the actual quantities
    let children = [];
    if (!shouldBuy) {
        const actionsNeeded = Math.ceil(quantity / outputCount);
        children = [];
        if (action.inputItems) {
            for (const input of action.inputItems) {
                const inputCountPerAction = input.count || 1;
                const reducedCount = inputCountPerAction * (1 - artisanBonus);
                const inputQty = Math.ceil(reducedCount * actionsNeeded);
                children.push(
                    computeBestCraftingPlan(
                        input.itemHrid,
                        inputQty,
                        mode,
                        visited,
                        memo,
                        depth + 1,
                        maxDepth,
                        buyRawOnly,
                        forceRootCraft,
                        timeCostPerHour,
                        skipProcessing,
                        thinMarket,
                        getAskQty
                    )
                );
            }
        }
        if (action.upgradeItemHrid) {
            children.push(
                computeBestCraftingPlan(
                    action.upgradeItemHrid,
                    actionsNeeded,
                    mode,
                    visited,
                    memo,
                    depth + 1,
                    maxDepth,
                    buyRawOnly,
                    forceRootCraft,
                    timeCostPerHour,
                    skipProcessing,
                    thinMarket,
                    getAskQty
                )
            );
        }
    }

    return {
        itemHrid,
        itemName,
        quantity,
        strategy,
        unitCost,
        totalCost: unitCost * quantity,
        buyPrice,
        craftCost: craftCostPerUnit,
        actionHrid: strategy === 'craft' ? actionHrid : null,
        actionsNeeded: strategy === 'craft' ? Math.ceil(quantity / outputCount) : 0,
        children,
        // Optional marker: this leg would have been bought on price, but was
        // crafted because the cheap ask cannot supply the quantity. Renders as an
        // ordinary craft node otherwise — the display already keys off strategy.
        ...(thinReroute ? { thinMarketRerouted: true } : {}),
    };
}

/**
 * Flatten a plan into what is still missing from an inventory.
 *
 * The plan must already be sized for the real total wanted — the caller plans
 * for `numActions × outputCount` units and this reads the quantities off that
 * tree. Scaling a one-unit plan's quantities instead is the bug this replaces:
 * a one-unit plan's buy counts are already a whole action's worth (rounded up),
 * so multiplying them by units-of-output overcounted a multi-output recipe by
 * its outputCount again.
 *
 * An owned intermediate is credited at its own craft node before that node is
 * expanded: owning the leather means the plan buys hide only for the leather
 * still short, never for all of it. The credit is drawn from one shared ledger,
 * so the same stock cannot cover two nodes that hold the same intermediate. The
 * root is never credited — owning copies of the item the player asked to craft
 * must not shrink the run they requested.
 *
 * Coins are skipped (not bought on the marketplace); untradable items are
 * reported with `isTradeable: false` so the caller can leave them off the tabs.
 *
 * @param {Object} plan - A node from {@link computeBestCraftingPlan}
 * @param {Array<Object>} inventory - Inventory rows ({itemHrid, count, enhancementLevel})
 * @returns {Array<{itemHrid: string, itemName: string, missing: number, required: number, isTradeable: boolean}>}
 *   One line per buy item still short, aggregated across branches
 */
export function collectMissingMaterials(plan, inventory) {
    const needed = new Map(); // itemHrid → { itemName, quantity }
    const rows = Array.isArray(inventory) ? inventory : [];

    // One shared, mutable ledger. Only unenhanced copies count — an enhanced
    // piece is not a material.
    const stock = new Map();
    for (const row of rows) {
        if (row.enhancementLevel) continue;
        stock.set(row.itemHrid, (stock.get(row.itemHrid) || 0) + (row.count || 0));
    }
    const creditedToCrafts = new Map(); // itemHrid → units the tree's craft nodes took

    (function walk(node, scale, isRoot) {
        if (!node) return;
        const quantity = node.quantity * scale;

        if (node.strategy === 'buy') {
            if (node.itemHrid === '/items/coin' || !(quantity > 0)) return;
            const line = needed.get(node.itemHrid);
            if (line) line.quantity += quantity;
            else needed.set(node.itemHrid, { itemName: node.itemName, quantity });
            return;
        }

        // A craft node without a quantity carries no scale of its own; walk it
        // through untouched rather than crediting against a number that is not there.
        let childScale = scale;
        if (!isRoot && node.quantity > 0) {
            const held = stock.get(node.itemHrid) || 0;
            const used = Math.min(held, quantity);
            if (used > 0) {
                stock.set(node.itemHrid, held - used);
                creditedToCrafts.set(node.itemHrid, (creditedToCrafts.get(node.itemHrid) || 0) + used);
            }
            const remaining = quantity - used;
            if (!(remaining > 0)) return;
            // The children were sized per whole action, so the uncovered
            // remainder is expanded in whole actions too; the artisan reduction
            // already baked into those child quantities rides along untouched.
            childScale =
                node.actionsNeeded > 0
                    ? Math.ceil(node.actionsNeeded * (remaining / node.quantity)) / node.actionsNeeded
                    : remaining / node.quantity;
        }

        for (const child of node.children || []) walk(child, childScale, false);
    })(plan, 1, true);

    const missing = [];
    for (const [itemHrid, line] of needed) {
        const required = Math.ceil(line.quantity);
        const short = Math.max(0, required - (stock.get(itemHrid) || 0));
        if (short <= 0) continue;
        const isTradeable = dataManager.getItemDetails(itemHrid)?.isTradable !== false;
        // The caller re-subtracts the player's real inventory from `required`,
        // so add back whatever a craft node already spent of this item's stock.
        missing.push({
            itemHrid,
            itemName: line.itemName,
            missing: short,
            required: required + (creditedToCrafts.get(itemHrid) || 0),
            isTradeable,
        });
    }
    return missing;
}
