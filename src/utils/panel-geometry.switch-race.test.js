/** @vitest-environment happy-dom
 *
 * A character switch landing inside the open-flags read.
 *
 * `openFlags()` fixes its cache key from `characterKey(OPEN_KEY)` before the
 * read, but the read itself — `liftLegacyOpenFlags()` and then `readScoped()` —
 * resolves that key again, later, against whoever is current by then. A switch
 * inside the lift therefore cached the ARRIVING character's set of open panels
 * under the DEPARTING character's key, where it stays for the life of the tab:
 * the departing character's panels reopen to somebody else's arrangement, and
 * the next `saveOpenState()` writes that arrangement into their stored record.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ settings: {} }));

const gate = vi.hoisted(() => ({ geometry: null }));

const mockDataManager = vi.hoisted(() => ({
    characterId: 'char1',
    gameMode: 'standard',
    getCurrentCharacterId: () => mockDataManager.characterId,
    getCurrentCharacterGameMode: () => mockDataManager.gameMode,
    on: () => {},
    off: () => {},
}));

vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
        set: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        getJSON: async (key, name = 'settings', fallback = null) => {
            // The geometry read is the first await inside `liftLegacyOpenFlags`
            if (key === 'panelGeometry' && gate.geometry) await gate.geometry;
            return store[name]?.[key] ?? fallback;
        },
        setJSON: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        delete: async (key, name = 'settings') => {
            delete store[name][key];
            return true;
        },
        getAllKeys: async (name = 'settings') => Object.keys(store[name] || {}),
    },
}));

const { wasOpen, saveOpenState, _resetCaches } = await import('./panel-geometry.js');

describe('a character switch landing inside the open-flags read', () => {
    beforeEach(() => {
        store.settings = {
            panelOpenState_char1: { panelA: true },
            panelOpenState_char2: { panelB: true },
        };
        gate.geometry = null;
        mockDataManager.characterId = 'char1';
        _resetCaches();
    });

    /**
     * Start char1's flags read, hold it open, settle the switch to char2, then
     * let it land.
     * @returns {Promise<boolean>} What char1's `wasOpen('panelA')` answered
     */
    async function switchDuringRead() {
        let release;
        gate.geometry = new Promise((resolve) => {
            release = resolve;
        });
        const pending = wasOpen('panelA');
        // Let `openFlags()` get past `await storage.ready`, fix its cache key as
        // char1's, and park inside the lift — the switch has to land *there*
        await new Promise((resolve) => setTimeout(resolve, 0));
        mockDataManager.characterId = 'char2';
        release();
        gate.geometry = null;
        return pending;
    }

    test("char2's open panels are not cached as char1's", async () => {
        await switchDuringRead();

        // Back on char1, with their own record on disk untouched
        mockDataManager.characterId = 'char1';
        expect(await wasOpen('panelB')).toBe(false);
        expect(await wasOpen('panelA')).toBe(true);
    });

    test("char2's open panels are never written into char1's record", async () => {
        await switchDuringRead();

        mockDataManager.characterId = 'char1';
        await saveOpenState('panelC', true);

        expect(store.settings.panelOpenState_char1).toEqual({ panelA: true, panelC: true });
        expect(store.settings.panelOpenState_char2).toEqual({ panelB: true });
    });
});
