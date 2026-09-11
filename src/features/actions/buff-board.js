/**
 * Buff board
 *
 * What is actually boosting you right now, how much, and from where.
 *
 * The game states the answer eight times over and shows it nowhere. Every
 * source of a bonus — the tea in the slot, the gear, the house room, the
 * achievement tier, the MooPass, the guild shrine, the community donation, the
 * labyrinth seal — arrives as its own map on `characterData`, keyed by action
 * type, and each map is read separately by whichever calculator needed it. So
 * "why is my efficiency 61%" is a question the script could always answer and
 * never did: the numbers were in eight places and the player was in none of
 * them.
 *
 * This is one board for the action type the character is running, with a
 * selector for looking at another. One card per source, one row per buff: what
 * it boosts, by how much, and which thing granted it.
 *
 * ## Nothing here is derived
 *
 * Every figure is the `flatBoost`/`ratioBoost` the server states, printed. The
 * boosts are not summed across sources, because the sources do not all stack
 * the same way and a total would be a claim this module is not in a position to
 * make — `utils/efficiency.js` and `utils/action-calculator.js` own that
 * arithmetic. Nor are the level-bonus fields folded in: every existing reader
 * (`getAchievementBuffFlatBoost`, the guild sums in `action-calculator.js`)
 * takes the boost as stated, because the server has already resolved it.
 *
 * ## There is no expiry on the wire
 *
 * Every entry carries `startTime: '0001-01-01T00:00:00Z'` and a `duration`
 * that is the item type's fixed span, not a remaining time — a wisdom tea
 * reads 250 s whether it was drunk now or four minutes ago. The drink slots
 * say `isActive: true, duration: 0` while a drink is running, so they carry no
 * countdown either. So this board shows no countdown. What it does show is the
 * supply estimate `drink-calculator.js` already computes for the drink timer —
 * how long the stock lasts — labelled as the estimate it is, which is a
 * different question from when the current cup wears off.
 *
 * ## Combat is a different source
 *
 * `consumableActionTypeBuffsMap['/action_types/combat']` has been observed null
 * with three coffees active and slotted (captured on the test server,
 * 2026-09-11), while `ability-timing-calculator.js` reads that same slot for
 * Channeling Coffee's cast speed and expects it to be there. Rather than pick a
 * side, this reads the map first and falls back to the source the in-battle
 * buff bars use: `battle_updated` carries each unit's `combatBuffMap`, in the
 * same `{typeHrid, ratioBoost, flatBoost}` shape, and the drinks are in it. If
 * neither has anything, the board says so and names what is slotted, rather
 * than drawing an empty table that reads as "no buffs".
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { formatPercentage, timeReadable } from '../../utils/formatters.js';
import { runningAction } from '../../utils/combat-actions.js';
import { calculateDrinkRemainingSeconds } from '../../utils/drink-calculator.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { registerCommand } from '../../utils/command-registry.js';

/** The action type whose buffs do not live in the per-action-type maps */
export const COMBAT_ACTION_TYPE = '/action_types/combat';

const ACCENT = '#b48ffb';
const INK = '#e8ecf5';
const MUTED = 'rgba(232, 236, 245, 0.5)';

/**
 * Where a buff can come from, in the order a player would look for it.
 *
 * `read` rather than a map name, because the seal buffs live in two places:
 * `data-manager` mirrors them onto `characterData` *and* keeps its own copy,
 * and only the second is refreshed when `personal_buffs_updated` arrives
 * before character data exists.
 *
 * @type {Array<{key: string, label: string, read: () => Object}>}
 */
export const BUFF_SOURCES = [
    { key: 'consumable', label: 'Teas & coffees', read: () => map('consumableActionTypeBuffsMap') },
    { key: 'equipment', label: 'Equipment', read: () => map('equipmentActionTypeBuffsMap') },
    { key: 'house', label: 'House', read: () => map('houseActionTypeBuffsMap') },
    { key: 'achievement', label: 'Achievements', read: () => map('achievementActionTypeBuffsMap') },
    { key: 'mooPass', label: 'MooPass', read: () => map('mooPassActionTypeBuffsMap') },
    { key: 'guild', label: 'Guild', read: () => map('guildActionTypeBuffsMap') },
    { key: 'community', label: 'Community', read: () => map('communityActionTypeBuffsMap') },
    {
        key: 'personal',
        label: 'Seals',
        read: () => map('personalActionTypeBuffsMap') || dataManager.personalActionTypeBuffsMap || null,
    },
];

/**
 * One of the character's buff maps, or null when there is no character yet.
 * @param {string} name - The field on `characterData`
 * @returns {Object|null}
 */
function map(name) {
    return dataManager.characterData?.[name] || null;
}

/**
 * Buff types whose boost is a count rather than a fraction.
 *
 * Everything else the game states as a boost is a fraction — 0.144 is 14.4% —
 * but `/buff_types/*_level` is levels and `/buff_types/food_slots` is slots, as
 * `tea-optimizer.js` has always treated them. Printing those as percentages
 * would turn "+5 action levels" into "+500%".
 *
 * @param {string} typeHrid - e.g. `/buff_types/action_level`
 * @returns {boolean}
 */
export function isCountBuff(typeHrid) {
    const hrid = String(typeHrid || '');
    return hrid.endsWith('_level') || hrid === '/buff_types/food_slots';
}

/**
 * An hrid's last segment, in words.
 * @param {string} hrid - Any game hrid
 * @returns {string} e.g. `Action Speed`
 */
export function titleizeHrid(hrid) {
    return (
        String(hrid || '')
            .split('/')
            .pop()
            .split('_')
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ') || '?'
    );
}

/**
 * What a buff boosts, in words.
 * @param {string} typeHrid - e.g. `/buff_types/action_speed`
 * @returns {string}
 */
export function buffTypeLabel(typeHrid) {
    return titleizeHrid(typeHrid);
}

/**
 * What granted a buff, in words.
 *
 * A consumable's unique hrid is its item's slug — `/buff_uniques/wisdom_tea`
 * for `/items/wisdom_tea` — so the game's own item name is used where there is
 * one, and the slug in words where there is not (`/buff_uniques/house_efficiency`
 * is a house room, and no item is named after it).
 *
 * @param {string} uniqueHrid - e.g. `/buff_uniques/wisdom_tea`
 * @returns {string}
 */
export function buffSourceName(uniqueHrid) {
    const slug = String(uniqueHrid || '')
        .split('/')
        .pop();
    if (!slug) return '?';
    const item = dataManager.getItemDetails?.(`/items/${slug}`);
    return item?.name || titleizeHrid(uniqueHrid);
}

/**
 * The item a buff's unique hrid names, when it names one that is drunk.
 * @param {string} uniqueHrid - e.g. `/buff_uniques/wisdom_tea`
 * @returns {Object|null} The item detail, or null when the unique is not a consumable
 */
function consumableFor(uniqueHrid) {
    const slug = String(uniqueHrid || '')
        .split('/')
        .pop();
    if (!slug) return null;
    const item = dataManager.getItemDetails?.(`/items/${slug}`);
    return item?.consumableDetail ? item : null;
}

/**
 * How big a buff is, as the game states it.
 *
 * Both boost fields are printed when both are set, because they are different
 * numbers and the script's own readers add them rather than choosing one — so
 * collapsing them here would hide half of a figure. In practice the server sets
 * one.
 *
 * @param {Object} buff - `{typeHrid, ratioBoost, flatBoost}`
 * @returns {string} e.g. `+14.4%`, `+5`, or `—` when the buff states no size
 */
export function formatBuffSize(buff) {
    const count = isCountBuff(buff?.typeHrid);
    const flat = Number(buff?.flatBoost) || 0;
    const ratio = Number(buff?.ratioBoost) || 0;
    const show = (value) => {
        const sign = value < 0 ? '' : '+';
        return count ? `${sign}${value}` : `${sign}${formatPercentage(value, 1)}`;
    };

    if (flat && ratio) return `${show(flat)} flat · ${show(ratio)} ratio`;
    if (flat) return show(flat);
    if (ratio) return show(ratio);
    return '—';
}

/**
 * The buffs one source applies to one action type.
 * @param {Object} source - An entry of {@link BUFF_SOURCES}
 * @param {string} actionTypeHrid - e.g. `/action_types/cooking`
 * @returns {Array<Object>} The source's buff entries, possibly empty
 */
export function buffsFrom(source, actionTypeHrid) {
    const entries = source.read()?.[actionTypeHrid];
    return Array.isArray(entries) ? entries.filter(Boolean) : [];
}

/**
 * Every source that has something to say about an action type.
 *
 * A source with no buffs is left out rather than listed as zero: "the guild
 * shrine gives this skill nothing" and "the guild shrine gives this skill 0%"
 * are the same fact, and only one of them costs a row.
 *
 * @param {string} actionTypeHrid - e.g. `/action_types/cooking`
 * @returns {Array<{key: string, label: string, buffs: Array<Object>}>}
 */
export function collectBuffs(actionTypeHrid) {
    if (!actionTypeHrid) return [];
    return BUFF_SOURCES.map((source) => ({
        key: source.key,
        label: source.label,
        buffs: buffsFrom(source, actionTypeHrid),
    })).filter((source) => source.buffs.length > 0);
}

/**
 * Every action type any source has buffs for, plus the one being worked on.
 *
 * Derived rather than listed, so a skill the game adds appears here the day it
 * ships instead of the day somebody remembers to type it in.
 *
 * @returns {Array<string>} Action type hrids, ordered by their readable name
 */
export function knownActionTypes() {
    const types = new Set();
    for (const source of BUFF_SOURCES) {
        for (const key of Object.keys(source.read() || {})) types.add(key);
    }
    const running = runningActionType();
    if (running) types.add(running);
    // Combat's consumables are not in the maps, so combat can be missing from
    // every one of them while being exactly what the player wants to look at
    if (dataManager.getActionDrinkSlots?.(COMBAT_ACTION_TYPE)?.length) types.add(COMBAT_ACTION_TYPE);
    return [...types].sort((a, b) => titleizeHrid(a).localeCompare(titleizeHrid(b)));
}

/**
 * The action type the character is actually working on.
 *
 * Through `runningAction`, not `actions[0]`: a repeating action is requeued to
 * the front of the array with a *higher* ordinal, so array position routinely
 * names an action that is queued behind the running one.
 *
 * @returns {string|null} An action type hrid, or null when idle
 */
export function runningActionType() {
    const action = runningAction(dataManager.getCurrentActions?.() || []);
    if (!action?.actionHrid) return null;
    return dataManager.getActionDetails?.(action.actionHrid)?.type || null;
}

/**
 * The last battle seen, for the combat drinks the buff maps do not carry.
 *
 * Payload references only — the handlers do no work beyond an assignment, so
 * the subscription costs one store per combat tick whether or not anybody has
 * the board open. `new_battle` names the slots; `battle_updated` refreshes the
 * unit in one (`pMap`), which is where a drink that started mid-fight shows up.
 */
let lastBattle = null;
let lastTick = null;

/** Forget the fight. Exposed for tests and used on a character switch. */
export function _resetBattleState() {
    lastBattle = null;
    lastTick = null;
}

/**
 * Which slot of the last battle is this character.
 * @returns {string|null}
 */
function ownSlot() {
    const players = lastBattle?.players;
    if (!players) return null;
    const id = dataManager.getCurrentCharacterId?.();
    const name = dataManager.getCurrentCharacterName?.();
    const entries = Object.entries(players);
    const mine =
        entries.find(([, player]) => id && player?.character?.id === id) ||
        entries.find(([, player]) => name && (player?.character?.name === name || player?.name === name)) ||
        (entries.length === 1 ? entries[0] : null);
    return mine ? mine[0] : null;
}

/**
 * The drink buffs standing on this character in the live fight.
 *
 * The unit's `combatBuffMap` is everything on it — achievements, community,
 * house, the lot — so it is narrowed to the entries whose unique hrid names a
 * consumable item, which is exactly the source the per-action-type maps are
 * missing for combat. Everything else on that unit is already listed from its
 * own map above.
 *
 * @returns {Array<Object>} Buff entries in the ordinary `{uniqueHrid, typeHrid, …}` shape
 */
export function combatDrinkBuffs() {
    const slot = ownSlot();
    if (slot === null) return [];
    const buffMap = lastTick?.pMap?.[slot]?.combatBuffMap || lastBattle?.players?.[slot]?.combatBuffMap;
    if (!buffMap) return [];

    const drinks = [];
    for (const [uniqueHrid, buff] of Object.entries(buffMap)) {
        if (!consumableFor(uniqueHrid)) continue;
        drinks.push({ ...buff, uniqueHrid: buff?.uniqueHrid || uniqueHrid });
    }
    return drinks;
}

/** What is slotted for combat, by name, whether or not a fight is running */
function combatSlotNames() {
    return (dataManager.getActionDrinkSlots?.(COMBAT_ACTION_TYPE) || [])
        .map((slot) => dataManager.getItemDetails?.(slot?.itemHrid)?.name)
        .filter(Boolean);
}

/**
 * The action type the board is pointed at.
 *
 * Null means "whatever is running", which is what a board wants to be by
 * default — it is reset on a character switch because the arriving character is
 * doing something else.
 */
let pinned = null;

/** @returns {string|null} The action type the board is showing */
export function shownActionType() {
    return pinned || runningActionType() || knownActionTypes()[0] || null;
}

/**
 * Point the board at an action type.
 * @param {string|null} actionTypeHrid - An hrid, or null to follow the running action
 */
export function showActionType(actionTypeHrid) {
    pinned = actionTypeHrid || null;
}

/**
 * One buff, as three columns: what it boosts, by how much, and what granted it.
 * @param {Object} buff - A buff entry
 * @returns {HTMLElement}
 */
function buffRow(buff) {
    const line = document.createElement('div');
    line.dataset.buffRow = String(buff?.typeHrid || '');
    Object.assign(line.style, {
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: '8px',
        alignItems: 'baseline',
    });

    const name = document.createElement('span');
    name.textContent = buffTypeLabel(buff?.typeHrid);
    name.style.color = INK;

    const size = document.createElement('span');
    size.textContent = formatBuffSize(buff);
    size.style.color = ACCENT;
    size.style.whiteSpace = 'nowrap';

    const from = document.createElement('div');
    from.textContent = buffSourceName(buff?.uniqueHrid);
    Object.assign(from.style, { color: MUTED, fontSize: '11px', gridColumn: '1 / -1', marginTop: '-2px' });

    line.append(name, size, from);
    return line;
}

/**
 * The board.
 */
export const buffBoardPanel = createPanel({
    id: 'buffBoard',
    title: 'Buff Board',
    size: { width: 340, height: 460 },
    accent: ACCENT,
    draw: (body) => {
        const shown = shownActionType();
        const running = runningActionType();

        body.appendChild(selector(shown, running));

        if (!shown) {
            body.appendChild(panelNote('No action running, and the game has stated no buffs yet.'));
            return;
        }

        const sources = collectBuffs(shown);
        for (const source of sources) {
            const card = panelCard(body, source.label, ACCENT);
            card.dataset.buffSource = source.key;
            for (const buff of source.buffs) card.appendChild(buffRow(buff));
        }

        if (shown === COMBAT_ACTION_TYPE && !sources.some((source) => source.key === 'consumable')) {
            drawCombatDrinks(body);
        }

        if (!sources.length && shown !== COMBAT_ACTION_TYPE) {
            body.appendChild(panelNote(`Nothing is boosting ${titleizeHrid(shown)} right now.`));
        }

        drawSupply(body, shown);
    },
});

/**
 * The combat drinks, from the fight if there is one and honestly if there is not.
 * @param {HTMLElement} body - The panel body
 */
function drawCombatDrinks(body) {
    const drinks = combatDrinkBuffs();
    if (drinks.length) {
        const card = panelCard(body, 'Teas & coffees (from the live fight)', ACCENT);
        card.dataset.buffSource = 'consumable';
        for (const buff of drinks) card.appendChild(buffRow(buff));
        card.appendChild(
            note('Combat drinks are not in the character buff maps; these are read off your unit in the battle.')
        );
        return;
    }

    const slotted = combatSlotNames();
    const card = panelCard(body, 'Teas & coffees', ACCENT);
    card.dataset.buffSource = 'consumable-missing';
    card.appendChild(
        note(
            'The game states no combat drink buffs outside a fight — they arrive on your unit while a battle is ' +
                'running, and are listed here once one has been seen this session.'
        )
    );
    if (slotted.length) card.appendChild(note(`Slotted: ${slotted.join(', ')}.`));
}

/**
 * The drink supply estimate, which is not a countdown and says so.
 * @param {HTMLElement} body - The panel body
 * @param {string} actionTypeHrid - The action type shown
 */
function drawSupply(body, actionTypeHrid) {
    let drinks = [];
    try {
        drinks = calculateDrinkRemainingSeconds(actionTypeHrid) || [];
    } catch (error) {
        console.error('[BuffBoard] Drink supply could not be estimated:', error);
        return;
    }
    if (!drinks.length) return;

    const card = panelCard(body, 'Drink supply (estimate)', ACCENT);
    card.dataset.buffSource = 'supply';
    for (const drink of drinks) {
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', gap: '8px', alignItems: 'baseline' });

        const name = document.createElement('span');
        name.textContent = drink.name;
        name.style.color = INK;
        name.style.flex = '1';

        const left = document.createElement('span');
        left.textContent = timeReadable(Math.round(drink.totalSeconds));
        left.style.color = ACCENT;
        left.style.whiteSpace = 'nowrap';

        line.append(name, left);
        card.appendChild(line);
    }
    card.appendChild(
        note(
            'How long the stock lasts at the current drink rate — the drink timer’s estimate. Not a countdown on ' +
                'the buff: the game states no expiry for one.'
        )
    );
}

/**
 * A dim aside under a card's rows.
 * @param {string} text - What it says
 * @returns {HTMLElement}
 */
function note(text) {
    const element = document.createElement('div');
    element.textContent = text;
    Object.assign(element.style, { color: MUTED, fontSize: '11px', marginTop: '4px' });
    return element;
}

/**
 * The action-type picker, and what is running.
 * @param {string|null} shown - The action type on screen
 * @param {string|null} running - The action type being worked on
 * @returns {HTMLElement}
 */
function selector(shown, running) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '3px' });

    const select = document.createElement('select');
    select.dataset.buffActionType = 'true';
    Object.assign(select.style, {
        background: 'rgba(255, 255, 255, 0.06)',
        border: '1px solid rgba(255, 255, 255, 0.18)',
        borderRadius: '4px',
        color: INK,
        fontFamily: 'inherit',
        fontSize: '12px',
        padding: '3px 6px',
    });

    const follow = document.createElement('option');
    follow.value = '';
    follow.textContent = 'Whatever I am doing';
    select.appendChild(follow);

    for (const hrid of knownActionTypes()) {
        const option = document.createElement('option');
        option.value = hrid;
        option.textContent = hrid === running ? `${titleizeHrid(hrid)} (running)` : titleizeHrid(hrid);
        select.appendChild(option);
    }
    select.value = pinned || '';

    select.addEventListener('change', () => {
        showActionType(select.value);
        buffBoardPanel.render();
    });
    wrap.appendChild(select);

    const caption = document.createElement('div');
    caption.style.color = MUTED;
    caption.style.fontSize = '11px';
    caption.textContent = running
        ? `Running: ${titleizeHrid(running)}${shown && shown !== running ? ` — showing ${titleizeHrid(shown)}` : ''}`
        : shown
          ? `Nothing running — showing ${titleizeHrid(shown)}`
          : 'Nothing running.';
    wrap.appendChild(caption);

    return wrap;
}

// Module scope, like the Ability Book panel's: there is no setting that
// switches the board off and no feature-registry lifecycle behind it, so there
// is no state in which it is imported but unavailable.
registerCommand({
    name: 'Buff Board',
    hint: 'Every buff on the action you are doing, and where it comes from',
    run: () => buffBoardPanel.toggle(),
});

// One store per message, and nothing else — see the note on `lastBattle`
webSocketHook.on('new_battle', (payload) => {
    lastBattle = payload;
    lastTick = null;
});
webSocketHook.on('battle_updated', (payload) => {
    lastTick = payload;
});

// The panel shell already hides and reopens itself across a character switch.
// What it cannot know about is the fight state and the pinned action type held
// here: the departing character's battle is not the arriving character's, and
// the action they were pinned to is very likely a skill the new one is not
// training.
dataManager.on?.('character_switching', () => {
    _resetBattleState();
    pinned = null;
});

export default buffBoardPanel;
