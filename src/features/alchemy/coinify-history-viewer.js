/**
 * Coinify History Viewer
 * Modal UI for browsing coinify session history.
 * Injected as a tab in the alchemy panel tab bar.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { coinifyHistoryTracker } from './coinify-history-tracker.js';
import { getItemPrices } from '../../utils/market-data.js';
import { formatKMB, formatDateTime } from '../../utils/formatters.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

const CATALYST_OF_COINIFICATION_HRID = '/items/catalyst_of_coinification';
const PRIME_CATALYST_HRID = '/items/prime_catalyst';

/**
 * Check whether any mutation added nodes that are, contain, or sit under a tablist.
 * Keeps the body-wide watcher from re-scanning every tablist on unrelated DOM churn.
 * @param {MutationRecord[]} mutations
 * @returns {boolean}
 */
function mutationsTouchTablist(mutations) {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.closest?.('[role="tablist"]') || node.querySelector?.('[role="tablist"]')) {
                return true;
            }
        }
    }
    return false;
}

class CoinifyHistoryViewer {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.sessions = [];
        this.filteredSessions = [];
        this.currentPage = 1;
        this.rowsPerPage = 50;
        this.showAll = false;
        this.sortColumn = 'startTime';
        this.sortDirection = 'desc';

        // Column filters
        this.filters = {
            dateFrom: null,
            dateTo: null,
            selectedInputItems: [], // Array of itemHrids
        };

        this.activeFilterPopup = null;
        this.activeFilterButton = null;
        this.popupCloseHandler = null;

        // Computed profit per session id — kept out of the session objects so
        // it is never persisted back to storage
        this.profitCache = new Map();

        // Tab injection
        this.alchemyTab = null;
        this.tabWatcher = null;

        // Caches
        this.itemNameCache = new Map();
        this.itemsSpriteUrl = null;
        this.cachedDateRange = null;

        this.timerRegistry = createTimerRegistry();
    }

    /**
     * Initialize the viewer
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('alchemy_coinifyHistory')) {
            return;
        }

        this.isInitialized = true;
        this.addAlchemyTab();
    }

    /**
     * Disable the viewer
     */
    disable() {
        if (this.tabWatcher) {
            this.tabWatcher();
            this.tabWatcher = null;
        }
        if (this.alchemyTab && this.alchemyTab.parentNode) {
            this.alchemyTab.remove();
            this.alchemyTab = null;
        }
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        this.timerRegistry.clearAll();
        this.isInitialized = false;
    }

    // ─── Tab Injection ───────────────────────────────────────────────────────

    /**
     * Inject "Coinify History" tab into the alchemy tab bar.
     * The alchemy tab bar contains Coinify, Decompose, Transmute, Unrefine, Current Action.
     * We identify it by the presence of a "Coinify" tab text.
     */
    addAlchemyTab() {
        const ensureTabExists = () => {
            const tablist = document.querySelector('[role="tablist"]');
            if (!tablist) return;

            // Verify this is the alchemy tablist by checking for "Coinify" tab
            const hasCoinify = Array.from(tablist.children).some(
                (btn) => btn.textContent.includes('Coinify') && !btn.dataset.mwiCoinifyHistoryTab
            );
            if (!hasCoinify) return;

            // Already injected?
            if (tablist.querySelector('[data-mwi-coinify-history-tab="true"]')) return;

            // Clone an existing tab for structure
            const referenceTab = Array.from(tablist.children).find(
                (btn) => btn.textContent.includes('Coinify') && !btn.dataset.mwiCoinifyHistoryTab
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-coinify-history-tab', 'true');
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            // Set label
            const badge = tab.querySelector('.TabsComponent_badge__1Du26');
            if (badge) {
                // Replace first text node (the label) while keeping badge span
                const badgeSpan = badge.querySelector('.MuiBadge-badge');
                badge.textContent = '';
                badge.appendChild(document.createTextNode('Coinify History'));
                if (badgeSpan) badge.appendChild(badgeSpan);
            } else {
                tab.textContent = 'Coinify History';
            }

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            tablist.appendChild(tab);
            this.alchemyTab = tab;
        };

        // Watch for DOM changes that recreate the tablist
        if (!this.tabWatcher) {
            this.tabWatcher = createMutationWatcher(
                document.body,
                (mutations) => {
                    if (!mutationsTouchTablist(mutations)) return;
                    // If our tab was removed from DOM, clear reference
                    if (this.alchemyTab && !document.body.contains(this.alchemyTab)) {
                        this.alchemyTab = null;
                    }
                    ensureTabExists();
                },
                { childList: true, subtree: true }
            );
        }

        ensureTabExists();
    }

    // ─── Modal ───────────────────────────────────────────────────────────────

    /**
     * Open the modal — load sessions and render
     */
    async openModal() {
        this.sessions = await coinifyHistoryTracker.loadSessions();
        this.profitCache.clear();
        this.cachedDateRange = null;
        this.applyFilters();

        if (!this.modal) {
            this.createModal();
        }

        this.modal.style.display = 'flex';
        this.renderTable();
    }

    /**
     * Close the modal
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
        this.closeActiveFilterPopup();
    }

    /**
     * Create modal DOM structure
     */
    createModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'mwi-coinify-history-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        const content = document.createElement('div');
        content.className = 'mwi-coinify-history-content';
        content.style.cssText = `
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            width: fit-content;
            min-width: 500px;
            max-width: 95vw;
            max-height: 90%;
            overflow: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        `;

        const title = document.createElement('h2');
        title.textContent = 'Coinify History';
        title.style.cssText = 'margin: 0; color: #fff;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none; border: none; color: #fff;
            font-size: 24px; cursor: pointer; padding: 0;
            width: 30px; height: 30px;
        `;
        closeBtn.addEventListener('click', () => this.closeModal());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Controls
        const controls = document.createElement('div');
        controls.className = 'mwi-coinify-history-controls';
        controls.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 8px;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
        `;

        // Active filter badges row
        const badges = document.createElement('div');
        badges.className = 'mwi-coinify-history-badges';
        badges.style.cssText = `
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            align-items: center;
            min-height: 28px;
            margin-bottom: 10px;
        `;

        // Table container
        const tableContainer = document.createElement('div');
        tableContainer.className = 'mwi-coinify-history-table-container';
        tableContainer.style.cssText = 'overflow-x: auto;';

        // Pagination
        const pagination = document.createElement('div');
        pagination.className = 'mwi-coinify-history-pagination';
        pagination.style.cssText = `
            margin-top: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;

        content.appendChild(header);
        content.appendChild(controls);
        content.appendChild(badges);
        content.appendChild(tableContainer);
        content.appendChild(pagination);
        this.modal.appendChild(content);
        document.body.appendChild(this.modal);

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
    }

    // ─── Filtering ───────────────────────────────────────────────────────────

    /**
     * Apply all active filters to this.sessions → this.filteredSessions
     */
    applyFilters() {
        this.cachedDateRange = null;

        const hasDateFilter = !!(this.filters.dateFrom || this.filters.dateTo);
        let dateToEndOfDay = null;
        if (hasDateFilter && this.filters.dateTo) {
            dateToEndOfDay = new Date(this.filters.dateTo);
            dateToEndOfDay.setHours(23, 59, 59, 999);
        }

        const hasItemFilter = this.filters.selectedInputItems.length > 0;
        const itemFilterSet = hasItemFilter ? new Set(this.filters.selectedInputItems) : null;

        const filtered = this.sessions.filter((session) => {
            // Date filter
            if (hasDateFilter) {
                const d = new Date(session.startTime);
                if (this.filters.dateFrom && d < this.filters.dateFrom) return false;
                if (dateToEndOfDay && d > dateToEndOfDay) return false;
            }

            // Input item filter
            if (hasItemFilter && !itemFilterSet.has(session.inputItemHrid)) return false;

            return true;
        });

        for (const session of this.sessions) {
            if (!this.profitCache.has(session.id)) {
                this.profitCache.set(session.id, this.computeSessionProfit(session));
            }
        }

        // Sort
        filtered.sort((a, b) => {
            let aVal = a[this.sortColumn] ?? 0;
            let bVal = b[this.sortColumn] ?? 0;
            // Sort item columns by the displayed name, not the hrid
            if (this.sortColumn === 'inputItemHrid') {
                aVal = this.getItemName(String(aVal));
                bVal = this.getItemName(String(bVal));
            } else if (this.sortColumn === '_profit') {
                aVal = this.profitCache.get(a.id)?.profit ?? 0;
                bVal = this.profitCache.get(b.id)?.profit ?? 0;
            }
            const cmp = typeof aVal === 'string' ? aVal.localeCompare(String(bVal)) : aVal - bVal;
            return this.sortDirection === 'asc' ? cmp : -cmp;
        });

        this.filteredSessions = filtered;
        this.currentPage = 1;
    }

    /**
     * Check if a column has an active filter
     * @param {string} col
     * @returns {boolean}
     */
    hasActiveFilter(col) {
        switch (col) {
            case 'startTime':
                return !!(this.filters.dateFrom || this.filters.dateTo);
            case 'inputItemHrid':
                return this.filters.selectedInputItems.length > 0;
            default:
                return false;
        }
    }

    /**
     * Returns true if any filter is active
     */
    hasAnyFilter() {
        return this.hasActiveFilter('startTime') || this.hasActiveFilter('inputItemHrid');
    }

    /**
     * Clear all filters
     */
    clearAllFilters() {
        this.filters.dateFrom = null;
        this.filters.dateTo = null;
        this.filters.selectedInputItems = [];
        this.applyFilters();
        this.renderTable();
    }

    /**
     * Compute session profit: coins earned minus consumed inputs (at current
     * buy price for the session's enhancement level — historical input prices
     * were not recorded), catalysts consumed, and the alchemy coin fee.
     * @param {Object} session
     * @returns {{profit: number, revenue: number, inputCost: number, catalystCost: number, netConsumed: number}}
     */
    computeSessionProfit(session) {
        const itemDetails = dataManager.getItemDetails(session.inputItemHrid);
        const bulkMultiplier = session.bulkMultiplier ?? itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;
        const attempts = session.totalAttempts || 0;

        const revenue = session.totalCoinsEarned || 0;

        const netConsumed = attempts * bulkMultiplier;
        const inputPrices = getItemPrices(session.inputItemHrid, session.enhancementLevel || 0);
        const inputPrice = inputPrices?.ask > 0 ? inputPrices.ask : inputPrices?.bid > 0 ? inputPrices.bid : 0;
        const inputCost = netConsumed * inputPrice;

        const catalystPrice = (hrid) => {
            const prices = getItemPrices(hrid, 0);
            return prices?.ask > 0 ? prices.ask : prices?.bid > 0 ? prices.bid : 0;
        };
        const catalystCost =
            (session.catalystOfCoinificationUsed || 0) * catalystPrice(CATALYST_OF_COINIFICATION_HRID) +
            (session.primeCatalystUsed || 0) * catalystPrice(PRIME_CATALYST_HRID);

        // Coinify has no coin fee at all — the item is the input and coins are the output
        // (see utils/alchemy-fees.js). The line outlived the fee, so every tooltip carried a
        // permanent "Alchemy coins: -0" for a charge that does not exist.
        return {
            profit: revenue - inputCost - catalystCost,
            revenue,
            inputCost,
            catalystCost,
            netConsumed,
        };
    }

    // ─── Rendering ───────────────────────────────────────────────────────────

    /**
     * Full render: controls + badges + table + pagination
     */
    renderTable() {
        this.renderControls();
        this.renderBadges();

        const tableContainer = this.modal.querySelector('.mwi-coinify-history-table-container');
        while (tableContainer.firstChild) tableContainer.removeChild(tableContainer.firstChild);

        const table = document.createElement('table');
        table.style.cssText = 'width: max-content; border-collapse: collapse; color: #fff; white-space: nowrap;';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.background = '#1a1a1a';

        const columns = [
            { key: 'startTime', label: 'Session Start', filterable: true },
            { key: 'inputItemHrid', label: 'Input Item', filterable: true },
            { key: 'enhancementLevel', label: 'Enh. Level', filterable: false },
            { key: 'totalAttempts', label: 'Attempts', filterable: false },
            { key: 'totalSuccesses', label: 'Successes', filterable: false },
            { key: '_successRate', label: 'Success Rate', filterable: false },
            { key: 'totalCoinsEarned', label: 'Coins Earned', filterable: false },
            { key: '_catalystOfCoinification', label: 'Catalyst of Coinification', filterable: false },
            { key: '_primeCatalyst', label: 'Prime Catalyst', filterable: false },
            { key: '_profit', label: 'Profit', filterable: false },
            { key: '_delete', label: '', filterable: false },
        ];

        columns.forEach((col) => {
            const th = document.createElement('th');
            th.style.cssText = `
                padding: 10px;
                text-align: left;
                border-bottom: 2px solid #555;
                user-select: none;
                white-space: nowrap;
            `;

            const headerContent = document.createElement('div');
            headerContent.style.cssText = 'display: flex; align-items: center; gap: 8px;';

            const labelSpan = document.createElement('span');
            labelSpan.style.cursor = 'pointer';

            // Columns starting with _ are computed, not directly sortable by field
            const isSortable = !col.key.startsWith('_');
            const isCatalystCol = col.key === '_catalystOfCoinification' || col.key === '_primeCatalyst';

            if (isSortable) {
                if (this.sortColumn === col.key) {
                    labelSpan.textContent = col.label + (this.sortDirection === 'asc' ? ' ▲' : ' ▼');
                } else {
                    labelSpan.textContent = col.label;
                }
                labelSpan.addEventListener('click', () => {
                    if (this.sortColumn === col.key) {
                        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortColumn = col.key;
                        this.sortDirection = 'desc';
                    }
                    this.applyFilters();
                    this.renderTable();
                });
            } else if (isCatalystCol) {
                // Render icon as header with item name as tooltip
                const hrid =
                    col.key === '_catalystOfCoinification' ? CATALYST_OF_COINIFICATION_HRID : PRIME_CATALYST_HRID;
                labelSpan.title = col.label;
                labelSpan.style.cursor = 'default';
                this.appendItemIcon(labelSpan, hrid, 20);
            } else {
                labelSpan.textContent = col.label;
                labelSpan.style.cursor = 'default';
            }

            headerContent.appendChild(labelSpan);

            if (col.filterable) {
                const filterBtn = document.createElement('button');
                filterBtn.textContent = '⋮';
                filterBtn.style.cssText = `
                    background: none; border: none;
                    color: ${this.hasActiveFilter(col.key) ? '#4a90e2' : '#aaa'};
                    cursor: pointer; font-size: 16px;
                    padding: 2px 4px; font-weight: bold;
                `;
                filterBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showFilterPopup(col.key, filterBtn);
                });
                headerContent.appendChild(filterBtn);
            }

            th.appendChild(headerContent);
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        const paginated = this.getPaginatedSessions();

        if (paginated.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = columns.length;
            cell.textContent =
                this.sessions.length === 0
                    ? 'No coinify history recorded yet.'
                    : 'No sessions match the current filters.';
            cell.style.cssText = 'padding: 20px; text-align: center; color: #888;';
            row.appendChild(cell);
            tbody.appendChild(row);
        } else {
            paginated.forEach((session, index) => {
                const row = document.createElement('tr');
                row.style.cssText = `
                    border-bottom: 1px solid #333;
                    background: ${index % 2 === 0 ? '#2a2a2a' : '#252525'};
                `;

                // Session Start
                const dateCell = document.createElement('td');
                dateCell.textContent = formatDateTime(new Date(session.startTime));
                dateCell.style.padding = '6px 10px';
                row.appendChild(dateCell);

                // Input Item
                const inputCell = document.createElement('td');
                inputCell.style.cssText = 'padding: 6px 10px; display: flex; align-items: center; gap: 8px;';
                this.appendItemIcon(inputCell, session.inputItemHrid, 20);
                const inputName = document.createElement('span');
                inputName.textContent = this.getItemName(session.inputItemHrid);
                inputCell.appendChild(inputName);
                row.appendChild(inputCell);

                // Enhancement Level
                const enhCell = document.createElement('td');
                enhCell.textContent = session.enhancementLevel > 0 ? `+${session.enhancementLevel}` : '0';
                enhCell.style.cssText = 'padding: 6px 10px; text-align: center;';
                row.appendChild(enhCell);

                // Attempts
                const attemptsCell = document.createElement('td');
                attemptsCell.textContent = session.totalAttempts;
                attemptsCell.style.padding = '6px 10px';
                row.appendChild(attemptsCell);

                // Successes
                const successCell = document.createElement('td');
                const failures = session.totalAttempts - session.totalSuccesses;
                successCell.textContent = `${session.totalSuccesses} (${failures} failed)`;
                successCell.style.cssText = `
                    padding: 6px 10px;
                    color: ${failures > 0 ? '#fbbf24' : '#4ade80'};
                `;
                row.appendChild(successCell);

                // Success Rate
                const rateCell = document.createElement('td');
                const rate =
                    session.totalAttempts > 0
                        ? ((session.totalSuccesses / session.totalAttempts) * 100).toFixed(1)
                        : '—';
                rateCell.textContent = session.totalAttempts > 0 ? `${rate}%` : '—';
                rateCell.style.padding = '6px 10px';
                row.appendChild(rateCell);

                // Coins Earned
                const earnedCell = document.createElement('td');
                earnedCell.textContent = formatKMB(session.totalCoinsEarned || 0, 1);
                earnedCell.style.cssText = 'padding: 6px 10px; color: #fbbf24;';
                row.appendChild(earnedCell);

                // Catalyst of Coinification
                const cocCell = document.createElement('td');
                cocCell.style.cssText = 'padding: 6px 10px;';
                this.renderCatalystCell(
                    cocCell,
                    CATALYST_OF_COINIFICATION_HRID,
                    session.catalystOfCoinificationUsed || 0
                );
                row.appendChild(cocCell);

                // Prime Catalyst
                const pcCell = document.createElement('td');
                pcCell.style.cssText = 'padding: 6px 10px;';
                this.renderCatalystCell(pcCell, PRIME_CATALYST_HRID, session.primeCatalystUsed || 0);
                row.appendChild(pcCell);

                // Profit
                const profitCell = document.createElement('td');
                const profitDetail = this.profitCache.get(session.id) || this.computeSessionProfit(session);
                profitCell.textContent = formatKMB(profitDetail.profit, 1);
                profitCell.style.cssText = `
                    padding: 6px 10px;
                    font-weight: bold;
                    color: ${profitDetail.profit >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS};
                `;
                profitCell.title =
                    `Coins earned: ${formatKMB(profitDetail.revenue, 1)}\n` +
                    `Inputs (${profitDetail.netConsumed} @ current buy): −${formatKMB(profitDetail.inputCost, 1)}\n` +
                    `Catalysts: −${formatKMB(profitDetail.catalystCost, 1)}`;
                row.appendChild(profitCell);

                // Delete
                const deleteCell = document.createElement('td');
                deleteCell.style.cssText = 'padding: 6px 4px; text-align: center;';
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '✕';
                deleteBtn.title = 'Delete this session';
                deleteBtn.style.cssText = `
                    background: none; border: none; color: #dc2626;
                    cursor: pointer; font-size: 14px; padding: 2px 6px;
                    border-radius: 3px; line-height: 1;
                `;
                deleteBtn.addEventListener('mouseenter', () => {
                    deleteBtn.style.background = 'rgba(220,38,38,0.15)';
                });
                deleteBtn.addEventListener('mouseleave', () => {
                    deleteBtn.style.background = 'none';
                });
                deleteBtn.addEventListener('click', () => this.deleteSession(session.id));
                deleteCell.appendChild(deleteBtn);
                row.appendChild(deleteCell);

                tbody.appendChild(row);
            });
        }

        table.appendChild(tbody);
        tableContainer.appendChild(table);
        this.renderPagination();
    }

    /**
     * Render a catalyst cell: icon + count, or — if zero
     * @param {HTMLElement} cell
     * @param {string} catalystHrid
     * @param {number} count
     */
    renderCatalystCell(cell, catalystHrid, count) {
        if (count === 0) {
            const dash = document.createElement('span');
            dash.textContent = '—';
            dash.style.color = '#888';
            cell.appendChild(dash);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; align-items: center; gap: 4px;';

        this.appendItemIcon(wrapper, catalystHrid, 18);

        const countSpan = document.createElement('span');
        countSpan.textContent = count.toLocaleString();
        wrapper.appendChild(countSpan);

        cell.appendChild(wrapper);
    }

    /**
     * Render controls bar (stats + action buttons)
     */
    renderControls() {
        const controls = this.modal.querySelector('.mwi-coinify-history-controls');
        while (controls.firstChild) controls.removeChild(controls.firstChild);

        // Stats
        const stats = document.createElement('span');
        stats.style.cssText = 'color: #aaa; font-size: 14px;';
        stats.textContent = `${this.filteredSessions.length} session${this.filteredSessions.length !== 1 ? 's' : ''}`;
        controls.appendChild(stats);

        const rightGroup = document.createElement('div');
        rightGroup.style.cssText = 'display: flex; gap: 8px; align-items: center;';

        // Clear All Filters button (only when filters active)
        if (this.hasAnyFilter()) {
            const clearFiltersBtn = document.createElement('button');
            clearFiltersBtn.textContent = 'Clear All Filters';
            clearFiltersBtn.style.cssText = `
                padding: 6px 12px; background: #e67e22; color: white;
                border: none; border-radius: 4px; cursor: pointer;
            `;
            clearFiltersBtn.addEventListener('click', () => this.clearAllFilters());
            rightGroup.appendChild(clearFiltersBtn);
        }

        // Export button
        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export';
        exportBtn.style.cssText = `
            padding: 6px 12px; background: #2563eb; color: white;
            border: none; border-radius: 4px; cursor: pointer;
        `;
        exportBtn.addEventListener('click', () => this.exportHistory());
        rightGroup.appendChild(exportBtn);

        // Clear History button
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear History';
        clearBtn.style.cssText = `
            padding: 6px 12px; background: #dc2626; color: white;
            border: none; border-radius: 4px; cursor: pointer;
        `;
        clearBtn.addEventListener('click', () => this.clearHistory());
        rightGroup.appendChild(clearBtn);

        controls.appendChild(rightGroup);
    }

    /**
     * Render active filter badges
     */
    renderBadges() {
        const container = this.modal.querySelector('.mwi-coinify-history-badges');
        while (container.firstChild) container.removeChild(container.firstChild);

        const badges = [];

        if (this.filters.dateFrom || this.filters.dateTo) {
            const parts = [];
            if (this.filters.dateFrom) parts.push(formatDateTime(this.filters.dateFrom, { includeTime: false }));
            if (this.filters.dateTo) parts.push(formatDateTime(this.filters.dateTo, { includeTime: false }));
            badges.push({
                label: `Date: ${parts.join(' - ')}`,
                onRemove: () => {
                    this.filters.dateFrom = null;
                    this.filters.dateTo = null;
                    this.applyFilters();
                    this.renderTable();
                },
            });
        }

        if (this.filters.selectedInputItems.length > 0) {
            const label =
                this.filters.selectedInputItems.length === 1
                    ? this.getItemName(this.filters.selectedInputItems[0])
                    : `${this.filters.selectedInputItems.length} input items`;
            badges.push({
                label: `Input: ${label}`,
                icon: this.filters.selectedInputItems[0],
                onRemove: () => {
                    this.filters.selectedInputItems = [];
                    this.applyFilters();
                    this.renderTable();
                },
            });
        }

        badges.forEach((badge) => {
            const el = document.createElement('div');
            el.style.cssText = `
                display: flex; align-items: center; gap: 6px;
                padding: 4px 8px; background: #3a3a3a;
                border: 1px solid #555; border-radius: 4px;
                color: #aaa; font-size: 13px;
            `;

            if (badge.icon) {
                this.appendItemIcon(el, badge.icon, 14);
            }

            const labelSpan = document.createElement('span');
            labelSpan.textContent = badge.label;
            el.appendChild(labelSpan);

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = `
                background: none; border: none; color: #aaa;
                cursor: pointer; padding: 0; font-size: 13px; line-height: 1;
            `;
            removeBtn.addEventListener('click', badge.onRemove);
            el.appendChild(removeBtn);

            container.appendChild(el);
        });
    }

    /**
     * Render pagination controls
     */
    renderPagination() {
        const pagination = this.modal.querySelector('.mwi-coinify-history-pagination');
        while (pagination.firstChild) pagination.removeChild(pagination.firstChild);

        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display: flex; gap: 8px; align-items: center; color: #aaa;';

        const label = document.createElement('span');
        label.textContent = 'Rows per page:';

        const rowsInput = document.createElement('input');
        rowsInput.type = 'number';
        rowsInput.value = this.rowsPerPage;
        rowsInput.min = '1';
        rowsInput.disabled = this.showAll;
        rowsInput.style.cssText = `
            width: 60px; padding: 4px 8px;
            border: 1px solid #555; border-radius: 4px;
            background: ${this.showAll ? '#333' : '#1a1a1a'};
            color: ${this.showAll ? '#666' : '#fff'};
        `;
        rowsInput.addEventListener('change', (e) => {
            this.rowsPerPage = Math.max(1, parseInt(e.target.value) || 50);
            this.currentPage = 1;
            this.renderTable();
        });

        const showAllLabel = document.createElement('label');
        showAllLabel.style.cssText = 'cursor: pointer; color: #aaa; display: flex; align-items: center; gap: 4px;';

        const showAllCheckbox = document.createElement('input');
        showAllCheckbox.type = 'checkbox';
        showAllCheckbox.checked = this.showAll;
        showAllCheckbox.style.cursor = 'pointer';
        showAllCheckbox.addEventListener('change', (e) => {
            this.showAll = e.target.checked;
            rowsInput.disabled = this.showAll;
            rowsInput.style.background = this.showAll ? '#333' : '#1a1a1a';
            rowsInput.style.color = this.showAll ? '#666' : '#fff';
            this.currentPage = 1;
            this.renderTable();
        });

        showAllLabel.appendChild(showAllCheckbox);
        showAllLabel.appendChild(document.createTextNode('Show All'));

        leftSide.appendChild(label);
        leftSide.appendChild(rowsInput);
        leftSide.appendChild(showAllLabel);

        const rightSide = document.createElement('div');
        rightSide.style.cssText = 'display: flex; gap: 8px; align-items: center; color: #aaa;';

        if (!this.showAll) {
            const totalPages = this.getTotalPages();

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '◀';
            prevBtn.disabled = this.currentPage === 1;
            prevBtn.style.cssText = `
                padding: 4px 12px;
                background: ${this.currentPage === 1 ? '#333' : '#4a90e2'};
                color: ${this.currentPage === 1 ? '#666' : 'white'};
                border: none; border-radius: 4px;
                cursor: ${this.currentPage === 1 ? 'default' : 'pointer'};
            `;
            prevBtn.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderTable();
                }
            });

            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Page ${this.currentPage} of ${totalPages || 1}`;

            const nextBtn = document.createElement('button');
            nextBtn.textContent = '▶';
            nextBtn.disabled = this.currentPage >= totalPages;
            nextBtn.style.cssText = `
                padding: 4px 12px;
                background: ${this.currentPage >= totalPages ? '#333' : '#4a90e2'};
                color: ${this.currentPage >= totalPages ? '#666' : 'white'};
                border: none; border-radius: 4px;
                cursor: ${this.currentPage >= totalPages ? 'default' : 'pointer'};
            `;
            nextBtn.addEventListener('click', () => {
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.renderTable();
                }
            });

            rightSide.appendChild(prevBtn);
            rightSide.appendChild(pageInfo);
            rightSide.appendChild(nextBtn);
        } else {
            const info = document.createElement('span');
            info.textContent = `Showing all ${this.filteredSessions.length} sessions`;
            rightSide.appendChild(info);
        }

        pagination.appendChild(leftSide);
        pagination.appendChild(rightSide);
    }

    // ─── Filter Popups ───────────────────────────────────────────────────────

    /**
     * Show the appropriate filter popup for a column
     * @param {string} columnKey
     * @param {HTMLElement} buttonElement
     */
    showFilterPopup(columnKey, buttonElement) {
        // Toggle behavior
        if (this.activeFilterPopup && this.activeFilterButton === buttonElement) {
            this.closeActiveFilterPopup();
            return;
        }

        this.closeActiveFilterPopup();

        let popup;
        switch (columnKey) {
            case 'startTime':
                popup = this.createDateFilterPopup();
                break;
            case 'inputItemHrid':
                popup = this.createInputItemFilterPopup();
                break;
            default:
                return;
        }

        const rect = buttonElement.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = `${rect.bottom + 5}px`;
        popup.style.left = `${rect.left}px`;
        popup.style.zIndex = '10002';

        document.body.appendChild(popup);
        this.activeFilterPopup = popup;
        this.activeFilterButton = buttonElement;

        this.popupCloseHandler = (e) => {
            if (e.target.type === 'date' || e.target.closest?.('input[type="date"]')) return;
            if (!popup.contains(e.target) && e.target !== buttonElement) {
                this.closeActiveFilterPopup();
            }
        };
        const t = setTimeout(() => document.addEventListener('click', this.popupCloseHandler), 10);
        this.timerRegistry.registerTimeout(t);
    }

    /**
     * Close and clean up the active filter popup
     */
    closeActiveFilterPopup() {
        if (this.activeFilterPopup) {
            this.activeFilterPopup.remove();
            this.activeFilterPopup = null;
        }
        if (this.popupCloseHandler) {
            document.removeEventListener('click', this.popupCloseHandler);
            this.popupCloseHandler = null;
        }
        this.activeFilterButton = null;
    }

    /**
     * Create date range filter popup
     * @returns {HTMLElement}
     */
    createDateFilterPopup() {
        const popup = this.createPopupBase('Filter by Date');

        // Compute available range
        if (!this.cachedDateRange) {
            const timestamps = this.sessions.map((s) => s.startTime).filter(Boolean);
            if (timestamps.length > 0) {
                this.cachedDateRange = {
                    minDate: new Date(Math.min(...timestamps)),
                    maxDate: new Date(Math.max(...timestamps)),
                };
            } else {
                this.cachedDateRange = { minDate: null, maxDate: null };
            }
        }

        const { minDate, maxDate } = this.cachedDateRange;

        if (minDate && maxDate) {
            const rangeInfo = document.createElement('div');
            rangeInfo.style.cssText = `
                color: #aaa; font-size: 11px; margin-bottom: 10px;
                padding: 6px; background: #1a1a1a; border-radius: 3px;
            `;
            rangeInfo.textContent = `Available: ${formatDateTime(minDate, { includeTime: false })} - ${formatDateTime(maxDate, { includeTime: false })}`;
            popup.appendChild(rangeInfo);
        }

        const fromInput = this.createDateInput(
            'From:',
            this.formatLocalDateValue(this.filters.dateFrom),
            minDate,
            maxDate
        );
        const toInput = this.createDateInput('To:', this.formatLocalDateValue(this.filters.dateTo), minDate, maxDate);

        popup.appendChild(fromInput.label);
        popup.appendChild(fromInput.input);
        popup.appendChild(toInput.label);
        popup.appendChild(toInput.input);

        const btnRow = this.createPopupButtonRow(
            () => {
                this.filters.dateFrom = this.parseLocalDate(fromInput.input.value);
                this.filters.dateTo = this.parseLocalDate(toInput.input.value);
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            },
            () => {
                this.filters.dateFrom = null;
                this.filters.dateTo = null;
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            }
        );
        popup.appendChild(btnRow);

        return popup;
    }

    /**
     * Create input item filter popup (checkbox list with search)
     * @returns {HTMLElement}
     */
    createInputItemFilterPopup() {
        const popup = this.createPopupBase('Filter by Input Item');
        popup.style.minWidth = '220px';

        // Gather unique input items from all sessions
        const itemSet = new Map();
        this.sessions.forEach((s) => {
            if (!itemSet.has(s.inputItemHrid)) {
                itemSet.set(s.inputItemHrid, this.getItemName(s.inputItemHrid));
            }
        });
        const allItems = Array.from(itemSet.entries()).sort((a, b) => a[1].localeCompare(b[1]));

        // Track pending selection (local to this popup)
        const pending = new Set(this.filters.selectedInputItems);

        // Search box
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search items...';
        searchInput.style.cssText = `
            width: 100%; padding: 6px; margin-bottom: 8px;
            background: #1a1a1a; border: 1px solid #555;
            border-radius: 3px; color: #fff; box-sizing: border-box;
        `;

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'max-height: 200px; overflow-y: auto;';

        const renderList = (filterText) => {
            while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
            const term = filterText.toLowerCase();
            const visible = term ? allItems.filter(([, name]) => name.toLowerCase().includes(term)) : allItems;

            visible.forEach(([hrid, name]) => {
                const row = document.createElement('label');
                row.style.cssText = `
                    display: flex; align-items: center; gap: 8px;
                    padding: 4px 2px; cursor: pointer; color: #ddd;
                `;

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = pending.has(hrid);
                cb.style.cursor = 'pointer';
                cb.addEventListener('change', () => {
                    if (cb.checked) pending.add(hrid);
                    else pending.delete(hrid);
                });

                this.appendItemIcon(row, hrid, 16);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;

                row.appendChild(cb);
                row.appendChild(nameSpan);
                listContainer.appendChild(row);
            });
        };

        searchInput.addEventListener('input', () => renderList(searchInput.value));
        renderList('');

        popup.appendChild(searchInput);
        popup.appendChild(listContainer);

        const btnRow = this.createPopupButtonRow(
            () => {
                this.filters.selectedInputItems = Array.from(pending);
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            },
            () => {
                this.filters.selectedInputItems = [];
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            }
        );
        popup.appendChild(btnRow);

        return popup;
    }

    // ─── Popup Helpers ───────────────────────────────────────────────────────

    /**
     * Create a styled popup base div with a title
     * @param {string} titleText
     * @returns {HTMLElement}
     */
    createPopupBase(titleText) {
        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a; border: 1px solid #555;
            border-radius: 4px; padding: 12px; min-width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        `;

        const title = document.createElement('div');
        title.textContent = titleText;
        title.style.cssText = 'color: #fff; font-weight: bold; margin-bottom: 10px;';
        popup.appendChild(title);

        return popup;
    }

    /**
     * Create a date input with label
     * @param {string} labelText
     * @param {string} value
     * @param {Date|null} minDate
     * @param {Date|null} maxDate
     * @returns {{ label: HTMLElement, input: HTMLInputElement }}
     */
    createDateInput(labelText, value, minDate, maxDate) {
        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = 'display: block; color: #aaa; margin-bottom: 4px; font-size: 12px;';

        const input = document.createElement('input');
        input.type = 'date';
        input.value = value;
        if (minDate) input.min = minDate.toISOString().split('T')[0];
        if (maxDate) input.max = maxDate.toISOString().split('T')[0];
        input.style.cssText = `
            width: 100%; padding: 6px; background: #1a1a1a;
            border: 1px solid #555; border-radius: 3px; color: #fff; margin-bottom: 10px;
        `;

        return { label, input };
    }

    /**
     * Parse a YYYY-MM-DD date input value as local midnight.
     * new Date('YYYY-MM-DD') parses as UTC midnight, shifting the day boundary by the timezone offset.
     * @param {string} value
     * @returns {Date|null}
     */
    parseLocalDate(value) {
        if (!value) return null;
        const [y, m, d] = value.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    /**
     * Format a Date as a YYYY-MM-DD input value using local calendar fields
     * @param {Date|null} date
     * @returns {string}
     */
    formatLocalDateValue(date) {
        if (!date) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /**
     * Create Apply + Clear button row for filter popups
     * @param {Function} onApply
     * @param {Function} onClear
     * @returns {HTMLElement}
     */
    createPopupButtonRow(onApply, onClear) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; gap: 8px; margin-top: 10px;';

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1; padding: 6px; background: #4a90e2; color: white;
            border: none; border-radius: 3px; cursor: pointer;
        `;
        applyBtn.addEventListener('click', onApply);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1; padding: 6px; background: #666; color: white;
            border: none; border-radius: 3px; cursor: pointer;
        `;
        clearBtn.addEventListener('click', onClear);

        row.appendChild(applyBtn);
        row.appendChild(clearBtn);
        return row;
    }

    // ─── Utilities ───────────────────────────────────────────────────────────

    /**
     * Append a 16×16 or 20×20 SVG item icon to an element
     * @param {HTMLElement} parent
     * @param {string} itemHrid
     * @param {number} size
     */
    appendItemIcon(parent, itemHrid, size = 20) {
        const spriteUrl = this.getItemsSpriteUrl();
        if (!spriteUrl) return;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flexShrink = '0';

        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `${spriteUrl}#${itemHrid.split('/').pop()}`);
        svg.appendChild(use);
        parent.appendChild(svg);
    }

    /**
     * Get items sprite URL from DOM (cached)
     * @returns {string|null}
     */
    getItemsSpriteUrl() {
        if (!this.itemsSpriteUrl) {
            const el = document.querySelector('use[href*="items_sprite"]');
            if (el) {
                const href = el.getAttribute('href');
                this.itemsSpriteUrl = href ? href.split('#')[0] : null;
            }
        }
        return this.itemsSpriteUrl;
    }

    /**
     * Get item display name from HRID (cached)
     * @param {string} itemHrid
     * @returns {string}
     */
    getItemName(itemHrid) {
        if (this.itemNameCache.has(itemHrid)) {
            return this.itemNameCache.get(itemHrid);
        }
        const details = dataManager.getItemDetails(itemHrid);
        const name = details?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
        this.itemNameCache.set(itemHrid, name);
        return name;
    }

    /**
     * Get paginated sessions for current page
     * @returns {Array}
     */
    getPaginatedSessions() {
        if (this.showAll) return this.filteredSessions;
        const start = (this.currentPage - 1) * this.rowsPerPage;
        return this.filteredSessions.slice(start, start + this.rowsPerPage);
    }

    /**
     * Get total number of pages
     * @returns {number}
     */
    getTotalPages() {
        if (this.showAll) return 1;
        return Math.ceil(this.filteredSessions.length / this.rowsPerPage);
    }

    /**
     * Delete a single session by ID
     * @param {string} sessionId
     */
    async deleteSession(sessionId) {
        try {
            // Reload before filtering — persisting the modal-open snapshot would erase
            // sessions the tracker saved while the modal was open
            const fresh = await coinifyHistoryTracker.loadSessions();
            this.sessions = fresh.filter((s) => s.id !== sessionId);
            await coinifyHistoryTracker.deleteSessions(this.sessions);
        } catch (error) {
            console.error('[CoinifyHistoryViewer] Failed to delete session:', error);
        }

        this.applyFilters();
        this.renderTable();
    }

    /**
     * Export all sessions to a CSV file download
     */
    exportHistory() {
        const escape = (val) => `"${String(val === null || val === undefined ? '' : val).replace(/"/g, '""')}"`;

        const headers = [
            'Session Start',
            'Input Item',
            'Enhancement Level',
            'Attempts',
            'Successes',
            'Failures',
            'Success Rate',
            'Coins Earned',
            'Catalyst of Coinification Used',
            'Prime Catalyst Used',
            'Profit',
        ];

        const rows = this.sessions.map((session) => {
            const start = formatDateTime(new Date(session.startTime));
            const inputName = this.getItemName(session.inputItemHrid);
            const failures = session.totalAttempts - session.totalSuccesses;
            const rate =
                session.totalAttempts > 0
                    ? `${((session.totalSuccesses / session.totalAttempts) * 100).toFixed(1)}%`
                    : '—';

            return [
                start,
                inputName,
                session.enhancementLevel,
                session.totalAttempts,
                session.totalSuccesses,
                failures,
                rate,
                session.totalCoinsEarned || 0,
                session.catalystOfCoinificationUsed || 0,
                session.primeCatalystUsed || 0,
                Math.round((this.profitCache.get(session.id) || this.computeSessionProfit(session)).profit),
            ]
                .map(escape)
                .join(',');
        });

        const csv = [headers.map(escape).join(','), ...rows].join('\n');
        const date = new Date().toISOString().slice(0, 10);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `coinify-history-${date}.csv`;
        a.click();

        URL.revokeObjectURL(url);
    }

    /**
     * Clear all history after confirmation
     */
    async clearHistory() {
        const confirmed = confirm(
            `This will permanently delete ALL coinify history (${this.sessions.length} sessions).\nThis cannot be undone.\n\nAre you sure?`
        );
        if (!confirmed) return;

        try {
            // A clear that could not list the store deleted nothing, and the
            // sessions are still on disk — emptying the table and saying
            // "cleared" would be a lie the next reload exposes.
            if (!(await coinifyHistoryTracker.clearHistory())) {
                alert('Coinify history could NOT be cleared — storage could not be read. Nothing was deleted.');
                return;
            }
            this.sessions = [];
            this.filteredSessions = [];
            alert('Coinify history cleared.');
            this.applyFilters();
            this.renderTable();
        } catch (error) {
            console.error('[CoinifyHistoryViewer] Failed to clear history:', error);
            alert(`Failed to clear history: ${error.message}`);
        }
    }
}

const coinifyHistoryViewer = new CoinifyHistoryViewer();

export default {
    name: 'Coinify History Viewer',
    initialize: () => coinifyHistoryViewer.initialize(),
    cleanup: () => {
        try {
            return coinifyHistoryViewer.disable();
        } catch (error) {
            console.error('[Coinify History Viewer] Disable failed part-way:', error);
        } finally {
            coinifyHistoryViewer.isInitialized = false;
        }
    },
};
