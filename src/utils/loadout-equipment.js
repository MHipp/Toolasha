/**
 * Pure helpers for what a saved loadout actually equips.
 *
 * Split out of `features/combat/loadout-snapshot.js` so a caller outside the
 * combat bundle can answer "what level of this item would that loadout wear"
 * without importing that module's snapshot store — a module-level cache with
 * its own WebSocket subscription — across a bundle boundary (see
 * `scripts/check-bundle-sharing.mjs`, which polices exactly that). These three
 * functions hold no state of their own: `highestOwnedEnhancements` reads
 * whatever inventory it is handed (or the live one, as a default) and returns
 * a fresh Map every call; the other two are pure over their arguments. A
 * second inlined copy in another bundle is only weight, never a second truth.
 *
 * `loadout-snapshot.js` re-exports `highestOwnedEnhancements` and
 * `resolveEnhancementLevel` for its own existing callers/tests; new code
 * should import from here.
 */

import dataManager from '../core/data-manager.js';

/**
 * Parse a wearable hash string into itemLocationHrid, itemHrid, and enhancementLevel.
 * Format: "characterId::/item_locations/location::/items/item_hrid::enhancementLevel"
 * Empty string means no item in that slot.
 * @param {string} itemLocationHrid - The equipment slot key (e.g. "/item_locations/body")
 * @param {string} wearableHash - The wearable hash value
 * @returns {{ itemLocationHrid: string, itemHrid: string, enhancementLevel: number }|null}
 */
export function parseWearable(itemLocationHrid, wearableHash) {
    if (!wearableHash) return null;

    const parts = wearableHash.split('::');
    const itemHrid = parts.find((p) => p.startsWith('/items/'));
    if (!itemHrid) return null;

    const lastPart = parts[parts.length - 1];
    const enhancementLevel = !lastPart.startsWith('/') ? parseInt(lastPart, 10) || 0 : 0;

    return { itemLocationHrid, itemHrid, enhancementLevel };
}

/**
 * The best enhancement level owned of every item, from the inventory.
 *
 * Equipped pieces are in `characterItems` alongside the loose ones, so this
 * covers what is worn as well as what is in the bag — which is what "highest
 * owned" means to the game.
 *
 * @param {Array<Object>} [items] - Defaults to the live inventory
 * @returns {Map<string, number>} Item hrid → highest enhancement level owned
 */
export function highestOwnedEnhancements(items) {
    const inventory = items || dataManager.characterItems || dataManager.characterData?.characterItems || [];
    const highest = new Map();
    for (const item of inventory) {
        // Equipped items don't reliably carry a count field the way stacked
        // inventory items do — requiring count > 0 dropped them, letting a
        // lower-enhancement duplicate in the bag outrank the actually-equipped
        // higher copy. Skip only an explicit zero (a stack that was consumed).
        if (!item?.itemHrid || item.count === 0) continue;
        const level = item.enhancementLevel || 0;
        if (!highest.has(item.itemHrid) || level > highest.get(item.itemHrid)) {
            highest.set(item.itemHrid, level);
        }
    }
    return highest;
}

/**
 * What one slot of a loadout is really wearing.
 *
 * A loadout pinned with "use exact enhancement" wears what it says. Every other
 * loadout wears the best copy owned, so a stored level is a stale reading of
 * that rather than a fact — it is the level at the moment the loadout was last
 * saved, and enhancing the item since does not rewrite it.
 *
 * Never lower than what is stored: an inventory that has not arrived yet is an
 * empty map, and dropping a known +10 to 0 on the strength of it would be worse
 * than the staleness this is here to fix.
 *
 * @param {Object} snapshot - The loadout (or a raw `characterLoadoutMap` entry
 *   — both carry `useExactEnhancement`)
 * @param {Object} equip - One parsed equipment entry ({itemHrid, enhancementLevel})
 * @param {Map<string, number>} owned - From `highestOwnedEnhancements`
 * @returns {number} Enhancement level
 */
export function resolveEnhancementLevel(snapshot, equip, owned) {
    const stored = equip?.enhancementLevel || 0;
    if (snapshot?.useExactEnhancement) return stored;
    const highest = owned?.get(equip?.itemHrid);
    return highest === undefined ? stored : Math.max(stored, highest);
}
