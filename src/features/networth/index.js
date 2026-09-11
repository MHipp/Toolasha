/**
 * Networth Feature - Main Coordinator
 * Manages networth calculation and display updates
 */

import config from '../../core/config.js';
import performanceMonitor from '../../utils/performance-monitor.js';
import { runInBackground } from '../../utils/background-work.js';
import connectionState from '../../core/connection-state.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { calculateNetworth } from './networth-calculator.js';
import { networthHeaderDisplay, networthInventoryDisplay } from './networth-display.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createPauseRegistry } from '../../utils/pause-registry.js';
import networthCache from './networth-cache.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import networthHistory from './networth-history.js';
import networthHistoryChart from './networth-history-chart.js';
import productionIncomeRecorder from './production-income-recorder.js';
import chestOpeningRecorder from './chest-opening-recorder.js';
import combatLootRecorder from './combat-loot-recorder.js';
import goldSourcesPanel from './gold-sources-panel.js';
import { initExclusions } from './networth-exclusions.js';
import networthExclusionPopup from './networth-exclusion-popup.js';
import { terminateItemValueWorkerPool } from '../../utils/networth-worker-manager.js';

/** The settings that change what everything is worth, so a change re-prices the lot */
const PRICING_SETTINGS = ['networth_pricingMode', 'networth_valueSource'];

class NetworthFeature {
    constructor() {
        this.isActive = false;
        this.currentData = null;
        this.timerRegistry = createTimerRegistry();
        this.pauseRegistry = null;
        this.priceUpdateHandler = null;
        this.pricingModeHandler = null;
        this.itemsUpdateHandler = null;
        this.priceUpdateDebounceTimer = null;
        this.itemsUpdateDebounceTimer = null;
        this.lastRecalcAt = 0;
        this.recalcSeq = 0;
    }

    /**
     * Initialize the networth feature
     */
    async initialize() {
        if (this.isActive) return;

        // Set reference in display components so they can trigger recalculation
        networthHeaderDisplay.setNetworthFeature(this);
        networthInventoryDisplay.setNetworthFeature(this);

        // Initialize exclusions from storage
        const ticket = captureOwner(this);
        await performanceMonitor.span('init:networth', 'exclusions', () => initExclusions());
        // A character switch tearing the feature down inside that read used to
        // resume here regardless: `setupEventListeners()` below is
        // unconditional, and it refills `priceUpdateHandler`,
        // `pricingModeHandler` and `itemsUpdateHandler` — single fields, not an
        // array — that `disable()` has just nulled. The arriving character's
        // own initialize() then overwrites the handles, so the registrations
        // made here can never be removed: one orphaned price, settings and
        // inventory listener per interrupted switch, each re-pricing the whole
        // inventory on every subsequent event for the life of the tab.
        if (!stillOurs(ticket)) return;

        // Initialize header display (always enabled with networth feature)
        if (config.isFeatureEnabled('networth')) {
            networthHeaderDisplay.initialize();
        }

        // Initialize inventory panel display (separate toggle)
        if (config.isFeatureEnabled('inventorySummary')) {
            networthInventoryDisplay.initialize();
        }

        if (!this.pauseRegistry) {
            this.pauseRegistry = createPauseRegistry();
            this.pauseRegistry.register(
                'networth-event-listeners',
                () => this.pauseListeners(),
                () => this.resumeListeners()
            );
        }

        // Set up event-driven updates instead of polling
        this.setupEventListeners();

        this.isActive = true;

        // The first calculation prices every item in the inventory and every
        // saved snapshot in the history — seconds of work, and every feature
        // after this one in the registry was waiting behind it for a number
        // nobody has looked at yet. It runs once the page has drawn instead.
        this.ready = runInBackground('networth', async () => {
            if (connectionState.isConnected()) {
                await performanceMonitor.span('bg:networth', 'first calculation', () => this.recalculate());
            }
            if (config.getSetting('networth_historyChart')) {
                networthHistoryChart.setNetworthFeature(this);
                await performanceMonitor.span('bg:networth', 'history', () => networthHistory.initialize(this));
            }
            if (config.getSetting('networth_goldSources')) {
                await performanceMonitor.span('bg:networth', 'gold sources', async () => {
                    await productionIncomeRecorder.initialize();
                    await chestOpeningRecorder.initialize();
                    await combatLootRecorder.initialize();
                });
            }
        });
    }

    /**
     * Set up event listeners for automatic updates
     */
    setupEventListeners() {
        // Listen for market price updates
        this.priceUpdateHandler = () => {
            // Debounce price updates to avoid excessive recalculation
            clearTimeout(this.priceUpdateDebounceTimer);
            this.priceUpdateDebounceTimer = setTimeout(() => {
                if (this.isActive && connectionState.isConnected()) {
                    this.recalculate();
                }
            }, 1000); // 1 second debounce for price updates
        };

        marketAPI.on(this.priceUpdateHandler);

        // Listen for pricing changes. Both settings decide what an item is
        // worth — the value source picks the order book or the game's own
        // published value, the pricing mode picks a side of that book — so a
        // change to either has to re-price everything. Only the mode was
        // listened for, so switching the value source left the header, the
        // panel and the overlay tile showing figures from the source the user
        // had just changed away from until an unrelated item or price update
        // happened to trigger a pass.
        this.pricingModeHandler = () => {
            if (this.isActive && connectionState.isConnected()) {
                networthCache.clear();
                this.recalculate();
            }
        };
        for (const key of PRICING_SETTINGS) config.onSettingChange(key, this.pricingModeHandler);

        // Listen for inventory changes
        this.itemsUpdateHandler = () => {
            // Debounce item updates, with a floor: under a queue completing an
            // action every few seconds, the 500ms debounce alone re-ran the
            // full valuation on every completion — a synchronous block big
            // enough to stutter the game's progress bars each time (the
            // "purple bars hitch every few seconds" report of 2026-08-29). A
            // fresh figure is not worth more than a smooth frame, so a recalc
            // that would land inside the cooldown waits out the remainder
            // instead.
            const COOLDOWN_MS = 15000;
            const sinceLast = Date.now() - (this.lastRecalcAt || 0);
            const delay = Math.max(500, COOLDOWN_MS - sinceLast);

            clearTimeout(this.itemsUpdateDebounceTimer);
            this.itemsUpdateDebounceTimer = setTimeout(() => {
                if (this.isActive && connectionState.isConnected()) {
                    clearTimeout(this.itemsUpdateMaxWaitTimer);
                    this.itemsUpdateMaxWaitTimer = null;
                    this.lastRecalcAt = Date.now();
                    this.recalculate();
                }
            }, delay);

            // maxWait: the debounce resets on every update, so under continuous
            // load this is what guarantees a refresh actually happens
            if (!this.itemsUpdateMaxWaitTimer) {
                this.itemsUpdateMaxWaitTimer = setTimeout(() => {
                    this.itemsUpdateMaxWaitTimer = null;
                    clearTimeout(this.itemsUpdateDebounceTimer);
                    this.itemsUpdateDebounceTimer = null;
                    if (this.isActive && connectionState.isConnected()) {
                        this.lastRecalcAt = Date.now();
                        this.recalculate();
                    }
                }, 30000);
            }
        };

        dataManager.on('items_updated', this.itemsUpdateHandler);
    }

    /**
     * Pause event listeners (called when tab is hidden)
     */
    pauseListeners() {
        // Clear any pending debounce timers
        clearTimeout(this.priceUpdateDebounceTimer);
        clearTimeout(this.itemsUpdateDebounceTimer);
        clearTimeout(this.itemsUpdateMaxWaitTimer);
        this.itemsUpdateMaxWaitTimer = null;
    }

    /**
     * Resume event listeners (called when tab is visible)
     */
    resumeListeners() {
        // Recalculate immediately when resuming
        if (this.isActive && connectionState.isConnected()) {
            this.recalculate();
        }
    }

    /**
     * Recalculate networth and update displays
     */
    async recalculate() {
        if (!connectionState.isConnected()) {
            return;
        }

        // Into the rolling stats as *elapsed*, not CPU. This run yields to the
        // browser throughout (see the overlap note below), so what is measured
        // here is wall clock; the phases that actually hold the thread are
        // recorded separately, `networth:updateDisplays` being the unsliced one.
        // Reported as CPU it read as 9% of a rolling window on a client whose
        // stall ledger showed zero stalls over the same window.
        const recalcStartedAt = performanceMonitor.enabled ? performance.now() : 0;
        // Recalculations overlap: the cooldown path, a manual refresh and the
        // price-update debounce all call in here, and each run yields to the
        // browser throughout. Completion order does not follow start order —
        // the worker-failure fallback revalues a run's whole worker group
        // sequentially, so an older run can finish after a newer one and
        // overwrite fresher prices everywhere currentData is read (header,
        // inventory panel, overlay row, history snapshots) until the next
        // trigger, which on an idle account may not come. Last-started wins.
        const runId = ++this.recalcSeq;
        try {
            // Calculate networth
            const networthData = await calculateNetworth();
            if (runId !== this.recalcSeq) {
                return;
            }
            this.currentData = networthData;

            // Update displays — measured apart from the calculation: the DOM
            // work here is synchronous and unsliced, so when a stall points at
            // networth:recalculate this split says which half to open
            const displaysStartedAt = recalcStartedAt ? performance.now() : 0;
            if (config.isFeatureEnabled('networth')) {
                networthHeaderDisplay.update(networthData);
            }

            if (config.isFeatureEnabled('inventorySummary')) {
                networthInventoryDisplay.update(networthData);
            }

            // Refresh exclusion popup if open (updates amounts after recalculation)
            networthExclusionPopup.refresh(networthData);
            if (displaysStartedAt) {
                performanceMonitor.record('networth:updateDisplays', performance.now() - displaysStartedAt);
            }
        } catch (error) {
            console.error('[Networth] Error calculating networth:', error);
        } finally {
            if (recalcStartedAt) {
                performanceMonitor.recordElapsed('networth:recalculate', performance.now() - recalcStartedAt);
            }
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        // First of all, so an `initialize()` parked on the exclusions read
        // cannot resume into the handler fields this teardown is about to null.
        noteTeardown(this);
        try {
            // Clear debounce timers
            clearTimeout(this.priceUpdateDebounceTimer);
            clearTimeout(this.itemsUpdateDebounceTimer);
            clearTimeout(this.itemsUpdateMaxWaitTimer);
            this.itemsUpdateMaxWaitTimer = null;

            // Unregister event listeners
            if (this.priceUpdateHandler) {
                marketAPI.off(this.priceUpdateHandler);
                this.priceUpdateHandler = null;
            }

            if (this.pricingModeHandler) {
                for (const key of PRICING_SETTINGS) config.offSettingChange(key, this.pricingModeHandler);
                this.pricingModeHandler = null;
            }

            if (this.itemsUpdateHandler) {
                dataManager.off('items_updated', this.itemsUpdateHandler);
                this.itemsUpdateHandler = null;
            }

            if (this.pauseRegistry) {
                this.pauseRegistry.unregister('networth-event-listeners');
                this.pauseRegistry.cleanup();
                this.pauseRegistry = null;
            }

            this.timerRegistry.clearAll();

            networthHeaderDisplay.disable();
            networthInventoryDisplay.disable();
            networthHistory.disable();
            networthHistoryChart.closeModal();
            networthExclusionPopup.close();
            productionIncomeRecorder.cleanup();
            chestOpeningRecorder.cleanup();
            combatLootRecorder.cleanup();
            goldSourcesPanel.closeModal();

            // Clear the enhancement cost cache (character-specific)
            networthCache.clear();

            // The pool recreates itself on the next batch; idle workers should not
            // outlive the feature that spawned them
            terminateItemValueWorkerPool();

            // A recalculation still in flight belongs to the character being
            // left: without this its `runId` still matches and it would refill
            // `currentData` — and the header, the panel and the overlay tile —
            // with the departing character's total after this cleared it
            this.recalcSeq += 1;
            this.currentData = null;
            this.isActive = false;
        } catch (error) {
            console.error('[Net Worth] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
        }
    }
}

const networthFeature = new NetworthFeature();

/**
 * Open the net worth history chart, or close it if it is already up.
 *
 * The tile is one number; the chart is where that number came from and where it
 * has been. Wrapped rather than handed over directly because opening it loads
 * saved preferences first, and the overlay calls `onOpen` inside a synchronous
 * try/catch — a rejection would escape it as an unhandled promise.
 *
 * @returns {Promise<void>}
 */
async function openHistoryChart() {
    try {
        await networthHistoryChart.toggleModal();
    } catch (error) {
        console.error('[Networth] Opening the history chart failed:', error);
    }
}

// Registered at module scope so the overlay has the row regardless of start-up
// order. Reads the value the feature last calculated rather than calculating:
// a full networth pass prices every item you own and runs a worker pool, which
// is not something a row redrawn every second may do. The figure refreshes when
// the feature itself recalculates, on item and price changes.
registerRow({
    key: 'netWorth',
    empty: 'No net worth yet',
    name: 'Net Worth',
    defaultSize: { width: 180, height: 30 },
    // The tile is one number and a fixed tooltip, so the number as drawn is the
    // whole input — and the number is published by the net worth pass rather
    // than computed here, so nothing about reading it can be out of date
    version: () => {
        const total = networthFeature.currentData?.totalNetworth;
        return total > 0 ? String(Math.round(total)) : 'blank';
    },
    render: (container) => {
        const total = networthFeature.currentData?.totalNetworth;
        if (!(total > 0)) return blank(container);

        row(container, [
            { text: 'Net Worth', color: ROW_COLORS.dim },
            { text: formatLargeNumber(Math.round(total)), color: ROW_COLORS.good, bold: true, push: true },
        ]);
        container.title = 'Everything you own, priced.\nDouble-click for the net worth history chart.';
    },
    onOpen: openHistoryChart,
});

export default networthFeature;
