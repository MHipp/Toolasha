/**
 * Pinned Actions Page
 * Adds a "Pinned" button to the left nav bar that shows all pinned actions
 * in a consolidated list with skill, level, profit/hr, and XP/hr.
 * Columns are sortable (click header) and skill is filterable (⋮ button).
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import actionPanelSort from './action-panel-sort.js';
// Through the default export rather than as named imports: the combat sim panel
// is a bundle of its own, and a cross-bundle named import compiles to a property
// read off a global that carries only that default
import combatSimUI from '../combat-sim/combat-sim-ui.js';
import { calculateGatheringProfit } from './gathering-profit.js';
import { calculateProductionProfit } from './production-profit.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';
import { calculateExperienceMultiplier } from '../../utils/experience-parser.js';
import { numberFormatter } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { calculateMaterialRequirements } from '../../utils/material-calculator.js';
import assetManifest from '../../utils/asset-manifest.js';
import { capProfitRate, sellsFromProfitData, liquidityMarkerHtml } from '../../utils/liquidity-cap.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';

const GATHERING_TYPES = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

const COLUMNS = [
    { key: 'name', label: 'Action', align: 'left', filterable: false },
    { key: 'skill', label: 'Skill', align: 'left', filterable: true },
    { key: 'level', label: 'Lv', align: 'left', filterable: false },
    { key: 'profitPerHour', label: 'Profit/hr', align: 'right', filterable: false },
    { key: 'expPerHour', label: 'XP/hr', align: 'right', filterable: false },
];

const GRID_COLUMNS = '28px 1fr 120px 50px 90px 90px';

/**
 * Get game object via React fiber tree traversal
 * @returns {Object|null} Game component instance
 */
function getGameObject() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function find(fiber) {
        if (!fiber) return null;
        if (fiber.stateNode?.handleGoToAction) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Format skill name from action type HRID
 * @param {string} typeHrid - e.g. "/action_types/milking"
 * @returns {string} Display name, e.g. "Milking"
 */
function formatSkillName(typeHrid) {
    if (!typeHrid) return 'Unknown';
    const slug = typeHrid.split('/').pop();
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * Format profit/xp number compactly
 * @param {number|null} value - Value to format
 * @returns {string} Formatted string or '-'
 */
function formatCompact(value) {
    if (value === null || value === undefined) return '-';
    const abs = Math.abs(value);
    let formatted;
    if (abs >= 1e9) {
        formatted = (value / 1e9).toFixed(1) + 'B';
    } else if (abs >= 1e6) {
        formatted = (value / 1e6).toFixed(1) + 'M';
    } else if (abs >= 1e3) {
        formatted = (value / 1e3).toFixed(1) + 'K';
    } else {
        formatted = numberFormatter(value);
    }
    return formatted;
}

/**
 * How long ago, in the roughest terms that are still true.
 * @param {number|null} timestamp - Epoch milliseconds
 * @param {number} [now] - Epoch milliseconds to measure from
 * @returns {string} e.g. `3d ago`, or '' when there is no timestamp
 */
export function formatAge(timestamp, now = Date.now()) {
    if (!timestamp) return '';
    const minutes = Math.max(0, Math.round((now - timestamp) / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

/**
 * The last all-zones simulation, as rows this table can rank.
 *
 * Combat is the one thing the pinned list could never answer — a zone is not a
 * pinnable action, so "is fighting worth more than milking right now" had no
 * page to be asked on. A finished simulation already knows, and this is the
 * shape it has to be in to sit beside a gathering action.
 *
 * Rows carry when they were measured and whether the gear has moved since,
 * because a profit figure from a loadout you no longer wear is not wrong so much
 * as about somebody else.
 *
 * @param {Object|null} snapshot - From `combatSimUI.loadAllZonesSnapshot`
 * @param {string|null} currentFingerprint - From `combatSimUI.currentGearFingerprint`
 * @returns {Array<Object>} Rows in the same shape as a pinned action
 */
export function combatZoneRows(snapshot, currentFingerprint) {
    if (!snapshot || !Array.isArray(snapshot.zones)) return [];

    // Only a mismatch between two known signatures means anything: an unsigned
    // run, or a character whose gear cannot be read, is not evidence of change
    const gearChanged = Boolean(
        snapshot.fingerprint && currentFingerprint && snapshot.fingerprint !== currentFingerprint
    );

    return snapshot.zones
        .filter((zone) => zone?.zoneHrid)
        .map((zone) => {
            const tier = zone.difficultyTier ?? 0;
            const zoneName = zone.zoneName || zone.zoneHrid.split('/').pop().replace(/_/g, ' ');

            return {
                // Namespaced by tier: one zone is several rows, and they must not
                // collide with each other or with a pinned action's own key
                actionHrid: `${zone.zoneHrid}|T${tier}`,
                baseActionHrid: zone.zoneHrid,
                name: `${zoneName} T${tier}`,
                skill: 'Combat',
                type: '/action_types/combat',
                outputItemHrid: null,
                // Not a level requirement in the sense the column means — a zone
                // asks for gear, not a number — so it sorts with the unknowns
                level: null,
                profitPerHour: Number.isFinite(zone.profitPerHour) ? zone.profitPerHour : null,
                expPerHour: Number.isFinite(zone.xpPerHour) ? zone.xpPerHour : null,
                // What the run said it would sell each hour — the snapshot's
                // profit figure is the sim's raw claim, and this is what lets
                // the display bound it by market volume at read time
                sells: Array.isArray(zone.sells) ? zone.sells : [],
                source: 'combat-sim',
                simulatedAt: snapshot.savedAt ?? null,
                gearChanged,
            };
        });
}

class PinnedActionsPage {
    constructor() {
        this.navButton = null;
        this.pageContainer = null;
        this.isActive = false;
        this.navigationObserver = null;
        this.unregisterObserver = null;
        this.unregisterReady = null;
        this.timerRegistry = createTimerRegistry();
        this.navInjected = false;
        this.hiddenElements = [];

        // Sort state
        this.sortColumn = 'skill';
        this.sortDirection = 'asc';

        // Filter state
        this.selectedSkills = []; // empty = show all

        // Filter popup state
        this.activeFilterPopup = null;
        this.activeFilterButton = null;
        this.popupCloseHandler = null;

        // Cached action data (computed once per showPage, re-sorted/filtered in place)
        this.allActions = [];

        // Tab state
        this.activeTab = 'overview'; // 'overview' | 'materials'
        this.itemsSpriteUrl = null; // cached items sprite URL

        // Content area div (child of pageContainer, replaced on tab switch)
        this.contentArea = null;

        // Game nav deactivation (so clicking the previously-active skill re-triggers navigation)
        this.deactivatedNavItem = null;
        this.deactivatedNavClass = null; // the exact hashed class removed, for restore

        // Nav click interceptor (hides pinned page when user clicks a game nav item)
        this.navClickInterceptor = null;
    }

    /**
     * Initialize the pinned actions page feature
     */
    initialize() {
        if (!config.getSetting('actions_pinnedPage')) return;

        this.unregisterObserver = domObserver.onClass('PinnedActionsPage', 'NavigationBar_nav', () => {
            if (!this.navInjected) {
                this.injectNavButton();
            }
        });

        // @run-at document-start: a nav bar rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('PinnedActionsPageCatchUp', () => {
            const existingNav = document.querySelector('[class*="NavigationBar_nav"]');
            if (existingNav && !this.navInjected) {
                this.injectNavButton();
            }
        });
    }

    /**
     * Inject the "Pinned" nav button above the first skill in the nav bar
     */
    injectNavButton() {
        const navLinks = document.querySelector('[class*="NavigationBar_navigationLinks"]');
        if (!navLinks) return;

        this.navInjected = true;

        const btn = document.createElement('div');
        btn.className = 'mwi-pinned-nav';
        btn.style.cssText = `
            padding: 4px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.85em;
            color: ${config.COLOR_ACCENT};
            border-left: 3px solid transparent;
            transition: background 0.15s, border-color 0.15s;
            user-select: none;
            margin-bottom: 2px;
        `;

        btn.innerHTML = `<span style="font-size: 1.1em;">📌</span><span>Pinned</span>`;

        btn.addEventListener('mouseenter', () => {
            if (!this.isActive) {
                btn.style.background = 'rgba(255, 255, 255, 0.05)';
            }
        });

        btn.addEventListener('mouseleave', () => {
            if (!this.isActive) {
                btn.style.background = '';
            }
        });

        btn.addEventListener('click', () => {
            if (this.isActive) {
                this.hidePage();
            } else {
                this.showPage();
            }
        });

        navLinks.insertBefore(btn, navLinks.firstChild);
        this.navButton = btn;
    }

    /**
     * Show the pinned actions page, replacing the main content
     */
    showPage() {
        if (this.isActive) return;

        const mainPanel = document.querySelector('[class*="MainPanel_mainPanel"]');
        if (!mainPanel) return;

        this.isActive = true;
        this.updateNavButtonState(true);
        this.deactivateGameNav();
        this.startNavClickInterceptor();

        this.hiddenElements = [];
        for (const child of mainPanel.children) {
            if (child !== this.pageContainer) {
                this.hiddenElements.push({ el: child, prevDisplay: child.style.display });
                child.style.display = 'none';
            }
        }

        this.pageContainer = document.createElement('div');
        this.pageContainer.className = 'mwi-pinned-page';
        this.pageContainer.style.cssText = `
            width: 100%;
            height: 100%;
            overflow-y: auto;
            padding: 16px;
            box-sizing: border-box;
        `;
        mainPanel.appendChild(this.pageContainer);

        this._onPinChange = () => this.loadActions();
        actionPanelSort.onPinChange(this._onPinChange);

        this.loadActions();
        this.setupNavigationObserver(mainPanel);
    }

    /**
     * Load action data, painting immediately and filling in figures as they resolve.
     *
     * The pinned-action figures a cold session has to compute can genuinely be
     * slow: a fresh liquidity check (`computeStats` → `capProfitRate`) is a real
     * network round trip to a pooled-history server nobody has asked yet this
     * session (see `capProfitRate` in ../../utils/liquidity-cap.js and
     * `dailyVolume`/`sellThrottle` in ../planner/market-liquidity.js), and it pays
     * that cost in full the first time — nothing warms it at startup. With several
     * pinned actions, awaiting each one before building the next row used to queue
     * their costs one after another; a page with a single slow row could leave
     * every other row unpainted behind it for as long as that one took.
     *
     * So the rows themselves are built synchronously from whatever is already
     * known (a cached stat, or the pin itself) and painted before anything is
     * awaited. Whichever rows still need `computeStats` are marked `pending` and
     * resolved concurrently in the background; each one repaints only its own row
     * when it lands, without blocking or reordering the rest.
     */
    async loadActions() {
        const pinnedActions = actionPanelSort.getPinnedActions();
        this.allActions = [];
        const pendingResolutions = [];

        for (const pinnedKey of pinnedActions) {
            let actionHrid = pinnedKey;
            let pinnedItemHrid = null;
            if (pinnedKey.includes('|')) {
                const parts = pinnedKey.split('|');
                actionHrid = parts[0];
                pinnedItemHrid = parts[1];
            }

            const details = dataManager.getActionDetails(actionHrid);
            if (!details) continue;

            let displayName = details.name;
            if (pinnedItemHrid) {
                const itemDetails = dataManager.getItemDetails(pinnedItemHrid);
                if (itemDetails) {
                    displayName = `${details.name} ${itemDetails.name}`;
                }
            }

            const cachedStats = actionPanelSort.getCachedStats(pinnedKey);
            const isWarm = cachedStats && cachedStats.profitPerHour !== undefined;

            const row = {
                actionHrid: pinnedKey,
                baseActionHrid: actionHrid,
                name: displayName,
                skill: formatSkillName(details.type),
                type: details.type,
                outputItemHrid: pinnedItemHrid || details.outputItems?.[0]?.itemHrid || null,
                level: details.levelRequirement?.level ?? 0,
                profitPerHour: isWarm ? (cachedStats.profitPerHour ?? null) : null,
                expPerHour: isWarm ? (cachedStats.expPerHour ?? null) : null,
                liquidityLimit: isWarm ? (cachedStats.liquidityLimit ?? null) : null,
                // Distinct from a resolved `null` (computed, nothing to report):
                // this row hasn't been computed yet, and must say so rather than
                // read as a method that simply makes nothing.
                pending: !isWarm,
            };

            this.allActions.push(row);

            if (!isWarm) {
                pendingResolutions.push(this._resolveRowStats(row, actionHrid, details, pinnedItemHrid));
            }
        }

        // Everything known so far — cached rows in full, the rest marked pending —
        // paints now. Combat zones and the item sprite lag a little further behind
        // (both already fast, see the class doc measurements) rather than holding
        // up the first paint too.
        this.renderTable();

        pendingResolutions.push(this._resolveCombatZones());
        pendingResolutions.push(this._resolveItemsSprite());

        await Promise.all(pendingResolutions);
    }

    /**
     * Compute one pinned row's stats and repaint it in place once they land.
     * Never throws: `computeStats` already catches internally, and if a rejection
     * still reaches here the row settles as unpriced (`pending: false`, no figure)
     * rather than being stuck showing "measuring…" forever.
     * @param {Object} row - The row object pushed into `this.allActions`, mutated in place
     * @param {string} actionHrid - Action HRID
     * @param {Object} details - Action details from dataManager
     * @param {string|null} pinnedItemHrid - Pinned alchemy item, if any
     */
    async _resolveRowStats(row, actionHrid, details, pinnedItemHrid) {
        try {
            const stats = await this.computeStats(actionHrid, details, pinnedItemHrid);
            row.profitPerHour = stats?.profitPerHour ?? null;
            row.expPerHour = stats?.expPerHour ?? null;
            row.liquidityLimit = stats?.liquidityLimit ?? null;
        } catch (error) {
            // computeStats already catches everything itself; this is a second net
            // so a row can never be left pending forever (or take the rest of the
            // page's rows down with it via Promise.all) over a future regression.
            console.error('[PinnedActionsPage] Resolving stats failed for', actionHrid, error);
            row.profitPerHour = null;
            row.expPerHour = null;
        } finally {
            row.pending = false;
            this.repaintIfActive();
        }
    }

    /**
     * Load the simulated combat zones and repaint once they're in.
     */
    async _resolveCombatZones() {
        await this.loadSimulatedCombatZones();
        this.repaintIfActive();
    }

    /**
     * Fetch the items sprite (once) and repaint once it's in.
     */
    async _resolveItemsSprite() {
        if (this.itemsSpriteUrl) return;
        this.itemsSpriteUrl = await assetManifest.getSpriteUrl('items');
        this.repaintIfActive();
    }

    /**
     * Repaint the current tab, but only while this page is still the one on
     * screen. A row can resolve well after the user closed the page (or closed
     * and reopened it, starting a new `this.allActions`) — in either case the
     * resolved row is no longer part of what would be drawn, and rebuilding a
     * torn-down or superseded page would be either wasted work or a bug.
     */
    repaintIfActive() {
        if (!this.isActive || !this.contentArea) return;
        this.renderContent();
    }

    /**
     * Add the last all-zones simulation's zones to the list.
     *
     * Read from storage rather than from the simulator panel, so the rows are
     * here on a fresh page load with the panel never opened — which is the only
     * way this is worth anything, since nobody re-runs a ten-minute simulation
     * to decide what to do next.
     */
    async loadSimulatedCombatZones() {
        try {
            const snapshot = await combatSimUI.loadAllZonesSnapshot();
            if (!snapshot) return;

            const fingerprint = await combatSimUI.currentGearFingerprint();
            const rows = combatZoneRows(snapshot, fingerprint);

            // The snapshot stores the sim's raw claim; this page ranks zones
            // against skilling actions, so the pace shown is bounded by how
            // fast the loot actually sells — marked, never silently
            for (const row of rows) {
                if (!(row.profitPerHour > 0) || !row.sells?.length) continue;
                const capped = await capProfitRate({ goldPerHour: row.profitPerHour, sells: row.sells });
                if (capped.capped) {
                    row.uncappedProfitPerHour = row.profitPerHour;
                    row.profitPerHour = capped.goldPerHour;
                    row.liquidityLimit = capped.limit;
                }
            }

            this.allActions.push(...rows);
        } catch (error) {
            console.error('[PinnedActionsPage] Loading simulated combat zones failed:', error);
        }
    }

    /**
     * Get filtered and sorted actions based on current state
     * @returns {Array} Filtered and sorted action array
     */
    getFilteredSorted() {
        let actions = [...this.allActions];

        // Apply skill filter
        if (this.selectedSkills.length > 0) {
            const skillSet = new Set(this.selectedSkills);
            actions = actions.filter((a) => skillSet.has(a.skill));
        }

        // Apply sort
        const col = this.sortColumn;
        const dir = this.sortDirection === 'asc' ? 1 : -1;

        actions.sort((a, b) => {
            const aVal = a[col];
            const bVal = b[col];

            // Nulls sort last regardless of direction
            if (aVal === null && bVal === null) return 0;
            if (aVal === null) return 1;
            if (bVal === null) return -1;

            if (typeof aVal === 'string') {
                return dir * aVal.localeCompare(bVal);
            }
            return dir * (aVal - bVal);
        });

        return actions;
    }

    /**
     * Render the full page (header + tab bar + content area)
     * Called on initial load, filter change, sort change
     */
    renderTable() {
        if (!this.pageContainer) return;
        this.closeFilterPopup();

        const actions = this.getFilteredSorted();

        // Clear container
        while (this.pageContainer.firstChild) {
            this.pageContainer.removeChild(this.pageContainer.firstChild);
        }
        this.contentArea = null;

        // Title
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            padding-bottom: 8px;
            border-bottom: 1px solid #444;
        `;
        header.innerHTML = `
            <span style="font-size: 1.3em;">📌</span>
            <span style="font-size: 1.1em; font-weight: bold;">Pinned Actions</span>
            <span style="color: #888; font-size: 0.85em;">(${actions.length})</span>
        `;
        this.pageContainer.appendChild(header);

        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.style.cssText = `
            display: flex;
            gap: 0;
            margin-bottom: 12px;
            border-bottom: 1px solid #444;
        `;

        for (const tab of ['overview', 'materials']) {
            const label = tab === 'overview' ? 'Overview' : 'Materials';
            const btn = document.createElement('button');
            btn.dataset.tab = tab;
            btn.textContent = label;
            const isActive = this.activeTab === tab;
            btn.style.cssText = `
                background: none;
                border: none;
                border-bottom: 2px solid ${isActive ? config.COLOR_ACCENT : 'transparent'};
                color: ${isActive ? '#fff' : '#888'};
                padding: 6px 16px;
                cursor: pointer;
                font-size: 0.9em;
                font-weight: ${isActive ? '600' : '400'};
                margin-bottom: -1px;
                transition: color 0.15s, border-color 0.15s;
            `;
            btn.addEventListener('click', () => {
                if (this.activeTab === tab) return;
                this.activeTab = tab;
                // Update tab button styles
                tabBar.querySelectorAll('button').forEach((b) => {
                    const active = b.dataset.tab === tab;
                    b.style.borderBottomColor = active ? config.COLOR_ACCENT : 'transparent';
                    b.style.color = active ? '#fff' : '#888';
                    b.style.fontWeight = active ? '600' : '400';
                });
                this.renderContent();
            });
            tabBar.appendChild(btn);
        }
        this.pageContainer.appendChild(tabBar);

        // Content area
        this.contentArea = document.createElement('div');
        this.pageContainer.appendChild(this.contentArea);

        this.renderContent();
    }

    /**
     * Render only the content area (tab switch — no header/tab bar rebuild)
     */
    renderContent() {
        if (!this.contentArea) return;
        while (this.contentArea.firstChild) {
            this.contentArea.removeChild(this.contentArea.firstChild);
        }
        if (this.activeTab === 'materials') {
            this.renderMaterialsTab();
        } else {
            this.renderOverviewTab();
        }
    }

    /**
     * Render the overview tab (profit/hr, XP/hr table)
     */
    renderOverviewTab() {
        const actions = this.getFilteredSorted();

        if (this.allActions.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align: center; padding: 40px 20px; color: #999;';
            empty.innerHTML = `
                <div style="font-size: 2em; margin-bottom: 12px;">📌</div>
                <div style="font-size: 1.1em; margin-bottom: 8px;">No pinned actions</div>
                <div style="font-size: 0.85em; color: #666;">
                    Pin actions using the 📌 icon on action tiles to see them here.
                </div>
            `;
            this.contentArea.appendChild(empty);
            return;
        }

        // Column headers
        const headerRow = document.createElement('div');
        headerRow.style.cssText = `
            display: grid;
            grid-template-columns: ${GRID_COLUMNS};
            gap: 8px;
            padding: 4px 8px;
            font-size: 0.75em;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 2px solid #555;
            user-select: none;
        `;

        // Empty header for icon column
        const iconHeader = document.createElement('div');
        headerRow.appendChild(iconHeader);

        for (const col of COLUMNS) {
            const th = document.createElement('div');
            th.style.cssText = `
                display: flex;
                align-items: center;
                gap: 4px;
                ${col.align === 'right' ? 'justify-content: flex-end;' : ''}
            `;

            // Sort label
            const label = document.createElement('span');
            label.style.cursor = 'pointer';
            let labelText = col.label;
            if (this.sortColumn === col.key) {
                labelText += this.sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
            }
            label.textContent = labelText;

            label.addEventListener('click', () => {
                if (this.sortColumn === col.key) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortColumn = col.key;
                    this.sortDirection = col.key === 'name' || col.key === 'skill' ? 'asc' : 'desc';
                }
                this.renderTable();
            });

            th.appendChild(label);

            // Filter button for filterable columns
            if (col.filterable) {
                const filterBtn = document.createElement('button');
                filterBtn.textContent = '\u22EE';
                const hasActive = this.selectedSkills.length > 0;
                filterBtn.style.cssText = `
                    background: none;
                    border: none;
                    color: ${hasActive ? '#4a90e2' : '#aaa'};
                    cursor: pointer;
                    font-size: 14px;
                    padding: 2px 4px;
                    font-weight: bold;
                `;

                filterBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showSkillFilterPopup(filterBtn);
                });

                th.appendChild(filterBtn);
            }

            headerRow.appendChild(th);
        }

        this.contentArea.appendChild(headerRow);

        // Data rows
        for (let ri = 0; ri < actions.length; ri++) {
            const action = actions[ri];
            const profitColor =
                action.profitPerHour === null
                    ? '#888'
                    : action.profitPerHour >= 0
                      ? config.COLOR_PROFIT || '#5fda5f'
                      : config.COLOR_LOSS || '#ff6b6b';
            const profitPrefix = action.profitPerHour !== null && action.profitPerHour > 0 ? '+' : '';
            const rowBg = ri % 2 === 1 ? 'rgba(255, 255, 255, 0.03)' : 'transparent';
            // A row still being computed (the profit figure is a real network
            // round trip the first time — see loadActions' doc comment) says so
            // rather than showing '-', which reads as "there is nothing here"
            // instead of "this hasn't arrived yet".
            const profitText = action.pending ? 'measuring…' : `${profitPrefix}${formatCompact(action.profitPerHour)}`;
            const expText = action.pending ? 'measuring…' : formatCompact(action.expPerHour);

            const row = document.createElement('div');
            row.className = 'mwi-pinned-row';
            row.dataset.actionHrid = action.actionHrid;
            row.dataset.rowBg = rowBg;
            row.style.cssText = `
                display: grid;
                grid-template-columns: ${GRID_COLUMNS};
                gap: 8px;
                padding: 8px;
                cursor: pointer;
                border-radius: 4px;
                transition: background 0.15s;
                align-items: center;
                background: ${rowBg};
            `;

            const iconSlug = action.outputItemHrid ? action.outputItemHrid.split('/').pop() : '';
            const iconHtml =
                this.itemsSpriteUrl && iconSlug
                    ? `<svg width="24" height="24"><use href="${this.itemsSpriteUrl}#${iconSlug}"></use></svg>`
                    : '';

            row.innerHTML = `
                <span style="display: flex; align-items: center; justify-content: center;">${iconHtml}</span>
                <span style="font-weight: 500; text-align: left;">${action.name}${this.provenanceHtml(action)}</span>
                <span style="color: #aaa; font-size: 0.9em; text-align: left;">${action.skill}</span>
                <span style="color: #aaa; text-align: left;">${action.level ?? '—'}</span>
                <span style="text-align: right; color: ${action.pending ? '#888' : profitColor}; ${action.pending ? 'font-style: italic;' : ''}">
                    ${profitText}${action.pending ? '' : liquidityMarkerHtml(action.liquidityLimit, { compact: true })}
                </span>
                <span style="text-align: right; color: ${action.pending ? '#888' : '#7ec8e3'}; ${action.pending ? 'font-style: italic;' : ''}">
                    ${expText}
                </span>
            `;

            row.addEventListener('mouseenter', () => {
                row.style.background = 'rgba(255, 255, 255, 0.08)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.background = row.dataset.rowBg || 'transparent';
            });
            row.addEventListener('click', () => {
                const game = getGameObject();
                if (game?.handleGoToAction) {
                    this.hidePage(true);
                    game.handleGoToAction(action.baseActionHrid);
                }
            });

            this.contentArea.appendChild(row);
        }

        // No results after filtering
        if (actions.length === 0 && this.allActions.length > 0) {
            const noResults = document.createElement('div');
            noResults.style.cssText = 'text-align: center; padding: 20px; color: #888;';
            noResults.textContent = 'No actions match the current filter.';
            this.contentArea.appendChild(noResults);
        }
    }

    /**
     * Where a simulated row's numbers came from, and whether to believe them.
     *
     * A pinned action's figures are computed from the market this second; a
     * combat zone's are from whenever the simulation was run, in whatever was
     * being worn then. Saying so is the difference between a comparison and a
     * trap.
     *
     * @param {Object} action - A row from `getFilteredSorted`
     * @returns {string} HTML, empty for rows computed live
     */
    provenanceHtml(action) {
        if (action.source !== 'combat-sim') return '';

        const age = formatAge(action.simulatedAt);
        const simulated = age
            ? `<span style="color: #666; font-size: 0.8em; margin-left: 6px;" title="From the last all-zones simulation">sim ${age}</span>`
            : '';
        const stale = action.gearChanged
            ? `<span style="color: #d9a441; font-size: 0.8em; margin-left: 6px;"
                title="Your equipment has changed since this zone was simulated — re-run the all-zones simulation for current numbers">gear changed since</span>`
            : '';

        return `${simulated}${stale}`;
    }

    /**
     * Render the materials tab (per-production-action material breakdown)
     */
    async renderMaterialsTab() {
        const contentArea = this.contentArea;
        if (!contentArea) return;

        // Fetch/use cached sprite URL
        if (!this.itemsSpriteUrl) {
            this.itemsSpriteUrl = await assetManifest.getSpriteUrl('items');
            // Guard: content area may have changed while awaiting
            if (contentArea !== this.contentArea) return;
        }

        const actions = this.getFilteredSorted();
        // Simulated combat zones consume no materials and have no recipe to walk
        const productionActions = actions.filter((a) => !GATHERING_TYPES.includes(a.type) && a.source !== 'combat-sim');

        if (productionActions.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align: center; padding: 40px 20px; color: #999;';
            empty.textContent = 'No production actions pinned';
            contentArea.appendChild(empty);
            return;
        }

        let first = true;
        for (const action of productionActions) {
            const materials = calculateMaterialRequirements(action.actionHrid, 1, false);
            if (!materials || materials.length === 0) continue;

            const canProduce = Math.max(0, Math.min(...materials.map((m) => Math.floor(m.have / m.required))));

            // Action group header row
            const groupHeader = document.createElement('div');
            groupHeader.style.cssText = `
                display: grid;
                grid-template-columns: 36px 1fr auto;
                align-items: center;
                gap: 8px;
                padding: 8px;
                border-bottom: 1px solid #fff;
                ${first ? '' : 'border-top: 1px solid #333;'}
            `;
            first = false;

            // Output item icon
            const iconEl = document.createElement('div');
            iconEl.style.cssText =
                'display: flex; align-items: center; justify-content: center; width: 36px; height: 36px;';
            if (this.itemsSpriteUrl && action.outputItemHrid) {
                const slug = action.outputItemHrid.split('/').pop();
                iconEl.innerHTML = `<svg width="28" height="28"><use href="${this.itemsSpriteUrl}#${slug}"></use></svg>`;
            }

            // Action name
            const nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-weight: 500;';
            nameEl.textContent = action.name;

            // Can produce count
            const canProduceEl = document.createElement('div');
            canProduceEl.style.cssText = `font-size: 0.85em; color: ${canProduce > 0 ? config.COLOR_PROFIT : config.COLOR_LOSS};`;
            canProduceEl.textContent = `Can produce: ${canProduce.toLocaleString()}`;

            groupHeader.appendChild(iconEl);
            groupHeader.appendChild(nameEl);
            groupHeader.appendChild(canProduceEl);
            contentArea.appendChild(groupHeader);

            // Material rows
            for (let i = 0; i < materials.length; i++) {
                const m = materials[i];
                const rowBg = i % 2 === 1 ? 'rgba(255, 255, 255, 0.03)' : 'transparent';
                const matRow = document.createElement('div');
                matRow.style.cssText = `
                    display: grid;
                    grid-template-columns: 16px 1fr 100px;
                    align-items: center;
                    gap: 8px;
                    padding: 4px 8px;
                    background: ${rowBg};
                `;

                const spacer = document.createElement('div');

                const matName = document.createElement('div');
                matName.style.cssText = 'font-size: 0.85em; color: #ccc; text-align: left;';
                matName.textContent = m.itemName;

                const haveNeeded = document.createElement('div');
                const sufficient = m.have >= m.required;
                haveNeeded.style.cssText = `font-size: 0.85em; text-align: right; color: ${sufficient ? config.COLOR_PROFIT : config.COLOR_LOSS};`;
                haveNeeded.textContent = `${m.have.toLocaleString()} / ${m.required.toLocaleString()}`;

                matRow.appendChild(spacer);
                matRow.appendChild(matName);
                matRow.appendChild(haveNeeded);
                contentArea.appendChild(matRow);
            }
        }
    }

    /**
     * Show skill filter popup below the filter button
     * @param {HTMLElement} buttonElement - The filter button
     */
    showSkillFilterPopup(buttonElement) {
        // Toggle close if same button
        if (this.activeFilterPopup && this.activeFilterButton === buttonElement) {
            this.closeFilterPopup();
            return;
        }

        this.closeFilterPopup();

        // Get unique skills from all actions
        const skills = [...new Set(this.allActions.map((a) => a.skill))].sort();

        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 12px;
            min-width: 180px;
            max-height: 300px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'Filter by Skill';
        title.style.cssText = 'color: #fff; font-weight: bold; margin-bottom: 10px; font-size: 0.85em;';
        popup.appendChild(title);

        // Checkbox container
        const checkboxContainer = document.createElement('div');
        checkboxContainer.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 10px;';

        for (const skill of skills) {
            const label = document.createElement('label');
            label.style.cssText = `
                display: block;
                color: #fff;
                padding: 4px 0;
                cursor: pointer;
                font-size: 0.85em;
            `;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.selectedSkills.length === 0 || this.selectedSkills.includes(skill);
            checkbox.style.marginRight = '6px';

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(skill));
            checkboxContainer.appendChild(label);
        }

        popup.appendChild(checkboxContainer);

        // Buttons row
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px;';

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.8em;
        `;

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1;
            padding: 6px;
            background: #666;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.8em;
        `;

        applyBtn.addEventListener('click', () => {
            const checked = [];
            checkboxContainer.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
                if (cb.checked) checked.push(skills[i]);
            });
            // If all are checked, treat as no filter
            this.selectedSkills = checked.length === skills.length ? [] : checked;
            this.closeFilterPopup();
            this.renderTable();
        });

        clearBtn.addEventListener('click', () => {
            this.selectedSkills = [];
            this.closeFilterPopup();
            this.renderTable();
        });

        btnRow.appendChild(applyBtn);
        btnRow.appendChild(clearBtn);
        popup.appendChild(btnRow);

        // Position below button
        const rect = buttonElement.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = `${rect.bottom + 5}px`;
        popup.style.left = `${rect.left}px`;
        popup.style.zIndex = '10002';

        document.body.appendChild(popup);
        this.activeFilterPopup = popup;
        this.activeFilterButton = buttonElement;

        // Close on outside click (delayed to avoid immediate close)
        const closeTimeout = setTimeout(() => {
            this.popupCloseHandler = (e) => {
                if (!popup.contains(e.target) && e.target !== buttonElement) {
                    this.closeFilterPopup();
                }
            };
            document.addEventListener('click', this.popupCloseHandler);
        }, 10);
        this.timerRegistry.registerTimeout(closeTimeout);
    }

    /**
     * Close any open filter popup
     */
    closeFilterPopup() {
        if (this.activeFilterPopup) {
            this.activeFilterPopup.remove();
            this.activeFilterPopup = null;
            this.activeFilterButton = null;
        }
        if (this.popupCloseHandler) {
            document.removeEventListener('click', this.popupCloseHandler);
            this.popupCloseHandler = null;
        }
    }

    /**
     * Compute profit/hr and XP/hr for an action on demand
     * @param {string} actionHrid - Action HRID
     * @param {Object} details - Action details from dataManager
     * @returns {Object|null} { profitPerHour, expPerHour }
     */
    async computeStats(actionHrid, details, pinnedItemHrid = null) {
        try {
            let profitPerHour = null;
            let expPerHour = null;
            let sells = [];

            if (pinnedItemHrid && actionHrid.startsWith('/actions/alchemy/')) {
                const alchemyType = actionHrid.replace('/actions/alchemy/', '');
                const profitData = this._computeAlchemyStats(alchemyType, pinnedItemHrid);
                profitPerHour = profitData?.profitPerHour ?? null;
                expPerHour = profitData?.expPerHour ?? null;
                sells = profitData?.sells ?? [];
            } else {
                const isGathering = GATHERING_TYPES.includes(details.type);
                if (isGathering) {
                    const profitData = await calculateGatheringProfit(actionHrid);
                    profitPerHour = profitData?.profitPerHour ?? null;
                    sells = sellsFromProfitData(profitData);
                } else {
                    const profitData = await calculateProductionProfit(actionHrid);
                    profitPerHour = profitData?.profitPerHour ?? null;
                    sells = sellsFromProfitData(profitData);
                }

                const expData = calculateExpPerHour(actionHrid);
                expPerHour = expData?.expPerHour ?? null;
            }

            // The ranking seam: the pace this table sorts by is bounded by how
            // fast the outputs actually trade, and a bounded row carries the
            // marker payload the renderer must draw
            let liquidityLimit = null;
            if (profitPerHour > 0 && sells.length) {
                const capped = await capProfitRate({ goldPerHour: profitPerHour, sells });
                if (capped.capped) {
                    profitPerHour = capped.goldPerHour;
                    liquidityLimit = capped.limit;
                }
            }

            const stats = { profitPerHour, expPerHour, liquidityLimit };
            if (!actionPanelSort.cachedStats) actionPanelSort.cachedStats = {};
            const cacheKey = pinnedItemHrid ? `${actionHrid}|${pinnedItemHrid}` : actionHrid;
            actionPanelSort.cachedStats[cacheKey] = stats;

            return stats;
        } catch (error) {
            console.error('[PinnedActionsPage] Failed to compute stats for', actionHrid, error);
            return null;
        }
    }

    /**
     * Compute profit/hr and XP/hr for an alchemy action + item combo
     * @param {string} alchemyType - 'coinify', 'decompose', or 'transmute'
     * @param {string} itemHrid - Item HRID
     * @returns {Object|null} { profitPerHour, expPerHour }
     */
    _computeAlchemyStats(alchemyType, itemHrid) {
        try {
            let profitData;
            if (alchemyType === 'transmute') {
                profitData = alchemyProfitCalculator.calculateTransmuteProfit(itemHrid);
            } else if (alchemyType === 'decompose') {
                profitData = alchemyProfitCalculator.calculateDecomposeProfit(itemHrid, 0);
            } else {
                profitData = alchemyProfitCalculator.calculateCoinifyProfit(itemHrid, 0);
            }

            if (!profitData) return null;

            const itemDetails = dataManager.getItemDetails(itemHrid);
            const itemLevel = itemDetails?.itemLevel || 1;

            const baseXP = this._getAlchemyBaseXP(alchemyType, itemLevel);
            const xpData = calculateExperienceMultiplier('/skills/alchemy', '/action_types/alchemy');
            const fullXP = baseXP * xpData.totalMultiplier;
            const expectedXP = profitData.successRate * fullXP + (1 - profitData.successRate) * fullXP * 0.1;
            const expPerHour = profitData.actionsPerHour * expectedXP;

            return { profitPerHour: profitData.profitPerHour, expPerHour, sells: sellsFromProfitData(profitData) };
        } catch (error) {
            console.error('[PinnedActionsPage] Failed to compute alchemy stats:', error);
            return null;
        }
    }

    _getAlchemyBaseXP(actionType, itemLevel) {
        switch (actionType) {
            case 'coinify':
                return itemLevel + 10;
            case 'decompose':
                return itemLevel * 1.4 + 14;
            case 'transmute':
                return itemLevel * 1.6 + 16;
            default:
                return 0;
        }
    }

    /**
     * Hide the pinned page and restore original content
     * @param {boolean} [navigatedAway=false] - True if hiding because user navigated to a skill
     */
    hidePage(navigatedAway = false) {
        if (!this.isActive) return;

        this.closeFilterPopup();

        if (this._onPinChange) {
            actionPanelSort.offPinChange(this._onPinChange);
            this._onPinChange = null;
        }

        for (const { el, prevDisplay } of this.hiddenElements) {
            el.style.display = prevDisplay;
        }
        this.hiddenElements = [];

        if (this.pageContainer) {
            this.pageContainer.remove();
            this.pageContainer = null;
        }

        if (this.navigationObserver) {
            this.navigationObserver.disconnect();
            this.navigationObserver = null;
        }

        this.isActive = false;
        this.updateNavButtonState(false);
        this.stopNavClickInterceptor();

        // Only restore the old nav highlight if user toggled Pinned off (not when navigating away,
        // since the game already activated the new skill's nav item)
        if (!navigatedAway) {
            this.restoreGameNav();
        } else {
            this.deactivatedNavItem = null;
            this.deactivatedNavClass = null;
        }
    }

    /**
     * Update nav button visual state
     * @param {boolean} active - Whether the pinned page is active
     */
    updateNavButtonState(active) {
        if (!this.navButton) return;
        if (active) {
            this.navButton.style.borderLeftColor = config.COLOR_ACCENT;
            this.navButton.style.background = 'rgba(255, 255, 255, 0.08)';
        } else {
            this.navButton.style.borderLeftColor = 'transparent';
            this.navButton.style.background = '';
        }
    }

    /**
     * Remove the active class from the game's currently-selected nav item
     * so that clicking it again triggers a real navigation event.
     *
     * Prefix match, because the class carries a build hash that changes with
     * game updates (a hardcoded hash here went stale once already) — and the
     * matched name is remembered so restore puts back exactly what was removed.
     */
    deactivateGameNav() {
        const activeNav = document.querySelector('[class*="NavigationBar_active"]');
        const activeClass = activeNav && [...activeNav.classList].find((c) => c.includes('NavigationBar_active'));
        if (activeClass) {
            this.deactivatedNavItem = activeNav;
            this.deactivatedNavClass = activeClass;
            activeNav.classList.remove(activeClass);
        }
    }

    /**
     * Restore the active class to the nav item we deactivated
     */
    restoreGameNav() {
        if (this.deactivatedNavItem && this.deactivatedNavClass) {
            this.deactivatedNavItem.classList.add(this.deactivatedNavClass);
        }
        this.deactivatedNavItem = null;
        this.deactivatedNavClass = null;
    }

    /**
     * Start listening for clicks on game nav items while pinned page is active.
     * When a game nav item is clicked, hide the pinned page and let the game navigate.
     */
    startNavClickInterceptor() {
        this.stopNavClickInterceptor();

        const navParent = this.navButton?.parentElement;
        if (!navParent) return;

        this.navClickInterceptor = (e) => {
            if (!this.isActive) return;

            // Ignore clicks on the Pinned button itself (its handler manages show/hide)
            if (this.navButton && this.navButton.contains(e.target)) return;

            const clickedNav = e.target.closest('[class*="NavigationBar_nav"]');
            if (!clickedNav) return;

            // Full teardown (unhide game content, unregister pin-change handler, disconnect
            // observers) before the game navigates
            this.hidePage(true);
        };

        navParent.addEventListener('click', this.navClickInterceptor);
    }

    /**
     * Stop the nav click interceptor
     */
    stopNavClickInterceptor() {
        if (this.navClickInterceptor) {
            const navParent = this.navButton?.parentElement;
            if (navParent) {
                navParent.removeEventListener('click', this.navClickInterceptor);
            }
            this.navClickInterceptor = null;
        }
    }

    /**
     * Watch for React replacing the main panel content (user navigated to a skill)
     * @param {HTMLElement} mainPanel - The MainPanel_mainPanel element
     */
    setupNavigationObserver(mainPanel) {
        if (this.navigationObserver) {
            this.navigationObserver.disconnect();
        }

        this.navigationObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (
                        node.nodeType === Node.ELEMENT_NODE &&
                        node !== this.pageContainer &&
                        node.className?.includes?.('MainPanel_subPanelContainer')
                    ) {
                        this.hidePage(true);
                        return;
                    }
                }
            }
        });

        this.navigationObserver.observe(mainPanel, { childList: true });
    }

    /**
     * Disable the feature and clean up
     */
    disable() {
        try {
            if (this.isActive) {
                this.hidePage();
            }

            if (this.navButton) {
                this.navButton.remove();
                this.navButton = null;
            }

            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            if (this.unregisterReady) {
                this.unregisterReady();
                this.unregisterReady = null;
            }

            if (this.navigationObserver) {
                this.navigationObserver.disconnect();
                this.navigationObserver = null;
            }

            this.closeFilterPopup();
            this.stopNavClickInterceptor();
            this.timerRegistry.clearAll();
            this.navInjected = false;
        } catch (error) {
            console.error('[Pinned Actions Page] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
        }
    }
}

const pinnedActionsPage = new PinnedActionsPage();

export default pinnedActionsPage;
