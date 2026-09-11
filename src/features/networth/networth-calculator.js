/**
 * Networth Calculator
 * Calculates total character networth including:
 * - Equipped items
 * - Inventory items
 * - Market listings
 * - Houses (all 17)
 * - Abilities (equipped + others)
 * - Guild shrine levels bought (credits only — tokens have no gold price)
 */

import dataManager from '../../core/data-manager.js';
import { yieldToBrowser } from '../../utils/yield-to-browser.js';
import marketAPI from '../../api/marketplace.js';
import { explainAbilityCost } from '../../utils/ability-cost-calculator.js';
import { MARKET_TAX, COWBELL_BAG_HRID, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';
import { calculateHouseBuildCost } from '../../utils/house-cost-calculator.js';
import { calculateEnhancementPath } from '../enhancement/tooltip-enhancement.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { calculateTaskTokenValue } from '../tasks/task-profit-calculator.js';
import { calculateDungeonTokenValue } from '../../utils/token-valuation.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import config from '../../core/config.js';
import networthCache from './networth-cache.js';
import { getItemPrice, getItemPrices } from '../../utils/market-data.js';
import { refreshMarketValues, marketValueFor, reconcileBook } from '../../utils/market-values.js';
import { calculateItemValueBatch } from '../../utils/networth-worker-manager.js';
import { DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import { getKeyUnitCost } from '../../utils/key-cost.js';
import { getShopCoinCost } from '../../utils/game-lookups.js';
import { isExcluded, getExclusions } from './networth-exclusions.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import { loadoutSnapshot } from '../../utils/bundle-bridge.js';
import { buildGoldPerCredit, priceGuildCreditCosts } from '../../utils/guild-credit-pricing.js';

/**
 * Calculate the value of a single item
 * @param {Object} item - Item data {itemHrid, enhancementLevel, count}
 * @param {Map} priceCache - Optional price cache from getPricesBatch()
 * @returns {number} Total value in coins
 */
export async function calculateItemValue(item, priceCache = null) {
    const { itemHrid, enhancementLevel = 0, count = 1 } = item;

    let itemValue = 0;

    // Check if high enhancement cost mode is enabled
    const useHighEnhancementCost = config.getSetting('networth_highEnhancementUseCost');
    const minLevel = config.getSetting('networth_highEnhancementMinLevel') || 13;

    // For enhanced items (1+)
    if (enhancementLevel >= 1) {
        // For high enhancement levels, use cost instead of market price (if enabled)
        if (useHighEnhancementCost && enhancementLevel >= minLevel) {
            // Check cache first
            const cachedCost = networthCache.get(itemHrid, enhancementLevel);
            if (cachedCost !== null) {
                itemValue = cachedCost;
            } else {
                // Calculate enhancement cost (ignore market price)
                const enhancementParams = getEnhancingParams();
                const enhancementPath = calculateEnhancementPath(itemHrid, enhancementLevel, enhancementParams);

                if (enhancementPath && enhancementPath.optimalStrategy) {
                    itemValue = enhancementPath.optimalStrategy.totalCost;
                    // Cache the result
                    networthCache.set(itemHrid, enhancementLevel, itemValue);
                } else {
                    // Enhancement calculation failed, fallback to base item price
                    console.warn('[Networth] Enhancement calculation failed for:', itemHrid, '+' + enhancementLevel);
                    itemValue = getMarketPrice(itemHrid, 0, priceCache);
                }
            }
        } else {
            // Normal logic for lower enhancement levels: try market price first, then calculate
            const marketPrice = getMarketPrice(itemHrid, enhancementLevel, priceCache);

            if (marketPrice > 0) {
                itemValue = marketPrice;
            } else {
                // No market data, calculate enhancement cost
                const cachedCost = networthCache.get(itemHrid, enhancementLevel);
                if (cachedCost !== null) {
                    itemValue = cachedCost;
                } else {
                    const enhancementParams = getEnhancingParams();
                    const enhancementPath = calculateEnhancementPath(itemHrid, enhancementLevel, enhancementParams);

                    if (enhancementPath && enhancementPath.optimalStrategy) {
                        itemValue = enhancementPath.optimalStrategy.totalCost;
                        networthCache.set(itemHrid, enhancementLevel, itemValue);
                    } else {
                        console.warn(
                            '[Networth] Enhancement calculation failed for:',
                            itemHrid,
                            '+' + enhancementLevel
                        );
                        itemValue = getMarketPrice(itemHrid, 0, priceCache);
                    }
                }
            }
        }
    } else {
        // Unenhanced items: use market price or crafting cost
        itemValue = getMarketPrice(itemHrid, enhancementLevel, priceCache);
    }

    return itemValue * count;
}

/**
 * The prices net worth should use for one item at one enhancement level.
 *
 * Honors the "Net worth value source" setting and reconciles the raw order book
 * against the game's official market value:
 *   - officialValue: the game's own published value (a single estimate), when it
 *     has one — the figure behind the inventory's Total Market Value.
 *   - orderBook: the live ask/bid, with a stale price clamped into the tradable
 *     range and an empty book filled from the value.
 * A pass-through to the raw order book until the marketplace patch is live.
 *
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @param {Map|null} priceCache - Batch cache from getPricesBatch(), or null to fetch
 * @returns {{ask:number|null, bid:number|null, average:number|null}|number|null}
 */
function resolveNetworthPrices(itemHrid, enhancementLevel, priceCache = null) {
    const raw = priceCache
        ? priceCache.get(`${itemHrid}:${enhancementLevel}`)
        : getItemPrices(itemHrid, enhancementLevel);

    refreshMarketValues();
    const valueSource = config.getSettingValue('networth_valueSource') || 'orderBook';
    if (valueSource === 'officialValue') {
        const official = marketValueFor(itemHrid, enhancementLevel);
        if (official !== null) {
            return { ask: official, bid: official, average: official };
        }
    }

    if (raw && typeof raw === 'object') {
        const { ask, bid } = reconcileBook(raw.ask ?? null, raw.bid ?? null, itemHrid, enhancementLevel);
        if (ask === null && bid === null) {
            return null;
        }
        return { ask, bid, average: ask !== null && bid !== null ? (ask + bid) / 2 : null };
    }

    return raw ?? null;
}

/**
 * Is this a currency that priced at 0 because nothing could price it?
 *
 * A currency worth 0 and a currency nobody can value yet look identical in a
 * total, and only one of the two is worth saying out loud. Task tokens are
 * priced through the Task Shop, so before the shop and the market are both
 * readable there is no figure — which is a different statement from "these are
 * worth nothing", and the row says which one it is.
 *
 * @param {string} itemHrid - Item HRID
 * @returns {boolean} True when the item is a currency with no obtainable price
 */
export function isUnpricedCurrency(itemHrid) {
    if (itemHrid !== '/items/task_token') return false;
    if (config.getSetting('networth_includeTaskTokens') === false) return false;

    const tokenData = calculateTaskTokenValue();
    return !(tokenData?.tokenValue > 0);
}

/**
 * Get market price for an item
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @param {Map} priceCache - Optional price cache from getPricesBatch()
 * @returns {number} Price per item (uses networth pricing mode setting)
 */
function getMarketPrice(itemHrid, enhancementLevel, priceCache = null) {
    // Special handling for currencies
    const currencyValue = calculateCurrencyValue(itemHrid);
    if (currencyValue !== null) {
        return currencyValue;
    }

    // Determine which price field to use based on networth pricing mode
    const pricingMode = config.getSettingValue('networth_pricingMode') || 'ask';

    // Reconciled against the official market value and the value-source setting
    const prices = resolveNetworthPrices(itemHrid, enhancementLevel, priceCache);

    // Try selected pricing mode first
    const price = typeof prices === 'number' ? prices : prices?.[pricingMode];
    if (price && price > 0) {
        return price;
    }

    // No valid price - try fallbacks (only for base items)
    // Enhanced items should calculate via enhancement path, not crafting cost
    if (enhancementLevel === 0) {
        // Check if it's an openable container (crates, caches, chests)
        const itemDetails = dataManager.getItemDetails(itemHrid);
        if (itemDetails?.isOpenable && expectedValueCalculator.isInitialized) {
            const evData = expectedValueCalculator.calculateExpectedValue(itemHrid);
            if (evData && evData.expectedValue > 0) {
                let netValue = evData.expectedValue;

                // Deduct chest key cost for dungeon chests
                const chestKeyHrid = DUNGEON_CHEST_CHEST_KEYS[itemHrid];
                if (chestKeyHrid) {
                    // Through the key pricing resolver, not the raw setting: an
                    // unresolved 'synced' or 'craft' indexes nothing on the price
                    // map and would quietly deduct the ask instead
                    netValue -= getKeyUnitCost(chestKeyHrid) ?? 0;
                }

                return netValue;
            }
        }

        // Try crafting cost as fallback
        const craftingCost = calculateCraftingCost(itemHrid);
        if (craftingCost > 0) {
            return craftingCost;
        }

        // Try shop cost as final fallback (for shop-only items)
        const shopCost = getShopCoinCost(itemHrid);
        if (shopCost > 0) {
            return shopCost;
        }
    }

    return 0;
}

/**
 * What net worth carries one of an item at — the valuation the total itself is
 * built from: currencies at theirs, then the market at the pricing mode, then
 * (base items only) an openable's expected value, a material cost or a shop
 * price.
 *
 * Exported for the gold attribution, which has to value a gain the way net
 * worth valued it or the difference lands in its residual.
 *
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel] - Enhancement level
 * @returns {number} Coins per item, 0 when nothing can say
 */
export function networthUnitValue(itemHrid, enhancementLevel = 0) {
    return getMarketPrice(itemHrid, enhancementLevel) || 0;
}

/**
 * Calculate value for currency items
 * @param {string} itemHrid - Item HRID
 * @returns {number|null} Currency value per unit, or null if not a currency
 */
function calculateCurrencyValue(itemHrid) {
    // Coins: Face value (1 coin = 1 value)
    if (itemHrid === '/items/coin') {
        return 1;
    }

    // Cowbells: Market value of Bag of 10 Cowbells / 10 (if enabled)
    if (itemHrid === '/items/cowbell') {
        // Check if cowbells should be included in net worth
        const includeCowbells = config.getSetting('networth_includeCowbells');
        if (!includeCowbells) {
            return null; // Don't include cowbells in net worth
        }

        const pricingMode = config.getSettingValue('networth_pricingMode') || 'ask';
        const bagPrice = getItemPrice('/items/bag_of_10_cowbells', { mode: pricingMode }) || 0;
        if (bagPrice > 0) {
            return bagPrice / 10;
        }
        // Fallback: vendor value
        return 100000;
    }

    // Task Tokens: Expected value from Task Shop chests
    if (itemHrid === '/items/task_token') {
        const includeTaskTokens = config.getSetting('networth_includeTaskTokens');
        if (includeTaskTokens === false) {
            return null; // Don't include task tokens in net worth
        }

        const tokenData = calculateTaskTokenValue();
        if (tokenData && tokenData.tokenValue > 0) {
            return tokenData.tokenValue;
        }
        // Market data not loaded yet: the task shop is what prices a token, and until it
        // can be read there is no honest figure. A stand-in 30,000 apiece was worse than
        // nothing — a five-figure token stack appeared in the total, moved when nothing
        // about the character had, and settled somewhere else once prices arrived. Report
        // the tokens as unvalued instead, which is what offline economics already does.
        return 0;
    }

    // Dungeon tokens: Best market value per token approach
    // Calculate based on best shop item value (similar to task tokens)
    // Uses profitCalc_pricingMode which defaults to 'hybrid' (ask price)
    if (itemHrid === '/items/chimerical_token') {
        return calculateDungeonTokenValue(itemHrid, 'profitCalc_pricingMode', null) || 0;
    }
    if (itemHrid === '/items/sinister_token') {
        return calculateDungeonTokenValue(itemHrid, 'profitCalc_pricingMode', null) || 0;
    }
    if (itemHrid === '/items/enchanted_token') {
        return calculateDungeonTokenValue(itemHrid, 'profitCalc_pricingMode', null) || 0;
    }
    if (itemHrid === '/items/pirate_token') {
        return calculateDungeonTokenValue(itemHrid, 'profitCalc_pricingMode', null) || 0;
    }

    return null; // Not a currency
}

/**
 * Item → crafting action lookups, built once per game data.
 *
 * Every recalculation used to rediscover which action makes an item by scanning
 * the whole `actionDetailMap` — per item, so a full pass was
 * O(items × actions), and on a live account that scan alone was most of a
 * ~350ms synchronous block every few seconds (the stutter of 2026-08-29).
 * Two maps from one pass instead: by first output (the "this item is crafted
 * as" relation `addItemWithUpgrades` wants) and by any output with its count
 * (what `calculateCraftingCost` prices against).
 *
 * Keyed on the actionDetailMap object itself, so a character switch or data
 * reload rebuilds it and nothing has to remember to invalidate.
 */
let actionIndexes = null;
let actionIndexSource = null;

/** The last calculateNetworth run's per-phase milliseconds, for diagnosis. */
export let lastCalcPhases = null;

/** Single items whose valuation exceeded ~15ms in the last run — the indivisible chunks. */
export let lastSlowItems = null;

function getActionIndexes() {
    const map = dataManager.getInitClientData()?.actionDetailMap || null;
    if (!map) return null;
    if (actionIndexSource !== map) {
        actionIndexSource = map;
        const byPrimaryOutput = new Map();
        const byAnyOutput = new Map();
        for (const action of Object.values(map)) {
            if (!action.outputItems?.length) continue;
            const primary = action.outputItems[0].itemHrid;
            if (!byPrimaryOutput.has(primary)) byPrimaryOutput.set(primary, action);
            for (const output of action.outputItems) {
                if (!byAnyOutput.has(output.itemHrid)) byAnyOutput.set(output.itemHrid, { action, output });
            }
        }
        actionIndexes = { byPrimaryOutput, byAnyOutput };
    }
    return actionIndexes;
}

/**
 * Calculate crafting cost for an item (simple version without efficiency bonuses)
 * Applies Artisan Tea reduction (0.9x) to input materials
 * @param {string} itemHrid - Item HRID
 * @returns {number} Total material cost or 0 if not craftable
 */
export function calculateCraftingCost(itemHrid) {
    // The producing action comes from the once-built index rather than a scan
    // of every action in the game — see getActionIndexes
    const found = getActionIndexes()?.byAnyOutput.get(itemHrid);
    if (!found) return 0;
    const { action, output } = found;

    let inputCost = 0;
    if (action.inputItems && action.inputItems.length > 0) {
        for (const input of action.inputItems) {
            const inputPrice = getMarketPrice(input.itemHrid, 0, null);
            inputCost += inputPrice * input.count;
        }
    }

    // Apply Artisan Tea reduction (0.9x) to input materials
    inputCost *= 0.9;

    // Add upgrade item cost (not affected by Artisan Tea)
    let upgradeCost = 0;
    if (action.upgradeItemHrid) {
        const upgradePrice = getMarketPrice(action.upgradeItemHrid, 0, null);
        upgradeCost = upgradePrice;
    }

    // Divide by output count to get per-item cost
    return (inputCost + upgradeCost) / (output.count || 1);
}

/**
 * Calculate total value of all houses (all 17)
 * @param {Object} characterHouseRooms - Map of character house rooms
 * @returns {Object} {totalCost, breakdown: [{name, level, cost}]}
 */
export function calculateAllHousesCost(characterHouseRooms) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return { totalCost: 0, breakdown: [] };

    const houseRoomDetailMap = gameData.houseRoomDetailMap;
    if (!houseRoomDetailMap) return { totalCost: 0, breakdown: [] };

    let totalCost = 0;
    const breakdown = [];

    for (const [houseRoomHrid, houseData] of Object.entries(characterHouseRooms)) {
        const level = houseData.level || 0;
        if (level === 0) continue;

        const cost = calculateHouseBuildCost(houseRoomHrid, level);
        totalCost += cost;

        // Get human-readable name
        const houseDetail = houseRoomDetailMap[houseRoomHrid];
        const houseName = houseDetail?.name || houseRoomHrid.replace('/house_rooms/', '');

        breakdown.push({
            hrid: houseRoomHrid,
            name: houseName,
            level: level,
            cost: cost,
        });
    }

    // Sort by cost descending
    breakdown.sort((a, b) => b.cost - a.cost);

    return { totalCost, breakdown };
}

/**
 * Calculate total value of all abilities
 * @param {Array} characterAbilities - Array of character abilities
 * @param {Object} abilityCombatTriggersMap - Map of equipped abilities
 * @returns {Object} {totalCost, equippedCost, breakdown, equippedBreakdown, otherBreakdown}
 */
export function calculateAllAbilitiesCost(characterAbilities, abilityCombatTriggersMap) {
    if (!characterAbilities || characterAbilities.length === 0) {
        return {
            totalCost: 0,
            equippedCost: 0,
            breakdown: [],
            equippedBreakdown: [],
            otherBreakdown: [],
        };
    }

    let totalCost = 0;
    let equippedCost = 0;
    const breakdown = [];
    const equippedBreakdown = [];
    const otherBreakdown = [];

    // Create set of equipped ability HRIDs from abilityCombatTriggersMap keys
    const equippedHrids = new Set(Object.keys(abilityCombatTriggersMap || {}));

    for (const ability of characterAbilities) {
        if (!ability.abilityHrid || ability.level === 0) continue;

        // No listing for the book is no price, not a free ability. Counting it
        // as zero quietly understated the total and put the row at the bottom
        // of the list as though it were worthless
        const priced = explainAbilityCost(ability.abilityHrid, ability.level);
        const unpriced = priced?.total == null;
        const cost = unpriced ? 0 : priced.total;
        totalCost += cost;

        // Format ability name for display
        const abilityName = ability.abilityHrid
            .replace('/abilities/', '')
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        const abilityData = {
            hrid: ability.abilityHrid,
            name: `${abilityName} ${ability.level}`,
            cost: cost,
            unpriced,
            books: priced?.books ?? 0,
        };

        breakdown.push(abilityData);

        // Categorize as equipped or other
        if (equippedHrids.has(ability.abilityHrid)) {
            equippedCost += cost;
            equippedBreakdown.push(abilityData);
        } else {
            otherBreakdown.push(abilityData);
        }
    }

    // Sort all breakdowns by cost descending
    breakdown.sort((a, b) => b.cost - a.cost);
    equippedBreakdown.sort((a, b) => b.cost - a.cost);
    otherBreakdown.sort((a, b) => b.cost - a.cost);

    return {
        totalCost,
        equippedCost,
        breakdown,
        equippedBreakdown,
        otherBreakdown,
    };
}

/**
 * Cumulative cost of every guild shrine level the character has bought.
 *
 * A shrine level is paid for in guild credits and guild tokens. Credits have a
 * gold value — the cheapest tradeable items that convert into them, the rate the
 * guild exchange table quotes — so levels 1..current can be priced the way
 * houses and abilities are, at the same pricing mode as the rest of net worth.
 * Tokens cannot: nothing converts into them, so they are returned as a count for
 * the row's tooltip and never added to a gold figure.
 *
 * The levels ride on guild traffic that may not have arrived this session, in
 * which case data-manager hands back the reading it persisted, or nothing at
 * all. Nothing at all is reported as `known: false` so the display omits the row
 * rather than claiming the character has bought no shrine levels.
 *
 * @param {Object} characterGuildBuffMap - buffHrid → `{guildBuffHrid, level}`
 * @param {string} [pricingMode='ask'] - Pricing side, as the net worth setting selects it
 * @returns {{totalCost: number, tokens: number, breakdown: Array<Object>, known: boolean}}
 */
export function calculateGuildShrinesCost(characterGuildBuffMap, pricingMode = 'ask') {
    const detailMap = dataManager.getInitClientData()?.guildBuffDetailMap;
    if (!detailMap || !characterGuildBuffMap || Object.keys(characterGuildBuffMap).length === 0) {
        return { totalCost: 0, tokens: 0, breakdown: [], known: false };
    }

    // Built once and shared: every level of every shrine prices the same credits
    const goldPerCredit = buildGoldPerCredit(pricingMode);

    let totalCost = 0;
    let totalTokens = 0;
    const breakdown = [];

    for (const [buffHrid, entry] of Object.entries(characterGuildBuffMap)) {
        const level = Math.max(0, Math.floor(Number(entry?.level) || 0));
        const detail = detailMap[buffHrid];
        if (!detail || level <= 0) continue;

        let cost = 0;
        let tokens = 0;
        for (let step = 1; step <= level; step++) {
            const levelCost = detail.levelCosts?.[String(step)];
            if (!levelCost) continue;
            tokens += Math.max(0, Math.floor(Number(levelCost.guildTokenCost) || 0));
            // An unpriced credit contributes nothing rather than blocking the
            // whole row: this is a running total of what was spent, and one
            // credit type without a conversion should not blank the other four
            const { lines } = priceGuildCreditCosts(levelCost.creditCosts, { mode: pricingMode, goldPerCredit });
            for (const line of lines) cost += line.gold || 0;
        }

        totalCost += cost;
        totalTokens += tokens;

        // Named off the buff, not the shrine: Force sells a combat buff and a
        // skilling one, and two rows both called "Force" would be unreadable
        const buffName = buffHrid
            .replace('/guild_buffs/', '')
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        breakdown.push({ hrid: buffHrid, name: `${buffName} ${level}`, level, cost, tokens });
    }

    breakdown.sort((a, b) => b.cost - a.cost);

    return { totalCost, tokens: totalTokens, breakdown, known: true };
}

/**
 * Calculate values for multiple items in parallel using workers
 * @param {Array} items - Array of items to value
 * @param {Map} priceCache - Price cache
 * @param {Object} gameData - Game data
 * @returns {Promise<Array>} Array of values in same order as items
 */
/**
 * The flat price map a worker batch is handed, built once per price cache.
 *
 * Flattening the whole cache is O(prices) on the main thread, and one
 * recalculation used to do it twice — once for the equipped batch and once for
 * the inventory batch, most of a 100ms synchronous block each. The map only
 * depends on the cache, the pricing mode and the value source, so it is
 * memoised on the cache object itself and the build loop hands the browser a
 * frame on a clock, the same way the valuation loop does.
 *
 * The base key carries a **reconciled** price — what `getMarketPrice` would
 * return on this thread, via `resolveNetworthPrices`: the official value when
 * the value source says so, and otherwise the order book banded and, on a side
 * the book leaves empty, filled from the official value. The cache itself is
 * only clamped (`marketAPI.getPrice` bands what it hands out), so shipping its
 * raw sides left the worker valuing an illiquid item at its craft cost while
 * the main thread valued the identical item at the game's own figure. Full
 * reconciliation inside the worker is not worth its weight; doing it once here,
 * where the flatten already runs, costs one resolve per cached entry.
 *
 * `_ask` and `_bid` stay raw on purpose. They feed the worker's enhancement-cost
 * path, whose main-thread counterpart (`calculateEnhancementPath`) reads the
 * clamped order book through `getItemPrices` and never reconciles — so
 * reconciling them here would trade one divergence for another.
 */
const priceMapMemo = new WeakMap();

async function priceMapFor(priceCache, pricingMode) {
    if (!priceCache) return {};
    const valueSource = config.getSettingValue('networth_valueSource') || 'orderBook';
    const memo = priceMapMemo.get(priceCache);
    if (memo && memo.pricingMode === pricingMode && memo.valueSource === valueSource) return memo.priceMap;

    const priceMap = {};
    let sliceStart = performance.now();
    for (const [key, prices] of priceCache.entries()) {
        // "hrid:level" — an hrid carries no colon, so the last one splits it
        const split = key.lastIndexOf(':');
        const resolved = resolveNetworthPrices(key.slice(0, split), Number(key.slice(split + 1)) || 0, priceCache);

        if (typeof prices === 'number') {
            priceMap[key] = typeof resolved === 'number' ? resolved : prices;
        } else if (prices && typeof prices === 'object') {
            // Store ask and bid WITHOUT coalescing null to 0 (preserve null for "no data" vs "0 price")
            priceMap[key + '_ask'] = prices.ask;
            priceMap[key + '_bid'] = prices.bid;
            // Store selected pricing mode at the base key for worker item valuation.
            // Leave it unset when the mode price is missing so the worker falls
            // back to enhancement-cost calculation like calculateItemValue does,
            // instead of silently substituting ask.
            const modePrice = typeof resolved === 'number' ? resolved : resolved?.[pricingMode];
            if (modePrice && modePrice > 0) {
                priceMap[key] = modePrice;
            }
        } else {
            priceMap[key] = 0;
        }
        if (performance.now() - sliceStart > 12) {
            await yieldToBrowser();
            sliceStart = performance.now();
        }
    }
    priceMapMemo.set(priceCache, { pricingMode, valueSource, priceMap });
    return priceMap;
}

async function calculateItemValuesParallel(items, priceCache, gameData) {
    // Prepare configuration options
    const useHighEnhancementCost = config.getSetting('networth_highEnhancementUseCost');
    const minLevel = config.getSetting('networth_highEnhancementMinLevel') || 13;
    const enhancementParams = getEnhancingParams();
    const pricingMode = config.getSettingValue('networth_pricingMode') || 'ask';

    // Separate items into those that need workers vs those that don't
    const itemsNeedingWorkers = [];
    const itemsNotNeedingWorkers = [];
    const itemMapping = []; // Track which original index goes where

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const enhancementLevel = item.enhancementLevel || 0;

        // Check if this specific item needs worker processing
        let needsWorker = false;

        if (enhancementLevel >= 1) {
            // Check if high enhancement cost mode applies
            if (useHighEnhancementCost && enhancementLevel >= minLevel) {
                needsWorker = true;
            } else {
                // Check if the configured pricing mode's price is missing — valuation
                // uses that mode, so classifying on ask alone would run the expensive
                // enhancement-path fallback synchronously on the main thread. Resolve
                // the same way getMarketPrice will, so an item the official value can
                // price (or a book the value can fill) is not sent to the worker.
                const resolved = resolveNetworthPrices(item.itemHrid, enhancementLevel, priceCache);
                const hasMarketPrice =
                    resolved && (typeof resolved === 'number' ? resolved > 0 : resolved[pricingMode] > 0);

                if (!hasMarketPrice) {
                    needsWorker = true;
                }
            }
        }

        if (needsWorker) {
            itemMapping.push({ originalIndex: i, workerIndex: itemsNeedingWorkers.length, useWorker: true });
            itemsNeedingWorkers.push(item);
        } else {
            itemMapping.push({ originalIndex: i, sequentialIndex: itemsNotNeedingWorkers.length, useWorker: false });
            itemsNotNeedingWorkers.push(item);
        }
    }

    // Calculate both groups in parallel
    const [workerResults, sequentialResults] = await Promise.all([
        // Worker group
        itemsNeedingWorkers.length > 0
            ? (async () => {
                  const priceMap = await priceMapFor(priceCache, pricingMode);

                  try {
                      const values = await calculateItemValueBatch(
                          itemsNeedingWorkers,
                          priceMap,
                          { useHighEnhancementCost, minLevel, enhancementParams },
                          gameData
                      );
                      return values;
                  } catch (error) {
                      // Fallback to sequential for worker items
                      console.warn('[NetworthCalculator] Worker failed, falling back to sequential:', error);
                      const values = [];
                      for (const item of itemsNeedingWorkers) {
                          values.push(await calculateItemValue(item, priceCache));
                      }
                      return values;
                  }
              })()
            : Promise.resolve([]),

        // Sequential group
        itemsNotNeedingWorkers.length > 0
            ? (async () => {
                  const values = [];
                  // Yield on a clock, not a count: item costs vary by orders of
                  // magnitude, and what the frame budget cares about is time
                  const slow = [];
                  let sliceStart = performance.now();
                  for (const item of itemsNotNeedingWorkers) {
                      const itemStart = performance.now();
                      const value = await calculateItemValue(item, priceCache);
                      const itemMs = performance.now() - itemStart;
                      // One item over the frame budget is an indivisible chunk
                      // no slicing can help — record it so the next stall hunt
                      // reads a name instead of re-instrumenting
                      if (itemMs > 15) {
                          slow.push({
                              itemHrid: item.itemHrid,
                              enhancementLevel: item.enhancementLevel || 0,
                              ms: Math.round(itemMs),
                          });
                      }
                      values.push(value);
                      if (performance.now() - sliceStart > 12) {
                          await yieldToBrowser();
                          sliceStart = performance.now();
                      }
                  }
                  lastSlowItems = slow;
                  return values;
              })()
            : Promise.resolve([]),
    ]);

    // Reconstruct results in original order
    const finalResults = new Array(items.length);
    for (const mapping of itemMapping) {
        if (mapping.useWorker) {
            finalResults[mapping.originalIndex] = workerResults[mapping.workerIndex];
        } else {
            finalResults[mapping.originalIndex] = sequentialResults[mapping.sequentialIndex];
        }
    }

    return finalResults;
}

/**
 * Calculate total networth
 * @returns {Promise<Object>} Networth data with breakdowns
 */
export async function calculateNetworth() {
    // Where the time went, phase by phase, for the last run — readable at
    // `Toolasha.Market.networthCalculator.lastCalcPhases` when hunting a stall. Kept always-on
    // because recording eight numbers costs nothing and the 2026-08-29 stutter
    // hunt spent its hours exactly here, guessing.
    const phases = {};
    let phaseStart = performance.now();
    const phase = (name) => {
        phases[name] = Math.round(performance.now() - phaseStart);
        phaseStart = performance.now();
    };

    const gameData = dataManager.getCombinedData();
    if (!gameData) {
        console.error('[Networth] No game data available');
        return createEmptyNetworthData();
    }

    // Ensure market data is loaded (check in-memory first to avoid storage reads)
    if (!marketAPI.isLoaded()) {
        const marketData = await marketAPI.fetch();
        if (!marketData) {
            console.error('[Networth] Failed to fetch market data');
            return createEmptyNetworthData();
        }
    }

    // Invalidate cache if market data changed (wrap for cache compatibility)
    networthCache.checkAndInvalidate({ marketData: marketAPI.marketData });

    const characterItems = gameData.characterItems || [];
    const marketListings = gameData.myMarketListings || [];
    const characterHouseRooms = gameData.characterHouseRoomMap || {};
    const characterAbilities = gameData.characterAbilities || [];
    const abilityCombatTriggersMap = gameData.abilityCombatTriggersMap || {};

    // OPTIMIZATION: Pre-fetch all market prices in one batch
    const itemsToPrice = [];
    const itemsToFetch = new Set();

    // Helper to recursively add upgrade items
    const addItemWithUpgrades = (itemHrid) => {
        if (itemsToFetch.has(itemHrid)) return; // Already added
        itemsToFetch.add(itemHrid);

        // The crafting action for this item, from the once-built index — the
        // per-item actionDetailMap scan this replaces was O(items × actions)
        const action = getActionIndexes()?.byPrimaryOutput.get(itemHrid);
        if (action) {
            // Add all input materials to price fetch list
            if (action.inputItems) {
                for (const input of action.inputItems) {
                    if (!itemsToFetch.has(input.itemHrid)) {
                        itemsToFetch.add(input.itemHrid);
                    }
                }
            }

            // If this item has an upgrade item (e.g., refined items), recursively fetch that too
            if (action.upgradeItemHrid) {
                addItemWithUpgrades(action.upgradeItemHrid); // Recursive call
            }
        }
    };

    // What an enhanced item's valuation reaches for beyond its own recipe: the
    // materials each attempt burns, and whatever can protect it. The worker
    // prices all of these out of this same cache (see the closure walk in
    // networth-worker-manager.js), and none of them were ever collected — so
    // they crossed the thread boundary unpriced and the worker fell back to
    // sellPrice or production cost for materials the main thread was quoting at
    // the live market.
    let hasEnhancedItem = false;
    const addEnhancementInputs = (itemHrid) => {
        hasEnhancedItem = true;
        const details = gameData.itemDetailMap?.[itemHrid];
        if (!details) return;
        for (const material of details.enhancementCosts || []) addItemWithUpgrades(material.itemHrid);
        for (const protHrid of details.protectionItemHrids || []) addItemWithUpgrades(protHrid);
    };

    // Collect all items that need pricing
    for (const item of characterItems) {
        itemsToPrice.push({ itemHrid: item.itemHrid, enhancementLevel: item.enhancementLevel || 0 });
        addItemWithUpgrades(item.itemHrid); // Add upgrade chain
        if ((item.enhancementLevel || 0) >= 1) addEnhancementInputs(item.itemHrid);
    }

    // Collect market listings items
    for (const listing of marketListings) {
        itemsToPrice.push({ itemHrid: listing.itemHrid, enhancementLevel: listing.enhancementLevel || 0 });
        addItemWithUpgrades(listing.itemHrid); // Add upgrade chain
        if ((listing.enhancementLevel || 0) >= 1) addEnhancementInputs(listing.itemHrid);
    }

    // The two mirrors are reachable from every enhancement path — the
    // Philosopher's Mirror shortcut and the universal protection item — so they
    // are collected once for the character rather than once per item
    if (hasEnhancedItem) {
        addItemWithUpgrades('/items/philosophers_mirror');
        addItemWithUpgrades('/items/mirror_of_protection');
    }

    // Add all collected base items at enhancement level 0
    for (const itemHrid of itemsToFetch) {
        itemsToPrice.push({ itemHrid, enhancementLevel: 0 });
    }

    // Batch fetch all prices at once (eliminates ~400 redundant lookups)
    const priceCache = marketAPI.getPricesBatch(itemsToPrice);
    phase('collectAndPrice');

    // Precompute loadout-excluded item hrids: Map<itemHrid → loadoutName>
    const loadoutExcludedHridToName = new Map();
    const loadoutExclusions = getExclusions().filter((e) => e.type === 'loadout');
    if (loadoutExclusions.length > 0) {
        const allSnapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots();
        for (const exc of loadoutExclusions) {
            const snapshot = allSnapshots.find((s) => s.name === exc.value);
            if (snapshot) {
                for (const eq of snapshot.equipment) {
                    if (!loadoutExcludedHridToName.has(eq.itemHrid)) {
                        loadoutExcludedHridToName.set(eq.itemHrid, exc.value);
                    }
                }
            }
        }
    }

    // Accumulate excluded amounts keyed by type:value
    const excludedByKey = new Map();
    const trackExcluded = (type, value, name, amount) => {
        const key = `${type}:${value}`;
        if (!excludedByKey.has(key)) {
            excludedByKey.set(key, { type, value, name, amount: 0 });
        }
        excludedByKey.get(key).amount += amount;
    };

    // Calculate equipped items value using workers
    let equippedValue = 0;
    const equippedBreakdown = [];

    const entireEquippedExcluded = isExcluded('assetType', 'equipped');
    const equippedItems = characterItems.filter((item) => item.itemLocationHrid !== '/item_locations/inventory');
    const equippedValues = await calculateItemValuesParallel(equippedItems, priceCache, gameData);

    for (let i = 0; i < equippedItems.length; i++) {
        const item = equippedItems[i];
        const value = equippedValues[i];

        const itemDetails = gameData.itemDetailMap[item.itemHrid];
        const itemName = itemDetails?.name || item.itemHrid.replace('/items/', '');
        const displayName = item.enhancementLevel > 0 ? `${itemName} +${item.enhancementLevel}` : itemName;

        // Check exclusions in priority order: assetType > item > loadout
        if (entireEquippedExcluded) {
            trackExcluded('assetType', 'equipped', 'All Equipped Items', value);
            continue;
        }
        if (isExcluded('item', item.itemHrid)) {
            trackExcluded('item', item.itemHrid, displayName, value);
            continue;
        }
        const loadoutName = loadoutExcludedHridToName.get(item.itemHrid);
        if (loadoutName) {
            trackExcluded('loadout', loadoutName, `Loadout: ${loadoutName}`, value);
            continue;
        }

        equippedValue += value;
        equippedBreakdown.push({
            name: displayName,
            value,
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel || 0,
        });
    }

    phase('equipped');

    // Calculate inventory items value using workers
    let inventoryValue = 0;
    const inventoryBreakdown = [];
    const inventoryByCategory = {};

    // Separate ability books for Fixed Assets section
    let abilityBooksValue = 0;
    const abilityBooksBreakdown = [];

    // Track gold coins separately for header display
    let coinCount = 0;
    // And separately again, the coins that survived the exclusions. Coin is an
    // excludable item like any other, and every other snapshot field the
    // history records is post-exclusion — so a `gold` recorded as the full
    // balance while `inventory` no longer carries it made the chart's
    // inventory-less-gold line dive by the whole coin balance
    let countedCoins = 0;

    const inventoryItems = characterItems.filter((item) => item.itemLocationHrid === '/item_locations/inventory');
    const inventoryValues = await calculateItemValuesParallel(inventoryItems, priceCache, gameData);
    phase('inventoryValues');

    for (let i = 0; i < inventoryItems.length; i++) {
        const item = inventoryItems[i];
        const value = inventoryValues[i];

        // Extract coin count for header display (always track regardless of exclusion)
        if (item.itemHrid === '/items/coin') {
            coinCount = item.count || 0;
        }

        // Add to breakdown
        const itemDetails = gameData.itemDetailMap[item.itemHrid];
        const itemName = itemDetails?.name || item.itemHrid.replace('/items/', '');
        const displayName = item.enhancementLevel > 0 ? `${itemName} +${item.enhancementLevel}` : itemName;

        const itemData = {
            name: displayName,
            value,
            count: item.count,
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel || 0,
            isOpenable: itemDetails?.isOpenable === true,
            // A currency the shop cannot price yet contributes 0 — the same
            // situation the ability rows already distinguish from "worth nothing"
            unpriced: value === 0 && isUnpricedCurrency(item.itemHrid),
        };

        // Check if this is an ability book
        const categoryHrid = itemDetails?.categoryHrid || '/item_categories/other';
        const isAbilityBook = categoryHrid === '/item_categories/ability_book';
        const booksAsInventory = config.getSetting('networth_abilityBooksAsInventory') === true;

        // Check item-level and category-level exclusions
        if (isExcluded('item', item.itemHrid)) {
            trackExcluded('item', item.itemHrid, displayName, value);
            continue;
        }
        // Coin is never excluded by category — it must be excluded individually
        if (item.itemHrid !== '/items/coin' && isExcluded('category', categoryHrid)) {
            const categoryName = gameData.itemCategoryDetailMap?.[categoryHrid]?.name || 'Other';
            trackExcluded('category', categoryHrid, `${categoryName} (category)`, value);
            continue;
        }
        if (isAbilityBook && !booksAsInventory && isExcluded('assetType', 'abilityBooks')) {
            trackExcluded('assetType', 'abilityBooks', 'All Ability Books', value);
            continue;
        }

        if (isAbilityBook && !booksAsInventory) {
            // Add to ability books (Fixed Assets)
            abilityBooksValue += value;
            abilityBooksBreakdown.push(itemData);
        } else {
            // Add to regular inventory (Current Assets)
            inventoryValue += value;
            inventoryBreakdown.push(itemData);
            if (item.itemHrid === '/items/coin') {
                countedCoins = item.count || 0;
            }

            // Coin is always listed individually — never bucketed into a category
            if (item.itemHrid !== '/items/coin') {
                const categoryName = gameData.itemCategoryDetailMap?.[categoryHrid]?.name || 'Other';

                if (!inventoryByCategory[categoryName]) {
                    inventoryByCategory[categoryName] = {
                        items: [],
                        totalValue: 0,
                        categoryHrid,
                    };
                }

                inventoryByCategory[categoryName].items.push(itemData);
                inventoryByCategory[categoryName].totalValue += value;
            }
        }
    }

    // Sort items within each category by value descending
    for (const category of Object.values(inventoryByCategory)) {
        category.items.sort((a, b) => b.value - a.value);
    }

    // Sort ability books by value descending
    abilityBooksBreakdown.sort((a, b) => b.value - a.value);

    phase('inventoryBreakdown');

    // Calculate market listings value
    let listingsValue = 0;
    const listingsBreakdown = [];
    const clientData = dataManager.getInitClientData();

    for (const listing of marketListings) {
        // A listing the game has ended is no longer holding anything on the
        // market: whatever it did not trade has already moved into the
        // unclaimed counts, and taxing it again (or counting the remainder as
        // still locked) would value the same coins twice.
        const ended = listing.status && listing.status !== '/market_listing_status/active';
        const quantity = ended ? 0 : listing.orderQuantity - listing.filledQuantity;
        const enhancementLevel = listing.enhancementLevel || 0;
        const itemName = clientData?.itemDetailMap?.[listing.itemHrid]?.name || listing.itemHrid;

        if (listing.isSell) {
            // Selling: value is locked in listing + unclaimed coins
            // Apply marketplace fee (cowbells are taxed higher than everything else)
            const fee = ended ? 0 : listing.itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX;

            // Still on the market: the units yet to sell, taxed at what they
            // would net. Ended: the units handed back, untaxed and yours
            const value = await calculateItemValue(
                {
                    itemHrid: listing.itemHrid,
                    enhancementLevel,
                    count: ended ? listing.unclaimedItemCount || 0 : quantity,
                },
                priceCache
            );

            const listingValue = value * (1 - fee) + listing.unclaimedCoinCount;
            listingsValue += listingValue;
            listingsBreakdown.push({
                itemHrid: listing.itemHrid,
                enhancementLevel,
                name: itemName,
                isSell: true,
                value: listingValue,
            });
        } else {
            // Buying: value is locked coins + unclaimed items
            const unclaimedValue = await calculateItemValue(
                { itemHrid: listing.itemHrid, enhancementLevel, count: listing.unclaimedItemCount },
                priceCache
            );

            // Unclaimed coins are yours whatever the listing's status. On an
            // ended order they are the refund of what never filled; on a live
            // one they are the price improvement a fill was cheaper by, and
            // those coins were dropped from the total entirely — the market
            // header's own "unclaimed" figure counts them on every listing.
            // They cannot double-count `quantity * price`, which is what is
            // still locked against the units that have *not* filled.
            const listingValue = quantity * listing.price + unclaimedValue + (listing.unclaimedCoinCount || 0);
            listingsValue += listingValue;
            listingsBreakdown.push({
                itemHrid: listing.itemHrid,
                enhancementLevel,
                name: itemName,
                isSell: false,
                value: listingValue,
            });
        }
    }

    listingsBreakdown.sort((a, b) => b.value - a.value);

    // Apply listings exclusion
    if (isExcluded('assetType', 'listings') && listingsValue > 0) {
        trackExcluded('assetType', 'listings', 'All Market Listings', listingsValue);
        listingsValue = 0;
    }

    phase('listings');

    // Calculate houses value — apply per-room and whole-section exclusions
    let housesData = calculateAllHousesCost(characterHouseRooms);
    if (isExcluded('assetType', 'houses') && housesData.totalCost > 0) {
        trackExcluded('assetType', 'houses', 'All Houses', housesData.totalCost);
        housesData = { totalCost: 0, breakdown: [] };
    } else {
        let excludedRoomCost = 0;
        const remainingRooms = [];
        for (const room of housesData.breakdown) {
            if (isExcluded('houseRoom', room.hrid)) {
                trackExcluded('houseRoom', room.hrid, room.name, room.cost);
                excludedRoomCost += room.cost;
            } else {
                remainingRooms.push(room);
            }
        }
        if (excludedRoomCost > 0) {
            housesData = { totalCost: housesData.totalCost - excludedRoomCost, breakdown: remainingRooms };
        }
    }

    // Calculate abilities value — apply per-ability and whole-section exclusions
    let abilitiesData = calculateAllAbilitiesCost(characterAbilities, abilityCombatTriggersMap);
    if (isExcluded('assetType', 'abilities') && abilitiesData.totalCost > 0) {
        trackExcluded('assetType', 'abilities', 'All Abilities', abilitiesData.totalCost);
        abilitiesData = {
            totalCost: 0,
            equippedCost: 0,
            breakdown: [],
            equippedBreakdown: [],
            otherBreakdown: [],
        };
    } else {
        let excludedAbilityCost = 0;
        let excludedEquippedCost = 0;
        const remainingBreakdown = [];
        const remainingEquipped = [];
        const remainingOther = [];
        const equippedHridSet = new Set(abilitiesData.equippedBreakdown.map((a) => a.hrid));
        for (const ability of abilitiesData.breakdown) {
            if (isExcluded('ability', ability.hrid)) {
                trackExcluded('ability', ability.hrid, ability.name, ability.cost);
                excludedAbilityCost += ability.cost;
                if (equippedHridSet.has(ability.hrid)) {
                    excludedEquippedCost += ability.cost;
                }
            } else {
                remainingBreakdown.push(ability);
                if (equippedHridSet.has(ability.hrid)) {
                    remainingEquipped.push(ability);
                } else {
                    remainingOther.push(ability);
                }
            }
        }
        if (excludedAbilityCost > 0) {
            abilitiesData = {
                totalCost: abilitiesData.totalCost - excludedAbilityCost,
                equippedCost: abilitiesData.equippedCost - excludedEquippedCost,
                breakdown: remainingBreakdown,
                equippedBreakdown: remainingEquipped,
                otherBreakdown: remainingOther,
            };
        }
    }

    // Calculate guild shrines value — apply per-shrine and whole-section exclusions.
    // The levels are not part of getCombinedData(): they arrive on guild traffic
    // rather than with the character, and data-manager holds them separately.
    let guildShrinesData = calculateGuildShrinesCost(
        dataManager.characterGuildBuffMap,
        config.getSettingValue('networth_pricingMode') || 'ask'
    );
    if (isExcluded('assetType', 'guildShrines') && guildShrinesData.totalCost > 0) {
        trackExcluded('assetType', 'guildShrines', 'All Guild Shrines', guildShrinesData.totalCost);
        guildShrinesData = { totalCost: 0, tokens: 0, breakdown: [], known: guildShrinesData.known };
    } else {
        let excludedShrineCost = 0;
        let excludedShrineTokens = 0;
        const remainingShrines = [];
        for (const shrine of guildShrinesData.breakdown) {
            if (isExcluded('guildShrine', shrine.hrid)) {
                trackExcluded('guildShrine', shrine.hrid, shrine.name, shrine.cost);
                excludedShrineCost += shrine.cost;
                excludedShrineTokens += shrine.tokens;
            } else {
                remainingShrines.push(shrine);
            }
        }
        if (excludedShrineCost > 0 || excludedShrineTokens > 0) {
            guildShrinesData = {
                totalCost: guildShrinesData.totalCost - excludedShrineCost,
                tokens: guildShrinesData.tokens - excludedShrineTokens,
                breakdown: remainingShrines,
                known: guildShrinesData.known,
            };
        }
    }

    phase('housesAbilitiesShrines');

    // Build excluded summary
    const excludedItems = [...excludedByKey.values()].sort((a, b) => b.amount - a.amount);
    const excludedTotal = excludedItems.reduce((sum, e) => sum + e.amount, 0);

    // Calculate totals
    const currentAssetsTotal = equippedValue + inventoryValue + listingsValue;
    const fixedAssetsTotal =
        housesData.totalCost + abilitiesData.totalCost + abilityBooksValue + guildShrinesData.totalCost;
    const totalNetworth = currentAssetsTotal + fixedAssetsTotal;

    phase('totals');
    lastCalcPhases = phases;

    // Sort breakdowns by value descending
    equippedBreakdown.sort((a, b) => b.value - a.value);
    inventoryBreakdown.sort((a, b) => b.value - a.value);

    return {
        totalNetworth,
        coins: coinCount,
        countedCoins,
        excluded: { total: excludedTotal, items: excludedItems },
        currentAssets: {
            total: currentAssetsTotal,
            equipped: { value: equippedValue, breakdown: equippedBreakdown },
            inventory: {
                value: inventoryValue,
                breakdown: inventoryBreakdown,
                byCategory: inventoryByCategory,
            },
            listings: { value: listingsValue, breakdown: listingsBreakdown },
        },
        fixedAssets: {
            total: fixedAssetsTotal,
            houses: housesData,
            abilities: abilitiesData,
            abilityBooks: {
                totalCost: abilityBooksValue,
                breakdown: abilityBooksBreakdown,
            },
            guildShrines: guildShrinesData,
        },
    };
}

/**
 * Create empty networth data structure
 * @returns {Object} Empty networth data
 */
function createEmptyNetworthData() {
    return {
        totalNetworth: 0,
        coins: 0,
        countedCoins: 0,
        excluded: { total: 0, items: [] },
        currentAssets: {
            total: 0,
            equipped: { value: 0, breakdown: [] },
            inventory: { value: 0, breakdown: [], byCategory: {} },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            total: 0,
            houses: { totalCost: 0, breakdown: [] },
            abilities: {
                totalCost: 0,
                equippedCost: 0,
                breakdown: [],
                equippedBreakdown: [],
                otherBreakdown: [],
            },
            abilityBooks: {
                totalCost: 0,
                breakdown: [],
            },
            guildShrines: { totalCost: 0, tokens: 0, breakdown: [], known: false },
        },
    };
}
