/**
 * Gathering Stats Display Module
 *
 * Shows profit/hr and exp/hr on gathering action tiles
 * (foraging, woodcutting, milking)
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import actionPanelSort from './action-panel-sort.js';
import actionFilter from './action-filter.js';
import { calculateGatheringProfit } from './gathering-profit.js';
import { formatKMB } from '../../utils/formatters.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';
import { onActionTile, resolveActionTile } from '../../utils/action-panel-helper.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

class GatheringStats {
    constructor() {
        this.actionElements = new Map(); // actionPanel → {actionHrid, displayElement}
        this.unregisterObserver = null;
        this.itemsUpdatedHandler = null;
        this.actionCompletedHandler = null;
        this.consumablesUpdatedHandler = null; // Handler for tea/drink changes
        this.characterSwitchingHandler = null; // Handler for character switch cleanup
        this.pricingModeHandler = null; // Handler for pricing mode changes
        this.profitPerHourSettingHandler = null; // Handler for the profit/hr display toggle
        this.expPerHourSettingHandler = null; // Handler for the exp/hr display toggle
        this.isInitialized = false;
        this.itemsUpdatedDebounceTimer = null; // Debounce timer for items_updated events
        this.consumablesUpdatedDebounceTimer = null; // Debounce timer for consumables_updated events
        this.indicatorUpdateDebounceTimer = null; // Debounce timer for indicator rendering
        this.DEBOUNCE_DELAY = 300; // 300ms debounce for event handlers
        this.resizeObserver = null;
    }

    /**
     * Initialize the gathering stats display
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (
            !config.getSetting('actionPanel_showProfitPerHour_gathering') &&
            !config.getSetting('actionPanel_showExpPerHour_gathering')
        ) {
            return;
        }

        this.isInitialized = true;

        // Initialize shared sort manager.
        //
        // `isInitialized` is set *before* this await (which reads the pins and
        // sort mode out of IndexedDB), so a `character_switching` teardown
        // landing inside it never made the re-initialise early-return. The
        // resumed tail instead ran on top of a `disable()` that had already
        // nulled the handler fields and dropped the tile observer, and re-stored
        // its own into them — leaving the previous `items_updated`,
        // `consumables_updated`, `character_switching` and setting listeners and
        // the previous `onActionTile` observer live with no handle left to
        // unregister them. One leak per switch, each one a full profit/exp
        // recompute and a DOM pass over every visible tile on every inventory
        // change.
        const ticket = captureOwner(this);
        await actionPanelSort.initialize();
        // Guards the whole resumed tail — the observer and every listener below.
        if (!stillOurs(ticket)) return;

        this.setupObserver();

        // Store handler references for cleanup with debouncing
        this.itemsUpdatedHandler = () => {
            clearTimeout(this.itemsUpdatedDebounceTimer);
            this.itemsUpdatedDebounceTimer = setTimeout(() => {
                this.updateAllStats();
            }, this.DEBOUNCE_DELAY);
        };
        this.consumablesUpdatedHandler = () => {
            clearTimeout(this.consumablesUpdatedDebounceTimer);
            this.consumablesUpdatedDebounceTimer = setTimeout(() => {
                this.updateAllStats();
            }, this.DEBOUNCE_DELAY);
        };

        this.characterSwitchingHandler = () => {
            this.clearAllReferences();
        };

        // Event-driven updates (no polling needed)
        dataManager.on('items_updated', this.itemsUpdatedHandler);
        dataManager.on('consumables_updated', this.consumablesUpdatedHandler);
        dataManager.on('character_switching', this.characterSwitchingHandler);

        this.pricingModeHandler = () => {
            this.updateAllStats();
        };
        config.onSettingChange('profitCalc_pricingMode', this.pricingModeHandler);

        this.profitPerHourSettingHandler = () => this.updateAllStats();
        this.expPerHourSettingHandler = () => this.updateAllStats();
        config.onSettingChange('actionPanel_showProfitPerHour_gathering', this.profitPerHourSettingHandler);
        config.onSettingChange('actionPanel_showExpPerHour_gathering', this.expPerHourSettingHandler);
    }

    /**
     * Setup DOM observer to watch for action panels
     */
    setupObserver() {
        // Watch for skill action panels (in skill screen, not detail modal)
        this.unregisterObserver = onActionTile((context) => {
            this.injectGatheringStats(context.panel, context);
        });

        // Check for existing action panels that may already be open
        const existingPanels = document.querySelectorAll('[class*="SkillAction_skillAction"]');
        existingPanels.forEach((panel) => {
            this.injectGatheringStats(panel);
        });
    }

    /**
     * Inject gathering stats display into an action panel
     * @param {HTMLElement} actionPanel - The action panel element
     * @param {import('../../utils/action-panel-helper.js').ActionPanelContext} [context] - The tile's
     *   resolved action, when the dispatcher supplies it; resolved here otherwise
     */
    injectGatheringStats(actionPanel, context = resolveActionTile(actionPanel)) {
        const { actionHrid, actionDetails } = context;

        if (!actionHrid) {
            return;
        }

        // Only show for gathering actions (no inputItems)
        const gatheringTypes = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];
        if (!actionDetails || !gatheringTypes.includes(actionDetails.type)) {
            return;
        }

        // Check if already injected
        const existingDisplay = actionPanel.querySelector('.mwi-gathering-stats');
        if (existingDisplay) {
            // If the panel is already registered in our Map, it's being re-added by a
            // sort reorder (DocumentFragment move) — not genuine navigation. Skip
            // updateStats and triggerSort to avoid the sort→observer→triggerSort loop.
            if (this.actionElements.has(actionPanel)) {
                return;
            }

            // Re-register existing display (DOM elements may be reused across navigation).
            // Use skipRender so we don't wipe innerHTML (which would erase the emoji
            // set by addBestActionIndicators and cause a visible blink).
            this.actionElements.set(actionPanel, {
                actionHrid: actionHrid,
                displayElement: existingDisplay,
            });
            (async () => {
                try {
                    await this.updateStats(actionPanel, { skipRender: true });
                    this.scheduleIndicatorUpdate();
                } catch (error) {
                    console.error('[GatheringStats] Failed to update stats:', error);
                }
            })();
            // Register with shared sort manager
            actionPanelSort.registerPanel(actionPanel, actionHrid);
            if (existingDisplay) {
                this.scheduleStatsLayoutSync(actionPanel, existingDisplay);
                this.getResizeObserver().observe(existingDisplay);
            }
            // Trigger sort
            actionPanelSort.triggerSort();
            return;
        }

        // Create display element
        const display = document.createElement('div');
        display.className = 'mwi-gathering-stats';
        display.style.cssText = `
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            font-size: 11px;
            padding: 4px 8px;
            text-align: center;
            background: rgba(0, 0, 0, 0.7);
            border-top: 1px solid var(--border-color, ${config.COLOR_BORDER});
            z-index: 10;
            line-height: 1.3;
            overflow: hidden;
        `;

        // Make sure the action panel has relative positioning and extra bottom margin
        if (actionPanel.style.position !== 'relative' && actionPanel.style.position !== 'absolute') {
            actionPanel.style.position = 'relative';
        }
        actionPanel.style.alignSelf = 'flex-start';
        actionPanel.style.overflow = 'visible';

        // Append directly to action panel with absolute positioning
        actionPanel.appendChild(display);

        this.scheduleStatsLayoutSync(actionPanel, display);
        this.getResizeObserver().observe(display);

        // Store reference
        this.actionElements.set(actionPanel, {
            actionHrid: actionHrid,
            displayElement: display,
        });

        // Register with shared sort manager
        actionPanelSort.registerPanel(actionPanel, actionHrid);

        (async () => {
            try {
                await this.updateStats(actionPanel);
                this.scheduleIndicatorUpdate();
            } catch (error) {
                console.error('[GatheringStats] Failed to update stats:', error);
            }
        })();

        // Trigger sort
        actionPanelSort.triggerSort();
    }

    /**
     * Update stats display for a single action panel
     * @param {HTMLElement} actionPanel - The action panel element
     * @param {Object} [options] - Optional flags
     * @param {boolean} [options.skipRender=false] - Skip DOM rendering
     */
    async updateStats(actionPanel, options = {}) {
        const data = this.actionElements.get(actionPanel);

        if (!data) {
            return;
        }

        const { skipRender = false } = options;

        // Calculate profit/hr
        const profitData = await calculateGatheringProfit(data.actionHrid);
        const profitPerHour = profitData?.profitPerHour || null;
        const hasMissingPrices = profitData?.hasMissingPrices || false;

        // Calculate exp/hr using shared utility
        const expData = calculateExpPerHour(data.actionHrid);
        const expPerHour = expData?.expPerHour || null;

        // Store profit value for sorting and update shared sort manager
        data.profitPerHour = profitPerHour;
        data.expPerHour = expPerHour;
        data.hasMissingPrices = hasMissingPrices;
        actionPanelSort.updateProfit(actionPanel, profitPerHour);
        actionPanelSort.updateExpPerHour(actionPanel, expPerHour);

        // Check if we should hide actions with negative profit (unless pinned)
        const hideNegativeProfit = config.getSetting('actionPanel_hideNegativeProfit');
        const isPinned = actionPanelSort.isPinned(data.actionHrid);
        const isFilterHidden = actionFilter.isFilterHidden(actionPanel);

        if (hideNegativeProfit && profitPerHour !== null && profitPerHour < 0 && !isPinned) {
            // Hide the entire action panel
            actionPanel.style.display = 'none';
            return;
        } else if (isFilterHidden) {
            // Hide the panel if filter doesn't match
            actionPanel.style.display = 'none';
            return;
        } else {
            // Show the action panel (in case it was previously hidden)
            actionPanel.style.display = '';
        }

        if (skipRender) {
            return;
        }

        this.renderIndicators(actionPanel, data);
    }

    /**
     * Update all stats
     */
    async updateAllStats() {
        // Clean up stale references and update valid ones
        const updatePromises = [];
        for (const actionPanel of [...this.actionElements.keys()]) {
            if (document.body.contains(actionPanel)) {
                // skipRender: bulk updates go through addBestActionIndicators
                // which updates spans in-place — avoids double render + flash.
                updatePromises.push(this.updateStats(actionPanel, { skipRender: true }));
            } else {
                // Panel no longer in DOM - remove injected elements BEFORE deleting from Map
                const data = this.actionElements.get(actionPanel);
                if (data && data.displayElement) {
                    data.displayElement.innerHTML = ''; // Clear innerHTML to break references
                    data.displayElement.remove();
                    data.displayElement = null; // Null out reference for GC
                }
                this.actionElements.delete(actionPanel);
                actionPanelSort.unregisterPanel(actionPanel);
            }
        }

        // Wait for all updates to complete
        await Promise.all(updatePromises);

        // Re-render the stat text on each panel (skipRender only updated data, not DOM)
        for (const [actionPanel, data] of this.actionElements.entries()) {
            if (document.body.contains(actionPanel) && data.displayElement) {
                this.renderIndicators(actionPanel, data);
            }
        }

        // Find best actions and add indicators
        this.scheduleIndicatorUpdate();

        // Trigger sort via shared manager
        actionPanelSort.triggerSort();

        this.syncAllStatsLayouts();
    }

    /**
     * Debounce indicator rendering to batch panel updates
     */
    scheduleIndicatorUpdate() {
        clearTimeout(this.indicatorUpdateDebounceTimer);
        this.indicatorUpdateDebounceTimer = setTimeout(() => {
            this.addBestActionIndicators();
        }, this.DEBOUNCE_DELAY);
    }

    /**
     * Find best actions and add visual indicators
     */
    addBestActionIndicators() {
        let bestProfit = null;
        let bestProfitExp = null;
        let bestProfitHrid = null;
        let bestExp = null;
        let bestOverall = null;
        let bestProfitPanels = [];
        let bestExpPanels = [];
        let bestOverallPanels = [];

        // First pass: find the best values
        for (const [actionPanel, data] of this.actionElements.entries()) {
            if (!document.body.contains(actionPanel) || !data.displayElement) {
                continue;
            }

            const { profitPerHour, expPerHour, hasMissingPrices } = data;

            // Skip actions with missing prices for profit comparison
            if (!hasMissingPrices && profitPerHour !== null) {
                if (bestProfit === null || profitPerHour > bestProfit) {
                    bestProfit = profitPerHour;
                    bestProfitExp = expPerHour;
                    bestProfitHrid = data.actionHrid;
                    bestProfitPanels = [actionPanel];
                } else if (profitPerHour === bestProfit) {
                    bestProfitPanels.push(actionPanel);
                }
            }

            // Find best exp/hr
            if (expPerHour !== null && expPerHour > 0) {
                if (bestExp === null || expPerHour > bestExp) {
                    bestExp = expPerHour;
                    bestExpPanels = [actionPanel];
                } else if (expPerHour === bestExp) {
                    bestExpPanels.push(actionPanel);
                }
            }
        }

        // Second pass: compute gold-neutral effective XP/hr and find best overall
        for (const [actionPanel, data] of this.actionElements.entries()) {
            if (!document.body.contains(actionPanel) || !data.displayElement) {
                continue;
            }

            const { profitPerHour, expPerHour, hasMissingPrices } = data;
            if (hasMissingPrices || profitPerHour === null || expPerHour === null || expPerHour <= 0) {
                continue;
            }

            let effectiveXp;
            if (profitPerHour >= 0) {
                effectiveXp = expPerHour;
            } else if (bestProfit > 0) {
                const loss = Math.abs(profitPerHour);
                const recoveryRatio = loss / bestProfit;
                effectiveXp = (expPerHour + recoveryRatio * (bestProfitExp || 0)) / (1 + recoveryRatio);
            } else {
                continue;
            }

            data.effectiveXpPerHour = effectiveXp;

            if (bestOverall === null || effectiveXp > bestOverall) {
                bestOverall = effectiveXp;
                bestOverallPanels = [actionPanel];
            } else if (effectiveXp === bestOverall) {
                bestOverallPanels.push(actionPanel);
            }
        }

        // Third pass: update emoji indicators and effective XP display in-place.
        // Avoids rewriting innerHTML (which would cause a flash + re-size).
        const EMOJIS = [' 💰', ' 🧠', ' 🏆'];
        const stripEmoji = (text) => {
            let t = text;
            for (const e of EMOJIS) t = t.replace(e, '');
            return t;
        };

        const bestProfitName = bestProfitHrid
            ? dataManager.getActionDetails(bestProfitHrid)?.name || bestProfitHrid
            : null;

        for (const [actionPanel, data] of this.actionElements.entries()) {
            if (!document.body.contains(actionPanel) || !data.displayElement) {
                continue;
            }

            const isBestProfit = bestProfitPanels.includes(actionPanel);
            const isBestExp = bestExpPanels.includes(actionPanel);
            const isBestOverall = bestOverallPanels.includes(actionPanel);

            const profitSpan = data.displayElement.querySelector('[data-stat="profit"]');
            if (profitSpan) {
                profitSpan.textContent = stripEmoji(profitSpan.textContent) + (isBestProfit ? ' 💰' : '');
            }

            const expSpan = data.displayElement.querySelector('[data-stat="exp"]');
            if (expSpan) {
                expSpan.textContent = stripEmoji(expSpan.textContent) + (isBestExp ? ' 🧠' : '');
            }

            const overallSpan = data.displayElement.querySelector('[data-stat="overall"]');
            if (overallSpan) {
                const effXp = data.effectiveXpPerHour;
                const label = effXp != null ? `Eff. XP/hr: ${formatKMB(effXp)}` : stripEmoji(overallSpan.textContent);
                overallSpan.textContent = label + (isBestOverall ? ' 🏆' : '');

                if (data.profitPerHour < 0 && bestProfit > 0 && effXp != null) {
                    const loss = Math.abs(data.profitPerHour);
                    const ratio = loss / bestProfit;
                    overallSpan.title =
                        `Gold-neutral XP rate\n` +
                        `This action: ${formatKMB(data.expPerHour)} XP/hr, -${formatKMB(loss)}/hr\n` +
                        `Recovery: ${bestProfitName} (+${formatKMB(bestProfit)}/hr, ${formatKMB(bestProfitExp || 0)} XP/hr)\n` +
                        `Ratio: ${ratio.toFixed(2)}hr recovery per 1hr action\n` +
                        `Blended: (${formatKMB(data.expPerHour)} + ${ratio.toFixed(2)} × ${formatKMB(bestProfitExp || 0)}) / ${(1 + ratio).toFixed(2)} = ${formatKMB(effXp)}`;
                } else {
                    overallSpan.title = '';
                }
            }

            // Re-fit font sizes now that emoji may have changed span widths.
            this.fitLineFontSizes(actionPanel, data.displayElement);
        }
    }

    /**
     * Render stat lines into the display element and size them to fit.
     * @param {HTMLElement} actionPanel - Action panel container
     * @param {Object} data - Stored action data
     */
    renderIndicators(actionPanel, data) {
        const { profitPerHour, expPerHour } = data;
        const showProfit = config.getSetting('actionPanel_showProfitPerHour_gathering');
        const showExp = config.getSetting('actionPanel_showExpPerHour_gathering');
        let html = '';

        if (showProfit && profitPerHour !== null) {
            const profitColor = profitPerHour >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS;
            const profitSign = profitPerHour >= 0 ? '' : '-';
            html += `<div class="mwi-action-stat-line" style="white-space: nowrap;">`;
            html += `<span data-stat="profit" style="color: ${profitColor};">Profit/hr: ${profitSign}${formatKMB(Math.abs(profitPerHour))}</span></div>`;
        }

        if (showExp && expPerHour !== null && expPerHour > 0) {
            html += `<div class="mwi-action-stat-line" style="white-space: nowrap;">`;
            html += `<span data-stat="exp" style="color: #fff;">Exp/hr: ${formatKMB(expPerHour)}</span></div>`;
        }

        if (showProfit && showExp && profitPerHour !== null && expPerHour !== null && expPerHour > 0) {
            html += `<div class="mwi-action-stat-line" style="white-space: nowrap;">`;
            html += `<span data-stat="overall" style="color: #fff;">Eff. XP/hr: ${formatKMB(expPerHour)}</span></div>`;
        }

        data.displayElement.innerHTML = html;
        if (!html) {
            data.displayElement.style.display = 'none';
            this.syncStatsLayout(actionPanel, data.displayElement);
            return;
        }
        data.displayElement.style.display = 'block';
        data.displayElement.style.visibility = 'hidden';
        this.fitLineFontSizes(actionPanel, data.displayElement);
    }

    /**
     * Fit each stat line to the action panel width
     * @param {HTMLElement} actionPanel - Action panel container
     * @param {HTMLElement} displayElement - Stats container
     */
    fitLineFontSizes(actionPanel, displayElement, retries = 4) {
        requestAnimationFrame(() => {
            const panelWidth = actionPanel.getBoundingClientRect().width;
            const fallbackWidth = displayElement.getBoundingClientRect().width;
            const rawWidth = panelWidth || fallbackWidth;
            const availableWidth = Math.max(0, rawWidth - 16);
            if (!availableWidth) {
                if (retries > 0) {
                    setTimeout(() => this.fitLineFontSizes(actionPanel, displayElement, retries - 1), 60);
                } else {
                    // Out of retries — reveal anyway so it's never permanently hidden.
                    displayElement.style.visibility = '';
                }
                return;
            }

            const baseFontSize = 11;
            const minFontSize = 5;
            const lines = displayElement.querySelectorAll('.mwi-action-stat-line');

            lines.forEach((line) => {
                const textSpan = line.querySelector('span');
                if (!textSpan) {
                    return;
                }

                textSpan.style.setProperty('display', 'inline-block');
                textSpan.style.setProperty('transform-origin', 'left center');
                textSpan.style.setProperty('transform', 'scaleX(1)');

                let fontSize = baseFontSize;
                textSpan.style.setProperty('font-size', `${fontSize}px`, 'important');
                let textWidth = textSpan.getBoundingClientRect().width;
                let iterations = 0;

                while (textWidth > availableWidth && fontSize > minFontSize && iterations < 20) {
                    fontSize -= 1;
                    textSpan.style.setProperty('font-size', `${fontSize}px`, 'important');
                    textWidth = textSpan.getBoundingClientRect().width;
                    iterations += 1;
                }

                if (textWidth > availableWidth) {
                    const scaleX = Math.max(0.6, availableWidth / textWidth);
                    textSpan.style.setProperty('transform', `scaleX(${scaleX})`);
                }
            });

            // Reveal now that sizing is complete.
            displayElement.style.visibility = '';

            this.syncStatsLayout(actionPanel, displayElement);
            this.scheduleStatsLayoutSync(actionPanel, displayElement);
        });
    }

    getResizeObserver() {
        if (!this.resizeObserver) {
            this.resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const displayElement = entry.target;
                    const actionPanel = displayElement.parentElement;
                    if (actionPanel) {
                        this.syncStatsLayout(actionPanel, displayElement);
                        this.scheduleStatsLayoutSync(actionPanel, displayElement);
                    }
                }
            });
        }
        return this.resizeObserver;
    }

    syncStatsLayout(actionPanel, displayElement) {
        if (!actionPanel || !displayElement) return;
        if (!document.body.contains(actionPanel) || !document.body.contains(displayElement)) return;

        actionPanel.style.alignSelf = 'flex-start';
        actionPanel.style.overflow = 'visible';

        if (actionPanel.style.position !== 'relative' && actionPanel.style.position !== 'absolute') {
            actionPanel.style.position = 'relative';
        }

        if (displayElement.style.display === 'none') {
            actionPanel.style.marginBottom = '';
            return;
        }

        const height = Math.ceil(displayElement.getBoundingClientRect().height || displayElement.offsetHeight || 0);

        if (height > 0) {
            actionPanel.style.marginBottom = `${height}px`;
        }
    }

    scheduleStatsLayoutSync(actionPanel, displayElement) {
        requestAnimationFrame(() => {
            this.syncStatsLayout(actionPanel, displayElement);
            requestAnimationFrame(() => {
                this.syncStatsLayout(actionPanel, displayElement);
            });
        });
    }

    syncAllStatsLayouts() {
        for (const [actionPanel, data] of this.actionElements.entries()) {
            if (!document.body.contains(actionPanel) || !data.displayElement) continue;
            this.scheduleStatsLayoutSync(actionPanel, data.displayElement);
        }
    }

    /**
     * Clear all DOM references to prevent memory leaks during character switch
     */
    clearAllReferences() {
        clearTimeout(this.indicatorUpdateDebounceTimer);
        this.indicatorUpdateDebounceTimer = null;

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // CRITICAL: Remove injected DOM elements BEFORE clearing Maps
        // This prevents detached SVG elements from accumulating
        // Note: .remove() is safe to call even if element is already detached
        for (const [actionPanel, data] of this.actionElements.entries()) {
            if (data.displayElement) {
                data.displayElement.innerHTML = ''; // Clear innerHTML to break event listener references
                data.displayElement.remove();
                data.displayElement = null; // Null out reference for GC
            }
            actionPanel.style.marginBottom = '';
            actionPanel.style.overflow = '';
        }

        // Clear all action element references (prevents detached DOM memory leak)
        this.actionElements.clear();

        // Clear shared sort manager's panel references
        actionPanelSort.clearAllPanels();
    }

    /**
     * Disable the gathering stats display
     */
    disable() {
        noteTeardown(this);
        try {
            // Clear debounce timers
            clearTimeout(this.itemsUpdatedDebounceTimer);
            clearTimeout(this.actionCompletedDebounceTimer);
            clearTimeout(this.consumablesUpdatedDebounceTimer);
            clearTimeout(this.indicatorUpdateDebounceTimer);
            this.itemsUpdatedDebounceTimer = null;
            this.actionCompletedDebounceTimer = null;
            this.consumablesUpdatedDebounceTimer = null;
            this.indicatorUpdateDebounceTimer = null;

            if (this.itemsUpdatedHandler) {
                dataManager.off('items_updated', this.itemsUpdatedHandler);
                this.itemsUpdatedHandler = null;
            }

            if (this.consumablesUpdatedHandler) {
                dataManager.off('consumables_updated', this.consumablesUpdatedHandler);
                this.consumablesUpdatedHandler = null;
            }
            if (this.characterSwitchingHandler) {
                dataManager.off('character_switching', this.characterSwitchingHandler);
                this.characterSwitchingHandler = null;
            }

            if (this.pricingModeHandler) {
                config.offSettingChange('profitCalc_pricingMode', this.pricingModeHandler);
                this.pricingModeHandler = null;
            }

            if (this.profitPerHourSettingHandler) {
                config.offSettingChange('actionPanel_showProfitPerHour_gathering', this.profitPerHourSettingHandler);
                this.profitPerHourSettingHandler = null;
            }

            if (this.expPerHourSettingHandler) {
                config.offSettingChange('actionPanel_showExpPerHour_gathering', this.expPerHourSettingHandler);
                this.expPerHourSettingHandler = null;
            }

            // Clear all DOM references
            this.clearAllReferences();

            // Remove DOM observer
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            // Remove all injected elements
            document.querySelectorAll('.mwi-gathering-stats').forEach((el) => el.remove());
            this.actionElements.clear();

            this.isInitialized = false;
        } catch (error) {
            console.error('[Gathering Stats] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const gatheringStats = new GatheringStats();

export default gatheringStats;
