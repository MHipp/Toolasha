/** @vitest-environment happy-dom
 *
 * Remembering where a panel was, and whether it was anywhere.
 *
 * The two halves are stored apart on purpose. Where a panel sits is the same
 * answer on every character — you dragged it there once. Which panels were left
 * open is not: the market character's eight open panels reopening on top of the
 * iron cow is the leak this split exists to close.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ settings: {}, networthHistory: {} }));

const mockDataManager = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
    getCurrentCharacterId: () => mockDataManager.characterId,
    getCurrentCharacterGameMode: () => mockDataManager.gameMode,
    on: () => {},
    off: () => {},
}));

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
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
        getJSON: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
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

const {
    saveGeometry,
    saveOpenState,
    wasOpen,
    allGeometry,
    reopenIfLeftOpen,
    clearPosition,
    restoreGeometry,
    clampGeometry,
    clampPanelToViewport,
    markPanelInteracted,
    _resetCaches,
} = await import('./panel-geometry.js');
const { _resetAdoptionCache } = await import('./character-key.js');

beforeEach(() => {
    store.settings = {};
    store.networthHistory = {};
    mockDataManager.characterId = 'market123';
    mockDataManager.gameMode = 'standard';
    _resetCaches();
    _resetAdoptionCache();
});

describe('holding a saved geometry inside the window', () => {
    const phone = { width: 400, height: 800 };

    test('a position saved on a desktop comes back fully on a phone', () => {
        // The bug this is here for: the Treasure panel restored at a left of
        // 900 on a 400px screen, with the header and its close button off the
        // right-hand side and no way to reach either.
        const clamped = clampGeometry({ left: 900, top: 120, width: 720, height: 560 }, phone);

        expect(clamped.width).toBe(400);
        expect(clamped.left).toBe(0);
        expect(clamped.left + clamped.width).toBeLessThanOrEqual(phone.width);
    });

    test('a panel that still fits is left where it was', () => {
        const clamped = clampGeometry({ left: 40, top: 60, width: 300, height: 400 }, phone);

        expect(clamped).toEqual({ left: 40, top: 60, width: 300, height: 400 });
    });

    test('a panel nudged past the right edge is pulled back, not merely tethered', () => {
        // The old rule kept a 60px strip on screen, which is enough to drag a
        // panel by on a mouse and no help at all when the part hanging off is
        // the close button
        const clamped = clampGeometry({ left: 380, top: 10, width: 300, height: 200 }, phone);

        expect(clamped.left).toBe(100);
    });

    test('a saved position above or left of the window comes back to the corner', () => {
        const clamped = clampGeometry({ left: -250, top: -80, width: 300, height: 200 }, phone);

        expect(clamped).toMatchObject({ left: 0, top: 0 });
    });

    test('a minimum bigger than the screen is not honoured', () => {
        // The Treasure panel asks for 420 back. A phone is 400 wide, and a
        // minimum that overflows the screen is the bug it was written against.
        const clamped = clampGeometry({ left: 0, top: 0, width: 720, height: 560 }, phone, {
            width: 420,
            height: 200,
        });

        expect(clamped.width).toBe(400);
    });

    test('a panel taller than the window sits at the top of it', () => {
        const clamped = clampGeometry({ left: 0, top: 300, width: 300, height: 2000 }, phone);

        expect(clamped.height).toBe(800);
        expect(clamped.top).toBe(0);
    });

    test('nothing saved is nothing to apply', () => {
        expect(clampGeometry(null, phone)).toBe(null);
        expect(clampGeometry({}, phone)).toBe(null);
    });
});

describe('holding a panel that is already on screen inside the window', () => {
    /**
     * happy-dom lays nothing out, so the rect a browser would have measured is
     * the one thing a test has to supply.
     * @param {Object} rect - `{left, top, width, height}`
     * @returns {HTMLElement} A panel in the document
     */
    function panelAt({ left, top, width, height }) {
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'fixed',
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
        });
        panel.getBoundingClientRect = () => ({
            left,
            top,
            width,
            height,
            right: left + width,
            bottom: top + height,
        });
        document.body.appendChild(panel);
        return panel;
    }

    const realWidth = window.innerWidth;
    const realHeight = window.innerHeight;

    beforeEach(() => {
        document.body.replaceChildren();
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    });

    afterEach(() => {
        // A phone-sized window left behind would clamp every panel the rest of
        // this file restores
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
        document.body.replaceChildren();
    });

    test('a panel opening off the right edge is pulled in and re-anchored', () => {
        const panel = panelAt({ left: 320, top: 80, width: 380, height: 500 });

        const applied = clampPanelToViewport(panel);

        expect(applied.left).toBe(20);
        expect(panel.style.left).toBe('20px');
        expect(panel.style.right).toBe('auto');
    });

    test('a panel wider than the screen is narrowed to it', () => {
        const panel = panelAt({ left: 0, top: 0, width: 720, height: 500 });

        clampPanelToViewport(panel);

        expect(panel.style.width).toBe('400px');
    });

    test('a panel taller than the screen is shortened to it', () => {
        // The position clamp can only push `top` down to 0, so without a height
        // shrink this panel still runs 400px off the bottom — taking the close
        // button with it. This is the keyboard case on a phone.
        const panel = panelAt({ left: 0, top: 0, width: 300, height: 1200 });

        const applied = clampPanelToViewport(panel);

        expect(applied.height).toBe(800);
        expect(panel.style.height).toBe('800px');
    });

    test('a panel that fits is not touched at all', () => {
        const panel = panelAt({ left: 30, top: 40, width: 300, height: 400 });

        expect(clampPanelToViewport(panel)).toBe(null);
        expect(panel.style.left).toBe('30px');
        expect(panel.style.width).toBe('300px');
    });

    test('a centred panel is left to its transform', () => {
        // `left: 50%` with a translate(-50%) is a different coordinate system;
        // writing a measured left back onto one shifts it by half its width
        const panel = panelAt({ left: 320, top: 80, width: 380, height: 500 });
        panel.style.transform = 'translate(-50%, -50%)';

        expect(clampPanelToViewport(panel)).toBe(null);
    });

    test('a panel positioned inside something else is left to its parent', () => {
        const panel = panelAt({ left: 320, top: 80, width: 380, height: 500 });
        panel.style.position = 'absolute';

        expect(clampPanelToViewport(panel)).toBe(null);
    });

    test('an unmounted panel is not a crash', () => {
        const panel = panelAt({ left: 320, top: 80, width: 380, height: 500 });
        panel.remove();

        expect(clampPanelToViewport(panel)).toBe(null);
    });

    test('restoring a panel that has never been moved still holds it on screen', async () => {
        // Nothing saved, so there is nothing for the old clamp to have run on —
        // and the panel opens at the corner it was written to open at, which on
        // a phone is off the side
        const panel = panelAt({ left: 320, top: 80, width: 380, height: 500 });

        await restoreGeometry(panel, 'neverMoved', { width: 200, height: 80 });

        expect(panel.style.left).toBe('20px');
    });

    test('restoring a desktop position onto a phone lands the whole panel on it', async () => {
        await saveGeometry('desk', { left: 900, top: 60, width: 720, height: 560 });
        const panel = panelAt({ left: 900, top: 60, width: 720, height: 560 });

        await restoreGeometry(panel, 'desk', { width: 420, height: 200 });

        expect(panel.style.width).toBe('400px');
        expect(parseFloat(panel.style.left)).toBe(0);
    });

    test('a panel grabbed while the read was in flight keeps where the drag left it', async () => {
        // A wide window, so nothing here is the viewport clamp's doing
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        await saveGeometry('slow', { left: 900, top: 60, width: 500, height: 300 });
        _resetCaches();

        const panel = panelAt({ left: 900, top: 60, width: 500, height: 300 });

        // Not awaited, exactly as every panel shell calls it — the storage read
        // is still outstanding when the user takes hold of the panel
        const restoring = restoreGeometry(panel, 'slow', { width: 200, height: 80 });

        markPanelInteracted(panel);
        panel.style.left = '120px';
        panel.style.top = '400px';
        panel.style.width = '640px';

        await restoring;

        expect(panel.style.left).toBe('120px');
        expect(panel.style.top).toBe('400px');
        expect(panel.style.width).toBe('640px');
    });

    test('an untouched panel is still restored', async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        await saveGeometry('quiet', { left: 900, top: 60, width: 500, height: 300 });
        _resetCaches();

        const panel = panelAt({ left: 20, top: 20, width: 500, height: 300 });
        await restoreGeometry(panel, 'quiet', { width: 200, height: 80 });

        expect(panel.style.left).toBe('900px');
        expect(panel.style.top).toBe('60px');
    });

    test('a panel grabbed on a previous open is restored on the next one', async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        await saveGeometry('again', { left: 700, top: 90, width: 500, height: 300 });
        _resetCaches();

        const panel = panelAt({ left: 20, top: 20, width: 500, height: 300 });
        markPanelInteracted(panel);

        // The count is compared against what it was when *this* call started, so
        // a grab that happened before it does not veto it
        await restoreGeometry(panel, 'again', { width: 200, height: 80 });

        expect(panel.style.left).toBe('700px');
    });
});

describe('whether a panel was open', () => {
    test('nothing stored means it was not', () => {
        return expect(wasOpen('dps')).resolves.toBe(false);
    });

    test('a round trip in both directions', async () => {
        await saveOpenState('dps', true);
        await expect(wasOpen('dps')).resolves.toBe(true);

        await saveOpenState('dps', false);
        await expect(wasOpen('dps')).resolves.toBe(false);
    });

    test('panels do not read each other’s state', async () => {
        await saveOpenState('dps', true);

        await expect(wasOpen('partyLoot')).resolves.toBe(false);
    });
});

describe('forgetting where a panel was but not how big', () => {
    test('the position goes and the size stays', () => {
        // The Treasure popup places itself beside the chest dialog and is only
        // pinned by being moved. Unpinning has to drop the position; dropping
        // the size with it would be a second change nobody asked for.
        return (async () => {
            await saveGeometry('popup', { left: 400, top: 90, width: 320, height: 500 });
            await clearPosition('popup');

            const all = await allGeometry();
            expect(all.popup).toEqual({ width: 320, height: 500 });
        })();
    });

    test('and the open flag survives it', async () => {
        await saveOpenState('popup', true);
        await saveGeometry('popup', { left: 10, top: 10 });
        await clearPosition('popup');

        await expect(wasOpen('popup')).resolves.toBe(true);
    });

    test('a panel with nothing stored is not a problem', () => {
        return expect(clearPosition('never-seen')).resolves.toBeUndefined();
    });
});

describe('reopening at start-up', () => {
    test('a panel left open is reopened', async () => {
        await saveOpenState('dps', true);

        const reopen = vi.fn();
        await reopenIfLeftOpen('dps', reopen);

        expect(reopen).toHaveBeenCalled();
    });

    test('a panel left closed is not', async () => {
        const reopen = vi.fn();
        await reopenIfLeftOpen('neverOpened', reopen);

        expect(reopen).not.toHaveBeenCalled();
    });

    test('it waits for the character before asking', async () => {
        // Panels ask at module scope, long before the websocket says who logged
        // in. Asking then reads the wrong character's key, which comes back
        // empty and looks exactly like "nothing was left open".
        store.settings.panelOpenState_market123 = { dps: true };
        mockDataManager.characterId = null;
        let announce = null;
        mockDataManager.on = (event, handler) => {
            if (event === 'character_initialized') announce = handler;
        };

        const reopen = vi.fn();
        const pending = reopenIfLeftOpen('dps', reopen);
        await Promise.resolve();
        expect(reopen).not.toHaveBeenCalled();

        mockDataManager.characterId = 'market123';
        announce();
        await pending;

        expect(reopen).toHaveBeenCalled();
        mockDataManager.on = () => {};
    });

    test('a panel that throws on reopening does not take the others with it', async () => {
        // These are all fired off at module scope, one after another
        await saveOpenState('dps', true);

        await expect(
            reopenIfLeftOpen('dps', () => {
                throw new Error('no body yet');
            })
        ).resolves.toBeUndefined();
    });
});

describe('the two halves, stored apart', () => {
    test('the geometry is shared and the open flag is not', async () => {
        await saveGeometry('dps', { left: 120, top: 80, width: 400, height: 300 });
        await saveOpenState('dps', true);

        expect(store.settings.panelGeometry.dps).toEqual({ left: 120, top: 80, width: 400, height: 300 });
        expect(store.settings.panelOpenState_market123).toEqual({ dps: true });
    });

    test('a panel dragged on one character is in the same place on the other', async () => {
        await saveGeometry('dps', { left: 120, top: 80, width: 400, height: 300 });

        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';
        document.body.innerHTML = '<div id="panel"></div>';
        await restoreGeometry(document.getElementById('panel'), 'dps');

        expect(document.getElementById('panel').style.left).toBe('120px');
    });
});

describe('open flags left in the old shared record', () => {
    const legacyRecord = () => ({
        dps: { left: 120, top: 80, width: 400, height: 300, open: true },
        partyLoot: { left: 10, top: 10, width: 200, height: 200, open: false },
    });

    test('the main character adopts them', async () => {
        store.settings.panelGeometry = legacyRecord();

        await expect(wasOpen('dps')).resolves.toBe(true);
        await expect(wasOpen('partyLoot')).resolves.toBe(false);
        expect(store.settings.panelOpenState_market123).toEqual({ dps: true, partyLoot: false });
        expect(store.settings.panelOpenState).toBeUndefined();
    });

    test('and the geometry stays behind, shared and intact', async () => {
        store.settings.panelGeometry = legacyRecord();

        await wasOpen('dps');

        expect(store.settings.panelGeometry.dps).toEqual({ left: 120, top: 80, width: 400, height: 300 });
        expect(store.settings.panelGeometry.dps.open).toBeUndefined();
    });

    test('the iron cow starts with everything closed', async () => {
        store.settings.panelGeometry = legacyRecord();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';

        await expect(wasOpen('dps')).resolves.toBe(false);
        expect(store.settings.panelOpenState_iron456).toBeUndefined();
    });

    test('and leaves them for the main character to claim later', async () => {
        store.settings.panelGeometry = legacyRecord();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';
        await wasOpen('dps');

        mockDataManager.characterId = 'market123';
        mockDataManager.gameMode = 'standard';
        await expect(wasOpen('dps')).resolves.toBe(true);
        expect(store.settings.panelOpenState_market123).toEqual({ dps: true, partyLoot: false });
    });

    test('what the iron cow opens is its own', async () => {
        store.settings.panelGeometry = legacyRecord();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';

        await saveOpenState('partyLoot', true);

        expect(store.settings.panelOpenState_iron456).toEqual({ partyLoot: true });
        mockDataManager.characterId = 'market123';
        mockDataManager.gameMode = 'standard';
        await expect(wasOpen('partyLoot')).resolves.toBe(false);
    });
});

/**
 * A character switch during the save.
 *
 * `openFlags()` caches by the key that is current when it starts, and
 * `writeScoped` recomputed the key when it ran, so the two ends of one save
 * could belong to different characters — the open panels of the character
 * whose button was pressed filed under the character who arrived while the
 * flags loaded. Cosmetic, but it is the leak the per-character split exists to
 * close.
 */
describe('a character switch while the open flags load', () => {
    test('the save is refused rather than filed under the arriving character', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            store.settings.panelOpenState_market123 = { partyLoot: true };
            store.settings.panelOpenState_iron456 = { dps: false };

            const pending = saveOpenState('dps', true);
            mockDataManager.characterId = 'iron456';
            mockDataManager.gameMode = 'ironcow';
            await pending;

            // The iron cow never opened the DPS panel and must not be told it did
            expect(store.settings.panelOpenState_iron456).toEqual({ dps: false });
            expect(store.settings.panelOpenState_market123).toEqual({ partyLoot: true });
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('a save with no switch behind it still lands under the current character', async () => {
        await saveOpenState('dps', true);

        expect(store.settings.panelOpenState_market123).toEqual({ dps: true });
    });
});
