/**
 * Action Filter Manager
 *
 * Adds a search/filter input box to action panel pages (gathering/production).
 * Filters action panels in real-time based on action name.
 * Works alongside existing sorting and hide negative profit features.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import marketAPI from '../../api/marketplace.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { isMobileMode } from '../../utils/mobile.js';
import actionPanelSort from './action-panel-sort.js';
import { displayGatheringProfit, displayProductionProfit } from './profit-display.js';

/**
 * Device-local key for whether the mobile "sort/mode/craft/refresh" row was
 * left open. `toolasha_local_` keeps it out of settings sync, exports, and
 * backups (see `DEVICE_LOCAL_KEY_PREFIXES` in `core/settings-storage.js`) —
 * a phone and a desktop each remember their own collapsed/expanded state
 * instead of fighting over one synced value.
 */
const CONTROLS_EXPANDED_KEY = 'toolasha_local_actionFilterControlsExpanded';

class ActionFilter {
    constructor() {
        this.panels = new Map(); // actionPanel → {actionName, container}
        this.filterValue = ''; // Current filter text
        this.filterInput = null; // Reference to the input element
        this.sortButton = null; // Reference to the sort toggle button
        this.modeButton = null; // Reference to the profit mode toggle button
        this.noResultsMessage = null; // Reference to "No matching actions" message
        this.initialized = false;
        this.timerRegistry = createTimerRegistry();
        this.filterTimeout = null;
        this.unregisterHandlers = [];
        this.currentTitleElement = null; // Track which title we're attached to
        this.refreshButton = null; // Reference to the manual price refresh button
        this._priceRefreshInFlight = false; // Guards against a second click while fetching
        this._updateModeBtn = null;
        this._updateCraftBtn = null;
        this._updateSortBtn = null;
        // Mobile-only collapsible row — see injectFilterInput(). Desktop never
        // creates these, so they stay null there.
        this.controlsToggle = null; // The compact "show controls" button
        this.controlsWrapper = null; // Holds sort/mode/craft/refresh when collapsible
        this._controlsExpanded = false;
    }

    /**
     * Initialize - set up DOM observers
     */
    async initialize() {
        if (this.initialized) return;

        // Observe for skill page title bars
        const unregisterTitleObserver = domObserver.onClass(
            'ActionFilter-Title',
            'GatheringProductionSkillPanel_title__3VihQ',
            (titleElement) => {
                this.injectFilterInput(titleElement);
            }
        );

        this.unregisterHandlers.push(unregisterTitleObserver);

        // Re-update button labels when config finishes loading from storage
        this.unregisterHandlers.push(
            config.onSettingChange('profitCalc_pricingMode', () => {
                if (this._updateModeBtn) this._updateModeBtn();
            })
        );
        this.unregisterHandlers.push(
            config.onSettingChange('profitCalc_craftUpgradeItems', () => {
                if (this._updateCraftBtn) this._updateCraftBtn();
            })
        );

        // A character switch reloads settings with an empty previous map, so the
        // per-key change callbacks above never fire — the mode/craft buttons and
        // the profit sections they drive would keep the previous character's
        // pricing mode. This channel fires whenever settings finish loading, so
        // Action Filter — which panel-observer.js's cleanup() tears down and
        // re-initializes on every character switch, like every other feature —
        // resyncs even though its own per-key listeners above went quiet.
        // Ported from upstream Celasha/Toolasha#630.
        this.unregisterHandlers.push(
            config.onSettingsLoaded(() => {
                if (this._updateModeBtn) this._updateModeBtn();
                if (this._updateCraftBtn) this._updateCraftBtn();
                this._refreshProfitDisplays();
            })
        );

        this.unregisterHandlers.push(
            actionPanelSort.onSortModeChange(() => {
                if (this._updateSortBtn) this._updateSortBtn();
            })
        );

        this.initialized = true;
    }

    /**
     * Inject filter input into the title bar
     * @param {HTMLElement} titleElement - The h1 title element
     */
    injectFilterInput(titleElement) {
        // If this is a different title than we're currently attached to, clean up the old one first
        if (this.currentTitleElement && this.currentTitleElement !== titleElement) {
            this.clearFilter();
        }

        // Check if we already injected into THIS specific title
        if (titleElement.querySelector('#mwi-action-filter')) {
            return;
        }

        // Track the new title element
        this.currentTitleElement = titleElement;

        // Reset UI refs for new page (panels are NOT cleared — they may have been
        // registered before this title appeared in the same mutation batch)
        this.filterValue = '';
        this.filterInput = null;
        this.sortButton = null;
        this.modeButton = null;
        this.refreshButton = null;
        this.noResultsMessage = null;
        this.controlsToggle = null;
        this.controlsWrapper = null;
        this._controlsExpanded = false;

        // The h1 has display: block from game CSS, need to override it
        const anyVisible =
            config.getSetting('actionPanel_showFilter') ||
            config.getSetting('actionPanel_showSort') ||
            config.getSetting('actionPanel_showPricingMode') ||
            config.getSetting('actionPanel_showCraftToggle') ||
            this._profitPerHourVisible();

        if (anyVisible) {
            titleElement.style.setProperty('display', 'flex', 'important');
            titleElement.style.alignItems = 'center';
            titleElement.style.gap = '15px';
            titleElement.style.flexWrap = 'wrap';
        }

        // Create input element (match game's input style)
        const input = document.createElement('input');
        input.id = 'mwi-action-filter';
        input.type = 'text';
        input.placeholder = 'Filter actions...';
        input.className = 'MuiInputBase-input'; // Use game's input class
        input.style.padding = '8px 12px';
        input.style.fontSize = '14px';
        input.style.border = '1px solid rgba(255, 255, 255, 0.23)';
        input.style.borderRadius = '4px';
        input.style.backgroundColor = 'transparent';
        input.style.color = 'inherit';
        input.style.width = '200px';
        input.style.fontFamily = 'inherit';
        input.style.flexShrink = '0'; // Don't shrink the input

        // Add focus styles
        input.addEventListener('focus', () => {
            input.style.borderColor = config.COLOR_ACCENT;
            input.style.outline = 'none';
        });

        input.addEventListener('blur', () => {
            input.style.borderColor = 'rgba(255, 255, 255, 0.23)';
        });

        // Add input listener with debouncing
        input.addEventListener('input', (e) => {
            this.handleFilterInput(e.target.value);
        });

        // Insert at the beginning of the title element (before the skill name div)
        titleElement.insertBefore(input, titleElement.firstChild);

        // Store reference
        this.filterInput = input;

        if (!config.getSetting('actionPanel_showFilter')) {
            input.style.display = 'none';
        }

        // Mobile mode: the sort/mode/craft/refresh buttons collapse behind one
        // compact toggle on the filter input's row instead of eating two more
        // full-width rows above the action list. Desktop is untouched — no
        // wrapper, no toggle, buttons attach straight to the title bar exactly
        // as before.
        // No point collapsing an empty row behind a toggle: if the user has
        // switched off sort, pricing mode, craft, and profit/hr (which is what
        // gates the refresh button), there is nothing for the toggle to reveal.
        const hasControlsToShow =
            config.getSetting('actionPanel_showSort') ||
            config.getSetting('actionPanel_showPricingMode') ||
            config.getSetting('actionPanel_showCraftToggle') ||
            this._profitPerHourVisible();
        const mobile = isMobileMode() && hasControlsToShow;
        // Where the four control buttons get attached: the title bar directly
        // on desktop (unchanged), or a collapsible wrapper on mobile.
        let controlsHost = null;

        if (mobile) {
            const toggle = document.createElement('button');
            toggle.id = 'mwi-action-controls-toggle';
            toggle.type = 'button';
            toggle.textContent = '⋯';
            toggle.title = 'Show sort, pricing mode, craft, and price-refresh controls';
            toggle.setAttribute('aria-label', 'Show sort, pricing mode, craft, and price-refresh controls');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-controls', 'mwi-action-controls');
            toggle.style.cssText = `
                padding: 8px 12px;
                font-size: 14px;
                border: 1px solid rgba(255, 255, 255, 0.23);
                border-radius: 4px;
                background: transparent;
                cursor: pointer;
                font-family: inherit;
                flex-shrink: 0;
            `;
            toggle.addEventListener('click', () => {
                const next = !this._controlsExpanded;
                this._applyControlsExpanded(next);
                storage.set(CONTROLS_EXPANDED_KEY, next, 'settings').catch((error) => {
                    console.error('[ActionFilter] Failed to save whether the mobile controls row was open:', error);
                });
            });
            input.insertAdjacentElement('afterend', toggle);
            this.controlsToggle = toggle;

            const wrapper = document.createElement('div');
            wrapper.id = 'mwi-action-controls';
            wrapper.style.cssText = `
                display: none;
                flex-direction: row;
                flex-wrap: wrap;
                gap: 15px;
                width: 100%;
            `;
            toggle.insertAdjacentElement('afterend', wrapper);
            this.controlsWrapper = wrapper;
            controlsHost = wrapper;

            // Collapsed until proven otherwise — a device that never stored a
            // preference (or storage that cannot be read) gets the compact
            // single-row default the mobile layout exists for.
            this._controlsExpanded = false;
            storage
                .get(CONTROLS_EXPANDED_KEY, 'settings', false)
                .then((expanded) => {
                    // The page may have navigated away, or the filter been torn
                    // down/rebuilt, while this read was in flight — only apply it
                    // to the wrapper it was read for.
                    if (this.controlsWrapper !== wrapper || !expanded) return;
                    this._applyControlsExpanded(true);
                })
                .catch((error) => {
                    console.error('[ActionFilter] Failed to read whether the mobile controls row was open:', error);
                });
        }

        // Create sort toggle button
        const SORT_MODES = ['default', 'profit', 'xp', 'coinsPerXp'];
        const SORT_LABELS = {
            default: 'Sort: Default',
            profit: 'Sort: Profit',
            xp: 'Sort: XP',
            coinsPerXp: 'Sort: Profit/XP',
        };
        const sortBtn = document.createElement('button');
        sortBtn.id = 'mwi-action-sort-toggle';
        const updateSortBtn = () => {
            const mode = actionPanelSort.getSortMode();
            sortBtn.textContent = SORT_LABELS[mode] || 'Sort: Default';
            const isActive = mode !== 'default';
            sortBtn.style.borderColor = isActive ? config.COLOR_ACCENT : 'rgba(255, 255, 255, 0.23)';
            sortBtn.style.color = isActive ? config.COLOR_ACCENT : 'inherit';
        };
        sortBtn.style.cssText = `
            padding: 8px 12px;
            font-size: 14px;
            border: 1px solid rgba(255, 255, 255, 0.23);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            font-family: inherit;
            flex-shrink: 0;
        `;
        updateSortBtn();
        this._updateSortBtn = updateSortBtn;
        sortBtn.addEventListener('click', () => {
            const current = actionPanelSort.getSortMode();
            const nextIndex = (SORT_MODES.indexOf(current) + 1) % SORT_MODES.length;
            actionPanelSort.setSortMode(SORT_MODES[nextIndex]);
            updateSortBtn();
            actionPanelSort.sortPanelsByProfit();
        });
        if (controlsHost) {
            controlsHost.appendChild(sortBtn);
        } else {
            input.insertAdjacentElement('afterend', sortBtn);
        }
        this.sortButton = sortBtn;

        if (!config.getSetting('actionPanel_showSort')) {
            sortBtn.style.display = 'none';
        }

        // Create profit mode toggle button
        const PROFIT_MODES = ['hybrid', 'conservative', 'optimistic', 'patientBuy'];
        const modeBtn = document.createElement('button');
        modeBtn.id = 'mwi-action-profit-mode';
        const updateModeBtn = () => {
            const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
            modeBtn.textContent = `Mode: ${config.getPricingModeLabel(mode)}`;
        };
        modeBtn.style.cssText = `
            padding: 8px 12px;
            font-size: 14px;
            border: 1px solid rgba(255, 255, 255, 0.23);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            font-family: inherit;
            flex-shrink: 0;
        `;
        updateModeBtn();
        this._updateModeBtn = updateModeBtn;
        modeBtn.addEventListener('click', async () => {
            const current = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
            const nextIndex = (PROFIT_MODES.indexOf(current) + 1) % PROFIT_MODES.length;
            config.setSettingValue('profitCalc_pricingMode', PROFIT_MODES[nextIndex]);
            updateModeBtn();
            await this._refreshProfitDisplays();
        });
        if (controlsHost) {
            controlsHost.appendChild(modeBtn);
        } else {
            sortBtn.insertAdjacentElement('afterend', modeBtn);
        }
        this.modeButton = modeBtn;

        if (!config.getSetting('actionPanel_showPricingMode')) {
            modeBtn.style.display = 'none';
        }

        // Create craft toggle button
        const craftBtn = document.createElement('button');
        craftBtn.id = 'mwi-action-craft-toggle';
        craftBtn.title =
            'When on, uses crafting cost for upgrade items if cheaper than market, and includes crafting time in profit/hr';
        const updateCraftBtn = () => {
            const enabled = config.getSetting('profitCalc_craftUpgradeItems');
            craftBtn.textContent = enabled ? 'Craft: On' : 'Craft: Off';
        };
        craftBtn.style.cssText = `
            padding: 8px 12px;
            font-size: 14px;
            border: 1px solid rgba(255, 255, 255, 0.23);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            font-family: inherit;
            flex-shrink: 0;
        `;
        updateCraftBtn();
        this._updateCraftBtn = updateCraftBtn;
        craftBtn.addEventListener('click', async () => {
            const current = config.getSetting('profitCalc_craftUpgradeItems');
            config.setSetting('profitCalc_craftUpgradeItems', !current);
            updateCraftBtn();
            await this._refreshProfitDisplays();
        });
        if (controlsHost) {
            controlsHost.appendChild(craftBtn);
        } else {
            modeBtn.insertAdjacentElement('afterend', craftBtn);
        }
        this.craftButton = craftBtn;

        if (!config.getSetting('actionPanel_showCraftToggle')) {
            craftBtn.style.display = 'none';
        }

        // Manual price refresh. Prices come out of a 15-minute cache, so the
        // profit/hr numbers on every tile can be up to that stale; the only way
        // to freshen them used to be opening the marketplace once per item.
        // This pulls the whole feed once and re-renders every tile on the page.
        const refreshBtn = document.createElement('button');
        refreshBtn.id = 'mwi-action-price-refresh';
        refreshBtn.textContent = 'Refresh Prices';
        refreshBtn.title = 'Fetch fresh market prices now and update the profit/hr figures on every action here';
        refreshBtn.style.cssText = `
            padding: 8px 12px;
            font-size: 14px;
            border: 1px solid rgba(255, 255, 255, 0.23);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            font-family: inherit;
            flex-shrink: 0;
        `;
        refreshBtn.addEventListener('click', async () => {
            await this.refreshPrices();
        });
        if (controlsHost) {
            controlsHost.appendChild(refreshBtn);
        } else {
            craftBtn.insertAdjacentElement('afterend', refreshBtn);
        }
        this.refreshButton = refreshBtn;

        // Only useful where profit/hr is actually drawn — no separate setting.
        if (!this._profitPerHourVisible()) {
            refreshBtn.style.display = 'none';
        }

        // Find the container for action panels to inject "No results" message
        this.setupNoResultsMessage(titleElement);
    }

    /**
     * Whether profit/hr is shown on any action tile, gathering or production.
     * The refresh button only appears when there is something for it to update.
     * @returns {boolean} True if either profit/hr display setting is enabled
     */
    _profitPerHourVisible() {
        return (
            config.getSetting('actionPanel_showProfitPerHour_gathering') ||
            config.getSetting('actionPanel_showProfitPerHour_production')
        );
    }

    /**
     * Show or hide the mobile controls row and reflect the state on the toggle
     * button. UI only — callers that mean to persist the change also write
     * `CONTROLS_EXPANDED_KEY` (the toggle's click handler does; the storage
     * read-back in `injectFilterInput` deliberately does not, since applying a
     * value just read from storage is not a new preference to save).
     * @param {boolean} expanded - Whether the row should be visible
     */
    _applyControlsExpanded(expanded) {
        this._controlsExpanded = expanded;
        if (this.controlsWrapper) {
            this.controlsWrapper.style.display = expanded ? 'flex' : 'none';
        }
        if (this.controlsToggle) {
            this.controlsToggle.setAttribute('aria-expanded', String(expanded));
            this.controlsToggle.style.borderColor = expanded ? config.COLOR_ACCENT : 'rgba(255, 255, 255, 0.23)';
            this.controlsToggle.style.color = expanded ? config.COLOR_ACCENT : 'inherit';
        }
    }

    /**
     * Force a fresh marketplace pull and re-render every profit section on the
     * page. User-initiated only — this deliberately bypasses the price cache and
     * adds no automatic polling of its own.
     * @returns {Promise<boolean>} True if the prices were refreshed
     */
    async refreshPrices() {
        // A second click while the first fetch is still running is a no-op. The
        // button is disabled too, but tests and stray programmatic clicks are not.
        if (this._priceRefreshInFlight) return false;
        this._priceRefreshInFlight = true;

        const btn = this.refreshButton;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Refreshing...';
            btn.style.opacity = '0.6';
            btn.style.cursor = 'default';
        }

        let ok = false;
        try {
            await marketAPI.fetch(true);
            await this._refreshProfitDisplays();
            ok = true;
        } catch (error) {
            console.error('[ActionFilter] Failed to refresh market prices:', error);
        } finally {
            this._priceRefreshInFlight = false;
            // Re-read the reference: the page may have been torn down mid-fetch,
            // in which case clearFilter() already dropped the button.
            const current = this.refreshButton;
            if (current) {
                current.disabled = false;
                current.textContent = ok ? 'Refresh Prices' : 'Refresh Failed';
                current.style.opacity = '1';
                current.style.cursor = 'pointer';
            }
        }

        return ok;
    }

    /**
     * Set up "No matching actions" message container
     * @param {HTMLElement} titleElement - The h1 title element
     */
    setupNoResultsMessage(titleElement) {
        // Walk up the DOM to find the skill panel container
        let container = titleElement.parentElement;
        let depth = 0;
        const maxDepth = 3;

        while (container && depth < maxDepth) {
            // Look for the container that holds action panels
            const actionPanels = container.querySelectorAll('.SkillActionDetail_regularComponent__3oCgr');
            if (actionPanels.length > 0) {
                // Found the container, create message element
                const message = document.createElement('div');
                message.id = 'mwi-action-filter-no-results';
                message.style.display = 'none';
                message.style.textAlign = 'center';
                message.style.padding = '40px 20px';
                message.style.color = 'rgba(255, 255, 255, 0.6)';
                message.style.fontSize = '16px';
                message.textContent = 'No matching actions';

                // Insert after the title
                titleElement.parentElement.insertBefore(message, titleElement.nextSibling);
                this.noResultsMessage = message;
                break;
            }

            container = container.parentElement;
            depth++;
        }
    }

    /**
     * Handle filter input with debouncing
     * @param {string} value - Filter text
     */
    handleFilterInput(value) {
        // Clear existing timeout
        if (this.filterTimeout) {
            clearTimeout(this.filterTimeout);
        }

        // Schedule filter update after 300ms of inactivity
        this.filterTimeout = setTimeout(() => {
            this.filterValue = value.toLowerCase().trim();
            this.applyFilter();
            this.filterTimeout = null;
        }, 300);

        this.timerRegistry.registerTimeout(this.filterTimeout);
    }

    /**
     * Register a panel for filtering
     * @param {HTMLElement} actionPanel - The action panel element
     * @param {string} actionName - The action/item name
     */
    registerPanel(actionPanel, actionName) {
        // The tile class this registers from (SkillAction_skillAction__.../panel-observer.js) is
        // generic and reused outside filterable skill pages (e.g. Combat Zones). If the title bar
        // we attached the filter to has since been removed from the DOM without a new filterable
        // title appearing to replace it (i.e. we navigated to a non-filterable page), the tracked
        // filterValue is stale and must not be applied to whatever tile is registering now.
        if (this.currentTitleElement && !this.currentTitleElement.isConnected) {
            this.clearFilter();
            this.currentTitleElement = null;
        }

        // Store the container for later "no results" check
        const container = actionPanel.parentElement;

        this.panels.set(actionPanel, {
            actionName: actionName.toLowerCase(),
            container: container,
        });

        // Apply current filter if one is active
        if (this.filterValue) {
            this.applyFilterToPanel(actionPanel);
            if (actionPanel.dataset.mwiFilterHidden === 'true') {
                actionPanel.style.display = 'none';
            }
        }
    }

    /**
     * Unregister a panel (cleanup when panel removed from DOM)
     * @param {HTMLElement} actionPanel - The action panel element
     */
    unregisterPanel(actionPanel) {
        this.panels.delete(actionPanel);
    }

    /**
     * Apply filter to a specific panel
     * @param {HTMLElement} actionPanel - The action panel element
     */
    applyFilterToPanel(actionPanel) {
        const data = this.panels.get(actionPanel);
        if (!data) return;

        // If no filter, show the panel
        if (!this.filterValue) {
            actionPanel.dataset.mwiFilterHidden = 'false';
            return;
        }

        // Check if action name matches filter
        const matches = data.actionName.includes(this.filterValue);
        actionPanel.dataset.mwiFilterHidden = matches ? 'false' : 'true';
    }

    /**
     * Apply filter to all registered panels
     */
    applyFilter() {
        let totalPanels = 0;
        let visiblePanels = 0;
        const containerMap = new Map(); // Track panels per container

        // Apply filter to each panel
        for (const [actionPanel, data] of this.panels.entries()) {
            // Clean up detached panels
            if (!actionPanel.parentElement) {
                this.panels.delete(actionPanel);
                continue;
            }

            totalPanels++;

            // Track container
            if (!containerMap.has(data.container)) {
                containerMap.set(data.container, { total: 0, visible: 0 });
            }
            const containerStats = containerMap.get(data.container);
            containerStats.total++;

            // Apply filter
            this.applyFilterToPanel(actionPanel);

            // Check if panel should be visible
            const isFilterHidden = actionPanel.dataset.mwiFilterHidden === 'true';

            if (!isFilterHidden) {
                visiblePanels++;
                containerStats.visible++;
            }

            // Apply display directly — don't rely on other features to read the data attribute
            if (isFilterHidden) {
                actionPanel.style.display = 'none';
            } else if (actionPanel.style.display === 'none') {
                actionPanel.style.display = '';
            }
        }

        // Show/hide "No matching actions" message
        if (this.noResultsMessage) {
            if (this.filterValue && visiblePanels === 0 && totalPanels > 0) {
                this.noResultsMessage.style.display = 'block';
            } else {
                this.noResultsMessage.style.display = 'none';
            }
        }
    }

    /**
     * Check if a panel is hidden by the filter
     * @param {HTMLElement} actionPanel - The action panel element
     * @returns {boolean} True if panel is hidden by filter
     */
    isFilterHidden(actionPanel) {
        return actionPanel.dataset.mwiFilterHidden === 'true';
    }

    /**
     * Clear filter and reset state
     */
    clearFilter() {
        // Clear input value
        if (this.filterInput) {
            this.filterInput.value = '';
        }

        // Reset filter value
        this.filterValue = '';

        // Reset filter attributes on still-attached panels; purge detached ones
        for (const [actionPanel] of this.panels.entries()) {
            if (!actionPanel.parentElement) {
                this.panels.delete(actionPanel);
            } else {
                actionPanel.dataset.mwiFilterHidden = 'false';
            }
        }

        // Hide "No results" message
        if (this.noResultsMessage) {
            this.noResultsMessage.style.display = 'none';
        }

        // Remove injected input
        if (this.filterInput && this.filterInput.parentElement) {
            this.filterInput.remove();
            this.filterInput = null;
        }

        if (this.sortButton && this.sortButton.parentElement) {
            this.sortButton.remove();
            this.sortButton = null;
        }

        if (this.modeButton && this.modeButton.parentElement) {
            this.modeButton.remove();
            this.modeButton = null;
        }

        if (this.craftButton && this.craftButton.parentElement) {
            this.craftButton.remove();
            this.craftButton = null;
        }

        if (this.refreshButton && this.refreshButton.parentElement) {
            this.refreshButton.remove();
            this.refreshButton = null;
        }

        // Mobile-only wrapper/toggle (see injectFilterInput) — no-op on desktop,
        // where these are never created.
        if (this.controlsWrapper && this.controlsWrapper.parentElement) {
            this.controlsWrapper.remove();
        }
        this.controlsWrapper = null;

        if (this.controlsToggle && this.controlsToggle.parentElement) {
            this.controlsToggle.remove();
        }
        this.controlsToggle = null;
        this._controlsExpanded = false;

        this._updateModeBtn = null;
        this._updateCraftBtn = null;
        this._updateSortBtn = null;

        if (this.noResultsMessage && this.noResultsMessage.parentElement) {
            this.noResultsMessage.remove();
            this.noResultsMessage = null;
        }
    }

    /**
     * Get the current skill name from the tracked title element
     * @returns {string|null} Skill name (e.g., "Foraging", "Woodcutting", "Cooking") or null
     */
    getCurrentSkillName() {
        if (!this.currentTitleElement) {
            return null;
        }

        // The title element contains multiple children:
        // - Our injected filter input
        // - In mobile mode, the collapsible controls wrapper (also a <div>,
        //   and never the skill name — skipped by id like the input)
        // - A div with the skill name text
        // Find the div that contains the skill name (not ours)
        for (const child of this.currentTitleElement.children) {
            if (child.id === 'mwi-action-filter' || child.id === 'mwi-action-controls') continue;
            if (child.tagName === 'DIV' && child.textContent) {
                return child.textContent.trim();
            }
        }

        // Fallback: try to get text content minus input value
        const text = this.currentTitleElement.textContent.trim();
        if (this.filterInput && this.filterInput.value) {
            return text.replace(this.filterInput.value, '').trim();
        }

        return text || null;
    }

    /**
     * Re-render all visible profit sections using the current pricing mode.
     * Called after the mode button changes profitCalc_pricingMode.
     */
    async _refreshProfitDisplays() {
        const DROP_TABLE_SELECTOR = 'div.SkillActionDetail_dropTable__3ViVp';

        // Snapshot before any re-rendering removes/replaces sections
        const toRefresh = [];
        document.querySelectorAll('[data-mwi-action-hrid]').forEach((section) => {
            const panel = section.closest('div.SkillActionDetail_regularComponent__3oCgr');
            const actionHrid = section.dataset.mwiActionHrid;
            const actionType = section.dataset.mwiActionType;
            if (panel && actionHrid && actionType) {
                toRefresh.push({ panel, actionHrid, actionType });
            }
        });

        for (const { panel, actionHrid, actionType } of toRefresh) {
            if (!document.body.contains(panel)) continue;
            if (actionType === 'gathering') {
                await displayGatheringProfit(panel, actionHrid, DROP_TABLE_SELECTOR);
            } else if (actionType === 'production') {
                await displayProductionProfit(panel, actionHrid, DROP_TABLE_SELECTOR);
            }
        }
    }

    /**
     * Cleanup function for disabling filter
     */
    cleanup() {
        // Clear timeout
        if (this.filterTimeout) {
            clearTimeout(this.filterTimeout);
            this.filterTimeout = null;
        }

        this.timerRegistry.clearAll();

        // Unregister observers
        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];

        // Clear filter
        this.clearFilter();
        this.panels.clear();

        this.initialized = false;
    }
}

const actionFilter = new ActionFilter();

export default actionFilter;
