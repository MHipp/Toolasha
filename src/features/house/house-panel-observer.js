/**
 * House Panel Observer
 * Detects house upgrade modal and injects cost displays
 */

import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import houseCostDisplay from './house-cost-display.js';
import * as houseCostCalculator from '../../utils/house-cost-calculator.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';

class HousePanelObserver {
    constructor() {
        this.isActive = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.processedCards = new WeakSet();
        this.modalObserver = null; // Unwatch function for the current modal's mutation watcher
    }

    /**
     * Initialize the observer
     */
    async initialize() {
        if (this.isActive) return;

        // Initialize calculator
        await houseCostCalculator.initialize();

        // Initialize display
        houseCostDisplay.initialize();

        // Register modal observer
        this.registerObservers();

        this.isActive = true;
    }

    /**
     * Register DOM observers
     */
    registerObservers() {
        // Watch for house modal appearing
        const unregisterModal = domObserver.onClass(
            'HousePanelObserver-Modal',
            'HousePanel_modalContent',
            (modalContent) => {
                this.handleHouseModal(modalContent);
            }
        );
        this.cleanupRegistry.registerCleanup(unregisterModal);
    }

    /**
     * Handle house modal appearing
     * @param {Element} modalContent - The house panel modal content element
     */
    async handleHouseModal(modalContent) {
        // Wait a moment for content to fully load
        await new Promise((resolve) => {
            const loadTimeout = setTimeout(resolve, 100);
            this.cleanupRegistry.registerTimeout(loadTimeout);
        });

        // Modal shows one room at a time, not a grid
        // Process the currently displayed room
        await this.processModalContent(modalContent);

        // Set up observer for room switching
        this.observeModalChanges(modalContent);
    }

    /**
     * Process the modal content (single room display)
     * @param {Element} modalContent - The house panel modal content
     */
    async processModalContent(modalContent) {
        // Identify which room is currently displayed
        const houseRoomHrid = this.identifyRoomFromModal(modalContent);

        if (!houseRoomHrid) {
            return;
        }

        // Find the costs section to add our column
        const costsSection = modalContent.querySelector('[class*="HousePanel_costs"]');

        if (!costsSection) {
            return;
        }

        // Add our cost display as a column
        await houseCostDisplay.addCostColumn(costsSection, houseRoomHrid, modalContent);
    }

    /**
     * Identify house room HRID from modal header
     * @param {Element} modalContent - The modal content element
     * @returns {string|null} House room HRID
     */
    identifyRoomFromModal(modalContent) {
        const initData = dataManager.getInitClientData();
        if (!initData || !initData.houseRoomDetailMap) {
            return null;
        }

        // Get room name from header
        const header = modalContent.querySelector('[class*="HousePanel_header"]');
        if (!header) {
            return null;
        }

        const roomName = header.textContent.trim();

        // Match against room names in game data
        for (const [hrid, roomData] of Object.entries(initData.houseRoomDetailMap)) {
            if (roomData.name === roomName) {
                return hrid;
            }
        }

        return null;
    }

    /**
     * Observe modal for room switching
     * @param {Element} modalContent - The house panel modal content
     */
    observeModalChanges(modalContent) {
        // Only one modal is open at a time — release the previous modal's watcher
        // so observers don't accumulate across modal opens
        if (this.modalObserver) {
            this.modalObserver();
            this.modalObserver = null;
        }

        const unwatch = createMutationWatcher(
            modalContent,
            (mutations) => {
                // Self-disconnect once the modal has been detached
                if (!modalContent.isConnected) {
                    if (this.modalObserver === unwatch) {
                        this.modalObserver = null;
                    }
                    unwatch();
                    return;
                }
                // Check if header changed (indicates room switch)
                for (const mutation of mutations) {
                    if (mutation.type === 'childList' || mutation.type === 'characterData') {
                        const header = modalContent.querySelector('[class*="HousePanel_header"]');
                        if (header && mutation.target.contains(header)) {
                            // Room switched, reprocess
                            this.processModalContent(modalContent);
                            break;
                        }
                    }
                }
            },
            {
                childList: true,
                subtree: true,
                characterData: true,
            }
        );
        this.modalObserver = unwatch;
    }

    /**
     * Disable the observer
     */
    disable() {
        try {
            this.cleanup();
        } catch (error) {
            console.error('[House Panel Observer] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
        }
    }

    /**
     * Clean up observers
     */
    cleanup() {
        // The display is this feature's, not the registry's: `initialize()`
        // starts it, and nothing else ever will, so nothing else will ever stop
        // it. It has a working `disable()` and had no caller — the registry
        // tears down this observer and the display's two `dataManager`
        // listeners stayed, so every character switch registered another pair.
        // Its own try/catch so a display that fails part-way cannot take this
        // observer's teardown down with it.
        try {
            houseCostDisplay.disable();
        } catch (error) {
            console.error('[House Panel Observer] House cost display teardown failed:', error);
        }
        if (this.modalObserver) {
            this.modalObserver();
            this.modalObserver = null;
        }
        this.cleanupRegistry.cleanupAll();
        this.cleanupRegistry = createCleanupRegistry();
        this.processedCards = new WeakSet();
        this.isActive = false;
    }
}

const housePanelObserver = new HousePanelObserver();

export default housePanelObserver;
