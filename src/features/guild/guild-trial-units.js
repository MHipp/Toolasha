/**
 * Putting names to the units in a spectated trial fight.
 *
 * `guild_battle_updated` — the stream that arrives while the In Progress fight
 * view is open — identifies its units by **index only**. `pMap` is `{"1": {…}}`
 * and nothing in the message says who "1" is. Every figure the per-player panel
 * draws is worthless attached to "Player 2", so this is the join, and it is
 * built out of three sources of decreasing trust.
 *
 * ## 1. The fight view's own portraits
 *
 * The trial fight view draws the same `CombatUnit` tiles the ordinary battle
 * panel does, names and all, in slot order. When the tiles cover the index being
 * asked about, their order *is* the slot order and the name is read straight
 * off. This is a fact on screen rather than an inference, so it wins.
 *
 * It is also the source that is not always there: the view has to be open, and
 * the class names carry a build hash, so the selector is a prefix match and the
 * resolver simply falls through when the game renames them.
 *
 * ## 2. The captured build's vitals
 *
 * A tick states `mHP` and `mMP` — the unit's *maximum* health and mana, which do
 * not move during a fight — and `guild-loadout-capture.js` has been recording
 * exactly those two numbers per guild member for weeks. In the capture that
 * proved this stream exists, `pMap["1"]` read `mHP: 2612, mMP: 2180` and exactly
 * one member's sheet said `Max HP 2,612, Max MP 2,180`. That is an identification.
 *
 * The pair is used rather than health alone because health alone collides: two
 * members in the same gear have the same health and the same mana, and a match
 * that fits two people identifies neither. **An ambiguous signature resolves to
 * nobody**, which is the whole discipline of this file — a wrong name on a
 * damage row is worse than no name, because a guild acts on it.
 *
 * ## 3. Nothing
 *
 * `Player 2`, and the caller says the name is a placeholder. Never a guess from
 * whoever happens to be online, or the roster in alphabetical order.
 *
 * ## 0. The roster, once one arrives
 *
 * That better source turned up, exactly where this predicted: **`new_guild_battle`**
 * fires at every tier and carries `players[]` in slot order with
 * `character.id` and `character.name` on each entry, and a tick's `pMap` keys
 * are indexes into that array — entry 19 is Player20, verified against a raw
 * recording. So the roster now sits at the top of the list and the three sources
 * below it are what a viewer who joined mid-tier still has.
 *
 * It slotted in as an argument rather than a rewrite, which is what the list
 * shape was for.
 *
 * ## The portraits are not slot-ordered in the spectate view, and that mislabelled damage
 *
 * Reported live, after a page refresh dropped the roster: the leaderboard
 * showed the watcher's own name **twice** — "MillenniumTest 161/s" and
 * "MillenniumTest 113/s" — while a real member vanished from it entirely. The
 * spectate fight view draws only the *watcher's own* unit as a full
 * `CombatUnit`; the rest of the party are `MiniUnit` lines. So the portrait
 * list was one name long — the watcher's — and reading it positionally handed
 * that name to whichever slot happened to be index 0, while the watcher's real
 * slot earned the same name from their own captured build. Two rules close it:
 *
 * - **Positional portraits only when they cover the party.** A portrait list
 *   shorter than the party is not in slot order for anybody.
 * - **One name, one unit.** The watcher's own name may only bind to the slot
 *   the caller identifies as theirs (the roster entry carrying their character
 *   id — the stream's attack counters, which used to single them out, now
 *   arrive for every player), and any resolution pass ends by
 *   enforcing injectivity outright — a duplicate name demotes the weaker claim
 *   to a placeholder rather than letting two rows wear it.
 *
 * The mini-unit names still earn their keep as a *set*: they say who is in the
 * party without saying where, and when exactly one unit is unnamed and exactly
 * one on-screen name unclaimed, the pairing is forced rather than guessed.
 */

import { parseGameNumber } from '../../utils/number-parser.js';

/** A party tile in the fight view; the class names carry a build hash */
const UNIT = '[class*="CombatUnit_combatUnit"]';

/** The name inside one */
const UNIT_NAME = '[class*="CombatUnit_name"]';

/** A party member drawn small — everyone but the watcher, in the spectate view */
const MINI_UNIT_NAME = '[class*="MiniUnit_name"]';

/** Where the party's tiles live, as opposed to the monsters' */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';

/** And where what they are fighting lives */
const MONSTERS_AREA = '[class*="BattlePanel_monstersArea"]';

/**
 * The party names the fight view is showing, in slot order.
 *
 * Empty when the view is not open, which is most of the time — the caller must
 * treat that as "no answer" rather than as "nobody is there".
 *
 * @param {Document|Element} [root] - Where to look; the document by default
 * @returns {string[]} Names in DOM order, with gaps preserved as empty strings
 */
export function fightViewNames(root = typeof document === 'undefined' ? null : document) {
    if (!root || typeof root.querySelector !== 'function') return [];

    const area = root.querySelector(PLAYERS_AREA);
    if (!area) return [];

    return [...area.querySelectorAll(UNIT)].map((unit) => unit.querySelector(UNIT_NAME)?.textContent?.trim() || '');
}

/**
 * Everyone the fight view names in the party, as a set with no positions.
 *
 * The spectate view draws the watcher's own unit as a full `CombatUnit` and
 * the rest of the party as `MiniUnit` lines, and the two lists cannot be
 * interleaved back into slot order — which is exactly the mistake the
 * positional portrait rung made. What the combined list *can* say is who is in
 * the party: {@link resolveUnitNames} uses it for the forced last pairing, and
 * for nothing positional.
 *
 * @param {Document|Element} [root] - Where to look; the document by default
 * @returns {string[]} Distinct names, in no particular order
 */
export function fightViewPartyNames(root = typeof document === 'undefined' ? null : document) {
    if (!root || typeof root.querySelector !== 'function') return [];

    const area = root.querySelector(PLAYERS_AREA);
    if (!area) return [];

    const names = [];
    for (const el of area.querySelectorAll(`${UNIT_NAME}, ${MINI_UNIT_NAME}`)) {
        const name = el.textContent?.trim();
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

/**
 * What the fight view says is being fought.
 *
 * The identity of a spectated stream, and the fix for the worst thing this
 * feature has done: a week with **two** combat trials, both cards barless on the
 * Trials tab, and the watched pool stood in for both of them — so a report of a
 * Chameleon fight was filed under Hedgehog, with Hedgehog's banked count (zero)
 * and Hedgehog's tier ladder. The stream itself never says which encounter it
 * is; the view drawing it does, in the same tiles the party's names come from.
 *
 * @param {Document|Element} [root] - Where to look; the document by default
 * @returns {string[]} Monster names in DOM order, empty when the view is shut
 */
export function fightViewBossNames(root = typeof document === 'undefined' ? null : document) {
    if (!root || typeof root.querySelector !== 'function') return [];

    const area = root.querySelector(MONSTERS_AREA);
    if (!area) return [];

    return [...area.querySelectorAll(UNIT)]
        .map((unit) => unit.querySelector(UNIT_NAME)?.textContent?.trim() || '')
        .filter(Boolean);
}

/**
 * The roster a `new_guild_battle` states, by slot.
 *
 * `players` is an array and the tick's `pMap` keys are indexes into it, so the
 * join is positional and exact — no matching, no ambiguity, and a character id
 * beside every name for anything that wants to know whether a unit is *you*.
 *
 * Defensive about the shape, because this is read from the wire: a payload whose
 * `players` is missing, is not an array, or holds entries without a name gives
 * back the slots it could read and nothing for the rest.
 *
 * A fifty-player trial's payload has been seen carrying a slot's `character.id`
 * with no `character.name` beside it — trimmed, presumably, the same way the
 * game trims other bulk payloads. An id with nothing else to say is still a
 * fact worth having: the guild already knows this member's name from elsewhere
 * (the Members list, the trial's own sign-ups), so `resolveName` is asked
 * before the slot is given up on. It is what turned "Player 7", "Player 10",
 * "Player 36" — real members of a live forty-eight-player trial, resolvable by
 * id and simply not carrying a name on this particular message — back into
 * their actual names.
 *
 * @param {Object} data - A `new_guild_battle` payload
 * @param {function(number): (string|null)} [resolveName] - Given a character id the
 *   payload itself named nobody for, returns a name from elsewhere (the guild
 *   roster, the trial sign-ups), or null when that source does not know it either
 * @returns {Object<string, {name: string, characterId: number|null}>} Slot → who
 */
export function rosterFromBattle(data, resolveName = null) {
    const players = Array.isArray(data?.players) ? data.players : [];
    const roster = {};

    players.forEach((player, index) => {
        const id = Number(player?.character?.id);
        const characterId = Number.isFinite(id) && id > 0 ? id : null;

        let name = String(player?.character?.name || player?.name || '').trim();
        if (!name && characterId !== null && typeof resolveName === 'function') {
            name = String(resolveName(characterId) || '').trim();
        }
        if (!name) return;

        roster[index] = { name, characterId };
    });

    return roster;
}

/**
 * A number the game wrote for a human to read.
 * @param {string|number} value - e.g. `'2,612'`
 * @returns {number|null} The number, or null
 */
function readNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = parseGameNumber(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The maximum health and mana a captured sheet states.
 *
 * From the sheet's *rows*, which are what the game displayed, and never from
 * `stats.maxHitpoints` — that field is a multiplier (0.932 for a character whose
 * health is 2,612) and matching a tick against it would find nobody, forever.
 *
 * @param {Object} loadout - A snapshot from `guild-loadout-capture.js`
 * @returns {{mHP: number|null, mMP: number|null}} The vitals
 */
export function loadoutVitals(loadout) {
    const rows = Array.isArray(loadout?.rows) ? loadout.rows : [];
    const find = (label) => rows.find((row) => String(row?.label || '').toLowerCase() === label)?.value;

    return { mHP: readNumber(find('max hp')), mMP: readNumber(find('max mp')) };
}

/**
 * Which member's sheet matches a unit's maximum health and mana.
 *
 * Both must be known and both must match. A signature that fits more than one
 * member returns null: see the module note for why a near-miss is worse here
 * than a blank.
 *
 * @param {Object} unit - A `pMap` entry, or anything with `mHP`/`mMP`
 * @param {Array<Object>} loadouts - Snapshots from `guild-loadout-capture.js`
 * @returns {{name: string, at: number|null}|null} The member, or null
 */
export function matchByVitals(unit, loadouts) {
    const health = readNumber(unit?.mHP);
    const mana = readNumber(unit?.mMP);
    if (!Number.isFinite(health) || !Number.isFinite(mana)) return null;

    const hits = [];
    const seen = new Set();

    for (const loadout of loadouts || []) {
        const name = String(loadout?.name || '').trim();
        if (!name) continue;

        // One member, one sheet: `seen()` is most-recent-first, so a member
        // whose build was captured twice must not count as two candidates and
        // make their own signature look ambiguous
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const vitals = loadoutVitals(loadout);
        if (vitals.mHP !== health || vitals.mMP !== mana) continue;
        hits.push({ name, at: Number.isFinite(loadout?.at) ? loadout.at : null });
    }

    return hits.length === 1 ? hits[0] : null;
}

/** How much each naming source is worth, when two of them claim one name */
const SOURCE_RANK = { placeholder: 0, elimination: 1, vitals: 2, portrait: 3, own: 4, roster: 5 };

/**
 * A placeholder entry for a slot.
 * @param {string} index - The slot
 * @returns {{name: string, source: 'placeholder'}} The entry
 */
function placeholderFor(index) {
    const slot = Number(index);
    return { name: `Player ${Number.isInteger(slot) ? slot + 1 : index}`, source: 'placeholder' };
}

/**
 * Name every unit in a tick, and say how each name was arrived at.
 *
 * Beyond the source ladder, two invariants hold whatever the sources say — both
 * earned by the duplicate-name incident in the module note:
 *
 * - **The watcher's own name binds only to the watcher's own slot.** `own` is
 *   the slot the caller says the watcher holds — derived from the roster entry
 *   whose `characterId` is theirs, since the stream now carries attack counters
 *   for every present player and no longer singles anybody out; a portrait, a
 *   build or a held name claiming that name anywhere else is structurally the
 *   spectate view's own-unit tile read positionally, and is refused. The roster
 *   is exempt: it is the game stating the slot outright. A null `own.slot`
 *   means the watcher's slot is unknown, and their name is then refused
 *   everywhere outside the roster — a placeholder is recoverable, a name filed
 *   against the wrong guildmate is not.
 * - **One name, one unit.** After resolution, a name held by two slots keeps
 *   its highest-ranked claim and the rest fall back to placeholders — a row
 *   with a placeholder is recoverable; damage filed under the wrong member is
 *   not.
 *
 * `partyNames` — the fight view's un-positioned name set — closes the last
 * gap: when it covers the party exactly and precisely one slot is unnamed and
 * one name unclaimed, the pairing is forced by injectivity rather than
 * guessed.
 *
 * @param {Object} input - Inputs
 * @param {Object} input.pMap - The tick's players
 * @param {Object} [input.roster] - From {@link rosterFromBattle}; the game's own answer
 * @param {string[]} [input.portraits] - From {@link fightViewNames}; positional, so only
 *   believed when the list covers the whole party
 * @param {string[]} [input.partyNames] - From {@link fightViewPartyNames}; a set, never positional
 * @param {Array<Object>} [input.loadouts] - Snapshots from `guild-loadout-capture.js`
 * @param {Object} [input.known] - Names already resolved, index → `{name, source}`
 * @param {{slot: string|number|null, name: string|null, characterId?: number|string|null}|null} [input.own] -
 *   The watcher: the slot they hold (null when unknown), and their character's name
 * @returns {Object<string, {name: string, source: 'roster'|'own'|'portrait'|'vitals'|'elimination'|'placeholder',
 *   characterId?: number|null}>} Per index; may also carry corrections for slots outside this
 *   tick whose held name lost an injectivity contest
 */
export function resolveUnitNames({
    pMap = {},
    roster = {},
    portraits = [],
    partyNames = [],
    loadouts = [],
    known = {},
    own = null,
} = {}) {
    const resolved = {};
    const indexes = new Set([...Object.keys(known || {}), ...Object.keys(pMap || {})]);
    const ownName = String(own?.name || '').trim();
    const ownSlot = own?.slot === undefined || own?.slot === null ? null : String(own.slot);

    // Positional reading is only sound when the portraits cover the party: the
    // spectate view draws one CombatUnit — the watcher — and a one-name list
    // read positionally is how their name landed on somebody else's slot
    const positional = (portraits || []).length >= indexes.size ? portraits : [];

    // Whether a source may put this name on this slot. The watcher's own name
    // is the poisoned one — the spectate view draws their tile whatever slot
    // they hold — so it binds only where the caller says they are.
    const allowed = (index, name, source) => {
        if (!ownName || String(name || '').toLowerCase() !== ownName.toLowerCase()) return true;
        if (source === 'roster') return true;
        return ownSlot !== null && String(index) === ownSlot;
    };

    for (const [index, unit] of Object.entries(pMap || {})) {
        // The roster is positional and stated by the game, so it outranks
        // everything including a name already held — a new battle restates it
        const listed = roster?.[index];
        if (listed?.name) {
            resolved[index] = { name: listed.name, source: 'roster', characterId: listed.characterId ?? null };
            continue;
        }

        // The watcher's own slot, as the caller derived it
        if (ownName && ownSlot !== null && String(index) === ownSlot) {
            resolved[index] = { name: ownName, source: 'own', characterId: own?.characterId ?? null };
            continue;
        }

        // A name already read off a portrait is not re-derived every tick; the
        // fight view closes and the identification must not close with it. A
        // held claim of the watcher's name on the wrong slot is the incident
        // this file now exists to prevent, and is dropped rather than kept.
        const held = known[index];
        if (held && held.source !== 'placeholder' && allowed(index, held.name, held.source)) {
            resolved[index] = held;
            continue;
        }

        const slot = Number(index);
        const portrait = Number.isInteger(slot) && slot >= 0 && slot < positional.length ? positional[slot] : '';
        if (portrait && allowed(index, portrait, 'portrait')) {
            resolved[index] = { name: portrait, source: 'portrait' };
            continue;
        }

        const matched = matchByVitals(unit, loadouts);
        if (matched && allowed(index, matched.name, 'vitals')) {
            resolved[index] = { name: matched.name, source: 'vitals' };
            continue;
        }

        resolved[index] = placeholderFor(index);
    }

    // ── One name, one unit ──────────────────────────────────────────────────
    // Across everything now believed — this tick's answers over the stored
    // ones — a duplicated name keeps its best-ranked claim and the rest are
    // demoted. A demoted *stored* slot is included in the output so the caller
    // overwrites the stale mislabel rather than keeping it.
    const combined = { ...(known || {}), ...resolved };
    const byName = new Map();
    for (const [index, entry] of Object.entries(combined)) {
        if (!entry?.name || entry.source === 'placeholder') continue;
        const key = entry.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(index);
    }
    for (const holders of byName.values()) {
        if (holders.length < 2) continue;
        holders.sort(
            (a, b) =>
                (SOURCE_RANK[combined[b].source] ?? 0) - (SOURCE_RANK[combined[a].source] ?? 0) || Number(a) - Number(b)
        );
        for (const loser of holders.slice(1)) {
            resolved[loser] = placeholderFor(loser);
            combined[loser] = resolved[loser];
        }
    }

    // ── The forced last pairing ─────────────────────────────────────────────
    // The fight view's name set covers the party exactly, one slot is unnamed
    // and one name unclaimed: injectivity leaves a single arrangement, which
    // is an identification rather than a guess.
    const pool = [...new Set((partyNames || []).map((name) => String(name || '').trim()).filter(Boolean))];
    if (pool.length && pool.length === indexes.size) {
        const claimed = new Set(
            Object.values(combined)
                .filter((entry) => entry?.name && entry.source !== 'placeholder')
                .map((entry) => entry.name.toLowerCase())
        );
        const unclaimed = pool.filter((name) => !claimed.has(name.toLowerCase()));
        const unresolved = [...indexes].filter((index) => !combined[index] || combined[index].source === 'placeholder');
        // Injectivity only forces the pairing if every *other* assignment is
        // right, and the watcher's own name is the one a positional source is
        // likeliest to have misplaced — so the same guard applies here. When
        // it refuses, nothing is assigned: the slot keeps its placeholder,
        // which reads as "Player N" and is honest, rather than carrying a
        // name the data does not support.
        if (unclaimed.length === 1 && unresolved.length === 1 && allowed(unresolved[0], unclaimed[0], 'elimination')) {
            resolved[unresolved[0]] = { name: unclaimed[0], source: 'elimination' };
        }
    }

    return resolved;
}

/**
 * What the resolver managed, in a form a caption can use.
 * @param {Object} names - From {@link resolveUnitNames}
 * @returns {{named: number, of: number, placeholders: string[], bySource: Object}} The tally
 */
export function nameCoverage(names) {
    const entries = Object.values(names || {});
    const bySource = {};
    const placeholders = [];

    for (const entry of entries) {
        bySource[entry.source] = (bySource[entry.source] || 0) + 1;
        if (entry.source === 'placeholder') placeholders.push(entry.name);
    }

    return {
        named: entries.length - placeholders.length,
        of: entries.length,
        placeholders,
        bySource,
    };
}
