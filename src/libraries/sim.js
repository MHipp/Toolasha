/**
 * Combat Simulator Library
 *
 * The battle engine, on its own.
 *
 * It is by a wide margin the largest thing in the script — about a megabyte of
 * source, roughly half of what the combat bundle used to be — and four features
 * across three bundles reach into it: the labyrinth clear-rate model, task
 * profit, the build score, and the simulator's own interface.
 *
 * Bundled with each of them it was **copied into each of them**, which is how
 * the combat and UI bundles both ended up within a few kilobytes of the 2 MB
 * ceiling while carrying the same `Monster` class twice over. Here it is loaded
 * once and referenced.
 *
 * Exports to: window.Toolasha.Sim
 */

import combatSim from '../features/combat-sim/combat-sim.js';
import labSim from '../features/combat-sim/lab-sim.js';
import combatSimUI from '../features/combat-sim/combat-sim-ui.js';
import * as combatSimAdapter from '../features/combat-sim/combat-sim-adapter.js';
import * as abilityTimingCalculator from '../features/combat-sim/ability-timing-calculator.js';
import * as combatSimRunner from '../features/combat-sim/combat-sim-runner.js';
import * as wilson from '../features/combat-sim/engine/wilson.js';
import * as gameData from '../features/combat-sim/engine/game-data.js';
import Monster from '../features/combat-sim/engine/monster.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Sim = {
    combatSim,
    labSim,
    combatSimUI,
    combatSimAdapter,
    // The ability tooltip's effective cooldown/cast time. Its home is here because
    // it reconstructs a Player; the combat bundle reads it through this global.
    abilityTimingCalculator,
    combatSimRunner,
    wilson,
    gameData,
    // The class itself, not a namespace around it. A default import compiles to
    // the global value directly — `import Monster from …` becomes
    // `Toolasha.Sim.monster` — so wrapping it hands a `{default}` object to
    // every `new Monster(...)` in the script.
    monster: Monster,
};

console.log('[Toolasha] Sim library loaded');
