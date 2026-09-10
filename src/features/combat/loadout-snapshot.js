/**
 * Loadout Snapshot
 *
 * Listens for `loadouts_updated` WebSocket messages to capture all loadout configurations
 * (equipment, abilities, consumables, enhancement levels) in real time.
 *
 * Stored snapshots are used by profit calculators to apply the correct tool/equipment
 * bonuses for a skill even when that loadout is not currently equipped.
 *
 * Skill matching: the loadout's actionTypeHrid (e.g. "/action_types/brewing") is compared
 * to the action type of the profit calculation. An "All Skills" loadout (empty actionTypeHrid)
 * is used as a fallback when no skill-specific snapshot is found.
 *
 * Priority: skill default > all skills default > skill non-default > all skills non-default
 */

import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { webSocketHook as sharedWebSocketHook } from '../../utils/bundle-bridge.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORAGE_KEY_PREFIX = 'loadout_snapshots';

/**
 * How long a caller waiting on the store will wait before giving up on it.
 *
 * The store only loads if the Loadout Snapshots feature is switched on; with it
 * off, nothing ever marks it ready. A wait that could never end would leave
 * every consumer gated on it permanently, so the deadline marks the store ready
 * anyway and the callers fall back to the pre-flag behaviour (whatever
 * `snapshots` holds, empty or not).
 */
const SNAPSHOT_READY_TIMEOUT_MS = 5000;

/**
 * Returns the active WebSocket hook instance.
 * In the multi-bundle production build each library bundles its own copy of websocket.js,
 * but only the Core library's instance has install() called on it.
 * Prefer window.Toolasha.Core.webSocketHook so listeners actually receive messages.
 * Falls back to the bundled copy for the dev standalone build (single bundle, one instance).
 */
function getWebSocketHook() {
    return sharedWebSocketHook() || webSocketHook;
}

/**
 * Get character-scoped storage key.
 * @returns {string}
 */
function getStorageKey() {
    const charId = dataManager.getCurrentCharacterId() || 'default';
    return `${STORAGE_KEY_PREFIX}_${charId}`;
}

/**
 * Parse a wearable hash string into itemLocationHrid, itemHrid, and enhancementLevel.
 * Format: "characterId::/item_locations/location::/items/item_hrid::enhancementLevel"
 * Empty string means no item in that slot.
 * @param {string} itemLocationHrid - The equipment slot key (e.g. "/item_locations/body")
 * @param {string} wearableHash - The wearable hash value
 * @returns {{ itemLocationHrid: string, itemHrid: string, enhancementLevel: number }|null}
 */
function parseWearable(itemLocationHrid, wearableHash) {
    if (!wearableHash) return null;

    const parts = wearableHash.split('::');
    const itemHrid = parts.find((p) => p.startsWith('/items/'));
    if (!itemHrid) return null;

    const lastPart = parts[parts.length - 1];
    const enhancementLevel = !lastPart.startsWith('/') ? parseInt(lastPart, 10) || 0 : 0;

    return { itemLocationHrid, itemHrid, enhancementLevel };
}

/**
 * The best enhancement level owned of every item, from the inventory.
 *
 * Equipped pieces are in `characterItems` alongside the loose ones, so this
 * covers what is worn as well as what is in the bag — which is what "highest
 * owned" means to the game.
 *
 * @param {Array<Object>} [items] - Defaults to the live inventory
 * @returns {Map<string, number>} Item hrid → highest enhancement level owned
 */
export function highestOwnedEnhancements(items) {
    const inventory = items || dataManager.characterItems || dataManager.characterData?.characterItems || [];
    const highest = new Map();
    for (const item of inventory) {
        // Equipped items don't reliably carry a count field the way stacked inventory
        // items do — requiring count > 0 dropped them, letting a lower-enhancement
        // duplicate in the bag outrank the actually-equipped higher copy. Skip only an
        // explicit zero (a stack that was consumed), matching loadout-enhancement-display.
        if (!item?.itemHrid || item.count === 0) continue;
        const level = item.enhancementLevel || 0;
        if (!highest.has(item.itemHrid) || level > highest.get(item.itemHrid)) {
            highest.set(item.itemHrid, level);
        }
    }
    return highest;
}

/**
 * What one slot of a loadout is really wearing.
 *
 * A loadout pinned with "use exact enhancement" wears what it says. Every other
 * loadout wears the best copy owned, so a stored level is a stale reading of
 * that rather than a fact — it is the level at the moment the loadout was last
 * saved, and enhancing the item since does not rewrite it.
 *
 * Never lower than what is stored: an inventory that has not arrived yet is an
 * empty map, and dropping a known +10 to 0 on the strength of it would be worse
 * than the staleness this is here to fix.
 *
 * @param {Object} snapshot - The loadout
 * @param {Object} equip - One entry of `snapshot.equipment`
 * @param {Map<string, number>} owned - From `highestOwnedEnhancements`
 * @returns {number} Enhancement level
 */
export function resolveEnhancementLevel(snapshot, equip, owned) {
    const stored = equip?.enhancementLevel || 0;
    if (snapshot?.useExactEnhancement) return stored;
    const highest = owned?.get(equip?.itemHrid);
    return highest === undefined ? stored : Math.max(stored, highest);
}

/**
 * Convert a server loadout object into our snapshot format.
 * @param {Object} loadout - A loadout entry from characterLoadoutMap
 * @returns {Object} snapshot
 */
function buildSnapshot(loadout) {
    // Parse equipment from wearableMap
    const equipment = [];
    for (const [locationHrid, hash] of Object.entries(loadout.wearableMap || {})) {
        const parsed = parseWearable(locationHrid, hash);
        if (parsed) equipment.push(parsed);
    }

    // Parse drinks
    const drinks = (loadout.drinkItemHrids || []).map((hrid) => ({
        itemHrid: hrid || '',
    }));

    // Parse food
    const food = (loadout.foodItemHrids || []).map((hrid) => ({
        itemHrid: hrid || '',
    }));

    // Parse abilities
    const abilities = [];
    for (const [slot, hrid] of Object.entries(loadout.abilityMap || {})) {
        if (hrid) abilities.push({ abilityHrid: hrid, slot: parseInt(slot, 10) });
    }

    return {
        name: loadout.name,
        actionTypeHrid: loadout.actionTypeHrid || '',
        isDefault: !!loadout.isDefault,
        useExactEnhancement: loadout.useExactEnhancement ?? false,
        ordinal: loadout.ordinal || 0,
        equipment,
        abilities,
        food,
        drinks,
        abilityCombatTriggersMap: loadout.abilityCombatTriggersMap || {},
        consumableCombatTriggersMap: loadout.consumableCombatTriggersMap || {},
        savedAt: Date.now(),
    };
}

class LoadoutSnapshot {
    constructor() {
        this.snapshots = {}; // In-memory cache: { [loadoutName]: snapshot }
        this.characterInitializedHandler = null;
        this.updateListeners = [];
        this.isInitialized = false;
        // Whether `snapshots` has been filled from its sources yet — storage
        // (IndexedDB, asynchronous) or a `loadouts_updated` message. An empty
        // `snapshots` says nothing on its own: before the load resolves it is
        // indistinguishable from a character with no loadouts at all, and a
        // consumer that cannot tell the two apart silently simulates the wrong
        // gear. Never reset once set — a reload is a fresh module.
        this.snapshotsReady = false;
        this._readyWaiters = [];

        // No WebSocket subscription here. This module is inlined into every
        // production bundle, but only the combat bundle's copy is ever read
        // (directly or through the bundle bridge) — a constructor-time
        // subscription had all six copies rebuilding their private caches on
        // every loadouts_updated message, five of which nothing ever read.
        // The copy that gets used subscribes on its first actual access.
        this.loadoutsUpdatedHandler = null;
    }

    /**
     * Attach the `loadouts_updated` handler to the shared WebSocket hook, once.
     *
     * Called from every public entry point rather than the constructor, so only
     * a copy something actually reads (or initializes) pays for a live cache.
     * disable() clears the handler; the next access re-subscribes.
     * @private
     */
    _ensureSubscribed() {
        if (this.loadoutsUpdatedHandler) return;
        this.loadoutsUpdatedHandler = (data) => this._onLoadoutsUpdated(data);
        getWebSocketHook().on('loadouts_updated', this.loadoutsUpdatedHandler);
    }

    /**
     * Register a callback to be called whenever snapshots are updated.
     * @param {Function} fn
     */
    onUpdate(fn) {
        this._ensureSubscribed();
        this.updateListeners.push(fn);
    }

    /**
     * Remove a previously registered update callback.
     * @param {Function} fn
     */
    offUpdate(fn) {
        this.updateListeners = this.updateListeners.filter((l) => l !== fn);
    }

    _emitUpdate() {
        this.updateListeners.forEach((fn) => fn());
    }

    /**
     * Declare the store loaded, and release anything waiting on it.
     * @private
     */
    _markReady() {
        if (this.snapshotsReady) return;
        this.snapshotsReady = true;
        const waiters = this._readyWaiters;
        this._readyWaiters = [];
        for (const resolve of waiters) resolve(true);
    }

    /**
     * Resolves once the store has been filled from storage (or from a
     * `loadouts_updated` message), so a caller that would otherwise read an
     * empty `snapshots` as "this character has no loadouts" can wait for the
     * real answer.
     *
     * Bounded: with the feature switched off nothing ever loads, so the
     * deadline marks the store ready and the wait resolves anyway.
     * @param {number} [timeoutMs]
     * @returns {Promise<boolean>} Always true — the store is ready or has been
     *   declared ready by the deadline
     */
    whenReady(timeoutMs = SNAPSHOT_READY_TIMEOUT_MS) {
        this._ensureSubscribed();
        if (this.snapshotsReady) return Promise.resolve(true);
        return new Promise((resolve) => {
            this._readyWaiters.push(resolve);
            setTimeout(() => this._markReady(), timeoutMs);
        });
    }

    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        // Covers both the first subscription and re-registering after disable()
        this._ensureSubscribed();

        // Load from storage — loadouts_updated only fires when the user visits the loadouts
        // UI, so storage is always the source of snapshots at startup.
        const ticket = captureOwner(this);
        if (Object.keys(this.snapshots).length === 0) {
            const storageKey = getStorageKey();
            // NOTE: getCurrentCharacterId() is set by the time this runs, because
            // features are initialized from inside the character_initialized
            // handler — so the key here is already character-scoped. The listener
            // below cannot correct it if it ever were not: that event has already
            // fired and will only come again on a character switch.
            const loaded = (await storage.getJSON(storageKey, 'settings', null)) || {};
            // The key was right when the read started; the adopt is a storage
            // round trip later. `initializeFeatures()` at boot is not on the
            // switch chain, so a switch landing inside this read resumes here
            // with another character current — and `disable()` clears
            // `snapshots` precisely so the arriving character's initialize will
            // read its own key. Adopting now puts the departing character's
            // gear back, which makes that guard see a full cache and skip the
            // read, and every write path below then files the departing
            // character's loadouts under the arriving character's key.
            //
            // The key comparison this replaces caught that switch and nothing
            // else. A *reconnect* — `disable()` then `initialize()` again under
            // the same character — leaves the key identical, so the suspended
            // call sailed through and re-ran the whole tail below on top of the
            // fresh call's: `characterInitializedHandler` holds one handle, so
            // the fresh call's `character_initialized` listener was orphaned,
            // live and unremovable, one per interrupted reconnect. Only the
            // ticket's generation counter tells the two calls apart.
            if (!stillOurs(ticket)) return;
            this.snapshots = loaded;

            // Fallback for Steam users: if storage is also empty, bootstrap from
            // the characterLoadoutMap embedded in init_character_data (already in dataManager).
            if (Object.keys(this.snapshots).length === 0) {
                const characterLoadoutMap = dataManager.characterData?.characterLoadoutMap;
                if (characterLoadoutMap && Object.keys(characterLoadoutMap).length > 0) {
                    this._onLoadoutsUpdated({ characterLoadoutMap });
                }
            }
        }

        // Whatever the load produced — snapshots, or a genuinely empty store —
        // is now the answer, so consumers can stop treating empty as "not yet"
        this._markReady();

        // Reload from the correct character-scoped key once character data is available
        this.characterInitializedHandler = async () => {
            const storageKey = getStorageKey();
            const fresh = (await storage.getJSON(storageKey, 'settings', null)) || {};
            // `character_initialized` is a deferred macrotask and this listener
            // is the module's own, so nothing serialises it against a further
            // switch — same reason as the read above
            if (getStorageKey() !== storageKey) return;
            if (Object.keys(fresh).length > 0) {
                this.snapshots = fresh;
                this._emitUpdate();
            }
        };
        dataManager.on('character_initialized', this.characterInitializedHandler);
    }

    /**
     * Handle a loadouts_updated WebSocket message.
     * Replaces all snapshots with the server's current state.
     * @param {Object} data - The WebSocket message payload
     */
    _onLoadoutsUpdated(data) {
        const loadoutMap = data.characterLoadoutMap;
        if (!loadoutMap) {
            console.warn('[LoadoutSnapshot] loadouts_updated received but no characterLoadoutMap');
            return;
        }

        const newSnapshots = {};
        for (const [id, loadout] of Object.entries(loadoutMap)) {
            if (!loadout.name) continue;
            newSnapshots[id] = buildSnapshot(loadout);
        }

        this.snapshots = newSnapshots;
        storage.setJSON(getStorageKey(), this.snapshots, 'settings');
        // The server's own word on the loadouts — as loaded as the store gets,
        // whether or not initialize() has run yet
        this._markReady();
        this._emitUpdate();
    }

    /**
     * Update a snapshot equipment item's enhancement level.
     * Used when the highest owned enhancement of a loadout item changes (up or down).
     * @param {string} itemHrid - Base item HRID (e.g. "/items/sword")
     * @param {number} newLevel - New enhancement level (highest currently owned)
     * @returns {boolean} True if any snapshot was updated
     */
    updateEnhancementLevel(itemHrid, newLevel) {
        this._ensureSubscribed();
        let changed = false;
        for (const snapshot of Object.values(this.snapshots)) {
            // Exact-mode snapshots intentionally hold a frozen level — never auto-update them.
            if (snapshot.useExactEnhancement) continue;
            for (const eq of snapshot.equipment || []) {
                if (eq.itemHrid === itemHrid && eq.enhancementLevel !== newLevel) {
                    eq.enhancementLevel = newLevel;
                    snapshot.savedAt = Date.now();
                    changed = true;
                }
            }
        }
        if (changed) {
            storage.setJSON(getStorageKey(), this.snapshots, 'settings');
            this._emitUpdate();
        }
        return changed;
    }

    /**
     * Find the best snapshot for a given action type.
     * Priority: skill default > all skills default > skill non-default > all skills non-default
     * @param {string} actionTypeHrid - e.g. "/action_types/brewing"
     * @returns {Object|null} snapshot entry or null
     */
    _findSnapshot(actionTypeHrid) {
        this._ensureSubscribed();
        if (!config.getSetting('loadoutSnapshot')) return null;

        let skillDefault = null;
        let allSkillsDefault = null;
        let skillNonDefault = null;
        let allSkillsNonDefault = null;

        for (const snapshot of Object.values(this.snapshots)) {
            if (snapshot.actionTypeHrid === actionTypeHrid) {
                if (snapshot.isDefault) {
                    skillDefault = snapshot;
                } else {
                    skillNonDefault = snapshot;
                }
            } else if (snapshot.actionTypeHrid === '') {
                if (snapshot.isDefault) {
                    allSkillsDefault = snapshot;
                } else {
                    allSkillsNonDefault = snapshot;
                }
            }
        }

        return skillDefault || allSkillsDefault || skillNonDefault || allSkillsNonDefault || null;
    }

    /**
     * Get a Map<itemLocationHrid, item> for the best loadout snapshot matching the given
     * action type. Returns null if no snapshot exists or the feature is disabled.
     * The returned Map has the same format as dataManager.getEquipment().
     * @param {string} actionTypeHrid
     * @returns {Map<string, Object>|null}
     */
    getSnapshotForSkill(actionTypeHrid) {
        const snapshot = this._findSnapshot(actionTypeHrid);
        if (!snapshot || !snapshot.equipment?.length) return null;
        // Through resolveEquipment, not the raw stored levels: this is the map
        // the enhancement and profit calculators wear, and reading it literally
        // quoted the enhancing outfit at the level it had when the loadout was
        // last saved — +12 gear the character had long since taken to +20
        // (reported 2026-08-29). Exact-pinned loadouts keep their frozen level
        // inside the resolver.
        return new Map(this.resolveEquipment(snapshot).map((e) => [e.itemLocationHrid, e]));
    }

    /**
     * Get the drink slots array for the best loadout snapshot matching the given
     * action type. Returns null if no snapshot exists or the feature is disabled.
     * The returned array has the same format as dataManager.getActionDrinkSlots().
     * @param {string} actionTypeHrid
     * @returns {Array<{itemHrid: string}>|null}
     */
    getSnapshotDrinksForSkill(actionTypeHrid) {
        const snapshot = this._findSnapshot(actionTypeHrid);
        if (!snapshot) return null;
        // Filter out empty slots so callers get only actual items
        const filled = (snapshot.drinks || []).filter((d) => d.itemHrid);
        return filled.length > 0 ? filled : null;
    }

    /**
     * Get all saved loadout snapshots as a flat array.
     * @returns {Array<Object>} Array of snapshot objects
     */
    getAllSnapshots() {
        this._ensureSubscribed();
        return Object.values(this.snapshots).sort((a, b) => a.ordinal - b.ordinal);
    }

    /**
     * The equipment a loadout would actually put on, at the levels it would
     * actually wear.
     *
     * A snapshot's stored enhancement level is only the truth for a loadout
     * pinned with "use exact enhancement". The default is the other way round —
     * the game equips the **highest copy you own** — and the wearable hash the
     * snapshot is parsed from routinely carries 0, or a level from before the
     * last enhancement. Reading it literally reports a refined cape at +0 while
     * the character is wearing it at +10, and every number computed from that
     * loadout is quietly wrong in the same direction.
     *
     * @param {Object} snapshot - From `snapshots` / `getAllSnapshots`
     * @returns {Array<{itemHrid: string, enhancementLevel: number, itemLocationHrid: string}>}
     */
    resolveEquipment(snapshot) {
        this._ensureSubscribed();
        const owned = highestOwnedEnhancements();
        return (snapshot?.equipment || []).map((equip) => ({
            ...equip,
            enhancementLevel: resolveEnhancementLevel(snapshot, equip, owned),
        }));
    }

    /**
     * Get the name and default status of the saved loadout being used for a given action type.
     * Returns an object with name and isDefault, or null if no snapshot exists or feature is disabled.
     * @param {string} actionTypeHrid
     * @returns {{ name: string, isDefault: boolean }|null}
     */
    getSnapshotInfoForSkill(actionTypeHrid) {
        const snapshot = this._findSnapshot(actionTypeHrid);
        if (!snapshot) return null;
        return { name: snapshot.name, isDefault: !!snapshot.isDefault };
    }

    disable() {
        // First of all, so an `initialize()` parked on the snapshot read cannot
        // resume into the handler field this teardown is about to null — on a
        // reconnect the storage key it checks is unchanged, so nothing else
        // would stop it.
        noteTeardown(this);
        try {
            if (this.loadoutsUpdatedHandler) {
                getWebSocketHook().off('loadouts_updated', this.loadoutsUpdatedHandler);
                this.loadoutsUpdatedHandler = null;
            }

            if (this.characterInitializedHandler) {
                dataManager.off('character_initialized', this.characterInitializedHandler);
                this.characterInitializedHandler = null;
            }

            this.updateListeners = [];
            this.isInitialized = false;

            // initialize()'s "only load if empty" guard exists so a
            // `loadouts_updated` message that arrived before this ran is not
            // clobbered by the storage read racing behind it — it assumes an
            // empty cache means nothing has loaded yet. Left un-cleared here,
            // that assumption breaks on a character switch: the next
            // initialize() sees the *previous* character's snapshots still
            // sitting in the cache, treats it as "already loaded", and skips
            // reading the new character's storage key entirely — profit
            // calculators keep applying the old character's gear until
            // `loadouts_updated` happens to fire again for this character.
            this.snapshots = {};
            this.snapshotsReady = false;
        } catch (error) {
            console.error('[Loadout Snapshots] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const loadoutSnapshot = new LoadoutSnapshot();

export default loadoutSnapshot;
