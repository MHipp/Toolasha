/**
 * Init ownership tickets.
 *
 * A feature's `initialize()` that awaits — a storage read is the normal shape —
 * and then registers listeners, observers, styles or DOM is registering against
 * whatever layer is current when the await *resolves*, not the one that was
 * current when it started. A character switch tears every feature down
 * (`disableAllFeatures()`) while those awaits are in flight, and since
 * `concurrent: true` began working there can be around fifteen of them in flight
 * at once, for as long as the slowest storage read in the batch. Registering
 * after that teardown leaves a live handler on a dead layer, and — where the
 * `isInitialized` flag is set after the await too — leaves the flag set over a
 * teardown that cleared it, so the switch's re-initialise early-returns and the
 * feature is dead until the page is reloaded.
 *
 * The test has to be two-part, which is why this is a shared facility rather
 * than a `getIsCharacterSwitching()` call at each site:
 *
 * - The character id alone is not enough. A reconnect re-initialises the *same*
 *   character, and `getIsCharacterSwitching()` is already false by the time a
 *   slow read resolves after the switch has settled.
 * - The generation alone is not enough either. `getCurrentCharacterId()` moves
 *   the moment the switch settles, which is before `disable()` has had its turn,
 *   so a read resolving in that window would pass a generation-only test while
 *   already belonging to somebody else.
 *
 * This is the shape `treasure-tracker.js` proved with its own `_owner()` /
 * `_stillOurs()` pair; the counter lives in a WeakMap here so a module adopts it
 * in three lines and holds no field of its own.
 *
 * Adoption at a site:
 *
 * ```js
 * async initialize() {
 *     const ticket = captureOwner(this);
 *     await this.loadData();
 *     if (!stillOurs(ticket)) return; // nothing registered, no flag left set
 *     …register…
 *     this.isInitialized = true;
 * }
 *
 * disable() {
 *     noteTeardown(this);
 *     …
 * }
 * ```
 */

import dataManager from '../core/data-manager.js';

/**
 * Where an owner's teardown generation is kept — on the owner itself.
 *
 * A registry symbol rather than a module-level WeakMap so this file holds no
 * mutable state of its own: the production build inlines a shared util into
 * every bundle that imports it, and a per-module map would give the four
 * bundles four private counters. `Symbol.for` resolves to the same symbol in
 * every copy, so whichever copy tears an owner down is the one every copy
 * reads.
 */
const GENERATION = Symbol.for('toolasha.initTeardownGeneration');

/**
 * @param {Object} owner - The module instance
 * @returns {number} Its current teardown generation
 */
function generationOf(owner) {
    return owner?.[GENERATION] ?? 0;
}

/**
 * @returns {string|null} The character in hand, or null when there is none
 */
function currentCharacter() {
    return dataManager.getCurrentCharacterId?.() ?? null;
}

/**
 * Take a ticket for work an `initialize()` is about to suspend on.
 *
 * Call before the first `await`, and pass the ticket to {@link stillOurs} after
 * every await that could span a teardown.
 * @param {Object} owner - The module instance whose teardown counts
 * @returns {{owner: Object, generation: number, charId: string|null}} The ticket
 */
export function captureOwner(owner) {
    return { owner, generation: generationOf(owner), charId: currentCharacter() };
}

/**
 * Whether the work a ticket was taken for may still register anything.
 *
 * False once the owner has been torn down, or once the character it was taken
 * under is no longer the one in hand.
 * @param {{owner: Object, generation: number, charId: string|null}} ticket - From {@link captureOwner}
 * @returns {boolean} True when the ticket is still current
 */
export function stillOurs(ticket) {
    if (!ticket) return false;
    return generationOf(ticket.owner) === ticket.generation && currentCharacter() === ticket.charId;
}

/**
 * Record that an owner has been torn down, invalidating every ticket it issued.
 *
 * Call it first thing in `disable()` — before the cleanup itself, so a teardown
 * that throws part-way has still invalidated the tickets.
 * @param {Object} owner - The module instance being torn down
 * @returns {void}
 */
export function noteTeardown(owner) {
    if (!owner) return;
    owner[GENERATION] = generationOf(owner) + 1;
}
