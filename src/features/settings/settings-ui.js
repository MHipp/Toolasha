/**
 * Settings UI Module
 * Injects Toolasha settings tab into the game's settings panel
 * Based on MWITools Extended approach
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { settingsGroups } from '../../core/settings-schema.js';
import settingsStorage from '../../core/settings-storage.js';
import storage from '../../core/storage.js';
import settingsCSS from './settings-styles.css?raw';
import marketAPI from '../../api/marketplace.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';
import { detectedModeLabel, isMobileMode } from '../../utils/mobile.js';
import scrollSimulatorUI from '../combat/scroll-simulator-ui.js';
import spawnCensus from '../combat/spawn-census.js';
import whatsNew from './whats-new.js';
import ironCowMode, { IRON_COW_SETTINGS } from './iron-cow-mode.js';
import { getDetectedGearSettings, getEnhancingParams } from '../../utils/enhancement-config.js';
import pformancePanel from '../dev/pformance-panel.js';
import treasureTracker from '../inventory/treasure-tracker.js';
import overlayPanel from '../ui/overlay-panel.js';
import overlayTabButton from '../ui/overlay-tab-button.js';
import commandPalette from '../ui/command-palette.js';
import syncManager from '../sync/sync-manager.js';
import { copySyncSetupToOtherCharacters } from '../sync/sync-setup-copy.js';
import {
    getCustomPriceOverrides,
    getCustomPriceOverridesAsync,
    setCustomPriceOverride,
    removeCustomPriceOverride,
    initCustomPriceOverrides,
} from './custom-price-overrides.js';
import {
    MODE_PRESETS,
    SETTING_PRESETS,
    applyPreset,
    presetTargetIds,
    saveBulkSnapshot,
    loadBulkSnapshot,
    clearBulkSnapshot,
    writeCheckboxValues,
} from './setting-presets.js';
import { isSettingChanged, refreshRequiredIds } from './settings-inspection.js';
import {
    characterLabel,
    describeIronCowCopy,
    getCharacterGameModes,
    recordCurrentCharacterGameMode,
    selectIronCowTargets,
} from './character-modes.js';
import { createDiagnosticsSection } from './diagnostics-section.js';
import { exportEverythingJSON, importEverything } from '../../utils/full-backup.js';
import { downloadFile } from '../../utils/csv-export.js';
import { askChoice } from '../../utils/choice-dialog.js';

const COLLAPSED_GROUPS_KEY = 'toolasha_collapsedGroups';

/**
 * How long the search box waits after the last keystroke before filtering.
 *
 * Every keystroke otherwise walks several hundred rows; a typist outruns that
 * long before they have typed a word worth matching.
 */
export const SEARCH_DEBOUNCE_MS = 100;

/** Game mode → the abbreviation the backup filename carries. */
const BACKUP_MODE_ABBR = { standard: 'MC', ironcow: 'IC', legacy_ironcow: 'LC' };

/**
 * `-<charname>-<MC|IC|LC>` for backup filenames, or '' before login.
 * @returns {string} Filename suffix identifying who the backup was taken from
 */
function backupCharacterSuffix() {
    const name = (dataManager.getCurrentCharacterName?.() || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!name) return '';
    const mode = BACKUP_MODE_ABBR[dataManager.getCurrentCharacterGameMode?.()] || '';
    return `-${name}${mode ? `-${mode}` : ''}`;
}

/**
 * An option's label, with anything only the running page can know added to it.
 *
 * One case so far: mobile mode's `auto`. The schema cannot say what detection
 * currently decides — reading it there would close the circle
 * mobile → config → settings-schema — and "Auto-detect" on its own gives the
 * one person whose touchscreen laptop is detected wrong no way to tell a wrong
 * detection from a wrong setting.
 *
 * @param {string} settingId - Which setting the option belongs to
 * @param {string} optValue - The option's value
 * @param {string} optLabel - The label the schema gave it
 * @returns {string} What to show
 */
function liveOptionLabel(settingId, optValue, optLabel) {
    if (settingId === 'mobileMode' && optValue === 'auto') {
        return `${optLabel} (currently: ${detectedModeLabel()})`;
    }
    return optLabel;
}

class SettingsUI {
    constructor() {
        this.config = config;
        this.settingsPanel = null;
        this.settingsObserver = null;
        this.settingsObserverCleanup = null;
        this.currentSettings = {};
        this.isInjecting = false; // Guard against concurrent injection
        this.characterSwitchHandler = null; // Store listener reference to prevent duplicates
        this.settingsPanelCallbacks = []; // Callbacks to run when settings panel appears
        this.timerRegistry = createTimerRegistry();
        this.collapsedGroups = new Set();
        this.panelStateReady = null; // Lazily started read of panel-only state (collapsed groups)
        this.searchQuery = '';
        this.changedOnly = false;
        this.searchFilterTimer = null; // Pending debounced search filter pass
        this.restoreButton = null;
        this.diagnosticsSection = null; // The Diagnostics group, built lazily on open
    }

    /**
     * Initialize the settings UI
     */
    async initialize() {
        // Inject CSS styles (check if already injected)
        if (!document.getElementById('toolasha-settings-styles')) {
            this.injectStyles();
        }

        // Start the custom price overrides read first so it overlaps everything
        // below; it is awaited at the end because the profit features that
        // start next read the cache synchronously
        const overridesReady = initCustomPriceOverrides();

        // Current settings come from config's already-loaded map rather than a
        // third storage read of the same record; the entries are copied so the
        // panel's working copy stays its own, as a fresh load's would be
        this.currentSettings = this.snapshotSettings();

        // The one moment the game says which mode this character plays. Nothing
        // else on the account can be asked, so it is written down when heard —
        // "Copy Settings to IC Characters" has no other way to know
        recordCurrentCharacterGameMode();

        // Set up handler for character switching (ONLY if not already registered)
        if (!this.characterSwitchHandler) {
            this.characterSwitchHandler = () => {
                recordCurrentCharacterGameMode();
                this.handleCharacterSwitch();
            };
            dataManager.on('character_initialized', this.characterSwitchHandler);
        }

        // Cross-device sync starts here rather than from the feature registry:
        // its only entry points are the buttons in this panel and its own
        // schedule, and config has loaded this character's settings by now.
        // It no-ops unless sync_enabled and a token are both present. Its
        // initializer does not await anything, so nothing here waits on it.
        syncManager.initialize().catch((error) => {
            console.error('[SettingsUI] Starting cross-device sync failed:', error);
        });

        // Wait for game's settings panel to load
        this.observeSettingsPanel();

        await overridesReady;
    }

    /**
     * A working copy of config's loaded settings map — one object per entry,
     * so the panel can edit its copy without reaching into config's.
     * @returns {Object} settingId → entry
     */
    snapshotSettings() {
        const snapshot = {};
        for (const [id, entry] of Object.entries(config.settingsMap || {})) {
            snapshot[id] = entry && typeof entry === 'object' ? { ...entry } : entry;
        }
        return snapshot;
    }

    /**
     * Load the state only the panel itself needs (which groups are collapsed),
     * the first time the panel is about to be drawn. The read is shared: a
     * second caller joins the one in flight.
     * @returns {Promise<void>}
     */
    loadPanelState() {
        if (!this.panelStateReady) {
            this.panelStateReady = (async () => {
                try {
                    const savedCollapsed = await storage.get(COLLAPSED_GROUPS_KEY, 'settings', []);
                    this.collapsedGroups = new Set(Array.isArray(savedCollapsed) ? savedCollapsed : []);
                } catch (error) {
                    console.error('[SettingsUI] Reading collapsed groups failed:', error);
                }
            })();
        }
        return this.panelStateReady;
    }

    /**
     * Register a callback to be called when settings panel appears
     * @param {Function} callback - Function to call when settings panel is detected
     */
    onSettingsPanelAppear(callback) {
        if (typeof callback === 'function') {
            this.settingsPanelCallbacks.push(callback);
        }
    }

    /**
     * Handle character switch
     * Clean up old observers and re-initialize for new character's settings panel
     */
    handleCharacterSwitch() {
        // Clean up old DOM references and observers (but keep listener registered)
        this.cleanupDOM();

        // Wait for settings panel to stabilize before re-observing
        const reobserveTimeout = setTimeout(() => {
            this.observeSettingsPanel();
        }, 500);
        this.timerRegistry.registerTimeout(reobserveTimeout);
    }

    /**
     * Cleanup DOM elements and observers only (internal cleanup during character switch)
     */
    cleanupDOM() {
        this.timerRegistry.clearAll();

        // Stop observer
        if (this.settingsObserver) {
            this.settingsObserver.disconnect();
            this.settingsObserver = null;
        }

        if (this.settingsObserverCleanup) {
            this.settingsObserverCleanup();
            this.settingsObserverCleanup = null;
        }

        // Remove settings tab
        const tab = document.querySelector('#toolasha-settings-tab');
        if (tab) {
            tab.remove();
        }

        // Remove settings panel
        const panel = document.querySelector('#toolasha-settings');
        if (panel) {
            panel.remove();
        }

        this.diagnosticsSection?.destroy();
        this.diagnosticsSection = null;

        // Clear state
        this.settingsPanel = null;
        this.currentSettings = {};
        this.isInjecting = false;

        // The config cache is deliberately NOT cleared here.
        //
        // Clearing it is half of a pair — feature-registry clears it on
        // `character_switching` and reloads it on `character_switched`, and only
        // that pairing is safe. This method has no reload to follow it, and it
        // runs on `character_initialized`, which fires on a plain reconnect or
        // re-login to the *same* character with no switch events at all. The map
        // was then emptied with nothing to refill it: every `getSetting` fell
        // through to the shipped schema default for the rest of the session, and
        // every `setSetting` went to the pending queue that only `loadSettings`
        // drains — so the panel's switches moved, nothing was stored, and a
        // refresh showed none of it. Tearing the panel's DOM down is not a
        // reason to throw away the settings the whole script is running on.
    }

    /**
     * Inject CSS styles into page
     */
    injectStyles() {
        const styleEl = document.createElement('style');
        styleEl.id = 'toolasha-settings-styles';
        styleEl.textContent = settingsCSS;
        document.head.appendChild(styleEl);
    }

    /**
     * Observe for game's settings panel
     * Uses MutationObserver to detect when settings panel appears
     */
    observeSettingsPanel() {
        // Wait for DOM to be ready before observing
        const startObserver = () => {
            if (!document.body) {
                const observerDelay = setTimeout(startObserver, 10);
                this.timerRegistry.registerTimeout(observerDelay);
                return;
            }

            const onMutation = (_mutations) => {
                // Look for the settings tabs container
                const tabsContainer = document.querySelector('div[class*="SettingsPanel_tabsComponentContainer"]');

                if (tabsContainer) {
                    // Check if our tab already exists before injecting
                    if (!tabsContainer.querySelector('#toolasha-settings-tab')) {
                        this.injectSettingsTab();
                    }

                    // Call registered callbacks for other features
                    this.settingsPanelCallbacks.forEach((callback) => {
                        try {
                            callback();
                        } catch (error) {
                            console.error('[Toolasha Settings] Callback error:', error);
                        }
                    });

                    // Keep observer running - panel might be removed/re-added if user navigates away and back
                }
            };

            // Observe the main game panel for changes
            const gamePanel = document.querySelector('div[class*="GamePage_gamePanel"]');
            if (gamePanel) {
                this.settingsObserverCleanup = createMutationWatcher(gamePanel, onMutation, {
                    childList: true,
                    subtree: true,
                });
            } else {
                // Fallback: observe entire body if game panel not found (Firefox timing issue)
                console.warn('[Toolasha Settings] Could not find game panel, observing body instead');
                this.settingsObserverCleanup = createMutationWatcher(document.body, onMutation, {
                    childList: true,
                    subtree: true,
                });
            }

            // Store observer reference (for compatibility with existing cleanup path)
            this.settingsObserver = null;

            // Also check immediately in case settings is already open
            const existingTabsContainer = document.querySelector('div[class*="SettingsPanel_tabsComponentContainer"]');
            if (existingTabsContainer && !existingTabsContainer.querySelector('#toolasha-settings-tab')) {
                this.injectSettingsTab();

                // Call registered callbacks for other features
                this.settingsPanelCallbacks.forEach((callback) => {
                    try {
                        callback();
                    } catch (error) {
                        console.error('[Toolasha Settings] Callback error:', error);
                    }
                });
            }
        };

        startObserver();
    }

    /**
     * Inject Toolasha settings tab into game's settings panel
     */
    async injectSettingsTab() {
        // Guard against concurrent injection
        if (this.isInjecting) {
            return;
        }
        this.isInjecting = true;

        try {
            // Find tabs container (MWIt-E approach)
            const tabsComponentContainer = document.querySelector('div[class*="SettingsPanel_tabsComponentContainer"]');

            if (!tabsComponentContainer) {
                console.warn('[Toolasha Settings] Could not find tabsComponentContainer');
                return;
            }

            // Find the MUI tabs flexContainer
            const tabsContainer = tabsComponentContainer.querySelector('[class*="MuiTabs-flexContainer"]');
            const tabPanelsContainer = tabsComponentContainer.querySelector(
                '[class*="TabsComponent_tabPanelsContainer"]'
            );

            if (!tabsContainer || !tabPanelsContainer) {
                console.warn('[Toolasha Settings] Could not find tabs or panels container');
                return;
            }

            // Check if already injected
            if (tabsContainer.querySelector('#toolasha-settings-tab')) {
                return;
            }

            // Reload current settings from storage to ensure latest values,
            // alongside the panel-only state that is read on first open
            // rather than at startup
            const [currentSettings] = await Promise.all([settingsStorage.loadSettings(), this.loadPanelState()]);
            this.currentSettings = currentSettings;

            // React can remount the settings panel while that read is in flight,
            // and the two containers captured above are then orphaned nodes. The
            // tab would be appended into a tree nobody is looking at and stay
            // missing until the next mutation happened to trigger another pass.
            // Bailing leaves the observer to fire again against the live panel.
            if (!tabsContainer.isConnected || !tabPanelsContainer.isConnected) {
                return;
            }

            // Get existing tabs for reference
            const existingTabs = Array.from(tabsContainer.querySelectorAll('button[role="tab"]'));

            // Create new tab button
            const tabButton = this.createTabButton();

            // Create tab panel
            const tabPanel = this.createTabPanel();

            // Setup tab switching
            this.setupTabSwitching(tabButton, tabPanel, existingTabs, tabPanelsContainer);

            // Append to DOM
            tabsContainer.appendChild(tabButton);
            tabPanelsContainer.appendChild(tabPanel);

            // Apply disabled state now that elements are in the document
            this.applyDisabledByState();

            // Populate auto-detected values if auto-detect is already on
            if (config.getSettingValue('enhanceSim_autoDetect', false)) {
                this.populateEnhanceSimFromDetection();
            }

            // Store reference
            this.settingsPanel = tabPanel;
        } catch (error) {
            console.error('[Toolasha Settings] Error during tab injection:', error);
        } finally {
            // Always reset the guard flag
            this.isInjecting = false;
        }
    }

    /**
     * Create tab button
     * @returns {HTMLElement} Tab button element
     */
    createTabButton() {
        const button = document.createElement('button');
        button.id = 'toolasha-settings-tab';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', '-1');
        button.className = 'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary';
        button.style.minWidth = '90px';

        const span = document.createElement('span');
        span.className = 'MuiTab-wrapper';
        span.textContent = 'Toolasha';

        button.appendChild(span);

        return button;
    }

    /**
     * Create tab panel with all settings
     * @returns {HTMLElement} Tab panel element
     */
    createTabPanel() {
        const panel = document.createElement('div');
        panel.id = 'toolasha-settings';
        panel.className = 'TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3';
        panel.setAttribute('role', 'tabpanel');
        panel.style.display = 'none';

        // Create settings card
        const card = document.createElement('div');
        card.className = 'toolasha-settings-card';
        card.id = 'toolasha-settings-content';

        // Add search box at the top
        this.addSearchBox(card);

        // Presets lead the page: somebody opening this panel for the first time
        // wants "make it do the thing I play", not the first of four hundred
        // switches. Iron Cow rides along as a mode chip in the same row
        this.addPresetButtons(card);

        // Generate settings from config
        this.generateSettings(card);

        this.addUtilityButtons(card);

        // Add refresh notice
        this.addRefreshNotice(card);

        panel.appendChild(card);

        // Add change listener
        card.addEventListener('change', (e) => this.handleSettingChange(e));

        // Add click listener for template edit buttons
        card.addEventListener('click', (e) => {
            if (e.target.classList.contains('toolasha-template-edit-btn')) {
                const settingId = e.target.dataset.settingId;
                this.openTemplateEditor(settingId);
            }
            if (e.target.classList.contains('toolasha-text-vars-btn')) {
                const settingId = e.target.dataset.settingId;
                this.openTextVariablesHelper(settingId);
            }
            if (e.target.classList.contains('toolasha-custom-price-edit-btn')) {
                this.openCustomPriceOverridesEditor();
            }
            if (e.target.classList.contains('toolasha-scroll-defaults-btn')) {
                scrollSimulatorUI.openDefaultsPopup();
            }
            if (e.target.classList.contains('toolasha-setting-action-btn')) {
                if (e.target.dataset.settingId === 'enhanceSim_resetProDefaults') {
                    this.resetEnhanceSimToProDefaults(e.target);
                }
                if (e.target.dataset.settingId === 'spawnCensusExport') {
                    this.exportSpawnCensus(e.target);
                }
            }
        });

        return panel;
    }

    /**
     * Generate all settings UI from config
     * @param {HTMLElement} container - Container element
     */
    generateSettings(container) {
        for (const [groupKey, group] of Object.entries(settingsGroups)) {
            // Create collapsible group container
            const groupContainer = document.createElement('div');
            groupContainer.className = 'toolasha-settings-group';
            groupContainer.dataset.group = groupKey;
            // The search matches section headings too, and the header's own text
            // carries the collapse arrow and the icon with it
            groupContainer.dataset.groupTitle = group.title;

            // Add section header with collapse toggle
            const header = document.createElement('h3');
            header.className = 'toolasha-settings-group-header';
            header.innerHTML = `
                <span class="collapse-icon">▼</span>
                <span class="icon">${group.icon}</span>
                ${group.title}
            `;
            // Bind toggleGroup method to this instance
            header.addEventListener('click', this.toggleGroup.bind(this, groupContainer));

            // Create content container for this group
            const content = document.createElement('div');
            content.className = 'toolasha-settings-group-content';

            // Add computed stats summary for enhancement simulator group
            if (groupKey === 'enhancementSimulator') {
                const summary = document.createElement('div');
                summary.id = 'enhanceSim-stats-summary';
                summary.style.cssText =
                    'padding:8px 12px; margin-bottom:8px; background:#1a1a2e; border:1px solid #333; border-radius:4px; font-size:12px; color:#aaa; line-height:1.6;';
                summary.innerHTML = this.buildEnhanceSimSummaryHTML();
                content.appendChild(summary);
            }

            // Add settings in this group
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                if (settingDef.hidden) continue;
                const settingEl = this.createSettingElement(settingId, settingDef);
                content.appendChild(settingEl);
            }

            // Push/pull are actions, not settings, and belong beside the
            // switches that configure them rather than in the global button row
            if (groupKey === 'sync') {
                this.addSyncControls(content);
            }

            // Skip groups with no visible settings (all hidden or group is empty)
            if (content.children.length === 0) continue;

            groupContainer.appendChild(header);
            groupContainer.appendChild(content);

            if (this.collapsedGroups.has(groupKey)) {
                groupContainer.classList.add('collapsed');
            }

            container.appendChild(groupContainer);
        }

        // Diagnostics last: not a setting, but the place to look when one of
        // the settings above stops doing anything. Starts collapsed and draws
        // nothing until opened.
        this.diagnosticsSection?.destroy();
        this.diagnosticsSection = createDiagnosticsSection();
        container.appendChild(this.diagnosticsSection.element);
    }

    /**
     * Apply disabled/greyed-out state for settings controlled by a parent checkbox
     * Reads disabledBy from schema and applies opacity + pointer-events
     */
    applyDisabledByState() {
        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                if (!settingDef.disabledBy) continue;

                const parentEntry = this.config.settingsMap[settingDef.disabledBy];
                const parentValue = parentEntry?.isTrue ?? false;
                const settingEl = document.querySelector(`.toolasha-setting[data-setting-id="${settingId}"]`);
                if (!settingEl) continue;

                if (parentValue) {
                    settingEl.style.opacity = '0.4';
                    settingEl.style.pointerEvents = 'none';
                } else {
                    settingEl.style.opacity = '';
                    settingEl.style.pointerEvents = '';
                }
            }
        }

        // Iron Cow locking pass
        const ironCowActive = ironCowMode.isEnabled();
        for (const id of IRON_COW_SETTINGS) {
            const el = document.querySelector(`.toolasha-setting[data-setting-id="${id}"]`);
            if (!el) continue;
            if (ironCowActive) {
                el.style.opacity = '0.35';
                el.style.pointerEvents = 'none';
                el.dataset.ironCowLocked = 'true';
            } else if (el.dataset.ironCowLocked) {
                delete el.dataset.ironCowLocked;
                el.style.opacity = '';
                el.style.pointerEvents = '';
            }
        }
    }

    /**
     * Setup collapse icons for parent settings (settings that have dependents)
     * @param {HTMLElement} container - Settings container
     */
    /**
     * Toggle group collapse/expand
     * @param {HTMLElement} groupContainer - Group container element
     */
    toggleGroup(groupContainer) {
        groupContainer.classList.toggle('collapsed');
        const groupKey = groupContainer.dataset.group;
        if (groupContainer.classList.contains('collapsed')) {
            this.collapsedGroups.add(groupKey);
        } else {
            this.collapsedGroups.delete(groupKey);
        }
        storage.set(COLLAPSED_GROUPS_KEY, [...this.collapsedGroups], 'settings');
    }

    /**
     * Create a single setting UI element
     * @param {string} settingId - Setting ID
     * @param {Object} settingDef - Setting definition
     * @returns {HTMLElement} Setting element
     */
    createSettingElement(settingId, settingDef) {
        const div = document.createElement('div');
        div.className = 'toolasha-setting';
        div.dataset.settingId = settingId;
        div.dataset.type = settingDef.type || 'checkbox';

        // Add not-implemented class for red text
        if (settingDef.notImplemented) {
            div.classList.add('not-implemented');
        }

        // Create label container
        const labelContainer = document.createElement('div');
        labelContainer.className = 'toolasha-setting-label-container';
        labelContainer.style.display = 'flex';
        labelContainer.style.alignItems = 'center';
        labelContainer.style.flex = '1';
        labelContainer.style.gap = '6px';

        // Create label
        const label = document.createElement('span');
        label.className = 'toolasha-setting-label';
        label.textContent = settingDef.label;

        // Add help text if present
        if (settingDef.help) {
            const help = document.createElement('span');
            help.className = 'toolasha-setting-help';
            help.textContent = settingDef.help;
            label.appendChild(help);
        }

        labelContainer.appendChild(label);

        // A setting that only takes effect at startup says so on itself, rather
        // than the panel warning that "some settings" might
        if (settingDef.requiresRefresh) {
            const tag = document.createElement('span');
            tag.className = 'toolasha-refresh-tag';
            tag.textContent = 'reload';
            tag.title = 'This one only takes effect after you refresh the page';
            tag.style.cssText =
                'flex: 0 0 auto; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; ' +
                'color: #ffa500; border: 1px solid rgba(255, 165, 0, 0.45); border-radius: 3px; ' +
                'padding: 1px 5px; line-height: 1.4;';
            labelContainer.appendChild(tag);
        }

        // Create input
        const inputHTML = this.generateSettingInput(settingId, settingDef);
        const inputContainer = document.createElement('div');
        inputContainer.className = 'toolasha-setting-input';
        inputContainer.innerHTML = inputHTML;

        div.appendChild(labelContainer);
        div.appendChild(inputContainer);

        return div;
    }

    /**
     * Generate input HTML for a setting
     * @param {string} settingId - Setting ID
     * @param {Object} settingDef - Setting definition
     * @returns {string} Input HTML
     */
    generateSettingInput(settingId, settingDef) {
        const currentSetting = this.currentSettings[settingId];
        const type = settingDef.type || 'checkbox';

        switch (type) {
            case 'checkbox': {
                const checked = currentSetting?.isTrue ?? settingDef.default ?? false;
                return `
                    <input type="checkbox" id="${settingId}" ${checked ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer; accent-color:#6b9fff;">
                `;
            }

            case 'text': {
                let value = currentSetting?.value ?? settingDef.default ?? '';
                // Migrate old template array format (previously type:'template') to plain string
                if (Array.isArray(value)) {
                    value = value.map((item) => (item.type === 'variable' ? item.key : (item.value ?? ''))).join('');
                } else if (typeof value === 'string' && value.startsWith('[')) {
                    try {
                        const arr = JSON.parse(value);
                        if (Array.isArray(arr)) {
                            value = arr
                                .map((item) => (item.type === 'variable' ? item.key : (item.value ?? '')))
                                .join('');
                        }
                    } catch {
                        /* leave as-is */
                    }
                }
                const hasVars = settingDef.templateVariables?.length > 0;
                const input = `
                    <input type="text"
                        id="${settingId}"
                        class="toolasha-text-input"
                        value="${String(value).replace(/"/g, '&quot;')}"
                        placeholder="${settingDef.placeholder || ''}">
                `;
                if (!hasVars) return input;
                return `
                    <div style="display:flex; gap:6px; align-items:center;">
                        ${input}
                        <button type="button"
                            class="toolasha-text-vars-btn"
                            data-setting-id="${settingId}"
                            style="
                                background: #4a7c59;
                                border: 1px solid #5a8c69;
                                border-radius: 4px;
                                padding: 6px 12px;
                                color: #e0e0e0;
                                cursor: pointer;
                                font-size: 13px;
                                white-space: nowrap;
                                flex-shrink: 0;
                            ">
                            Edit Template
                        </button>
                    </div>
                `;
            }

            // A secret, not a preference: rendered masked so it is not readable
            // over a shoulder or in a screenshot of the settings panel, which is
            // the single most common way this script's settings get shared.
            // `autocomplete="off"` keeps the browser's password manager from
            // offering to remember a GitHub token against milkywayidle.com.
            case 'password': {
                const value = currentSetting?.value ?? settingDef.default ?? '';
                return `
                    <input type="password"
                        id="${settingId}"
                        class="toolasha-text-input"
                        value="${String(value).replace(/"/g, '&quot;')}"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="${settingDef.placeholder || ''}">
                `;
            }

            case 'template': {
                const value = currentSetting?.value ?? settingDef.default ?? [];
                // Store as JSON string
                const jsonValue = JSON.stringify(value);
                const escapedValue = jsonValue.replace(/"/g, '&quot;');

                return `
                    <input type="hidden"
                        id="${settingId}"
                        value="${escapedValue}">
                    <button type="button"
                        class="toolasha-template-edit-btn"
                        data-setting-id="${settingId}"
                        style="
                            background: #4a7c59;
                            border: 1px solid #5a8c69;
                            border-radius: 4px;
                            padding: 6px 12px;
                            color: #e0e0e0;
                            cursor: pointer;
                            font-size: 13px;
                            white-space: nowrap;
                            transition: all 0.2s;
                        ">
                        Edit Template
                    </button>
                `;
            }

            case 'number': {
                const value = currentSetting?.value ?? settingDef.default ?? 0;
                return `
                    <input type="number"
                        id="${settingId}"
                        class="toolasha-number-input"
                        value="${value}"
                        min="${settingDef.min ?? ''}"
                        max="${settingDef.max ?? ''}"
                        step="${settingDef.step ?? '1'}">
                `;
            }

            case 'select': {
                const value = currentSetting?.value ?? settingDef.default ?? '';
                const options =
                    typeof settingDef.options === 'function' ? settingDef.options() : settingDef.options || [];
                const optionsHTML = options
                    .map((option) => {
                        const optValue = typeof option === 'object' ? option.value : option;
                        const optLabel = typeof option === 'object' ? option.label : option;
                        const selected = optValue === value ? 'selected' : '';
                        return `<option value="${optValue}" ${selected}>${liveOptionLabel(
                            settingId,
                            optValue,
                            optLabel
                        )}</option>`;
                    })
                    .join('');

                return `
                    <select id="${settingId}" class="toolasha-select-input toolasha-select">
                        ${optionsHTML}
                    </select>
                `;
            }

            case 'color': {
                const value = currentSetting?.value ?? settingDef.value ?? settingDef.default ?? '#000000';
                return `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <input type="color"
                            id="${settingId}"
                            class="toolasha-color-input"
                            value="${value}">
                        <input type="text"
                            id="${settingId}_text"
                            class="toolasha-color-text-input"
                            value="${value}"
                            style="width: 80px; padding: 4px; background: #2a2a2a; color: white; border: 1px solid #555; border-radius: 3px;"
                            readonly>
                    </div>
                `;
            }

            case 'enhanceGear': {
                const val = currentSetting?.value ?? settingDef.default ?? { enabled: true, level: 0 };
                const enabled = val.enabled ?? true;
                const tier = val.tier || '';
                const level = val.level ?? 0;
                const hasTiers = settingDef.tiers && settingDef.tiers.length > 0;
                const checkedMeansAuto = settingDef.checkedMeansAuto || false;

                // Inputs disabled when: gear unchecked (not equipped) OR checkedMeansAuto and checked
                const inputsDisabled = checkedMeansAuto ? enabled : !enabled;
                const disabledStyle = inputsDisabled ? 'opacity:0.4; pointer-events:none;' : '';

                let tierHTML = '';
                if (hasTiers) {
                    const options = settingDef.tiers
                        .map(
                            (t) =>
                                `<option value="${t.value}" ${t.value === tier ? 'selected' : ''}>${t.label}</option>`
                        )
                        .join('');
                    tierHTML = `<select id="${settingId}_tier" class="toolasha-select-input toolasha-select" style="width:100px; font-size:12px; padding:2px 4px; ${disabledStyle}">${options}</select>`;
                }

                return `
                    <div style="display:flex; align-items:center; gap:6px;" data-checked-means-auto="${checkedMeansAuto}">
                        <input type="checkbox" id="${settingId}_enabled" ${enabled ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;">
                        ${tierHTML}
                        <input type="number" id="${settingId}_level" value="${level}" min="0" max="20" style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:2px 4px; font-size:12px; text-align:center; ${disabledStyle}">
                    </div>
                `;
            }

            case 'slider': {
                const value = currentSetting?.value ?? settingDef.default ?? 0;
                return `
                    <div style="display: flex; align-items: center; gap: 12px; width: 100%;">
                        <input type="range"
                            id="${settingId}"
                            class="toolasha-slider-input"
                            value="${value}"
                            min="${settingDef.min ?? 0}"
                            max="${settingDef.max ?? 1}"
                            step="${settingDef.step ?? 0.01}"
                            style="flex: 1;">
                        <span id="${settingId}_value" class="toolasha-slider-value" style="min-width: 50px; color: #aaa; font-size: 0.9em;">${value}</span>
                    </div>
                `;
            }

            case 'customPriceOverrides': {
                const overrides = getCustomPriceOverrides();
                const count = Object.keys(overrides).length;
                return `
                    <input type="hidden"
                        id="${settingId}"
                        value="">
                    <button type="button"
                        class="toolasha-custom-price-edit-btn"
                        data-setting-id="${settingId}"
                        style="
                            background: #4a7c59;
                            border: 1px solid #5a8c69;
                            border-radius: 4px;
                            padding: 6px 12px;
                            color: #e0e0e0;
                            cursor: pointer;
                            font-size: 13px;
                            white-space: nowrap;
                            transition: all 0.2s;
                        ">
                        Manage Overrides${count > 0 ? ` (${count})` : ''}
                    </button>
                `;
            }

            case 'checkboxWithButton': {
                const checkedCwb = currentSetting?.isTrue ?? settingDef.default ?? false;
                const btnLabel = settingDef.buttonLabel ?? 'Configure...';
                return `
                    <div style="display:flex; align-items:center; gap:8px;">
                        <button type="button"
                            class="toolasha-scroll-defaults-btn"
                            data-setting-id="${settingId}"
                            style="
                                background: #4a7c59;
                                border: 1px solid #5a8c69;
                                border-radius: 4px;
                                padding: 4px 10px;
                                color: #e0e0e0;
                                cursor: pointer;
                                font-size: 12px;
                                white-space: nowrap;
                            ">
                            ${btnLabel}
                        </button>
                        <input type="checkbox"
                            id="${settingId}"
                            ${checkedCwb ? 'checked' : ''}
                            style="width:18px; height:18px; cursor:pointer;">
                    </div>
                `;
            }

            case 'button': {
                // A row that IS an action: nothing stored, nothing collected on
                // save — the delegated click handler dispatches on the id
                const label = settingDef.buttonLabel ?? settingDef.label ?? 'Run';
                return `
                    <button type="button"
                        class="toolasha-setting-action-btn"
                        data-setting-id="${settingId}"
                        style="
                            background: #4a7c59;
                            border: 1px solid #5a8c69;
                            border-radius: 4px;
                            padding: 4px 10px;
                            color: #e0e0e0;
                            cursor: pointer;
                            font-size: 12px;
                            white-space: nowrap;
                        ">
                        ${label}
                    </button>
                `;
            }

            default:
                return `<span style="color: red;">Unknown type: ${type}</span>`;
        }
    }

    /**
     * Add search box to filter settings
     * @param {HTMLElement} container - Container element
     */
    addSearchBox(container) {
        // A freshly built panel starts unfiltered: the controls below are new
        // elements, and leaving the old state on the instance would show an
        // inactive button over a filtered list
        this.searchQuery = '';
        this.changedOnly = false;
        this.cancelPendingSettingsFilter();

        const searchContainer = document.createElement('div');
        searchContainer.className = 'toolasha-search-container';
        searchContainer.style.cssText = `
            margin-bottom: 20px;
            display: flex;
            gap: 8px;
            align-items: center;
        `;

        // Search input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'toolasha-search-input';
        searchInput.placeholder = 'Search settings...';
        searchInput.style.cssText = `
            flex: 1;
            padding: 8px 12px;
            background: #2a2a2a;
            color: white;
            border: 1px solid #555;
            border-radius: 4px;
            font-size: 14px;
        `;

        // Clear button
        const clearButton = document.createElement('button');
        clearButton.textContent = 'Clear';
        clearButton.className = 'toolasha-search-clear';
        clearButton.style.cssText = `
            padding: 8px 16px;
            background: #444;
            color: white;
            border: 1px solid #555;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;
        clearButton.style.display = 'none'; // Hidden by default

        // "Changed only" toggle. Several hundred switches is too many to scan
        // for the four you touched, and the schema already knows what it ships
        // with — so the difference is something the panel can simply show.
        const changedButton = document.createElement('button');
        changedButton.textContent = 'Changed only';
        changedButton.className = 'toolasha-changed-only-toggle';
        changedButton.title = 'Show only settings whose value differs from the default';
        changedButton.setAttribute('aria-pressed', 'false');
        changedButton.style.cssText = `
            padding: 8px 16px;
            background: #444;
            color: white;
            border: 1px solid #555;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            white-space: nowrap;
        `;
        this.changedOnlyButton = changedButton;

        // Collapse/expand all: with this many groups, folding them one header
        // at a time is busywork in both directions
        const buttonStyle = changedButton.style.cssText;
        const collapseAllButton = document.createElement('button');
        collapseAllButton.textContent = '▸ All';
        collapseAllButton.className = 'toolasha-collapse-all';
        collapseAllButton.title = 'Collapse every settings group';
        collapseAllButton.style.cssText = buttonStyle;
        const expandAllButton = document.createElement('button');
        expandAllButton.textContent = '▾ All';
        expandAllButton.className = 'toolasha-expand-all';
        expandAllButton.title = 'Expand every settings group';
        expandAllButton.style.cssText = buttonStyle;
        collapseAllButton.addEventListener('click', () => this.setAllGroupsCollapsed(container, true));
        expandAllButton.addEventListener('click', () => this.setAllGroupsCollapsed(container, false));

        /** Empty the box and put the panel back the way it was. */
        const clearSearch = () => {
            searchInput.value = '';
            clearButton.style.display = 'none';
            this.cancelPendingSettingsFilter();
            this.searchQuery = '';
            this.applySettingsFilter();
            searchInput.focus();
        };

        // Input event listener. The clear button follows the box immediately —
        // it is one element — while the filter itself waits out the typing.
        searchInput.addEventListener('input', (e) => {
            const value = e.target.value;
            clearButton.style.display = value.trim() ? 'block' : 'none';
            this.scheduleSettingsFilter(value);
        });

        // The game listens for bare keys as shortcuts, and a settings search is
        // the one place where every letter is meant for the box
        searchInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                clearSearch();
            }
        });

        // Clear button event listener
        clearButton.addEventListener('click', clearSearch);

        changedButton.addEventListener('click', () => {
            this.changedOnly = !this.changedOnly;
            this.updateChangedOnlyButton();
            this.applySettingsFilter();
        });

        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(changedButton);
        searchContainer.appendChild(collapseAllButton);
        searchContainer.appendChild(expandAllButton);
        searchContainer.appendChild(clearButton);
        container.appendChild(searchContainer);
    }

    /**
     * Take a new search string and filter once the typing stops.
     * @param {string} value - The raw text now in the search box
     */
    scheduleSettingsFilter(value) {
        this.cancelPendingSettingsFilter();
        this.searchFilterTimer = setTimeout(() => {
            this.searchFilterTimer = null;
            this.searchQuery = value;
            this.applySettingsFilter();
        }, SEARCH_DEBOUNCE_MS);
    }

    /**
     * Drop a filter pass that has not run yet, so a clear is not undone by the
     * keystroke that preceded it.
     */
    cancelPendingSettingsFilter() {
        if (this.searchFilterTimer) {
            clearTimeout(this.searchFilterTimer);
            this.searchFilterTimer = null;
        }
    }

    /**
     * Collapse or expand every settings group at once, remembered the same way
     * the per-group toggles are.
     * @param {HTMLElement} container - The settings card holding the groups
     * @param {boolean} collapsed - Fold everything, or open everything
     */
    setAllGroupsCollapsed(container, collapsed) {
        for (const group of container.querySelectorAll('.toolasha-settings-group')) {
            group.classList.toggle('collapsed', collapsed);
            const key = group.dataset.group;
            if (!key) continue;
            if (collapsed) this.collapsedGroups.add(key);
            else this.collapsedGroups.delete(key);
        }
        // Diagnostics draws its body on first open, so expand-all has to open it
        // rather than merely un-collapse it
        if (!collapsed) this.diagnosticsSection?.open();
        storage.set(COLLAPSED_GROUPS_KEY, [...this.collapsedGroups], 'settings');
    }

    /**
     * Reflect the changed-only state on its button.
     */
    updateChangedOnlyButton() {
        const button = this.changedOnlyButton;
        if (!button) return;
        button.setAttribute('aria-pressed', String(this.changedOnly));
        button.style.background = this.changedOnly ? '#2f5d8a' : '#444';
        button.style.borderColor = this.changedOnly ? '#6b9fff' : '#555';
    }

    /**
     * Show the settings that pass the search text and the changed-only toggle,
     * hiding groups that end up empty.
     *
     * One function for both filters rather than one each: two independent
     * passes over the same elements would fight, the second undoing whatever
     * the first hid.
     */
    applySettingsFilter() {
        const query = (this.searchQuery || '').toLowerCase().trim();
        const changedOnly = this.changedOnly;

        this._markMatchingModeChips(query);

        if (!query && !changedOnly) {
            document.querySelectorAll('.toolasha-setting').forEach((setting) => {
                setting.style.display = 'flex';
            });
            document.querySelectorAll('.toolasha-settings-group').forEach((group) => {
                group.style.display = 'block';
            });
            return;
        }

        document.querySelectorAll('.toolasha-settings-group').forEach((group) => {
            let visibleCount = 0;
            // Naming the section is a way of asking for everything in it — the
            // heading is how the panel is organised, not decoration on the rows
            const groupMatches = Boolean(query) && (group.dataset.groupTitle || '').toLowerCase().includes(query);

            group.querySelectorAll('.toolasha-setting').forEach((setting) => {
                let visible = true;

                if (query && !groupMatches) {
                    const label = setting.querySelector('.toolasha-setting-label')?.textContent || '';
                    const help = setting.querySelector('.toolasha-setting-help')?.textContent || '';
                    visible = (label + ' ' + help).toLowerCase().includes(query);
                }

                if (visible && changedOnly) {
                    const settingId = setting.dataset.settingId;
                    visible = isSettingChanged(this.findSettingDef(settingId), this.config.settingsMap[settingId]);
                }

                setting.style.display = visible ? 'flex' : 'none';
                if (visible) visibleCount++;
            });

            // A section named by the search stays up even if it has no rows of
            // its own to show, so the search points somewhere rather than nowhere
            const keep = visibleCount > 0 || (groupMatches && !changedOnly);
            group.style.display = keep ? 'block' : 'none';
        });
    }

    /**
     * Ring the mode chips a search names.
     *
     * A mode's schema entry is hidden — the chip is its control — so a search
     * for "iron cow" would otherwise hide every row and point at nothing.
     *
     * @param {string} query - The lower-cased search text, empty to clear
     */
    _markMatchingModeChips(query) {
        for (const mode of MODE_PRESETS) {
            const chip = document.querySelector(`.toolasha-mode-chip[data-mode-id="${mode.id}"]`);
            if (!chip) continue;
            const matched = Boolean(query) && `${mode.label} ${mode.description}`.toLowerCase().includes(query);
            chip.dataset.searchMatch = String(matched);
            chip.style.outline = matched ? '2px solid #6b9fff' : '';
            chip.style.outlineOffset = matched ? '2px' : '';
        }
    }

    /**
     * Add the preset bundles — a whole configuration in one button.
     * @param {HTMLElement} container - Container element
     */
    addPresetButtons(container) {
        const wrapper = document.createElement('div');
        wrapper.className = 'toolasha-preset-buttons';
        wrapper.style.cssText = 'margin: 0 0 16px 0;';

        const heading = document.createElement('div');
        heading.textContent = 'Presets';
        heading.style.cssText = 'font-size: 12px; color: #888; margin-bottom: 6px;';
        wrapper.appendChild(heading);

        const note = document.createElement('div');
        note.textContent =
            'A preset turns feature switches on and off in one go. Numbers, dropdowns and colours are left alone, ' +
            'and Restore undoes the last one. A mode — the pressed-in chip — is not a one-off: it stays on ' +
            'alongside whichever preset you pick.';
        note.style.cssText = 'font-size: 11px; color: #666; margin-bottom: 8px; line-height: 1.4;';
        wrapper.appendChild(note);

        const row = document.createElement('div');
        row.className = 'toolasha-utility-buttons';

        for (const preset of SETTING_PRESETS) {
            const button = document.createElement('button');
            button.textContent = preset.label;
            button.className = 'toolasha-utility-button toolasha-preset-chip';
            button.title = preset.description;
            button.dataset.presetId = preset.id;
            // A one-shot is an action, never a state: it has no pressed look and
            // says so, so the one chip that *is* a state reads as different
            button.dataset.presetKind = 'oneShot';
            button.addEventListener('click', () => this.handleApplyPreset(preset));
            row.appendChild(button);
        }

        for (const mode of MODE_PRESETS) {
            row.appendChild(this.createModeChip(mode));
        }

        wrapper.appendChild(row);
        container.appendChild(wrapper);
    }

    /**
     * A chip for a persistent mode — pressed in while the mode is on.
     *
     * Carries `data-setting-id` so the settings search and the command palette
     * can find and jump to it exactly as they find an ordinary setting row: the
     * mode's schema entry is hidden, so this chip *is* its control.
     *
     * @param {Object} mode - Entry from MODE_PRESETS
     * @returns {HTMLButtonElement} The chip
     */
    createModeChip(mode) {
        const chip = document.createElement('button');
        chip.className = 'toolasha-utility-button toolasha-mode-chip';
        chip.dataset.modeId = mode.id;
        chip.dataset.presetKind = 'mode';
        chip.dataset.settingId = mode.settingId;
        chip.setAttribute('role', 'switch');
        chip.title = mode.description;
        chip.textContent = `${mode.icon} ${mode.label}`;

        chip.addEventListener('click', () => this.handleToggleMode(mode, chip));
        this._paintModeChip(chip, ironCowMode.isEnabled(), mode);
        return chip;
    }

    /**
     * Show whether a mode is currently on.
     * @param {HTMLElement} chip - The mode's chip
     * @param {boolean} enabled - Whether the mode is on
     * @param {Object} mode - Entry from MODE_PRESETS
     */
    _paintModeChip(chip, enabled, mode) {
        chip.setAttribute('aria-pressed', String(enabled));
        chip.dataset.active = String(enabled);
        chip.title = enabled ? `${mode.description} ${mode.activeNote}` : mode.description;
        chip.style.cssText = enabled
            ? 'background: linear-gradient(135deg, #7c5c20, #d4900a); border: 1px solid #ffc65c; ' +
              'box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.45); color: #fff9e8; font-weight: 700;'
            : 'background: linear-gradient(135deg, #2a2a2a, #3a3a3a); border: 1px dashed #7c5c20; color: #c0c0c0;';
    }

    /**
     * Turn a mode on or off. Modes stack with presets, so nothing else is
     * touched — the force-disable machinery the mode owns does its own work.
     *
     * @param {Object} mode - Entry from MODE_PRESETS
     * @param {HTMLElement} chip - Its chip, repainted afterwards
     */
    async handleToggleMode(mode, chip) {
        if (chip.dataset.busy === 'true') return;
        chip.dataset.busy = 'true';

        try {
            const enabling = !ironCowMode.isEnabled();
            config.setSetting(mode.settingId, enabling);
            if (enabling) {
                await ironCowMode.enable();
            } else {
                await ironCowMode.disable();
            }
            this._paintModeChip(chip, enabling, mode);
            this._syncIronCowSettingInputs();
            this.applyDisabledByState();
        } catch (error) {
            console.error('[SettingsUI] Toggling a mode failed:', error);
        } finally {
            delete chip.dataset.busy;
        }
    }

    /**
     * Repaint every mode chip from the mode's own state.
     *
     * Run after any bulk write: a preset must never move a mode, and the chip
     * saying so is how somebody can see that it did not.
     */
    _refreshModeChips() {
        for (const mode of MODE_PRESETS) {
            const chip = document.querySelector(`.toolasha-mode-chip[data-mode-id="${mode.id}"]`);
            if (chip) this._paintModeChip(chip, ironCowMode.isEnabled(), mode);
        }
    }

    /**
     * Apply a preset, after asking — it rewrites a few hundred switches.
     * @param {Object} preset - Entry from SETTING_PRESETS
     */
    async handleApplyPreset(preset) {
        const confirmed = confirm(
            `Apply the "${preset.label}" preset?\n\n${preset.description}\n\n` +
                'Every other feature switch is turned off. Numbers, dropdowns and colours are left alone, and ' +
                'Restore puts your current switches back.'
        );
        if (!confirmed) return;

        const applied = await applyPreset(preset.id);
        if (!applied) {
            alert('Applying the preset failed. See the console for details.');
            return;
        }

        for (const [id, value] of Object.entries(applied)) {
            if (this.currentSettings[id]) this.currentSettings[id].isTrue = value;
        }

        // A preset writes stored values even for settings the mode locks;
        // re-force them so Iron Cow wins immediately, not on its next apply
        this._reapplyModes();
        this._syncAllCheckboxInputs();
        // A preset is a one-shot and a mode is not: whichever modes were on
        // before are still on, and the chips have to keep saying so
        this._refreshModeChips();
        this.applyDisabledByState();
        this.applySettingsFilter();
        if (this.restoreButton) this.restoreButton.style.display = '';
    }

    /**
     * Put the enhancement bench back to the shipped pro defaults.
     *
     * Resets exactly the settings the auto-detect switch governs (they carry
     * `disabledBy: 'enhanceSim_autoDetect'`) — the bench Pro rates quote —
     * writing each schema default through the same path a hand edit takes and
     * updating the visible inputs in place, so the panel needs no rebuild.
     *
     * @param {HTMLElement} [button] - The pressed button, for a moment's feedback
     */
    async resetEnhanceSimToProDefaults(button) {
        // While auto-detect is on, the on-screen inputs show *detected* values,
        // not the stored bench — writing defaults into them would make the
        // display lie about what was detected. The stored values still reset;
        // the saved-values map (what toggling auto-detect off restores to the
        // screen) is updated instead, so the panel shows the defaults then.
        const autoDetectOn = this.config.settingsMap['enhanceSim_autoDetect']?.isTrue ?? false;
        const savedValues = autoDetectOn ? this._enhanceSimSavedValues : null;

        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, def] of Object.entries(group.settings)) {
                if (def.disabledBy !== 'enhanceSim_autoDetect') continue;
                const value = structuredClone(def.default);

                await settingsStorage.setSetting(settingId, value);
                if (!this.currentSettings[settingId]) this.currentSettings[settingId] = {};
                if (def.type === 'checkbox') {
                    this.currentSettings[settingId].isTrue = value;
                    this.config.setSetting(settingId, value);
                } else {
                    this.currentSettings[settingId].value = value;
                    this.config.setSettingValue(settingId, value);
                }

                if (savedValues) {
                    // Same shapes populateEnhanceSimFromDetection saves and
                    // restoreEnhanceSimSavedValues reads back
                    if (def.type === 'enhanceGear') {
                        savedValues[settingId] = {
                            enabled: value?.enabled ?? true,
                            tier: value?.tier || '',
                            level: String(value?.level ?? 0),
                        };
                    } else if (def.type === 'checkbox') {
                        savedValues[settingId] = !!value;
                    } else {
                        savedValues[settingId] = String(value);
                    }
                    continue;
                }

                // Mirror the stored value into whatever inputs are on screen
                if (def.type === 'enhanceGear') {
                    const enabledEl = document.getElementById(`${settingId}_enabled`);
                    const tierEl = document.getElementById(`${settingId}_tier`);
                    const levelEl = document.getElementById(`${settingId}_level`);
                    if (enabledEl) enabledEl.checked = value?.enabled ?? true;
                    if (tierEl && value?.tier) tierEl.value = value.tier;
                    if (levelEl) levelEl.value = String(value?.level ?? 0);

                    // The sub-inputs' enabled/disabled look follows the checkbox
                    // (inverted for checkedMeansAuto rows) — a hand edit keeps it
                    // current in handleSettingChange, and a reset that flips the
                    // checkbox without it leaves tier/level greyed and unclickable
                    const enabled = value?.enabled ?? true;
                    const inputsDisabled = def.checkedMeansAuto ? enabled : !enabled;
                    const style = inputsDisabled ? 'opacity:0.4; pointer-events:none;' : '';
                    for (const el of [tierEl, levelEl]) {
                        if (!el) continue;
                        el.style.cssText =
                            el.style.cssText.replace(/opacity:[^;]*;?\s*pointer-events:[^;]*;?/g, '') + style;
                    }
                } else {
                    const input = document.getElementById(settingId);
                    if (input) {
                        if (def.type === 'checkbox') input.checked = !!value;
                        else input.value = String(value);
                    }
                }
            }
        }

        this.updateEnhanceSimSummary?.();
        if (button) {
            const label = button.textContent;
            button.textContent = 'Reset ✓';
            setTimeout(() => {
                if (button.isConnected) button.textContent = label;
            }, 1500);
        }
    }

    /**
     * Download the Spawn Census export, the same file `Toolasha.Debug.spawnCensusExport()`
     * produces, from a settings button so contributing data doesn't need the console.
     *
     * Works regardless of whether the `spawnCensus` checkbox is currently on - someone may
     * have switched it off but still wants what was already collected, so this button carries
     * no `disabledBy`. The only thing that blocks it is having nothing recorded yet, which is
     * reported on the button itself rather than silently downloading an empty file.
     *
     * @param {HTMLElement} [button] - The pressed button, for a moment's feedback
     */
    async exportSpawnCensus(button) {
        const label = button?.textContent;
        const flash = (text) => {
            if (!button) return;
            button.textContent = text;
            setTimeout(() => {
                if (button.isConnected) button.textContent = label;
            }, 2000);
        };

        // If the feature was off when this page loaded, nothing was hydrated from
        // storage into memory (initialize() bails before load() in that case) - a
        // prior session's data would otherwise look like it was never collected.
        // Unconditional now that load() is idempotent: the previous "only when
        // memory is empty" guard was still true for a second press that arrived
        // while the first read was in flight, and hydrate() is additive, so two
        // quick presses doubled every count and then flushed the doubled copy.
        await spawnCensus.load();

        await spawnCensus.flush();
        const waveCount = spawnCensus.summary().wavesSeen;
        if (!waveCount) {
            flash('Nothing recorded yet');
            return;
        }

        if (spawnCensus.downloadExport()) {
            flash(`Exported ${waveCount.toLocaleString()} waves ✓`);
        } else {
            flash('Nothing recorded yet');
        }
    }

    /**
     * Re-force every active mode's managed settings after a bulk write.
     */
    _reapplyModes() {
        try {
            ironCowMode.reapply();
            for (const id of Object.keys(this.currentSettings)) {
                const entry = config.settingsMap[id];
                if (entry && this.currentSettings[id]) this.currentSettings[id].isTrue = entry.isTrue;
            }
        } catch (error) {
            console.error('[SettingsUI] Re-applying modes after a bulk write failed:', error);
        }
    }

    /**
     * Add utility buttons (Reset, Export, Import, Fetch Prices)
     * @param {HTMLElement} container - Container element
     */
    /**
     * Export every IndexedDB store — settings and all tracked history — as one
     * versioned JSON file. The filename carries which character and game mode
     * the backup was taken from — the payload is account-wide either way, but
     * a folder of dated backups is unreadable without it.
     * @param {HTMLElement} button - The button, for inline status feedback
     */
    async handleFullBackup(button) {
        const original = button.textContent;
        try {
            button.textContent = 'Exporting…';
            // Serialized store by store: the object form of a large database
            // plus its stringification is two copies of everything at once
            const json = await exportEverythingJSON();
            const stamp = new Date().toISOString().slice(0, 10);
            downloadFile(
                `toolasha-backup-${stamp}${backupCharacterSuffix()}.json`,
                json,
                'application/json;charset=utf-8;'
            );
            button.textContent = 'Saved ✓';
        } catch (error) {
            console.error('[SettingsUI] Full backup failed:', error);
            button.textContent = 'Failed';
        } finally {
            setTimeout(() => {
                button.textContent = original;
            }, 2000);
        }
    }

    /**
     * Restore a full backup file after an explicit confirmation. Overwrites the
     * stored keys the backup carries; a reload afterwards picks everything up.
     */
    async handleFullRestore() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const payload = JSON.parse(await file.text());
                const stores = Object.keys(payload?.stores || {});
                if (!stores.length) {
                    alert('That file does not look like a Toolasha backup.');
                    return;
                }
                const when = payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : 'unknown date';
                const confirmed = await askChoice({
                    title: 'Restore backup',
                    message:
                        `Backup from ${when}, covering ${stores.length} data stores ` +
                        `(${stores.slice(0, 5).join(', ')}${stores.length > 5 ? ', …' : ''}). ` +
                        'Restoring overwrites the stored copies of everything it contains.',
                    choices: [
                        { value: 'restore', label: 'Restore', tone: 'danger' },
                        { value: null, label: 'Cancel' },
                    ],
                });
                if (confirmed !== 'restore') return;
                const { restored, failed, complete } = await importEverything(payload);
                const total = Object.values(restored).reduce((sum, n) => sum + n, 0);

                // "Restored 0 entries" used to be reported as success. A store
                // whose transaction aborts writes nothing, and one bad key aborts
                // the whole store — so the number that mattered was never the one
                // shown. Say which stores did not land, and do not call it done.
                if (!complete) {
                    const detail = failed
                        .map((entry) => `${entry.store} (${entry.written}/${entry.expected})`)
                        .join(', ');
                    alert(
                        `The restore did not finish. These stores did not take their data: ${detail}. ` +
                            `${total} entries were written elsewhere. The console has the detail; freeing disk ` +
                            'space and restoring again is the usual fix.'
                    );
                    return;
                }

                alert(
                    `Restored ${total} entries across ${Object.keys(restored).length} stores. ` +
                        'Reload now — changes made before reloading will not be kept.'
                );
            } catch (error) {
                console.error('[SettingsUI] Restoring backup failed:', error);
                alert('Restoring the backup failed: ' + error.message);
            }
        });
        input.click();
    }

    /**
     * Push / Pull / Unlink, plus a line saying where this device stands.
     *
     * Kept inside the Sync group rather than in the utility row at the bottom of
     * the panel: those buttons are all local operations, and a button that
     * uploads a year of history to the internet should not sit unlabelled next
     * to "Export Settings".
     *
     * @param {HTMLElement} container - The Sync group's content element
     */
    addSyncControls(container) {
        const wrapper = document.createElement('div');
        wrapper.className = 'toolasha-sync-controls';
        wrapper.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:8px 0 4px;';

        const status = document.createElement('div');
        status.id = 'toolasha-sync-status';
        status.style.cssText = 'font-size:12px; color:#aaa; line-height:1.5;';
        status.textContent = 'Checking sync status…';

        const refreshStatus = async () => {
            try {
                status.textContent = await syncManager.describeStatus();
            } catch (error) {
                console.error('[SettingsUI] Reading sync status failed:', error);
                status.textContent = 'Sync status unavailable.';
            }
        };
        refreshStatus();

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px;';

        /**
         * A button whose label reports what happened, then goes back to normal.
         * @param {string} label - Resting label
         * @param {string} busyLabel - Label while the work runs
         * @param {Function} run - Returns the sync manager's outcome object
         * @returns {HTMLButtonElement} The button
         */
        const makeButton = (label, busyLabel, run) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.className = 'toolasha-utility-button';
            button.addEventListener('click', async () => {
                if (button.disabled) return;
                button.disabled = true;
                button.textContent = busyLabel;
                try {
                    const result = await run();
                    button.textContent = result?.ok ? 'Done ✓' : 'Failed';
                } catch (error) {
                    console.error('[SettingsUI] Sync action failed:', error);
                    button.textContent = 'Failed';
                } finally {
                    await refreshStatus();
                    this.timerRegistry.registerTimeout(
                        setTimeout(() => {
                            button.textContent = label;
                            button.disabled = false;
                        }, 2000)
                    );
                }
            });
            return button;
        };

        row.appendChild(makeButton('⬆ Push to GitHub', 'Pushing…', () => syncManager.push()));
        row.appendChild(makeButton('⬇ Pull from GitHub', 'Pulling…', () => syncManager.pull()));
        row.appendChild(
            makeButton('Unlink gist', 'Unlinking…', async () => {
                const answer = await askChoice({
                    title: 'Unlink the sync gist',
                    message:
                        'This device forgets which gist it was using and what it last synced. The gist itself is ' +
                        'left alone on GitHub — the next push finds it again or makes a new one.',
                    choices: [
                        { value: 'unlink', label: 'Unlink' },
                        { value: null, label: 'Cancel' },
                    ],
                });
                if (answer !== 'unlink') return { ok: false };
                await syncManager.forgetGist();
                return { ok: true };
            })
        );

        // The token and the switches above are stored per character, so a main
        // and an iron cow on one browser otherwise need the same token pasted
        // twice. Local write only — see sync-setup-copy.js.
        const copyRow = document.createElement('div');
        copyRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px;';
        const copyBtn = makeButton(
            "Copy sync setup to this device's other characters",
            'Copying…',
            copySyncSetupToOtherCharacters
        );
        copyBtn.title =
            'Copies the settings in this section — token, passphrase, scope and switches — onto the other ' +
            "characters this device has settings for. Written to this browser's local database only; nothing " +
            'is uploaded.';
        copyRow.appendChild(copyBtn);

        wrapper.appendChild(row);
        wrapper.appendChild(copyRow);
        wrapper.appendChild(status);
        container.appendChild(wrapper);
    }

    addUtilityButtons(container) {
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'toolasha-utility-buttons';

        // Sync button (at top - most important)
        const syncBtn = document.createElement('button');
        syncBtn.textContent = 'Copy Settings to All Characters';
        syncBtn.className = 'toolasha-utility-button toolasha-sync-button';
        syncBtn.addEventListener('click', () => this.handleSync());

        // The same copy, aimed only at the characters with no marketplace —
        // whose settings are a different configuration on purpose
        const syncIronCowBtn = document.createElement('button');
        syncIronCowBtn.textContent = 'Copy Settings to IC Characters';
        syncIronCowBtn.className = 'toolasha-utility-button toolasha-sync-button toolasha-sync-ironcow-button';
        syncIronCowBtn.title = 'Copy these settings to the characters Toolasha has seen running an iron cow game mode';
        syncIronCowBtn.addEventListener('click', () => this.handleSyncIronCow());

        // Re-open the first-run setup — the one-shot welcome is easily dismissed
        // (a click outside counts), and this is the recoverable way back to it,
        // on this character or any alt. Offers presets and "copy from another
        // character".
        const setupBtn = document.createElement('button');
        setupBtn.textContent = 'First-time setup';
        setupBtn.className = 'toolasha-utility-button';
        setupBtn.title =
            'Re-open the welcome setup for this character — pick a preset or copy settings from another character';
        setupBtn.addEventListener('click', () => whatsNew.promptSetup());

        // Reopen the after-update popup — the changelog and the update's new
        // settings — which is one-shot and easily dismissed by a stray click.
        const whatsNewBtn = document.createElement('button');
        whatsNewBtn.textContent = "What's new";
        whatsNewBtn.className = 'toolasha-utility-button';
        whatsNewBtn.title = 'Reopen the latest update notes — the changelog and any new settings';
        whatsNewBtn.addEventListener('click', () => whatsNew.reopen());

        // Fetch Latest Prices button
        const fetchPricesBtn = document.createElement('button');
        fetchPricesBtn.textContent = '🔄 Fetch Latest Prices';
        fetchPricesBtn.className = 'toolasha-utility-button toolasha-fetch-prices-button';
        fetchPricesBtn.addEventListener('click', () => this.handleFetchPrices(fetchPricesBtn));

        // Reset button
        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset to Defaults';
        resetBtn.className = 'toolasha-utility-button';
        resetBtn.addEventListener('click', () => this.handleReset());

        // Export button
        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export Settings';
        exportBtn.className = 'toolasha-utility-button';
        exportBtn.addEventListener('click', () => this.handleExport());

        // Full backup: settings are one store of ~17 — the tracked histories
        // (dungeon runs, networth, loot logs, …) were unexportable before this
        const backupBtn = document.createElement('button');
        backupBtn.textContent = '💾 Back Up Everything';
        backupBtn.className = 'toolasha-utility-button';
        backupBtn.addEventListener('click', () => this.handleFullBackup(backupBtn));

        const restoreBackupBtn = document.createElement('button');
        restoreBackupBtn.textContent = '📥 Restore Backup';
        restoreBackupBtn.className = 'toolasha-utility-button';
        restoreBackupBtn.addEventListener('click', () => this.handleFullRestore());

        // Import button
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import Settings';
        importBtn.className = 'toolasha-utility-button';
        importBtn.addEventListener('click', () => this.handleImport());

        // All Off button
        const allOffBtn = document.createElement('button');
        allOffBtn.textContent = 'All Off';
        allOffBtn.className = 'toolasha-utility-button';
        allOffBtn.addEventListener('click', () => this.handleAllOff(restoreBtn));

        // Restore button (only shown when an All Off snapshot exists)
        const restoreBtn = document.createElement('button');
        restoreBtn.textContent = 'Restore';
        restoreBtn.className = 'toolasha-utility-button';
        restoreBtn.style.display = 'none';
        restoreBtn.addEventListener('click', () => this.handleRestore(restoreBtn));
        this.restoreButton = restoreBtn;

        // Show restore immediately if a snapshot already exists from a prior bulk write
        (async () => {
            try {
                const snap = await loadBulkSnapshot();
                if (snap) restoreBtn.style.display = '';
            } catch (error) {
                console.error('[SettingsUI] Failed to check bulk-write snapshot:', error);
            }
        })();

        buttonsDiv.appendChild(syncBtn);
        buttonsDiv.appendChild(syncIronCowBtn);
        buttonsDiv.appendChild(setupBtn);
        buttonsDiv.appendChild(whatsNewBtn);
        buttonsDiv.appendChild(fetchPricesBtn);
        buttonsDiv.appendChild(allOffBtn);
        buttonsDiv.appendChild(restoreBtn);
        buttonsDiv.appendChild(resetBtn);
        buttonsDiv.appendChild(exportBtn);
        buttonsDiv.appendChild(importBtn);
        buttonsDiv.appendChild(backupBtn);
        buttonsDiv.appendChild(restoreBackupBtn);

        const overlayBtn = document.createElement('button');
        overlayBtn.textContent = 'Overlay';
        overlayBtn.className = 'toolasha-utility-button';
        overlayBtn.addEventListener('click', () => overlayPanel.toggle());
        buttonsDiv.appendChild(overlayBtn);

        const treasureBtn = document.createElement('button');
        treasureBtn.textContent = 'Treasure';
        treasureBtn.className = 'toolasha-utility-button';
        treasureBtn.addEventListener('click', () => treasureTracker.toggle());
        buttonsDiv.appendChild(treasureBtn);

        const pformanceBtn = document.createElement('button');
        pformanceBtn.textContent = 'PFormance';
        pformanceBtn.className = 'toolasha-utility-button';
        pformanceBtn.addEventListener('click', () => pformancePanel.toggle());
        buttonsDiv.appendChild(pformanceBtn);

        // Mobile-only: a phone has no Ctrl/Cmd to press, so the palette's
        // hotkey is unreachable there. This tab is the one place Toolasha's
        // own UI is guaranteed to be on screen on a phone (it rides beside the
        // game's own Inventory tab, which is always present), so it is where
        // the palette's one other opener belongs. Desktop keeps the hotkey as
        // the only way in — a second button there would just be a slower
        // version of it sitting in a row of panel toggles.
        if (isMobileMode()) {
            const paletteBtn = document.createElement('button');
            paletteBtn.textContent = 'Command Palette';
            paletteBtn.className = 'toolasha-utility-button';
            paletteBtn.title =
                'Search every panel, overlay row, saved layout and setting by name — the same list Ctrl/Cmd+K ' +
                'opens on desktop, reachable here because a phone has no keyboard to press that with.';
            paletteBtn.addEventListener('click', () => commandPalette.open());
            buttonsDiv.appendChild(paletteBtn);
        }

        this.addOverlayLauncherRecovery(buttonsDiv);

        container.appendChild(buttonsDiv);
    }

    /**
     * "Show the overlay button" — brings back the phone launcher if it was
     * dragged onto the drop zone and dismissed.
     *
     * Mobile-only: the launcher (`overlay-tab-button.js`) only exists in mobile
     * mode, so the control has nothing to recover on desktop.
     *
     * Deliberately not a `settings-schema.js` entry: whether the launcher is
     * hidden is device-local state (`toolasha_local_overlayLauncherHidden`,
     * excluded from sync by `DEVICE_LOCAL_KEY_PREFIXES` in
     * `core/settings-storage.js`) so that a phone which dismissed its launcher
     * and a desktop that never had one do not fight over one synced switch, and
     * a freshly-set-up phone gets its own launcher rather than inheriting
     * whatever the last phone decided. This button reads and clears that flag
     * only through `overlay-tab-button.js`'s own small API
     * (`isLauncherHidden()` / `showLauncher()`) — it never touches the storage
     * key itself, so there is exactly one place that owns that key's shape.
     *
     * A control that only appears once the launcher is already gone is the
     * thing that got this raised in the first place — nobody could find a way
     * back once it was dismissed — so with the flag unset this still shows,
     * just reporting that the button is already up.
     *
     * @param {HTMLElement} buttonsDiv - The utility-button row to add it to
     */
    addOverlayLauncherRecovery(buttonsDiv) {
        if (!isMobileMode()) return;

        const launcherBtn = document.createElement('button');
        launcherBtn.className = 'toolasha-utility-button';

        const syncLabel = async () => {
            try {
                const hidden = await overlayTabButton.isLauncherHidden();
                launcherBtn.textContent = hidden ? 'Show the overlay button' : 'Overlay button is already shown';
                launcherBtn.disabled = !hidden;
            } catch (error) {
                console.error('[SettingsUI] Checking the overlay launcher flag failed:', error);
                launcherBtn.textContent = 'Show the overlay button';
                launcherBtn.disabled = false;
            }
        };

        launcherBtn.title =
            'Brings back the round ⧉ overlay launcher if it was dragged onto its drop zone and dismissed. ' +
            'Device-local — each phone remembers this on its own, separately from any synced setting.';
        launcherBtn.addEventListener('click', async () => {
            try {
                await overlayTabButton.setLauncherHidden(false);
            } catch (error) {
                console.error('[SettingsUI] Bringing back the overlay launcher failed:', error);
            }
            await syncLabel();
        });

        syncLabel();
        buttonsDiv.appendChild(launcherBtn);
    }

    /**
     * Add refresh notice
     * @param {HTMLElement} container - Container element
     */
    addRefreshNotice(container) {
        const notice = document.createElement('div');
        notice.className = 'toolasha-refresh-notice';

        // "Some settings require a refresh" was true of a handful and read as
        // true of all of them, which taught people to reload after every click.
        // The schema now marks the ones that mean it, so the notice can point
        // at them and promise the rest are live.
        const count = refreshRequiredIds().length;
        notice.textContent = count
            ? `Everything applies straight away except the ${count} settings tagged "reload" — those gate a feature ` +
              'at startup and need a page refresh.'
            : 'Every setting applies straight away — no refresh needed.';

        container.appendChild(notice);
    }

    /**
     * Setup tab switching functionality
     * @param {HTMLElement} tabButton - Toolasha tab button
     * @param {HTMLElement} tabPanel - Toolasha tab panel
     * @param {HTMLElement[]} existingTabs - Existing tab buttons
     * @param {HTMLElement} tabPanelsContainer - Tab panels container
     */
    setupTabSwitching(tabButton, tabPanel, existingTabs, tabPanelsContainer) {
        const switchToTab = (targetButton, targetPanel) => {
            // Hide all panels
            const allPanels = tabPanelsContainer.querySelectorAll('[class*="TabPanel_tabPanel"]');
            allPanels.forEach((panel) => {
                panel.style.display = 'none';
                panel.classList.add('TabPanel_hidden__26UM3');
            });

            // Deactivate only the buttons in this tab's own tab list. The game
            // renders several independent MUI tab bars at once (chat channels,
            // the top-right panel, the actions panel, ...); a document-wide
            // query here deselects all of them, but only this settings panel's
            // target gets re-selected below. Those other tab bars are
            // React-controlled and their React state never changed, so React
            // never repaints the class back in — the tab stays visibly
            // unselected until something unrelated remounts it. Deriving the
            // list from the target button's own tablist (rather than unioning
            // `existingTabs` with `tabButton`) also covers a tab the game adds
            // to this settings panel later, after this closure was created.
            const tabList = targetButton.closest('[role="tablist"]') || targetButton.parentElement;
            const allButtons = tabList.querySelectorAll('button[role="tab"]');
            allButtons.forEach((btn) => {
                btn.setAttribute('aria-selected', 'false');
                btn.setAttribute('tabindex', '-1');
                btn.classList.remove('Mui-selected');
            });

            // Activate target
            targetButton.setAttribute('aria-selected', 'true');
            targetButton.setAttribute('tabindex', '0');
            targetButton.classList.add('Mui-selected');
            targetPanel.style.display = 'block';
            targetPanel.classList.remove('TabPanel_hidden__26UM3');

            // Update title
            const titleEl = document.querySelector('[class*="SettingsPanel_title"]');
            if (titleEl) {
                if (targetButton.id === 'toolasha-settings-tab') {
                    const ver = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).Toolasha?.version || '';
                    titleEl.textContent = `⚙️ Toolasha ${ver ? `v${ver} ` : ''}Settings (refresh to apply)`;
                } else {
                    titleEl.textContent = 'Settings';
                }
            }
        };

        // Click handler for Toolasha tab
        tabButton.addEventListener('click', () => {
            switchToTab(tabButton, tabPanel);
        });

        // Click handlers for existing tabs
        existingTabs.forEach((existingTab, index) => {
            existingTab.addEventListener('click', () => {
                const correspondingPanel = tabPanelsContainer.children[index];
                if (correspondingPanel) {
                    switchToTab(existingTab, correspondingPanel);
                }
            });
        });
    }

    /**
     * Handle setting change
     * @param {Event} event - Change event
     */
    async handleSettingChange(event) {
        const input = event.target;
        if (!input.id) return;

        let settingId = input.id;

        // Block changes to locked settings while Iron Cow mode is active
        if (ironCowMode.isEnabled() && IRON_COW_SETTINGS.has(settingId)) return;
        const settingEl = input.closest('.toolasha-setting');
        const type = settingEl?.dataset.type || 'checkbox';
        const isCheckboxType = type === 'checkbox' || type === 'checkboxWithButton';

        // Handle enhanceGear compound inputs
        if (type === 'enhanceGear') {
            // The real setting ID is on the container element
            settingId = settingEl?.dataset.settingId;
            if (!settingId) return;

            const enabledEl = document.getElementById(`${settingId}_enabled`);
            const tierEl = document.getElementById(`${settingId}_tier`);
            const levelEl = document.getElementById(`${settingId}_level`);

            // Built in the schema's key order, and `tier` only when the row has
            // a tier select: the "Changed only" filter compares this object to
            // the schema default by JSON text, and a `tier: ''` a tierless
            // row's default never had would flag the row as changed forever
            const value = { enabled: enabledEl?.checked ?? true };
            if (tierEl) value.tier = tierEl.value || '';
            value.level = parseInt(levelEl?.value, 10) || 0;

            // Update disabled state on sub-inputs
            const container = enabledEl?.parentElement;
            const checkedMeansAuto = container?.dataset.checkedMeansAuto === 'true';
            const inputsDisabled = checkedMeansAuto ? value.enabled : !value.enabled;
            const style = inputsDisabled ? 'opacity:0.4; pointer-events:none;' : '';
            if (tierEl)
                tierEl.style.cssText =
                    tierEl.style.cssText.replace(/opacity:[^;]*;?\s*pointer-events:[^;]*;?/g, '') + style;
            if (levelEl)
                levelEl.style.cssText =
                    levelEl.style.cssText.replace(/opacity:[^;]*;?\s*pointer-events:[^;]*;?/g, '') + style;

            await settingsStorage.setSetting(settingId, value);
            if (!this.currentSettings[settingId]) this.currentSettings[settingId] = {};
            this.currentSettings[settingId].value = value;
            this.config.setSettingValue(settingId, value);
            this.updateEnhanceSimSummary();
            return;
        }

        let value;

        // Get value based on type
        if (isCheckboxType) {
            value = input.checked;
        } else if (type === 'number' || type === 'slider') {
            value = parseFloat(input.value) || 0;
            // Update the slider value display if it's a slider
            if (type === 'slider') {
                const valueDisplay = document.getElementById(`${settingId}_value`);
                if (valueDisplay) {
                    valueDisplay.textContent = value;
                }
            }
        } else if (type === 'color') {
            value = input.value;
            // Update the text display
            const textInput = document.getElementById(`${settingId}_text`);
            if (textInput) {
                textInput.value = value;
            }
        } else {
            value = input.value;
        }

        // Save to storage
        await settingsStorage.setSetting(settingId, value);

        // Update local cache immediately
        if (!this.currentSettings[settingId]) {
            this.currentSettings[settingId] = {};
        }
        if (isCheckboxType) {
            this.currentSettings[settingId].isTrue = value;
        } else {
            this.currentSettings[settingId].value = value;
        }

        // Update config module (for backward compatibility)
        if (isCheckboxType) {
            this.config.setSetting(settingId, value);
        } else {
            this.config.setSettingValue(settingId, value);
        }

        // Apply color settings immediately if this is a color setting
        if (type === 'color') {
            this.config.applyColorSettings();
        }

        // Update disabled state for dependent settings
        if (isCheckboxType) {
            this.applyDisabledByState();

            // When enhanceSim_autoDetect is toggled, manage gear input display
            if (settingId === 'enhanceSim_autoDetect') {
                if (value) {
                    this.populateEnhanceSimFromDetection();
                } else {
                    this.restoreEnhanceSimSavedValues();
                }
                this.updateEnhanceSimSummary();
            }
        }

        // Update enhancement sim summary if any enhance setting changed
        if (settingId.startsWith('enhanceSim_')) {
            this.updateEnhanceSimSummary();
        }
    }

    /**
     * Populate enhancement sim gear inputs with auto-detected values from character data.
     * Saves current values first so they can be restored when toggling off.
     */
    populateEnhanceSimFromDetection() {
        const detected = getDetectedGearSettings();
        if (!detected) return;

        // Save current input values before overwriting
        this._enhanceSimSavedValues = {};

        for (const [settingId, value] of Object.entries(detected)) {
            if (value && typeof value === 'object' && 'enabled' in value) {
                // Compound gear setting
                const enabledEl = document.getElementById(`${settingId}_enabled`);
                const tierEl = document.getElementById(`${settingId}_tier`);
                const levelEl = document.getElementById(`${settingId}_level`);

                // Save current state
                this._enhanceSimSavedValues[settingId] = {
                    enabled: enabledEl?.checked ?? true,
                    tier: tierEl?.value || '',
                    level: levelEl?.value || '0',
                };

                // Apply detected values
                if (enabledEl) enabledEl.checked = value.enabled;
                if (tierEl && value.tier) tierEl.value = value.tier;
                if (levelEl) levelEl.value = value.level;
            } else {
                // Simple setting (checkbox or value)
                const el = document.getElementById(settingId);
                if (!el) continue;

                if (typeof value === 'boolean') {
                    this._enhanceSimSavedValues[settingId] = el.checked;
                    el.checked = value;
                } else {
                    this._enhanceSimSavedValues[settingId] = el.value;
                    el.value = value;
                }
            }
        }
    }

    /**
     * Restore previously saved enhancement sim values when auto-detect is toggled off.
     */
    restoreEnhanceSimSavedValues() {
        if (!this._enhanceSimSavedValues) return;

        for (const [settingId, saved] of Object.entries(this._enhanceSimSavedValues)) {
            if (saved && typeof saved === 'object' && 'enabled' in saved) {
                // Compound gear setting
                const enabledEl = document.getElementById(`${settingId}_enabled`);
                const tierEl = document.getElementById(`${settingId}_tier`);
                const levelEl = document.getElementById(`${settingId}_level`);

                if (enabledEl) enabledEl.checked = saved.enabled;
                if (tierEl) tierEl.value = saved.tier;
                if (levelEl) levelEl.value = saved.level;
            } else if (typeof saved === 'boolean') {
                const el = document.getElementById(settingId);
                if (el) el.checked = saved;
            } else {
                const el = document.getElementById(settingId);
                if (el) el.value = saved;
            }
        }

        this._enhanceSimSavedValues = null;
    }

    /**
     * Build HTML for the enhancement sim computed stats summary.
     * @returns {string} HTML string
     */
    buildEnhanceSimSummaryHTML() {
        try {
            const params = getEnhancingParams();
            const fmt = (v) => (typeof v === 'number' ? v.toFixed(2).replace(/\.?0+$/, '') : v);
            return `
                <span style="color:#6b9fff; font-weight:bold;">Computed Stats</span><br>
                Effective Level: <span style="color:#e0e0e0;">${fmt(params.enhancingLevel)}</span> &nbsp;|&nbsp;
                Tool Success: <span style="color:#e0e0e0;">${fmt(params.toolBonus)}%</span> &nbsp;|&nbsp;
                Speed: <span style="color:#e0e0e0;">${fmt(params.speedBonus)}%</span><br>
                Drink Conc: <span style="color:#e0e0e0;">${fmt((params.guzzlingBonus - 1) * 100)}%</span> &nbsp;|&nbsp;
                Rare Find: <span style="color:#e0e0e0;">${fmt(params.rareFindBonus)}%</span> &nbsp;|&nbsp;
                Experience: <span style="color:#e0e0e0;">${fmt(params.experienceBonus)}%</span>
            `;
        } catch {
            return '<span style="color:#666;">Stats unavailable (game data not loaded)</span>';
        }
    }

    /**
     * Update the enhancement sim stats summary in place.
     */
    updateEnhanceSimSummary() {
        const el = document.getElementById('enhanceSim-stats-summary');
        if (el) {
            el.innerHTML = this.buildEnhanceSimSummaryHTML();
        }
    }

    /**
     * The characters this one could copy settings to.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async _otherKnownCharacters() {
        const knownCharacters = await this.config.getKnownCharacters();
        const currentId = this._currentCharacterId();
        return knownCharacters.filter((c) => c.id !== currentId);
    }

    /**
     * @returns {string} The character being played, as a string id
     */
    _currentCharacterId() {
        return String(dataManager.getCurrentCharacterId() || '');
    }

    /**
     * Handle sync settings to all characters
     */
    async handleSync() {
        const others = await this._otherKnownCharacters();

        if (others.length === 0) {
            alert('You only have one character. Settings are already saved for this character.');
            return;
        }

        this._openCopySettingsDialog({
            title: 'Copy Settings To',
            characters: others,
            describe: (count) => `Settings copied to ${count} character${count !== 1 ? 's' : ''}!`,
        });
    }

    /**
     * Copy this character's settings to the iron cows only.
     *
     * Same mechanics as the all-characters copy — same dialog, same per-character
     * checkboxes, the same whole-settings-map write — narrowed to the ids whose
     * *recorded* game mode says iron cow. A character whose mode was never
     * recorded is skipped and named rather than guessed at, and copying onto an
     * iron cow composes with Iron Cow Mode exactly as a manual edit does: the
     * values land, and that character's own force-disable pass owns them from
     * the next time its mode is applied.
     */
    async handleSyncIronCow() {
        const others = await this._otherKnownCharacters();
        const modes = await getCharacterGameModes();
        const { targets, unknown } = selectIronCowTargets(others, modes, this._currentCharacterId());

        if (targets.length === 0) {
            const names = unknown.map(characterLabel).join(', ');
            alert(
                unknown.length
                    ? 'No character is known to be an iron cow yet.\n\n' +
                          `Toolasha records a character's game mode when you play it, and has not seen ${names}. ` +
                          'Log in on each one once and try again.'
                    : 'No iron cow characters on this account.'
            );
            return;
        }

        this._openCopySettingsDialog({
            title: 'Copy Settings To Iron Cows',
            characters: targets,
            note: unknown.length
                ? `Skipped, game mode not recorded yet: ${unknown.map(characterLabel).join(', ')}`
                : '',
            describe: (count) => describeIronCowCopy(count, unknown),
        });
    }

    /**
     * The pick-your-characters dialog both copy buttons share.
     *
     * @param {Object} options - What to draw
     * @param {string} options.title - Dialog heading
     * @param {Array<{id: string, name: string}>} options.characters - Offered as checkboxes, all pre-ticked
     * @param {string} [options.note] - A line under the list, for what was left out
     * @param {Function} options.describe - Given the copied count, the message to show
     */
    _openCopySettingsDialog({ title: titleText, characters, note = '', describe }) {
        // Build a small modal with checkboxes for each character
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:${PANEL_Z_CAP + 1};display:flex;align-items:center;justify-content:center;`;

        const dialog = document.createElement('div');
        dialog.className = 'toolasha-copy-settings-dialog';
        dialog.style.cssText = `background:#1a1a2e;border:1px solid rgba(74,158,255,0.5);border-radius:10px;padding:20px;min-width:280px;font-family:'Segoe UI',sans-serif;color:#e0e0e0;`;

        const title = document.createElement('div');
        title.style.cssText = `font-size:14px;font-weight:700;color:#4a9eff;margin-bottom:12px;`;
        title.textContent = titleText;
        dialog.appendChild(title);

        const checkboxes = characters.map((char) => {
            const row = document.createElement('label');
            row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;`;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.value = char.id;
            const nameSpan = document.createElement('span');
            nameSpan.textContent = characterLabel(char);
            row.appendChild(cb);
            row.appendChild(nameSpan);
            dialog.appendChild(row);
            return cb;
        });

        if (note) {
            const noteEl = document.createElement('div');
            noteEl.className = 'toolasha-copy-settings-note';
            noteEl.style.cssText = 'font-size:11px;color:#aaa;margin-top:8px;line-height:1.4;max-width:320px;';
            noteEl.textContent = note;
            dialog.appendChild(noteEl);
        }

        const btnRow = document.createElement('div');
        btnRow.style.cssText = `display:flex;gap:8px;margin-top:16px;justify-content:flex-end;`;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `padding:6px 14px;border:1px solid #555;background:transparent;color:#aaa;border-radius:4px;cursor:pointer;`;

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy Settings';
        copyBtn.style.cssText = `padding:6px 14px;background:#4a9eff;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:600;`;

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(copyBtn);
        dialog.appendChild(btnRow);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });

        copyBtn.addEventListener('click', async () => {
            const selected = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
            if (selected.length === 0) {
                close();
                return;
            }
            close();
            const result = await this.config.syncSettingsToAllCharacters(selected);
            if (result.success) {
                alert(describe(result.count));
            } else {
                alert(`Failed to copy settings: ${result.error || 'Unknown error'}`);
            }
        });

        return overlay;
    }

    /**
     * Handle fetch latest prices
     * @param {HTMLElement} button - Button element for state updates
     */
    async handleFetchPrices(button) {
        // Disable button and show loading state
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = '⏳ Fetching...';

        try {
            // Clear cache and fetch fresh data
            const result = await marketAPI.clearCacheAndRefetch();

            if (result) {
                // Success - clear listing price display cache to force re-render
                document.querySelectorAll('.mwi-listing-prices-set').forEach((table) => {
                    table.classList.remove('mwi-listing-prices-set');
                });

                // Show success state
                button.textContent = '✅ Updated!';
                button.style.backgroundColor = '#00ff00';
                button.style.color = '#000';

                // Reset button after 2 seconds
                const resetSuccessTimeout = setTimeout(() => {
                    button.textContent = originalText;
                    button.style.backgroundColor = '';
                    button.style.color = '';
                    button.disabled = false;
                }, 2000);
                this.timerRegistry.registerTimeout(resetSuccessTimeout);
            } else {
                // Failed - show error state
                button.textContent = '❌ Failed';
                button.style.backgroundColor = '#ff0000';

                // Reset button after 3 seconds
                const resetFailureTimeout = setTimeout(() => {
                    button.textContent = originalText;
                    button.style.backgroundColor = '';
                    button.disabled = false;
                }, 3000);
                this.timerRegistry.registerTimeout(resetFailureTimeout);
            }
        } catch (error) {
            console.error('[SettingsUI] Fetch prices failed:', error);

            // Show error state
            button.textContent = '❌ Error';
            button.style.backgroundColor = '#ff0000';

            // Reset button after 3 seconds
            const resetErrorTimeout = setTimeout(() => {
                button.textContent = originalText;
                button.style.backgroundColor = '';
                button.disabled = false;
            }, 3000);
            this.timerRegistry.registerTimeout(resetErrorTimeout);
        }
    }

    /**
     * Handle reset to defaults
     */
    async handleReset() {
        if (!confirm('Reset all settings to defaults? This cannot be undone.')) {
            return;
        }

        await settingsStorage.resetToDefaults();
        await this.config.resetToDefaults();

        alert('Settings reset to defaults. Please refresh the page.');
        window.location.reload();
    }

    /**
     * Handle export settings
     */
    async handleExport() {
        const json = await settingsStorage.exportSettings();

        // Create download
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `toolasha-settings-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Handle import settings
     */
    async handleImport() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const result = await settingsStorage.importSettings(text);

                if (result) {
                    const msg =
                        `Settings imported successfully (${result.imported} keys imported` +
                        (result.skipped > 0 ? `, ${result.skipped} skipped from other characters` : '') +
                        '). Please refresh the page.';
                    alert(msg);
                    window.location.reload();
                } else {
                    alert('Failed to import settings. Please check the file format.');
                }
            } catch (error) {
                console.error('[Toolasha Settings] Import error:', error);
                alert('Failed to import settings.');
            }
        });

        input.click();
    }

    /**
     * Handle All Off — snapshots all checkbox values then sets them all to false.
     * @param {HTMLElement} [restoreBtn]
     */
    async handleAllOff(restoreBtn = this.restoreButton) {
        const snapshot = await saveBulkSnapshot();

        const off = {};
        for (const id of Object.keys(snapshot)) off[id] = false;
        writeCheckboxValues(off);
        for (const id of Object.keys(off)) {
            if (this.currentSettings[id]) this.currentSettings[id].isTrue = false;
        }

        this._reapplyModes();
        this._syncAllCheckboxInputs();
        this._refreshModeChips();
        this.applyDisabledByState();
        this.applySettingsFilter();
        if (restoreBtn) restoreBtn.style.display = '';
    }

    /**
     * Handle Restore — puts back the values from before the last bulk write,
     * whether that was All Off or a preset.
     * @param {HTMLElement} [restoreBtn]
     */
    async handleRestore(restoreBtn = this.restoreButton) {
        const snapshot = await loadBulkSnapshot();
        if (!snapshot) return;

        writeCheckboxValues(snapshot);
        for (const [id, value] of Object.entries(snapshot)) {
            if (this.currentSettings[id]) this.currentSettings[id].isTrue = value;
        }
        await clearBulkSnapshot();

        this._reapplyModes();
        this._syncAllCheckboxInputs();
        // Restore undoes the last bulk write, which never included a mode
        this._refreshModeChips();
        this.applyDisabledByState();
        this.applySettingsFilter();
        if (restoreBtn) restoreBtn.style.display = 'none';
    }

    /**
     * Syncs all checkbox DOM inputs to match their current config values.
     * Used after bulk changes (presets / All Off / Restore).
     */
    _syncAllCheckboxInputs() {
        for (const id of presetTargetIds()) {
            const entry = this.config.settingsMap[id];
            if (!entry) continue;
            const input = document.querySelector(`.toolasha-setting[data-setting-id="${id}"] input[type="checkbox"]`);
            if (input) input.checked = entry.isTrue ?? false;
        }
    }

    /**
     * Open variable-helper popup for freeform text settings with templateVariables.
     * @param {string} settingId - Setting ID
     */
    openTextVariablesHelper(settingId) {
        const setting = this.findSettingDef(settingId);
        if (!setting?.templateVariables?.length) return;

        const textInput = document.getElementById(settingId);
        if (!textInput) return;

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            z-index: ${PANEL_Z_CAP + 1};
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: #1a1a1a;
            border: 2px solid #3a3a3a;
            border-radius: 8px;
            padding: 20px;
            max-width: 500px;
            width: 90%;
            color: #e0e0e0;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            border-bottom: 2px solid #3a3a3a;
            padding-bottom: 10px;
        `;
        header.innerHTML = `
            <h3 style="margin:0; color:#e0e0e0;">Edit Template</h3>
            <button style="background:none; border:none; color:#e0e0e0; font-size:32px; cursor:pointer; padding:0; line-height:1;">×</button>
        `;
        header.querySelector('button').onclick = () => overlay.remove();

        const textareaLabel = document.createElement('p');
        textareaLabel.style.cssText = 'margin: 0 0 8px; font-size:13px; color:#9ca3af;';
        textareaLabel.textContent = 'Message text:';

        const textarea = document.createElement('textarea');
        textarea.value = textInput.value;
        textarea.style.cssText = `
            width: 100%;
            box-sizing: border-box;
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            color: #e0e0e0;
            font-size: 13px;
            padding: 8px;
            resize: vertical;
            min-height: 80px;
            margin-bottom: 16px;
            font-family: monospace;
        `;

        const varsLabel = document.createElement('p');
        varsLabel.style.cssText = 'margin: 0 0 8px; font-size:13px; color:#9ca3af;';
        varsLabel.textContent = 'Click a variable to insert it at the cursor:';

        const chipsRow = document.createElement('div');
        chipsRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; margin-bottom:20px;';

        for (const v of setting.templateVariables) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.style.cssText = `
                background: #2a4a7c;
                border: 1px solid #3a5a8c;
                border-radius: 4px;
                color: #e0e0e0;
                padding: 4px 10px;
                cursor: pointer;
                font-size: 13px;
            `;
            chip.title = v.description || '';
            chip.textContent = v.label;
            chip.onclick = () => {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const val = textarea.value;
                textarea.value = val.slice(0, start) + v.key + val.slice(end);
                textarea.selectionStart = textarea.selectionEnd = start + v.key.length;
                textarea.focus();
            };
            chipsRow.appendChild(chip);
        }

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            background: #3a3a3a; border: 1px solid #5a5a5a;
            border-radius: 4px; color: #e0e0e0;
            padding: 8px 16px; cursor: pointer; font-size: 13px;
        `;
        cancelBtn.onclick = () => overlay.remove();

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = `
            background: #4a7c59; border: 1px solid #5a8c69;
            border-radius: 4px; color: #e0e0e0;
            padding: 8px 16px; cursor: pointer; font-size: 13px;
        `;
        saveBtn.onclick = () => {
            textInput.value = textarea.value;
            textInput.dispatchEvent(new Event('change', { bubbles: true }));
            overlay.remove();
        };

        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        modal.appendChild(header);
        modal.appendChild(textareaLabel);
        modal.appendChild(textarea);
        modal.appendChild(varsLabel);
        modal.appendChild(chipsRow);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
        textarea.focus();
    }

    /**
     * Open template editor modal
     * @param {string} settingId - Setting ID
     */
    openTemplateEditor(settingId) {
        const setting = this.findSettingDef(settingId);
        if (!setting || !setting.templateVariables) {
            return;
        }

        const input = document.getElementById(settingId);
        let currentValue = setting.default;

        // Try to parse stored value
        if (input && input.value) {
            try {
                const parsed = JSON.parse(input.value);
                if (Array.isArray(parsed)) {
                    currentValue = parsed;
                }
            } catch (e) {
                console.error('[Settings] Failed to parse template value:', e);
            }
        }

        // Ensure currentValue is an array
        if (!Array.isArray(currentValue)) {
            currentValue = setting.default || [];
        }

        // Deep clone to avoid mutating original
        const templateItems = JSON.parse(JSON.stringify(currentValue));

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'toolasha-template-editor-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: ${PANEL_Z_CAP + 1};
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Create modal
        const modal = document.createElement('div');
        modal.className = 'toolasha-template-editor-modal';
        modal.style.cssText = `
            background: #1a1a1a;
            border: 2px solid #3a3a3a;
            border-radius: 8px;
            padding: 20px;
            max-width: 700px;
            width: 90%;
            max-height: 90%;
            overflow-y: auto;
            color: #e0e0e0;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            border-bottom: 2px solid #3a3a3a;
            padding-bottom: 10px;
        `;
        header.innerHTML = `
            <h3 style="margin: 0; color: #e0e0e0;">Edit Template</h3>
            <button class="toolasha-template-close-btn" style="
                background: none;
                border: none;
                color: #e0e0e0;
                font-size: 32px;
                cursor: pointer;
                padding: 0;
                line-height: 1;
            ">×</button>
        `;

        // Template list section
        const listSection = document.createElement('div');
        listSection.style.cssText = 'margin-bottom: 20px;';
        listSection.innerHTML =
            '<h4 style="margin: 0 0 10px 0; color: #e0e0e0;">Template Items (drag to reorder):</h4>';

        const listContainer = document.createElement('div');
        listContainer.className = 'toolasha-template-list';
        listContainer.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            padding: 10px;
            min-height: 200px;
            max-height: 300px;
            overflow-y: auto;
        `;

        const renderList = () => {
            listContainer.innerHTML = '';
            templateItems.forEach((item, index) => {
                const itemEl = this.createTemplateListItem(item, index, templateItems, renderList);
                listContainer.appendChild(itemEl);
            });
        };

        renderList();
        listSection.appendChild(listContainer);

        // Available variables section
        const variablesSection = document.createElement('div');
        variablesSection.style.cssText = 'margin-bottom: 20px;';
        variablesSection.innerHTML = '<h4 style="margin: 0 0 10px 0; color: #e0e0e0;">Add Variable:</h4>';

        const variablesContainer = document.createElement('div');
        variablesContainer.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        `;

        for (const variable of setting.templateVariables) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.textContent = '+  ' + variable.label;
            chip.title = variable.description;
            chip.style.cssText = `
                background: #2a2a2a;
                border: 1px solid #4a4a4a;
                border-radius: 4px;
                padding: 6px 12px;
                color: #e0e0e0;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            `;
            chip.onmouseover = () => {
                chip.style.background = '#3a3a3a';
                chip.style.borderColor = '#5a5a5a';
            };
            chip.onmouseout = () => {
                chip.style.background = '#2a2a2a';
                chip.style.borderColor = '#4a4a4a';
            };
            chip.onclick = () => {
                templateItems.push({
                    type: 'variable',
                    key: variable.key,
                    label: variable.label,
                });
                renderList();
            };
            variablesContainer.appendChild(chip);
        }

        // Add text button
        const addTextBtn = document.createElement('button');
        addTextBtn.type = 'button';
        addTextBtn.textContent = '+ Add Text';
        addTextBtn.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            padding: 6px 12px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.2s;
        `;
        addTextBtn.onmouseover = () => {
            addTextBtn.style.background = '#3a3a3a';
            addTextBtn.style.borderColor = '#5a5a5a';
        };
        addTextBtn.onmouseout = () => {
            addTextBtn.style.background = '#2a2a2a';
            addTextBtn.style.borderColor = '#4a4a4a';
        };
        addTextBtn.onclick = () => {
            const text = prompt('Enter text:');
            if (text !== null && text !== '') {
                templateItems.push({
                    type: 'text',
                    value: text,
                });
                renderList();
            }
        };

        variablesContainer.appendChild(addTextBtn);
        variablesSection.appendChild(variablesContainer);

        // Buttons
        const buttonsSection = document.createElement('div');
        buttonsSection.style.cssText = `
            display: flex;
            gap: 10px;
            justify-content: space-between;
            margin-top: 20px;
        `;

        // Restore to Default button (left side)
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.textContent = 'Restore to Default';
        restoreBtn.style.cssText = `
            background: #6b5b3a;
            border: 1px solid #8b7b5a;
            border-radius: 4px;
            padding: 8px 16px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 14px;
        `;
        restoreBtn.onclick = () => {
            if (confirm('Reset template to default? This will discard your current template.')) {
                // Reset to default
                templateItems.length = 0;
                const defaultTemplate = setting.default || [];
                templateItems.push(...JSON.parse(JSON.stringify(defaultTemplate)));
                renderList();
            }
        };

        // Right side buttons container
        const rightButtons = document.createElement('div');
        rightButtons.style.cssText = 'display: flex; gap: 10px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            padding: 8px 16px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 14px;
        `;
        cancelBtn.onclick = () => overlay.remove();

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = `
            background: #4a7c59;
            border: 1px solid #5a8c69;
            border-radius: 4px;
            padding: 8px 16px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 14px;
        `;
        saveBtn.onclick = () => {
            const input = document.getElementById(settingId);
            if (input) {
                input.value = JSON.stringify(templateItems);
                // Trigger change event
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            overlay.remove();
        };

        rightButtons.appendChild(cancelBtn);
        rightButtons.appendChild(saveBtn);

        buttonsSection.appendChild(restoreBtn);
        buttonsSection.appendChild(rightButtons);

        // Assemble modal
        modal.appendChild(header);
        modal.appendChild(listSection);
        modal.appendChild(variablesSection);
        modal.appendChild(buttonsSection);
        overlay.appendChild(modal);

        // Close button handler
        header.querySelector('.toolasha-template-close-btn').onclick = () => overlay.remove();

        // Close on overlay click
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        };

        // Add to page
        document.body.appendChild(overlay);
    }

    /**
     * Open custom price overrides editor modal
     */
    async openCustomPriceOverridesEditor() {
        const overrides = await getCustomPriceOverridesAsync();
        const gameData = dataManager.getInitClientData();
        const itemDetailMap = gameData?.itemDetailMap || {};

        // Build item list for search
        const allItems = Object.entries(itemDetailMap).map(([hrid, detail]) => ({
            hrid,
            name: detail.name || hrid.replace('/items/', ''),
        }));

        // Get sprite URL for item icons
        const spriteEl = document.querySelector('use[href*="items_sprite"]');
        const itemsSpriteUrl = spriteEl ? spriteEl.getAttribute('href').split('#')[0] : null;

        const createItemIcon = (itemHrid, size = 20) => {
            if (!itemsSpriteUrl) return null;
            const iconName = itemHrid.split('/').pop();
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', String(size));
            svg.setAttribute('height', String(size));
            svg.style.flexShrink = '0';
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${itemsSpriteUrl}#${iconName}`);
            svg.appendChild(use);
            return svg;
        };

        // Working copy of overrides
        const workingOverrides = JSON.parse(JSON.stringify(overrides));

        // Create overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: ${PANEL_Z_CAP + 1};
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Create modal
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: #1a1a1a;
            border: 2px solid #3a3a3a;
            border-radius: 8px;
            padding: 20px;
            max-width: 700px;
            width: 90%;
            max-height: 90%;
            overflow-y: auto;
            color: #e0e0e0;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            border-bottom: 2px solid #3a3a3a;
            padding-bottom: 10px;
        `;
        header.innerHTML = `
            <h3 style="margin: 0; color: #e0e0e0;">Custom Price Overrides</h3>
            <button class="toolasha-cpo-close-btn" style="
                background: none;
                border: none;
                color: #e0e0e0;
                font-size: 32px;
                cursor: pointer;
                padding: 0;
                line-height: 1;
            ">&times;</button>
        `;

        // Help text
        const helpText = document.createElement('div');
        helpText.style.cssText = `
            color: #888;
            font-size: 12px;
            margin-bottom: 16px;
            line-height: 1.4;
        `;
        helpText.textContent =
            'Set custom buy/sell prices for items. Leave a field blank to use the marketplace price. ' +
            'Overridden prices show * in profit displays.';

        // Search section
        const searchSection = document.createElement('div');
        searchSection.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
            align-items: flex-end;
            position: relative;
        `;

        // Search input wrapper (for dropdown positioning)
        const searchWrapper = document.createElement('div');
        searchWrapper.style.cssText = 'flex: 1; position: relative;';

        const searchLabel = document.createElement('div');
        searchLabel.style.cssText = 'font-size: 11px; color: #888; margin-bottom: 4px;';
        searchLabel.textContent = 'Item';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search items...';
        searchInput.style.cssText = `
            width: 100%;
            padding: 6px 10px;
            background: #2a2a2a;
            color: #e0e0e0;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            font-size: 13px;
            box-sizing: border-box;
        `;

        const dropdown = document.createElement('div');
        dropdown.style.cssText = `
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 0 0 4px 4px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 10;
            display: none;
        `;

        searchWrapper.appendChild(searchLabel);
        searchWrapper.appendChild(searchInput);
        searchWrapper.appendChild(dropdown);

        // Enhancement level input
        const enhWrapper = document.createElement('div');
        const enhLabel = document.createElement('div');
        enhLabel.style.cssText = 'font-size: 11px; color: #888; margin-bottom: 4px;';
        enhLabel.textContent = 'Enh';

        const enhInput = document.createElement('input');
        enhInput.type = 'number';
        enhInput.min = '0';
        enhInput.max = '20';
        enhInput.value = '0';
        enhInput.style.cssText = `
            width: 50px;
            padding: 6px 6px;
            background: #2a2a2a;
            color: #e0e0e0;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            font-size: 13px;
            text-align: center;
        `;

        enhWrapper.appendChild(enhLabel);
        enhWrapper.appendChild(enhInput);

        // Add button
        const addBtnWrapper = document.createElement('div');
        addBtnWrapper.style.cssText = 'padding-top: 15px;';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+';
        addBtn.style.cssText = `
            background: #4a7c59;
            border: 1px solid #5a8c69;
            border-radius: 4px;
            padding: 6px 12px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
        `;

        addBtnWrapper.appendChild(addBtn);

        searchSection.appendChild(searchWrapper);
        searchSection.appendChild(enhWrapper);
        searchSection.appendChild(addBtnWrapper);

        // Selected item tracker (object to avoid no-loop-func lint warning)
        const selection = { itemHrid: null };

        // Search functionality
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (query.length < 2) {
                dropdown.style.display = 'none';
                return;
            }

            const matches = allItems.filter((item) => item.name.toLowerCase().includes(query)).slice(0, 15);

            if (matches.length === 0) {
                dropdown.style.display = 'none';
                return;
            }

            dropdown.innerHTML = '';
            dropdown.style.display = 'block';

            for (const match of matches) {
                const option = document.createElement('div');
                option.style.cssText = `
                    padding: 6px 10px;
                    cursor: pointer;
                    font-size: 13px;
                    border-bottom: 1px solid #333;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                `;
                const optIcon = createItemIcon(match.hrid, 16);
                if (optIcon) option.appendChild(optIcon);
                const optName = document.createElement('span');
                optName.textContent = match.name;
                option.appendChild(optName);
                option.dataset.hrid = match.hrid;
                option.addEventListener('mouseover', () => {
                    option.style.background = '#3a3a3a';
                });
                option.addEventListener('mouseout', () => {
                    option.style.background = 'transparent';
                });
                option.addEventListener('click', (e) => {
                    const clickedOption = e.currentTarget;
                    searchInput.value = clickedOption.querySelector('span').textContent;
                    selection.itemHrid = clickedOption.dataset.hrid;
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(option);
            }
        });

        // Hide dropdown when clicking outside
        modal.addEventListener('click', (e) => {
            if (!searchWrapper.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });

        // Override table
        const tableContainer = document.createElement('div');
        tableContainer.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            min-height: 60px;
            max-height: 350px;
            overflow-y: auto;
        `;

        const renderTable = () => {
            tableContainer.innerHTML = '';

            const entries = Object.entries(workingOverrides);
            if (entries.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding: 20px; text-align: center; color: #666; font-size: 13px;';
                empty.textContent = 'No custom price overrides. Use the search bar above to add items.';
                tableContainer.appendChild(empty);
                return;
            }

            // Table header
            const headerRow = document.createElement('div');
            headerRow.style.cssText = `
                display: flex;
                align-items: center;
                padding: 8px 10px;
                border-bottom: 1px solid #4a4a4a;
                font-size: 11px;
                color: #888;
                font-weight: 600;
                gap: 8px;
            `;
            headerRow.innerHTML = `
                <div style="flex: 1;">Item</div>
                <div style="width: 80px; text-align: center;">Buy Price</div>
                <div style="width: 80px; text-align: center;">Sell Price</div>
                <div style="width: 28px;"></div>
            `;
            tableContainer.appendChild(headerRow);

            for (const [key, override] of entries) {
                const [itemHrid, enhLevel] = key.split(':');
                const enhNum = parseInt(enhLevel) || 0;
                const itemDetail = itemDetailMap[itemHrid];
                const itemName = itemDetail?.name || itemHrid.replace('/items/', '');
                const enhSuffix = enhNum > 0 ? ` +${enhNum}` : '';

                const row = document.createElement('div');
                row.style.cssText = `
                    display: flex;
                    align-items: center;
                    padding: 6px 10px;
                    border-bottom: 1px solid #333;
                    font-size: 13px;
                    gap: 8px;
                `;

                // Item name with icon
                const nameDiv = document.createElement('div');
                nameDiv.style.cssText =
                    'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px;';
                const icon = createItemIcon(itemHrid);
                if (icon) nameDiv.appendChild(icon);
                const nameSpan = document.createElement('span');
                nameSpan.textContent = itemName + enhSuffix;
                nameDiv.appendChild(nameSpan);

                // Buy price input
                const buyInput = document.createElement('input');
                buyInput.type = 'number';
                buyInput.min = '0';
                buyInput.placeholder = '--';
                buyInput.value = override.buy ?? '';
                buyInput.style.cssText = `
                    width: 80px;
                    padding: 4px 6px;
                    background: #1a1a1a;
                    color: #e0e0e0;
                    border: 1px solid #4a4a4a;
                    border-radius: 3px;
                    font-size: 13px;
                    text-align: right;
                `;
                buyInput.addEventListener('change', () => {
                    const val = buyInput.value.trim();
                    if (val === '') {
                        delete workingOverrides[key].buy;
                    } else {
                        workingOverrides[key].buy = Number(val);
                    }
                    // If both empty, remove the entry (0 is a valid override, not "unset")
                    if (workingOverrides[key].buy === undefined && workingOverrides[key].sell === undefined) {
                        delete workingOverrides[key];
                        renderTable();
                    }
                });

                // Sell price input
                const sellInput = document.createElement('input');
                sellInput.type = 'number';
                sellInput.min = '0';
                sellInput.placeholder = '--';
                sellInput.value = override.sell ?? '';
                sellInput.style.cssText = `
                    width: 80px;
                    padding: 4px 6px;
                    background: #1a1a1a;
                    color: #e0e0e0;
                    border: 1px solid #4a4a4a;
                    border-radius: 3px;
                    font-size: 13px;
                    text-align: right;
                `;
                sellInput.addEventListener('change', () => {
                    const val = sellInput.value.trim();
                    if (val === '') {
                        delete workingOverrides[key].sell;
                    } else {
                        workingOverrides[key].sell = Number(val);
                    }
                    // 0 is a valid override, not "unset"
                    if (workingOverrides[key].buy === undefined && workingOverrides[key].sell === undefined) {
                        delete workingOverrides[key];
                        renderTable();
                    }
                });

                // Remove button
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.textContent = '\u00d7';
                removeBtn.style.cssText = `
                    background: none;
                    border: none;
                    color: #888;
                    font-size: 18px;
                    cursor: pointer;
                    padding: 0 4px;
                    line-height: 1;
                `;
                removeBtn.addEventListener('mouseover', () => {
                    removeBtn.style.color = '#ff6b6b';
                });
                removeBtn.addEventListener('mouseout', () => {
                    removeBtn.style.color = '#888';
                });
                removeBtn.addEventListener('click', () => {
                    delete workingOverrides[key];
                    renderTable();
                });

                row.appendChild(nameDiv);
                row.appendChild(buyInput);
                row.appendChild(sellInput);
                row.appendChild(removeBtn);
                tableContainer.appendChild(row);
            }
        };

        renderTable();

        // Add button handler
        addBtn.addEventListener('click', () => {
            if (!selection.itemHrid) {
                // Try exact match from search text
                const searchText = searchInput.value.toLowerCase().trim();
                const exactMatch = allItems.find((item) => item.name.toLowerCase() === searchText);
                if (exactMatch) {
                    selection.itemHrid = exactMatch.hrid;
                } else {
                    return;
                }
            }

            const enhLevel = parseInt(enhInput.value) || 0;
            const key = `${selection.itemHrid}:${enhLevel}`;

            if (!workingOverrides[key]) {
                workingOverrides[key] = {};
            }

            // Reset search
            searchInput.value = '';
            enhInput.value = '0';
            selection.itemHrid = null;
            dropdown.style.display = 'none';

            renderTable();
        });

        // Buttons section
        const buttonsSection = document.createElement('div');
        buttonsSection.style.cssText = `
            display: flex;
            gap: 10px;
            justify-content: space-between;
            margin-top: 20px;
        `;

        const clearAllBtn = document.createElement('button');
        clearAllBtn.type = 'button';
        clearAllBtn.textContent = 'Clear All';
        clearAllBtn.style.cssText = `
            background: #6b3a3a;
            border: 1px solid #8b5a5a;
            border-radius: 4px;
            padding: 8px 16px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 14px;
        `;
        clearAllBtn.addEventListener('click', () => {
            if (Object.keys(workingOverrides).length === 0) return;
            if (!confirm('Remove all custom price overrides?')) return;
            for (const key of Object.keys(workingOverrides)) {
                delete workingOverrides[key];
            }
            renderTable();
        });

        const rightButtons = document.createElement('div');
        rightButtons.style.cssText = 'display: flex; gap: 10px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            padding: 8px 16px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 14px;
        `;
        cancelBtn.addEventListener('click', () => overlay.remove());

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = `
            background: #4a7c59;
            border: 1px solid #5a8c69;
            border-radius: 4px;
            padding: 8px 16px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 14px;
        `;
        saveBtn.addEventListener('click', async () => {
            // Determine what to add, update, and remove
            const currentOverrides = getCustomPriceOverrides();

            // Remove overrides that are no longer in working copy
            for (const key of Object.keys(currentOverrides)) {
                if (!workingOverrides[key]) {
                    const [itemHrid, enhLevel] = key.split(':');
                    await removeCustomPriceOverride(itemHrid, parseInt(enhLevel) || 0);
                }
            }

            // Add/update overrides
            for (const [key, override] of Object.entries(workingOverrides)) {
                const [itemHrid, enhLevel] = key.split(':');
                await setCustomPriceOverride(
                    itemHrid,
                    parseInt(enhLevel) || 0,
                    override.buy ?? null,
                    override.sell ?? null
                );
            }

            // Update the button text
            const btn = document.querySelector('.toolasha-custom-price-edit-btn');
            if (btn) {
                const count = Object.keys(workingOverrides).length;
                btn.textContent = `Manage Overrides${count > 0 ? ` (${count})` : ''}`;
            }

            overlay.remove();
        });

        rightButtons.appendChild(cancelBtn);
        rightButtons.appendChild(saveBtn);

        buttonsSection.appendChild(clearAllBtn);
        buttonsSection.appendChild(rightButtons);

        // Assemble modal
        modal.appendChild(header);
        modal.appendChild(helpText);
        modal.appendChild(searchSection);
        modal.appendChild(tableContainer);
        modal.appendChild(buttonsSection);
        overlay.appendChild(modal);

        // Close handlers
        header.querySelector('.toolasha-cpo-close-btn').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        document.body.appendChild(overlay);
    }

    /**
     * @param {Object} item - Template item
     * @param {number} index - Item index
     * @param {Array} items - All items
     * @param {Function} renderList - Callback to re-render list
     * @returns {HTMLElement} List item element
     */
    createTemplateListItem(item, index, items, renderList) {
        const itemEl = document.createElement('div');
        itemEl.draggable = true;
        itemEl.dataset.index = index;
        itemEl.style.cssText = `
            background: #1a1a1a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: move;
            transition: all 0.2s;
        `;

        // Drag handle
        const dragHandle = document.createElement('span');
        dragHandle.textContent = '⋮⋮';
        dragHandle.style.cssText = `
            color: #666;
            font-size: 16px;
            cursor: move;
        `;

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'flex: 1; color: #e0e0e0; font-size: 13px;';

        if (item.type === 'variable') {
            content.innerHTML = `<strong style="color: #4a9eff;">${item.label}</strong> <span style="color: #666; font-family: monospace;">${item.key}</span>`;
        } else {
            // Editable text
            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.value = item.value;
            textInput.style.cssText = `
                background: #2a2a2a;
                border: 1px solid #4a4a4a;
                border-radius: 3px;
                padding: 4px 8px;
                color: #e0e0e0;
                font-size: 13px;
                width: 100%;
            `;
            textInput.onchange = () => {
                items[index].value = textInput.value;
            };
            content.appendChild(textInput);
        }

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Remove';
        deleteBtn.style.cssText = `
            background: #8b0000;
            border: 1px solid #a00000;
            border-radius: 3px;
            color: #e0e0e0;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            padding: 4px 8px;
            transition: all 0.2s;
        `;
        deleteBtn.onmouseover = () => {
            deleteBtn.style.background = '#a00000';
        };
        deleteBtn.onmouseout = () => {
            deleteBtn.style.background = '#8b0000';
        };
        deleteBtn.onclick = () => {
            items.splice(index, 1);
            renderList();
        };

        // Drag events
        itemEl.ondragstart = (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', index);
            itemEl.style.opacity = '0.5';
        };

        itemEl.ondragend = () => {
            itemEl.style.opacity = '1';
        };

        itemEl.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            itemEl.style.borderColor = '#4a9eff';
        };

        itemEl.ondragleave = () => {
            itemEl.style.borderColor = '#4a4a4a';
        };

        itemEl.ondrop = (e) => {
            e.preventDefault();
            itemEl.style.borderColor = '#4a4a4a';

            const dragIndex = parseInt(e.dataTransfer.getData('text/plain'));
            const dropIndex = index;

            if (dragIndex !== dropIndex) {
                // Remove from old position
                const [movedItem] = items.splice(dragIndex, 1);
                // Insert at new position
                items.splice(dropIndex, 0, movedItem);
                renderList();
            }
        };

        itemEl.appendChild(dragHandle);
        itemEl.appendChild(content);
        itemEl.appendChild(deleteBtn);

        return itemEl;
    }

    /**
     * Sync all Iron Cow-locked setting DOM inputs to match their current config values.
     * Called after enabling or disabling Iron Cow so the UI reflects forced values.
     */
    _syncIronCowSettingInputs() {
        for (const id of IRON_COW_SETTINGS) {
            const entry = config.settingsMap[id];
            if (!entry) continue;
            const input = document.getElementById(id);
            if (!input) continue;
            if (entry.type === 'checkbox') {
                input.checked = entry.isTrue ?? false;
            } else {
                input.value = entry.value ?? '';
            }
        }
    }

    /**
     * Find setting definition by ID
     * @param {string} settingId - Setting ID
     * @returns {Object|null} Setting definition
     */
    findSettingDef(settingId) {
        for (const group of Object.values(settingsGroups)) {
            if (group.settings[settingId]) {
                return group.settings[settingId];
            }
        }
        return null;
    }

    /**
     * Cleanup for full shutdown (not character switching)
     * Unregisters event listeners and removes all DOM elements
     */
    cleanup() {
        // Clean up DOM elements first
        this.cleanupDOM();

        this.cancelPendingSettingsFilter();

        if (this.characterSwitchHandler) {
            dataManager.off('character_initialized', this.characterSwitchHandler);
            this.characterSwitchHandler = null;
        }

        this.timerRegistry.clearAll();
    }
}

const settingsUI = new SettingsUI();

export default settingsUI;
