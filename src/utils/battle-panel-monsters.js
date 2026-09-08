/**
 * Recovering monster names after a reload
 *
 * A `battle_updated` tick carries `cHP`, `cMP` and two counters per monster, and
 * nothing that says what the monster is. Identity arrives once, in `new_battle`,
 * and a page reloaded mid-fight never sees that message — so everything that hits
 * you for the rest of that battle is filed under "Unknown Enemy", and so is
 * everything you kill in it. MCS has the same hole for the same reason.
 *
 * The names do exist, though: the game is drawing them on screen. Each monster in
 * the battle panel is a tile with its name and its health bar, and the health bar
 * is the useful part — it is the same number the tick reports as `cHP`.
 *
 * ## Matched by health, not by position
 *
 * The obvious join is positional: the first tile is monster 0. That is an
 * assumption about how the panel handles a dead monster, which is exactly the
 * kind of assumption that is right until a game update and then silently
 * mis-attributes everything. Health is a fact both sides state, so it is what
 * the two are matched on.
 *
 * Two monsters at the same health are ambiguous, and the ambiguity resolves
 * itself: if the candidates all have the same name it does not matter which one
 * it is, and if they do not, nothing is claimed. A wave of three Eyes at full
 * health is the common case and it is the harmless one.
 *
 * ## It fails closed
 *
 * Every part of this reads the game's DOM, which is not a contract. A missing
 * panel, a renamed class, a tile whose text no longer starts with the name — each
 * of them produces nothing, and nothing means the tracker carries on saying
 * "Unknown Enemy" exactly as it does today. Nothing here can produce a wrong
 * name where there was previously a right one.
 */

import { parseGameNumber, gameDigitsSource } from './number-parser.js';

const MONSTER_AREA = '[class*="BattlePanel_monstersArea"]';
const UNIT_GRID = '[class*="BattlePanel_combatUnitGrid"]';

/**
 * A health bar, alone in its own element: `1,348/2,035` (or, in a
 * period-grouping locale, `1.348/2.035`).
 *
 * Built fresh on every call rather than compiled once into a module-level
 * constant: a health value carries no decimal, but its grouping character is
 * whatever the game's current locale uses, and a `RegExp` frozen at import
 * time would stay on whatever locale happened to be active on first load.
 *
 * @returns {RegExp} Matches a bare "current/max" reading
 */
function barPattern() {
    const digits = gameDigitsSource({ decimal: false });
    return new RegExp(`^(${digits})\\s*\\/\\s*(${digits})$`);
}

/**
 * Any health bar, for the fallback when the bars are not their own elements.
 * @returns {RegExp} Matches a "current/max" reading anywhere in the text
 */
function looseBarPattern() {
    const digits = gameDigitsSource({ decimal: false });
    return new RegExp(`(${digits})\\s*\\/\\s*(${digits})`);
}

/**
 * @param {string} text - A number with separators
 * @returns {number} NaN when it is not one
 */
function toNumber(text) {
    return parseGameNumber(text);
}

/**
 * The text of every leaf element inside a tile, in order.
 *
 * Per element rather than the tile's `textContent`, because flattening a tile
 * runs its two bars together: `2215/2215` above `2215/2215` becomes
 * `2215/22152215/2215`, and there is then no way to tell where the first bar's
 * denominator ends. The first draft read the health right by luck and the
 * maximum as `22152215`.
 *
 * @param {HTMLElement} tile - A unit tile
 * @returns {Array<string>} Non-empty trimmed texts
 */
function leafTexts(tile) {
    const texts = [];
    for (const node of tile.querySelectorAll?.('*') || []) {
        if (node.children.length) continue;

        const text = node.textContent.trim();
        if (text) texts.push(text);
    }
    return texts;
}

/**
 * One tile's name and health, from its parts.
 *
 * The name is the first part with no digit in it. A tile's parts run
 * `Eyes`, `2215/2215`, `2215/2215`, `T2`, `Auto Attack`, `0/s`, and only the
 * first and `Auto Attack` have no digits — so first wins. Reaching for an inner
 * class instead would be one more thing to break at the next patch.
 *
 * Only the current health is taken. The bar's denominator is the monster's full
 * health, which is what a kill is worth — but every tick states that as `mHP`,
 * on every monster it mentions, so reading it off the screen would be a second
 * and worse source for a number the payload already gives.
 *
 * @param {Array<string>} texts - The tile's parts, in order
 * @returns {{name: string, hp: number}|null} Null when it is not a unit tile
 */
export function parseUnitTexts(texts) {
    const parts = (texts || []).map((text) => String(text).trim()).filter(Boolean);
    const name = parts.find((text) => !/\d/.test(text));
    if (!name) return null;

    const exact = parts.map((text) => text.match(barPattern())).find(Boolean);
    const bar = exact || parts.join(' ').match(looseBarPattern());
    if (!bar) return null;

    const hp = toNumber(bar[1]);
    return Number.isFinite(hp) ? { name, hp } : null;
}

/**
 * One tile, read from the page.
 *
 * @param {HTMLElement} tile - A unit tile
 * @returns {{name: string, hp: number}|null}
 */
export function parseUnit(tile) {
    const texts = leafTexts(tile);
    return parseUnitTexts(texts.length ? texts : [tile?.textContent || '']);
}

/**
 * The monsters the game is currently drawing.
 *
 * @param {Document|HTMLElement} [root] - Where to look
 * @returns {Array<{name: string, hp: number}>} Empty when the panel is not up
 */
export function readMonsterUnits(root = document) {
    const area = root.querySelector?.(MONSTER_AREA);
    if (!area) return [];

    const grid = area.querySelector(UNIT_GRID) || area;
    return [...grid.children].map(parseUnit).filter(Boolean);
}

/**
 * Which drawn monster is which slot of the tick, joined on health.
 *
 * @param {Array<{name: string, hp: number}>} units - From `readMonsterUnits`
 * @param {Object} mMap - The tick's monsters
 * @returns {Object<string, string>} Monster index → name, for the ones it is sure of
 */
export function matchMonsterNames(units, mMap) {
    const names = {};
    if (!units?.length) return names;

    for (const [index, monster] of Object.entries(mMap || {})) {
        const health = Number(monster?.cHP);
        if (!Number.isFinite(health)) continue;

        const candidates = units.filter((unit) => unit.hp === health);
        if (!candidates.length) continue;

        // Several at the same health is only a problem when they disagree; three
        // Eyes at full health are all called Eyes whichever one this is
        const distinct = new Set(candidates.map((unit) => unit.name));
        if (distinct.size === 1) names[index] = candidates[0].name;
    }
    return names;
}

/**
 * What the battle panel looks like right now, for a recording to carry.
 *
 * A diagnostic rather than something the tracker uses. Whether the selectors
 * here still match the game is not a thing that can be reasoned about from this
 * side of the screen, and it is exactly what goes wrong silently — so a
 * recording made during a refresh can carry the answer instead.
 *
 * @param {Document|HTMLElement} [root] - Where to look
 * @returns {Object} `{area, grid, tiles}` — what was found and what it said
 */
export function describeMonsterPanel(root = document) {
    try {
        const area = root.querySelector?.(MONSTER_AREA);
        if (!area) return { area: false };

        const grid = area.querySelector(UNIT_GRID);
        return {
            area: true,
            grid: Boolean(grid),
            tiles: [...(grid || area).children].map((tile) => leafTexts(tile)),
        };
    } catch (error) {
        return { area: false, error: String(error?.message || error) };
    }
}

/**
 * Names for a battle whose `new_battle` was missed, or nothing.
 *
 * @param {Object} mMap - The tick's monsters
 * @param {Document|HTMLElement} [root] - Where to read the panel from
 * @returns {Object<string, string>} Monster index → name
 */
export function recoverMonsterNames(mMap, root = globalThis.document) {
    try {
        if (!root) return {};
        return matchMonsterNames(readMonsterUnits(root), mMap);
    } catch (error) {
        console.error('[BattlePanelMonsters] Reading the battle panel failed:', error);
        return {};
    }
}
