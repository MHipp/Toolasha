/**
 * Crafting Plan Feature
 * Shows the cheapest way to obtain a crafted item by comparing
 * buy vs craft at each material tier, and — when the guided walk is on —
 * steps through that plan one confirmation at a time — for one action panel's
 * plan, or for several task-board tasks whose chains overlap, merged into one.
 */

import craftingPlanDisplay from './crafting-plan-display.js';
import craftingPlanWalk from './crafting-plan-walk.js';
import taskCraftingTrain from './task-crafting-train.js';

export default {
    name: 'Crafting Plan',
    initialize: () => {
        craftingPlanDisplay.initialize();
        // Gated on its own setting inside; the display's button is too
        craftingPlanWalk.initialize();
        // Lives here rather than in the tasks bundle because it is the crafting
        // plan and the crafting walk, merely driven from the task board.
        taskCraftingTrain.initialize();
    },
    disable: () => {
        craftingPlanDisplay.disable();
        craftingPlanWalk.disable();
        taskCraftingTrain.disable();
    },
    /** The walk itself, for tests and for anything that wants to drive it */
    walk: craftingPlanWalk,
};
