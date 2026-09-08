/**
 * Where the Iron Bell Farming panel's own state lives.
 *
 * Two things, both per character: the manual ticks for the one plan stage
 * nothing can measure, and the last costed loop so the panel has a figure to
 * draw the instant it opens. Neither is ever read back as fact — the ticks can
 * only add to what the character's state already derived, and the snapshot is
 * replaced the moment a refresh finishes.
 *
 * Every key goes through {@link characterKey}'s helpers. An iron cow's plan is
 * not the main's plan, and a bare key would show each of them the other's.
 */

import dataManager from '../../core/data-manager.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

// The panel's display name changed to "Iron Bell Farming", but these two keys
// are kept exactly as they were (ironCowFarmOverrides / ironCowFarmSnapshot) —
// renaming them would orphan the stage ticks and the last costed loop that
// existing users already have stored under them.

/** Unscoped key for the manual stage ticks; the real key carries the character id */
export const OVERRIDES_KEY = 'ironCowFarmOverrides';

/** Unscoped key for the last costed loop */
export const SNAPSHOT_KEY = 'ironCowFarmSnapshot';

/** Unscoped key for whether the plan section is shut */
export const PLAN_COLLAPSED_KEY = 'ironCowFarmPlanCollapsed';

/**
 * This character's manual stage ticks.
 * @returns {Promise<Object>} Stage id → true
 */
export async function loadOverrides() {
    try {
        // 'discard': there is no legacy global to inherit, and a tick made by
        // another character says nothing about this one's levels.
        const stored = await readScoped(OVERRIDES_KEY, 'settings', {}, { migrate: 'discard' });
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
        const clean = {};
        for (const [id, value] of Object.entries(stored)) {
            if (value === true) clean[id] = true;
        }
        return clean;
    } catch (error) {
        console.error('[IronCow] Loading the stage ticks failed:', error);
        return {};
    }
}

/**
 * Turn one stage's manual tick on or off.
 * @param {string} stageId - Which stage
 * @param {boolean} ticked - On or off
 * @returns {Promise<Object>} The new tick map
 */
export async function setOverride(stageId, ticked) {
    // Captured before `loadOverrides()`'s await: `characterKey()` is resolved
    // again, fresh, inside `writeScoped` below, against whatever character is
    // current *then*. A switch landing in the gap — the player ticks a stage
    // just as a switch begins — would otherwise write the departing
    // character's tick map under the arriving character's key, corrupting
    // their stored overrides with a tick they never made.
    const charId = dataManager.getCurrentCharacterId();
    const overrides = await loadOverrides();
    if (ticked) overrides[stageId] = true;
    else delete overrides[stageId];
    if (dataManager.getCurrentCharacterId() !== charId) return overrides;
    try {
        await writeScoped(OVERRIDES_KEY, overrides, 'settings');
    } catch (error) {
        console.error('[IronCow] Saving the stage ticks failed:', error);
    }
    return overrides;
}

/**
 * The last costed loop, for drawing before a refresh finishes.
 * @returns {Promise<Object|null>} The snapshot
 */
export async function loadSnapshot() {
    try {
        const stored = await readScoped(SNAPSHOT_KEY, 'settings', null, { migrate: 'discard' });
        return stored && typeof stored === 'object' ? stored : null;
    } catch (error) {
        console.error('[IronCow] Loading the last loop failed:', error);
        return null;
    }
}

/**
 * Remember the loop just costed.
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @returns {Promise<void>}
 */
export async function saveSnapshot(loop) {
    try {
        await writeScoped(SNAPSHOT_KEY, loop || null);
    } catch (error) {
        console.error('[IronCow] Saving the last loop failed:', error);
    }
}

/**
 * Whether this character has shut the plan section.
 *
 * Anything other than a stored `true` is open: the default has to be today's
 * appearance, so that upgrading to a version that can collapse the section does
 * not silently fold it up on everyone who never asked for that.
 *
 * @returns {Promise<boolean>} True when it is shut
 */
export async function loadPlanCollapsed() {
    try {
        // 'discard': one character having shut their plan says nothing about
        // another's, exactly as for the stage ticks.
        const stored = await readScoped(PLAN_COLLAPSED_KEY, 'settings', false, { migrate: 'discard' });
        return stored === true;
    } catch (error) {
        console.error('[IronCow] Loading the plan section state failed:', error);
        return false;
    }
}

/**
 * Shut the plan section, or open it.
 *
 * Nothing is read first — the new state is the caller's, not a mutation of the
 * stored one — so there is no gap for a character switch to land in: the key is
 * resolved inside `writeScoped`, against whoever is current at the write.
 *
 * @param {boolean} collapsed - True to shut it
 * @returns {Promise<void>}
 */
export async function setPlanCollapsed(collapsed) {
    try {
        await writeScoped(PLAN_COLLAPSED_KEY, collapsed === true, 'settings');
    } catch (error) {
        console.error('[IronCow] Saving the plan section state failed:', error);
    }
}

export default {
    OVERRIDES_KEY,
    SNAPSHOT_KEY,
    PLAN_COLLAPSED_KEY,
    loadOverrides,
    setOverride,
    loadSnapshot,
    saveSnapshot,
    loadPlanCollapsed,
    setPlanCollapsed,
};
