/**
 * The panel's own state, and the two rules it keeps.
 *
 * Every key is per character — an iron cow's plan is not the main's — and the
 * only thing that can be stored is a tick that is on. A tick turned off is
 * removed rather than written as `false`, so a stale `false` can never sit in
 * storage arguing with a stage the character has since finished.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({ values: {}, readPending: null }));
// Mutable so the character-switch race test can move the active character
// mid-flight, the way a real switch does.
const characterId = vi.hoisted(() => ({ current: 'charA' }));

vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, _store, fallback) => {
        if (disk.readPending) await disk.readPending;
        return base in disk.values ? disk.values[base] : fallback;
    },
    writeScoped: async (base, value) => {
        disk.values[base] = value;
        return true;
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => characterId.current,
    },
}));

const {
    loadOverrides,
    setOverride,
    loadSnapshot,
    saveSnapshot,
    loadPlanCollapsed,
    setPlanCollapsed,
    OVERRIDES_KEY,
    SNAPSHOT_KEY,
    PLAN_COLLAPSED_KEY,
} = await import('./ironcow-store.js');

beforeEach(() => {
    disk.values = {};
    disk.readPending = null;
    characterId.current = 'charA';
});

describe('the storage keys, deliberately unchanged by the display-name rename', () => {
    // The panel's display name is "Iron Bell Farming", but these two keys are
    // still the literal strings they always were — renaming them would orphan
    // an existing user's stage ticks and last costed loop.
    test('the stage ticks are still keyed by ironCowFarmOverrides', () => {
        expect(OVERRIDES_KEY).toBe('ironCowFarmOverrides');
    });

    test('the last costed loop is still keyed by ironCowFarmSnapshot', () => {
        expect(SNAPSHOT_KEY).toBe('ironCowFarmSnapshot');
    });
});

describe('the stage ticks', () => {
    test('start empty', async () => {
        await expect(loadOverrides()).resolves.toEqual({});
    });

    test('a tick round-trips', async () => {
        await setOverride('rooms', true);
        expect(disk.values[OVERRIDES_KEY]).toEqual({ rooms: true });
        await expect(loadOverrides()).resolves.toEqual({ rooms: true });
    });

    test('unticking removes the key rather than storing a false', async () => {
        await setOverride('rooms', true);
        await setOverride('rooms', false);
        expect(disk.values[OVERRIDES_KEY]).toEqual({});
    });

    test('anything stored that is not a tick is dropped on the way in', async () => {
        disk.values[OVERRIDES_KEY] = { rooms: true, jewelry: false, alchemy: 'yes' };
        await expect(loadOverrides()).resolves.toEqual({ rooms: true });
    });

    test('a stored shape that is not a map at all is nothing, not a crash', async () => {
        disk.values[OVERRIDES_KEY] = ['rooms'];
        await expect(loadOverrides()).resolves.toEqual({});
        disk.values[OVERRIDES_KEY] = 'rooms';
        await expect(loadOverrides()).resolves.toEqual({});
    });

    test("a character switch mid-tick does not file the departing character's tick under the arriving one's key", async () => {
        // Character B has already ticked "rooms" for themself.
        characterId.current = 'charB';
        await setOverride('rooms', true);
        expect(disk.values[OVERRIDES_KEY]).toEqual({ rooms: true });

        // Character A ticks "jewelry"; the read inside setOverride is slow
        // and still in flight...
        characterId.current = 'charA';
        let releaseRead;
        disk.readPending = new Promise((resolve) => {
            releaseRead = resolve;
        });
        const ticking = setOverride('jewelry', true);

        // ...and the player switches to character B before it resolves.
        characterId.current = 'charB';
        releaseRead();
        await ticking;

        // A's tick must never land under B's key: B's own stored tick map is
        // untouched by a write that started life as A's.
        expect(disk.values[OVERRIDES_KEY]).toEqual({ rooms: true });
    });
});

describe('the last costed loop', () => {
    test('is nothing until one has been costed', async () => {
        await expect(loadSnapshot()).resolves.toBeNull();
    });

    test('round-trips', async () => {
        await saveSnapshot({ goldPerHour: 277_500, computedAt: 1 });
        expect(disk.values[SNAPSHOT_KEY]).toMatchObject({ goldPerHour: 277_500 });
        await expect(loadSnapshot()).resolves.toMatchObject({ goldPerHour: 277_500 });
    });

    test('a null result clears rather than half-writes', async () => {
        await saveSnapshot({ goldPerHour: 1 });
        await saveSnapshot(null);
        await expect(loadSnapshot()).resolves.toBeNull();
    });
});

describe('whether the plan section is shut', () => {
    test('defaults to open, so an upgrade changes nobody’s panel', async () => {
        await expect(loadPlanCollapsed()).resolves.toBe(false);
    });

    test('shut round-trips', async () => {
        await setPlanCollapsed(true);
        expect(disk.values[PLAN_COLLAPSED_KEY]).toBe(true);
        await expect(loadPlanCollapsed()).resolves.toBe(true);
    });

    test('opening it again round-trips', async () => {
        await setPlanCollapsed(true);
        await setPlanCollapsed(false);
        await expect(loadPlanCollapsed()).resolves.toBe(false);
    });

    test('anything stored that is not a boolean reads as open', async () => {
        disk.values[PLAN_COLLAPSED_KEY] = 'yes';
        await expect(loadPlanCollapsed()).resolves.toBe(false);
    });

    test('is keyed apart from the stage ticks and the snapshot', () => {
        expect(PLAN_COLLAPSED_KEY).not.toBe(OVERRIDES_KEY);
        expect(PLAN_COLLAPSED_KEY).not.toBe(SNAPSHOT_KEY);
    });
});
