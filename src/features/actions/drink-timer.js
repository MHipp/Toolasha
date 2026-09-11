/**
 * Drink Timer
 * Displays remaining drink time per slot inside each non-combat skill panel's
 * consumables section. Warns when any drink falls below the configured threshold
 * and highlights if the queued actions will outlast available drink supply.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import notificationService from '../notifications/notification-service.js';
import { thresholdCrossing } from '../notifications/notification-predicates.js';
import { calculateDrinkRemainingSeconds, calculateQueueTimeSeconds } from '../../utils/drink-calculator.js';
import { runningAction } from '../../utils/combat-actions.js';

const SECONDS_PER_HOUR = 3600;
/** The consumables sections the timer lives in, for the one-time scan at start-up */
const CONTAINER_SELECTOR = [
    '[class*="GatheringProductionSkillPanel_consumablesContainer"]',
    '[class*="AlchemyPanel_consumablesContainer"]',
    '[class*="EnhancingPanel_consumablesContainer"]',
].join(', ');
/** Inventory updates arrive in bursts; one redraw per burst, like the sibling panel features */
const UPDATE_DEBOUNCE_MS = 300;

class DrinkTimer {
    constructor() {
        this.initialized = false;
        this.observers = [];
        /**
         * The consumables containers the DOM observer has handed over and that
         * are still in the document. Inventory updates redraw these rather than
         * re-querying the whole document for them; a container that has since
         * been removed is dropped on the next pass.
         * @type {Set<Element>}
         */
        this.containers = new Set();
        this.updateDebounceTimer = null;
        /**
         * actionTypeHrid -> whether a dip below the threshold would be news.
         *
         * Per action type rather than one flag, because woodcutting and cooking
         * have different drinks and running low on one says nothing about the
         * other. An unseen type is armed, so the first sighting of a low supply
         * is announced.
         */
        this.drinkAlertArmed = new Map();
    }

    initialize() {
        if (this.initialized) return;

        const onContainer = (el) => this._trackPanel(el);
        const unregister = domObserver.onClass(
            'DrinkTimer',
            'GatheringProductionSkillPanel_consumablesContainer',
            onContainer
        );
        this.observers.push(unregister);

        const unregisterAlchemy = domObserver.onClass(
            'DrinkTimer-Alchemy',
            'AlchemyPanel_consumablesContainer',
            onContainer
        );
        this.observers.push(unregisterAlchemy);

        const unregisterEnhancing = domObserver.onClass(
            'DrinkTimer-Enhancing',
            'EnhancingPanel_consumablesContainer',
            onContainer
        );
        this.observers.push(unregisterEnhancing);

        const onUpdate = () => {
            clearTimeout(this.updateDebounceTimer);
            this.updateDebounceTimer = setTimeout(() => {
                this.updateDebounceTimer = null;
                this._updateAllPanels();
                // The panels only cover what is on screen, and the whole point of a
                // notification is that you are not looking at the screen — so the
                // skill actually being performed is checked whether or not its panel
                // happens to be open
                this._checkCurrentActionDrinks();
            }, UPDATE_DEBOUNCE_MS);
        };
        dataManager.on('consumables_updated', onUpdate);
        dataManager.on('items_updated', onUpdate);
        this.observers.push(() => {
            dataManager.off('consumables_updated', onUpdate);
            dataManager.off('items_updated', onUpdate);
            clearTimeout(this.updateDebounceTimer);
            this.updateDebounceTimer = null;
        });

        // A low-supply alert already fired for an action type disarms it (see
        // thresholdCrossing) so the same dip is not announced twice. That bit is
        // keyed only by actionTypeHrid, not by character — switching to a different
        // character (1 main + 3 ironcow in one browser share this tab) carries the
        // previous character's disarmed types over, so an alt whose milking tea is
        // already critically low on its very first observation gets no warning at
        // all, because "milking" was disarmed by the main character earlier in the
        // session. Re-arming on every real switch makes the alt's first reading
        // count as news again, same as a fresh page load would.
        const onCharacterSwitch = (data) => {
            if (data?._isCharacterSwitch) this.drinkAlertArmed.clear();
        };
        dataManager.on('character_initialized', onCharacterSwitch);
        this.observers.push(() => {
            dataManager.off('character_initialized', onCharacterSwitch);
        });

        // Containers already on screen were inserted before the observer was
        // listening, so they are picked up once here; everything after arrives
        // through the observer. @run-at document-start: the scan waits for the
        // shared observer's actual-ready signal (immediate if it is already
        // attached), so a container rendered during the readiness gap is not missed.
        this.observers.push(
            domObserver.onReady('DrinkTimerCatchUp', () => {
                for (const el of document.querySelectorAll(CONTAINER_SELECTOR)) {
                    this._trackPanel(el);
                }
            })
        );
        this.initialized = true;
    }

    /** Remember a consumables container and draw it */
    _trackPanel(consumablesContainer) {
        this.containers.add(consumablesContainer);
        this._updatePanel(consumablesContainer);
    }

    /** Redraw every tracked container that is still in the document */
    _updateAllPanels() {
        for (const el of this.containers) {
            if (!el.isConnected) {
                this.containers.delete(el);
                continue;
            }
            this._updatePanel(el);
        }
    }

    _updatePanel(consumablesContainer) {
        consumablesContainer.querySelector('.mwi-drink-timer')?.remove();

        const slotsEl = consumablesContainer.querySelector(
            '[class*="ActionTypeConsumableSlots_actionTypeConsumableSlots"]'
        );
        if (!slotsEl) return;

        const actionTypeHrid = this._getActionTypeHrid(slotsEl);
        if (!actionTypeHrid || actionTypeHrid === '/action_types/combat') return;

        const drinks = calculateDrinkRemainingSeconds(actionTypeHrid);
        if (!drinks.length) return;

        const thresholdSeconds = config.getSettingValue('drinkTimer_warningThreshold', 24) * SECONDS_PER_HOUR;
        const queueSeconds = calculateQueueTimeSeconds(actionTypeHrid);

        this._checkDrinkThreshold(actionTypeHrid, drinks, thresholdSeconds);

        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-drink-timer';
        wrapper.style.cssText = 'padding: 3px 8px 4px; font-size: 11px; line-height: 1.5;';

        // Per-drink time row
        const drinkParts = drinks.map(({ name, totalSeconds }) => {
            const color =
                totalSeconds < SECONDS_PER_HOUR ? '#ef4444' : totalSeconds < thresholdSeconds ? '#f0a830' : '#9ca3af';
            const prefix = totalSeconds < thresholdSeconds ? '⚠ ' : '';
            return `<span style="color:${color};">${prefix}${name}: ${this._formatTime(totalSeconds)}</span>`;
        });
        const drinkRow = document.createElement('div');
        drinkRow.innerHTML = drinkParts.join('<span style="color:#4b5563;"> · </span>');
        wrapper.appendChild(drinkRow);

        // Queue warning row
        if (queueSeconds > 0) {
            const minDrinkSeconds = Math.min(...drinks.map((d) => d.totalSeconds));
            const shortfall = queueSeconds - minDrinkSeconds;
            if (shortfall > 0) {
                const shortDrink = drinks.find((d) => d.totalSeconds === minDrinkSeconds);
                const queueRow = document.createElement('div');
                queueRow.style.color = '#f0a830';
                queueRow.textContent = `⚠ Queue (${this._formatTime(queueSeconds)}) outlasts ${shortDrink.name} by ${this._formatTime(shortfall)}`;
                wrapper.appendChild(queueRow);
            }
        }

        slotsEl.insertAdjacentElement('afterend', wrapper);
    }

    /**
     * The action type the character is actually working on, if any.
     *
     * The queue is in insertion order, not execution order: a repeating action
     * requeued to the front of the array carries a *higher* ordinal, so
     * `actions[0]` can be a queued action sitting behind the one actually
     * running. `runningAction` picks the lowest-ordinal unfinished entry instead.
     *
     * @returns {string|null} An action type hrid, or null when idle
     */
    _currentActionTypeHrid() {
        const current = runningAction(dataManager.getCurrentActions?.() ?? []);
        if (!current?.actionHrid) return null;
        return dataManager.getActionDetails(current.actionHrid)?.type ?? null;
    }

    /** Evaluate the running skill's drinks, whether or not its panel is open */
    _checkCurrentActionDrinks() {
        if (!config.getSetting('notifications_consumableLow')) return;

        const actionTypeHrid = this._currentActionTypeHrid();
        if (!actionTypeHrid || actionTypeHrid === '/action_types/combat') return;

        const thresholdSeconds = config.getSettingValue('drinkTimer_warningThreshold', 24) * SECONDS_PER_HOUR;
        this._checkDrinkThreshold(actionTypeHrid, calculateDrinkRemainingSeconds(actionTypeHrid), thresholdSeconds);
    }

    /**
     * Announce a drink supply that has just fallen under the warning threshold.
     *
     * The soonest one, because a skill stops when its first drink runs out and
     * not when its average one does. The crossing itself is decided by a pure
     * predicate; all this does is hold the per-skill bit that predicate needs
     * and turn its answer into a sentence.
     *
     * @param {string} actionTypeHrid - Which skill's drinks these are
     * @param {Array<{name: string, totalSeconds: number}>} drinks - Remaining time per drink
     * @param {number} thresholdSeconds - Where the warning starts
     */
    _checkDrinkThreshold(actionTypeHrid, drinks, thresholdSeconds) {
        if (!config.getSetting('notifications_consumableLow')) return;
        if (!drinks?.length) return;

        const soonest = drinks.reduce((min, drink) => (drink.totalSeconds < min.totalSeconds ? drink : min));
        const armed = this.drinkAlertArmed.get(actionTypeHrid) ?? true;
        const next = thresholdCrossing({ armed, secondsLeft: soonest.totalSeconds, thresholdSeconds });

        this.drinkAlertArmed.set(actionTypeHrid, next.armed);
        if (!next.fire) return;

        const skill = actionTypeHrid.split('/').pop().replace(/_/g, ' ');
        notificationService.notify(
            `consumable-low:${actionTypeHrid}`,
            `${soonest.name} runs out in ${this._formatTime(soonest.totalSeconds)} (${skill})`
        );
    }

    /**
     * Get actionTypeHrid from the ActionTypeConsumableSlots element via fiber.
     * The prop lives one level up in the return fiber.
     */
    _getActionTypeHrid(slotsEl) {
        const root = document.getElementById('root');
        const rootFiber = root?._reactRootContainer?.current || root?._reactRootContainer?._internalRoot?.current;
        if (!rootFiber) return null;

        function walk(f, target) {
            if (!f) return null;
            if (f.stateNode === target) return f;
            return walk(f.child, target) || walk(f.sibling, target);
        }

        const fiber = walk(rootFiber, slotsEl);
        return fiber?.return?.memoizedProps?.actionTypeHrid ?? null;
    }

    _formatTime(seconds) {
        if (seconds <= 0) return '0m';
        const h = Math.floor(seconds / SECONDS_PER_HOUR);
        const m = Math.floor((seconds % SECONDS_PER_HOUR) / 60);
        if (h >= 48) return `${Math.round(seconds / 86400)}d`;
        if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
        return `${m}m`;
    }

    cleanup() {
        this.observers.forEach((fn) => fn());
        this.observers = [];
        clearTimeout(this.updateDebounceTimer);
        this.updateDebounceTimer = null;
        this.containers.clear();
        document.querySelectorAll('.mwi-drink-timer').forEach((el) => el.remove());
        this.drinkAlertArmed.clear();
        this.initialized = false;
    }
}

const drinkTimer = new DrinkTimer();

export default {
    name: 'Drink Timer',
    initialize: () => drinkTimer.initialize(),
    cleanup: () => {
        try {
            return drinkTimer.cleanup();
        } catch (error) {
            console.error('[Drink Timer] Disable failed part-way:', error);
        } finally {
            drinkTimer.initialized = false;
        }
    },
};
