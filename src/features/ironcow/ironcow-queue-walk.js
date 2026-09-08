/**
 * The three steps that fill an Iron Bell queue, walked.
 *
 * The panel can say "queue 1,600 forages, 1,600 decomposes and 480 coinifies"
 * all it likes; typing that in is still three trips through the game's own
 * screens with three numbers to remember. This turns the sizing into a walk:
 * forage, then decompose, then coinify, in the order the loop consumes them.
 *
 * **One user click is one game action, always.** Nothing here presses a game
 * button or queues anything. Each step opens the action and types the count into
 * the game's own count box; the press that queues it is the player's, and the
 * walk only moves on once the server has answered that press. That invariant
 * belongs to `crafting-plan-walk.js`, which is the walker this drives — there is
 * one guided walk in this script, not two, and a second copy of it would be a
 * second place for that rule to be got wrong.
 *
 * ## Alchemy is chosen by item, and that is the whole difficulty
 *
 * `navigateToAction` reaches the alchemy screen — `/actions/alchemy/decompose`
 * and `/actions/alchemy/coinify` are real actions and `handleGoToAction` opens
 * them. What it cannot do is put the Star Fruit in the slot: alchemy is one
 * action for every item in the game and the item is chosen in a slot the game
 * exposes no handler for, only a sprite to read back. Selecting it for the
 * player would mean the script clicking the game's own controls, which is
 * exactly what this project does not do.
 *
 * So the two alchemy steps carry `requiresItemHrid`, and the walker waits: it
 * navigates, it says which item to select, and it types nothing until the panel
 * itself reports that item in the slot. A count typed against the wrong item
 * would be a count the player did not ask for, one press away from queueing it.
 */

import { formatWithSeparator } from '../../utils/formatters.js';
import craftingPlanWalk from '../crafting-plan/crafting-plan-walk.js';

/** The alchemy actions the loop uses. One action apiece, item chosen separately. */
export const DECOMPOSE_ACTION = '/actions/alchemy/decompose';
export const COINIFY_ACTION = '/actions/alchemy/coinify';

/** What the strip says to do about a slot the script is not allowed to fill */
const SELECT_NOTE = 'put it in the alchemy slot';

/**
 * The three steps of one balanced batch, in the order the loop consumes them.
 *
 * Forage first because the decompose leg eats what it grew, decompose before
 * coinify for the same reason. A leg the balance sized at nothing is not a step:
 * there is nothing to type into it.
 *
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @param {Object|null} batch - From `balanceBatch`
 * @returns {Array<Object>} Steps for `craftingPlanWalk.start`, or an empty list
 */
export function buildQueueSteps(loop, batch) {
    if (!loop || loop.missing?.length || !batch) return [];
    const items = loop.items;
    if (!items?.forageActionHrid || !items.starfruitHrid || !items.essenceHrid) return [];

    const fruitName = items.starfruitName || 'Star Fruit';
    const essenceName = items.essenceName || 'essence';
    const steps = [];

    if (batch.forageActions > 0) {
        steps.push({
            key: 'ironbell:forage',
            kind: 'craft',
            itemHrid: items.starfruitHrid,
            itemName: fruitName,
            actionHrid: items.forageActionHrid,
            count: batch.forageActions,
            actions: batch.forageActions,
            label: `forage ${formatWithSeparator(batch.forageActions)} × ${fruitName}`,
        });
    }

    if (batch.decomposeActions > 0) {
        steps.push({
            key: 'ironbell:decompose',
            kind: 'craft',
            itemHrid: items.starfruitHrid,
            itemName: fruitName,
            actionHrid: DECOMPOSE_ACTION,
            requiresItemHrid: items.starfruitHrid,
            count: batch.decomposeActions,
            actions: batch.decomposeActions,
            label: `decompose ${formatWithSeparator(batch.decomposeActions)} × ${fruitName} — ${SELECT_NOTE}`,
        });
    }

    if (batch.coinifyActions > 0) {
        steps.push({
            key: 'ironbell:coinify',
            kind: 'craft',
            itemHrid: items.essenceHrid,
            itemName: essenceName,
            actionHrid: COINIFY_ACTION,
            requiresItemHrid: items.essenceHrid,
            count: batch.coinifyActions,
            actions: batch.coinifyActions,
            label: `coinify ${formatWithSeparator(batch.coinifyActions)} × ${essenceName} — ${SELECT_NOTE}`,
        });
    }

    return steps;
}

/**
 * Walk one balanced batch.
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @param {Object|null} batch - From `balanceBatch`
 * @returns {boolean} Whether a walk started
 */
export function startQueueWalk(loop, batch) {
    const steps = buildQueueSteps(loop, batch);
    if (!steps.length) return false;
    return craftingPlanWalk.start(steps);
}

export default { buildQueueSteps, startQueueWalk, DECOMPOSE_ACTION, COINIFY_ACTION };
