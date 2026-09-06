/**
 * Foundation Core Library
 * Core infrastructure and API clients only (no utilities)
 *
 * Exports to: window.Toolasha.Core
 */

// Core modules
import storage from '../core/storage.js';
import config from '../core/config.js';
import webSocketHook from '../core/websocket.js';
import domObserver from '../core/dom-observer.js';
import dataManager from '../core/data-manager.js';
import connectionState from '../core/connection-state.js';
import featureRegistry from '../core/feature-registry.js';
// The error ring buffer the Diagnostics section reads. Namespace-imported so
// its functions arrive as one object other bundles reach through Core.
import * as errorLog from '../core/error-log.js';
import settingsStorage from '../core/settings-storage.js';
import { settingsGroups, getAllSettingIds, getSettingDefinition } from '../core/settings-schema.js';
import { setCurrentProfile, getCurrentProfile, clearCurrentProfile } from '../core/profile-manager.js';
import tooltipObserver from '../core/tooltip-observer.js';
import * as dualInstallGuard from '../core/dual-install-guard.js';
import performanceMonitor, { installIntervalTracing } from '../utils/performance-monitor.js';

// API modules
import marketAPI from '../api/marketplace.js';
// A market path, but marketAPI above is its caller, so the one live copy has to
// load here — every later bundle references it through Core (see rollup.config.js)
import networkAlert from '../features/market/network-alert.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Core = {
    storage,
    config,
    webSocketHook,
    domObserver,
    dataManager,
    connectionState,
    featureRegistry,
    errorLog,
    settingsStorage,
    settingsGroups,
    getAllSettingIds,
    getSettingDefinition,
    tooltipObserver,
    dualInstallGuard,
    profileManager: {
        setCurrentProfile,
        getCurrentProfile,
        clearCurrentProfile,
    },
    marketAPI,
    networkAlert,
    performanceMonitor,
    installIntervalTracing,
};

console.log('[Toolasha] Core library loaded');
