/**
 * Equipment Mismatch Warning
 *
 * A pulsing pill in the game header for the two ways the equipped kit can
 * contradict the action that is actually running: production gear worn into a
 * fight, and — the expensive direction — a production action running while the
 * piece that would have sped it up sits unequipped in the bag. The second is
 * the one that costs real hours, because nothing in the game says anything: the
 * action simply runs slower than it should for as long as you leave it.
 *
 * Which piece belongs to which action is a table, but the table is not trusted
 * on its own. Every rule is re-checked against the game's own item data before
 * it can fire — the item hrid has to exist and its `equipmentDetail` has to
 * carry one of the bonuses the rule claims for it. A rule the data does not
 * confirm is skipped rather than guessed at, so a renamed item or a moved stat
 * makes the pill go quiet instead of making it lie.
 *
 * Suppressed for the whole of a labyrinth run: the run equips a loadout per
 * room and restores it on exit, so every reading taken inside one is of gear
 * the player did not choose and cannot act on.
 *
 * Adapted from MWITools checkEquipment, CC-BY-NC-SA-4.0, see third-party/mwitools/
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { labyrinthRunState } from '../notifications/notification-predicates.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { runningAction } from '../../utils/combat-actions.js';

const PILL_ID = 'toolasha-equipment-mismatch';
const STYLE_ID = 'toolasha-equipment-mismatch-style';
const HOST_CLASS = 'toolasha-equipment-mismatch-host';
const HOST_SELECTOR = 'div[class*="Header_actionInfo"]';
const ANCHOR_SELECTOR = 'div[class*="Header_communityBuffs"]';

const COMBAT_PREFIX = '/actions/combat/';

// A burst of item deltas (a craft banking its output, a loadout swap) arrives as
// several `items_updated` in the same frame; one repaint is enough for all of
// them.
const DEBOUNCE_MS = 250;

/**
 * The production pieces worth warning about, and what each one is for.
 *
 * `stats` is the claim being made about the piece — the check below requires the
 * game data to carry at least one of them with a positive value before the rule
 * is allowed to fire. Note that the gloves' enhancing bonus is a *speed* stat,
 * not an efficiency one; the data says so and the table follows the data.
 */
const GEAR_RULES = [
    {
        code: 'production-hat',
        itemHrid: '/items/red_culinary_hat',
        fallbackName: 'Red Culinary Hat',
        stats: ['cookingEfficiency', 'brewingEfficiency'],
        actionPrefixes: ['/actions/cooking/', '/actions/brewing/'],
    },
    {
        code: 'production-off-hand',
        itemHrid: '/items/eye_watch',
        fallbackName: 'Eye Watch',
        stats: ['cheesesmithingEfficiency', 'craftingEfficiency', 'tailoringEfficiency'],
        actionPrefixes: ['/actions/cheesesmithing/', '/actions/crafting/', '/actions/tailoring/'],
    },
    {
        code: 'production-boots',
        itemHrid: '/items/collectors_boots',
        fallbackName: "Collector's Boots",
        stats: ['milkingEfficiency', 'foragingEfficiency', 'woodcuttingEfficiency'],
        actionPrefixes: ['/actions/milking/', '/actions/foraging/', '/actions/woodcutting/'],
    },
    {
        code: 'enhancing-gloves',
        itemHrid: '/items/enchanted_gloves',
        fallbackName: 'Enchanted Gloves',
        stats: ['enhancingSpeed'],
        actionPrefixes: ['/actions/enhancing'],
    },
];

const PILL_STYLES = `
.${HOST_CLASS} { position: relative !important; }
@keyframes toolasha-equipment-mismatch-pulse {
    0%, 100% { box-shadow: 0 0 0 2px rgba(255, 75, 75, 0.38), 0 2px 10px rgba(0, 0, 0, 0.42); }
    50% { box-shadow: 0 0 0 4px rgba(255, 75, 75, 0.16), 0 2px 12px rgba(0, 0, 0, 0.5); }
}
#${PILL_ID} {
    position: absolute;
    z-index: 7;
    display: flex;
    box-sizing: border-box;
    min-width: 28px;
    max-width: var(--toolasha-equipment-mismatch-space, 216px);
    height: 22px;
    align-items: center;
    gap: 5px;
    padding: 1px 7px;
    border: 2px solid #ff5b5b;
    border-radius: 999px;
    background: rgba(91, 14, 22, 0.96);
    color: #fff4f4;
    box-shadow: 0 0 0 2px rgba(255, 75, 75, 0.38), 0 2px 10px rgba(0, 0, 0, 0.42);
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
    font: inherit;
    font-size: 0.6875rem;
    font-weight: 750;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    pointer-events: none;
    animation: toolasha-equipment-mismatch-pulse 1.8s ease-in-out infinite;
}
#${PILL_ID} .toolasha-equipment-mismatch-icon { flex: 0 0 auto; color: #ffb7b7; }
#${PILL_ID} .toolasha-equipment-mismatch-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) { #${PILL_ID} { animation: none; } }
@media (max-width: 680px) {
    #${PILL_ID} { width: 28px; max-width: 28px; justify-content: center; padding: 2px; }
    #${PILL_ID} .toolasha-equipment-mismatch-text { display: none; }
}
`;

/**
 * Whether the game's own item data backs the claim a rule makes.
 *
 * Fails closed: an unknown hrid, a piece with no `equipmentDetail`, or one whose
 * non-combat stats carry none of the rule's bonuses disqualifies the rule
 * entirely rather than letting it warn about a piece that no longer helps.
 *
 * @param {Object} rule - An entry of GEAR_RULES
 * @returns {boolean} True when the data confirms at least one claimed bonus
 */
export function isRuleConfirmedByGameData(rule) {
    const stats = dataManager.getItemDetails(rule.itemHrid)?.equipmentDetail?.noncombatStats;
    if (!stats || typeof stats !== 'object') return false;
    return rule.stats.some((stat) => Number(stats[stat]) > 0);
}

/**
 * The display name the game gives a piece, falling back to the table's own.
 * @param {Object} rule - An entry of GEAR_RULES
 * @returns {string}
 */
function pieceName(rule) {
    return dataManager.getItemDetails(rule.itemHrid)?.name || rule.fallbackName;
}

/**
 * Whether a piece is in a worn slot right now.
 *
 * Read across the whole equipment map rather than against a hardcoded slot: the
 * slot an item goes in is the game's business, and asking "is it anywhere on the
 * character" needs no assumption about which location hrid that is.
 *
 * @param {Map} equipment - dataManager.getEquipment()
 * @param {string} itemHrid
 * @returns {boolean}
 */
function isEquipped(equipment, itemHrid) {
    for (const item of equipment.values()) {
        if (item?.itemHrid === itemHrid) return true;
    }
    return false;
}

/**
 * Whether a piece is sitting in the bag.
 * @param {Array|null} inventory - dataManager.getInventory()
 * @param {string} itemHrid
 * @returns {boolean}
 */
function isInInventory(inventory, itemHrid) {
    if (!Array.isArray(inventory)) return false;
    return inventory.some(
        (item) =>
            item?.itemHrid === itemHrid &&
            item.itemLocationHrid === '/item_locations/inventory' &&
            (item.count || 0) > 0
    );
}

class EquipmentMismatchWarning {
    constructor() {
        this.initialized = false;
        this.registry = createCleanupRegistry();
        this.unregisterObserver = null;
        this.pendingTimer = null;
        this._handlers = {};
    }

    initialize() {
        if (this.initialized) return;
        if (!config.getSetting('equipmentMismatchWarning')) return;

        this._handlers = {
            actions_updated: () => this.schedule(),
            items_updated: () => this.schedule(),
            character_switched: () => this.schedule(),
            character_switching: () => this.remove(),
        };
        for (const [event, handler] of Object.entries(this._handlers)) {
            dataManager.on(event, handler);
        }

        this.unregisterObserver = domObserver.onClass('EquipmentMismatchWarning', 'Header_actionInfo', () =>
            this.schedule()
        );

        this.initialized = true;
        this.schedule();
    }

    /**
     * Repaint after the burst settles, for the character that asked.
     *
     * The character id is captured at scheduling time and checked again when the
     * timer fires: a switch inside the debounce window would otherwise paint the
     * departing character's gear against the arriving character's header.
     */
    schedule() {
        if (!this.initialized) return;
        const characterId = dataManager.getCurrentCharacterId();
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            if (dataManager.getCurrentCharacterId() !== characterId) return;
            this.render();
        }, DEBOUNCE_MS);
        this.registry.registerTimeout(this.pendingTimer);
    }

    /**
     * What the pill should say right now, or null for nothing to say.
     * @returns {{code: string, text: string}|null}
     */
    evaluate() {
        if (dataManager.getIsCharacterSwitching()) return null;
        if (labyrinthRunState(dataManager.characterData?.characterLabyrinth) === 'active') return null;

        // Execution order, never array position: a requeued repeat sits first in
        // the queue with a higher ordinal, so the front of the array is routinely
        // an action that has not started.
        const action = runningAction(dataManager.getCurrentActions() || []);
        const actionHrid = String(action?.actionHrid || '');
        if (!actionHrid) return null;

        const rules = GEAR_RULES.filter(isRuleConfirmedByGameData);
        if (rules.length === 0) return null;

        const equipment = dataManager.getEquipment() || new Map();

        if (actionHrid.startsWith(COMBAT_PREFIX)) {
            const worn = rules.filter((rule) => isEquipped(equipment, rule.itemHrid));
            if (worn.length === 0) return null;
            return {
                code: 'skilling-gear-in-combat',
                text: `Skilling gear in combat: ${worn.map(pieceName).join(', ')}`,
            };
        }

        const rule = rules.find((candidate) => candidate.actionPrefixes.some((p) => actionHrid.startsWith(p)));
        if (!rule) return null;
        if (isEquipped(equipment, rule.itemHrid)) return null;
        if (!isInInventory(dataManager.getInventory(), rule.itemHrid)) return null;

        return { code: rule.code, text: `${pieceName(rule)} not equipped` };
    }

    /** Draw, update or take down the pill for the current state. */
    render() {
        const warning = this.evaluate();
        const host = document.querySelector(HOST_SELECTOR);
        const anchor = host?.querySelector(ANCHOR_SELECTOR);
        if (!warning || !host || !anchor) {
            this.remove();
            return;
        }

        addStyles(PILL_STYLES, STYLE_ID);
        for (const stale of document.querySelectorAll(`.${HOST_CLASS}`)) {
            if (stale !== host) stale.classList.remove(HOST_CLASS);
        }
        host.classList.add(HOST_CLASS);

        let pill = document.getElementById(PILL_ID);
        if (!pill || !pill.isConnected) {
            pill = document.createElement('div');
            pill.id = PILL_ID;
            pill.setAttribute('role', 'status');
            const icon = document.createElement('span');
            icon.className = 'toolasha-equipment-mismatch-icon';
            icon.textContent = '⚠';
            const text = document.createElement('span');
            text.className = 'toolasha-equipment-mismatch-text';
            pill.append(icon, text);
        }
        if (pill.parentElement !== host) host.appendChild(pill);

        pill.dataset.code = warning.code;
        pill.querySelector('.toolasha-equipment-mismatch-text').textContent = warning.text;
        pill.title = warning.text;
        this.position(pill, host, anchor);
    }

    /**
     * Sit the pill just under the community-buff row, clamped to the header.
     * @param {HTMLElement} pill
     * @param {HTMLElement} host
     * @param {HTMLElement} anchor
     */
    position(pill, host, anchor) {
        const hostRect = host.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const left = Math.max(0, anchorRect.left - hostRect.left);
        const top = Math.max(0, anchorRect.bottom - hostRect.top + 4);
        const viewportWidth = host.ownerDocument?.defaultView?.innerWidth || 0;
        const available = viewportWidth ? Math.max(26, viewportWidth - hostRect.left - left - 12) : anchorRect.width;
        pill.style.left = `${left}px`;
        pill.style.top = `${top}px`;
        pill.style.setProperty(
            '--toolasha-equipment-mismatch-space',
            `${Math.min(216, anchorRect.width || 216, available)}px`
        );
    }

    /** Take the pill down and release the host's positioning class. */
    remove() {
        document.getElementById(PILL_ID)?.remove();
        for (const host of document.querySelectorAll(`.${HOST_CLASS}`)) {
            host.classList.remove(HOST_CLASS);
        }
    }

    disable() {
        // Timers first and unconditionally: a later step throwing must not leave
        // a debounce pending that repaints after the feature is marked off.
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        try {
            for (const [event, handler] of Object.entries(this._handlers)) {
                dataManager.off(event, handler);
            }
            this._handlers = {};
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            this.registry.cleanupAll();
            this.remove();
            removeStyles(STYLE_ID);
        } catch (error) {
            console.error('[Equipment Mismatch Warning] Disable failed part-way:', error);
        } finally {
            this.initialized = false;
        }
    }
}

const equipmentMismatchWarning = new EquipmentMismatchWarning();

export default equipmentMismatchWarning;
