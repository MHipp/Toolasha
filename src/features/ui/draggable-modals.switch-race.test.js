/** @vitest-environment happy-dom
 *
 * A character switch tearing the feature down while its initialize() is parked
 * on the stored-positions read.
 *
 * `initialized` is set after that read, so a late assignment writes `true` over
 * the teardown that cleared it. `domObserver` is a singleton that a switch does
 * not tear down, so the orphaned registration keeps firing and the feature is
 * not dead — the damage is instead:
 *
 * - the flag disagrees with the teardown, so a `disable()` the registry has
 *   already accounted for (the user turning the setting off mid-read) leaves
 *   the feature running with the registry believing it is off, and
 * - `unregisterObserver` holds only the LAST registration, so two switches
 *   landing inside overlapping reads orphan one observer permanently — nothing
 *   can ever unregister it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    // Set to a promise to hold the positions read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

const observerMock = vi.hoisted(() => ({ live: 0, callback: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            observerMock.live += 1;
            observerMock.callback = callback;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                observerMock.live -= 1;
                observerMock.callback = null;
            };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => {
            if (storageMock.gate) await storageMock.gate;
            return key in storageMock.stored ? storageMock.stored[key] : fallback;
        },
        set: async (key, value) => {
            storageMock.stored[key] = value;
            return true;
        },
    },
}));

const { default: draggableModalsFeature, draggableModals } = await import('./draggable-modals.js');

/** @returns {HTMLElement} A Modal_modalContent element inside its Modal_modal box */
function makeModal() {
    const box = document.createElement('div');
    box.className = 'Modal_modal__abc';
    const content = document.createElement('div');
    content.className = 'Modal_modalContent__xyz';
    const heading = document.createElement('h2');
    heading.textContent = 'Settings';
    content.appendChild(heading);
    box.appendChild(content);
    document.body.appendChild(box);
    return content;
}

describe('a character switch landing inside the stored-positions read', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        draggableModalsFeature.cleanup();
        observerMock.live = 0;
        observerMock.callback = null;
        document.body.innerHTML = '';
    });

    /**
     * Start an initialize() whose read is held open, tear the feature down
     * inside it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = draggableModalsFeature.initialize();
        // `character_switching` — the whole feature layer comes down while the
        // read is still out
        draggableModalsFeature.cleanup();
        // …and the arriving character is current before the read resolves
        dataManagerMock.characterId = 'char2';
        release();
        storageMock.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing and leaves the guard flag clear', async () => {
        await switchDuringInitialize();

        expect(observerMock.live).toBe(0);
        expect(draggableModals.initialized).toBe(false);
        // The observer is the whole feature — a modal opening now gets no drag bar
        expect(document.querySelector('.mwi-drag-bar')).toBeNull();
    });

    test('two switches inside overlapping reads leave exactly one live, working observer', async () => {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });
        const first = draggableModalsFeature.initialize();
        draggableModalsFeature.cleanup(); // `character_switching`
        dataManagerMock.characterId = 'char2';
        // `character_switched` re-initialise, parked on the read in its turn
        const second = draggableModalsFeature.initialize();
        draggableModalsFeature.cleanup(); // and a second switch lands inside it
        dataManagerMock.characterId = 'char3';
        release();
        storageMock.gate = null;
        await Promise.all([first, second]);

        // The second switch's own re-initialise, which is the only registration
        // that should survive
        await draggableModalsFeature.initialize();

        expect(draggableModals.initialized).toBe(true);
        // Not two: `unregisterObserver` holds one handle, so a second live
        // registration could never be released
        expect(observerMock.live).toBe(1);

        observerMock.callback(makeModal());
        expect(document.querySelectorAll('.mwi-drag-bar').length).toBe(1);

        draggableModalsFeature.cleanup();
        expect(observerMock.live).toBe(0);
    });
});
