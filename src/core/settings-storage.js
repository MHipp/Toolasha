/**
 * Settings Storage Module
 * Handles persistence of settings to chrome.storage.local
 */

import storage from './storage.js';
import { settingsGroups } from './settings-schema.js';

/**
 * Whether a schema type stores its state as a boolean (.isTrue)
 * @param {string} type - Setting type from the schema
 * @returns {boolean}
 */
/**
 * The one value a stored or built setting entry carries: `.value` when it
 * has one, else `.isTrue`.
 * @param {Object} entry - A settings-map entry
 * @returns {*} Its value
 */
function valueOf(entry) {
    if (!entry || typeof entry !== 'object') return undefined;
    return Object.hasOwn(entry, 'value') ? entry.value : entry.isTrue;
}

function isBooleanType(type) {
    return type === 'checkbox' || type === 'checkboxWithButton';
}

/**
 * Schema defaults that changed after release, and the value they changed from.
 *
 * A changed schema default only reaches a fresh install. The saved map is
 * written whole — every setting the schema had at save time is in it, chosen or
 * not — so an existing user holds the *old* default as an explicit stored
 * value, and the merge below faithfully restores it forever. That is right for
 * a setting the user actually picked and wrong for one they never touched, and
 * storage cannot tell the two apart.
 *
 * So each entry is rewritten exactly once, guarded by a persisted flag: an old
 * default is nudged to the new one on the first load that sees it, and after
 * that the user's value is theirs. Someone who deliberately re-picks the old
 * value keeps it, because the flag has already been set.
 *
 * `from` is the value being replaced — anything else stays put, since a user
 * who chose a third option was never sitting on the old default.
 */
const DEFAULT_REWRITES = [
    // Replaying the live fight runs the real combat engine hundreds of times
    // mid-fight; it should be opt-in rather than something every player pays for
    { id: 'labyrinthLiveCombatSim', field: 'isTrue', from: true, to: false },
    // Routing unrevealed rooms as clearable sends players through rooms that
    // turn out to need a shroud they did not bring
    { id: 'labyrinthPathUnknownMode', field: 'value', from: 'clearable', to: 'shroud' },
];

/**
 * Pass as `saveSettings`' second argument to write the whole map, every id of
 * it, over what is stored — the deliberate reset to defaults. Named rather than
 * implied by omission so a caller that simply forgot to say what it changed
 * cannot silently get the destructive write. See `saveSettings`.
 *
 * Reached as `settingsStorage.SAVE_ALL_KEYS` rather than as a named export:
 * rollup maps this module to the `Toolasha.Core.settingsStorage` global, so a
 * caller in another bundle gets the singleton and nothing else — a named import
 * would compile to `undefined` there and quietly fall through to the scoped
 * write. Hanging it off the singleton means every bundle reads the one symbol.
 * @type {symbol}
 */
const SAVE_ALL_KEYS = Symbol('settings.saveAllKeys');

/** Bump the suffix when a new batch is added to DEFAULT_REWRITES */
const DEFAULT_REWRITE_FLAG_KEY = 'settings_default_rewrites_v1';

// Task data stored per character under a `_<charId>` suffix, outside the
// settings map (task-reroll-protection.js / task-auto-reroll.js) — copied along
// with the map so "make this alt like my main" carries the task lists too
const TASK_CHARACTER_SCOPED_PREFIXES = ['taskProtectedHrids', 'taskAutoRerollHrids'];

class SettingsStorage {
    constructor() {
        this.storageKey = 'script_settingsMap'; // Legacy global key (used as template)
        this.storageArea = 'settings';
        this.currentCharacterId = null;
        this.currentCharacterName = null;
        this.knownCharactersKey = 'known_character_ids';
        /**
         * Whether the last `loadSettings()` could actually read the store.
         * `storage.getJSON` answers a read that could not be made with the
         * default, which a loader takes for "nothing saved yet" — and the
         * next whole-map write would then put the schema defaults over the
         * user's settings. `false` says the map that came back is defaults
         * standing in for settings that could not be read, not settings.
         */
        this.lastLoadReadable = true;
        /** See SAVE_ALL_KEYS — carried on the instance so it crosses bundles */
        this.SAVE_ALL_KEYS = SAVE_ALL_KEYS;
    }

    /**
     * Set the current character ID and name.
     * Must be called after character_initialized event.
     * @param {string} characterId
     * @param {string} [characterName]
     */
    setCharacterId(characterId, characterName) {
        this.currentCharacterId = characterId;
        if (characterName) this.currentCharacterName = characterName;
    }

    /**
     * Get the storage key for current character
     * Falls back to global key if no character ID set
     * @returns {string} Storage key
     */
    getCharacterStorageKey() {
        if (this.currentCharacterId) {
            return `${this.storageKey}_${this.currentCharacterId}`;
        }
        return this.storageKey; // Fallback to global key
    }

    /**
     * The setting IDs the *previous* build saved, before any merging.
     *
     * The saved map is written whole, so its keys are a fingerprint of the
     * schema of whatever script wrote it — including the upstream fork, which
     * uses the same storage keys. Diffing the current schema against this is
     * how a first run tells "arrived from another build of Toolasha, with
     * settings worth respecting" from "genuinely fresh install".
     *
     * @returns {Promise<Array<string>|null>} Stored IDs, or null when nothing
     *   has ever been saved
     */
    async storedSettingIds() {
        const saved = await storage.getJSON(this.getCharacterStorageKey(), this.storageArea, null);
        return saved ? Object.keys(saved) : null;
    }

    /**
     * Load all settings from storage
     * Merges saved values with defaults from settings-schema
     * @returns {Promise<Object>} Settings map
     */
    async loadSettings() {
        const characterKey = this.getCharacterStorageKey();
        // Whose key that is, captured with it: the migration below runs after
        // two awaits and used to read `this.currentCharacterId` afresh, so a
        // switch in the gap seeded the departing character's key and filed the
        // arriving character in the known-characters roster off the same load.
        const characterId = this.currentCharacterId;
        const characterName = this.currentCharacterName;
        // Probe first: "absent" and "could not be read" must not look alike
        // here, because the migration below treats absent as "first run for
        // this character" and writes, and the caller treats the result as
        // the settings to save back.
        //
        // The probe already read the raw value off the same key — a second
        // `getJSON` round trip just to JSON-parse it would be a redundant
        // IndexedDB transaction on every settings load, doubling this key's
        // exposure to slow transactions when the main thread or the
        // browser's IDB task queue is under load. Parse what the probe
        // already has instead.
        const probed = await storage.tryGet(characterKey, this.storageArea);
        this.lastLoadReadable = probed !== null;
        let saved = null;

        if (probed !== null) {
            saved = probed.found ? storage.parseJSON(probed.value, characterKey, null) : null;

            // Migration: If this is a character-specific key and it doesn't exist
            // Copy from global template (old 'script_settingsMap' key)
            if (characterId && !saved) {
                const globalTemplate = await storage.getJSON(this.storageKey, this.storageArea, null);
                if (globalTemplate) {
                    // Copy global template to this character
                    saved = globalTemplate;
                    await storage.setJSON(characterKey, saved, this.storageArea, true);
                }

                // Add character to known characters list
                await this.addToKnownCharacters(characterId, characterName);
            }

            saved = await this.applyDefaultRewrites(saved, characterKey);
        } else {
            console.warn(`[SettingsStorage] ${characterKey} could not be read; answering with schema defaults`);
        }

        const settings = {};

        // Build default settings from config
        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                settings[settingId] = {
                    id: settingId,
                    desc: settingDef.label,
                    type: settingDef.type || 'checkbox',
                };

                // Set default value
                if (isBooleanType(settingDef.type)) {
                    settings[settingId].isTrue = settingDef.default ?? false;
                } else {
                    settings[settingId].value = settingDef.default ?? '';
                }

                // Copy other properties
                if (settingDef.options && typeof settingDef.options !== 'function') {
                    settings[settingId].options = settingDef.options;
                }
                if (settingDef.min !== undefined) {
                    settings[settingId].min = settingDef.min;
                }
                if (settingDef.max !== undefined) {
                    settings[settingId].max = settingDef.max;
                }
                if (settingDef.step !== undefined) {
                    settings[settingId].step = settingDef.step;
                }
            }
        }

        // Merge saved settings
        if (saved) {
            for (const [settingId, savedValue] of Object.entries(saved)) {
                if (settings[settingId]) {
                    // Merge saved boolean values
                    if (savedValue.hasOwnProperty('isTrue')) {
                        settings[settingId].isTrue = savedValue.isTrue;
                    }
                    // Merge saved non-boolean values
                    if (savedValue.hasOwnProperty('value')) {
                        if (isBooleanType(settings[settingId].type)) {
                            // A boolean setting keeps its state in `.isTrue`, so a stored
                            // `.value` beside it is not a second opinion — it is either the
                            // old checkboxWithButton shape (which persisted its boolean in
                            // `.value` alone) or the write of a setter that put the new
                            // answer in the wrong field. Both mean `.value` holds the newer
                            // intent, so it wins and the entry rebuilt from the schema keeps
                            // no `.value` at all.
                            //
                            // The one case this gets wrong: a settings-panel change (which
                            // wrote `.isTrue`) made AFTER the stray `.value` write in the
                            // same session leaves `.isTrue` as the newer intent, and this
                            // prefers `.value`. That window is narrow, cannot recur now the
                            // setter deletes the field it did not write, and the alternative
                            // is that every player who ticked a box on the buggy build stays
                            // stuck with the value they tried to change.
                            settings[settingId].isTrue = !!savedValue.value;
                        } else {
                            settings[settingId].value = savedValue.value;
                        }
                    }
                }
            }

            // Migrate: formatting_useKMBFormat changed from checkbox to select
            const fmtSaved = saved['formatting_useKMBFormat'];
            if (fmtSaved && fmtSaved.hasOwnProperty('isTrue') && !fmtSaved.hasOwnProperty('value')) {
                settings['formatting_useKMBFormat'].value = fmtSaved.isTrue ? 'compact' : 'full';
            }
        }

        return settings;
    }

    /**
     * Rewrite stored values still sitting on a superseded schema default, once.
     *
     * See DEFAULT_REWRITES for why this is needed at all. The flag is stored
     * per character, beside that character's settings, so each save file is
     * nudged exactly once — and is set even when there is nothing to rewrite
     * (a fresh install, which already has the new defaults), so a later change
     * of mind is never second-guessed.
     *
     * @param {Object|null} saved - The stored settings map, or null when none
     * @param {string} characterKey - Storage key the map was loaded from
     * @returns {Promise<Object|null>} The map to merge, rewrites applied
     */
    async applyDefaultRewrites(saved, characterKey) {
        const flagKey = `${DEFAULT_REWRITE_FLAG_KEY}_${characterKey}`;
        try {
            if (await storage.get(flagKey, this.storageArea, false)) return saved;

            let next = saved;
            for (const { id, field, from, to } of DEFAULT_REWRITES) {
                const entry = saved?.[id];
                if (!entry || entry[field] !== from) continue;
                // Copy rather than mutate the loaded map, so a caller holding
                // the same object does not see it change underneath them
                next = next === saved ? { ...saved } : next;
                next[id] = { ...entry, [field]: to };
            }

            if (next !== saved) {
                await storage.setJSON(characterKey, next, this.storageArea, true);
            }
            await storage.set(flagKey, true, this.storageArea, true);
            return next;
        } catch (error) {
            // A failed rewrite must not cost the user their settings; the flag
            // stays unset, so the next load tries again
            console.error('[SettingsStorage] Default rewrite failed:', error);
            return saved;
        }
    }

    /**
     * Build default settings from schema without touching storage
     * Used during early initialization before character ID is known
     * @returns {Object} Settings map with schema defaults only
     */
    buildDefaults() {
        const settings = {};

        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                settings[settingId] = {
                    id: settingId,
                    desc: settingDef.label,
                    type: settingDef.type || 'checkbox',
                };

                if (isBooleanType(settingDef.type)) {
                    settings[settingId].isTrue = settingDef.default ?? false;
                } else {
                    settings[settingId].value = settingDef.default ?? '';
                }

                if (settingDef.options) {
                    settings[settingId].options = settingDef.options;
                }
                if (settingDef.min !== undefined) {
                    settings[settingId].min = settingDef.min;
                }
                if (settingDef.max !== undefined) {
                    settings[settingId].max = settingDef.max;
                }
                if (settingDef.step !== undefined) {
                    settings[settingId].step = settingDef.step;
                }
            }
        }

        return settings;
    }

    /**
     * Save all settings to storage, keeping entries this build does not know.
     *
     * `loadSettings()` builds its map from the schema and merges saved values
     * onto it, so a stored id the current schema has no entry for never reaches
     * the map — and this write is whole, so the next save erased it. That is
     * fine for a setting genuinely retired, and wrong for the case that
     * actually happens: a device on an older build pulls settings written by a
     * newer one (`sync-payload.js` folds the incoming map onto the local one,
     * so the newer ids DO land on disk), and the first toggle on the old build
     * strips every one of them. Upgrading that device later then finds those
     * settings back at their shipped defaults, with no sign they were ever
     * chosen. The same applies to the upstream fork, which writes its own ids
     * to these very keys.
     *
     * So an id the caller's map does not mention is carried over from what is
     * stored rather than dropped. `loadSettings()` emits every id in the
     * schema, so the only ids that can be carried are ones this build does not
     * have — nothing the user can turn off is kept alive by this.
     *
     * A store that cannot be read still gets the write: losing the change the
     * player just made is a worse answer than losing ids this build cannot show
     * them anyway.
     *
     * `dirtyKeys` narrows the write to the ids the caller actually changed.
     * Without it this method writes the caller's whole map, which means a client
     * holding a map it loaded ten minutes ago reverts every setting another
     * client has changed since — a second tab or a second browser on the same
     * character is enough, and neither shows any sign of it. With it, what is
     * stored is the base and only the named ids (plus any id stored does not
     * have at all, so a genuinely new setting still lands) are written over it.
     *
     * @param {Object} settings - Settings map
     * @param {Iterable<string>|symbol|null} [dirtyKeys=null] - The ids this
     *   caller changed, `settingsStorage.SAVE_ALL_KEYS` to write the map whole,
     *   or null for a caller with no dirty tracking (writes whole, as it always did)
     * @returns {Promise<void>}
     */
    async saveSettings(settings, dirtyKeys = null) {
        const characterKey = this.getCharacterStorageKey();
        const probed = await storage.tryGet(characterKey, this.storageArea);

        let stored = probed?.found ? probed.value : null;
        if (typeof stored === 'string') {
            try {
                stored = JSON.parse(stored);
            } catch {
                stored = null;
            }
        }

        let toWrite = settings;
        if (stored && typeof stored === 'object') {
            const scoped = dirtyKeys !== null && dirtyKeys !== undefined && dirtyKeys !== SAVE_ALL_KEYS;
            if (scoped) {
                // Stored is the base, so every id this client did not touch keeps
                // whatever another client last wrote for it — including ids this
                // build has no schema entry for, which fall out of the loop below
                // and are therefore carried for free.
                const dirty = dirtyKeys instanceof Set ? dirtyKeys : new Set(dirtyKeys);
                toWrite = { ...stored };
                for (const [id, entry] of Object.entries(settings || {})) {
                    if (dirty.has(id) || !(id in stored)) toWrite[id] = entry;
                }
            } else {
                const foreign = Object.keys(stored).filter((id) => !(id in (settings || {})));
                if (foreign.length > 0) {
                    toWrite = { ...settings };
                    for (const id of foreign) toWrite[id] = stored[id];
                }
            }
        }

        await storage.setJSON(characterKey, toWrite, this.storageArea, true);
    }

    /**
     * Save a settings map that was never read back, without writing over what
     * the user had.
     *
     * For a map built from schema defaults because the store could not be
     * read, a key still at its default says nothing about the user's choice,
     * so the stored entry keeps it; a key moved off its default is a choice
     * made this session and wins. Refuses outright when the store cannot be
     * read now either — a blind write of defaults is the accident this exists
     * to prevent. A store with nothing under the key is written whole.
     *
     * @param {Object} settings - Settings map, as `loadSettings()` shapes it
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveSettingsKeepingStored(settings) {
        const characterKey = this.getCharacterStorageKey();
        const probed = await storage.tryGet(characterKey, this.storageArea);
        if (probed === null) {
            console.warn(`[SettingsStorage] Settings not saved: ${characterKey} could not be read first`);
            return false;
        }

        let stored = probed.found ? probed.value : null;
        if (typeof stored === 'string') {
            try {
                stored = JSON.parse(stored);
            } catch {
                stored = null;
            }
        }
        if (!stored || typeof stored !== 'object') {
            await storage.setJSON(characterKey, settings, this.storageArea, true);
            return true;
        }

        const defaults = this.buildDefaults();
        const merged = { ...stored };
        for (const [settingId, entry] of Object.entries(settings || {})) {
            const untouched = settingId in defaults && valueOf(entry) === valueOf(defaults[settingId]);
            if (!(settingId in merged) || !untouched) merged[settingId] = entry;
        }
        await storage.setJSON(characterKey, merged, this.storageArea, true);
        return true;
    }

    /**
     * Add character to known characters list, storing name alongside ID.
     * Migrates old flat-array format ([id, id]) to object format ([{id, name}]).
     * @param {string} characterId
     * @param {string} characterName
     * @returns {Promise<void>}
     */
    async addToKnownCharacters(characterId, characterName) {
        // The game sends the id as a NUMBER and the stored list holds STRINGS,
        // so a strict compare against the raw value never matched — every call
        // pushed a fresh duplicate of the same character, and rosters grew into
        // the hundreds. Everything below works in strings.
        const id = String(characterId);
        const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
        const list = this._normalizeKnownCharacters(raw);
        const existing = list.find((c) => c.id === id);
        if (existing) {
            if (characterName && existing.name !== characterName) {
                existing.name = characterName;
                await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
            } else if (list.length !== raw.length) {
                // The normalize pass collapsed historic duplicates — keep that
                await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
            }
        } else {
            list.push({ id, name: characterName || id });
            await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
        }
    }

    /**
     * Normalise stored known-characters to [{id, name}] regardless of legacy
     * format, one entry per id.
     *
     * Rosters written before the id-type fix hold the same character dozens of
     * times (a number-vs-string compare never found the existing entry), so
     * duplicates are collapsed here: one entry per id, keeping the best name
     * seen for it — a real name over an id echoed as one.
     *
     * @param {Array} raw
     * @returns {Array<{id: string, name: string}>}
     * @private
     */
    _normalizeKnownCharacters(raw) {
        if (!Array.isArray(raw)) return [];
        const byId = new Map();
        for (const entry of raw) {
            const normalized =
                typeof entry === 'object' && entry !== null
                    ? { id: String(entry.id), name: entry.name || String(entry.id) }
                    : { id: String(entry), name: String(entry) };
            const kept = byId.get(normalized.id);
            // Later entries win, except a real name is never replaced by an id echo
            if (!kept || normalized.name !== normalized.id || kept.name === kept.id) {
                byId.set(normalized.id, normalized);
            }
        }
        return [...byId.values()];
    }

    /**
     * Get list of known characters as [{id, name}] objects.
     *
     * Reads self-heal: a roster the duplicate bug inflated is collapsed and,
     * when that changed anything, written back, so the fix applies itself on
     * the first read after updating.
     *
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getKnownCharacters() {
        const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
        const list = this._normalizeKnownCharacters(raw);
        if (Array.isArray(raw) && list.length !== raw.length) {
            await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
        }
        return list;
    }

    /**
     * Sync current settings to a specified subset of characters.
     * @param {Object} settings - Current settings to copy
     * @param {string[]} targetIds - IDs to sync to (omit to sync to all others)
     * @returns {Promise<number>} Number of characters synced
     */
    async syncSettingsToAllCharacters(settings, targetIds) {
        // The source is whoever was current when the button was pressed — the
        // character `settings` was read off. Re-reading it after the awaits
        // below would exclude the wrong character from the targets and copy the
        // wrong character's task lists.
        const sourceId = this.currentCharacterId;
        const knownCharacters = await this.getKnownCharacters();
        let syncedCount = 0;

        const targets = targetIds
            ? knownCharacters.filter((c) => targetIds.includes(c.id))
            : knownCharacters.filter((c) => c.id !== sourceId);

        const taskScopedValues = await Promise.all(
            TASK_CHARACTER_SCOPED_PREFIXES.map((prefix) =>
                storage.getJSON(`${prefix}_${sourceId}`, this.storageArea, null)
            )
        );

        for (const character of targets) {
            if (character.id === sourceId) continue;
            const characterKey = `${this.storageKey}_${character.id}`;
            await storage.setJSON(characterKey, settings, this.storageArea, true);

            for (let i = 0; i < TASK_CHARACTER_SCOPED_PREFIXES.length; i++) {
                if (taskScopedValues[i] === null) continue;
                const targetKey = `${TASK_CHARACTER_SCOPED_PREFIXES[i]}_${character.id}`;
                await storage.setJSON(targetKey, taskScopedValues[i], this.storageArea, true);
            }
            syncedCount++;
        }

        return syncedCount;
    }

    /**
     * Merge a handful of setting entries into every other known character's
     * stored map, leaving the rest of their settings alone.
     *
     * The whole-map copies above are the "make this alt like my main" gesture;
     * this is the narrow one — a few keys that describe a device rather than a
     * playstyle, such as the sync group's token and switches.
     *
     * A known character with nothing stored is skipped rather than seeded: a
     * map holding six keys would, on that character's next load, read as a
     * settings map written by some other build of the script and set off the
     * first-run reconciliation. It is named in the result instead.
     *
     * @param {Object} entries - Setting entries by id, shaped as loadSettings() writes them
     * @returns {Promise<{copied: Array<{id: string, name: string}>, skipped: Array<{id: string, name: string}>}>}
     */
    async copySettingEntriesToOtherCharacters(entries) {
        const ids = Object.keys(entries || {});
        const copied = [];
        const skipped = [];
        if (ids.length === 0) return { copied, skipped };

        // Fixed for the whole walk: the loop awaits a read and a write per
        // character, and a switch part way through would start excluding a
        // different character from "the other characters".
        const sourceId = String(this.currentCharacterId);

        for (const character of await this.getKnownCharacters()) {
            if (String(character.id) === sourceId) continue;
            const characterKey = `${this.storageKey}_${character.id}`;
            const stored = await storage.getJSON(characterKey, this.storageArea, null);
            if (!stored || typeof stored !== 'object' || Object.keys(stored).length === 0) {
                skipped.push(character);
                continue;
            }
            const merged = { ...stored };
            for (const id of ids) merged[id] = { ...entries[id] };
            await storage.setJSON(characterKey, merged, this.storageArea, true);
            copied.push(character);
        }

        return { copied, skipped };
    }

    /**
     * Copy another character's whole settings map onto the current character.
     *
     * The inverse of the sync buttons: they push this character's settings out,
     * this pulls another character's settings in — the one-click "make this new
     * alt like my main" a fresh character wants. The map is written whole, the
     * same shape a normal save uses, so the caller only has to reload config.
     *
     * @param {string} sourceId - The character to copy settings from
     * @returns {Promise<boolean>} True when a map was found and written
     */
    async copySettingsFromCharacter(sourceId) {
        if (!sourceId || !this.currentCharacterId || String(sourceId) === String(this.currentCharacterId)) {
            return false;
        }
        // The destination is the character the user was on when they pressed
        // the button, not whoever is current when the source map comes back —
        // a switch during the read would otherwise overwrite the arriving
        // character's settings with a map they never asked for.
        const destinationKey = this.getCharacterStorageKey();
        const sourceMap = await storage.getJSON(`${this.storageKey}_${sourceId}`, this.storageArea, null);
        if (!sourceMap || typeof sourceMap !== 'object' || Object.keys(sourceMap).length === 0) {
            return false;
        }
        if (this.getCharacterStorageKey() !== destinationKey) {
            console.warn('[SettingsStorage] Settings not copied: the character changed while the source map loaded');
            return false;
        }
        await storage.setJSON(destinationKey, sourceMap, this.storageArea, true);
        return true;
    }

    /**
     * The known characters, other than the current one, that actually have
     * settings saved — the only ones worth offering as a copy source.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async charactersWithSettings() {
        const known = await this.getKnownCharacters();
        const withSettings = [];
        for (const character of known) {
            if (String(character.id) === String(this.currentCharacterId)) continue;
            const map = await storage.getJSON(`${this.storageKey}_${character.id}`, this.storageArea, null);
            if (map && typeof map === 'object' && Object.keys(map).length > 0) {
                withSettings.push(character);
            }
        }
        return withSettings;
    }

    /**
     * Get a single setting value
     * @param {string} settingId - Setting ID
     * @param {*} defaultValue - Default value if not found
     * @returns {Promise<*>} Setting value
     */
    async getSetting(settingId, defaultValue = null) {
        const settings = await this.loadSettings();
        const setting = settings[settingId];

        if (!setting) {
            return defaultValue;
        }

        // Return boolean for checkbox settings
        if (isBooleanType(setting.type)) {
            return setting.isTrue ?? defaultValue;
        }

        // Return value for other settings
        return setting.value ?? defaultValue;
    }

    /**
     * Set a single setting value
     * @param {string} settingId - Setting ID
     * @param {*} value - New value
     * @returns {Promise<void>}
     */
    async setSetting(settingId, value) {
        // Captured before the load, checked after it. `loadSettings()` reads
        // the key that was current when it started, and `saveSettings()` below
        // asks for the key that is current when it runs — so a character switch
        // landing in that gap wrote the departing character's whole settings
        // map, plus this edit, under the arriving character's key.
        const characterKey = this.getCharacterStorageKey();
        const settings = await this.loadSettings();
        if (this.getCharacterStorageKey() !== characterKey) {
            console.warn(
                `[SettingsStorage] Setting '${settingId}' not saved: the character changed while settings loaded`
            );
            return;
        }
        if (!this.lastLoadReadable) {
            // The map in hand is defaults standing in for settings that could
            // not be read; writing it back would put them over the user's
            console.warn(`[SettingsStorage] Setting '${settingId}' not saved: settings could not be read first`);
            return;
        }

        if (!settings[settingId]) {
            console.warn(`Setting '${settingId}' not found`);
            return;
        }

        // Update value
        if (isBooleanType(settings[settingId].type)) {
            settings[settingId].isTrue = value;
        } else {
            settings[settingId].value = value;
        }

        // Freshly loaded a few lines up, so a whole-map write would be correct
        // here too — but naming the one id it changed costs nothing and keeps a
        // concurrent client's change made during that gap.
        await this.saveSettings(settings, [settingId]);
    }

    /**
     * Reset all settings to defaults
     * @returns {Promise<void>}
     */
    async resetToDefaults() {
        // Clear per-character settings so loadSettings() returns defaults
        const characterKey = this.getCharacterStorageKey();
        await storage.delete(characterKey, this.storageArea);
    }

    /**
     * Export all settings as JSON (full dump of settings store)
     * Includes global keys and current character's keys.
     * Excludes transient cache data.
     * @returns {Promise<string>} JSON string
     */
    async exportSettings() {
        const allData = await storage.getAll(this.storageArea);

        // Exclude transient cache keys
        const EXCLUDE_PREFIXES = ['marketplace_cache'];
        const exported = {};

        for (const [key, value] of Object.entries(allData)) {
            if (EXCLUDE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
            exported[key] = value;
        }

        return JSON.stringify(exported, null, 2);
    }

    /**
     * Import settings from JSON
     * Only imports global keys and keys matching the current character ID.
     * Character-specific keys for other characters are skipped.
     * @param {string} jsonString - JSON string
     * @returns {Promise<{imported: number, skipped: number}>} Import result
     */
    async importSettings(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            const currentCharId = this.currentCharacterId;
            let imported = 0;
            let skipped = 0;

            const knownCharacters = new Set((await this.getKnownCharacters()).map((character) => character.id));
            if (data[this.knownCharactersKey]) {
                for (const character of this._normalizeKnownCharacters(data[this.knownCharactersKey])) {
                    knownCharacters.add(character.id);
                }
            }

            for (const [key, value] of Object.entries(data)) {
                const charIdMatch =
                    key.match(/_([0-9a-f]{24})$/i) ||
                    key.match(/_(\d{10,})$/) ||
                    this._matchKnownCharacterSuffix(key, knownCharacters);

                if (charIdMatch) {
                    const keyCharId = charIdMatch[1];
                    if (currentCharId && keyCharId !== String(currentCharId)) {
                        skipped++;
                        continue;
                    }
                }

                await storage.setJSON(key, value, this.storageArea, true);
                imported++;
            }

            return { imported, skipped };
        } catch (error) {
            console.error('[Settings Storage] Import failed:', error);
            return null;
        }
    }

    /**
     * Check if a key ends with a known character ID suffix
     * @param {string} key - Storage key
     * @param {Set<string>} knownIds - Set of known character ID strings
     * @returns {Array|null} Match array with captured ID at index 1, or null
     * @private
     */
    _matchKnownCharacterSuffix(key, knownIds) {
        const lastUnderscore = key.lastIndexOf('_');
        if (lastUnderscore === -1) return null;
        const suffix = key.substring(lastUnderscore + 1);
        if (knownIds.has(suffix)) {
            return [key, suffix];
        }
        return null;
    }
}

const settingsStorage = new SettingsStorage();

export default settingsStorage;
