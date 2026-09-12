/**
 * The record round-trip.
 *
 * The whole feature rests on one claim: what a tab writes while it is playing a character is
 * what another tab reads back on the character-select screen. These tests stand in for the
 * shared IndexedDB with a plain map, and check the parts that are ours — the key shape that
 * keeps a character id from colliding with the account preferences key, the schema-version gate
 * that refuses to guess at a record it does not understand, and the preference mirror that
 * merges rather than replaces.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

/** The store, keyed `storeName -> key -> value`, swapped out between tests */
const db = vi.hoisted(() => ({ data: new Map(), writes: [] }));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, storeName, defaultValue = null) => {
            const store = db.data.get(storeName);
            const value = store?.get(key);
            return value === undefined ? defaultValue : value;
        },
        setJSON: async (key, value, storeName, immediate = false) => {
            if (!db.data.has(storeName)) db.data.set(storeName, new Map());
            db.data.get(storeName).set(key, value);
            db.writes.push({ key, storeName, immediate });
            return true;
        },
    },
}));

const { loadCharacterActivity, saveCharacterActivity, loadAccountPreferences, saveAccountPreferences } =
    await import('./character-activity-storage.js');

const sampleRecord = () => ({
    characterId: '1234',
    characterName: 'Bessie',
    observedAt: 1_700_000_000_000,
    offline: { hourCap: 12, mooPassExpireTime: null },
    projection: { segments: [], terminalCause: 'idle', terminalAt: 1_700_000_000_000, certainty: 'trustworthy' },
});

beforeEach(() => {
    db.data = new Map();
    db.writes = [];
});

describe('character record round-trip', () => {
    test('a saved record reads back with its fields intact', async () => {
        await saveCharacterActivity('1234', sampleRecord());
        const loaded = await loadCharacterActivity('1234');

        expect(loaded.characterName).toBe('Bessie');
        expect(loaded.offline.hourCap).toBe(12);
        expect(loaded.projection.terminalCause).toBe('idle');
    });

    test('a character never observed reads back as null, not as a default', async () => {
        expect(await loadCharacterActivity('9999')).toBeNull();
    });

    test('one character’s record does not answer for another', async () => {
        await saveCharacterActivity('1234', sampleRecord());
        expect(await loadCharacterActivity('5678')).toBeNull();
    });

    test('a character id cannot collide with the account preferences key', async () => {
        await saveCharacterActivity('accountPreferences', { ...sampleRecord(), characterName: 'Impostor' });
        const prefs = await loadAccountPreferences();

        expect(prefs.enabled).toBe(true);
        expect(prefs.characterName).toBeUndefined();
    });

    test('a record from an unknown schema version is refused rather than guessed at', async () => {
        db.data.set('characterActivityStatus', new Map([['character_1234', { ...sampleRecord(), version: 99 }]]));

        expect(await loadCharacterActivity('1234')).toBeNull();
    });

    test('immediate is passed through so a departing character’s write is not debounced away', async () => {
        await saveCharacterActivity('1234', sampleRecord(), true);
        expect(db.writes.at(-1).immediate).toBe(true);
    });

    test('a missing character id writes nothing at all', async () => {
        expect(await saveCharacterActivity(null, sampleRecord())).toBe(false);
        expect(db.writes).toHaveLength(0);
    });
});

describe('account preference mirror', () => {
    test('never-saved preferences come back complete', async () => {
        expect(await loadAccountPreferences()).toEqual({ enabled: true, dateFormat: 'MM-DD', timeFormat: 'auto' });
    });

    test('a partial save merges onto what is already there', async () => {
        await saveAccountPreferences({ dateFormat: 'DD-MM' });
        await saveAccountPreferences({ enabled: false });

        // timeFormat was never saved, so it is the fresh-install fallback
        expect(await loadAccountPreferences()).toEqual({
            enabled: false,
            dateFormat: 'DD-MM',
            timeFormat: 'auto',
        });
    });
});
