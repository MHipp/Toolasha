/**
 * Enhancement XPH Calculator
 * Ranks all enhanceable items by expected XP per hour at the user's current stats.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { calculateSuccessXP, calculateFailureXP } from './enhancement-xp.js';
import { benchNote, enhancementParamsFor } from './enhancement-params-source.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import {
    getCheapestProtectionPrice,
    calculatePerAttemptMaterialCost,
    calculateEnhancementPath,
    buildEnhancementTooltipHTML,
} from './tooltip-enhancement.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import { getItemPrices } from '../../utils/market-data.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { capProfitRate, liquidityMarkerHtml } from '../../utils/liquidity-cap.js';
import { yieldToEventLoop } from '../../utils/background-work.js';

const PANEL_ID = 'mwi-xph-calc-panel';
const BTN_CLASS = 'mwi-xph-calc-btn';

/**
 * Calculate XPH and cost metrics for a single item.
 * @param {string} itemHrid
 * @param {Object} itemDetails
 * @param {number} maxLevel
 * @param {number} protectFrom
 * @param {Object} params - from enhancementParamsFor()
 * @returns {{itemHrid, name, xph, goldPerXP, costPerHour, costPartial, itemsPerHour, profitPerHour,
 *   profitUnavailableReason, liquidityLimit}|null}
 */
export function calculateItemXPH(itemHrid, itemDetails, maxLevel, protectFrom, params) {
    const itemLevel = itemDetails.itemLevel || 0;

    let calc;
    try {
        calc = calculateEnhancement({
            enhancingLevel: params.enhancingLevel,
            houseLevel: params.houseLevel,
            toolBonus: params.toolBonus,
            speedBonus: params.speedBonus,
            itemLevel,
            targetLevel: maxLevel,
            startLevel: 0,
            protectFrom,
            blessedTea: params.teas.blessed,
            guzzlingBonus: params.guzzlingBonus,
            blessedTeaBonus: params.blessedTeaBonus,
        });
    } catch {
        return null;
    }

    if (!calc?.visitCounts || calc.totalTime <= 0) return null;

    let totalXP = 0;
    for (let i = 0; i < maxLevel; i++) {
        const visits = calc.visitCounts[i];
        if (!visits) continue;
        const successRate = (calc.successRates[i]?.actualRate ?? 0) / 100;
        const successXP = calculateSuccessXP(i, itemHrid);
        const failXP = calculateFailureXP(i, itemHrid);
        totalXP += visits * (successRate * successXP + (1 - successRate) * failXP);
    }

    if (totalXP <= 0) return null;

    const xph = Math.round((totalXP / calc.totalTime) * 3600);
    // How many finished (level maxLevel) items this run produces per hour — the same
    // throughput costPerHour below is already priced against, just named for revenue too.
    const itemsPerHour = 3600 / calc.totalTime;

    // Material cost calculation — shared pricing rules: coins at face value, untradeable
    // trainee charms at their fixed price, and a one-sided market quote filled in from the
    // side that exists.
    const perAttempt = calculatePerAttemptMaterialCost(itemDetails);
    const materialCost = perAttempt.cost * calc.attempts;
    let costPartial = perAttempt.costPartial;
    const hasCost = perAttempt.hasCost;

    let goldPerXP = hasCost ? materialCost / totalXP : null;
    let costPerHour = hasCost ? goldPerXP * xph : null;

    // Protection cost — find cheapest option for this item
    let protectionItemName = null;
    if (protectFrom > 0 && calc.protectionCount > 0) {
        const protectionInfo = getCheapestProtectionPrice(itemHrid);
        if (protectionInfo.price > 0) {
            const protCost = protectionInfo.price * calc.protectionCount;
            const totalCost = (materialCost || 0) + protCost;
            goldPerXP = totalCost / totalXP;
            costPerHour = goldPerXP * xph;
            protectionItemName = dataManager.getInitClientData()?.itemDetailMap[protectionInfo.itemHrid]?.name || null;
        } else {
            costPartial = true;
        }
    }

    // Profit/hr: what the finished item sells for at the row's own target level, net of
    // marketplace tax, against the same per-hour cost above (materials, protection — time is
    // already what both figures are "per hour" of). An item whose enhanced form has no market
    // quote, or whose run cost is entirely unknown, is never reported as free or break-even —
    // it says so instead, via `profitUnavailableReason`, and the panel sorts it last.
    let profitPerHour = null;
    let profitUnavailableReason = null;
    const enhancedPrice = getItemPrices(itemHrid, maxLevel);
    const sellPrice = enhancedPrice
        ? enhancedPrice.bid > 0
            ? enhancedPrice.bid
            : enhancedPrice.ask > 0
              ? enhancedPrice.ask
              : null
        : null;

    if (sellPrice === null) {
        profitUnavailableReason = 'unpriced';
    } else if (costPerHour === null) {
        profitUnavailableReason = 'no-cost';
    } else {
        profitPerHour = calculatePriceAfterTax(sellPrice) * itemsPerHour - costPerHour;
    }

    return {
        itemHrid,
        name: itemDetails.name,
        protectionItemName,
        xph,
        goldPerXP,
        costPerHour,
        costPartial: hasCost && costPartial,
        itemsPerHour,
        profitPerHour,
        profitUnavailableReason,
        // Filled in by capXPHRowProfit() once the sweep knows what the market can absorb;
        // null here means "not checked yet", not "unbound".
        liquidityLimit: null,
    };
}

/**
 * Bound one row's profit/hr by how fast the finished item actually sells, using the shared
 * liquidity cap (`utils/liquidity-cap.js`) — the same bound the goal planner and the production
 * arbitrage board apply. A thin market gets its rate throttled and a marker instead of a fat
 * number nobody could realise; the row is copied, never edited in place, so `uncappedProfitPerHour`
 * survives for anything that wants the raw figure.
 *
 * @param {Object} row - From {@link calculateItemXPH}
 * @returns {Promise<Object>} The row, bounded where the market binds
 */
export async function capXPHRowProfit(row) {
    if (!(row.profitPerHour > 0)) return row;

    try {
        const capped = await capProfitRate({
            goldPerHour: row.profitPerHour,
            sells: [{ itemHrid: row.itemHrid, unitsPerHour: row.itemsPerHour }],
        });
        if (!capped.capped) return row;
        return {
            ...row,
            profitPerHour: capped.goldPerHour,
            uncappedProfitPerHour: row.profitPerHour,
            liquidityLimit: capped.limit,
        };
    } catch (error) {
        console.error('[XPHCalculator] Bounding profit by market volume failed:', error);
        return row;
    }
}

class XPHCalculator {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        this.panel = null;
        this.tableBody = null;
        this.sortColumn = 'xph';
        this.sortAsc = false;
        this.lastResults = [];
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('enhancementXPH')) return;

        this.isInitialized = true;
        this._buildPanel();

        const unregister = domObserver.onClass('XPHCalculator', 'EnhancingPanel_enhancingPanel', (panel) =>
            this._injectButton(panel)
        );
        this.unregisterHandlers.push(unregister);

        document.querySelectorAll('[class*="EnhancingPanel_enhancingPanel"]').forEach((panel) => {
            this._injectButton(panel);
        });

        // The injected button only exists while the enhancing panel is on
        // screen, so off that page there was no way to reach this at all
        registerCommand({
            name: 'Enhancing XP/hr',
            hint: 'Enhancing experience and cost per hour',
            run: () => this._toggle(),
        });
    }

    _injectButton(panel) {
        if (panel.querySelector(`.${BTN_CLASS}`)) return;

        const btn = document.createElement('button');
        btn.className = BTN_CLASS;
        btn.textContent = 'XPH Calc';
        btn.style.cssText = `
            background: linear-gradient(180deg, rgba(0,200,150,0.2) 0%, rgba(0,200,150,0.1) 100%);
            color: #e0e0e0;
            border: 1px solid rgba(0,200,150,0.4);
            border-radius: 6px;
            padding: 5px 12px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            margin: 4px 8px;
            display: block;
        `;
        btn.addEventListener('click', () => this._toggle());
        panel.insertBefore(btn, panel.firstChild);
    }

    _toggle() {
        if (!this.panel) return;
        const visible = this.panel.style.display !== 'none';
        this.panel.style.display = visible ? 'none' : 'flex';
        if (!visible) bringPanelToFront(this.panel);
    }

    _buildPanel() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        this.panel.style.cssText = `
            position: fixed;
            top: 60px;
            right: 60px;
            z-index: ${config.Z_FLOATING_PANEL};
            background: rgba(10, 10, 20, 0.97);
            border: 2px solid rgba(0, 200, 150, 0.5);
            border-radius: 10px;
            width: 560px;
            max-height: 580px;
            display: none;
            flex-direction: column;
            font-family: 'Segoe UI', sans-serif;
            color: #e0e0e0;
            font-size: 13px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            cursor: grab;
            background: rgba(0,200,150,0.12);
            border-bottom: 1px solid rgba(0,200,150,0.3);
            border-radius: 8px 8px 0 0;
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-weight:700; font-size:14px; color:#00c896;">Enhancement XPH Calculator</span>
            <button id="mwi-xph-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">×</button>
        `;
        this._setupDrag(header);

        // Controls row
        const controls = document.createElement('div');
        controls.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;

        const defaultMax = config.getSettingValue('enhancementXPH_maxLevel') || '6';
        const defaultProtect = config.getSettingValue('enhancementXPH_protectFrom') || '0';

        const inputStyle =
            'width:46px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;';

        controls.innerHTML = `
            <label style="color:#888; font-size:12px;">Max level</label>
            <input id="mwi-xph-maxlevel" type="number" min="1" max="20" value="${defaultMax}" style="${inputStyle}">
            <label style="color:#888; font-size:12px; margin-left:6px;">Protect from</label>
            <input id="mwi-xph-protect" type="number" min="0" max="19" value="${defaultProtect}" style="${inputStyle}">
            <button id="mwi-xph-run" style="
                margin-left: auto;
                background: rgba(0,200,150,0.2);
                color: #00c896;
                border: 1px solid rgba(0,200,150,0.4);
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;">Calculate</button>
        `;

        // "Enhance any item" — a route for an item you neither own nor see
        // listed. The route math needs no market data (base item falls back to
        // its crafting cost), so any enhanceable item can be quoted here.
        const routeSection = document.createElement('div');
        routeSection.style.cssText = 'padding: 8px 14px; border-bottom: 1px solid #222; flex-shrink: 0;';
        routeSection.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <label style="color:#888; font-size:12px;">Enhance any item</label>
                <input id="mwi-xph-item" list="mwi-xph-item-list" placeholder="type an item name…"
                    style="flex:1; min-width:140px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                    border-radius:4px; padding:3px 8px; font-size:12px;">
                <datalist id="mwi-xph-item-list"></datalist>
                <label style="color:#888; font-size:12px;">to +</label>
                <input id="mwi-xph-item-target" type="number" min="1" max="20" value="${defaultMax}" style="${inputStyle}">
                <button id="mwi-xph-item-route" style="
                    background: rgba(0,200,150,0.2); color: #00c896; border: 1px solid rgba(0,200,150,0.4);
                    border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;">Route</button>
            </div>
            <div id="mwi-xph-item-route-out" style="display:none; margin-top:8px; max-height:240px; overflow-y:auto;
                background:rgba(0,0,0,0.25); border:1px solid #222; border-radius:6px; padding:8px; font-size:12px;"></div>
        `;

        // Table container
        const tableContainer = document.createElement('div');
        tableContainer.style.cssText = 'overflow-y: auto; flex: 1;';

        const thBase =
            'padding:6px 10px; font-weight:600; font-size:11px; cursor:pointer; white-space:nowrap; border-bottom:1px solid #222; color:#888;';
        tableContainer.innerHTML = `
            <table style="width:100%; border-collapse:collapse;">
                <thead style="position:sticky; top:0; background:#0a0a14; z-index:1;">
                    <tr>
                        <th id="mwi-xph-th-name" style="${thBase} text-align:left;"># Item</th>
                        <th id="mwi-xph-th-xph"  style="${thBase} text-align:right;">XP/hr ▼</th>
                        <th id="mwi-xph-th-gpx"  style="${thBase} text-align:right;">Gold/XP</th>
                        <th id="mwi-xph-th-cphr" style="${thBase} text-align:right;">Cost/hr</th>
                        <th id="mwi-xph-th-profit" style="${thBase} text-align:right;">Profit/hr</th>
                    </tr>
                </thead>
                <tbody id="mwi-xph-tbody"></tbody>
            </table>
        `;

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-xph-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Enter parameters and click Calculate.';

        this.panel.appendChild(header);
        this.panel.appendChild(controls);
        this.panel.appendChild(routeSection);
        this.panel.appendChild(tableContainer);
        this.panel.appendChild(status);
        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);

        this.tableBody = this.panel.querySelector('#mwi-xph-tbody');

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: [controls, routeSection, tableContainer, status],
            panelKey: PANEL_ID,
            beforeEl: header.querySelector('#mwi-xph-close'),
            accent: '#aaa',
        });

        this.panel.querySelector('#mwi-xph-close').addEventListener('click', () => {
            this.panel.style.display = 'none';
        });
        this.panel.querySelector('#mwi-xph-run').addEventListener('click', () => this._run());
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        ['name', 'xph', 'gpx', 'cphr', 'profit'].forEach((col) => {
            this.panel.querySelector(`#mwi-xph-th-${col}`)?.addEventListener('click', () => this._sort(col));
        });

        const itemInput = this.panel.querySelector('#mwi-xph-item');
        itemInput.addEventListener('focus', () => this._populateItemList());
        this.panel.querySelector('#mwi-xph-item-route').addEventListener('click', () => this._showItemRoute());
        itemInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._showItemRoute();
        });
    }

    /**
     * Fill the item datalist with every enhanceable item, once. Built lazily on
     * first focus because game data may not be loaded when the panel is created.
     * @private
     */
    _populateItemList() {
        if (this._itemsByName) return;
        const gameData = dataManager.getInitClientData();
        const map = gameData?.itemDetailMap;
        if (!map) return;

        this._itemsByName = new Map();
        const options = [];
        for (const [hrid, details] of Object.entries(map)) {
            if (!details.enhancementCosts?.length || !details.name) continue;
            this._itemsByName.set(details.name.toLowerCase(), hrid);
            options.push(`<option value="${details.name.replace(/"/g, '&quot;')}"></option>`);
        }
        const list = this.panel?.querySelector('#mwi-xph-item-list');
        if (list) list.innerHTML = options.join('');
    }

    /**
     * Compute and render the enhancing route for the typed item and target level,
     * regardless of ownership or market listings.
     * @private
     */
    _showItemRoute() {
        const out = this.panel?.querySelector('#mwi-xph-item-route-out');
        if (!out) return;
        out.style.display = 'block';

        this._populateItemList();
        const name = (this.panel.querySelector('#mwi-xph-item')?.value || '').trim().toLowerCase();
        const hrid = this._itemsByName?.get(name);
        if (!hrid) {
            out.innerHTML = '<div style="color:#888;">Type an enhanceable item name and pick it from the list.</div>';
            return;
        }

        const target = Math.max(
            1,
            Math.min(20, parseInt(this.panel.querySelector('#mwi-xph-item-target')?.value, 10) || 1)
        );
        let data = null;
        try {
            data = calculateEnhancementPath(hrid, target, enhancementParamsFor('lab:route', hrid));
        } catch (error) {
            console.error('[XPHCalculator] Route failed:', error);
        }
        out.innerHTML = data
            ? buildEnhancementTooltipHTML(data)
            : '<div style="color:#888;">No route available (item not enhanceable, or game data not loaded).</div>';
    }

    _setupDrag(header) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        header.style.touchAction = 'none';

        header.addEventListener('pointerdown', (e) => {
            if (e.target.id === 'mwi-xph-close') return;
            this.isDragging = true;
            header.style.cursor = 'grabbing';
            const rect = this.panel.getBoundingClientRect();
            this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            bringPanelToFront(this.panel);

            const onMove = (ev) => {
                if (!this.isDragging) return;
                this.panel.style.left = `${ev.clientX - this.dragOffset.x}px`;
                this.panel.style.top = `${ev.clientY - this.dragOffset.y}px`;
                this.panel.style.right = 'auto';
            };
            const onUp = () => {
                this.isDragging = false;
                header.style.cursor = 'grab';
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    _run() {
        const maxLevel = Math.min(20, Math.max(1, parseInt(this.panel.querySelector('#mwi-xph-maxlevel').value) || 6));
        const protectFrom = Math.min(
            maxLevel - 1,
            Math.max(0, parseInt(this.panel.querySelector('#mwi-xph-protect').value) || 0)
        );

        const status = this.panel.querySelector('#mwi-xph-status');
        status.textContent = 'Calculating…';
        this.tableBody.innerHTML = '';

        const t = setTimeout(async () => {
            try {
                await this._compute(maxLevel, protectFrom);
            } catch (err) {
                console.error('[XPHCalculator] Error:', err);
                status.textContent = 'Error during calculation.';
            }
        }, 10);
        this.timerRegistry.registerTimeout(t);
    }

    async _compute(maxLevel, protectFrom) {
        const gameData = dataManager.getInitClientData();
        const status = this.panel.querySelector('#mwi-xph-status');
        if (!gameData) {
            status.textContent = 'No game data available.';
            return;
        }

        // One bench for the whole ranking: the sweep is over every enhanceable item in the
        // game, so there is no single piece to ask whether anybody could sell it finished.
        const params = enhancementParamsFor('lab:ranking');
        const results = [];

        for (const [itemHrid, itemDetails] of Object.entries(gameData.itemDetailMap || {})) {
            if (!itemDetails.enhancementCosts?.length) continue;
            const result = calculateItemXPH(itemHrid, itemDetails, maxLevel, protectFrom, params);
            if (result) results.push(result);
        }

        // Bound every priced row's profit by what the market can actually absorb, in slices
        // so a full-game sweep doesn't freeze the panel while the volume lookups run.
        const CAP_BATCH_SIZE = 24;
        for (let i = 0; i < results.length; i += CAP_BATCH_SIZE) {
            const slice = results.slice(i, i + CAP_BATCH_SIZE);
            const bounded = await Promise.all(slice.map((row) => capXPHRowProfit(row)));
            results.splice(i, bounded.length, ...bounded);
            await yieldToEventLoop();
        }

        this.lastResults = results;
        this.sortColumn = 'xph';
        this.sortAsc = false;
        this._render();
        this._updateSortIndicators();

        const withCost = results.filter((r) => r.costPerHour !== null).length;
        const withProfit = results.filter((r) => r.profitPerHour !== null).length;
        const partialNote = results.some((r) => r.costPartial) ? ' * = partial price data.' : '';
        // Say so when the ranking was built on somebody else's bench — hand-entered
        // stats or the Pro kit — instead of this character's. Pro especially: the
        // item route beside this table wears a chip, and a ranking quoting the
        // professional's bench in silence next to it read as this character's own.
        const sourceNote = benchNote(params);
        status.textContent =
            `${results.length} items · ${withCost} with cost data · ${withProfit} priced for profit.${partialNote}` +
            (sourceNote ? ` · ${sourceNote}` : '');
    }

    _sort(col) {
        const colMap = { name: 'name', xph: 'xph', gpx: 'goldPerXP', cphr: 'costPerHour', profit: 'profitPerHour' };
        const key = colMap[col];
        if (this.sortColumn === key) {
            this.sortAsc = !this.sortAsc;
        } else {
            this.sortColumn = key;
            this.sortAsc = col === 'name';
        }
        this._render();
        this._updateSortIndicators();
    }

    _updateSortIndicators() {
        const colMap = { name: 'name', xph: 'xph', goldPerXP: 'gpx', costPerHour: 'cphr', profitPerHour: 'profit' };
        const activeId = colMap[this.sortColumn];
        ['name', 'xph', 'gpx', 'cphr', 'profit'].forEach((col) => {
            const th = this.panel.querySelector(`#mwi-xph-th-${col}`);
            if (!th) return;
            const base = th.textContent.replace(/\s*[▲▼]$/, '').trimEnd();
            th.textContent = col === activeId ? `${base} ${this.sortAsc ? '▲' : '▼'}` : base;
        });
    }

    _render() {
        const sorted = [...this.lastResults].sort((a, b) => {
            const key = this.sortColumn;
            const av = a[key];
            const bv = b[key];
            if (av === null && bv === null) return 0;
            if (av === null) return 1;
            if (bv === null) return -1;
            if (typeof av === 'string') return this.sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
            return this.sortAsc ? av - bv : bv - av;
        });

        const tdR = 'padding:5px 10px; text-align:right; border-bottom:1px solid #141414;';
        const tdL = `padding:5px 10px; text-align:left; border-bottom:1px solid #141414;
            max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;

        this.tableBody.innerHTML = sorted
            .map(
                (r, i) => `
            <tr style="${i % 2 ? 'background:rgba(255,255,255,0.02)' : ''}">
                <td style="${tdL}" title="${r.name}${r.protectionItemName ? ` (${r.protectionItemName})` : ''}">${i + 1}. ${r.name}${r.protectionItemName ? ` <span style="color:#888; font-size:11px;">(${r.protectionItemName})</span>` : ''}</td>
                <td style="${tdR} color:#00c896;">${formatWithSeparator(r.xph)}</td>
                <td style="${tdR}${r.goldPerXP === null ? ' color:#444;' : ''}">
                    ${r.goldPerXP !== null ? `${r.goldPerXP.toFixed(3)}${r.costPartial ? '*' : ''}` : '—'}
                </td>
                <td style="${tdR}${r.costPerHour === null ? ' color:#444;' : ''}">
                    ${r.costPerHour !== null ? `${formatKMB(Math.round(r.costPerHour))}${r.costPartial ? '*' : ''}` : '—'}
                </td>
                <td style="${tdR}">${this._profitCellHTML(r)}</td>
            </tr>`
            )
            .join('');
    }

    /**
     * Profit/hr cell contents: the coloured figure with its liquidity marker when the market
     * bounds it, or a label — never a bare dash — when the row could not be priced at all.
     * @param {Object} r - A row from {@link calculateItemXPH} / {@link capXPHRowProfit}
     * @returns {string} Inner HTML for the cell
     * @private
     */
    _profitCellHTML(r) {
        if (r.profitPerHour === null) {
            const label = r.profitUnavailableReason === 'unpriced' ? 'unpriced' : 'no cost data';
            const title =
                r.profitUnavailableReason === 'unpriced'
                    ? 'No market price for the enhanced item at this level'
                    : 'No cost data available for this item';
            return `<span style="color:#444;" title="${title}">${label}</span>`;
        }

        const color = r.profitPerHour < 0 ? '#ff6b6b' : '#00c896';
        const marker = r.liquidityLimit ? liquidityMarkerHtml(r.liquidityLimit, { compact: true }) : '';
        return `<span style="color:${color};">${formatKMB(Math.round(r.profitPerHour))}${r.costPartial ? '*' : ''}</span>${marker}`;
    }

    disable() {
        try {
            unregisterCommand('Enhancing XP/hr');
            this.unregisterHandlers.forEach((fn) => fn());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();
            this.minimizeCtl?.destroy();
            this.minimizeCtl = null;
            if (this.panel) {
                unregisterFloatingPanel(this.panel);
                this.panel.remove();
                this.panel = null;
            }
            document.querySelectorAll(`.${BTN_CLASS}`).forEach((el) => el.remove());
            this.isInitialized = false;
        } catch (error) {
            console.error('[Enhancement XPH Calculator] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const xphCalculator = new XPHCalculator();
export default xphCalculator;
