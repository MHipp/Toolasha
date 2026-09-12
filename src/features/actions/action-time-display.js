/**
 * Action Time Display Module
 *
 * Displays estimated completion time for queued actions.
 * Uses WebSocket data from data-manager instead of DOM scraping.
 *
 * Features:
 * - Appends stats to game's action name (queue count, time/action, actions/hr)
 * - Shows time estimates below (total time → completion time)
 * - Updates automatically on action changes
 * - Queue tooltip enhancement (time for each action + total)
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import tooltipObserver from '../../core/tooltip-observer.js';
import marketAPI from '../../api/marketplace.js';
import { calculateGatheringProfit } from './gathering-profit.js';
import profitCalculator from '../market/profit-calculator.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import itemFlowRecorder from '../networth/item-flow-recorder.js';
import { GATHERING_ACTION_TYPES, lootEntryValue } from '../networth/gold-sources.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { getAlchemyCoinCost, getAlchemyTypeFromActionHrid } from '../../utils/alchemy-fees.js';
import { timeReadable, formatWithSeparator, formatDateTime } from '../../utils/formatters.js';
import { calculateEfficiencyMultiplier } from '../../utils/efficiency.js';
import { getCommunityGatheringQuantity } from '../../utils/community-buffs.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { isMobileMode } from '../../utils/mobile.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import {
    parseArtisanBonus,
    getDrinkConcentration,
    parseGatheringBonus,
    parseGourmetBonus,
} from '../../utils/tea-parser.js';
import { getAlchemySuccessBonus } from '../../utils/buff-parser.js';
import { getItemPrices } from '../../utils/market-data.js';
import { capProfitData, liquidityMarkerHtml } from '../../utils/liquidity-cap.js';
import { badgeHtml, calibrationBadgeFor } from '../../utils/calibration-badge.js';
import {
    calculateProductionActionTotalsFromBase,
    calculateGatheringActionTotalsFromBase,
    calculateActionsPerHour,
    calculateEffectiveActionsPerHour,
} from '../../utils/profit-helpers.js';
import { calculateEnhancementPredictions } from '../enhancement/enhancement-xp.js';
import { BASE_SUCCESS_RATES } from '../../utils/enhancement-calculator.js';
import { parseGameNumber, gameDigitsSource } from '../../utils/number-parser.js';

/**
 * Format a completion Date as a clock string, respecting user's time/date format settings.
 * @param {Date} completionTime
 * @param {boolean} includeDate - Whether to include the date portion
 * @returns {string}
 */
function formatCompletionTime(completionTime, includeDate) {
    return formatDateTime(completionTime, { includeDate, includeTime: true, includeSeconds: true });
}

// Marks a native QueuedActions edit-menu once Toolasha has enhanced it, so the width contract
// below and the row-wrapping rules only ever apply to that specific popup - never to unrelated
// MUI tooltips/poppers elsewhere in the game.
// The one protection item that is spent on every attempt rather than only on a failure: it
// guarantees the enhancement, so both the attempt count and its cost are exact.
const PHILOSOPHERS_MIRROR_HRID = '/items/philosophers_mirror';

const QUEUE_EDIT_MENU_MARKER_CLASS = 'toolasha-queue-edit-menu-enhanced';
const QUEUE_EDIT_MENU_STYLE_ID = 'toolasha-queue-edit-menu-width-styles';

// The native popup declares no width, so it sizes to its intrinsic content and Toolasha's own
// injected timing/profit rows drive it: measured 164px with short rows and 338px once a row
// carries a "Complete at ..." suffix. 414px is the preferred desktop inner width; on constrained
// viewports it shrinks continuously (min() formula) rather than switching at a fixed breakpoint,
// staying fully on-screen. dvw is preferred where supported, falling back to vw.
const QUEUE_EDIT_MENU_CSS = `
.${QUEUE_EDIT_MENU_MARKER_CLASS} {
    width: min(414px, calc(100vw - 64px));
    max-width: min(414px, calc(100vw - 64px));
    min-width: min(280px, calc(100vw - 64px));
    box-sizing: border-box;
}
@supports (width: 100dvw) {
    .${QUEUE_EDIT_MENU_MARKER_CLASS} {
        width: min(414px, calc(100dvw - 64px));
        max-width: min(414px, calc(100dvw - 64px));
        min-width: min(280px, calc(100dvw - 64px));
    }
}
.${QUEUE_EDIT_MENU_MARKER_CLASS} .mwi-queue-action-time,
.${QUEUE_EDIT_MENU_MARKER_CLASS} .mwi-queue-action-profit {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
    box-sizing: border-box;
}
`;

/**
 * ActionTimeDisplay class manages the time display panel and queue tooltips
 */

/**
 * Whether an element in the action-name row was put there by a script rather
 * than by the game — Toolasha's own annotations all carry an `mwi-` class or
 * id, and anything else following that convention is equally not part of the
 * action's name.
 * @param {Element} node - A child of the action name element
 * @returns {boolean}
 */
function isScriptAnnotation(node) {
    const className = typeof node.className === 'string' ? node.className : '';
    return className.includes('mwi-') || String(node.id || '').startsWith('mwi-');
}

/** Below this many seconds the boundary is not worth a tooltip about it. */
const PARTIAL_PROGRESS_NOTE_THRESHOLD_SECONDS = 0.05;

/**
 * A small "ⓘ" the ETA line carries whenever it has subtracted time already spent on the
 * action currently in progress, so the boundary `getElapsedSecondsInCurrentUnit` tracks is
 * named rather than left as an unexplained few seconds of drift between what the queue count
 * implies and what the clock actually shows.
 *
 * Pure and returns markup rather than a DOM node because it slots straight into the
 * template-literal `innerHTML` builds the ETA line already uses, and disappears with them
 * whenever that line is cleared or replaced.
 *
 * @param {number} elapsedInCurrentUnit - Seconds already spent on the in-progress unit,
 *   from `dataManager.getElapsedSecondsInCurrentUnit`
 * @returns {string} HTML, or '' when there is nothing worth explaining
 */
export function partialProgressNote(elapsedInCurrentUnit) {
    if (!(elapsedInCurrentUnit > PARTIAL_PROGRESS_NOTE_THRESHOLD_SECONDS)) return '';
    const seconds = elapsedInCurrentUnit.toFixed(1);
    return (
        ` <span title="Counts only what's left: ${seconds}s already spent on the action in progress is not ` +
        `charged again" style="cursor:help; opacity:0.6;">ⓘ</span>`
    );
}

/**
 * The inventory count trailing an action name, e.g. "Coinify: Item (4,312)" → 4312.
 *
 * Digits only, no decimal — an inventory count is always a whole number — and
 * grouped by the game's current locale, not always a comma: a hardcoded
 * `[\d,]+` reads "(4.312)" as "(4)" in a period-grouping locale, long before
 * the value is even parsed.
 *
 * @param {string} actionNameText - The action name, with any appended stats already stripped
 * @returns {number|null} The count, or null when the text carries none
 */
export function parseInventoryCountFromActionName(actionNameText) {
    const match = String(actionNameText || '').match(new RegExp(`\\((${gameDigitsSource({ decimal: false })})\\)$`));
    if (!match) return null;
    const count = Math.trunc(parseGameNumber(match[1]));
    return Number.isFinite(count) ? count : null;
}

class ActionTimeDisplay {
    constructor() {
        this.displayElement = null;
        this.profitElement = null;
        this.runElement = null;
        this.isInitialized = false;
        this.updateTimer = null;
        this.unregisterQueueObserver = null;
        this.actionNameObserver = null;
        this.queueMenuObserver = null; // Observer for queue menu mutations
        this.unregisterActionNameObserver = null;
        this.characterInitHandler = null; // Handler for character switch
        this.activeProfitCalculationId = null; // Track active profit calculation to prevent race conditions
        this.activeBarProfitId = null;
        this.waitForPanelTimeout = null;
        this.retryUpdateTimeout = null;
        this.cleanupRegistry = createCleanupRegistry();
    }

    /**
     * Initialize the action time display
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        // Set up setting change listeners for all action bar toggles (registered once,
        // before the enabled check, so toggling the feature back on works without a reload)
        if (!this.settingListenersRegistered) {
            this.settingListenersRegistered = true;
            const actionBarSettings = [
                'actionBar_enabled',
                'actionBar_compactWidth',
                'actionBar_showQueueCount',
                'actionBar_showActionDuration',
                'actionBar_showActionsPerHour',
                'actionBar_showTimeRemaining',
                'profitCalc_pricingMode',
            ];
            for (const key of actionBarSettings) {
                config.onSettingChange(key, (newValue) => {
                    if (key === 'actionBar_enabled') {
                        if (newValue) {
                            this.initialize().catch((error) => {
                                console.error('[ActionTimeDisplay] Re-initialization failed:', error);
                            });
                        } else {
                            this.disable();
                        }
                        return;
                    }
                    this.updateDisplay();
                });
            }
        }

        if (!config.getSetting('actionBar_enabled')) {
            return;
        }

        // Set up handler for character switching
        if (!this.characterInitHandler) {
            this.characterInitHandler = () => {
                this.handleCharacterSwitch();
            };
            dataManager.on('character_initialized', this.characterInitHandler);
            this.cleanupRegistry.registerCleanup(() => {
                if (this.characterInitHandler) {
                    dataManager.off('character_initialized', this.characterInitHandler);
                    this.characterInitHandler = null;
                }
            });
        }

        // Listen for actions_updated so display refreshes when new actions arrive via WebSocket
        // (the DOM updates optimistically before the WS message, so the mutation observer fires
        // before characterActions is populated — this ensures we retry once the data is available)
        if (!this.actionsUpdatedHandler) {
            this.actionsUpdatedHandler = () => {
                this.updateDisplay();
            };
            dataManager.on('actions_updated', this.actionsUpdatedHandler);
            this.cleanupRegistry.registerCleanup(() => {
                if (this.actionsUpdatedHandler) {
                    dataManager.off('actions_updated', this.actionsUpdatedHandler);
                    this.actionsUpdatedHandler = null;
                }
            });
        }

        this.cleanupRegistry.registerCleanup(() => {
            const actionNameElement = document.querySelector('div[class*="Header_actionName"]');
            if (actionNameElement) {
                this.clearAppendedStats(actionNameElement);
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            if (this.waitForPanelTimeout) {
                clearTimeout(this.waitForPanelTimeout);
                this.waitForPanelTimeout = null;
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            if (this.retryUpdateTimeout) {
                clearTimeout(this.retryUpdateTimeout);
                this.retryUpdateTimeout = null;
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            if (this.updateTimer) {
                clearInterval(this.updateTimer);
                this.updateTimer = null;
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            if (this.actionNameObserver) {
                this.actionNameObserver();
                this.actionNameObserver = null;
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            if (this.queueMenuObserver) {
                this.queueMenuObserver();
                this.queueMenuObserver = null;
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            if (this.unregisterActionNameObserver) {
                this.unregisterActionNameObserver();
                this.unregisterActionNameObserver = null;
            }
        });

        // Wait for action name element to exist
        this.waitForActionPanel();

        this.initializeActionNameWatcher();

        // Initialize queue tooltip observer
        this.initializeQueueObserver();

        // Initialize queue hover tooltip observer
        this.initializeQueueTooltipObserver();

        this.isInitialized = true;
    }

    /**
     * Initialize observer for queue tooltip
     */
    initializeQueueObserver() {
        this.ensureQueueEditMenuStyles();

        // Register with centralized DOM observer to watch for queue menu
        this.unregisterQueueObserver = domObserver.onClass(
            'ActionTimeDisplay-Queue',
            'QueuedActions_queuedActionsEditMenu',
            (queueMenu) => {
                // classList.add is a no-op if already present, so repeated mounts/reorders of the
                // same element can never duplicate the marker.
                queueMenu.classList.add(QUEUE_EDIT_MENU_MARKER_CLASS);

                this.injectQueueTimes(queueMenu);

                this.setupQueueMenuObserver(queueMenu);
            }
        );

        this.cleanupRegistry.registerCleanup(() => {
            if (this.unregisterQueueObserver) {
                this.unregisterQueueObserver();
                this.unregisterQueueObserver = null;
            }
        });

        this.cleanupRegistry.registerCleanup(() => {
            removeStyles(QUEUE_EDIT_MENU_STYLE_ID);
        });
    }

    /**
     * Inject the Queued Actions edit-menu width stylesheet once. Idempotent so re-initializing
     * (e.g. disabling and re-enabling the feature) never appends a duplicate `<style>` element.
     */
    ensureQueueEditMenuStyles() {
        if (document.getElementById(QUEUE_EDIT_MENU_STYLE_ID)) {
            return;
        }
        addStyles(QUEUE_EDIT_MENU_CSS, QUEUE_EDIT_MENU_STYLE_ID);
    }

    /**
     * Initialize observer for queue hover tooltip (the MUI Tooltip that appears on hover over "+N Queued Actions")
     */
    initializeQueueTooltipObserver() {
        tooltipObserver.subscribe('queue-tooltip-timing', (element, eventType) => {
            if (eventType !== 'opened') return;

            // Identify queue tooltip by its unique class
            const tooltipContent = element.querySelector('[class*="QueuedActions_queuedActionsTooltip"]');
            if (!tooltipContent) return;

            this.injectQueueTimesTooltip(tooltipContent);
        });

        this.cleanupRegistry.registerCleanup(() => {
            tooltipObserver.unsubscribe('queue-tooltip-timing');
        });
    }

    /**
     * Inject time display into queue hover tooltip
     * Reuses matchActionFromDiv and calculation logic from injectQueueTimes,
     * but simplified (no mutation observer, no async profit).
     * @param {HTMLElement} tooltipContent - The QueuedActions_queuedActionsTooltip container
     */
    injectQueueTimesTooltip(tooltipContent) {
        if (!config.getSetting('actionQueue')) return;
        try {
            const currentActions = dataManager.getCurrentActions();
            if (!currentActions || currentActions.length === 0) return;

            const actionDivs = tooltipContent.querySelectorAll('[class*="QueuedActions_action__"]');
            if (actionDivs.length === 0) return;

            // Content-keyed guard against duplicate/stale injection. tooltip-observer.js
            // redelivers a popper as freshly "opened" once it has genuinely left and
            // returned to the document — which is what happens when the game closes this
            // tooltip and later reuses the same popper element for the next hover of the
            // same "+N Queued Actions" badge. Between those two hovers the queue keeps
            // moving (actions complete, get reordered, or are edited), so a guard that only
            // checks "was anything injected before" — with no key describing which queue
            // state that was for — would find the previous hover's leftover
            // `.mwi-queue-action-time` markers and skip re-injection entirely, leaving the
            // stale time/total on screen under the new queue state. Same guard shape fixed
            // for tooltip-prices.js (6dc52988) and dungeon-token-tooltips.js (d3101317).
            const contentKey = `${actionDivs.length}|${currentActions
                .map((a) => `${a.id}:${a.currentCount}:${a.maxCount ?? ''}:${a.ordinal}`)
                .join(',')}`;
            if (tooltipContent.dataset.mwiQueueContentKey === contentKey) return;
            tooltipContent.dataset.mwiQueueContentKey = contentKey;
            tooltipContent
                .querySelectorAll('.mwi-queue-action-time, .mwi-queue-tooltip-total')
                .forEach((el) => el.remove());

            const inventoryLookup = this.buildInventoryLookup(dataManager.getInventory());

            let accumulatedTime = 0;
            let hasInfinite = false;
            // Sticky: once a row's figure rests on credited expected yield, every clock built
            // on the running total after it does too.
            let hasEstimate = false;

            // Include current action time in total (same as edit menu)
            const currentActionTime = this.calculateCurrentActionTime(currentActions, inventoryLookup);
            if (currentActionTime) {
                accumulatedTime += currentActionTime.totalTime;
                if (currentActionTime.hasInfinite) hasInfinite = true;
            }

            // Track used action IDs to prevent duplicate matching
            const usedActionIds = new Set();
            if (currentActionTime?.actionId) {
                usedActionIds.add(currentActionTime.actionId);
            }

            for (const actionDiv of actionDivs) {
                const actionObj = this.matchActionFromDiv(actionDiv, currentActions, usedActionIds);

                if (!actionObj) {
                    this.appendTimeToActionDiv(actionDiv, '[Unknown action]');
                    continue;
                }

                usedActionIds.add(actionObj.id);

                const actionDetails = dataManager.getActionDetails(actionObj.actionHrid);
                if (!actionDetails) continue;

                // The walk costs each row against what its predecessors left, so a counted
                // row is shown for what it can actually run, not for what it asked.
                const result = this.calculateSingleQueueActionTime(actionObj, actionDetails, inventoryLookup, {
                    limitCountedByMaterials: true,
                });

                // The queue is walked in order, so this row's materials are gone before the
                // next row is costed — otherwise every row claims the whole starting bag.
                this.deductQueueActionMaterials(inventoryLookup, actionDetails, actionObj, result);

                if (result.isTrulyInfinite) {
                    hasInfinite = true;
                } else {
                    accumulatedTime += result.actionTimeSeconds;
                }
                if (result.materialLimitIsEstimated) hasEstimate = true;

                // Format time text
                let timeText;
                if (result.isTrulyInfinite) {
                    timeText = '[∞]';
                } else if (result.isInfinite && result.materialLimit !== null) {
                    const timeStr = timeReadable(result.totalTime);
                    const mark = result.materialLimitIsEstimated ? '~' : '';
                    timeText = `[${timeStr} · ${result.limitLabel}: ${mark}${this.formatLargeNumber(result.materialLimit)}]`;
                } else {
                    const timeStr = timeReadable(result.totalTime);
                    timeText = `[${timeStr}]`;
                }

                // Add completion time
                if (!hasInfinite && !result.isTrulyInfinite) {
                    const completionDate = new Date();
                    completionDate.setSeconds(completionDate.getSeconds() + accumulatedTime);
                    const isToday = completionDate.toDateString() === new Date().toDateString();
                    const mark = hasEstimate ? '~' : '';
                    timeText += ` Complete at ${mark}${formatCompletionTime(completionDate, !isToday)}`;
                }

                this.appendTimeToActionDiv(actionDiv, timeText);
            }

            // Add total time at bottom of tooltip
            const actionsContainer = tooltipContent.querySelector('[class*="QueuedActions_actions"]');
            if (actionsContainer) {
                const totalDiv = document.createElement('div');
                totalDiv.className = 'mwi-queue-tooltip-total';
                totalDiv.style.cssText = `
                    color: ${config.COLOR_TOOLTIP_INFO};
                    font-weight: bold;
                    margin-top: 8px;
                    padding-top: 6px;
                    border-top: 1px solid rgba(0, 0, 0, 0.2);
                    text-align: center;
                    font-size: 0.85em;
                `;

                let totalText;
                const totalMark = hasEstimate ? '~' : '';
                if (hasInfinite) {
                    totalText =
                        accumulatedTime > 0
                            ? `Total: ${totalMark}${timeReadable(accumulatedTime)} + [∞]`
                            : 'Total: [∞]';
                } else {
                    totalText = `Total: ${totalMark}${timeReadable(accumulatedTime)}`;
                }
                totalDiv.textContent = totalText;
                actionsContainer.appendChild(totalDiv);
            }
        } catch (error) {
            console.error('[Action Time Display] Error injecting queue tooltip times:', error);
        }
    }

    /**
     * Append a time display div to an action div in the queue tooltip
     * @param {HTMLElement} actionDiv - The action container div
     * @param {string} text - Time text to display
     */
    appendTimeToActionDiv(actionDiv, text) {
        const timeDiv = document.createElement('div');
        timeDiv.className = 'mwi-queue-action-time';
        timeDiv.style.cssText = `
            color: ${config.COLOR_TOOLTIP_INFO};
            font-size: 0.85em;
            margin-top: 2px;
        `;
        timeDiv.textContent = text;

        const actionTextContainer = actionDiv.querySelector('[class*="QueuedActions_actionText"]');
        if (actionTextContainer) {
            actionTextContainer.appendChild(timeDiv);
        } else {
            actionDiv.appendChild(timeDiv);
        }
    }

    /**
     * Calculate time for the currently active action (for total time calculation)
     *
     * Also spends that action's materials out of `inventoryLookup`: it runs ahead of every
     * queued row, so the rows after it must be costed against what it leaves.
     * @param {Array} currentActions - All current actions from dataManager
     * @param {Object} inventoryLookup - Inventory lookup map, mutated by the deduction
     * @returns {Object|null} { totalTime, hasInfinite, actionId } or null
     */
    calculateCurrentActionTime(currentActions, inventoryLookup) {
        const actionNameElement = document.querySelector('div[class*="Header_actionName"]');
        if (!actionNameElement || !actionNameElement.textContent) return null;

        const actionNameText = this.getCleanActionName(actionNameElement);
        const sorted = [...currentActions].sort((a, b) => a.ordinal - b.ordinal);
        const currentAction = this.matchCurrentActionFromText(sorted.slice(0, 1), actionNameText);

        if (!currentAction) return null;

        const actionDetails = dataManager.getActionDetails(currentAction.actionHrid);
        if (!actionDetails) return null;

        const result = this.calculateSingleQueueActionTime(currentAction, actionDetails, inventoryLookup, {
            limitCountedByMaterials: true,
        });
        this.deductQueueActionMaterials(inventoryLookup, actionDetails, currentAction, result);

        return {
            totalTime: result.actionTimeSeconds,
            hasInfinite: result.isTrulyInfinite,
            actionId: currentAction.id,
        };
    }

    /**
     * Calculate time for a single queued action
     * @param {Object} actionObj - Action object from dataManager cache
     * @param {Object} actionDetails - Action details from dataManager
     * @param {Object} inventoryLookup - Inventory lookup map
     * @param {Object} [options] - {limitCountedByMaterials} — cap a counted row's request at
     *   what the lookup can actually pay for. Off by default: this helper also answers for a
     *   single, unqueued action, where the whole bag is the right basis and the requested
     *   count is what the player asked to run. Only the queue walks, which cost each row
     *   against a running ledger, ask for the cap.
     * @returns {Object} { totalTime, actionTimeSeconds, count, baseActionsNeeded, isTrulyInfinite,
     *      isInfinite, materialLimit, limitType, limitLabel, materialLimitIsEstimated, isEnhancing }
     */
    calculateSingleQueueActionTime(actionObj, actionDetails, inventoryLookup, options = {}) {
        const isEnhancing = actionDetails.type === '/action_types/enhancing';
        const isInfinite = !actionObj.hasMaxCount || actionObj.actionHrid.includes('/combat/');

        let totalTime = 0;
        let actionTimeSeconds = 0;
        let count = 0;
        let baseActionsNeeded = 0;
        let isTrulyInfinite = false;
        let materialLimit = null;
        let limitType = null;
        let limitLabel = '';
        let materialLimitIsEstimated = false;

        if (isEnhancing) {
            const enhancingTime = this.calculateEnhancingQueueTime(actionObj, actionDetails, inventoryLookup, options);
            if (enhancingTime) {
                count = enhancingTime.count;
                totalTime = enhancingTime.totalTime;
                actionTimeSeconds = enhancingTime.totalTime;
                // Set only when the cap actually bound, as in the non-enhancing branch: an
                // enhancing row inside its materials rests on the player's request, not on a
                // material channel, and must not be labelled — or marked — as if it did.
                if (enhancingTime.limitType) {
                    materialLimit = enhancingTime.count;
                    limitType = enhancingTime.limitType;
                }
                // Independent of the label: an uncounted row's figure comes straight from the
                // material limit, which counts the expected protection draw, so it can rest on
                // an estimate without any channel being named as what bound it.
                if (enhancingTime.materialLimitIsEstimated === true) {
                    materialLimitIsEstimated = true;
                }
            } else if (isInfinite) {
                isTrulyInfinite = true;
                totalTime = Infinity;
            }
        } else {
            const timeData = this.calculateActionTime(actionDetails, actionObj.actionHrid);
            if (!timeData) {
                return {
                    totalTime: 0,
                    actionTimeSeconds: 0,
                    count: 0,
                    baseActionsNeeded: 0,
                    isTrulyInfinite: isInfinite,
                    isInfinite,
                    materialLimit: null,
                    limitType: null,
                    limitLabel: '',
                    materialLimitIsEstimated: false,
                    isEnhancing,
                };
            }

            const { actionTime, totalEfficiency } = timeData;

            if (isInfinite) {
                const equipment = dataManager.getEquipment();
                const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
                const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
                const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
                const artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);

                const limitResult = this.calculateMaterialLimit(
                    actionDetails,
                    inventoryLookup,
                    artisanBonus,
                    actionObj
                );
                if (limitResult) {
                    materialLimit = limitResult.maxActions;
                    limitType = limitResult.limitType;
                    materialLimitIsEstimated = limitResult.isEstimated === true;
                }
            }

            isTrulyInfinite = isInfinite && materialLimit === null;

            if (!isInfinite) {
                count = actionObj.maxCount - actionObj.currentCount;
                if (options.limitCountedByMaterials) {
                    const capped = this.capCountedRequestByMaterials(count, actionDetails, inventoryLookup, actionObj);
                    count = capped.count;
                    if (capped.limitType !== null) {
                        materialLimit = capped.count;
                        limitType = capped.limitType;
                        materialLimitIsEstimated = capped.isEstimated;
                    }
                }
            } else if (materialLimit !== null) {
                count = materialLimit;
            }

            if (!isTrulyInfinite && count > 0) {
                const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);
                baseActionsNeeded = Math.ceil(count / avgActionsPerBaseAction);
                // Scoped by (id, currentCount), so this only ever subtracts for the action
                // actually in progress — a queued action gets 0 back and is unaffected
                const elapsedInCurrentUnit = dataManager.getElapsedSecondsInCurrentUnit(
                    actionObj.id,
                    actionObj.currentCount,
                    actionTime
                );
                totalTime = Math.max(0, baseActionsNeeded * actionTime - elapsedInCurrentUnit);
                actionTimeSeconds = totalTime;
            } else if (isTrulyInfinite) {
                totalTime = Infinity;
            }
        }

        // Derive limit label
        if (limitType === 'gold') {
            limitLabel = 'gold';
        } else if (limitType && limitType.startsWith('material:')) {
            limitLabel = 'mat';
        } else if (limitType && limitType.startsWith('upgrade:')) {
            limitLabel = 'upgrade';
        } else {
            limitLabel = 'max';
        }

        return {
            totalTime,
            actionTimeSeconds,
            count,
            baseActionsNeeded,
            isTrulyInfinite,
            isInfinite,
            materialLimit,
            limitType,
            limitLabel,
            materialLimitIsEstimated,
            isEnhancing,
        };
    }

    /**
     * Initialize observer for action name element replacement
     */
    initializeActionNameWatcher() {
        if (this.unregisterActionNameObserver) {
            return;
        }

        this.unregisterActionNameObserver = domObserver.onClass(
            'ActionTimeDisplay-ActionName',
            'Header_actionName',
            (actionNameElement) => {
                if (!actionNameElement) {
                    return;
                }

                this.createDisplayPanel();
                this.setupActionNameObserver(actionNameElement);
                this.updateDisplay();
            }
        );
    }

    /**
     * Setup mutation observer for queue menu reordering
     * @param {HTMLElement} queueMenu - Queue menu container element
     */
    setupQueueMenuObserver(queueMenu) {
        if (!queueMenu) {
            return;
        }

        if (this.queueMenuObserver) {
            this.queueMenuObserver();
            this.queueMenuObserver = null;
        }

        this.queueMenuObserver = createMutationWatcher(
            queueMenu,
            () => {
                // Disconnect to prevent infinite loop (our injection triggers mutations)
                if (this.queueMenuObserver) {
                    this.queueMenuObserver();
                    this.queueMenuObserver = null;
                }

                // Queue DOM changed (reordering) - re-inject times
                // NOTE: Reconnection happens inside injectQueueTimes after async completes
                this.injectQueueTimes(queueMenu);
            },
            {
                childList: true,
                subtree: true,
            }
        );
    }

    /**
     * Handle character switch
     * Clean up old observers and re-initialize for new character's action panel
     */
    handleCharacterSwitch() {
        // Cancel any active profit calculations to prevent stale data. Both guards, not just the
        // action-card one: the bar's own calculation writes into `this.profitElement` at whatever
        // node that points to when it resolves, so leaving `activeBarProfitId` matching lets the
        // old character's figure land in the row created for the new one.
        this.activeProfitCalculationId = null;
        this.activeBarProfitId = null;

        // Clear appended stats from old character's action panel (before it's removed)
        const oldActionNameElement = document.querySelector('div[class*="Header_actionName"]');
        if (oldActionNameElement) {
            this.clearAppendedStats(oldActionNameElement);
        }

        // Disconnect old action name observer (watching removed element)
        if (this.actionNameObserver) {
            this.actionNameObserver();
            this.actionNameObserver = null;
        }

        // Clear display element reference (already removed from DOM by game)
        this.displayElement = null;
        this.profitElement = null;
        this.runElement = null;

        // Re-initialize action panel display for new character
        this.waitForActionPanel();
    }

    /**
     * Wait for action panel to exist in DOM
     */
    async waitForActionPanel() {
        // Try to find action name element (use wildcard for hash-suffixed class)
        const actionNameElement = document.querySelector('div[class*="Header_actionName"]');

        if (actionNameElement) {
            this.createDisplayPanel();
            this.setupActionNameObserver(actionNameElement);
            this.updateDisplay();
        } else {
            // Not found, try again in 200ms
            if (this.waitForPanelTimeout) {
                clearTimeout(this.waitForPanelTimeout);
            }
            this.waitForPanelTimeout = setTimeout(() => {
                this.waitForPanelTimeout = null;
                this.waitForActionPanel();
            }, 200);
            this.cleanupRegistry.registerTimeout(this.waitForPanelTimeout);
        }
    }

    /**
     * Setup MutationObserver to watch action name changes
     * @param {HTMLElement} actionNameElement - The action name DOM element
     */
    setupActionNameObserver(actionNameElement) {
        // Disconnect any observer already running before replacing it. Both
        // waitForActionPanel() and the persistent Header_actionName watcher call
        // this on a character switch, and without this a second call would orphan
        // the first observer — its disconnect handle overwritten and lost. That
        // leaked observer keeps watching the element, and since updateDisplay()
        // only disconnects the *current* this.actionNameObserver before appending
        // its stats span, the leaked one fires on that append and re-triggers
        // updateDisplay in an unbounded loop that freezes the tab. (Ported from
        // upstream Celasha/Toolasha#623.)
        if (this.actionNameObserver) {
            this.actionNameObserver();
            this.actionNameObserver = null;
        }

        // Watch for text content changes in the action name element
        this.actionNameObserver = createMutationWatcher(
            actionNameElement,
            () => {
                this.updateDisplay();
            },
            {
                childList: true,
                characterData: true,
                subtree: true,
            }
        );
    }

    /**
     * Create the display panel in the DOM
     */
    createDisplayPanel() {
        if (this.displayElement && this.displayElement.isConnected) {
            return; // Already created and still in the DOM
        }
        this.displayElement = null;
        this.profitElement = null;
        this.runElement = null;

        // Remove any orphaned copies of our injected elements before creating fresh ones.
        // The game can swap out the action-name subtree in a way that drops one of our two
        // tracked siblings from `this` without removing it from the live DOM (e.g. only the
        // time-display node gets torn down while the profit node survives elsewhere) — a
        // plain `this.profitElement = document.createElement(...)` reassignment would then
        // orphan the old node, leaving two "#mwi-action-profit-display" elements on the page
        // showing stale-vs-fresh data (same rate, different "remaining", since the queue moved
        // on between the two renders). Querying by data attribute — rather than
        // getElementById, which only ever returns the first match — guarantees every stray
        // duplicate is cleared, keying the idempotent injection so exactly one of each exists.
        document.querySelectorAll('[data-mwi-action-bar-widget="time"]').forEach((el) => el.remove());
        document.querySelectorAll('[data-mwi-action-bar-widget="profit"]').forEach((el) => el.remove());
        document.querySelectorAll('[data-mwi-action-bar-widget="run"]').forEach((el) => el.remove());

        const actionNameContainer = document.querySelector('div[class*="Header_actionName"]');
        if (!actionNameContainer) {
            return;
        }

        // NOTE: Width overrides are now applied in updateDisplay() after we know if it's combat
        // This prevents HP/MP bar width issues when loading directly on combat actions

        // Create display element
        this.displayElement = document.createElement('div');
        this.displayElement.id = 'mwi-action-time-display';
        this.displayElement.setAttribute('data-mwi-action-bar-widget', 'time');
        this.displayElement.style.cssText = `
            font-size: 0.9em;
            color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
            margin-top: 2px;
            line-height: 1.4;
            text-align: left;
            white-space: pre-wrap;
        `;

        // Insert after action name
        actionNameContainer.parentNode.insertBefore(this.displayElement, actionNameContainer.nextSibling);

        // Create profit element (below time display)
        this.profitElement = document.createElement('div');
        this.profitElement.id = 'mwi-action-profit-display';
        this.profitElement.setAttribute('data-mwi-action-bar-widget', 'profit');
        this.profitElement.style.cssText = `
            font-size: 0.9em;
            color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
            line-height: 1.4;
            text-align: left;
            white-space: pre-wrap;
        `;
        this.displayElement.parentNode.insertBefore(this.profitElement, this.displayElement.nextSibling);

        // Create "so far this run" element (below the profit line)
        this.runElement = document.createElement('div');
        this.runElement.id = 'mwi-action-run-display';
        this.runElement.setAttribute('data-mwi-action-bar-widget', 'run');
        this.runElement.style.cssText = `
            font-size: 0.9em;
            color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
            line-height: 1.4;
            text-align: left;
            white-space: pre-wrap;
        `;
        this.profitElement.parentNode.insertBefore(this.runElement, this.profitElement.nextSibling);

        this.cleanupRegistry.registerCleanup(() => {
            if (this.displayElement && this.displayElement.parentNode) {
                this.displayElement.parentNode.removeChild(this.displayElement);
            }
            this.displayElement = null;
            if (this.profitElement && this.profitElement.parentNode) {
                this.profitElement.parentNode.removeChild(this.profitElement);
            }
            this.profitElement = null;
            if (this.runElement && this.runElement.parentNode) {
                this.runElement.parentNode.removeChild(this.runElement);
            }
            this.runElement = null;
        });
    }

    /**
     * Update the display with current action data
     */
    updateDisplay() {
        // Don't paint while settings are mid-switch or not yet character-loaded —
        // a stale actionBar_compactWidth read here is how the bar could load compact
        // even though the setting is off
        if (!config.characterSettingsLoaded || dataManager.getIsCharacterSwitching()) {
            return;
        }

        if (!this.displayElement) {
            this.createDisplayPanel();
            if (!this.displayElement) {
                return;
            }
        }

        if (!this.displayElement.isConnected) {
            this.createDisplayPanel();
            if (!this.displayElement) {
                return;
            }
        }

        // Get current action - read from game UI which is always correct
        // The game updates the DOM immediately when actions change
        // Use wildcard selector to handle hash-suffixed class names
        const actionNameElement = document.querySelector('div[class*="Header_actionName"]');

        // CRITICAL: Disconnect observer before making changes to prevent infinite loop
        if (this.actionNameObserver) {
            this.actionNameObserver();
            this.actionNameObserver = null;
        }

        if (!actionNameElement || !actionNameElement.textContent) {
            this.displayElement.innerHTML = '';
            this.clearBarProfit();
            this.clearRunSoFar();
            // Clear any appended stats from the game's div
            this.clearAppendedStats(actionNameElement);
            // Reconnect observer
            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        // Parse action name from DOM
        // Format can be: "Action Name (#123)", "Action Name (123)", "Action Name: Item (123)", etc.
        // First, strip any stats we previously appended
        const actionNameText = this.getCleanActionName(actionNameElement);

        // Check if no action is running ("Doing nothing...")
        if (actionNameText.includes('Doing nothing')) {
            this.displayElement.innerHTML = '';
            this.clearBarProfit();
            this.clearRunSoFar();
            this.clearAppendedStats(actionNameElement);
            // Reconnect observer
            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        // Extract inventory count from parentheses (e.g., "Coinify: Item (4312)" -> 4312)
        const inventoryCount = parseInventoryCountFromActionName(actionNameText);

        // Find the matching action in cache
        const cachedActions = dataManager.getCurrentActions();
        let action;

        // Match against the front action (lowest ordinal = most active).
        // Sort needed because the array is in insertion order, not ordinal order.
        if (cachedActions.length > 0) {
            const sorted = cachedActions.sort((a, b) => a.ordinal - b.ordinal);
            action = this.matchCurrentActionFromText(sorted.slice(0, 1), actionNameText);
        }

        if (!action) {
            this.displayElement.innerHTML = '';
            // The profit line too: it was the previous action's, and this
            // header is the labyrinth's (or a name nothing queued matches), so
            // it had been left standing under the wrong activity
            this.clearBarProfit();
            this.clearRunSoFar();
            this.clearAppendedStats(actionNameElement);
            // The name matched nothing queued, which the labyrinth does every
            // time — its header reads "Labyrinth - Mimic Lv.252" and no action
            // is called that. The width policy only needs the action's type,
            // and the queue gives that without going through the header text.
            const frontHrid = cachedActions.length > 0 ? cachedActions[0].actionHrid : null;
            const frontType = frontHrid ? dataManager.getActionDetails(frontHrid)?.type : null;
            if (frontType) this.applyActionBarWidth(actionNameElement, frontType === '/action_types/combat');
            // Only retry if no cached actions (data not loaded yet).
            // If cached actions exist but none match, data updated before DOM —
            // the mutation observer will trigger updateDisplay when DOM catches up.
            if (cachedActions.length === 0) {
                this.scheduleUpdateRetry();
            }
            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        const actionDetails = dataManager.getActionDetails(action.actionHrid);
        if (!actionDetails) {
            this.displayElement.innerHTML = '';
            this.clearBarProfit();
            this.clearRunSoFar();
            this.clearAppendedStats(actionNameElement);
            // Reconnect observer
            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        // Skip combat actions - no time display for combat
        if (actionDetails.type === '/action_types/combat') {
            this.displayElement.innerHTML = '';
            this.clearBarProfit();
            this.clearRunSoFar();
            this.clearAppendedStats(actionNameElement);

            this.applyActionBarWidth(actionNameElement, true);

            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        // Handle enhancing actions with specialized display
        if (actionDetails.type === '/action_types/enhancing') {
            this.clearBarProfit();
            this.clearRunSoFar();
            this.buildEnhancingDisplay(action, actionDetails, actionNameElement);
            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        // Re-apply CSS override on every update to prevent game's CSS from truncating text
        // ONLY for non-combat actions (combat needs normal width for HP/MP bars)
        // Use setProperty with 'important' to ensure we override game's styles

        this.applyActionBarWidth(actionNameElement, false);

        // Get character data
        const equipment = dataManager.getEquipment();
        const skills = dataManager.getSkills();
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

        // For alchemy actions, use item level for efficiency calculation (not action requirement)
        let levelRequirementOverride = undefined;
        if (actionDetails.type === '/action_types/alchemy' && action.primaryItemHash) {
            const { itemHrid: alchItemHrid } = this.parseItemHash(action.primaryItemHash);
            if (alchItemHrid) {
                const itemDetails = itemDetailMap[alchItemHrid];
                if (itemDetails && itemDetails.itemLevel) {
                    levelRequirementOverride = itemDetails.itemLevel;
                }
            }
        }

        // Use shared calculator
        const stats = calculateActionStats(actionDetails, {
            skills,
            equipment,
            itemDetailMap,
            actionHrid: action.actionHrid, // Pass action HRID for task detection
            includeCommunityBuff: true,
            includeBreakdown: false,
            levelRequirementOverride,
        });

        if (!stats) {
            // Reconnect observer
            this.reconnectActionNameObserver(actionNameElement);
            return;
        }

        const { actionTime, totalEfficiency } = stats;
        const baseActionsPerHour = calculateActionsPerHour(actionTime);

        // Efficiency model:
        // - Queue input counts completed actions (including instant repeats)
        // - Efficiency adds instant repeats with no extra time
        // - Time is based on time-consuming actions (queuedActions / avgActionsPerBaseAction)
        // - Materials are consumed per completed action, including repeats
        // Calculate average queued actions completed per time-consuming action
        const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);

        // Calculate actions per hour WITH efficiency (total action completions including instant repeats)
        const actionsPerHourWithEfficiency = calculateEffectiveActionsPerHour(
            baseActionsPerHour,
            avgActionsPerBaseAction
        );

        // Calculate items per hour based on action type
        let itemsPerHour;

        // Gathering action types (need special handling for dropTable)
        const GATHERING_TYPES = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

        // Production action types that benefit from Gourmet Tea
        const PRODUCTION_TYPES = ['/action_types/brewing', '/action_types/cooking'];

        if (
            actionDetails.dropTable &&
            actionDetails.dropTable.length > 0 &&
            GATHERING_TYPES.includes(actionDetails.type)
        ) {
            // Gathering action - use dropTable with gathering quantity bonus
            const mainDrop = actionDetails.dropTable[0];
            const baseAvgAmount = (mainDrop.minCount + mainDrop.maxCount) / 2;

            // Calculate gathering quantity bonus (same as gathering-profit.js)
            const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
            const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
            const gatheringTea = parseGatheringBonus(activeDrinks, itemDetailMap, drinkConcentration);

            // Community buff — strength and which skills it covers both come from game data
            const communityGathering = getCommunityGatheringQuantity(actionDetails.type);

            // Achievement buffs
            const achievementGathering = dataManager.getAchievementBuffFlatBoost(
                actionDetails.type,
                '/buff_types/gathering'
            );

            // Total gathering bonus (all additive)
            const totalGathering = gatheringTea + communityGathering + achievementGathering;

            // Apply gathering bonus to average amount
            const avgAmountPerAction = baseAvgAmount * (1 + totalGathering);

            // Items per hour = actions × drop rate × avg amount × efficiency
            itemsPerHour = baseActionsPerHour * mainDrop.dropRate * avgAmountPerAction * avgActionsPerBaseAction;
        } else if (actionDetails.outputItems && actionDetails.outputItems.length > 0) {
            // Production action - use outputItems
            const outputAmount = actionDetails.outputItems[0].count || 1;
            itemsPerHour = baseActionsPerHour * outputAmount * avgActionsPerBaseAction;

            // Apply Gourmet bonus for brewing/cooking (extra items chance)
            if (PRODUCTION_TYPES.includes(actionDetails.type)) {
                const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
                const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
                const gourmetBonus = parseGourmetBonus(activeDrinks, itemDetailMap, drinkConcentration);

                // Gourmet gives a chance for extra items (e.g., 0.1344 = 13.44% more items)
                const gourmetBonusItems = itemsPerHour * gourmetBonus;
                itemsPerHour += gourmetBonusItems;
            }
        } else {
            // Fallback - no items produced
            itemsPerHour = actionsPerHourWithEfficiency;
        }

        // Calculate material limit for infinite actions
        let materialLimit = null;
        let limitType = null;
        if (!action.hasMaxCount) {
            // Get inventory and calculate Artisan bonus
            const inventory = dataManager.getInventory();
            const inventoryLookup = this.buildInventoryLookup(inventory);
            const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
            const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
            const artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);

            // Calculate max actions based on materials and costs
            const limitResult = this.calculateMaterialLimit(actionDetails, inventoryLookup, artisanBonus, action);
            if (limitResult) {
                materialLimit = limitResult.maxActions;
                limitType = limitResult.limitType;
            }
        }

        let limitingItemHrid = null;
        if (limitType?.startsWith('material:')) {
            limitingItemHrid = limitType.slice('material:'.length);
        } else if (limitType === 'gold') {
            limitingItemHrid = '/items/coin';
        }

        // Get queue size for display (total queued, doesn't change)
        // For infinite actions with inventory count, use that; otherwise use maxCount or Infinity
        let queueSizeDisplay;
        if (action.hasMaxCount) {
            queueSizeDisplay = action.maxCount;
        } else if (materialLimit !== null) {
            // Material-limited infinite action - show infinity but we'll add "max: X" separately
            queueSizeDisplay = Infinity;
        } else if (inventoryCount !== null) {
            queueSizeDisplay = inventoryCount;
        } else {
            queueSizeDisplay = Infinity;
        }

        // Get remaining actions for time calculation
        // For infinite actions, use material limit if available, then inventory count
        let remainingQueuedActions;
        if (action.hasMaxCount) {
            // Finite action: maxCount is the target, currentCount is progress toward that target
            remainingQueuedActions = action.maxCount - action.currentCount;
        } else if (materialLimit !== null) {
            // Infinite action limited by materials (materialLimit is queued actions)
            remainingQueuedActions = materialLimit;
        } else if (inventoryCount !== null) {
            // Infinite action: currentCount is lifetime total, so just use inventory count directly
            remainingQueuedActions = inventoryCount;
        } else {
            remainingQueuedActions = Infinity;
        }

        // Calculate time-consuming actions needed
        let baseActionsNeeded;
        if (!action.hasMaxCount && materialLimit !== null) {
            // Material-limited infinite action - convert queued actions to time-consuming actions
            baseActionsNeeded = Math.ceil(materialLimit / avgActionsPerBaseAction);
        } else {
            // Finite action or inventory-count infinite - remainingQueuedActions is queued actions
            baseActionsNeeded = Math.ceil(remainingQueuedActions / avgActionsPerBaseAction);
        }
        // Subtract what the in-progress base action has already run for. baseActionsNeeded
        // counts that unit as a whole one, so without this the ETA re-anchors to a fresh full
        // action on every reload/remount and walks later each time.
        const elapsedInCurrentUnit = dataManager.getElapsedSecondsInCurrentUnit(
            action.id,
            action.currentCount,
            actionTime
        );
        const totalTimeSeconds = Math.max(0, baseActionsNeeded * actionTime - elapsedInCurrentUnit);

        // Calculate transmute recycle time estimate
        let recycleTimeSeconds = null;
        if (
            actionDetails.hrid?.includes('transmute') &&
            actionDetails.type === '/action_types/alchemy' &&
            action.primaryItemHash &&
            config.getSetting('actionBar_showRecycleTime')
        ) {
            const { itemHrid: transmuteItemHrid } = this.parseItemHash(action.primaryItemHash);
            if (transmuteItemHrid) {
                const transmuteItemDetails = itemDetailMap[transmuteItemHrid];
                const dropTable = transmuteItemDetails?.alchemyDetail?.transmuteDropTable;
                if (dropTable) {
                    const selfReturn = dropTable.find((d) => d.itemHrid === transmuteItemHrid);
                    if (selfReturn && selfReturn.dropRate > 0) {
                        const baseSuccessRate = transmuteItemDetails.alchemyDetail.transmuteSuccessRate || 0;
                        let catalystBonus = 0;
                        if (action.secondaryItemHash) {
                            const { itemHrid: catHrid } = this.parseItemHash(action.secondaryItemHash);
                            if (catHrid?.includes('prime_catalyst')) {
                                catalystBonus = 0.25;
                            } else if (catHrid?.includes('catalyst_of_transmutation')) {
                                catalystBonus = 0.15;
                            }
                        }
                        const teaBonus = getAlchemySuccessBonus();
                        const successRate = Math.min(1.0, baseSuccessRate * (1 + catalystBonus + teaBonus));
                        const recycleRate = selfReturn.dropRate * successRate;
                        if (recycleRate > 0 && recycleRate < 1) {
                            recycleTimeSeconds = totalTimeSeconds / (1 - recycleRate);
                        }
                    }
                }
            }
        }

        // Calculate completion time
        const completionTime = new Date();
        completionTime.setSeconds(completionTime.getSeconds() + totalTimeSeconds);

        // Format time strings (timeReadable handles days/hours/minutes properly)
        const timeStr = timeReadable(totalTimeSeconds);

        // Format completion time
        const now = new Date();
        const isToday = completionTime.toDateString() === now.toDateString();
        const clockTime = formatCompletionTime(completionTime, !isToday);

        // Build display HTML
        // Line 1: Append stats to game's action name div
        const statsToAppend = [];

        // Queue count
        if (config.getSetting('actionBar_showQueueCount')) {
            if (queueSizeDisplay !== Infinity) {
                statsToAppend.push(`(${queueSizeDisplay.toLocaleString()} queued)`);
            } else if (materialLimit !== null) {
                let limitLabel = '';
                if (limitType === 'gold') {
                    limitLabel = 'gold limit';
                } else if (limitType && limitType.startsWith('material:')) {
                    limitLabel = 'mat limit';
                } else if (limitType && limitType.startsWith('upgrade:')) {
                    limitLabel = 'upgrade limit';
                } else {
                    limitLabel = 'max';
                }
                statsToAppend.push(`(∞ · ${limitLabel}: ${this.formatLargeNumber(materialLimit)})`);
            } else {
                statsToAppend.push(`(∞)`);
            }
        }

        // Time per action
        if (config.getSetting('actionBar_showActionDuration')) {
            statsToAppend.push(`${actionTime.toFixed(2)}s/action`);
        }

        // Actions/hr and items/hr
        if (config.getSetting('actionBar_showActionsPerHour')) {
            statsToAppend.push(
                `${actionsPerHourWithEfficiency.toFixed(0)} actions/hr (${itemsPerHour.toFixed(0)} items/hr)`
            );
        }

        // Append to game's div (with marker for cleanup)
        this.appendStatsToActionName(actionNameElement, statsToAppend.join(' · '));

        // Line 2: Time estimates in our div
        if (
            config.getSetting('actionBar_showTimeRemaining') &&
            remainingQueuedActions !== Infinity &&
            !isNaN(remainingQueuedActions) &&
            remainingQueuedActions > 0
        ) {
            const itemIconHtml = this.getItemIconHtml(limitingItemHrid);
            const matsLabel = itemIconHtml ? `${itemIconHtml}:` : '';
            let recycleHtml = '';
            if (recycleTimeSeconds !== null) {
                const recycleCompletion = new Date();
                recycleCompletion.setSeconds(recycleCompletion.getSeconds() + recycleTimeSeconds);
                const recycleTimeStr = timeReadable(recycleTimeSeconds);
                const recycleIsToday = recycleCompletion.toDateString() === new Date().toDateString();
                const recycleClockTime = formatCompletionTime(recycleCompletion, !recycleIsToday);
                recycleHtml = `<span style="color:#4dd0a0; margin-left:12px; font-size:11px;">Est. w/ recycle: ${recycleTimeStr} → ${recycleClockTime}</span>`;
            }
            const progressNote = partialProgressNote(elapsedInCurrentUnit);
            this.displayElement.innerHTML = `<span style="display: inline-flex; flex-wrap: nowrap; align-items: baseline; gap: 0.25em;"><span>⏱</span>${matsLabel} ${timeStr} → ${clockTime}${progressNote}</span>${recycleHtml}`;
        } else {
            this.displayElement.innerHTML = '';
        }

        // Line 3: Profit display (async, non-blocking)
        this.updateActionBarProfit(action, remainingQueuedActions);

        // Line 4: "So far this run" — synchronous, from the item flow recorder's
        // own in-memory ledger, so it draws on the same pass as the time line
        this.updateRunSoFar(action, actionDetails);

        // Reconnect observer to watch for game's updates
        this.reconnectActionNameObserver(actionNameElement);
    }

    /**
     * Reconnect action name observer after making our changes
     * @param {HTMLElement} actionNameElement - Action name element
     */
    reconnectActionNameObserver(actionNameElement) {
        if (!actionNameElement) {
            return;
        }

        if (this.actionNameObserver) {
            this.actionNameObserver();
        }

        this.actionNameObserver = createMutationWatcher(
            actionNameElement,
            () => {
                this.updateDisplay();
            },
            {
                childList: true,
                characterData: true,
                subtree: true,
            }
        );
    }

    /**
     * Build and display enhancing-specific stats in the action bar
     * @param {Object} action - Current action object from dataManager
     * @param {Object} actionDetails - Action details
     * @param {HTMLElement} actionNameElement - Action name DOM element
     * @param {string} displayMode - Display mode ('full', 'compact', 'minimal')
     */
    buildEnhancingDisplay(action, actionDetails, actionNameElement) {
        // Parse primaryItemHash to get item HRID and current enhancement level
        if (!action.primaryItemHash) {
            this.displayElement.innerHTML = '';
            this.clearAppendedStats(actionNameElement);
            return;
        }

        const { itemHrid, level: currentLevel } = this.parseItemHash(action.primaryItemHash);
        if (!itemHrid) {
            this.displayElement.innerHTML = '';
            this.clearAppendedStats(actionNameElement);
            return;
        }

        const targetLevel = action.enhancingMaxLevel || 0;
        const protectFrom = action.enhancingProtectionMinLevel || 0;

        if (targetLevel <= currentLevel) {
            this.displayElement.innerHTML = '';
            this.clearAppendedStats(actionNameElement);
            return;
        }

        // Get predictions from the enhancement calculator
        const predictions = calculateEnhancementPredictions(itemHrid, currentLevel, targetLevel, protectFrom);
        if (!predictions) {
            this.displayElement.innerHTML = '';
            this.clearAppendedStats(actionNameElement);
            return;
        }

        const { expectedAttempts, expectedProtections, perActionTime, successMultiplier } = predictions;

        // Detect Philosopher's Mirror — guarantees success on every attempt
        let protectionItemHrid = null;
        if (action.secondaryItemHash) {
            const { itemHrid: secItemHrid } = this.parseItemHash(action.secondaryItemHash);
            protectionItemHrid = secItemHrid;
        }
        if (!protectionItemHrid && action.enhancingProtectionItemHrid) {
            protectionItemHrid = action.enhancingProtectionItemHrid;
        }
        const usesMirror = protectionItemHrid === PHILOSOPHERS_MIRROR_HRID;

        const effectiveAttempts = usesMirror ? targetLevel - currentLevel : expectedAttempts;
        const effectiveProtections = usesMirror ? 0 : expectedProtections;

        // Calculate current level success rate
        const baseRate = currentLevel < BASE_SUCCESS_RATES.length ? BASE_SUCCESS_RATES[currentLevel] : 30;
        const actualSuccessRate = usesMirror ? 100 : Math.min(100, baseRate * successMultiplier);

        // Determine the material limit. The count itself is not displayed — an enhancing
        // action is always Repeat ∞ in practice — only the time it buys.
        let materialLimit = null;
        let limitingItemHrid = null;
        // A limit that rests on the expected protection draw is not an exact count of actions
        let materialLimitIsEstimated = false;

        if (!action.hasMaxCount) {
            // Infinite action — one limit, covering both the per-attempt enhancement costs and
            // the expected protection draw (and the Philosopher's Mirror, spent every attempt).
            // Computing a second protection cap here is what let the action bar and the queue
            // ledger drift; `calculateMaterialLimit` is now the only place that decides.
            const inventory = dataManager.getInventory();
            const inventoryLookup = this.buildInventoryLookup(inventory);
            const limitResult = this.calculateMaterialLimit(actionDetails, inventoryLookup, 0, action);
            if (limitResult) {
                materialLimit = limitResult.maxActions;
                // Extract item HRID from limitType (e.g. "material:/items/foo" → "/items/foo")
                if (limitResult.limitType?.startsWith('material:')) {
                    limitingItemHrid = limitResult.limitType.slice('material:'.length);
                }
                materialLimitIsEstimated = limitResult.isEstimated === true;
            }
        }

        const elapsedInCurrentUnit = dataManager.getElapsedSecondsInCurrentUnit(
            action.id,
            action.currentCount,
            perActionTime
        );
        const materialTime =
            materialLimit !== null ? Math.max(0, materialLimit * perActionTime - elapsedInCurrentUnit) : null;

        // Apply CSS overrides for non-combat display
        const enhCompact = config.getSetting('actionBar_compactWidth') || isMobileMode();
        if (enhCompact) {
            actionNameElement.style.setProperty('max-width', '800px', 'important');
            actionNameElement.style.setProperty('overflow', 'hidden', 'important');
            actionNameElement.style.setProperty('text-overflow', 'clip', 'important');
            actionNameElement.style.setProperty('white-space', 'nowrap', 'important');
            actionNameElement.style.setProperty('width', '', 'important');
        } else {
            actionNameElement.style.setProperty('overflow', 'visible', 'important');
            actionNameElement.style.setProperty('text-overflow', 'clip', 'important');
            actionNameElement.style.setProperty('white-space', 'nowrap', 'important');
            actionNameElement.style.setProperty('max-width', 'none', 'important');
            actionNameElement.style.setProperty('width', 'auto', 'important');

            const parent1 = actionNameElement.parentElement;
            const parent2 = parent1?.parentElement;
            if (parent1) {
                parent1.style.setProperty('max-width', 'none', 'important');
                parent1.style.setProperty('width', 'auto', 'important');
                parent1.style.setProperty('overflow', 'visible', 'important');
            }
            if (parent2) {
                parent2.style.setProperty('max-width', 'none', 'important');
                parent2.style.setProperty('width', 'auto', 'important');
                parent2.style.setProperty('overflow', 'visible', 'important');
            }
        }

        // Build stats line — enhancing is always infinite, so skip queue count display
        const statsToAppend = [];

        if (config.getSetting('actionBar_showActionDuration')) {
            statsToAppend.push(`${perActionTime.toFixed(2)}s/action`);
        }
        statsToAppend.push(`${actualSuccessRate.toFixed(1)}% success`);
        statsToAppend.push(`~${formatWithSeparator(effectiveAttempts)} to target`);

        if (protectFrom > 0 && effectiveProtections > 0) {
            statsToAppend.push(`~${formatWithSeparator(effectiveProtections)} protections`);
        }

        this.appendStatsToActionName(actionNameElement, statsToAppend.join(' · '));

        // Line 2: Time estimate — always material-based for enhancing
        if (
            config.getSetting('actionBar_showTimeRemaining') &&
            materialTime !== null &&
            materialTime > 0 &&
            isFinite(materialTime)
        ) {
            const timeStr = timeReadable(materialTime);

            const completionTime = new Date();
            completionTime.setSeconds(completionTime.getSeconds() + materialTime);

            const now = new Date();
            const isToday = completionTime.toDateString() === now.toDateString();
            const clockTime = formatCompletionTime(completionTime, !isToday);

            const itemIconHtml = this.getItemIconHtml(limitingItemHrid);
            const matsLabel = itemIconHtml ? `${itemIconHtml}:` : 'Mats:';
            this.displayElement.innerHTML = `<span style="display: inline-flex; flex-wrap: nowrap; align-items: baseline; gap: 0.25em;"><span>⏱</span>${matsLabel} ${timeStr} → ${clockTime} (${materialLimitIsEstimated ? '~' : ''}${formatWithSeparator(materialLimit)} actions)</span>`;
        } else {
            this.displayElement.innerHTML = '';
        }
    }

    /**
     * Calculate time for an enhancing action in the queue
     * Uses enhancement predictions to determine realistic time based on min(queued, expected attempts)
     *
     * What limits an enhancing row is its per-attempt bill: `enhancementCosts` on the item
     * being enhanced, plus the expected protection draw (`getEnhancingProtectionDraw`).
     * `calculateMaterialLimit` and `deductQueueActionMaterials` cost it against both, from the
     * same helper, so nothing that binds here can disagree with what the ledger charges. The
     * item itself is not consumed — it comes back at a new level — so it is not a channel.
     *
     * A protection draw is an expectation, so a figure it bound carries `materialLimitIsEstimated`
     * and is rendered with the `~` marker rather than as an exact count.
     *
     * @param {Object} actionObj - Action object from dataManager
     * @param {Object} actionDetails - Action details
     * @param {Object} inventoryLookup - Inventory lookup maps; read, never mutated
     * @param {Object} [options] - {limitCountedByMaterials} — cap a counted row at what its
     *   per-attempt costs can pay for, the same rule every other action type follows. Off by
     *   default: this helper also answers for a single, unqueued action, where the whole bag
     *   is the right basis and the requested count is what the player asked to run.
     * @returns {Object|null} `{ count, totalTime }`, carrying `limitType` and
     *   `materialLimitIsEstimated` as well when the cap actually bound, or null if cannot calculate
     */
    calculateEnhancingQueueTime(actionObj, actionDetails, inventoryLookup, options = {}) {
        if (!actionObj.primaryItemHash) return null;

        const { itemHrid, level: currentLevel } = this.parseItemHash(actionObj.primaryItemHash);
        if (!itemHrid) return null;

        const targetLevel = actionObj.enhancingMaxLevel || 0;
        const protectFrom = actionObj.enhancingProtectionMinLevel || 0;

        if (targetLevel <= currentLevel) return null;

        const predictions = calculateEnhancementPredictions(itemHrid, currentLevel, targetLevel, protectFrom);
        if (!predictions || predictions.expectedAttempts <= 0) return null;

        const perActionTime = predictions.perActionTime;

        // Philosopher's Mirror guarantees success — exactly (target - current) actions
        let usesMirror = false;
        if (actionObj.secondaryItemHash) {
            const { itemHrid: secItemHrid } = this.parseItemHash(actionObj.secondaryItemHash);
            if (secItemHrid === '/items/philosophers_mirror') usesMirror = true;
        }
        if (!usesMirror && actionObj.enhancingProtectionItemHrid === '/items/philosophers_mirror') {
            usesMirror = true;
        }

        // A row's figure and the time built on it, capped by materials where the caller asked
        // for it. `elapsed` belongs to the attempt already running, so it is subtracted after
        // the cap rather than scaled with it.
        const settle = (rawCount, estimatedFromLimit = false) => {
            let finalCount = Number.isFinite(rawCount) ? Math.max(0, rawCount) : 0;
            let cap = null;
            if (options.limitCountedByMaterials && actionObj.hasMaxCount) {
                // Ceil, because an expected-attempts count is fractional and the shared helper
                // answers in whole actions: the cap must bind on 10 available against an
                // expected 10.4, and must not round 10.4 down to 10 when nothing binds.
                const capped = this.capCountedRequestByMaterials(
                    Math.ceil(finalCount),
                    actionDetails,
                    inventoryLookup,
                    actionObj
                );
                if (capped.limitType !== null) {
                    finalCount = capped.count;
                    cap = capped;
                }
            }
            const elapsed = dataManager.getElapsedSecondsInCurrentUnit(
                actionObj.id,
                actionObj.currentCount,
                perActionTime
            );
            const totalTime = Math.max(0, finalCount * perActionTime - elapsed);
            // An uncapped row can still rest on an estimate: an uncounted row's figure comes
            // from the material limit directly, and that limit counts the protection draw.
            if (!cap) {
                return estimatedFromLimit
                    ? { count: finalCount, totalTime, materialLimitIsEstimated: true }
                    : { count: finalCount, totalTime };
            }
            return {
                count: finalCount,
                totalTime,
                limitType: cap.limitType,
                materialLimitIsEstimated: cap.isEstimated || estimatedFromLimit,
            };
        };

        // An uncounted row's figure is the material limit itself; a counted one asks for what
        // the player typed and `settle` caps it. The mirror path takes the same two steps, so
        // a "Repeat ∞" mirror row is bounded by its bill the way every other row is.
        let queuedActions;
        let estimatedFromLimit = false;
        if (actionObj.hasMaxCount) {
            queuedActions = actionObj.maxCount - actionObj.currentCount;
        } else {
            const limitResult = this.calculateMaterialLimit(actionDetails, inventoryLookup, 0, actionObj);
            queuedActions = limitResult?.maxActions ?? Infinity;
            estimatedFromLimit = limitResult?.isEstimated === true;
        }

        if (usesMirror) {
            // A mirror guarantees the attempt, so exactly one attempt per level remains
            const actions = Math.min(targetLevel - currentLevel, queuedActions);
            return settle(actions, estimatedFromLimit);
        }

        const realisticActions =
            queuedActions === Infinity
                ? predictions.expectedAttempts
                : Math.min(queuedActions, predictions.expectedAttempts);

        return settle(realisticActions, estimatedFromLimit);
    }

    parseActionNameFromDom(actionNameText) {
        // Strip ALL trailing parentheses groups (e.g., "(T3) (Party)" or "(50)")
        // This handles combat tiers and party indicators: "Infernal Abyss (T3) (Party)" → "Infernal Abyss"
        const actionNameMatch = actionNameText.match(/^(.+?)(?:\s*\([^)]+\))*$/);
        const fullNameFromDom = actionNameMatch ? actionNameMatch[1].trim() : actionNameText;

        if (fullNameFromDom.includes(':')) {
            const parts = fullNameFromDom.split(':');
            return {
                actionNameFromDom: parts[0].trim(),
                itemNameFromDom: parts.slice(1).join(':').trim(),
            };
        }

        return {
            actionNameFromDom: fullNameFromDom,
            itemNameFromDom: null,
        };
    }

    buildItemHridFromName(itemName) {
        return `/items/${itemName
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '_')}`;
    }

    /**
     * Parse primaryItemHash to extract item HRID and enhancement level
     * Handles both formats:
     *   "/item_locations/inventory::/items/cheese_sword::1" (3 parts)
     *   "161296::/item_locations/inventory::/items/cheese_sword::5" (4 parts)
     * @param {string} hash - primaryItemHash string
     * @returns {Object} {itemHrid, level} or {itemHrid: null, level: 0} on failure
     */
    parseItemHash(hash) {
        try {
            const parts = hash.split('::');

            // Find the part that starts with /items/
            const itemHrid = parts.find((part) => part.startsWith('/items/')) || null;

            // Level is the last part if it's numeric (not a path)
            let level = 0;
            const lastPart = parts[parts.length - 1];
            if (lastPart && !lastPart.startsWith('/')) {
                const parsed = parseInt(lastPart, 10);
                if (!isNaN(parsed)) {
                    level = parsed;
                }
            }

            return { itemHrid, level };
        } catch {
            return { itemHrid: null, level: 0 };
        }
    }

    /**
     * Apply the action bar's width policy.
     *
     * Kept apart from the time display because the two need different things:
     * the display must know exactly which action is running, while the width
     * only needs to know whether it is a fight. A labyrinth room's header reads
     * "Labyrinth - Mimic Lv.252", which never equals any action's name, so the
     * lookup driving the display finds nothing there — and while the width rode
     * on that lookup, entering the labyrinth left the bar at whatever width the
     * previous action had set, until a redraw dropped it to the game's narrow
     * default with nothing left to put it back.
     *
     * @param {HTMLElement} actionNameElement - The header's action name element
     * @param {boolean} isCombat - Combat leaves the name element alone so the
     *   game's own HP/MP bars size themselves; only the parents are opened up
     */
    applyActionBarWidth(actionNameElement, isCombat) {
        if (!actionNameElement) return;
        const compact = config.getSetting('actionBar_compactWidth') || isMobileMode();
        const parent1 = actionNameElement.parentElement;
        const parent2 = parent1?.parentElement;
        const SIZING = ['overflow', 'text-overflow', 'white-space', 'max-width', 'width', 'min-width'];

        if (compact && isCombat) {
            // Hand the whole column back to the game
            for (const prop of SIZING) actionNameElement.style.removeProperty(prop);
            let parent = parent1;
            for (let levels = 0; parent && levels < 5; levels++) {
                for (const prop of SIZING) parent.style.removeProperty(prop);
                parent = parent.parentElement;
            }
            return;
        }

        if (compact) {
            actionNameElement.style.setProperty('max-width', '800px', 'important');
            actionNameElement.style.setProperty('overflow', 'hidden', 'important');
            actionNameElement.style.setProperty('text-overflow', 'clip', 'important');
            actionNameElement.style.setProperty('white-space', 'nowrap', 'important');
            actionNameElement.style.setProperty('width', '', 'important');
            for (const parent of [parent1, parent2]) {
                if (!parent) continue;
                parent.style.removeProperty('max-width');
                parent.style.removeProperty('width');
                parent.style.removeProperty('overflow');
            }
            return;
        }

        if (isCombat) {
            for (const prop of SIZING) actionNameElement.style.removeProperty(prop);
        } else {
            actionNameElement.style.setProperty('overflow', 'visible', 'important');
            actionNameElement.style.setProperty('text-overflow', 'clip', 'important');
            actionNameElement.style.setProperty('white-space', 'nowrap', 'important');
            actionNameElement.style.setProperty('max-width', 'none', 'important');
            actionNameElement.style.setProperty('width', 'auto', 'important');
        }
        for (const parent of [parent1, parent2]) {
            if (!parent) continue;
            parent.style.setProperty('max-width', 'none', 'important');
            parent.style.setProperty('width', 'auto', 'important');
            parent.style.setProperty('overflow', 'visible', 'important');
        }
    }

    matchCurrentActionFromText(currentActions, actionNameText) {
        const { actionNameFromDom, itemNameFromDom } = this.parseActionNameFromDom(actionNameText);
        const itemHridFromDom = this.buildItemHridFromName(itemNameFromDom || actionNameFromDom);

        return currentActions.find((currentAction) => {
            const actionDetails = dataManager.getActionDetails(currentAction.actionHrid);
            if (!actionDetails) {
                return false;
            }

            // Enhancing actions: DOM shows item name (e.g. "Cheese Sword +1"), not "Enhance: ..."
            // Match by checking if the action is enhancing and primaryItemHash contains the base item
            if (actionDetails.type === '/action_types/enhancing' && currentAction.primaryItemHash) {
                // Strip enhancement level suffix (e.g. "Cheese Sword +1" → "Cheese Sword")
                const baseItemName = actionNameFromDom.replace(/\s*\+\d+$/, '');
                const baseItemHrid = this.buildItemHridFromName(baseItemName);
                if (currentAction.primaryItemHash.includes(baseItemHrid)) {
                    return true;
                }
            }

            const outputItems = actionDetails.outputItems || [];
            const dropTable = actionDetails.dropTable || [];
            const matchesOutput = outputItems.some((item) => item.itemHrid === itemHridFromDom);
            const matchesDrop = dropTable.some((drop) => drop.itemHrid === itemHridFromDom);
            const matchesName =
                actionDetails.name === actionNameFromDom ||
                (actionNameFromDom.includes('★') && actionDetails.name === actionNameFromDom.replace(/\s*★/, ' (R)')) ||
                (actionNameFromDom.includes('(R)') &&
                    actionDetails.name === actionNameFromDom.replace(/\s*\(R\)/, ' ★'));

            if (!matchesName && !matchesOutput && !matchesDrop) {
                return false;
            }

            if (itemNameFromDom && currentAction.primaryItemHash) {
                const { itemHrid: hashItemHrid } = this.parseItemHash(currentAction.primaryItemHash);
                if (hashItemHrid) {
                    const hashItemDetails = dataManager.getItemDetails(hashItemHrid);
                    if (hashItemDetails?.name === itemNameFromDom) return true;
                }
                return currentAction.primaryItemHash.includes(itemHridFromDom);
            }

            return true;
        });
    }

    scheduleUpdateRetry(attempt = 0) {
        if (this.retryUpdateTimeout || attempt >= 3) {
            return;
        }

        const delays = [150, 300, 500];
        this.retryUpdateTimeout = setTimeout(() => {
            this.retryUpdateTimeout = null;
            this.updateDisplay();
            if (!this.displayElement || !this.displayElement.innerHTML) {
                this.scheduleUpdateRetry(attempt + 1);
            }
        }, delays[attempt]);
        this.cleanupRegistry.registerTimeout(this.retryUpdateTimeout);
    }

    /**
     * Get clean action name from element, stripping any stats we appended
     * @param {HTMLElement} actionNameElement - Action name element
     * @returns {string} Clean action name text
     */
    getCleanActionName(actionNameElement) {
        // Walk direct children to join their text with spaces, preserving word boundaries
        // that textContent would collapse (e.g. <span>Dragon</span><span>Fruit</span> → "Dragon Fruit")
        //
        // Every annotation is skipped, not just this feature's own. The row is
        // shared: the battle counter appends "· Attempt #3", the labyrinth
        // readouts append "[Clear ~85%]". Folding those into the name stops it
        // matching any action in the queue, and the failed match takes the
        // width override down with it — the action bar reverts to the game's
        // narrow default for as long as an annotation happens to be showing.
        const parts = [];
        for (const node of actionNameElement.childNodes) {
            if (node.nodeType === 1 && isScriptAnnotation(node)) continue;
            const text = node.textContent.trim();
            if (text) parts.push(text);
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * Clear any stats we previously appended to action name
     * @param {HTMLElement} actionNameElement - Action name element
     */
    clearAppendedStats(actionNameElement) {
        if (!actionNameElement) return;
        const markerSpan = actionNameElement.querySelector('.mwi-appended-stats');
        if (markerSpan) {
            markerSpan.remove();
        }
    }

    /**
     * Append stats to game's action name element
     * @param {HTMLElement} actionNameElement - Action name element
     * @param {string} statsText - Stats text to append
     */
    appendStatsToActionName(actionNameElement, statsText) {
        // Clear any previous appended stats
        this.clearAppendedStats(actionNameElement);

        // Get clean action name before appending stats
        const cleanActionName = this.getCleanActionName(actionNameElement);

        // Create marker span for our additions
        const statsSpan = document.createElement('span');
        statsSpan.className = 'mwi-appended-stats';

        // Check compact width toggle
        const compactWidth = config.getSetting('actionBar_compactWidth') || isMobileMode();

        if (compactWidth) {
            // COMPACT MODE: Truncate stats if too long
            statsSpan.style.cssText = `
                color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
                display: inline-block;
                max-width: 400px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                vertical-align: bottom;
            `;
            // Set full text as tooltip on both stats span and parent element
            const fullText = cleanActionName + ' ' + statsText;
            statsSpan.setAttribute('title', fullText);
            actionNameElement.setAttribute('title', fullText);
        } else {
            // FULL WIDTH and MINIMAL modes: Show all stats
            statsSpan.style.cssText = `color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});`;
            // Remove tooltip in full width mode
            actionNameElement.removeAttribute('title');
        }

        statsSpan.textContent = ' ' + statsText;

        // Append to action name element
        actionNameElement.appendChild(statsSpan);
    }

    /**
     * Calculate action time for a given action
     * @param {Object} actionDetails - Action details from data manager
     * @param {string} actionHrid - Action HRID for task detection (optional)
     * @returns {Object} {actionTime, totalEfficiency} or null if calculation fails
     */
    calculateActionTime(actionDetails, actionHrid = null) {
        const skills = dataManager.getSkills();
        const equipment = dataManager.getEquipment();
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

        // Use shared calculator with same parameters as main display
        return calculateActionStats(actionDetails, {
            skills,
            equipment,
            itemDetailMap,
            actionHrid, // Pass action HRID for task detection
            includeCommunityBuff: true,
            includeBreakdown: false,
        });
    }

    /**
     * Format a number with K/M suffix for large values
     * @param {number} num - Number to format
     * @returns {string} Formatted string (e.g., "1.23K", "5.67M")
     */
    formatLargeNumber(num) {
        if (num < 10000) {
            return num.toLocaleString(); // Under 10K: show full number with commas
        } else if (num < 1000000) {
            return (num / 1000).toFixed(1) + 'K'; // 10K-999K: show with K
        } else {
            return (num / 1000000).toFixed(2) + 'M'; // 1M+: show with M
        }
    }

    /**
     * Build an inline SVG icon HTML string for an item HRID.
     * Returns an empty string if the sprite URL cannot be found or no HRID given.
     * @param {string|null} itemHrid - e.g. "/items/mirror_of_protection"
     * @returns {string} HTML string with an inline <svg> element, or ''
     */
    getItemIconHtml(itemHrid) {
        if (!itemHrid) return '';
        const spriteEl = document.querySelector('use[href*="items_sprite"]');
        if (!spriteEl) return '';
        const spriteUrl = spriteEl.getAttribute('href')?.split('#')[0];
        if (!spriteUrl) return '';
        const symbolId = itemHrid.replace('/items/', '');
        return `<svg width="16" height="16" style="vertical-align: middle; margin: 0 1px;"><use href="${spriteUrl}#${symbolId}"></use></svg>`;
    }

    /**
     * Build inventory lookup maps for fast material queries
     * @param {Array} inventory - Character inventory items
     * @returns {Object} Lookup maps by HRID and enhancement
     */
    buildInventoryLookup(inventory) {
        const byHrid = {};
        const byEnhancedKey = {};

        // Provenance: item hrids whose balance has an estimated component, credited from
        // an earlier row's expected yield rather than counted in the bag. A figure resting
        // on one of these has to say so; a figure resting only on stock in hand must not.
        const estimatedHrids = new Set();

        if (!Array.isArray(inventory)) {
            return { byHrid, byEnhancedKey, estimatedHrids };
        }

        for (const item of inventory) {
            if (item.itemLocationHrid !== '/item_locations/inventory') {
                continue;
            }

            const count = item.count || 0;
            if (!count) {
                continue;
            }

            byHrid[item.itemHrid] = (byHrid[item.itemHrid] || 0) + count;

            const enhancementLevel = item.enhancementLevel || 0;
            const enhancedKey = `${item.itemHrid}::${enhancementLevel}`;
            byEnhancedKey[enhancedKey] = (byEnhancedKey[enhancedKey] || 0) + count;
        }

        return { byHrid, byEnhancedKey, estimatedHrids };
    }

    /**
     * The protection item one attempt of an enhancing row draws, and how much of it.
     *
     * A protection item is not a flat per-attempt cost like `enhancementCosts`: it is spent
     * only on an attempt that fails, so what an attempt costs is an expectation. The
     * enhancement prediction already produces one for the whole start→target climb —
     * `expectedProtections`, the Markov expectation of failures at or above the protect
     * level — and dividing it by `expectedAttempts` gives the per-attempt draw. Deriving a
     * second estimate here would let the two drift.
     *
     * `calculateMaterialLimit` and `deductQueueActionMaterials` both read this one helper, so
     * the count a row is displayed for and the count the ledger charges it cannot disagree.
     * That mutual dependence is the whole reason protections were left out until now: a limit
     * that counted them against a ledger that did not would contradict itself.
     *
     * The Philosopher's Mirror is the exception. It guarantees the attempt, so it is consumed
     * once per attempt whatever happens — a flat cost, and the only protection channel that
     * is exact rather than estimated.
     *
     * @param {Object} actionDetails - Action detail object for the row
     * @param {Object} actionObj - Character action object (carries the item hashes and the
     *      protection configuration)
     * @returns {{itemHrid: string, perAction: number, isEstimated: boolean}|null} The draw,
     *      or null when no protection is configured — in which case nothing about the row
     *      changes. `perAction` is 0 for a protection that is configured but cannot be
     *      quantified: it caps nothing, and `isEstimated` says the figure is not a promise.
     */
    getEnhancingProtectionDraw(actionDetails, actionObj) {
        if (actionDetails?.type !== '/action_types/enhancing') return null;
        if (!actionObj?.primaryItemHash) return null;

        // The secondary slot is where the game puts the item actually loaded into the action;
        // `enhancingProtectionItemHrid` is the configured fallback. Same precedence the action
        // bar's own enhancing readout uses.
        let protectionItemHrid = null;
        if (actionObj.secondaryItemHash) {
            protectionItemHrid = this.parseItemHash(actionObj.secondaryItemHash).itemHrid;
        }
        if (!protectionItemHrid) {
            protectionItemHrid = actionObj.enhancingProtectionItemHrid || null;
        }
        // No protection configured — every figure stays exactly what it was
        if (!protectionItemHrid) return null;

        if (protectionItemHrid === PHILOSOPHERS_MIRROR_HRID) {
            return { itemHrid: protectionItemHrid, perAction: 1, isEstimated: false };
        }

        // A protection item the client data does not know is not evidence of unlimited
        // protection, and capping the row at zero over it would be worse still. It caps
        // nothing and marks the figure instead, so the row never reads as an exact promise.
        const unquantified = { itemHrid: protectionItemHrid, perAction: 0, isEstimated: true };
        if (!config.getSetting('actionPanel_enhanceMatLimitProtections')) return null;
        if (!dataManager.getItemDetails(protectionItemHrid)) return unquantified;

        const { itemHrid, level: currentLevel } = this.parseItemHash(actionObj.primaryItemHash);
        const targetLevel = actionObj.enhancingMaxLevel || 0;
        const protectFrom = actionObj.enhancingProtectionMinLevel || 0;
        if (!itemHrid || targetLevel <= currentLevel) return unquantified;

        // Protection is configured but never reached on this climb: genuinely zero draws, not
        // an unknown one, so the row is exactly what it was without protection.
        if (protectFrom <= 0 || protectFrom >= targetLevel) return null;

        const predictions = calculateEnhancementPredictions(itemHrid, currentLevel, targetLevel, protectFrom);
        const attempts = predictions?.expectedAttempts;
        const protections = predictions?.expectedProtections;
        if (!Number.isFinite(attempts) || attempts <= 0) return unquantified;
        if (!Number.isFinite(protections) || protections <= 0) return unquantified;

        const perAction = protections / attempts;
        if (!Number.isFinite(perAction) || perAction <= 0) return unquantified;
        return { itemHrid: protectionItemHrid, perAction, isEstimated: true };
    }

    /**
     * Calculate maximum actions possible based on inventory materials
     * @param {Object} actionDetails - Action detail object
     * @param {Object|Array} inventoryLookup - Inventory lookup maps or raw inventory array
     * @param {number} artisanBonus - Artisan material reduction (0-1 decimal)
     * @param {Object} actionObj - Character action object (for primaryItemHash)
     * @returns {Object|null} {maxActions: number, limitType: string, isEstimated: boolean} or null if unlimited
     */
    calculateMaterialLimit(actionDetails, inventoryLookup, artisanBonus, actionObj = null) {
        if (!actionDetails || !inventoryLookup) {
            return null;
        }

        // Materials are consumed per queued action. Efficiency only affects time, not materials.

        const lookup = Array.isArray(inventoryLookup) ? this.buildInventoryLookup(inventoryLookup) : inventoryLookup;
        const byHrid = lookup?.byHrid || {};
        const byEnhancedKey = lookup?.byEnhancedKey || {};

        // A limit is an estimate when any channel it is costed against carries credited
        // expected yield — not only the binding one. An estimate that turns out low could
        // bind after all, so the answer is only as certain as its weakest input.
        const estimatedHrids = lookup?.estimatedHrids;
        let usedEstimate = false;
        const noteProvenance = (itemHrid) => {
            if (estimatedHrids?.has(itemHrid)) usedEstimate = true;
        };

        // Check for primaryItemHash (ONLY for Alchemy actions: Coinify, Decompose, Transmute)
        // Crafting actions also have primaryItemHash but should use the standard input/upgrade logic
        // Format: "characterID::itemLocation::itemHrid::enhancementLevel"
        const isEnhancingAction = actionDetails.type === '/action_types/enhancing';
        if (isEnhancingAction && actionObj && actionObj.primaryItemHash) {
            const { itemHrid } = this.parseItemHash(actionObj.primaryItemHash);
            if (itemHrid) {
                const itemData = dataManager.getItemDetails(itemHrid);
                const costs = itemData?.enhancementCosts;
                let minLimit = Infinity;
                let limitingType = 'unknown';

                if (Array.isArray(costs) && costs.length > 0) {
                    for (const cost of costs) {
                        noteProvenance(cost.itemHrid);
                        const available = byHrid[cost.itemHrid] || 0;
                        const maxFromThis = Math.floor(available / cost.count);
                        if (maxFromThis < minLimit) {
                            minLimit = maxFromThis;
                            limitingType = cost.itemHrid.includes('coin') ? 'gold' : `material:${cost.itemHrid}`;
                        }
                    }
                }

                // The protection channel. `deductQueueActionMaterials` spends the same draw
                // from the same helper, so what binds here is also what is charged.
                const protection = this.getEnhancingProtectionDraw(actionDetails, actionObj);
                if (protection?.isEstimated) {
                    // Sticky even when protections are not what binds: a draw that turns out
                    // heavier than expected could bind after all.
                    usedEstimate = true;
                }
                if (protection && protection.perAction > 0) {
                    noteProvenance(protection.itemHrid);
                    const availableProtections = byHrid[protection.itemHrid] || 0;
                    const maxFromProtection = Math.floor(availableProtections / protection.perAction);
                    if (maxFromProtection < minLimit) {
                        minLimit = maxFromProtection;
                        limitingType = `material:${protection.itemHrid}`;
                    }
                }

                if (minLimit !== Infinity) {
                    return { maxActions: minLimit, limitType: limitingType, isEstimated: usedEstimate };
                }
            }
        }

        const isAlchemyAction = actionDetails.type === '/action_types/alchemy';
        if (isAlchemyAction && actionObj && actionObj.primaryItemHash) {
            const { itemHrid: alchItemHrid, level: enhancementLevel } = this.parseItemHash(actionObj.primaryItemHash);
            if (alchItemHrid) {
                let minLimit = Infinity;
                let limitType = 'unknown';

                noteProvenance(alchItemHrid);
                const enhancedKey = `${alchItemHrid}::${enhancementLevel}`;
                const availableCount = byEnhancedKey[enhancedKey] || 0;
                const alchItemDetails = dataManager.getItemDetails(alchItemHrid);
                const bulkMultiplier = alchItemDetails?.alchemyDetail?.bulkMultiplier || 1;
                const maxFromItem = Math.floor(availableCount / bulkMultiplier);
                if (maxFromItem < minLimit) {
                    minLimit = maxFromItem;
                    limitType = `material:${alchItemHrid}`;
                }

                // Alchemy coin fees are not in the game's action data — actionDetails.coinCost
                // is 0 for every alchemy action, so gold could never be the limiting material.
                // The formulas live in utils/alchemy-fees.js, shared with every other fee site.
                const alchemyType = getAlchemyTypeFromActionHrid(actionDetails.hrid);
                const alchemyCoinCost =
                    alchemyType && alchemyType !== 'coinify' ? getAlchemyCoinCost(alchItemDetails, alchemyType) : 0;

                if (alchemyCoinCost > 0) {
                    noteProvenance('/items/coin');
                    const availableGold = byHrid['/items/coin'] || 0;
                    const maxFromGold = Math.floor(availableGold / alchemyCoinCost);
                    if (maxFromGold < minLimit) {
                        minLimit = maxFromGold;
                        limitType = 'gold';
                    }
                }

                if (actionObj.secondaryItemHash) {
                    const { itemHrid: catalystHrid } = this.parseItemHash(actionObj.secondaryItemHash);
                    if (catalystHrid) {
                        noteProvenance(catalystHrid);
                        const availableCatalyst = byHrid[catalystHrid] || 0;
                        const baseSuccessRate = this.getAlchemyCatalystRate(actionDetails, alchItemDetails);
                        if (baseSuccessRate > 0) {
                            const maxFromCatalyst = Math.floor(availableCatalyst / baseSuccessRate);
                            if (maxFromCatalyst < minLimit) {
                                minLimit = maxFromCatalyst;
                                limitType = `material:${catalystHrid}`;
                            }
                        }
                    }
                }

                if (minLimit === Infinity) return null;
                return { maxActions: minLimit, limitType, isEstimated: usedEstimate };
            }
        }

        // Check if action requires input materials or has costs
        const hasInputItems = actionDetails.inputItems && actionDetails.inputItems.length > 0;
        const hasUpgradeItem = actionDetails.upgradeItemHrid;
        const hasCoinCost = actionDetails.coinCost && actionDetails.coinCost > 0;

        if (!hasInputItems && !hasUpgradeItem && !hasCoinCost) {
            return null; // No materials or costs required - unlimited
        }

        let minLimit = Infinity;
        let limitType = 'unknown';

        // Check gold/coin constraint (if action has a coin cost)
        if (hasCoinCost) {
            noteProvenance('/items/coin');
            const availableGold = byHrid['/items/coin'] || 0;
            const maxActionsFromGold = Math.floor(availableGold / actionDetails.coinCost);

            if (maxActionsFromGold < minLimit) {
                minLimit = maxActionsFromGold;
                limitType = 'gold';
            }
        }

        // Check input items (affected by Artisan Tea)
        if (hasInputItems) {
            for (const inputItem of actionDetails.inputItems) {
                noteProvenance(inputItem.itemHrid);
                const availableCount = byHrid[inputItem.itemHrid] || 0;

                // Apply Artisan reduction to required materials
                const requiredPerAction = inputItem.count * (1 - artisanBonus);

                // Calculate max queued actions for this material
                const maxActions = Math.floor(availableCount / requiredPerAction);

                if (maxActions < minLimit) {
                    minLimit = maxActions;
                    limitType = `material:${inputItem.itemHrid}`;
                }
            }
        }

        // Check upgrade item (NOT affected by Artisan Tea)
        if (hasUpgradeItem) {
            noteProvenance(hasUpgradeItem);
            const availableCount = byHrid[hasUpgradeItem] || 0;

            if (availableCount < minLimit) {
                minLimit = availableCount;
                limitType = `upgrade:${hasUpgradeItem}`;
            }
        }

        if (minLimit === Infinity) {
            return null;
        }

        return { maxActions: minLimit, limitType, isEstimated: usedEstimate };
    }

    /**
     * Catalyst draw per alchemy action. A catalyst is spent only on the attempts that succeed,
     * so the base success rate is both the per-action cost and the divisor the limit uses.
     * @param {Object} actionDetails - Action detail object
     * @param {Object|null} alchItemDetails - Item details for the item being alchemized
     * @returns {number} Catalysts consumed per action
     */
    getAlchemyCatalystRate(actionDetails, alchItemDetails) {
        if (actionDetails?.hrid?.includes('decompose')) return 0.6;
        if (actionDetails?.hrid?.includes('transmute')) {
            return alchItemDetails?.alchemyDetail?.transmuteSuccessRate || 0.5;
        }
        return 0.7;
    }

    /**
     * Artisan material reduction currently in effect for an action type.
     * @param {Object} actionDetails - Action detail object
     * @returns {number} Reduction as a 0-1 decimal
     */
    getArtisanBonusForAction(actionDetails) {
        const equipment = dataManager.getEquipment();
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
        const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
        return parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
    }

    /**
     * Cap a counted queue row's request at what its materials can actually buy.
     *
     * A counted row — "produce 500" — used to be displayed for all 500 while the ledger it
     * fed spent only the 40 it could pay for, so the row contradicted itself and every
     * "Complete at" clock after it was wrong. Both figures now come from the same limit.
     *
     * The rule is the one already chosen for limits: report the real remainder, zero
     * included. A row that can perform nothing shows no time rather than promising work
     * that will not happen.
     *
     * `limitType` is returned only when the cap actually binds. An unlimited row's figure
     * rests on the request the player typed, not on a material channel, so reporting one
     * would mislabel why it stops — and mark an exact figure as an estimate.
     *
     * @param {number} requested - Actions the row still asks for (maxCount − currentCount)
     * @param {Object} actionDetails - Action detail object for the row
     * @param {Object} inventoryLookup - Maps from buildInventoryLookup; read, never mutated
     * @param {Object} actionObj - Character action object (carries the item hashes)
     * @returns {{count: number, limitType: string|null, isEstimated: boolean}} Capped count,
     *      always a finite non-negative integer
     */
    capCountedRequestByMaterials(requested, actionDetails, inventoryLookup, actionObj) {
        // Neither a display nor the ledger may ever see Infinity, NaN or a negative
        const count = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
        const unlimited = { count, limitType: null, isEstimated: false };
        if (!inventoryLookup || !actionDetails) return unlimited;

        const artisanBonus = this.getArtisanBonusForAction(actionDetails);
        const limitResult = this.calculateMaterialLimit(actionDetails, inventoryLookup, artisanBonus, actionObj);
        if (!limitResult || !Number.isFinite(limitResult.maxActions)) return unlimited;

        const cap = Math.max(0, Math.floor(limitResult.maxActions));
        if (cap >= count) return unlimited;
        return { count: cap, limitType: limitResult.limitType, isEstimated: limitResult.isEstimated === true };
    }

    /**
     * Expected quantity for one drop-table entry, whose count is a range.
     * @param {Object} drop - Entry carrying minCount/maxCount, or a flat count
     * @returns {number} Average quantity per drop
     */
    getDropAverageCount(drop) {
        const min = Number.isFinite(drop?.minCount) ? drop.minCount : (drop?.count ?? 1);
        const max = Number.isFinite(drop?.maxCount) ? drop.maxCount : min;
        return (min + max) / 2;
    }

    /**
     * What one performed action of a queued row puts back into the bag.
     *
     * Split by provenance, because the two tiers are trusted differently. A deterministic
     * output (`outputItems`) is as good as stock in hand and the row resting on it stays
     * exact. An expected value — a drop rate, a min/max range, an alchemy success roll — is
     * a projection, and every figure downstream of it has to be marked as one.
     *
     * Alchemy outputs are not on the action: `/actions/alchemy/*` carries no outputItems and
     * no drop table at all. The item being alchemized carries them, in `alchemyDetail`, which
     * is where the profit calculator reads them from too — `decomposeItems` for decompose,
     * `transmuteDropTable` for transmute, and for coinify the `sellPrice x bulk x 5` formula
     * that has no table behind it. All three land only on a successful attempt, so all three
     * are expected values. Unrefine is left uncredited: nothing in the repo establishes what
     * it yields, and crediting nothing understates rather than overstates.
     *
     * Enhancing is excluded on purpose — its output is the same item at a higher level, not
     * a material anything downstream consumes as such.
     *
     * Efficiency is not applied, matching the spend: the ledger costs the queued action
     * count, not the free repeats efficiency grants.
     *
     * @param {Object} actionDetails - Action detail object for the row
     * @param {Object} actionObj - Character action object (carries the item hashes)
     * @returns {{deterministic: Array<Object>, estimated: Array<Object>}} Per one performed
     *      action, each entry {itemHrid, count}
     */
    getQueueActionOutputs(actionDetails, actionObj) {
        const outputs = { deterministic: [], estimated: [] };
        if (!actionDetails) return outputs;
        if (actionDetails.type === '/action_types/enhancing') return outputs;

        if (actionDetails.type === '/action_types/alchemy') {
            const { itemHrid } = this.parseItemHash(actionObj?.primaryItemHash || '');
            if (!itemHrid) return outputs;
            const alchItemDetails = dataManager.getItemDetails(itemHrid);
            const alchemyDetail = alchItemDetails?.alchemyDetail;
            if (!alchemyDetail) return outputs;

            const bulkMultiplier = alchemyDetail.bulkMultiplier || 1;
            // The same base success rate the catalyst draw is costed at, so the two sides of
            // one attempt cannot disagree. A catalyst or tea raises it, which makes the
            // credit an underestimate rather than an overestimate.
            const successRate = this.getAlchemyCatalystRate(actionDetails, alchItemDetails);
            const alchemyType = getAlchemyTypeFromActionHrid(actionDetails.hrid);

            if (alchemyType === 'coinify') {
                outputs.estimated.push({
                    itemHrid: '/items/coin',
                    count: (alchItemDetails.sellPrice || 0) * bulkMultiplier * 5 * successRate,
                });
            } else if (alchemyType === 'transmute') {
                for (const drop of alchemyDetail.transmuteDropTable || []) {
                    outputs.estimated.push({
                        itemHrid: drop.itemHrid,
                        count: (drop.dropRate ?? 1) * this.getDropAverageCount(drop) * bulkMultiplier * successRate,
                    });
                }
            } else if (alchemyType === 'decompose') {
                for (const output of alchemyDetail.decomposeItems || []) {
                    outputs.estimated.push({
                        itemHrid: output.itemHrid,
                        count: (output.count || 0) * bulkMultiplier * successRate,
                    });
                }
            }
            return outputs;
        }

        for (const output of actionDetails.outputItems || []) {
            outputs.deterministic.push({ itemHrid: output.itemHrid, count: output.count || 0 });
        }
        for (const table of [actionDetails.dropTable, actionDetails.essenceDropTable, actionDetails.rareDropTable]) {
            for (const drop of table || []) {
                outputs.estimated.push({
                    itemHrid: drop.itemHrid,
                    count: (drop.dropRate ?? 1) * this.getDropAverageCount(drop),
                });
            }
        }
        return outputs;
    }

    /**
     * Credit one queued action's outputs into the queue-walk ledger.
     *
     * Only rows after this one can draw on them, which the walk order already gives: the
     * callers credit a row after costing it and before costing the next.
     *
     * Balances may become fractional — an expected 41.6 essence is a better basis than 41 or
     * 42 — and stay that way in the ledger. `calculateMaterialLimit` floors at the point of
     * use, so a limit of 41.6 actions still displays as 41.
     *
     * @param {Object} inventoryLookup - Maps from buildInventoryLookup; mutated in place
     * @param {Object} actionDetails - Action detail object for the row being credited
     * @param {Object} actionObj - Character action object (carries the item hashes)
     * @param {number} performed - Actions the row actually performs
     * @param {boolean} creditStochastic - Whether expected yields count, or deterministic only
     * @returns {void}
     */
    creditQueueActionOutputs(inventoryLookup, actionDetails, actionObj, performed, creditStochastic) {
        if (!(performed > 0)) return;
        const byHrid = inventoryLookup?.byHrid;
        const byEnhancedKey = inventoryLookup?.byEnhancedKey;
        if (!byHrid || !byEnhancedKey) return;
        if (!(inventoryLookup.estimatedHrids instanceof Set)) {
            inventoryLookup.estimatedHrids = new Set();
        }

        // Produced items arrive unenhanced, so the level-0 stack is the one that moves —
        // the same key the alchemy branch of the limit reads.
        const gain = (itemHrid, amount, isEstimated) => {
            if (!itemHrid || !Number.isFinite(amount) || amount <= 0) return;
            byHrid[itemHrid] = Math.max(0, (byHrid[itemHrid] || 0) + amount);
            const key = `${itemHrid}::0`;
            byEnhancedKey[key] = Math.max(0, (byEnhancedKey[key] || 0) + amount);
            if (isEstimated) inventoryLookup.estimatedHrids.add(itemHrid);
        };

        const outputs = this.getQueueActionOutputs(actionDetails, actionObj);
        for (const output of outputs.deterministic) {
            gain(output.itemHrid, output.count * performed, false);
        }
        if (creditStochastic) {
            for (const output of outputs.estimated) {
                gain(output.itemHrid, output.count * performed, true);
            }
        }
    }

    /**
     * Spend one queued action's materials out of a queue-walk inventory ledger, and credit
     * back what it produces.
     *
     * The queue runs in order, so every action after the first can only draw on what its
     * predecessors left behind. `calculateSingleQueueActionTime` is deliberately pure with
     * respect to the lookup it is handed — it also serves single-action displays, where the
     * whole bag genuinely is the correct basis — so the running ledger lives here, called
     * from the callers' loops between rows.
     *
     * Every channel `calculateMaterialLimit` counts is spent here. A channel that can limit a
     * row but is never spent would leave later rows costed against materials already used.
     *
     * @param {Object} inventoryLookup - Maps from buildInventoryLookup; mutated in place
     * @param {Object} actionDetails - Action detail object for the row being spent
     * @param {Object} actionObj - Character action object (carries the item hashes)
     * @param {Object} timing - The row's timing, needing only {count, isTrulyInfinite}
     * @param {Object} [options] - {creditStochastic} — false credits deterministic outputs only,
     *   which is what the activity projection wants: it warns about an idle alt, so an expected
     *   yield that may not arrive must not push its deadline out
     * @returns {number} Actions actually paid for, which is what the row performs
     */
    deductQueueActionMaterials(inventoryLookup, actionDetails, actionObj, timing, options = {}) {
        const byHrid = inventoryLookup?.byHrid;
        const byEnhancedKey = inventoryLookup?.byEnhancedKey;
        if (!byHrid || !byEnhancedKey || !actionDetails || !timing) return 0;
        // An unbounded action never hands the queue back, so nothing after it is reachable and
        // no finite quantity describes what it consumes.
        if (timing.isTrulyInfinite) return 0;

        const artisanBonus = this.getArtisanBonusForAction(actionDetails);

        // What the row performs, not what it asked for: a request for 500 backed by materials
        // for 40 consumes 40. The queue walks now cap a counted row's displayed count the same
        // way, so this clamp agrees with the display rather than contradicting it; it stays
        // because a caller that passes a raw count (the edit menu's current-action block) must
        // still be charged only for what it can pay for.
        let performed = Number.isFinite(timing.count) ? Math.max(0, Math.floor(timing.count)) : 0;
        const limit = this.calculateMaterialLimit(actionDetails, inventoryLookup, artisanBonus, actionObj);
        if (limit && Number.isFinite(limit.maxActions)) {
            performed = Math.min(performed, Math.max(0, limit.maxActions));
        }
        if (performed <= 0) return 0;
        const creditStochastic = options.creditStochastic !== false;
        const credit = () => {
            this.creditQueueActionOutputs(inventoryLookup, actionDetails, actionObj, performed, creditStochastic);
            return performed;
        };

        // byHrid holds the total across enhancement levels and byEnhancedKey the per-level
        // stack; both have to fall or the alchemy branch and the generic branch disagree.
        const spend = (itemHrid, amount, enhancementLevel = 0) => {
            if (!itemHrid || !(amount > 0)) return;
            byHrid[itemHrid] = Math.max(0, (byHrid[itemHrid] || 0) - amount);
            const key = `${itemHrid}::${enhancementLevel}`;
            byEnhancedKey[key] = Math.max(0, (byEnhancedKey[key] || 0) - amount);
        };

        if (actionDetails.type === '/action_types/enhancing' && actionObj?.primaryItemHash) {
            const { itemHrid } = this.parseItemHash(actionObj.primaryItemHash);
            const costs = itemHrid ? dataManager.getItemDetails(itemHrid)?.enhancementCosts : null;
            const hasCosts = Array.isArray(costs) && costs.length > 0;
            // The same draw the limit was computed from, so the row is charged for exactly
            // the attempts it was displayed for. A fractional balance is fine — the ledger
            // already carries expected quantities, and the limit floors at the point of use.
            const protection = this.getEnhancingProtectionDraw(actionDetails, actionObj);
            const drawsProtection = protection ? protection.perAction > 0 : false;
            if (hasCosts || drawsProtection) {
                if (hasCosts) {
                    for (const cost of costs) {
                        spend(cost.itemHrid, cost.count * performed);
                    }
                }
                if (drawsProtection) {
                    spend(protection.itemHrid, protection.perAction * performed);
                }
                return performed;
            }
        }

        if (actionDetails.type === '/action_types/alchemy' && actionObj?.primaryItemHash) {
            const { itemHrid, level } = this.parseItemHash(actionObj.primaryItemHash);
            if (itemHrid) {
                const alchItemDetails = dataManager.getItemDetails(itemHrid);
                spend(itemHrid, performed * (alchItemDetails?.alchemyDetail?.bulkMultiplier || 1), level);

                // The fee is absent from the game's action data; utils/alchemy-fees.js is the
                // one place that states it, and the limit is computed from the same call.
                const alchemyType = getAlchemyTypeFromActionHrid(actionDetails.hrid);
                const alchemyCoinCost =
                    alchemyType && alchemyType !== 'coinify' ? getAlchemyCoinCost(alchItemDetails, alchemyType) : 0;
                spend('/items/coin', performed * alchemyCoinCost);

                if (actionObj.secondaryItemHash) {
                    const { itemHrid: catalystHrid } = this.parseItemHash(actionObj.secondaryItemHash);
                    spend(catalystHrid, performed * this.getAlchemyCatalystRate(actionDetails, alchItemDetails));
                }
                return credit();
            }
        }

        if (actionDetails.coinCost > 0) {
            spend('/items/coin', performed * actionDetails.coinCost);
        }
        for (const inputItem of actionDetails.inputItems || []) {
            spend(inputItem.itemHrid, performed * inputItem.count * (1 - artisanBonus));
        }
        // Upgrade items are not reduced by Artisan, matching the limit
        if (actionDetails.upgradeItemHrid) {
            spend(actionDetails.upgradeItemHrid, performed);
        }
        return credit();
    }

    /**
     * Match an action from cache by reading its name from a queue div
     * @param {HTMLElement} actionDiv - The queue action div element
     * @param {Array} cachedActions - Array of actions from dataManager
     * @returns {Object|null} Matched action object or null
     */
    matchActionFromDiv(actionDiv, cachedActions, usedActionIds = new Set()) {
        // Find the action text element within the div
        const actionTextContainer = actionDiv.querySelector('[class*="QueuedActions_actionText"]');
        if (!actionTextContainer) {
            return null;
        }

        // The first child div contains the action name: "#3 🧪 Coinify: Foraging Essence"
        const firstChildDiv = actionTextContainer.querySelector('[class*="QueuedActions_text__"]');
        if (!firstChildDiv) {
            return null;
        }

        // Check if this is an enhancing action by looking at the SVG icon
        const svgIcon = firstChildDiv.querySelector('svg use');
        const isEnhancingAction = svgIcon && svgIcon.getAttribute('href')?.includes('#enhancing');

        // Get the text content (format: "#3Coinify: Foraging Essence" - no space after number!)
        const fullText = firstChildDiv.textContent.trim();

        // Remove position number: "#3Coinify: Foraging Essence" → "Coinify: Foraging Essence"
        // Note: No space after the number in the actual text
        const actionNameText = fullText.replace(/^#\d+/, '').trim();

        // Handle enhancing actions specially
        if (isEnhancingAction) {
            // For enhancing, the text is just the item name (e.g., "Cheese Sword")
            const itemName = actionNameText.replace(/\s*\+\d+$/, '');
            const itemHrid = '/items/' + itemName.toLowerCase().replace(/\s+/g, '_');

            // Find enhancing action matching this item (excluding already-used actions)
            return cachedActions.find((a) => {
                if (usedActionIds.has(a.id)) {
                    return false; // Skip already-matched actions
                }

                const actionDetails = dataManager.getActionDetails(a.actionHrid);
                if (!actionDetails || actionDetails.type !== '/action_types/enhancing') {
                    return false;
                }

                // Match on primaryItemHash (the item being enhanced)
                return a.primaryItemHash && a.primaryItemHash.includes(itemHrid);
            });
        }

        // Parse action name (same logic as main display)
        let actionNameFromDiv, itemNameFromDiv;
        if (actionNameText.includes(':')) {
            const parts = actionNameText.split(':');
            actionNameFromDiv = parts[0].trim();
            itemNameFromDiv = parts.slice(1).join(':').trim();
        } else {
            actionNameFromDiv = actionNameText;
            itemNameFromDiv = null;
        }

        // Match action from cache (same logic as main display, excluding already-used actions)
        return cachedActions.find((a) => {
            if (usedActionIds.has(a.id)) {
                return false; // Skip already-matched actions
            }

            const actionDetails = dataManager.getActionDetails(a.actionHrid);
            if (!actionDetails) {
                return false;
            }

            if (actionDetails.name !== actionNameFromDiv) {
                const itemHridFromDiv = itemNameFromDiv
                    ? `/items/${itemNameFromDiv.toLowerCase().replace(/\s+/g, '_')}`
                    : `/items/${actionNameFromDiv.toLowerCase().replace(/\s+/g, '_')}`;
                const outputItems = actionDetails.outputItems || [];
                const dropTable = actionDetails.dropTable || [];
                const matchesOutput = outputItems.some((item) => item.itemHrid === itemHridFromDiv);
                const matchesDrop = dropTable.some((drop) => drop.itemHrid === itemHridFromDiv);

                if (!matchesOutput && !matchesDrop) {
                    return false;
                }
            }

            // If there's an item name, match on primaryItemHash
            if (itemNameFromDiv && a.primaryItemHash) {
                const { itemHrid: hashItemHrid } = this.parseItemHash(a.primaryItemHash);
                if (hashItemHrid) {
                    const hashItemDetails = dataManager.getItemDetails(hashItemHrid);
                    if (hashItemDetails?.name === itemNameFromDiv) return true;
                }
                const itemHrid = '/items/' + itemNameFromDiv.toLowerCase().replace(/\s+/g, '_');
                return a.primaryItemHash.includes(itemHrid);
            }

            return true;
        });
    }

    /**
     * Inject time display into queue tooltip
     * @param {HTMLElement} queueMenu - Queue menu container element
     */
    injectQueueTimes(queueMenu) {
        // The setting this section is named for; the value rows are created in
        // here too, so off means the queue is left entirely untouched
        if (!config.getSetting('actionQueue')) return;

        // Track if we need to reconnect observer at the end
        let shouldReconnectObserver = false;

        try {
            // Get all queued actions
            const currentActions = dataManager.getCurrentActions();
            if (!currentActions || currentActions.length === 0) {
                return;
            }

            // Find all action divs in the queue (individual actions only, not wrapper or text containers)
            const actionDivs = queueMenu.querySelectorAll('[class*="QueuedActions_action__"]');
            if (actionDivs.length === 0) {
                return;
            }

            const inventoryLookup = this.buildInventoryLookup(dataManager.getInventory());

            // Clear all existing time and profit displays to prevent duplicates
            queueMenu.querySelectorAll('.mwi-queue-action-time').forEach((el) => el.remove());
            queueMenu.querySelectorAll('.mwi-queue-action-profit').forEach((el) => el.remove());
            const existingTotal = document.querySelector('#mwi-queue-total-time');
            if (existingTotal) {
                existingTotal.remove();
            }

            // Observer is already disconnected by callback - we'll reconnect in finally
            shouldReconnectObserver = true;

            let accumulatedTime = 0;
            let hasInfinite = false;
            // Sticky, as in the tooltip: a clock built on a running total that includes an
            // estimated row is itself an estimate.
            let hasEstimate = false;
            const actionsToCalculate = []; // Store actions for async profit calculation (with time in seconds)

            // Detect current action from DOM so we can avoid double-counting
            let currentAction = null;
            const actionNameElement = document.querySelector('div[class*="Header_actionName"]');
            if (actionNameElement && actionNameElement.textContent) {
                const actionNameText = this.getCleanActionName(actionNameElement);
                const sorted = [...currentActions].sort((a, b) => a.ordinal - b.ordinal);
                currentAction = this.matchCurrentActionFromText(sorted.slice(0, 1), actionNameText);
            }

            // Calculate time for current action to include in total
            // Always include current action time, even if it appears in queue
            if (currentAction) {
                const actionDetails = dataManager.getActionDetails(currentAction.actionHrid);
                if (actionDetails) {
                    const isEnhancing = actionDetails.type === '/action_types/enhancing';

                    // Check if infinite BEFORE calculating count
                    const isInfinite = !currentAction.hasMaxCount || currentAction.actionHrid.includes('/combat/');

                    let actionTimeSeconds = 0; // Time spent on this action (for profit calculation)
                    let count = 0; // Queued action count for profit calculation
                    let baseActionsNeeded = 0; // Time-consuming actions for time calculation

                    if (isEnhancing) {
                        // Enhancing: use enhancement-specific time calculation, capped at what
                        // its per-attempt costs can pay for like every other counted row
                        const enhancingTime = this.calculateEnhancingQueueTime(
                            currentAction,
                            actionDetails,
                            inventoryLookup,
                            { limitCountedByMaterials: true }
                        );
                        if (enhancingTime) {
                            count = enhancingTime.count;
                            actionTimeSeconds = enhancingTime.totalTime;
                            accumulatedTime += enhancingTime.totalTime;
                        } else if (isInfinite) {
                            hasInfinite = true;
                        }
                    } else if (isInfinite) {
                        // Check for material limit on infinite actions
                        const equipment = dataManager.getEquipment();
                        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
                        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
                        const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
                        const artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);

                        // Calculate action stats to get efficiency
                        const timeData = this.calculateActionTime(actionDetails, currentAction.actionHrid);
                        if (timeData) {
                            const { actionTime, totalEfficiency } = timeData;
                            const limitResult = this.calculateMaterialLimit(
                                actionDetails,
                                inventoryLookup,
                                artisanBonus,
                                currentAction
                            );

                            // Not `|| null`: a limit of 0 is a real answer (the bag is empty),
                            // and coercing it to null would report the action as infinite
                            const materialLimit = limitResult ? limitResult.maxActions : null;

                            if (materialLimit !== null) {
                                // Material-limited infinite action - calculate time
                                count = materialLimit; // Max queued actions based on materials
                                const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);
                                baseActionsNeeded = Math.ceil(count / avgActionsPerBaseAction);
                                const elapsedInCurrentUnit = dataManager.getElapsedSecondsInCurrentUnit(
                                    currentAction.id,
                                    currentAction.currentCount,
                                    actionTime
                                );
                                const totalTime = Math.max(0, baseActionsNeeded * actionTime - elapsedInCurrentUnit);
                                accumulatedTime += totalTime;
                                actionTimeSeconds = totalTime;
                            }
                        } else {
                            // Could not calculate action time
                            hasInfinite = true;
                        }
                    } else {
                        // Counted row: shown for what its materials can actually buy, the same
                        // rule the shared helper applies for the queue tooltip. This block
                        // duplicates that timing logic inline; the two must stay in step.
                        count = this.capCountedRequestByMaterials(
                            currentAction.maxCount - currentAction.currentCount,
                            actionDetails,
                            inventoryLookup,
                            currentAction
                        ).count;
                        const timeData = this.calculateActionTime(actionDetails, currentAction.actionHrid);
                        if (timeData) {
                            const { actionTime, totalEfficiency } = timeData;

                            // Calculate average queued actions per time-consuming action
                            const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);

                            // Calculate time-consuming actions needed
                            baseActionsNeeded = Math.ceil(count / avgActionsPerBaseAction);
                            const elapsedInCurrentUnit = dataManager.getElapsedSecondsInCurrentUnit(
                                currentAction.id,
                                currentAction.currentCount,
                                actionTime
                            );
                            const totalTime = Math.max(0, baseActionsNeeded * actionTime - elapsedInCurrentUnit);
                            accumulatedTime += totalTime;
                            actionTimeSeconds = totalTime;
                        }
                    }

                    // The current action runs before every queued row, so its materials are
                    // gone by the time those rows are costed.
                    //
                    // No `isTrulyInfinite` is passed, deliberately. The flag the helper
                    // wants means "endless AND unbounded by materials"; the `isInfinite`
                    // in scope here only means "queued with no count", which is also true
                    // of a Repeat-∞ action that materials cap at 27k actions — and that
                    // one must spend. Passing it would silence exactly the case that has
                    // to be charged. `count` is 0 for an action with no count, so the
                    // helper's own `performed <= 0` guard is what stops the endless case,
                    // and a material-limited one still spends what it performs.
                    this.deductQueueActionMaterials(inventoryLookup, actionDetails, currentAction, { count });

                    // Store action for profit calculation (done async after UI renders)
                    // Skip enhancing actions — no profit applies
                    if (actionTimeSeconds > 0 && !isEnhancing) {
                        actionsToCalculate.push({
                            actionHrid: currentAction.actionHrid,
                            primaryItemHash: currentAction.primaryItemHash || null,
                            timeSeconds: actionTimeSeconds,
                            count: count,
                            baseActionsNeeded: baseActionsNeeded,
                        });
                    }
                }
            }

            // Now process queued actions by reading from each div
            // Each div shows a queued action, and we match it to cache by name
            // Track used action IDs to prevent duplicate matching (e.g., two identical infinite actions)
            const usedActionIds = new Set();

            // CRITICAL FIX: Always mark current action as used to prevent queue from matching it
            // The isCurrentActionInQueue flag only controls whether we add current action time to total
            if (currentAction) {
                usedActionIds.add(currentAction.id);
            }

            for (let divIndex = 0; divIndex < actionDivs.length; divIndex++) {
                const actionDiv = actionDivs[divIndex];

                // Match this div's action from the cache (excluding already-matched actions)
                const actionObj = this.matchActionFromDiv(actionDiv, currentActions, usedActionIds);

                if (!actionObj) {
                    // Could not match action - show unknown
                    const timeDiv = document.createElement('div');
                    timeDiv.className = 'mwi-queue-action-time';
                    timeDiv.style.cssText = `
                        color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
                        font-size: 0.85em;
                        margin-top: 2px;
                    `;
                    timeDiv.textContent = '[Unknown action]';

                    const actionTextContainer = actionDiv.querySelector('[class*="QueuedActions_actionText"]');
                    if (actionTextContainer) {
                        actionTextContainer.appendChild(timeDiv);
                    } else {
                        actionDiv.appendChild(timeDiv);
                    }

                    continue;
                }

                // Mark this action as used for subsequent divs
                usedActionIds.add(actionObj.id);

                const actionDetails = dataManager.getActionDetails(actionObj.actionHrid);
                if (!actionDetails) {
                    console.warn('[Action Time Display] Unknown queued action:', actionObj.actionHrid);
                    continue;
                }

                const isEnhancing = actionDetails.type === '/action_types/enhancing';

                // Check if infinite BEFORE calculating count
                const isInfinite = !actionObj.hasMaxCount || actionObj.actionHrid.includes('/combat/');

                let totalTime;
                let actionTimeSeconds = 0;
                let baseActionsNeeded = 0;
                let count = 0;
                let isTrulyInfinite = false;
                let materialLimit = null;
                let limitType = null;
                let materialLimitIsEstimated = false;

                if (isEnhancing) {
                    // Enhancing: use enhancement-specific time calculation, capped at what its
                    // per-attempt costs can pay for like every other counted row
                    const enhancingTime = this.calculateEnhancingQueueTime(actionObj, actionDetails, inventoryLookup, {
                        limitCountedByMaterials: true,
                    });
                    if (enhancingTime) {
                        count = enhancingTime.count;
                        totalTime = enhancingTime.totalTime;
                        actionTimeSeconds = enhancingTime.totalTime;
                        accumulatedTime += enhancingTime.totalTime;
                        // Only when the cap bound, as in the non-enhancing branch below
                        if (enhancingTime.limitType) {
                            materialLimit = enhancingTime.count;
                            limitType = enhancingTime.limitType;
                        }
                        // As in the shared helper: the estimate marker is not tied to a named
                        // channel, because an uncounted row's figure is the material limit itself
                        if (enhancingTime.materialLimitIsEstimated === true) {
                            materialLimitIsEstimated = true;
                        }
                    } else if (isInfinite) {
                        isTrulyInfinite = true;
                        hasInfinite = true;
                        totalTime = Infinity;
                    } else {
                        totalTime = 0;
                    }
                } else {
                    // Non-enhancing: use standard calculation
                    // Calculate action time first to get efficiency
                    const timeData = this.calculateActionTime(actionDetails, actionObj.actionHrid);
                    if (!timeData) continue;

                    const { actionTime, totalEfficiency } = timeData;

                    // Calculate material limit for infinite actions
                    if (isInfinite) {
                        const equipment = dataManager.getEquipment();
                        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
                        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
                        const activeDrinks = dataManager.getActionDrinkSlots(actionDetails.type);
                        const artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);

                        const limitResult = this.calculateMaterialLimit(
                            actionDetails,
                            inventoryLookup,
                            artisanBonus,
                            actionObj
                        );

                        if (limitResult) {
                            materialLimit = limitResult.maxActions;
                            limitType = limitResult.limitType;
                            materialLimitIsEstimated = limitResult.isEstimated === true;
                        }
                    }

                    // Determine if truly infinite (no material limit)
                    isTrulyInfinite = isInfinite && materialLimit === null;

                    if (isTrulyInfinite) {
                        hasInfinite = true;
                    }

                    // Calculate count for finite actions or material-limited infinite actions
                    if (!isInfinite) {
                        // As in the shared helper: a counted row is displayed for what it can
                        // actually run. `materialLimit` is set only when the cap binds, so an
                        // unlimited counted row keeps its plain `[time]` bracket.
                        const capped = this.capCountedRequestByMaterials(
                            actionObj.maxCount - actionObj.currentCount,
                            actionDetails,
                            inventoryLookup,
                            actionObj
                        );
                        count = capped.count;
                        if (capped.limitType !== null) {
                            materialLimit = capped.count;
                            limitType = capped.limitType;
                            materialLimitIsEstimated = capped.isEstimated;
                        }
                    } else if (materialLimit !== null) {
                        count = materialLimit;
                    }

                    // Calculate total time for this action
                    if (isTrulyInfinite) {
                        totalTime = Infinity;
                    } else {
                        // Calculate time-consuming actions needed
                        const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);
                        baseActionsNeeded = Math.ceil(count / avgActionsPerBaseAction);
                        totalTime = baseActionsNeeded * actionTime;
                        accumulatedTime += totalTime;
                        actionTimeSeconds = totalTime;
                    }
                }

                // Spend this row's materials before the next row is costed — the queue runs in
                // order, so without this every row claims the whole starting bag
                this.deductQueueActionMaterials(inventoryLookup, actionDetails, actionObj, {
                    count,
                    isTrulyInfinite,
                });

                // Store action for profit calculation (done async after UI renders)
                // Skip enhancing actions — no profit applies
                if (actionTimeSeconds > 0 && !isTrulyInfinite && !isEnhancing) {
                    actionsToCalculate.push({
                        actionHrid: actionObj.actionHrid,
                        primaryItemHash: actionObj.primaryItemHash || null,
                        timeSeconds: actionTimeSeconds,
                        count: count,
                        baseActionsNeeded: baseActionsNeeded,
                        divIndex: divIndex, // Store index to match back to DOM element
                    });
                }

                if (materialLimitIsEstimated) hasEstimate = true;

                // Format completion time
                let completionText = '';
                if (!hasInfinite && !isTrulyInfinite) {
                    const completionDate = new Date();
                    completionDate.setSeconds(completionDate.getSeconds() + accumulatedTime);
                    const isToday = completionDate.toDateString() === new Date().toDateString();
                    const mark = hasEstimate ? '~' : '';

                    completionText = ` Complete at ${mark}${formatCompletionTime(completionDate, !isToday)}`;
                }

                // Create time display element
                const timeDiv = document.createElement('div');
                timeDiv.className = 'mwi-queue-action-time';
                timeDiv.style.cssText = `
                    color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
                    font-size: 0.85em;
                    margin-top: 2px;
                `;

                if (isTrulyInfinite) {
                    timeDiv.textContent = '[∞]';
                } else if (isInfinite && materialLimit !== null) {
                    // Material-limited infinite action
                    let limitLabel = '';
                    if (limitType === 'gold') {
                        limitLabel = 'gold';
                    } else if (limitType && limitType.startsWith('material:')) {
                        limitLabel = 'mat';
                    } else if (limitType && limitType.startsWith('upgrade:')) {
                        limitLabel = 'upgrade';
                    } else {
                        limitLabel = 'max';
                    }
                    const timeStr = timeReadable(totalTime);
                    const mark = materialLimitIsEstimated ? '~' : '';
                    timeDiv.textContent = `[${timeStr} · ${limitLabel}: ${mark}${this.formatLargeNumber(materialLimit)}]${completionText}`;
                } else {
                    const timeStr = timeReadable(totalTime);
                    timeDiv.textContent = `[${timeStr}]${completionText}`;
                }

                // Find the actionText container and append inside it
                const actionTextContainer = actionDiv.querySelector('[class*="QueuedActions_actionText"]');
                if (actionTextContainer) {
                    actionTextContainer.appendChild(timeDiv);
                } else {
                    // Fallback: append to action div
                    actionDiv.appendChild(timeDiv);
                }

                // Create empty profit div for this action (will be populated asynchronously)
                // Skip enhancing actions — no profit applies
                if (
                    !isTrulyInfinite &&
                    actionTimeSeconds > 0 &&
                    !isEnhancing &&
                    config.getSettingValue('actionQueue_showValue', true)
                ) {
                    const profitDiv = document.createElement('div');
                    profitDiv.className = 'mwi-queue-action-profit';
                    profitDiv.dataset.divIndex = divIndex;
                    profitDiv.style.cssText = `
                        color: var(--text-color-secondary, ${config.COLOR_TEXT_SECONDARY});
                        font-size: 0.85em;
                        margin-top: 2px;
                    `;
                    // Leave empty - will be filled by async calculation
                    profitDiv.textContent = '';

                    if (actionTextContainer) {
                        actionTextContainer.appendChild(profitDiv);
                    } else {
                        actionDiv.appendChild(profitDiv);
                    }
                }
            }

            // Add total time at bottom (includes current action + all queued)
            const totalDiv = document.createElement('div');
            totalDiv.id = 'mwi-queue-total-time';
            totalDiv.style.cssText = `
                color: var(--text-color-primary, ${config.COLOR_TEXT_PRIMARY});
                font-weight: bold;
                margin-top: 12px;
                padding: 8px;
                border-top: 1px solid var(--border-color, ${config.COLOR_BORDER});
                text-align: center;
            `;

            // Build total time text
            let totalText = '';
            if (hasInfinite) {
                // Show finite time first, then add infinity indicator
                if (accumulatedTime > 0) {
                    totalText = `Total time: ${timeReadable(accumulatedTime)} + [∞]`;
                } else {
                    totalText = 'Total time: [∞]';
                }
            } else {
                totalText = `Total time: ${timeReadable(accumulatedTime)}`;
            }

            totalDiv.innerHTML = totalText;

            // Insert after queue menu
            queueMenu.insertAdjacentElement('afterend', totalDiv);

            // Calculate profit asynchronously (non-blocking)
            if (
                actionsToCalculate.length > 0 &&
                marketAPI.isLoaded() &&
                config.getSettingValue('actionQueue_showValue', true)
            ) {
                // Async will handle observer reconnection after updates complete
                shouldReconnectObserver = false;
                this.calculateAndDisplayTotalProfit(totalDiv, actionsToCalculate, totalText, queueMenu);
            }
        } catch (error) {
            console.error('[Toolasha] Error injecting queue times:', error);
        } finally {
            // Reconnect observer only if async didn't take over
            if (shouldReconnectObserver) {
                this.setupQueueMenuObserver(queueMenu);
            }
        }
    }

    /**
     * Calculate and display total profit asynchronously (non-blocking)
     * @param {HTMLElement} totalDiv - The total display div element
     * @param {Array} actionsToCalculate - Array of {actionHrid, timeSeconds, count, baseActionsNeeded, divIndex} objects
     * @param {string} baseText - Base text (time) to prepend
     * @param {HTMLElement} queueMenu - Queue menu element to reconnect observer after updates
     */
    async calculateAndDisplayTotalProfit(totalDiv, actionsToCalculate, baseText, queueMenu) {
        // Generate unique ID for this calculation to prevent race conditions
        const calculationId = Date.now() + Math.random();
        this.activeProfitCalculationId = calculationId;

        try {
            let totalProfit = 0;
            let hasProfitData = false;

            // Create all profit calculation promises at once (parallel execution)
            const profitPromises = actionsToCalculate.map(
                (action) =>
                    Promise.race([
                        this.calculateProfitForAction(action),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500)),
                    ]).catch(() => null) // Convert rejections to null
            );

            // Wait for all calculations to complete in parallel
            const results = await Promise.allSettled(profitPromises);

            // Check if this calculation is still valid (character might have switched)
            if (this.activeProfitCalculationId !== calculationId) {
                return;
            }

            // Aggregate results and update individual action profit displays
            results.forEach((result, index) => {
                const actionProfit = result.status === 'fulfilled' && result.value !== null ? result.value : null;

                if (actionProfit !== null) {
                    totalProfit += actionProfit;
                    hasProfitData = true;

                    // Update individual action's profit display
                    const action = actionsToCalculate[index];
                    if (action.divIndex !== undefined) {
                        const profitDiv = document.querySelector(
                            `.mwi-queue-action-profit[data-div-index="${action.divIndex}"]`
                        );
                        if (profitDiv) {
                            const profitColor =
                                actionProfit >= 0
                                    ? config.getSettingValue('color_profit', '#4ade80')
                                    : config.getSettingValue('color_loss', '#f87171');
                            const profitSign = actionProfit >= 0 ? '+' : '';
                            profitDiv.innerHTML = `Profit: <span style="color: ${profitColor};">${profitSign}${this.formatLargeNumber(Math.abs(Math.round(actionProfit)))}</span>`;
                        }
                    }
                }
            });

            // Update display with value
            if (hasProfitData) {
                // Get value mode setting to determine label and color
                const valueMode = config.getSettingValue('actionQueue_valueMode', 'profit');
                const isEstimatedValue = valueMode === 'estimated_value';

                // Estimated value is always positive (revenue), so always use profit color
                // Profit can be negative, so use appropriate color
                const valueColor =
                    isEstimatedValue || totalProfit >= 0
                        ? config.getSettingValue('color_profit', '#4ade80')
                        : config.getSettingValue('color_loss', '#f87171');
                const valueSign = totalProfit >= 0 ? '+' : '';
                const valueLabel = isEstimatedValue ? 'Estimated value' : 'Total profit';
                const valueText = `<br>${valueLabel}: <span style="color: ${valueColor};">${valueSign}${this.formatLargeNumber(Math.abs(Math.round(totalProfit)))}</span>`;
                totalDiv.innerHTML = baseText + valueText;
            }
        } catch (error) {
            console.warn('[Action Time Display] Error calculating total profit:', error);
        } finally {
            // CRITICAL: Reconnect mutation observer after ALL DOM updates are complete
            // This prevents infinite loop by ensuring observer only reconnects once all profit divs are updated
            this.setupQueueMenuObserver(queueMenu);
        }
    }

    /**
     * Calculate profit or estimated value for a single action based on action count
     * @param {Object} action - Action object with {actionHrid, timeSeconds, count, baseActionsNeeded}
     * @returns {Promise<number|null>} Total value (profit or revenue) or null if unavailable
     */
    async calculateProfitForAction(action) {
        const actionDetails = dataManager.getActionDetails(action.actionHrid);
        if (!actionDetails) {
            return null;
        }

        const valueMode = config.getSettingValue('actionQueue_valueMode', 'profit');

        // Get profit data (already has profitPerAction calculated)
        let profitData = null;
        let isAlchemy = false;

        if (actionDetails.type === '/action_types/alchemy' && action.primaryItemHash) {
            profitData = this.calculateAlchemyProfitForAction(action);
            isAlchemy = !!profitData;
        }

        if (!profitData) {
            const gatheringProfit = await calculateGatheringProfit(action.actionHrid);
            if (gatheringProfit) {
                profitData = gatheringProfit;
            } else if (actionDetails.outputItems?.[0]?.itemHrid) {
                // Named, because the panel is showing one action: without it the calculator
                // could answer about a different recipe that happens to yield the same item
                profitData = await profitCalculator.calculateProfit(actionDetails.outputItems[0].itemHrid, {
                    actionHrid: action.actionHrid,
                });
            }
        }

        if (!profitData) {
            return null;
        }

        const actionsCount = action.count ?? 0;
        if (!actionsCount) {
            return 0;
        }

        if (typeof profitData.actionsPerHour !== 'number') {
            return null;
        }

        if (isAlchemy) {
            const profitPerAction = profitData.profitPerHour / profitData.actionsPerHour;
            const totalProfit = profitPerAction * actionsCount;
            if (valueMode === 'estimated_value') {
                const revenuePerAction = (profitData.revenuePerHour || 0) / profitData.actionsPerHour;
                return revenuePerAction * actionsCount;
            }
            return totalProfit;
        }

        if (profitData.baseOutputs) {
            const totals = calculateGatheringActionTotalsFromBase({
                actionsCount,
                actionsPerHour: profitData.actionsPerHour,
                baseOutputs: profitData.baseOutputs,
                bonusDrops: profitData.bonusRevenue?.bonusDrops || [],
                processingRevenueBonusPerAction: profitData.processingRevenueBonusPerAction,
                gourmetRevenueBonusPerAction: profitData.gourmetRevenueBonusPerAction,
                drinkCostPerHour: profitData.drinkCostPerHour,
                efficiencyMultiplier: profitData.efficiencyMultiplier || 1,
            });
            return valueMode === 'estimated_value' ? totals.totalRevenue : totals.totalProfit;
        }

        const totals = calculateProductionActionTotalsFromBase({
            actionsCount,
            actionsPerHour: profitData.actionsPerHour,
            outputAmount: profitData.outputAmount || 1,
            outputPrice: profitData.outputPrice,
            gourmetBonus: profitData.gourmetBonus || 0,
            bonusDrops: profitData.bonusRevenue?.bonusDrops || [],
            materialCosts: profitData.materialCosts,
            totalTeaCostPerHour: profitData.totalTeaCostPerHour,
            efficiencyMultiplier: profitData.efficiencyMultiplier || 1,
        });

        return valueMode === 'estimated_value' ? totals.totalRevenue : totals.totalProfit;
    }

    /**
     * Calculate alchemy profit for a queued action using the alchemy profit calculator.
     * @param {Object} action - Action object with {actionHrid, primaryItemHash}
     * @returns {Object|null} Profit data with profitPerHour and actionsPerHour, or null
     */
    calculateAlchemyProfitForAction(action) {
        const { itemHrid, level: enhancementLevel } = this.parseItemHash(action.primaryItemHash);
        if (!itemHrid) return null;

        const actionHrid = action.actionHrid;

        if (actionHrid === '/actions/alchemy/coinify') {
            return alchemyProfitCalculator.calculateCoinifyProfit(itemHrid, enhancementLevel || 0, true);
        } else if (actionHrid === '/actions/alchemy/transmute') {
            return alchemyProfitCalculator.calculateTransmuteProfit(itemHrid, true);
        } else if (actionHrid === '/actions/alchemy/decompose') {
            return alchemyProfitCalculator.calculateDecomposeProfit(itemHrid, enhancementLevel || 0, true);
        }

        return null;
    }

    /**
     * Calculate and display profit in the action bar for the current action.
     * @param {Object} action - Current action object from dataManager
     * @param {number} remainingActions - Remaining queued actions (Infinity if unlimited)
     */
    /**
     * Blank the bar's profit line and cancel any calculation still in flight
     * for it — the header has moved to an action that has no profit to show
     * (the labyrinth, combat, nothing queued), and a calculation that started
     * for the previous one must not land on it.
     */
    clearBarProfit() {
        this.activeBarProfitId = null;
        if (this.profitElement) this.profitElement.innerHTML = '';
    }

    /**
     * Blank the "so far this run" line — same occasions as `clearBarProfit()`:
     * the header has moved to an action with nothing to show for it.
     */
    clearRunSoFar() {
        if (this.runElement) this.runElement.innerHTML = '';
    }

    /**
     * "So far this run": actions completed and what the drops are worth at
     * today's prices, for the action currently running.
     *
     * Gathering only — foraging, woodcutting, milking — because that is all
     * `item-flow-recorder.js` watches; every other action type leaves the row
     * blank rather than guess. Synchronous and cheap: the recorder keeps its
     * rows in memory once loaded, so this never blocks a paint the way the
     * profit line's calculators do.
     *
     * `action.currentCount` is the game's own completions count for this
     * queued run — it counts from when the run itself started, not from when
     * the script did, unlike anything this component could track on its own.
     * A nonzero count with nothing recorded means recording began after the
     * run did (a reload, the feature toggled on, storage recovering from a
     * quota) — the row says so rather than print a lying zero. A run that
     * simply has not completed anything yet (count 0) is not that: it is
     * ordinary, and the row stays blank until it has something to show.
     *
     * A run only partly covered — recording started partway through it rather
     * than not at all — is not distinguished from full coverage: `currentCount`
     * says only whether the run had *any* history before recording, not how
     * much. That is an accepted understatement, not a silent zero.
     *
     * @param {Object} action - The running action
     * @param {Object} actionDetails - Its action details
     */
    updateRunSoFar(action, actionDetails) {
        if (!this.runElement) return;
        if (!config.getSetting('actionBar_showProfit')) {
            this.runElement.innerHTML = '';
            return;
        }
        if (!GATHERING_ACTION_TYPES.includes(actionDetails.type)) {
            this.runElement.innerHTML = '';
            return;
        }

        const completed = Number(action.currentCount) || 0;
        if (completed <= 0) {
            this.runElement.innerHTML = '';
            return;
        }

        const run = action.id ?? action.actionHrid;
        const totals = itemFlowRecorder.getCachedRunGathering(run);

        if (!totals?.gained || Object.keys(totals.gained).length === 0) {
            this.runElement.innerHTML =
                '<span style="color:#888;">This run:</span> ' +
                '<span style="color:#888;">started before recording</span>';
            return;
        }

        const value = lootEntryValue(
            { drops: totals.gained },
            (itemHrid, level) => getItemPrices(itemHrid, level)?.ask ?? null
        );
        const color =
            value >= 0
                ? config.getSettingValue('color_profit', '#4ade80')
                : config.getSettingValue('color_loss', '#f87171');
        const sign = value >= 0 ? '+' : '';
        this.runElement.innerHTML =
            `<span style="color:#888;">This run:</span> ${completed.toLocaleString()} actions · ` +
            `<span style="color:${color}; font-weight:600;">${sign}${this.formatLargeNumber(Math.abs(Math.round(value)))}</span>`;
    }

    async updateActionBarProfit(action, remainingActions) {
        if (!this.profitElement) return;
        if (!config.getSetting('actionBar_showProfit')) {
            this.profitElement.innerHTML = '';
            return;
        }

        const calcId = Date.now() + Math.random();
        this.activeBarProfitId = calcId;

        try {
            const actionHrid = action.actionHrid;
            const actionDetails = dataManager.getActionDetails(actionHrid);
            if (!actionDetails) {
                this.profitElement.innerHTML = '';
                return;
            }

            let profitData = null;

            if (actionDetails.type === '/action_types/alchemy' && action.primaryItemHash) {
                profitData = this.calculateAlchemyProfitForAction(action);
            }

            if (!profitData) {
                const gatheringProfit = await calculateGatheringProfit(actionHrid);
                if (gatheringProfit) {
                    profitData = gatheringProfit;
                } else if (actionDetails.outputItems?.[0]?.itemHrid) {
                    profitData = await profitCalculator.calculateProfit(actionDetails.outputItems[0].itemHrid, {
                        actionHrid,
                    });
                }
            }

            // Display seam: the quoted pace is bounded by how fast the outputs
            // actually trade. A copy — the calculators themselves stay raw for
            // every non-display consumer.
            profitData = await capProfitData(profitData);

            if (this.activeBarProfitId !== calcId) return;

            if (!profitData || typeof profitData.profitPerHour !== 'number') {
                this.profitElement.innerHTML = '';
                return;
            }

            const profitPerHour = profitData.profitPerHour;
            const profitColor =
                profitPerHour >= 0
                    ? config.getSettingValue('color_profit', '#4ade80')
                    : config.getSettingValue('color_loss', '#f87171');
            const sign = profitPerHour >= 0 ? '+' : '';

            let html = `<span style="color:#888;">Profit:</span> <span style="color:${profitColor}; font-weight:600;">${sign}${this.formatLargeNumber(Math.abs(Math.round(profitPerHour)))}/hr</span>`;

            // A capped figure is never shown silently
            if (profitData.liquidityLimit) {
                html += liquidityMarkerHtml(profitData.liquidityLimit, { compact: true });
            }

            // The forecast's track record against finished runs, from the cached ledger
            html += badgeHtml(calibrationBadgeFor(actionDetails.type, { actionHrid }));

            if (isFinite(remainingActions) && remainingActions > 0 && profitData.actionsPerHour > 0) {
                const profitPerAction =
                    profitPerHour / (profitData.actionsPerHour * (profitData.efficiencyMultiplier || 1));
                const remainingProfit = profitPerAction * remainingActions;
                const remColor =
                    remainingProfit >= 0
                        ? config.getSettingValue('color_profit', '#4ade80')
                        : config.getSettingValue('color_loss', '#f87171');
                const remSign = remainingProfit >= 0 ? '+' : '';
                html += ` <span style="color:#888;">·</span> <span style="color:#888;">remaining</span> <span style="color:${remColor}; font-weight:600;">${remSign}${this.formatLargeNumber(Math.abs(Math.round(remainingProfit)))}</span>`;
            }

            if (this.activeBarProfitId !== calcId) return;
            this.profitElement.innerHTML = html;
        } catch {
            if (this.activeBarProfitId === calcId) {
                this.profitElement.innerHTML = '';
            }
        }
    }

    /**
     * Disable the action time display (cleanup)
     */
    disable() {
        try {
            this.cleanupRegistry.cleanupAll();
            this.displayElement = null;
            this.profitElement = null;
            this.runElement = null;
            this.updateTimer = null;
            this.unregisterQueueObserver = null;
            this.actionNameObserver = null;
            this.queueMenuObserver = null;
            this.characterInitHandler = null;
            this.waitForPanelTimeout = null;
            this.activeProfitCalculationId = null;
            this.activeBarProfitId = null;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Action Time Display] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const actionTimeDisplay = new ActionTimeDisplay();

export default actionTimeDisplay;
