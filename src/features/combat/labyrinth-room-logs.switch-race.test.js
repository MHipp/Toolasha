/**
 * @vitest-environment happy-dom
 *
 * A character switch tearing the room log down while its initialize() is parked
 * on the stored log's read.
 *
 * `isInitialized` is set *before* that read, so the switch's own re-initialise
 * never early-returned — the interrupted call simply resumed after `disable()`
 * had unhooked every socket handler, dropped both DOM-observer subscriptions
 * and cleared the capture timer, and re-stored its own handles into the very
 * fields the teardown had nulled. The previous set stayed live with nothing
 * left to remove it by: one leak per switch, and each leaked set files a second
 * `labFightRecorder.noteAttempt()` and a second helping of room experience for
 * the same room — a corrupted clear-rate calibration pool feeding the sim's own
 * accuracy math, and XP/hr figures reading double.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    /** Held open to park initialize() inside the record read */
    gate: null,
    characterId: 'char1',
}));

/** Every live websocket handler, by message type, so leaks are countable. */
const socket = vi.hoisted(() => ({ handlers: {} }));
/** How many DOM-observer subscriptions are open, and how many were dropped. */
const observers = vi.hoisted(() => ({ registered: 0, unregistered: 0 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'labyrinthRoomLogs',
        getSettingValue: (_key, fallback) => fallback,
        Z_FLOATING_PANEL: 1100,
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            (socket.handlers[type] ??= []).push(handler);
        },
        off: (type, handler) => {
            socket.handlers[type] = (socket.handlers[type] || []).filter((h) => h !== handler);
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => {
    const subscribe = () => {
        observers.registered += 1;
        return () => {
            observers.unregistered += 1;
        };
    };
    return { default: { onClass: subscribe, onReady: subscribe } };
});
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => null,
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        characterData: null,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback = null) => fallback,
        getJSON: async () => null,
        setJSON: async () => {},
        tryGet: async () => {
            // The read the switch lands inside
            if (world.gate) await world.gate;
            return { found: false, value: null };
        },
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('./labyrinth-fight-recorder.js', () => ({
    default: {
        load: async () => {},
        forget: () => {},
        noteAttempt: () => {},
        recordedAttempts: () => [],
        recordingStatus: () => ({ recording: false }),
        downloadRecording: () => false,
    },
}));
vi.mock('./labyrinth-tick-capture.js', () => ({
    default: {
        captureStatus: () => ({ capturing: false, ticks: 0, seconds: 0, duplicatesDiscarded: 0, savedAt: null }),
        isCapturing: () => false,
        startCapture: () => {},
        stopCapture: () => {},
        clearCapture: () => {},
        captureFile: () => ({ ticks: [] }),
    },
}));

const { labyrinthRoomLogs } = await import('./labyrinth-room-logs.js');

const liveCount = (type) => (socket.handlers[type] || []).length;
/** Every message type the tail hooks, including the three experience ones */
const HOOKED = [
    'labyrinth_room_progress',
    'labyrinth_updated',
    'battle_updated',
    'new_battle',
    'action_completed',
    'skills_updated',
];

describe('a character switch landing inside the room log read', () => {
    beforeEach(async () => {
        world.gate = null;
        world.characterId = 'char1';
        await labyrinthRoomLogs.disable();
        socket.handlers = {};
        observers.registered = 0;
        observers.unregistered = 0;
    });

    afterEach(async () => {
        world.gate = null;
        await labyrinthRoomLogs.disable();
    });

    /**
     * Start an initialize() whose read is held open, tear the log down inside
     * it the way `disableAllFeatures()` does, then let the read land.
     * @returns {Promise<void>} Resolves once the interrupted initialize() has finished
     */
    async function switchDuringInitialize() {
        let release;
        world.gate = new Promise((resolve) => {
            release = resolve;
        });
        const pending = labyrinthRoomLogs.initialize();
        // `character_switching` — the feature layer comes down mid-read
        await labyrinthRoomLogs.disable();
        // …and the arriving character is current before the read resolves
        world.characterId = 'char2';
        release();
        world.gate = null;
        await pending;
    }

    test('the interrupted initialize registers nothing on the way out', async () => {
        await switchDuringInitialize();

        for (const type of HOOKED) expect(liveCount(type)).toBe(0);
        expect(observers.registered).toBe(0);
        expect(labyrinthRoomLogs.captureRefreshTimer).toBeFalsy();
        expect(labyrinthRoomLogs.isInitialized).toBe(false);
    });

    test('a run of interrupted switches leaves nothing behind for the character that arrives', async () => {
        for (let i = 0; i < 3; i++) await switchDuringInitialize();
        // The switch's own re-initialise, which the flag never blocked
        await labyrinthRoomLogs.initialize();

        // Exactly one handler each — a second `new_battle` handler is a second
        // recorded attempt in the calibration pool, a second `skills_updated`
        // handler is the room's experience counted twice
        for (const type of HOOKED) {
            if (type === 'labyrinth_updated') continue;
            expect(liveCount(type)).toBe(1);
        }
        // …hooked twice on purpose: the room watcher and the experience absorber
        expect(liveCount('labyrinth_updated')).toBe(2);
        expect(observers.registered - observers.unregistered).toBe(2);
        expect(labyrinthRoomLogs.captureRefreshTimer).toBeTruthy();

        // …and that one set is the one the teardown can remove
        await labyrinthRoomLogs.disable();
        for (const type of HOOKED) expect(liveCount(type)).toBe(0);
        expect(observers.registered - observers.unregistered).toBe(0);
        expect(labyrinthRoomLogs.captureRefreshTimer).toBeFalsy();
    });
});
