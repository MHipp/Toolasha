/**
 * Character Activity Status Storage
 *
 * Per-character activity projections plus a small account-level mirror of the enable flag and
 * date/time presentation preferences. Both have to be readable on the character-select screen,
 * where there is no active character and therefore no per-character settings context at all.
 *
 * Everything here goes through the `storage` module's ordinary read/write path, which is what
 * makes the cross-tab case work: the record one tab writes for the character it is playing is
 * read back by any other tab that lands on character select, because they share one IndexedDB.
 */

import storage from '../../core/storage.js';

const STORE_NAME = 'characterActivityStatus';
const ACCOUNT_PREFS_KEY = 'accountPreferences';
const RECORD_KEY_PREFIX = 'character_';
const SCHEMA_VERSION = 1;

/**
 * How long a record stays worth showing. A projection is a statement about a queue that was
 * live when it was written; a week later it is archaeology, not status.
 */
export const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Mirrors the schema default: a fresh install's character select follows the device's own clock,
// like every screen after it, rather than starting on 24-hour before any character has shared its
// preferences.
const DEFAULT_ACCOUNT_PREFS = Object.freeze({
    enabled: true,
    dateFormat: 'MM-DD',
    timeFormat: 'auto',
});

/**
 * The store key for one character's record.
 *
 * Prefixed so the account-level preferences key can never collide with a character id, however
 * the game chooses to shape ids later.
 * @param {string|number} characterId
 * @returns {string}
 */
function recordKey(characterId) {
    return `${RECORD_KEY_PREFIX}${characterId}`;
}

/**
 * Load the persisted activity record for one character.
 *
 * Fails closed: a record written by a schema this build does not understand is treated as
 * "never observed" rather than guessed at. There is no prior schema to migrate from yet.
 * @param {string|number} characterId
 * @returns {Promise<Object|null>}
 */
export async function loadCharacterActivity(characterId) {
    if (characterId == null) return null;
    try {
        const record = await storage.getJSON(recordKey(characterId), STORE_NAME, null);
        if (!record || record.version !== SCHEMA_VERSION) return null;
        return record;
    } catch (error) {
        console.error('[CharacterActivity] Failed to load record:', error);
        return null;
    }
}

/**
 * Persist the activity record for one character.
 * @param {string|number} characterId
 * @param {Object} record
 * @param {boolean} [immediate] - Skip the normal debounce (character switch / page departure,
 *      where a delayed write could be lost with the page)
 * @returns {Promise<boolean>}
 */
export async function saveCharacterActivity(characterId, record, immediate = false) {
    if (characterId == null) return false;
    try {
        return await storage.setJSON(
            recordKey(characterId),
            { ...record, version: SCHEMA_VERSION },
            STORE_NAME,
            immediate
        );
    } catch (error) {
        console.error('[CharacterActivity] Failed to save record:', error);
        return false;
    }
}

/**
 * Load the account-level presentation/enable preferences used on character select, where no
 * per-character settings context exists. Always returns a complete object.
 * @returns {Promise<{enabled: boolean, dateFormat: string, timeFormat: string}>}
 */
export async function loadAccountPreferences() {
    try {
        const saved = await storage.getJSON(ACCOUNT_PREFS_KEY, STORE_NAME, null);
        return { ...DEFAULT_ACCOUNT_PREFS, ...(saved || {}) };
    } catch (error) {
        console.error('[CharacterActivity] Failed to load account preferences:', error);
        return { ...DEFAULT_ACCOUNT_PREFS };
    }
}

/**
 * Persist the account-level presentation/enable preferences. Callers pass the character-scoped
 * values currently in effect, so character select later shows whatever was last actually used
 * rather than a schema default.
 * @param {Partial<{enabled: boolean, dateFormat: string, timeFormat: string}>} prefs
 * @returns {Promise<boolean>}
 */
export async function saveAccountPreferences(prefs) {
    try {
        const current = await loadAccountPreferences();
        return await storage.setJSON(ACCOUNT_PREFS_KEY, { ...current, ...prefs }, STORE_NAME);
    } catch (error) {
        console.error('[CharacterActivity] Failed to save account preferences:', error);
        return false;
    }
}

export const CHARACTER_ACTIVITY_STORE = STORE_NAME;
export const CHARACTER_ACTIVITY_SCHEMA_VERSION = SCHEMA_VERSION;
