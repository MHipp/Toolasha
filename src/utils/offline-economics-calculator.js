/**
 * Offline Economics Calculator
 *
 * Values a Welcome Back offline session — what the night produced, what it ate, and the
 * difference — from the signed item deltas the server sends with `init_character_data`,
 * rather than from anything scraped off the modal.
 *
 * It deliberately owns no pricing of its own: gains go through the expected-value
 * calculator's sell-side resolver (Coin, Cowbell, dungeon tokens, container EV, custom
 * overrides, market price) and losses through its buy-side mirror, so these figures agree
 * with every other profit number in the script and change with the pricing mode like they do.
 *
 * An item it cannot price is never counted as zero. It is returned in `unvaluedItems` and
 * sets `isPartial`, because a total that quietly under-reports is worse than one that says
 * what it is missing.
 */

import dataManager from '../core/data-manager.js';
import expectedValueCalculator from '../features/market/expected-value-calculator.js';
import { calculateTaskTokenValue } from '../features/tasks/task-profit-calculator.js';
import { calculatePriceAfterTax } from './profit-helpers.js';
import { MARKET_TAX } from './profit-constants.js';

const TASK_TOKEN_HRID = '/items/task_token';
const SECONDS_PER_DAY = 86400;

/**
 * Resolve one item's unit value for a given transaction side.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @param {'sell'|'buy'} side - 'sell' for a gained item, 'buy' for a consumed one
 * @param {Object|null} itemDetails - dataManager.getItemDetails(itemHrid) result
 * @returns {{value: number, source: string}|null} Resolved unit value, or null when unavailable
 */
function resolveUnitValue(itemHrid, enhancementLevel, side, itemDetails) {
    // Task Tokens have no market of their own; the task calculator prices them off what they buy
    if (itemHrid === TASK_TOKEN_HRID) {
        const tokenData = calculateTaskTokenValue();
        if (tokenData?.error || !(tokenData?.tokenValue > 0)) return null;
        return { value: tokenData.tokenValue, source: 'taskToken' };
    }

    if (side === 'sell') {
        const resolved = expectedValueCalculator.resolveSellSideValue(itemHrid, enhancementLevel);
        if (!resolved) return null;
        const value =
            resolved.needsTax && itemDetails?.isTradable !== false
                ? calculatePriceAfterTax(resolved.value, MARKET_TAX)
                : resolved.value;
        return { value, source: resolved.source };
    }

    const resolved = expectedValueCalculator.resolveBuySideValue(itemHrid, enhancementLevel);
    return resolved ? { value: resolved.value, source: resolved.source } : null;
}

/**
 * Calculate the economic result of a Welcome Back offline session.
 * @param {Object} params - Offline session inputs
 * @param {Array<{itemHrid: string, enhancementLevel?: number, offlineCount: number}>} params.offlineItems
 *   - Signed offline item deltas: positive offlineCount = gained, negative = consumed
 * @param {string} params.currentTimestamp - ISO timestamp from the init_character_data payload
 * @param {string} params.lastOfflineTime - ISO timestamp the character went offline
 * @param {number|null} [params.offlineHourCap] - The character's server-resolved offline-progress
 *   hour cap (characterInfo.offlineHourCap), or null/undefined when not known
 * @returns {Object} { revenue, cost, profit, revenuePerDay, costPerDay, profitPerDay,
 *   durationSeconds, isPartial, unvaluedItems, lines, awayHours, offlineHourCap, overrunHours,
 *   overrunValue }
 */
export function calculateOfflineEconomics({ offlineItems, currentTimestamp, lastOfflineTime, offlineHourCap }) {
    let revenue = 0;
    let cost = 0;
    let isPartial = false;
    const unvaluedItems = [];
    const lines = [];

    for (const item of offlineItems || []) {
        const { itemHrid, offlineCount } = item;
        const enhancementLevel = item.enhancementLevel || 0;
        if (!itemHrid || !offlineCount) continue;

        const side = offlineCount > 0 ? 'sell' : 'buy';
        const quantity = Math.abs(offlineCount);
        const itemDetails = dataManager.getItemDetails(itemHrid);

        const resolved = resolveUnitValue(itemHrid, enhancementLevel, side, itemDetails);
        if (!resolved) {
            isPartial = true;
            unvaluedItems.push({ itemHrid, enhancementLevel, offlineCount });
            continue;
        }

        const totalValue = resolved.value * quantity;
        if (side === 'sell') {
            revenue += totalValue;
        } else {
            cost += totalValue;
        }

        lines.push({
            itemHrid,
            enhancementLevel,
            quantity,
            side,
            unitValue: resolved.value,
            totalValue,
            source: resolved.source,
        });
    }

    const profit = revenue - cost;

    // A clock that ran backwards, or a session with no measurable length, gets no rates at all
    // rather than an infinity — the totals still stand on their own.
    const durationMs = new Date(currentTimestamp).getTime() - new Date(lastOfflineTime).getTime();
    const durationSeconds = durationMs > 0 ? durationMs / 1000 : 0;
    const perDay = (value) => (durationSeconds > 0 ? (value * SECONDS_PER_DAY) / durationSeconds : null);

    // The game only ever rewards up to offlineHourCap hours; anything past that earned nothing.
    // A missing/zero cap or an unreadable window (durationSeconds falls back to 0 above) leaves
    // this whole picture unknown rather than guessed at.
    const awayHours = durationSeconds / 3600;
    const hasKnownCap = typeof offlineHourCap === 'number' && offlineHourCap > 0;
    const overrunHours = hasKnownCap && awayHours > offlineHourCap ? awayHours - offlineHourCap : 0;
    // Same rate this very haul's own profitPerDay is built from — profit earned over the hours
    // that actually counted — just anchored to the capped hours instead of the full clock time,
    // so the overrun is costed at what this session actually earned per credited hour rather
    // than a second, invented rate.
    const overrunValue = overrunHours > 0 ? (profit / offlineHourCap) * overrunHours : null;

    return {
        revenue,
        cost,
        profit,
        revenuePerDay: perDay(revenue),
        costPerDay: perDay(cost),
        profitPerDay: perDay(profit),
        durationSeconds,
        isPartial,
        unvaluedItems,
        lines,
        awayHours,
        offlineHourCap: hasKnownCap ? offlineHourCap : null,
        overrunHours,
        overrunValue,
    };
}
