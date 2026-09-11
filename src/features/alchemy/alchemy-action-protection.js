/**
 * Alchemy Action Protection
 * Prevents accidental alchemy actions on items from protected categories.
 * Uses a double-confirm pattern: blocks the action button for 3 seconds,
 * then requires a second click within 3 seconds to proceed.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import bundledActionPanelSort from '../actions/action-panel-sort.js';
import { actionPanelSort } from '../../utils/bundle-bridge.js';
import { getAlchemyCoinCost } from '../../utils/alchemy-fees.js';
import { runningAction } from '../../utils/combat-actions.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';

const STORAGE_KEY_PREFIX = 'alchemyProtectedCategories';
const LOCKDOWN_MS = 3000;
const CONFIRM_WINDOW_MS = 3000;

/**
 * Who this list belongs to, as the key builds it.
 * @returns {string} Character id, or `'default'` before login
 */
function currentOwner() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * @param {string} [owner] - Whose list, defaulting to whoever is logged in now
 * @returns {string} The storage key
 */
function getStorageKey(owner = currentOwner()) {
    return `${STORAGE_KEY_PREFIX}_${owner}`;
}

const DEFAULT_PROTECTION = {
    coinify: [],
    decompose: [],
    transmute: [],
};

class AlchemyActionProtection {
    constructor() {
        this.isInitialized = false;
        this.protectedMap = new Map();
        this.unregisterHandlers = [];
        this._panelCleanup = null; // Releases observers/listeners bound to the current alchemy panel
        this.confirmTimer = null;
        this.lockdownTimer = null;
        this._updatingGold = false;
        this._inventoryTotals = null; // Coin balance and per-item counts, rebuilt on items_updated
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('alchemy_actionProtection')) return;

        this.isInitialized = true;

        // Whose list this is, fixed before the read. Boot's `initializeFeatures()`
        // is not on the switch chain, so a switch landing inside the read
        // resumes here with another character current — and the `else` branch
        // *writes*. Seeding the empty default under the arriving character's key
        // would wipe the categories they had protected, and the double-confirm
        // that stands between a click and a decomposed item would simply stop
        // firing, with nothing in the popup to say why.
        const owner = currentOwner();
        const saved = await storage.getJSON(getStorageKey(owner), 'settings', null);
        if (currentOwner() !== owner) return;

        if (saved) {
            for (const [type, categories] of Object.entries(saved)) {
                this.protectedMap.set(type, new Set(categories));
            }
        } else {
            for (const [type, categories] of Object.entries(DEFAULT_PROTECTION)) {
                this.protectedMap.set(type, new Set(categories));
            }
            await this._saveProtection(owner);
        }

        this._setupClickInterceptor();
        this._setupShieldButton();
    }

    _setupClickInterceptor() {
        const handler = (e) => {
            if (!config.getSetting('alchemy_actionProtection')) return;

            const btn = e.target.closest('button');
            if (!btn) return;

            if (!btn.closest('[class*="SkillActionDetail_buttonsContainer"]')) return;

            const alchemyPanel = btn.closest('[class*="SkillActionDetail_alchemyComponent"]');
            if (!alchemyPanel) return;

            const alchemyType = this._getAlchemyType();
            if (!alchemyType) return;

            const protectedCategories = this.protectedMap.get(alchemyType);
            if (!protectedCategories || protectedCategories.size === 0) return;

            const itemHrid = this._getSelectedItemHrid();
            if (!itemHrid) return;

            const itemDetails = dataManager.getItemDetails(itemHrid);
            if (!itemDetails) return;

            const categoryHrid = itemDetails.categoryHrid;
            if (!protectedCategories.has(categoryHrid)) return;

            // Item is in a protected category — apply state machine
            if (alchemyPanel.dataset.mwiAlchemyConfirmed === '1') {
                alchemyPanel.dataset.mwiAlchemyConfirmed = '';
                this._clearWarning(alchemyPanel);
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (alchemyPanel.dataset.mwiAlchemyLocked === '1') return;

            alchemyPanel.dataset.mwiAlchemyLocked = '1';

            const categoryName = this._getCategoryDisplayName(categoryHrid);
            this._showWarning(alchemyPanel, `Protected category (${categoryName})! Unlocks in 3s...`);

            if (this.lockdownTimer) clearTimeout(this.lockdownTimer);
            if (this.confirmTimer) clearTimeout(this.confirmTimer);

            this.lockdownTimer = setTimeout(() => {
                alchemyPanel.dataset.mwiAlchemyLocked = '';
                alchemyPanel.dataset.mwiAlchemyConfirmed = '1';
                this._showWarning(alchemyPanel, 'Click again to confirm.');

                this.confirmTimer = setTimeout(() => {
                    alchemyPanel.dataset.mwiAlchemyConfirmed = '';
                    this._clearWarning(alchemyPanel);
                }, CONFIRM_WINDOW_MS);
            }, LOCKDOWN_MS);
        };

        document.addEventListener('click', handler, true);
        this.unregisterHandlers.push(() => document.removeEventListener('click', handler, true));
    }

    _setupShieldButton() {
        const unregister = domObserver.onClass(
            'AlchemyActionProtection-Shield',
            'SkillActionDetail_primaryItemSelectorContainer',
            (itemSelectorContainer) => {
                this._injectShieldButton(itemSelectorContainer);
            }
        );
        this.unregisterHandlers.push(unregister);

        // @run-at document-start: an alchemy panel open before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(
            domObserver.onReady('AlchemyActionProtection-ShieldCatchUp', () => {
                const existing = document.querySelector('[class*="SkillActionDetail_primaryItemSelectorContainer"]');
                if (existing) {
                    this._injectShieldButton(existing);
                }
            })
        );
    }

    _injectShieldButton(itemSelectorContainer) {
        const alchemyComponent = itemSelectorContainer.closest('[class*="SkillActionDetail_alchemyComponent"]');
        if (!alchemyComponent) return;

        const parent = itemSelectorContainer.parentElement;
        if (!parent || alchemyComponent.querySelector('.mwi-alchemy-protection-btn')) return;

        // Release observers/listeners bound to the previous panel instance so they
        // don't accumulate across panel remounts
        this._teardownPanel();
        const panelCleanups = [];

        // Flex row container for shield + pin
        const iconRow = document.createElement('div');
        iconRow.className = 'mwi-alchemy-icon-row';
        iconRow.style.cssText = 'display:flex; gap:6px; justify-content:center; margin-bottom:2px;';

        const btn = document.createElement('div');
        btn.className = 'mwi-alchemy-protection-btn';
        btn.textContent = '\u{1F6E1}\u{FE0F}';
        btn.style.cssText = 'cursor:pointer; font-size:16px; opacity:0.7; transition:opacity 0.1s; text-align:center;';
        btn.addEventListener('mouseenter', () => {
            btn.style.opacity = '1';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.opacity = '0.7';
        });
        btn.addEventListener('click', () => this.openConfigPopup());

        // Pin icon.
        //
        // The class must not be `mwi-alchemy-pin`. That name belongs to the pin
        // buttons alchemy-item-pins puts on the tiles inside the item picker,
        // and its stylesheet — which is global, in document.head — describes a
        // 15px badge absolutely positioned at `top: 0; right: 0` of whatever is
        // positioned above it, painted rgba(10, 14, 22, 0.75) and normally held
        // at `opacity: 0`. Sharing the name handed this icon all of that: on a
        // mouse it disappeared, and on a touchscreen — where that stylesheet
        // flips the opacity back to 1 and the size to 32px — it became a black
        // square floating over the catalyst slot beside it. alchemy-item-pins'
        // disable() also removes every `.mwi-alchemy-pin` on the page, which
        // took this icon with it.
        const pinIcon = document.createElement('div');
        pinIcon.className = 'mwi-alchemy-action-pin';
        pinIcon.innerHTML = '\u{1F4CC}';
        pinIcon.style.cssText =
            'position:static; cursor:pointer; font-size:16px; transition:all 0.2s; text-align:center; filter: grayscale(100%) brightness(0.7); display:none;';
        pinIcon.title = 'Pin this action';

        const updatePinIcon = () => {
            const alchemyType = this._getAlchemyType();
            const itemHrid = this._getSelectedItemHrid();
            if (!alchemyType || !itemHrid) {
                pinIcon.style.display = 'none';
                return;
            }
            pinIcon.style.display = 'block';
            const compositeKey = `/actions/alchemy/${alchemyType}|${itemHrid}`;
            const isPinned = (actionPanelSort() || bundledActionPanelSort).isPinned(compositeKey);
            if (isPinned) {
                pinIcon.style.filter = 'grayscale(0%) brightness(1.2) drop-shadow(0 0 3px rgba(255, 100, 0, 0.8))';
                pinIcon.style.transform = 'scale(1.1)';
                pinIcon.title = 'Unpin this action';
            } else {
                pinIcon.style.filter = 'grayscale(100%) brightness(0.7)';
                pinIcon.style.transform = 'scale(1)';
                pinIcon.title = 'Pin this action';
            }
        };

        pinIcon.addEventListener('mouseenter', () => {
            const alchemyType = this._getAlchemyType();
            const itemHrid = this._getSelectedItemHrid();
            if (alchemyType && itemHrid) {
                const compositeKey = `/actions/alchemy/${alchemyType}|${itemHrid}`;
                if (!(actionPanelSort() || bundledActionPanelSort).isPinned(compositeKey)) {
                    pinIcon.style.filter = 'grayscale(50%) brightness(1)';
                }
            }
        });
        pinIcon.addEventListener('mouseleave', updatePinIcon);
        pinIcon.addEventListener('click', async () => {
            const alchemyType = this._getAlchemyType();
            const itemHrid = this._getSelectedItemHrid();
            if (!alchemyType || !itemHrid) return;
            const compositeKey = `/actions/alchemy/${alchemyType}|${itemHrid}`;
            await (actionPanelSort() || bundledActionPanelSort).togglePin(compositeKey);
            updatePinIcon();
        });

        iconRow.appendChild(btn);
        iconRow.appendChild(pinIcon);
        parent.insertBefore(iconRow, itemSelectorContainer);

        const tabContainer = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
        const updateVisibility = () => {
            const type = this._getAlchemyType();
            iconRow.style.display = type ? 'flex' : 'none';
            updatePinIcon();
        };

        updateVisibility();

        if (tabContainer) {
            const observer = new MutationObserver(updateVisibility);
            observer.observe(tabContainer, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
            panelCleanups.push(() => observer.disconnect());
        }

        // Watch item selection changes to update pin state and gold summary.
        // Debounced: React rebuilds the panel in bursts of many mutations, and
        // each pass re-reads the tab, the selected item and the inventory.
        let updateAllTimer = null;
        const updateAll = () => {
            if (updateAllTimer) clearTimeout(updateAllTimer);
            updateAllTimer = setTimeout(() => {
                updateAllTimer = null;
                updatePinIcon();
                this._updateGoldSummary(alchemyComponent);
            }, 50);
        };
        const itemObserver = new MutationObserver(updateAll);
        itemObserver.observe(alchemyComponent, { childList: true, subtree: true });
        panelCleanups.push(() => {
            itemObserver.disconnect();
            if (updateAllTimer) {
                clearTimeout(updateAllTimer);
                updateAllTimer = null;
            }
        });

        // Watch action count input changes for gold summary
        const onInputChange = (e) => {
            if (e.target.closest('[class*="maxActionCountInput"]')) {
                this._updateGoldSummary(alchemyComponent);
            }
        };
        alchemyComponent.addEventListener('input', onInputChange);
        panelCleanups.push(() => alchemyComponent.removeEventListener('input', onInputChange));

        // Also update gold summary on tab changes
        if (tabContainer) {
            const tabGoldObserver = new MutationObserver(() => this._updateGoldSummary(alchemyComponent));
            tabGoldObserver.observe(tabContainer, {
                attributes: true,
                subtree: true,
                attributeFilter: ['aria-selected'],
            });
            panelCleanups.push(() => tabGoldObserver.disconnect());
        }

        // Update gold summary on inventory changes. The coin and item totals
        // are tallied once per inventory update, not once per panel mutation.
        const onItemsUpdated = () => {
            this._inventoryTotals = null;
            this._updateGoldSummary(alchemyComponent);
        };
        dataManager.on('items_updated', onItemsUpdated);
        panelCleanups.push(() => {
            dataManager.off('items_updated', onItemsUpdated);
            this._inventoryTotals = null;
        });

        this._panelCleanup = () => {
            for (const fn of panelCleanups) fn();
        };

        // Initial update
        this._updateGoldSummary(alchemyComponent);
    }

    /**
     * Invoke and clear the current panel's cleanup function
     */
    _teardownPanel() {
        if (this._panelCleanup) {
            this._panelCleanup();
            this._panelCleanup = null;
        }
    }

    _getAlchemyType() {
        const tabContainer = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
        const selectedTab = tabContainer?.querySelector('[role="tab"][aria-selected="true"]');
        const tabText = selectedTab?.textContent?.trim()?.toLowerCase() || '';

        if (tabText.includes('transmute')) return 'transmute';
        if (tabText.includes('decompose')) return 'decompose';
        if (tabText.includes('coinify')) return 'coinify';
        return null;
    }

    _getSelectedItemHrid() {
        const reqContainer = document.querySelector(
            '[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"]'
        );
        if (!reqContainer) return null;

        const use = reqContainer.querySelector('svg use');
        if (!use) return null;

        const href = use.getAttribute('href');
        if (!href) return null;

        const itemId = href.split('#')[1];
        return itemId ? `/items/${itemId}` : null;
    }

    /**
     * Inventory-location counts by item hrid, plus the coin balance, tallied
     * once and kept until the next `items_updated`.
     * @returns {{counts: Map<string, number>, coins: number}}
     */
    _getInventoryTotals() {
        if (this._inventoryTotals) return this._inventoryTotals;
        const counts = new Map();
        let coins = 0;
        const inventory = dataManager.getInventory();
        if (inventory) {
            for (const item of inventory) {
                if (item.itemLocationHrid !== '/item_locations/inventory') continue;
                const count = item.count || 0;
                if (item.itemHrid === '/items/coin') coins += count;
                counts.set(item.itemHrid, (counts.get(item.itemHrid) || 0) + count);
            }
        }
        this._inventoryTotals = { counts, coins };
        return this._inventoryTotals;
    }

    _updateGoldSummary(alchemyComponent) {
        if (this._updatingGold) return;
        this._updatingGold = true;

        try {
            this._doUpdateGoldSummary(alchemyComponent);
        } finally {
            this._updatingGold = false;
        }
    }

    _doUpdateGoldSummary(alchemyComponent) {
        let summaryDiv = alchemyComponent.querySelector('.mwi-alchemy-gold-summary');

        const alchemyType = this._getAlchemyType();
        if (!alchemyType || alchemyType === 'coinify') {
            if (summaryDiv) summaryDiv.style.display = 'none';
            return;
        }

        const itemHrid = this._getSelectedItemHrid();
        if (!itemHrid) {
            if (summaryDiv) summaryDiv.style.display = 'none';
            return;
        }

        const actionHrid = `/actions/alchemy/${alchemyType}`;
        const itemDetails = dataManager.getItemDetails(itemHrid);
        if (!itemDetails) {
            if (summaryDiv) summaryDiv.style.display = 'none';
            return;
        }
        const bulkMultiplier = itemDetails.alchemyDetail?.bulkMultiplier || 1;

        const coinCost = getAlchemyCoinCost(itemDetails, alchemyType);

        const totals = this._getInventoryTotals();
        const itemCount = totals.counts.get(itemHrid) || 0;
        const goldBalance = totals.coins;

        const actions = dataManager.getCurrentActions();
        // The queue is insertion order, not execution order — a repeating action
        // requeued to the front carries a HIGHER ordinal, so `.find` can return an
        // action queued behind the one actually running. `runningAction` picks the
        // lowest-ordinal unfinished match instead.
        const activeAction = runningAction(
            actions,
            (a) => a.actionHrid === actionHrid && a.primaryItemHash?.includes(itemHrid)
        );

        let totalActions;
        let label = 'all';

        const countInput = alchemyComponent.querySelector('[class*="maxActionCountInput"] input');
        const inputValue = countInput ? parseInt(countInput.value, 10) : NaN;

        // Floor, not ceil: a bulk action consumes bulkMultiplier items per
        // attempt, so a stack that isn't an exact multiple has a leftover
        // remainder that cannot fund one more action. Rounding up overstated
        // how many actions the item stock could sustain.
        const maxFromItems = Math.floor(itemCount / bulkMultiplier);

        if (!isNaN(inputValue) && inputValue > 0) {
            totalActions = Math.min(inputValue, maxFromItems);
            label = formatLargeNumber(totalActions);
        } else if (activeAction?.hasMaxCount) {
            totalActions = Math.min(activeAction.maxCount - (activeAction.currentCount || 0), maxFromItems);
            label = formatLargeNumber(totalActions);
        } else {
            totalActions = maxFromItems;
        }

        const goldNeeded = totalActions * coinCost;
        const hasEnough = goldBalance >= goldNeeded;

        if (!summaryDiv) {
            summaryDiv = document.createElement('div');
            summaryDiv.className = 'mwi-alchemy-gold-summary';
            summaryDiv.style.cssText = 'font-size: 12px; padding: 4px 8px; margin-top: 4px; text-align: center;';
            const costsSection = alchemyComponent.querySelector('[class*="SkillActionDetail_alchemyCosts"]');
            if (costsSection) {
                costsSection.insertAdjacentElement('afterend', summaryDiv);
            } else {
                alchemyComponent.appendChild(summaryDiv);
            }
        }

        const color = hasEnough ? '#4caf50' : '#ff6b6b';
        const text = `Gold for ${label}: ${formatLargeNumber(goldNeeded)} / ${formatLargeNumber(goldBalance)}`;
        if (summaryDiv.textContent === text && summaryDiv.style.display === 'block') return;
        summaryDiv.style.display = 'block';
        summaryDiv.style.color = color;
        summaryDiv.textContent = text;
    }

    _getCategoryDisplayName(categoryHrid) {
        const name = categoryHrid.replace('/item_categories/', '').replace(/_/g, ' ');
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    _showWarning(container, message) {
        this._clearWarning(container);

        const warning = document.createElement('div');
        warning.className = 'mwi-alchemy-protection-warning';
        warning.style.cssText = `
            text-align: center;
            font-size: 12px;
            font-weight: 700;
            color: #ff6b6b;
            background: rgba(0, 0, 0, 0.85);
            padding: 6px 12px;
            border-radius: 4px;
            margin-top: 6px;
        `;
        warning.textContent = message;

        const actionBtn = container.querySelector('button.Button_success__6d6kU');
        if (actionBtn) {
            actionBtn.parentElement.insertAdjacentElement('afterend', warning);
        } else {
            container.appendChild(warning);
        }
    }

    _clearWarning(container) {
        const existing = container.querySelector('.mwi-alchemy-protection-warning');
        if (existing) existing.remove();
    }

    /**
     * Remove the config popup and its invisible backdrop together
     */
    _closeConfigPopup() {
        document.getElementById('mwi-alchemy-protection-popup')?.remove();
        document.getElementById('mwi-alchemy-protection-backdrop')?.remove();
    }

    async openConfigPopup() {
        const existing = document.getElementById('mwi-alchemy-protection-popup');
        if (existing) {
            this._closeConfigPopup();
            return;
        }

        const popup = document.createElement('div');
        popup.id = 'mwi-alchemy-protection-popup';
        popup.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #1e1e2e;
            border: 2px solid #555;
            border-radius: 8px;
            padding: 20px;
            z-index: ${PANEL_Z_CAP + 2};
            min-width: 340px;
            max-width: 500px;
            max-height: 90vh;
            overflow-y: auto;
            color: #ccc;
            font-size: 13px;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;';
        header.innerHTML = `<h3 style="margin:0; font-size:16px; color:#eee;">Alchemy Action Protection</h3>`;

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u2715';
        closeBtn.style.cssText =
            'background:#a33; color:#fff; border:none; cursor:pointer; font-size:16px; padding:2px 8px; border-radius:4px;';
        closeBtn.addEventListener('click', () => this._closeConfigPopup());
        header.appendChild(closeBtn);
        popup.appendChild(header);

        const desc = document.createElement('p');
        desc.style.cssText = 'color:#999; margin:0 0 10px 0; font-size:12px;';
        desc.textContent =
            'Select which item categories to protect from each alchemy action. Protected items require a 3-second confirmation before the action proceeds.';
        popup.appendChild(desc);

        const alchemyTypes = ['coinify', 'decompose', 'transmute'];
        const categories = this._getAlchemizableCategories();

        for (const type of alchemyTypes) {
            const typeCats = categories[type];
            if (!typeCats || typeCats.length === 0) continue;

            const section = document.createElement('div');
            section.style.cssText = 'margin-bottom: 10px;';

            const typeHeader = document.createElement('div');
            typeHeader.style.cssText = 'font-weight:bold; margin-bottom:6px; text-transform:capitalize; color:#ddd;';
            typeHeader.textContent = type;
            section.appendChild(typeHeader);

            const protectedSet = this.protectedMap.get(type) || new Set();

            for (const cat of typeCats) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:2px 0; cursor:pointer;';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = protectedSet.has(cat.hrid);
                checkbox.style.cssText = 'cursor:pointer;';
                checkbox.addEventListener('change', async () => {
                    if (checkbox.checked) {
                        protectedSet.add(cat.hrid);
                    } else {
                        protectedSet.delete(cat.hrid);
                    }
                    this.protectedMap.set(type, protectedSet);
                    await this._saveProtection();
                });

                const label = document.createElement('span');
                label.textContent = `${cat.name} (${cat.count} items)`;

                row.appendChild(checkbox);
                row.appendChild(label);
                section.appendChild(row);
            }

            popup.appendChild(section);
        }

        // Click outside to close
        const backdrop = document.createElement('div');
        backdrop.id = 'mwi-alchemy-protection-backdrop';
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', () => this._closeConfigPopup());

        document.body.appendChild(backdrop);
        document.body.appendChild(popup);
    }

    _getAlchemizableCategories() {
        const gameData = dataManager.getInitClientData();
        if (!gameData?.itemDetailMap) return {};

        const result = { transmute: {}, decompose: {}, coinify: {} };

        for (const item of Object.values(gameData.itemDetailMap)) {
            if (!item.alchemyDetail || !item.categoryHrid) continue;

            const cat = item.categoryHrid;

            if (item.alchemyDetail.transmuteDropTable) {
                if (!result.transmute[cat]) result.transmute[cat] = 0;
                result.transmute[cat]++;
            }
            if (item.alchemyDetail.decomposeItems) {
                if (!result.decompose[cat]) result.decompose[cat] = 0;
                result.decompose[cat]++;
            }
            if (item.alchemyDetail.isCoinifiable) {
                if (!result.coinify[cat]) result.coinify[cat] = 0;
                result.coinify[cat]++;
            }
        }

        const format = (catMap) =>
            Object.entries(catMap)
                .map(([hrid, count]) => ({
                    hrid,
                    name: this._getCategoryDisplayName(hrid),
                    count,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

        return {
            transmute: format(result.transmute),
            decompose: format(result.decompose),
            coinify: format(result.coinify),
        };
    }

    /**
     * @param {string} [owner] - Whose list to file this under; defaults to
     *   whoever is logged in, which is right for every call made from a click
     * @returns {Promise<void>}
     */
    async _saveProtection(owner) {
        const obj = {};
        for (const [type, set] of this.protectedMap) {
            obj[type] = [...set];
        }
        await storage.setJSON(getStorageKey(owner), obj, 'settings');
    }

    disable() {
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];
        this._teardownPanel();

        if (this.lockdownTimer) clearTimeout(this.lockdownTimer);
        if (this.confirmTimer) clearTimeout(this.confirmTimer);

        this.isInitialized = false;
        this.protectedMap.clear();

        const warning = document.querySelector('.mwi-alchemy-protection-warning');
        if (warning) warning.remove();
        this._closeConfigPopup();
        const iconRow = document.querySelector('.mwi-alchemy-icon-row');
        if (iconRow) iconRow.remove();
        const goldSummary = document.querySelector('.mwi-alchemy-gold-summary');
        if (goldSummary) goldSummary.remove();
    }
}

const alchemyActionProtection = new AlchemyActionProtection();

export { alchemyActionProtection };

export default {
    name: 'Alchemy Action Protection',
    initialize: async () => {
        await alchemyActionProtection.initialize();
    },
    cleanup: () => {
        alchemyActionProtection.disable();
    },
    disable: () => {
        try {
            alchemyActionProtection.disable();
        } catch (error) {
            console.error('[Alchemy Action Protection] Disable failed part-way:', error);
        } finally {
            alchemyActionProtection.isInitialized = false;
        }
    },
};
