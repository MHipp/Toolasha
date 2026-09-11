/**
 * Dungeon ROI board — the drawn half.
 *
 * Gathers what `dungeon-roi-board.js` needs (runs, sessions, the sim snapshot,
 * prices, reward tables) from the modules that own each, builds the rows, and
 * draws them as a sortable table inside the dungeon tracker panel. Every
 * figure the table shows carries a tooltip saying where it came from and a
 * `sim` mark when it was simulated rather than measured.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { calculateExpectedDrops, taxedDropValue } from '../combat-sim/combat-sim-adapter.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { loadSessions } from '../combat-stats/combat-session-history.js';
import dungeonTrackerStorage, { filterRunsForCharacter, currentCharacter } from './dungeon-tracker-storage.js';
import { buildDungeonRoiRows, sortRoiRows, ROI_SORT_COLUMNS } from './dungeon-roi-board.js';
import { loadAllZonesSnapshot } from '../../utils/all-zones-snapshot.js';
import { describeKeyCosts } from '../../utils/key-cost.js';
import { calculateDungeonTokenValue } from '../../utils/token-valuation.js';
import { entryKeyFor } from '../../utils/key-ledger.js';
import { DUNGEON_CHEST_ENTRY_KEYS, DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import { formatKMB } from '../../utils/formatters.js';
import { captureOwner, stillOurs } from '../../utils/init-ownership.js';

/** The tokens the dungeon shops take, which the expected-value calculator also special-cases */
const DUNGEON_TOKENS = new Set([
    '/items/chimerical_token',
    '/items/sinister_token',
    '/items/enchanted_token',
    '/items/pirate_token',
]);

const COLUMNS = [
    { key: 'dungeon', label: 'Dungeon', title: 'Dungeon and tier. "T?" holds runs recorded without a tier.' },
    { key: 'runs', label: 'Runs', title: 'Recorded runs for this dungeon and tier (this character).' },
    {
        key: 'clearSeconds',
        label: 'Clear',
        title: 'Median clear time of recorded runs; "sim" when from the combat sim.',
    },
    { key: 'wavesPerMinute', label: 'Waves/min', title: 'Dungeon waves per minute at that clear time.' },
    {
        key: 'keyCostPerRun',
        label: 'Keys/run',
        title: 'One entry key plus one chest key per chest, cheaper of buy and craft.',
    },
    {
        key: 'tokenValuePerRun',
        label: 'Tokens/run',
        title: 'Tokens per completion, priced at the best shop line per token.',
    },
    {
        key: 'chestEvPerRun',
        label: 'Chest EV/run',
        title: 'Chests per completion times their expected value (net of tax).',
    },
    {
        key: 'consumableCostPerRun',
        label: 'Food/run',
        title: 'Consumables burned per run: measured from session history, else sim.',
    },
    { key: 'netPerRun', label: 'Net/run', title: 'Rewards minus keys and consumables, per completion.' },
    { key: 'netPerHour', label: 'Gold/hr', title: 'Net per run at the clear time shown.' },
    { key: 'xpPerHour', label: 'XP/hr', title: 'Combat XP per hour: measured from session history, else sim.' },
    { key: 'confidence', label: 'Conf.', title: 'high ≥ 20 runs, medium ≥ 5, low ≥ 1, sim = no runs but simulated.' },
];

/**
 * Every dungeon the game data knows, in its own display order.
 * @returns {Array<{hrid: string, name: string, maxWaves: number, maxDifficulty: number}>}
 */
export function listDungeons() {
    const actionDetailMap = dataManager.getInitClientData()?.actionDetailMap || {};
    const dungeons = [];
    for (const [hrid, action] of Object.entries(actionDetailMap)) {
        if (action?.type !== '/action_types/combat' || action.combatZoneInfo?.isDungeon !== true) continue;
        dungeons.push({
            hrid,
            name: action.name || dungeonTrackerStorage.getDungeonInfo(hrid)?.name || hrid,
            maxWaves:
                action.combatZoneInfo?.dungeonInfo?.maxWaves ||
                dungeonTrackerStorage.getDungeonInfo(hrid)?.maxWaves ||
                0,
            maxDifficulty: action.maxDifficulty || 0,
            sortIndex: action.sortIndex ?? 0,
        });
    }
    dungeons.sort((a, b) => a.sortIndex - b.sortIndex);
    return dungeons;
}

/**
 * One completion's expected rewards, through the sim's own expected-drop routine.
 *
 * A one-completion synthetic result is handed to `calculateExpectedDrops` so the
 * per-completion chest split, the quantity bonus and the per-tier rates are the
 * ones the sim's revenue already uses, rather than a second reading of the table.
 *
 * @param {string} dungeonHrid - The dungeon action
 * @param {number} tier - Difficulty tier
 * @param {number} partySize - How many split the payout
 * @param {number} dropQuantity - Combat drop quantity bonus, as a fraction
 * @returns {Map<string, number>} itemHrid → expected count per completion
 */
export function rewardsPerCompletion(dungeonHrid, tier, partySize, dropQuantity) {
    const actionDetailMap = dataManager.getInitClientData()?.actionDetailMap || {};
    const simResult = {
        isDungeon: true,
        dungeonsCompleted: 1,
        zoneName: dungeonHrid,
        numberOfPlayers: partySize > 0 ? partySize : 1,
        difficultyTier: tier || 0,
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: dropQuantity || 0 },
        debuffOnLevelGap: { player1: 0 },
        deaths: {},
    };
    return calculateExpectedDrops(simResult, { actionDetailMap, combatMonsterDetailMap: {} }, 'player1');
}

/**
 * The entry key a dungeon takes: the game's own field where it names one, the
 * script's table otherwise.
 * @param {string} dungeonHrid - The dungeon action
 * @returns {string|null}
 */
function entryKeyOf(dungeonHrid) {
    const fromData = dataManager.getActionDetails(dungeonHrid)?.combatZoneInfo?.dungeonInfo?.keyItemHrid;
    if (typeof fromData === 'string' && fromData.startsWith('/items/')) return fromData;
    return entryKeyFor(dungeonHrid);
}

/**
 * The character's combat drop quantity bonus, from the latest combat snapshot.
 * @returns {number} A fraction; 0 when nothing has been seen yet
 */
function currentDropQuantity() {
    const latest = combatStatsDataCollector.getLatestData?.();
    const me = latest?.players?.find((player) => player?.isCurrentPlayer);
    const quantity = Number(me?.combatStats?.combatDropQuantity);
    return Number.isFinite(quantity) ? quantity : 0;
}

/**
 * What a consumable costs to replace, in the user's buy-side pricing mode.
 * @param {string} itemHrid - The consumable
 * @returns {number|null}
 */
function consumableBuyPrice(itemHrid) {
    const prices = marketAPI.getPrice(itemHrid);
    if (!prices) return null;
    const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
    const price = mode === 'optimistic' || mode === 'patientBuy' ? prices.bid : prices.ask;
    return price > 0 ? price : prices.ask > 0 ? prices.ask : null;
}

/**
 * The price functions the board multiplies by, bound to the live modules.
 * @param {Map<string, Object>} keyCosts - From `describeKeyCosts`, for every key the board may ask about
 * @returns {Object} `pricing` for `buildDungeonRoiRows`
 */
function livePricing(keyCosts) {
    return {
        rewardsPerRun: rewardsPerCompletion,
        isToken: (itemHrid) => DUNGEON_TOKENS.has(itemHrid),
        tokenValue: (itemHrid) => calculateDungeonTokenValue(itemHrid),
        valueOf: (itemHrid) => {
            // Containers are priced at their expected value; the calculator caches
            // one once it has been asked, so ask before resolving
            if (dataManager.getItemDetails(itemHrid)?.isOpenable) {
                const ev =
                    expectedValueCalculator.getCachedValue(itemHrid) ||
                    expectedValueCalculator.calculateSingleContainer(itemHrid);
                if (ev > 0) return ev;
            }
            const resolved = expectedValueCalculator.resolveSellSideValue(itemHrid);
            if (!resolved || !(resolved.value > 0)) return null;
            return resolved.needsTax ? taxedDropValue(itemHrid, resolved.value) : resolved.value;
        },
        keyCost: (keyHrid) => {
            const cost = keyCosts.get(keyHrid);
            return Number.isFinite(cost?.unitCost) ? cost.unitCost : null;
        },
        entryKeyFor: entryKeyOf,
        consumablePrice: consumableBuyPrice,
    };
}

/**
 * Seconds as m:ss, or h:mm:ss past an hour.
 * @param {number} seconds - Duration
 * @returns {string}
 */
function clock(seconds) {
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Gold, signed, or a dash.
 * @param {number|null} value - Coins
 * @returns {string}
 */
function gold(value) {
    if (!Number.isFinite(value)) return '—';
    return formatKMB(value);
}

/**
 * Why a row has no net figure.
 *
 * A missing cost is not a zero cost, so the board says "—" and says why rather
 * than quietly reporting the revenue as profit.
 * @param {Object} row - A board row
 * @returns {string} Tooltip text
 */
function costGapNote(row) {
    return row.costGap === 'keys'
        ? 'No net: at least one key this run needs has no market price, so the cost is unknown'
        : 'No net: no measured or simulated consumable cost for this tier, so the food bill is unknown';
}

/**
 * The arithmetic behind a net figure.
 * @param {Object} row - A board row
 * @returns {string} Tooltip text
 */
function netNote(row) {
    return (
        `Revenue ${gold(row.revenuePerRun)} − keys ${gold(row.keyCostPerRun ?? 0)} ` +
        `− food ${gold(row.consumableCostPerRun ?? 0)}`
    );
}

const CONFIDENCE_COLORS = {
    good: '#5fda5f',
    ok: '#ffc107',
    dim: '#aaa',
    sim: '#4a9eff',
    none: '#666',
};

class DungeonRoiBoardUI {
    constructor(state) {
        this.state = state;
        this.rows = [];
        this.sortColumn = 'netPerHour';
        this.sortAsc = false;
        this.filterTier = 'all';
        this.filterParty = 'all';
        this.container = null;
        this._rendering = null;
    }

    /**
     * Gather everything and draw the board into its section.
     *
     * Rebuilt from scratch on every call: the inputs are a few hundred runs and
     * four reward tables, and the panel only asks when its history changed or the
     * section was opened.
     *
     * @param {HTMLElement} container - The tracker panel
     * @returns {Promise<void>}
     */
    async render(container) {
        const host = container?.querySelector('#mwi-dt-roi-container');
        if (!host) return;
        this.container = container;

        // Renders queue in arrival order, so the last one asked for is the last
        // one drawn. Awaiting `this._rendering` and *then* claiming the slot let
        // two callers that were both parked on the same in-flight render resume
        // together: each overwrote the other's claim and both loads ran at once,
        // so whichever storage read happened to finish last drew — the older
        // filter as often as the newer one. Claiming the slot before suspending
        // makes each render wait for the one ahead of it instead of racing it.
        const previous = this._rendering;
        const run = (async () => {
            if (previous) {
                try {
                    await previous;
                } catch {
                    // A render that failed must not stop the one queued behind it
                }
            }
            await this._renderInto(host);
        })();
        this._rendering = run;
        try {
            await run;
        } finally {
            // Only if nothing has queued behind us: clearing unconditionally
            // would let the next render skip the wait for one still in flight
            if (this._rendering === run) this._rendering = null;
        }
    }

    /**
     * @param {HTMLElement} host - The section body
     * @private
     */
    async _renderInto(host) {
        let rows;
        try {
            rows = await this.buildRows();
        } catch (error) {
            console.error('[DungeonRoiBoard] Building the board failed:', error);
            host.innerHTML =
                '<div style="color: #ff6b6b; font-style: italic; text-align: center; padding: 8px;">The ROI board could not be drawn</div>';
            return;
        }
        // Null is `buildRows` saying the character changed while it was loading,
        // not "no dungeons". Leaving the previous board on screen is the honest
        // outcome: the switch builds a fresh panel, and drawing an empty table
        // here would read as "you have run nothing" for the character arriving.
        if (rows === null) return;
        this.rows = rows;
        this.draw(host);
    }

    /**
     * The rows, from the live modules.
     * @returns {Promise<Array<Object>|null>} Null when the character changed
     *   while the history was loading, so nothing should be drawn
     */
    async buildRows() {
        const dungeons = listDungeons();
        if (!dungeons.length) return [];

        // Who the board is answering for, taken before the loads suspend.
        //
        // The three reads below take seconds of wall clock between them — the
        // run store indexes a few hundred records and both of the others are
        // character-scoped storage reads that resolve their key *now* — and a
        // character switch lands inside that window. Reading `currentCharacter()`
        // after the await narrowed this character's run list to whoever had
        // arrived, and then drew those runs against the sessions and the sim
        // snapshot belonging to the character who left: one board, two
        // characters, every gold-per-hour figure on it built across the seam.
        const ticket = captureOwner(this);
        const character = currentCharacter();
        const filterCharacter = this.state?.filterCharacter || 'mine';

        const [allRuns, sessions, snapshot] = await Promise.all([
            dungeonTrackerStorage.getAllRuns(),
            loadSessions(),
            loadAllZonesSnapshot(),
        ]);
        // Before the first thing that reads live character state — the filter
        // below, the drop quantity and the prices further down all do
        if (!stillOurs(ticket)) return null;
        const runs = filterRunsForCharacter(allRuns, filterCharacter, character);

        // Every key the board could ask about, costed in one pass so the shared
        // recipe materials are priced once
        const keyHrids = new Set([
            ...Object.values(DUNGEON_CHEST_ENTRY_KEYS),
            ...Object.values(DUNGEON_CHEST_CHEST_KEYS),
        ]);
        for (const dungeon of dungeons) {
            const entry = entryKeyOf(dungeon.hrid);
            if (entry) keyHrids.add(entry);
        }
        const keyCosts = describeKeyCosts([...keyHrids]);

        return buildDungeonRoiRows({
            dungeons,
            runs,
            sessions,
            snapshot,
            filters: { tier: this.filterTier, partySize: this.filterParty },
            dropQuantity: currentDropQuantity(),
            pricing: livePricing(keyCosts),
        });
    }

    /**
     * Draw the rows as they stand, sorted and filtered.
     * @param {HTMLElement} host - The section body
     */
    draw(host) {
        host.innerHTML = '';

        host.appendChild(this.buildControls());

        if (!this.rows.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color: #888; font-style: italic; text-align: center; padding: 8px;';
            empty.textContent = 'No dungeons to show yet';
            host.appendChild(empty);
            return;
        }

        const scroller = document.createElement('div');
        scroller.style.cssText = 'overflow-x: auto; max-height: 260px; overflow-y: auto;';
        scroller.appendChild(this.buildTable(sortRoiRows(this.rows, this.sortColumn, this.sortAsc)));
        host.appendChild(scroller);

        const note = document.createElement('div');
        note.style.cssText = 'color: #888; font-size: 10px; padding: 4px 0 0;';
        const hasSim = this.rows.some((row) => row.clearSource === 'sim');
        const anySnapshotless = this.rows.some((row) => row.runs === 0 && row.clearSource !== 'sim');
        note.textContent =
            (hasSim ? 'Rows marked "sim" use the last All Zones run of the combat sim. ' : '') +
            (anySnapshotless
                ? "Run the combat sim's All Zones pass to fill clear time and food for dungeons you have not run."
                : '');
        if (note.textContent) host.appendChild(note);
    }

    /**
     * Tier and party-size filters.
     * @returns {HTMLElement}
     */
    buildControls() {
        const bar = document.createElement('div');
        bar.style.cssText =
            'display: flex; gap: 12px; align-items: center; font-size: 11px; color: #ccc; padding: 0 0 6px;';

        const tierOptions = new Set(['all']);
        for (const row of this.rows) tierOptions.add(row.tier === null ? '?' : String(row.tier));
        const tierSelect = this.buildSelect(
            'mwi-dt-roi-filter-tier',
            'Tier',
            [...tierOptions].map((value) => ({ value, label: value === 'all' ? 'All tiers' : `T${value}` })),
            this.filterTier
        );
        tierSelect.querySelector('select').addEventListener('change', (event) => {
            const value = event.target.value;
            this.filterTier = value === 'all' ? 'all' : value === '?' ? null : Number(value);
            this.render(this.container);
        });
        bar.appendChild(tierSelect);

        const partySelect = this.buildSelect(
            'mwi-dt-roi-filter-party',
            'Party',
            [
                { value: 'all', label: 'Any size' },
                ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} player${n === 1 ? '' : 's'}` })),
            ],
            this.filterParty
        );
        partySelect.querySelector('select').addEventListener('change', (event) => {
            const value = event.target.value;
            this.filterParty = value === 'all' ? 'all' : Number(value);
            this.render(this.container);
        });
        bar.appendChild(partySelect);

        return bar;
    }

    /**
     * @param {string} id - Element id
     * @param {string} label - Text before the select
     * @param {Array<{value: string, label: string}>} options - Choices
     * @param {string|number|null} current - The selected value
     * @returns {HTMLElement}
     */
    buildSelect(id, label, options, current) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display: inline-flex; gap: 6px; align-items: center;';
        wrap.appendChild(document.createTextNode(`${label}:`));

        const select = document.createElement('select');
        select.classList.add('toolasha-select');
        select.id = id;
        select.style.cssText =
            'background: #333; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-size: 11px;';
        const currentValue = current === null ? '?' : String(current);
        for (const option of options) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            if (option.value === currentValue) el.selected = true;
            select.appendChild(el);
        }
        wrap.appendChild(select);
        return wrap;
    }

    /**
     * The table itself.
     * @param {Array<Object>} rows - Sorted rows
     * @returns {HTMLTableElement}
     */
    buildTable(rows) {
        const table = document.createElement('table');
        table.id = 'mwi-dt-roi-table';
        table.style.cssText =
            'border-collapse: collapse; font-size: 11px; color: #ccc; white-space: nowrap; width: 100%;';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const column of COLUMNS) {
            const th = document.createElement('th');
            th.textContent = column.label + (this.sortColumn === column.key ? (this.sortAsc ? ' ▲' : ' ▼') : '');
            th.title = column.title;
            th.dataset.column = column.key;
            th.style.cssText =
                'text-align: right; padding: 3px 6px; border-bottom: 1px solid #555; color: #aaa; font-weight: bold; position: sticky; top: 0; background: rgba(0,0,0,0.95);' +
                (ROI_SORT_COLUMNS[column.key] ? ' cursor: pointer;' : '');
            if (column.key === 'dungeon') th.style.textAlign = 'left';
            if (ROI_SORT_COLUMNS[column.key]) {
                th.addEventListener('click', () => this.sortBy(column.key));
            }
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of rows) tbody.appendChild(this.buildRow(row));
        table.appendChild(tbody);
        return table;
    }

    /**
     * Change the sort, flipping direction on a repeat click.
     * @param {string} column - A key of `ROI_SORT_COLUMNS`
     */
    sortBy(column) {
        if (this.sortColumn === column) {
            this.sortAsc = !this.sortAsc;
        } else {
            this.sortColumn = column;
            this.sortAsc = ROI_SORT_COLUMNS[column]?.asc ?? false;
        }
        const host = this.container?.querySelector('#mwi-dt-roi-container');
        if (host) this.draw(host);
    }

    /**
     * One dungeon×tier line.
     * @param {Object} row - From `buildDungeonRoiRows`
     * @returns {HTMLTableRowElement}
     */
    buildRow(row) {
        const tr = document.createElement('tr');
        tr.className = 'mwi-dt-roi-row';
        tr.dataset.key = row.key;
        tr.style.borderBottom = '1px solid #333';

        const cell = (text, { title = '', color = '#ccc', align = 'right', mark = null } = {}) => {
            const td = document.createElement('td');
            td.style.cssText = `padding: 3px 6px; text-align: ${align}; color: ${color};`;
            td.textContent = text;
            if (mark) {
                const tag = document.createElement('span');
                tag.textContent = ` ${mark}`;
                tag.style.cssText = 'color: #4a9eff; font-size: 9px; font-weight: bold;';
                td.appendChild(tag);
            }
            if (title) td.title = title;
            tr.appendChild(td);
            return td;
        };

        const partyNote = `Party of ${row.partySize} (${
            {
                filter: 'from the filter',
                runs: 'most common in your runs',
                sim: 'as simulated',
                default: 'assumed solo',
            }[row.partySizeSource]
        })`;

        cell(`${row.dungeonName} ${row.tierLabel}`, {
            align: 'left',
            color: '#fff',
            title: row.tierAssumed
                ? `Runs recorded without a tier; rewards priced as T0. ${partyNote}.`
                : `${row.maxWaves} waves. ${partyNote}.`,
        });
        cell(String(row.runs), { title: row.runs ? 'Recorded runs on this row' : 'No recorded runs' });
        cell(row.clearSeconds ? clock(row.clearSeconds) : '—', {
            title:
                row.clearSource === 'measured'
                    ? `Median of ${row.runs} recorded run${row.runs === 1 ? '' : 's'}`
                    : row.clearSource === 'sim'
                      ? 'Simulated clear time from the last All Zones run'
                      : 'No runs and no simulation for this tier',
            mark: row.clearSource === 'sim' ? 'sim' : null,
        });
        cell(row.wavesPerMinute ? row.wavesPerMinute.toFixed(1) : '—', {
            mark: row.clearSource === 'sim' && row.wavesPerMinute ? 'sim' : null,
        });
        cell(gold(row.keyCostPerRun), {
            color: '#ff6b6b',
            title: row.keyEntries
                .map((entry) => {
                    const name = dataManager.getItemDetails?.(entry.itemHrid)?.name || entry.itemHrid.split('/').pop();
                    const unit = Number.isFinite(entry.unitCost) ? gold(entry.unitCost) : 'unpriced';
                    return `${entry.count % 1 === 0 ? entry.count : entry.count.toFixed(2)}× ${name} @ ${unit}`;
                })
                .join('\n'),
        });
        cell(gold(row.tokenValuePerRun), {
            color: '#5fda5f',
            title: row.tokenHrid
                ? `${row.tokensPerRun.toFixed(1)} tokens per run at the best shop line`
                : 'No tokens in this reward table',
        });
        cell(gold(row.chestEvPerRun), {
            color: '#5fda5f',
            title:
                `${row.chestsPerRun.toFixed(2)} chest${row.chestsPerRun === 1 ? '' : 's'}` +
                (row.refinementChestsPerRun > 0 ? ` + ${row.refinementChestsPerRun.toFixed(3)} refinement` : '') +
                ' per run, at expected value' +
                (row.otherValuePerRun > 0 ? `; other rewards ${gold(row.otherValuePerRun)}` : ''),
        });
        cell(gold(row.consumableCostPerRun), {
            color: '#ff6b6b',
            title:
                row.consumableSource === 'measured'
                    ? `From your archived sessions in this dungeon, ${gold(row.consumableCostPerHour)}/hr`
                    : row.consumableSource === 'sim'
                      ? `Simulated, ${gold(row.consumableCostPerHour)}/hr`
                      : 'No measured or simulated consumption',
            mark: row.consumableSource === 'sim' ? 'sim' : null,
        });
        cell(gold(row.netPerRun), {
            color: row.costComplete === false ? '#666' : row.netPerRun >= 0 ? '#fff' : '#ff6b6b',
            title: row.costComplete === false ? costGapNote(row) : netNote(row),
        });
        cell(gold(row.netPerHour), {
            color: !Number.isFinite(row.netPerHour) ? '#666' : row.netPerHour >= 0 ? '#5fda5f' : '#ff6b6b',
            title:
                row.costComplete === false
                    ? costGapNote(row)
                    : row.runsPerHour
                      ? `${row.runsPerHour.toFixed(2)} runs/hr`
                      : 'Needs a clear time',
            mark: row.clearSource === 'sim' && Number.isFinite(row.netPerHour) ? 'sim' : null,
        });
        cell(Number.isFinite(row.xpPerHour) ? formatKMB(row.xpPerHour) : '—', {
            title:
                row.xpSource === 'measured'
                    ? 'From your archived sessions in this dungeon'
                    : row.xpSource === 'sim'
                      ? 'Simulated'
                      : 'No measured or simulated XP',
            mark: row.xpSource === 'sim' ? 'sim' : null,
        });
        cell(row.confidence.label, {
            color: row.costComplete === false ? '#666' : CONFIDENCE_COLORS[row.confidence.tone] || '#aaa',
            title:
                row.costComplete === false
                    ? `${costGapNote(row)}\n${COLUMNS[COLUMNS.length - 1].title}`
                    : COLUMNS[COLUMNS.length - 1].title,
        });

        return tr;
    }
}

export default DungeonRoiBoardUI;
