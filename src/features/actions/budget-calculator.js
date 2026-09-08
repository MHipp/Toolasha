/**
 * Budget Calculator
 * Calculates how many units you can produce within a gold budget,
 * buying missing tradeable materials at ask price.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { calculateMaterialRequirements } from '../../utils/material-calculator.js';
import { formatKMB, formatWithSeparator, parseKMB } from '../../utils/formatters.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { onDetailPanel, resolveDetailPanel } from '../../utils/action-panel-helper.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';
import { release, reserve } from '../../utils/inventory-reservations.js';

const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

const UI_ID = 'mwi-budget-calculator';

/**
 * The owner the calculator claims stock under, while its breakdown is open.
 *
 * Transient by nature: a budget calculation is a question, not a plan, and the
 * claim exists only so that a plan being costed elsewhere at the same moment
 * does not count the same stock twice. It goes when the modal closes.
 */
const RESERVATION_OWNER = 'budgetCalculator';

/**
 * Get action HRID from panel element.
 * @param {HTMLElement} panel
 * @returns {string|null}
 */
function getActionHridFromPanel(panel) {
    return resolveDetailPanel(panel).actionHrid;
}

/**
 * Find the action count input element within a panel.
 * @param {HTMLElement} panel
 * @returns {HTMLInputElement|null}
 */
function findActionInput(panel) {
    return panel.querySelector('[class*="maxActionCountInput"] input') || null;
}

/**
 * Binary search for maximum units produceable within budget.
 * @param {string} actionHrid
 * @param {number} budget
 * @returns {{n: number, materials: Array}|null} null if no tradeable materials with prices
 */
function findMaxUnits(actionHrid, budget) {
    const gameData = dataManager.getInitClientData();
    const actionDetail = gameData?.actionDetailMap[actionHrid];
    if (!actionDetail) return null;
    if (!PRODUCTION_TYPES.includes(actionDetail.type)) return null;
    if (!actionDetail.inputItems?.length) return null;

    // Verify at least one tradeable material has a market price
    const hasTradeableMat = actionDetail.inputItems.some((input) => {
        const itemDetails = gameData.itemDetailMap[input.itemHrid];
        if (!itemDetails?.isTradable) return false;
        const price = marketAPI.getPrice(input.itemHrid);
        return price?.ask > 0;
    });
    if (!hasTradeableMat) return null;

    /**
     * Calculate purchase cost for N units using current inventory.
     * @param {number} n
     * @returns {number}
     */
    const costForN = (n) => {
        if (n <= 0) return 0;
        const mats = calculateMaterialRequirements(actionHrid, n, false, { ownerId: RESERVATION_OWNER });
        let total = 0;
        for (const mat of mats) {
            if (!mat.isTradeable || mat.missing <= 0) continue;
            const price = marketAPI.getPrice(mat.itemHrid);
            if (!price?.ask) continue;
            total += mat.missing * price.ask;
        }
        return total;
    };

    // If we can't afford even 1 unit, return 0
    if (costForN(1) > budget) {
        const materials = calculateMaterialRequirements(actionHrid, 1, false, { ownerId: RESERVATION_OWNER });
        return { n: 0, materials };
    }

    // Binary search: find max n where cost <= budget
    let lo = 1;
    let hi = 10_000_000;

    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (costForN(mid) <= budget) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    const materials = calculateMaterialRequirements(actionHrid, lo, false, { ownerId: RESERVATION_OWNER });
    return { n: lo, materials };
}

/**
 * Show the breakdown modal for a budget calculation result.
 * @param {number} budget - The budget entered
 * @param {{n: number, materials: Array}} result
 */
function showBreakdownModal(budget, result) {
    // Remove any existing modal
    document.getElementById('mwi-budget-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mwi-budget-modal-overlay';
    overlay.style.cssText = `
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.75);
        z-index: ${PANEL_Z_CAP + 1};
        display: flex; align-items: center; justify-content: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: #1a1a1a;
        border: 2px solid #3a3a3a;
        border-radius: 8px;
        padding: 20px;
        max-width: 680px;
        width: 95%;
        max-height: 85vh;
        overflow-y: auto;
        color: #e0e0e0;
        font-size: 13px;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid #3a3a3a;
    `;
    header.innerHTML = `
        <div>
            <span style="font-size:15px; font-weight:600; color:#e0e0e0;">Budget Calculator</span>
            <span style="margin-left:10px; color:#aaa;">
                Budget: <strong style="color:#fff;">${formatKMB(budget)}</strong>
                &nbsp;→&nbsp;
                <strong style="color:#7ec87e;">${formatWithSeparator(result.n)} units</strong>
            </span>
        </div>
        <button id="mwi-budget-modal-close" style="
            background:none; border:none; color:#aaa; font-size:24px; cursor:pointer; padding:0; line-height:1;
        ">×</button>
    `;

    // Table
    const tableWrap = document.createElement('div');
    tableWrap.style.cssText = 'overflow-x: auto;';

    const thStyle =
        'padding:6px 10px; text-align:right; color:#aaa; font-weight:500; white-space:nowrap; border-bottom:1px solid #3a3a3a;';
    const thLeftStyle =
        'padding:6px 10px; text-align:left; color:#aaa; font-weight:500; white-space:nowrap; border-bottom:1px solid #3a3a3a;';
    const tdStyle = 'padding:5px 10px; text-align:right; border-bottom:1px solid #252525;';
    const tdLeftStyle = 'padding:5px 10px; text-align:left; border-bottom:1px solid #252525;';
    const tdDimStyle = 'padding:5px 10px; text-align:right; color:#666; border-bottom:1px solid #252525;';

    let totalSpend = 0;
    let perUnitCost = 0;
    // The binary search charges nothing for a tradeable material the market has no ask for,
    // so a shortfall in one of those makes the unit count an upper bound, not a promise.
    let hasUnpricedShortfall = false;

    const rows = result.materials
        .map((mat) => {
            const price = mat.isTradeable ? marketAPI.getPrice(mat.itemHrid) : null;
            const ask = price?.ask > 0 ? price.ask : null;
            const lineCost = ask && mat.missing > 0 ? mat.missing * ask : 0;
            if (mat.isTradeable && mat.missing > 0 && !ask) hasUnpricedShortfall = true;
            totalSpend += lineCost;
            if (ask) perUnitCost += ask * (mat.required / (result.n || 1));

            const toBuyCell = mat.isTradeable
                ? `<td style="${tdStyle}; color:${mat.missing > 0 ? '#e8a87c' : '#7ec87e'};">${formatWithSeparator(mat.missing)}</td>`
                : `<td style="${tdDimStyle}">—</td>`;

            const askCell = ask
                ? `<td style="${tdStyle}">${formatKMB(ask)}</td>`
                : `<td style="${tdDimStyle}">${mat.isTradeable ? 'No data' : '—'}</td>`;

            const costCell =
                lineCost > 0
                    ? `<td style="${tdStyle}; color:#e8a87c;">${formatKMB(lineCost)}</td>`
                    : `<td style="${tdDimStyle}">${mat.isTradeable ? '0' : '—'}</td>`;

            return `
            <tr>
                <td style="${tdLeftStyle}">${mat.itemName}</td>
                <td style="${tdStyle}">${formatWithSeparator(mat.required)}</td>
                <td style="${tdStyle}; color:${mat.have >= mat.required ? '#7ec87e' : '#e0e0e0'};">${formatWithSeparator(mat.have)}</td>
                ${toBuyCell}
                ${askCell}
                ${costCell}
            </tr>
        `;
        })
        .join('');

    const summaryRowStyle = 'padding:7px 10px; text-align:right; border-top:2px solid #3a3a3a; font-weight:600;';

    tableWrap.innerHTML = `
        <table style="width:100%; border-collapse:collapse;">
            <thead>
                <tr>
                    <th style="${thLeftStyle}">Ingredient</th>
                    <th style="${thStyle}">Required</th>
                    <th style="${thStyle}">On Hand</th>
                    <th style="${thStyle}">To Buy</th>
                    <th style="${thStyle}">Ask Price</th>
                    <th style="${thStyle}">Total Cost</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr>
                    <td colspan="5" style="${summaryRowStyle}; text-align:left; color:#aaa;">Per unit cost (ask)</td>
                    <td style="${summaryRowStyle}">${formatKMB(Math.round(perUnitCost))}</td>
                </tr>
                <tr>
                    <td colspan="5" style="${summaryRowStyle}; text-align:left; color:#aaa;">Total spend</td>
                    <td style="${summaryRowStyle}; color:#7ec87e;">${formatKMB(totalSpend)}</td>
                </tr>
            </tfoot>
        </table>
    `;

    modal.appendChild(header);
    modal.appendChild(tableWrap);

    // A shortfall the bag would have covered is another plan's claim, and the
    // modal is where the player is looking at that shortfall
    const claimed = result.materials.find((mat) => mat.reservedNote);
    if (claimed) {
        const note = document.createElement('div');
        note.id = 'mwi-budget-reserved-note';
        note.style.cssText = `
            margin-top: 12px; padding: 7px 10px; border-radius: 4px;
            background: rgba(232,168,124,0.12); border: 1px solid rgba(232,168,124,0.35);
            color: #e8a87c; font-size: 12px;
        `;
        note.textContent = `${claimed.itemName}: ${claimed.reservedNote}`;
        modal.appendChild(note);
    }

    if (hasUnpricedShortfall) {
        const note = document.createElement('div');
        note.id = 'mwi-budget-unpriced-note';
        note.style.cssText = `
            margin-top: 12px; padding: 7px 10px; border-radius: 4px;
            background: rgba(232,168,124,0.12); border: 1px solid rgba(232,168,124,0.35);
            color: #e8a87c; font-size: 12px;
        `;
        note.textContent =
            'Some materials you still need have no market data and were counted as free — ' +
            'the unit figure above is an upper bound, not a price you can actually pay.';
        modal.appendChild(note);
    }
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // The required totals, not the shortfall: what the bag already holds for
    // this budget is spoken for too, and claiming only the part being bought
    // would leave the rest looking free to every other plan
    reserve(
        RESERVATION_OWNER,
        result.materials.map((mat) => ({ itemHrid: mat.itemHrid, count: mat.required })),
        { label: 'Budget calculator' }
    );

    // close() is reachable three ways (×, backdrop click, Escape), but only the Escape path used
    // to detach this listener. Dismissing via the other two left it on `document` forever, and
    // since a fresh listener is added every time the modal reopens, repeatedly opening and
    // closing it by mouse alone grew an unbounded pile of keydown listeners that outlived the
    // panel — and even disable(), which only ever removed the overlay element.
    const onEsc = (e) => {
        if (e.key === 'Escape') close();
    };
    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onEsc);
        release(RESERVATION_OWNER);
    };
    overlay.querySelector('#mwi-budget-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onEsc);
}

class BudgetCalculator {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        this.processedPanels = new WeakSet();
        // A Set, not a WeakMap: an entry surviving GC was never the leak — a
        // live MutationObserver is a strong reference the other direction
        // (panel → observer, via the browser's internal observer registry),
        // so nothing here was ever going to be collected while the panel
        // stays open. disable() has to disconnect every observer itself,
        // which means holding something it can actually iterate.
        this.panelObservers = new Set();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('actions_budgetCalculator')) return;

        this.isInitialized = true;

        const unregister = onDetailPanel((context) => this._processPanel(context));
        this.unregisterHandlers.push(unregister);

        this._processActionPanels();
    }

    _processActionPanels() {
        document.querySelectorAll('[class*="SkillActionDetail_skillActionDetail"]').forEach((panel) => {
            this._processPanel(resolveDetailPanel(panel));
        });
    }

    /**
     * Attach to one production panel, once
     * @param {import('../../utils/action-panel-helper.js').ActionPanelContext} context
     */
    _processPanel({ panel, actionHrid, actionDetails }) {
        if (this.processedPanels.has(panel)) return;
        if (!actionHrid) return;

        if (!actionDetails || !PRODUCTION_TYPES.includes(actionDetails.type)) return;
        if (!actionDetails.inputItems?.length) return;

        this.processedPanels.add(panel);
        this._attachToPanel(panel);
    }

    /**
     * Create and inject the budget UI into a panel, and keep it positioned
     * after #mwi-missing-mats-button via a MutationObserver.
     * @param {HTMLElement} panel
     */
    _attachToPanel(panel) {
        const ui = this._createUI(panel);

        const position = () => {
            const existing = panel.querySelector(`#${UI_ID}`);
            const missingMatsBtn = panel.querySelector('#mwi-missing-mats-button');
            const itemRequirements = panel.querySelector('[class*="SkillActionDetail_itemRequirements"]');
            const anchor = missingMatsBtn || itemRequirements;
            if (!anchor) return;

            if (existing) {
                // Already present — ensure it's right after anchor
                if (existing.previousSibling !== anchor) {
                    anchor.parentNode.insertBefore(existing, anchor.nextSibling);
                }
            } else {
                anchor.parentNode.insertBefore(ui, anchor.nextSibling);
            }
        };

        position();

        // Re-position whenever the panel's children change (e.g. missing mats button recreated)
        const obs = new MutationObserver((mutations) => {
            const relevant = mutations.some((m) =>
                [...m.addedNodes, ...m.removedNodes].some((n) => n.id === 'mwi-missing-mats-button' || n.id === UI_ID)
            );
            if (relevant) position();
        });
        obs.observe(panel, { childList: true, subtree: false });
        this.panelObservers.add(obs);
    }

    /**
     * Build the budget input + Calculate button + Details link for a panel.
     * @param {HTMLElement} panel
     * @returns {HTMLElement}
     */
    _createUI(panel) {
        const wrapper = document.createElement('div');
        wrapper.id = UI_ID;
        wrapper.style.cssText =
            'display:flex; align-items:center; gap:6px; margin: 4px 0 8px 0; padding: 0 0;' +
            // The row may not outgrow the column it sits in; the Calculate
            // button was hanging past the edge of the action panel
            'box-sizing:border-box; max-width:100%;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Budget (e.g. 50m)';
        input.style.cssText = `
            flex: 1;
            background: #2a2a2a;
            color: #e0e0e0;
            border: 1px solid #555;
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 13px;
            min-width: 0;
        `;

        const calcBtn = document.createElement('button');
        calcBtn.textContent = 'Calculate';
        calcBtn.style.cssText = `
            background: linear-gradient(180deg, rgba(126,200,126,0.2) 0%, rgba(126,200,126,0.1) 100%);
            color: #e0e0e0;
            border: 1px solid rgba(126,200,126,0.4);
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
        `;
        calcBtn.addEventListener('mouseenter', () => {
            calcBtn.style.background =
                'linear-gradient(180deg, rgba(126,200,126,0.35) 0%, rgba(126,200,126,0.25) 100%)';
        });
        calcBtn.addEventListener('mouseleave', () => {
            calcBtn.style.background = 'linear-gradient(180deg, rgba(126,200,126,0.2) 0%, rgba(126,200,126,0.1) 100%)';
        });

        const detailsLink = document.createElement('span');
        detailsLink.title = 'View last breakdown';
        detailsLink.style.cssText = 'font-size:14px; cursor:pointer; opacity:0.4; user-select:none;';
        detailsLink.textContent = '📋';
        detailsLink.style.display = 'none';

        let lastResult = null;
        let lastBudget = null;

        calcBtn.addEventListener('click', () => {
            const raw = input.value.trim();
            if (!raw) return;

            const budget = parseKMB(raw);
            if (isNaN(budget) || budget <= 0) {
                input.style.borderColor = '#c0392b';
                const t = setTimeout(() => {
                    input.style.borderColor = '#555';
                }, 1500);
                this.timerRegistry.registerTimeout(t);
                return;
            }
            input.style.borderColor = '#555';

            const actionHrid = getActionHridFromPanel(panel);
            if (!actionHrid) return;

            const result = findMaxUnits(actionHrid, budget);
            if (!result) {
                calcBtn.textContent = 'No data';
                const t = setTimeout(() => {
                    calcBtn.textContent = 'Calculate';
                }, 2000);
                this.timerRegistry.registerTimeout(t);
                return;
            }

            // Fill action count input
            if (result.n > 0) {
                const actionInput = findActionInput(panel);
                if (actionInput) {
                    setReactInputValue(actionInput, result.n);
                }
            }

            // Store and show modal
            lastResult = result;
            lastBudget = budget;
            detailsLink.style.display = '';
            detailsLink.style.opacity = '1';
            showBreakdownModal(budget, result);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') calcBtn.click();
        });

        detailsLink.addEventListener('click', () => {
            if (lastResult !== null) showBreakdownModal(lastBudget, lastResult);
        });

        wrapper.appendChild(input);
        wrapper.appendChild(calcBtn);
        wrapper.appendChild(detailsLink);
        return wrapper;
    }

    disable() {
        try {
            this.unregisterHandlers.forEach((fn) => fn());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();

            document.querySelectorAll(`#${UI_ID}`).forEach((el) => el.remove());
            document.getElementById('mwi-budget-modal-overlay')?.remove();
            // The modal is gone by any of its three routes plus this one, and the
            // claim behind it goes with it every time
            release(RESERVATION_OWNER);

            // Disconnect every panel observer. Left running, one keeps firing
            // on an open panel's own DOM churn (e.g. missing-mats-button being
            // recreated by another feature) and its position() callback closes
            // over `ui` — the very element just removed above — so it would
            // re-insert the disabled widget on the next relevant mutation.
            this.panelObservers.forEach((obs) => obs.disconnect());
            this.panelObservers.clear();

            this.processedPanels = new WeakSet();
            this.isInitialized = false;
        } catch (error) {
            console.error('[Budget Calculator] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const budgetCalculator = new BudgetCalculator();
export default budgetCalculator;
