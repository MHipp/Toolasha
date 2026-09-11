/**
 * House affordability
 *
 * How many house upgrades your coins currently cover, and what the cheapest one
 * is.
 *
 * The costing is `utils/house-cost-calculator.js` — this only asks it a
 * different question. That calculator returns the **cumulative** cost of taking
 * a room from nothing to a level, so the price of the next upgrade alone is the
 * difference between two of its answers rather than anything new. It prices
 * materials at the buy side, so the headline upgrade cost is the same figure as
 * the `ask` shown beside it rather than a third number between the two.
 *
 * The figure is worth having because the alternative is opening each room in
 * turn to see what it wants, and the answer changes with the market rather than
 * only when you spend.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import marketAPI from '../../api/marketplace.js';
import { calculateHouseBuildCost } from '../../utils/house-cost-calculator.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { rows, blank, itemIcon, skillIcon, linkToMarketplace, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable, panelHeightCap } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { getItemPrice } from '../../utils/market-data.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { roomSkill } from '../../utils/room-skills.js';

/** The game's cap; a room at this level has nothing left to buy */
const MAX_ROOM_LEVEL = 8;
const PANEL_ID = 'toolasha-houses-panel';
/** Where this panel's size and position are remembered */
const GEOMETRY_KEY = 'housesPanel';
/** Where the rooms you have switched off are remembered */
const UNTRACKED_KEY = 'housesUntracked';
/** What it opens at before anyone has resized it */
const DEFAULT_PANEL = { width: 560, height: 420 };

const COLORS = {
    background: 'rgba(8, 10, 20, 0.96)',
    headerBg: 'rgba(14, 30, 20, 0.85)',
    border: 'rgba(120, 200, 150, 0.3)',
    text: '#e6efe9',
    textDim: 'rgba(230, 239, 233, 0.55)',
    accent: '#7fd6a3',
    affordable: 'rgba(60, 140, 90, 0.35)',
    tooDear: 'rgba(120, 60, 60, 0.3)',
    maxed: 'rgba(60, 60, 70, 0.35)',
};

/**
 * What one unit of a material costs.
 *
 * Ask by default, because the commonest question here prices what is *missing* —
 * the thing you would have to go and buy rather than something you are deciding
 * whether to sell.
 *
 * @param {string} itemHrid - The material
 * @param {string} [side] - `ask` or `bid`
 * @returns {number} Price, or 0 when the market has no answer
 */
function priceOfMaterial(itemHrid, side = 'ask') {
    // `mode`, not `context` + `side`: `getPricingMode` only recognises the
    // 'profit' and 'networth' contexts and otherwise falls through to its
    // default branch, which always resolves to 'ask' regardless of `side`.
    // That silently made the bid column identical to the ask column.
    return getItemPrice(itemHrid, { mode: side }) || 0;
}

/**
 * What a level's whole material list costs at one side of the book.
 *
 * Coins in the list are counted at face value rather than looked up — a coin
 * has no bid and no ask, and leaving it out would understate the level by
 * exactly the coin part.
 *
 * @param {Array<Object>} materials - From `upgradeCostsMap`
 * @param {string} side - `ask` or `bid`
 * @returns {number}
 */
export function materialsCost(materials, side) {
    let total = 0;
    for (const material of materials || []) {
        const count = material?.count || 0;
        if (!count) continue;
        total += material.itemHrid === '/items/coin' ? count : priceOfMaterial(material.itemHrid, side) * count;
    }
    return total;
}

/**
 * Rooms the player has said they are not saving for.
 *
 * Held in memory and mirrored to storage, because the affordability count is
 * recomputed on a timer and on every overlay tick — an await per room per tick
 * is not a thing to put behind a number that has to be there when it is drawn.
 * `loadUntrackedRooms` fills it once at start-up.
 */
let untracked = new Set();

/**
 * @returns {Set<string>} Room hrids left out of the count
 */
export function untrackedRooms() {
    return untracked;
}

/**
 * @param {string} houseRoomHrid - A room
 * @returns {boolean} Whether it counts towards "affordable"
 */
export function isRoomTracked(houseRoomHrid) {
    return !untracked.has(houseRoomHrid);
}

/**
 * Start or stop counting a room.
 *
 * @param {string} houseRoomHrid - The room
 * @param {boolean} tracked - Whether it should count
 * @returns {Promise<void>}
 */
export async function setRoomTracked(houseRoomHrid, tracked) {
    if (tracked) untracked.delete(houseRoomHrid);
    else untracked.add(houseRoomHrid);

    try {
        await writeScoped(UNTRACKED_KEY, [...untracked], 'settings');
    } catch (error) {
        console.error('[Houses] Saving which rooms to count failed:', error);
    }
}

/**
 * Read back which rooms were switched off.
 *
 * Each character has their own house, so each has their own list — the key is
 * built when this runs rather than once at import, and it runs again on a
 * switch.
 * @returns {Promise<Set<string>>}
 */
export async function loadUntrackedRooms() {
    // Captured before the first await: `character_initialized` and
    // `character_switched` both call this, unawaited, so a fast switch (or a
    // switch landing while the previous character's read is still in flight)
    // can have two calls outstanding at once. Whichever started for this
    // character is the one that gets to decide whether its answer still
    // applies once it comes back.
    const charId = dataManager.getCurrentCharacterId();
    // Called at module scope, which is long before the database is open. Read
    // there unguarded it came back with the default — every room counted, and a
    // "Database not available" line in the console saying so.
    try {
        await storage.ready;
        const saved = await readScoped(UNTRACKED_KEY, 'settings', null, { migrate: 'adopt' });
        // The character has moved on since this read started — a slower call
        // for the departed character resolving after a faster call for the
        // new one would otherwise overwrite the new character's set with the
        // old one's, silently applying the wrong exclusions to the wrong house.
        if (dataManager.getCurrentCharacterId() !== charId) return untracked;
        untracked = Array.isArray(saved) ? new Set(saved) : new Set();
    } catch (error) {
        console.error('[Houses] Reading which rooms to count failed:', error);
    }
    // Whatever is on screen was drawn against the wrong set
    housesPanel._render();
    return untracked;
}

/**
 * What the next level of one room costs, on its own.
 * @param {string} houseRoomHrid - Room
 * @param {number} currentLevel - Level it is at now
 * @returns {number} Cost of the next level, or 0 when there is none
 */
export function nextLevelCost(houseRoomHrid, currentLevel) {
    if (currentLevel >= MAX_ROOM_LEVEL) return 0;

    const toNext = calculateHouseBuildCost(houseRoomHrid, currentLevel + 1);
    const toHere = calculateHouseBuildCost(houseRoomHrid, currentLevel);
    const cost = toNext - toHere;
    return cost > 0 ? cost : 0;
}

/**
 * Which upgrades your coins cover right now.
 *
 * Counted per room rather than as a shopping basket: buying the cheapest
 * upgrade changes what you can afford next, so "you could buy all six" would be
 * false. Each entry answers "could I buy this one now", which stays true.
 *
 * @param {Object} houseRooms - `characterHouseRoomMap`
 * @param {number} coins - Coins in hand
 * @returns {{affordable: number, total: number, cheapest: {name: string, cost: number}|null}}
 */
export function affordableUpgrades(houseRooms, coins) {
    const gameData = dataManager.getInitClientData();
    const roomDetails = gameData?.houseRoomDetailMap || {};

    let affordable = 0;
    let total = 0;
    let cheapest = null;
    const ignored = untrackedRooms();

    // Walk the game's full room list, not the character's. `characterHouseRoomMap`
    // holds only rooms you have already bought, so a character with one maxed
    // room and fifteen unbuilt ones looks like a character with nothing left to
    // buy — when the unbuilt ones are the whole point of the figure.
    for (const houseRoomHrid of Object.keys(roomDetails)) {
        // A room you have said you are not saving for is not one you are failing
        // to afford. Left out of both halves of the count, so "3 of 5" stays a
        // sentence about rooms you actually want.
        if (ignored.has(houseRoomHrid)) continue;

        const level = (houseRooms || {})[houseRoomHrid]?.level || 0;
        const cost = nextLevelCost(houseRoomHrid, level);
        // A maxed room, or one whose materials cannot be priced, is not an
        // upgrade you are choosing not to buy
        if (cost <= 0) continue;

        total++;
        if (cost <= coins) affordable++;
        if (!cheapest || cost < cheapest.cost) {
            const name = roomDetails[houseRoomHrid]?.name || houseRoomHrid.replace('/house_rooms/', '');
            cheapest = { name, cost };
        }
    }

    return { affordable, total, cheapest };
}

/**
 * Every room, with what its next level costs and whether you can afford it.
 *
 * Sorted cheapest first, because the panel exists to answer "what can I buy
 * next" and the cheapest upgrade is almost always the answer.
 *
 * @param {Object} houseRooms - `characterHouseRoomMap`
 * @param {number} coins - Coins in hand
 * @returns {Array<Object>} `{ hrid, name, level, cost, affordable, maxed, materials }`
 */
export function roomUpgrades(houseRooms, coins) {
    const gameData = dataManager.getInitClientData();
    const roomDetails = gameData?.houseRoomDetailMap || {};

    const rooms = Object.keys(roomDetails).map((hrid) => {
        const level = (houseRooms || {})[hrid]?.level || 0;
        const cost = nextLevelCost(hrid, level);
        const maxed = level >= MAX_ROOM_LEVEL;

        return {
            hrid,
            name: roomDetails[hrid]?.name || hrid.replace('/house_rooms/', ''),
            level,
            cost,
            maxed,
            affordable: !maxed && cost > 0 && cost <= coins,
            materials: roomDetails[hrid]?.upgradeCostsMap?.[level + 1] || [],
        };
    });

    rooms.sort((a, b) => {
        // Maxed rooms last; there is nothing to decide about them
        if (a.maxed !== b.maxed) return a.maxed ? 1 : -1;
        return a.cost - b.cost;
    });
    return rooms;
}

/**
 * Coins in hand.
 * @returns {number} Coin count, or 0 when the inventory is not loaded
 */
function coinBalance() {
    const items = dataManager.getCombinedData()?.characterItems || [];
    const coin = items.find((item) => item.itemHrid === '/items/coin');
    return coin?.count || 0;
}

/**
 * Report why the Houses row is or is not showing anything.
 *
 * The row draws nothing when it cannot price a single upgrade, and "nothing" is
 * indistinguishable from the feature being off. This says which step came back
 * empty: the room list, the level, the game's cost table, or the market prices
 * those costs are valued at.
 *
 * Console: `Toolasha.Debug.houses()`
 * @returns {Object} What was found
 */
export function describeHouses() {
    const combined = dataManager.getCombinedData();
    const initData = dataManager.getInitClientData();
    const rooms = combined?.characterHouseRoomMap || {};
    const roomDetails = initData?.houseRoomDetailMap || {};

    const rows = Object.keys(roomDetails).map((hrid) => {
        const level = rooms[hrid]?.level || 0;
        const detail = roomDetails[hrid];
        const costsMap = detail?.upgradeCostsMap;
        const nextCosts = costsMap?.[level + 1];
        return {
            room: hrid.replace('/house_rooms/', ''),
            level,
            hasDetail: !!detail,
            hasCostsMap: !!costsMap,
            costsMapKeys: costsMap ? Object.keys(costsMap).join(',') : '(none)',
            nextLevelHasCosts: Array.isArray(nextCosts) ? nextCosts.length : '(missing)',
            cumulativeToHere: calculateHouseBuildCost(hrid, level),
            cumulativeToNext: calculateHouseBuildCost(hrid, level + 1),
            upgradeCost: nextLevelCost(hrid, level),
        };
    });

    const coins = coinBalance();
    const summary = affordableUpgrades(rooms, coins);

    console.log(
        `[Toolasha] ${Object.keys(roomDetails).length} room(s) in the game, ${Object.keys(rooms).length} owned; ` +
            `coins = ${coins}. ` +
            `houseRoomDetailMap present = ${!!initData?.houseRoomDetailMap}. ` +
            `Row shows: ${summary.total ? `${summary.affordable} of ${summary.total}` : 'nothing (no upgrade could be priced)'}.\n` +
            'upgradeCost of 0 on every row means the cost table was read wrong or its materials have no market price.'
    );
    if (rows.length) console.table(rows);

    return { coins, rooms: rows, summary };
}

/**
 * The Houses panel: a grid of rooms and what each one's next level costs.
 *
 * The overlay row is a headline — how many you can afford, and the cheapest. The
 * question it provokes is "which ones, and what do they need", and that needs a
 * list. So the row opens this on a double-click and stays one line itself.
 *
 * Rooms are ordered cheapest first, with maxed ones last, because the panel is
 * read to decide what to buy next rather than to audit what you own.
 */
class HousesPanel {
    constructor() {
        this.panel = null;
        this.gridEl = null;
        this.detailEl = null;
        this.selected = null;
        this.detachDrag = null;
        this.refreshId = null;
    }

    /**
     * Open the panel, or raise it if it is already up.
     * @param {Object} [options] - `remember: false` when reopening at start-up,
     *   so restoring a panel is not itself recorded as opening one
     */
    show({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, true);
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide({ remember = true } = {}) {
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this._remove();
    }

    /** Reopen if the page was left with this panel up */
    restore() {
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '100px',
            left: '60px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: panelHeightCap(DEFAULT_PANEL.height),
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        const header = this._header();
        this.panel.appendChild(header);

        const body = document.createElement('div');
        Object.assign(body.style, { display: 'flex', gap: '10px', padding: '10px', flex: '1', minHeight: '0' });

        this.gridEl = document.createElement('div');
        Object.assign(this.gridEl.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '6px',
            flex: '0 0 auto',
            overflow: 'auto',
        });

        this.detailEl = document.createElement('div');
        Object.assign(this.detailEl.style, { flex: '1', overflow: 'auto', minWidth: '0' });

        body.appendChild(this.gridEl);
        body.appendChild(this.detailEl);
        this.panel.appendChild(body);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 200,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 200 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body,
            panelKey: GEOMETRY_KEY,
            beforeEl: header.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        // Costs move with the market, and coins move as you play
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            this._render();
        }, 5000);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
        });

        this.titleEl = document.createElement('span');
        this.titleEl.style.fontWeight = 'bold';
        this.titleEl.style.color = COLORS.accent;

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 5px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.appendChild(this.titleEl);
        header.appendChild(close);
        return header;
    }

    _render() {
        if (!this.gridEl) return;

        const coins = coinBalance();
        const rooms = roomUpgrades(dataManager.getCombinedData()?.characterHouseRoomMap, coins);
        const buyable = rooms.filter((room) => room.affordable).length;
        const cheapest = rooms.find((room) => !room.maxed && room.cost > 0);

        this.titleEl.textContent = cheapest
            ? `Houses — ${buyable} affordable · cheapest ${cheapest.name} ${formatLargeNumber(Math.round(cheapest.cost))}`
            : 'Houses';

        this.gridEl.replaceChildren();
        for (const room of rooms) this.gridEl.appendChild(this._tile(room));

        // Keep whatever was selected across a refresh, or fall back to the one
        // you are most likely to want
        const chosen = rooms.find((room) => room.hrid === this.selected) || cheapest || rooms[0];
        this._renderDetail(chosen, coins);
    }

    /**
     * @param {Object} room - From `roomUpgrades`
     * @returns {HTMLElement} A tile
     */
    _tile(room) {
        const tile = document.createElement('div');
        const background = room.maxed ? COLORS.maxed : room.affordable ? COLORS.affordable : COLORS.tooDear;
        Object.assign(tile.style, {
            padding: '5px 6px',
            borderRadius: '4px',
            background,
            border: `1px solid ${room.hrid === this.selected ? COLORS.accent : 'transparent'}`,
            cursor: 'pointer',
            minWidth: '92px',
            lineHeight: '1.3',
        });
        tile.title = room.maxed
            ? `${room.name} is at the maximum level`
            : `${room.name} → level ${room.level + 1}: ${formatLargeNumber(Math.round(room.cost))}`;

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '5px' });

        // The switch that keeps a room out of the count. A room nobody intends
        // to buy — a skill they do not train — otherwise sits in the denominator
        // forever, so "14 of 17" is answering a question about somebody else's
        // character.
        const track = document.createElement('input');
        track.type = 'checkbox';
        track.checked = isRoomTracked(room.hrid);
        Object.assign(track.style, { margin: '0', cursor: 'pointer', accentColor: COLORS.accent, flex: '0 0 auto' });
        track.title = track.checked ? 'Counted — click to stop counting this room' : 'Not counted — click to count it';
        track.addEventListener('click', async (event) => {
            // Without this the click also selects the tile, so switching a room
            // off jumps the detail pane to it
            event.stopPropagation();
            await setRoomTracked(room.hrid, track.checked);
            this._render();
        });

        const name = document.createElement('div');
        name.textContent = room.name;
        Object.assign(name.style, {
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: '1',
            minWidth: '0',
        });

        // The game's own skill artwork, as JHouse has it: the icon identifies the
        // room before the name has been read, which is what makes a grid of
        // seventeen scannable at all
        top.append(track, skillIcon(roomSkill(room.hrid), 16), name);

        const level = document.createElement('div');
        level.textContent = room.maxed ? `Lv ${room.level} · max` : `Lv ${room.level} → ${room.level + 1}`;
        level.style.color = COLORS.textDim;
        level.style.fontSize = '11px';

        // An untracked room is still shown — you have to be able to switch it
        // back on — but dimmed, so the grid reads as the set being counted
        if (!isRoomTracked(room.hrid)) tile.style.opacity = '0.45';

        tile.appendChild(top);
        tile.appendChild(level);
        tile.addEventListener('click', () => {
            this.selected = room.hrid;
            this._render();
        });
        return tile;
    }

    /**
     * What the selected room's next level needs.
     *
     * Materials are listed with what you hold against what it wants, because the
     * cost in coins is only the answer if you intend to buy the materials — and
     * the usual question is whether you already have them.
     *
     * @param {Object} room - The selected room
     * @param {number} coins - Coins in hand
     */
    _renderDetail(room, coins) {
        this.detailEl.replaceChildren();
        if (!room) return;

        const title = document.createElement('div');
        title.textContent = room.maxed ? `${room.name} — maxed` : `${room.name} ${room.level} → ${room.level + 1}`;
        Object.assign(title.style, { fontWeight: 'bold', color: COLORS.accent, marginBottom: '4px' });
        this.detailEl.appendChild(title);

        if (room.maxed) return;

        // Both sides of the book, as JHouse shows them. They are genuinely
        // different answers: ask is what finishing this today costs, bid is what
        // it costs if you are willing to wait for your buy orders to fill, and
        // on a level wanting six thousand milk the gap between them is the
        // decision.
        const ask = materialsCost(room.materials, 'ask');
        const bid = materialsCost(room.materials, 'bid');

        const cost = document.createElement('div');
        cost.textContent = `Upgrade cost ${formatLargeNumber(Math.round(room.cost))}`;
        cost.style.color = room.affordable ? COLORS.accent : '#f87171';
        cost.style.marginBottom = '2px';
        this.detailEl.appendChild(cost);

        if (ask > 0 || bid > 0) {
            const sides = document.createElement('div');
            Object.assign(sides.style, { display: 'flex', gap: '10px', marginBottom: '2px' });

            const askEl = document.createElement('span');
            askEl.textContent = `${formatLargeNumber(Math.round(ask))} ask`;
            askEl.style.color = '#f87171';

            const bidEl = document.createElement('span');
            bidEl.textContent = `${formatLargeNumber(Math.round(bid))} bid`;
            bidEl.style.color = COLORS.accent;

            sides.append(askEl, bidEl);
            sides.title =
                'Materials at both sides of the book: ask is buying them now, bid is waiting for your own ' +
                'buy orders to fill.';
            this.detailEl.appendChild(sides);
        }

        const held = document.createElement('div');
        held.textContent = `You hold ${formatLargeNumber(coins)}`;
        held.style.color = COLORS.textDim;
        held.style.marginBottom = '6px';
        this.detailEl.appendChild(held);

        if (!room.materials.length) return;

        const heading = document.createElement('div');
        heading.textContent = 'Materials';
        heading.style.color = COLORS.textDim;
        heading.style.marginBottom = '2px';
        this.detailEl.appendChild(heading);

        const inventory = dataManager.getCombinedData()?.characterItems || [];
        let shortfall = 0;

        for (const material of room.materials) {
            const line = document.createElement('div');
            Object.assign(line.style, {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                padding: '1px 0',
            });

            const label = document.createElement('span');
            Object.assign(label.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                minWidth: '0',
                overflow: 'hidden',
            });

            const icon = itemIcon(material.itemHrid, 16);
            const name = document.createElement('span');
            name.textContent =
                dataManager.getItemDetails?.(material.itemHrid)?.name || material.itemHrid.split('/').pop();
            Object.assign(name.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
            label.append(icon, name);

            const have =
                material.itemHrid === '/items/coin'
                    ? coins
                    : inventory.find((item) => item.itemHrid === material.itemHrid && !item.enhancementLevel)?.count ||
                      0;
            const need = material.count || 0;
            const missing = Math.max(0, need - have);

            // Straight to the listing for the thing you are short of, which is
            // the next thing you were going to do anyway. Coins are not bought.
            if (material.itemHrid !== '/items/coin') {
                linkToMarketplace(icon, material.itemHrid, navigateToMarketplace);
                linkToMarketplace(name, material.itemHrid, navigateToMarketplace);
            }

            const amount = document.createElement('span');
            amount.textContent = missing
                ? `${formatLargeNumber(have)} / ${formatLargeNumber(need)}  −${formatLargeNumber(missing)}`
                : `${formatLargeNumber(have)} / ${formatLargeNumber(need)}`;
            amount.style.color = missing ? '#f87171' : COLORS.accent;
            amount.style.whiteSpace = 'nowrap';

            const price = missing && material.itemHrid !== '/items/coin' ? priceOfMaterial(material.itemHrid) : 0;
            if (price > 0) shortfall += price * missing;

            line.title = missing
                ? `Short ${formatLargeNumber(missing)} ${name.textContent}` +
                  (price > 0 ? `, about ${formatLargeNumber(Math.round(price * missing))} to buy.` : '.') +
                  (material.itemHrid === '/items/coin' ? '' : '\nClick to open its marketplace listing.')
                : `Enough ${name.textContent} in hand.`;

            line.append(label, amount);
            this.detailEl.appendChild(line);
        }

        // What finishing this level would actually cost from here, which is not
        // the upgrade cost: that prices every material, and you already own some
        const remaining = document.createElement('div');
        remaining.textContent = shortfall
            ? `Missing materials cost about ${formatLargeNumber(Math.round(shortfall))}`
            : 'Every material is already in hand';
        Object.assign(remaining.style, {
            marginTop: '6px',
            paddingTop: '4px',
            borderTop: `1px solid ${COLORS.border}`,
            color: shortfall ? COLORS.textDim : COLORS.accent,
        });
        this.detailEl.appendChild(remaining);
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.gridEl = null;
        this.detailEl = null;
    }
}

export const housesPanel = new HousesPanel();

// Read at module scope alongside the row registration, because this module has
// no initialize of its own — it is imported for its side effects. Fire and
// forget: until it lands every room counts, which is what an empty set means
// anyway, and the row redraws every second.
loadUntrackedRooms();
// This module has no initialize, so nothing re-reads it on a switch unless it
// asks to be told
dataManager.on('character_initialized', loadUntrackedRooms);
dataManager.on('character_switched', loadUntrackedRooms);
housesPanel.restore();

/**
 * How many times a price feed has landed.
 *
 * An upgrade is costed from the market price of its materials, so a new feed can
 * change the tile without a single room or coin moving. Counted rather than read
 * off the tile's own arithmetic, because that arithmetic — a walk of every room
 * in the game, pricing each one's next level — is exactly what the tile's
 * `version()` exists to avoid doing once a second.
 */
let priceFeed = 0;

marketAPI.on(() => {
    priceFeed++;
});

/**
 * What the Houses tile would count, without counting it.
 *
 * The rooms you own and the level of each, the coins the comparison is against,
 * the rooms you have said you are not saving for, and the price feed. Between
 * them those are every input `affordableUpgrades` has that can change: the
 * game's room list and its build costs are static data, and the pricing of the
 * materials moves with the feed.
 *
 * @returns {string}
 */
function housesVersion() {
    const rooms = dataManager.getCombinedData()?.characterHouseRoomMap;
    if (!rooms) return 'blank';

    const levels = Object.entries(rooms).map(([hrid, room]) => `${hrid}:${room?.level || 0}`);
    return `${levels.join(',')}|${coinBalance()}|${[...untrackedRooms()].sort().join(',')}|${priceFeed}`;
}

registerRow({
    key: 'houses',
    empty: 'No house data',
    name: 'Houses',
    defaultSize: { width: 200, height: 50 },
    version: housesVersion,
    render: (container) => {
        const rooms = dataManager.getCombinedData()?.characterHouseRoomMap;
        if (!rooms) return blank(container);

        const { affordable, total, cheapest } = affordableUpgrades(rooms, coinBalance());
        if (!total) return blank(container);

        rows(container, [
            [
                {
                    text: `${affordable} of ${total} affordable`,
                    // Nothing affordable is information, not an error — it just
                    // means the next one is still being saved for
                    color: affordable > 0 ? ROW_COLORS.good : ROW_COLORS.dim,
                },
            ],
            cheapest
                ? [
                      { text: cheapest.name, color: ROW_COLORS.gold, ellipsis: true },
                      { text: formatLargeNumber(Math.round(cheapest.cost)), color: ROW_COLORS.dim, push: true },
                  ]
                : null,
        ]);
    },
    onOpen: () => housesPanel.toggle(),
});
