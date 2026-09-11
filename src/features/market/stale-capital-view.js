/**
 * Stale Capital View Module
 *
 * A "Stale" tab beside the Ledger tab in the marketplace, answering "what of
 * mine isn't moving?": your open sell listings and buy orders, ranked by
 * coins tied up (not by age alone — see `buildStaleCapital`), each row
 * showing its age and how its price compares to the current book.
 *
 * Strictly a view over positions you already hold. It never scans the wider
 * market for opportunities and suggests nothing to buy — see
 * `src/utils/stale-capital.js` for the ranking arithmetic, which is the only
 * other file this feature owns.
 *
 * All figures come straight from `dataManager.getMarketListings()`, read
 * fresh every time the modal opens; there is no recorder and no persisted
 * store, so a character switch cannot leave a departed character's rows on
 * screen — the next open can only describe whoever is current then.
 *
 * Follows the same tab/modal conventions as `trade-ledger-view.js`.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import marketPriceStore from './mooket/market-price-store.js';
import { buildStaleCapital } from '../../utils/stale-capital.js';
import { formatKMB, formatRelativeTime, formatDateTime } from '../../utils/formatters.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { visibleTabsContainer, navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

/** Stable key for persisting the modal's minimized state; there is no geometry to key off. */
const PANEL_KEY = 'staleCapitalModal';

const PRICE_TOOLTIP =
    'How your price compares to the current best on your side of the book: "above" the best ask (sells) or ' +
    '"below" the best bid (buys) usually explains why a listing isn\'t moving. "at" means you already match ' +
    'the front of the book. "unknown" means the current price could not be read.';

/**
 * A row's price-comparison label, plain language rather than the raw
 * above/at/below/null the arithmetic returns.
 * @param {Object} row - From `buildStaleCapital`
 * @returns {{text: string, color: string}}
 */
export function priceComparisonBadge(row) {
    if (row.priceComparison === null) {
        return { text: 'unknown', color: '#9ca3af' };
    }
    if (row.priceComparison === 'at') {
        return { text: row.isSell ? 'at best ask' : 'at best bid', color: '#9ca3af' };
    }
    // "above" a sell's best ask is the losing side (priced worse than the front of
    // the queue); "below" a buy's best bid is likewise the losing side. Every
    // other combination is the winning side, which still not moving is worth
    // seeing but is not explained by price.
    const losing = (row.isSell && row.priceComparison === 'above') || (!row.isSell && row.priceComparison === 'below');
    const bookSide = row.isSell ? 'ask' : 'bid';
    const label = `${row.priceComparison} best ${bookSide}`;
    return { text: label, color: losing ? '#f87171' : '#4ade80' };
}

class StaleCapitalView {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.marketplaceTab = null;
        this.tabCleanupObserver = null;
        this.itemNameCache = new Map();
    }

    /**
     * Initialize the feature
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_staleCapital')) {
            return;
        }

        this.isInitialized = true;
        this.addMarketplaceTab();

        registerCommand({
            name: 'Stale Capital',
            hint: "What of yours isn't moving — open listings and orders ranked by coins tied up",
            run: () => this.openModal(),
        });
    }

    /**
     * Add a "Stale" tab to the marketplace tab strip, following the same
     * clone-a-real-tab convention as the Ledger tab, sitting right after it.
     */
    addMarketplaceTab() {
        const ensureTabExists = () => {
            const tabsContainer = visibleTabsContainer();
            if (!tabsContainer) return;

            const hasMarketListingsTab = Array.from(tabsContainer.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (!hasMarketListingsTab) return;

            if (tabsContainer.querySelector('[data-mwi-stale-capital-tab="true"]')) {
                return;
            }

            const referenceTab = Array.from(tabsContainer.children).find((btn) =>
                btn.textContent.includes('My Listings')
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-stale-capital-tab', 'true');

            const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
            if (badgeSpan) {
                badgeSpan.innerHTML = `
                    <div style="text-align: center;">
                        <div>Stale</div>
                    </div>
                `;
            }

            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            // Right after the Ledger tab when it exists, else right after Market
            // History, else before any pinned material tabs, else at the end
            const ledgerTab = tabsContainer.querySelector('[data-mwi-trade-ledger-tab="true"]');
            const historyTab = tabsContainer.querySelector('[data-mwi-market-history-tab="true"]');
            const firstCustomTab = Array.from(tabsContainer.children).find(
                (btn) => btn.getAttribute('data-mwi-custom-tab') === 'true'
            );
            if (ledgerTab) {
                ledgerTab.after(tab);
            } else if (historyTab) {
                historyTab.after(tab);
            } else if (firstCustomTab) {
                firstCustomTab.before(tab);
            } else {
                tabsContainer.appendChild(tab);
            }

            this.marketplaceTab = tab;
        };

        if (!this.tabCleanupObserver) {
            this.tabCleanupObserver = createMutationWatcher(
                document.body,
                () => {
                    const tabsContainer = visibleTabsContainer();
                    if (!tabsContainer) {
                        if (this.marketplaceTab && !document.body.contains(this.marketplaceTab)) {
                            this.marketplaceTab = null;
                        }
                        return;
                    }

                    const hasMarketListingsTab = Array.from(tabsContainer.children).some((btn) =>
                        btn.textContent.includes('Market Listings')
                    );
                    if (!hasMarketListingsTab) {
                        if (this.marketplaceTab && document.body.contains(this.marketplaceTab)) {
                            this.marketplaceTab.remove();
                            this.marketplaceTab = null;
                        }
                        return;
                    }

                    ensureTabExists();
                },
                { childList: true, subtree: true }
            );
        }

        ensureTabExists();
    }

    /**
     * Item display name from HRID, cached
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item name
     */
    getItemName(itemHrid) {
        if (this.itemNameCache.has(itemHrid)) {
            return this.itemNameCache.get(itemHrid);
        }
        const itemDetails = dataManager.getItemDetails(itemHrid);
        const name = itemDetails?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
        this.itemNameCache.set(itemHrid, name);
        return name;
    }

    /**
     * Current best ask (isSell) / bid (!isSell) for an item + enhancement level,
     * from the freshest of two sources — the Mooket price store (fed live by
     * order books you've opened and the periodic snapshot) and the marketplace
     * API cache (the hourly `marketplace.json` snapshot, patched by order-book
     * views). Neither is a network call: both are synchronous reads of whatever
     * is already cached.
     * @param {string} itemHrid
     * @param {number} enhancementLevel
     * @param {boolean} isSell
     * @returns {number|null} Best price, or null when it could not be read
     */
    getBestPrice(itemHrid, enhancementLevel, isSell) {
        const stored = marketPriceStore.get(itemHrid, enhancementLevel);
        const fromStore = isSell ? stored?.ask : stored?.bid;
        if (typeof fromStore === 'number' && fromStore > 0) return fromStore;

        const snapshot = marketAPI.getPrice(itemHrid, enhancementLevel);
        const fromSnapshot = isSell ? snapshot?.ask : snapshot?.bid;
        return typeof fromSnapshot === 'number' && fromSnapshot > 0 ? fromSnapshot : null;
    }

    /**
     * Open the modal with fresh figures for whoever is the current character.
     *
     * Recomputed on every open rather than cached: the listings and the book
     * both move while the modal is closed, and a character switch that
     * happened in between must never be answered with the departed
     * character's rows.
     */
    openModal() {
        this.result = buildStaleCapital(dataManager.getMarketListings(), (itemHrid, level, isSell) =>
            this.getBestPrice(itemHrid, level, isSell)
        );

        if (!this.modal) {
            this.createModal();
        }

        this.modal.style.display = 'flex';
        this.renderContent();
    }

    /**
     * Close the modal
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    /**
     * Create the modal shell (same chrome as the Ledger modal)
     */
    createModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'mwi-stale-capital-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: ${config.Z_MODAL};
        `;

        const content = document.createElement('div');
        content.className = 'mwi-stale-capital-content';
        content.style.cssText = `
            background: rgba(10, 10, 20, 0.97);
            border: 1px solid rgba(74, 158, 255, 0.5);
            border-radius: 8px;
            padding: 20px;
            max-width: 95%;
            max-height: 90%;
            min-width: 640px;
            overflow: auto;
            color: #e8ecf5;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(74, 158, 255, 0.3);
        `;

        const title = document.createElement('h2');
        title.textContent = 'Stale Capital';
        title.title = "What of yours isn't moving, ranked by coins tied up.";
        title.style.cssText = `
            margin: 0;
            color: #8fb4ff;
        `;

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: #e8ecf5;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 30px;
            height: 30px;
        `;
        closeBtn.addEventListener('click', () => this.closeModal());

        header.appendChild(title);
        header.appendChild(closeBtn);

        const totalsContainer = document.createElement('div');
        totalsContainer.className = 'mwi-stale-capital-totals';
        totalsContainer.style.cssText = `
            margin-bottom: 15px;
            font-size: 13px;
            color: #aaa;
            line-height: 1.6;
        `;

        const sellContainer = document.createElement('div');
        sellContainer.className = 'mwi-stale-capital-sell';
        sellContainer.style.cssText = 'margin-bottom: 20px;';

        const buyContainer = document.createElement('div');
        buyContainer.className = 'mwi-stale-capital-buy';

        content.appendChild(header);
        content.appendChild(totalsContainer);
        content.appendChild(sellContainer);
        content.appendChild(buyContainer);
        this.modal.appendChild(content);
        document.body.appendChild(this.modal);

        this.minimizeCtl = attachMinimize({
            panel: content,
            header,
            body: [totalsContainer, sellContainer, buyContainer],
            panelKey: PANEL_KEY,
            beforeEl: closeBtn,
            accent: '#e8ecf5',
        });

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
    }

    /**
     * Render the totals line and both side tables from `this.result`.
     */
    renderContent() {
        this.renderTotals();
        this.renderSide('sell', 'Sell listings not filling', this.result.sellRows, this.result.sellTotal);
        this.renderSide('buy', 'Buy orders sitting unfilled', this.result.buyRows, this.result.buyTotal);
    }

    /**
     * The one-line coins-tied-up total for each side, at the top of the modal.
     */
    renderTotals() {
        const container = this.modal.querySelector('.mwi-stale-capital-totals');
        while (container.firstChild) container.removeChild(container.firstChild);

        const { sellTotal, buyTotal, sellRows, buyRows } = this.result;

        const line = document.createElement('div');
        const sellPart = `<span style="color: #ffd700;">${formatKMB(sellTotal)}</span> tied up in ${sellRows.length} sell listing${sellRows.length === 1 ? '' : 's'}`;
        const buyPart = `<span style="color: #ffd700;">${formatKMB(buyTotal)}</span> tied up in ${buyRows.length} buy order${buyRows.length === 1 ? '' : 's'}`;
        line.innerHTML = `${sellPart} &nbsp;·&nbsp; ${buyPart}`;
        container.appendChild(line);
    }

    /**
     * One side's section: a heading, an empty note, or a table.
     * @param {'sell'|'buy'} side
     * @param {string} heading - Section heading text
     * @param {Array<Object>} rows - Ranked rows for this side
     * @param {number} total - This side's coins-tied-up total
     */
    renderSide(side, heading, rows, total) {
        const container = this.modal.querySelector(`.mwi-stale-capital-${side}`);
        while (container.firstChild) container.removeChild(container.firstChild);

        const headingEl = document.createElement('div');
        headingEl.textContent = heading;
        headingEl.style.cssText = 'font-size: 14px; color: #8fb4ff; margin-bottom: 8px; font-weight: 500;';
        container.appendChild(headingEl);

        if (rows.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = side === 'sell' ? 'No open sell listings.' : 'No open buy orders.';
            empty.style.cssText = 'padding: 10px; color: #888; font-size: 12px;';
            container.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse; color: #fff;';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.cssText = 'background: #1a1a1a;';
        const headers = [
            { label: 'Item' },
            { label: 'Enh' },
            { label: 'Qty left' },
            { label: 'Price' },
            { label: 'Coins tied up' },
            { label: 'Age' },
            { label: 'Vs. book', title: PRICE_TOOLTIP },
        ];
        for (const header of headers) {
            const th = document.createElement('th');
            th.textContent = header.label;
            if (header.title) th.title = header.title;
            th.style.cssText = 'padding: 6px 10px; text-align: left; border-bottom: 2px solid #555; user-select: none;';
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rows.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.style.cssText = `border-bottom: 1px solid #333; background: ${index % 2 === 0 ? '#2a2a2a' : '#252525'};`;

            const itemCell = document.createElement('td');
            itemCell.textContent = this.getItemName(row.itemHrid);
            itemCell.style.cssText = 'padding: 4px 10px; cursor: pointer;';
            itemCell.title = 'Open this item in the marketplace at its enhancement level.';
            itemCell.addEventListener('mouseenter', () => (itemCell.style.textDecoration = 'underline'));
            itemCell.addEventListener('mouseleave', () => (itemCell.style.textDecoration = ''));
            itemCell.addEventListener('click', () => {
                navigateToMarketplace(row.itemHrid, row.enhancementLevel || 0);
                this.closeModal();
            });
            tr.appendChild(itemCell);

            const enhCell = document.createElement('td');
            enhCell.textContent = row.enhancementLevel > 0 ? `+${row.enhancementLevel}` : '-';
            enhCell.style.padding = '4px 10px';
            tr.appendChild(enhCell);

            const qtyCell = document.createElement('td');
            qtyCell.textContent = String(row.quantity);
            qtyCell.style.padding = '4px 10px';
            tr.appendChild(qtyCell);

            const priceCell = document.createElement('td');
            priceCell.textContent = formatKMB(row.price);
            priceCell.style.padding = '4px 10px';
            tr.appendChild(priceCell);

            const tiedUpCell = document.createElement('td');
            tiedUpCell.textContent = formatKMB(row.coinsTiedUp);
            tiedUpCell.style.cssText = 'padding: 4px 10px; font-weight: 500; color: #ffd700;';
            tr.appendChild(tiedUpCell);

            const ageCell = document.createElement('td');
            ageCell.textContent = row.ageMs !== null ? formatRelativeTime(row.ageMs) : 'unknown';
            ageCell.style.cssText = 'padding: 4px 10px; color: #aaa;';
            if (row.ageMs !== null) {
                ageCell.title = `Created ${formatDateTime(new Date(Date.now() - row.ageMs))}`;
            }
            tr.appendChild(ageCell);

            const bookCell = document.createElement('td');
            const badge = priceComparisonBadge(row);
            bookCell.textContent = badge.text;
            bookCell.title = PRICE_TOOLTIP;
            bookCell.style.cssText = `padding: 4px 10px; color: ${badge.color};`;
            tr.appendChild(bookCell);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);

        const totalLine = document.createElement('div');
        totalLine.textContent = `Total tied up: ${formatKMB(total)}`;
        totalLine.style.cssText = 'padding: 6px 10px; font-size: 12px; color: #9ca3af;';
        container.appendChild(totalLine);
    }

    /**
     * Disable the feature and remove its DOM
     */
    disable() {
        try {
            unregisterCommand('Stale Capital');
            if (this.tabCleanupObserver) {
                this.tabCleanupObserver();
                this.tabCleanupObserver = null;
            }
            if (this.marketplaceTab) {
                this.marketplaceTab.remove();
                this.marketplaceTab = null;
            }
            this.minimizeCtl?.destroy();
            this.minimizeCtl = null;
            if (this.modal) {
                this.modal.remove();
                this.modal = null;
            }
            this.isInitialized = false;
        } catch (error) {
            console.error('[Stale Capital View] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const staleCapitalView = new StaleCapitalView();

config.onSettingChange('market_staleCapital', (value) => {
    if (value) {
        staleCapitalView.initialize();
    } else {
        staleCapitalView.disable();
    }
});

export default staleCapitalView;
