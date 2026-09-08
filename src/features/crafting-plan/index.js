/**
 * Crafting Plan Feature
 * Shows the cheapest way to obtain a crafted item by comparing
 * buy vs craft at each material tier, and — when the guided walk is on —
 * steps through that plan one confirmation at a time.
 *
 * The merged task-board walk (`task-crafting-train.js`) ships in this bundle
 * because it is this plan and this walk, but it is its own registry feature so
 * that either can be turned off without the other.
 */

import craftingPlanDisplay from './crafting-plan-display.js';
import craftingPlanWalk from './crafting-plan-walk.js';

export default {
    name: 'Crafting Plan',
    initialize: () => {
        craftingPlanDisplay.initialize();
        // Gated on its own setting inside; the display's button is too
        craftingPlanWalk.initialize();
    },
    disable: () => {
        craftingPlanDisplay.disable();
        craftingPlanWalk.disable();
    },
    /** The walk itself, for tests and for anything that wants to drive it */
    walk: craftingPlanWalk,
};
