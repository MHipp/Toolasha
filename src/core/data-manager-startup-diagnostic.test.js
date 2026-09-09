/**
 * Tests for the startup diagnostic that fires when no character payload arrives.
 *
 * `init_character_data` is sent once, right after the socket opens, and nothing
 * replays it. A hook installed a moment late misses it and then delivers every
 * later message perfectly — so "no character data" has two very different
 * causes, and the diagnostic has to say which one it is.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const hookMock = vi.hoisted(() => ({
    handlers: new Map(),
    messagesSeen: 0,
}));

vi.mock('./websocket.js', () => ({
    default: {
        on: vi.fn((event, handler) => {
            hookMock.handlers.set(event, handler);
        }),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
        get messagesSeen() {
            return hookMock.messagesSeen;
        },
    },
}));

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn(async (_key, _store, fallback) => fallback),
        setJSON: vi.fn(async () => true),
        get: vi.fn(async (_key, _store, fallback = null) => fallback),
        set: vi.fn(async () => true),
        flushAll: vi.fn(async () => true),
    },
}));

const { default: dataManager } = await import('./data-manager.js');

/** The 30-second fallback poll: 60 ticks of 500 ms. */
const FALLBACK_WINDOW_MS = 30_000;

const HOOK_FAILURE_TEXT = 'WebSocket hook may have failed';

let errors = [];
let toastCalls = [];

/** Every console.error emitted so far, joined, for substring assertions. */
const errorText = () => errors.join('\n');

beforeEach(() => {
    vi.useFakeTimers();
    errors = [];
    toastCalls = [];
    hookMock.messagesSeen = 0;

    vi.spyOn(console, 'error').mockImplementation((...args) => {
        errors.push(args.map((a) => String(a)).join(' '));
    });

    window.Toolasha = {
        Utils: {
            toast: {
                showToast: vi.fn((message, options) => {
                    const call = { message, options, dismissed: false };
                    toastCalls.push(call);
                    return {
                        element: document.createElement('div'),
                        dismiss: () => {
                            call.dismissed = true;
                        },
                    };
                }),
            },
        },
    };

    dataManager.cleanupIntervals();
    dataManager.characterData = null;
    dataManager.missedCharacterDataPrompt = null;
});

afterEach(() => {
    dataManager.cleanupIntervals();
    dataManager.missedCharacterDataPrompt = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete window.Toolasha;
});

describe('missing character data diagnostic', () => {
    test('messages flowing but no character payload blames the missed one-shot, not the hook', () => {
        hookMock.messagesSeen = 27;

        dataManager.initialize();
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        const text = errorText();
        expect(text).toContain('27 other WebSocket messages have arrived');
        expect(text).toContain('the hook is working');
        expect(text).toContain('Reload the page to recover');
        expect(text).not.toContain(HOOK_FAILURE_TEXT);
    });

    test('no messages at all keeps the original hook-failure wording', () => {
        hookMock.messagesSeen = 0;

        dataManager.initialize();
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        expect(errorText()).toContain(
            '[DataManager] Character data not received after 30 seconds. WebSocket hook may have failed.'
        );
        expect(toastCalls).toHaveLength(0);
    });

    test('character data arriving normally warns about nothing', () => {
        hookMock.messagesSeen = 12;

        dataManager.initialize();
        vi.advanceTimersByTime(2_000);
        dataManager.characterData = { character: { id: 30404 } };
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        const text = errorText();
        expect(text).not.toContain('Character data not received');
        expect(text).not.toContain(HOOK_FAILURE_TEXT);
        expect(toastCalls).toHaveLength(0);
    });
});

describe('recovery offer', () => {
    test('offers a reload the player has to accept, and offers it once', () => {
        hookMock.messagesSeen = 27;

        dataManager.initialize();
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        expect(toastCalls).toHaveLength(1);
        expect(toastCalls[0].message).toContain('reload the page');
        // Sticks around until acted on, rather than vanishing after a few seconds
        expect(toastCalls[0].options.duration).toBe(0);
        expect(typeof toastCalls[0].options.action.onClick).toBe('function');

        // Nothing reloads on its own: the offer is inert until clicked
        expect(window.location.href).toBeTruthy();

        // The poll is stopped at the same moment, so no second offer can appear
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS * 2);
        expect(toastCalls).toHaveLength(1);
    });

    test('a late genuine init_character_data takes the offer back', () => {
        hookMock.messagesSeen = 27;

        dataManager.initialize();
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);
        expect(toastCalls).toHaveLength(1);
        expect(toastCalls[0].dismissed).toBe(false);

        const handler = hookMock.handlers.get('init_character_data');
        expect(typeof handler).toBe('function');
        handler({ type: 'init_character_data', character: { id: 30404, name: 'Test' } }, { socket: {} });

        expect(toastCalls[0].dismissed).toBe(true);
        expect(dataManager.missedCharacterDataPrompt).toBeNull();
    });

    test('a page where the game never connects neither warns wrongly nor throws', () => {
        hookMock.messagesSeen = 0;
        delete window.Toolasha;

        expect(() => {
            dataManager.initialize();
            vi.advanceTimersByTime(FALLBACK_WINDOW_MS);
        }).not.toThrow();

        expect(errorText()).toContain(HOOK_FAILURE_TEXT);
    });

    test('no Utils bundle on the page degrades to the console message alone', () => {
        hookMock.messagesSeen = 5;
        delete window.Toolasha;

        expect(() => {
            dataManager.initialize();
            vi.advanceTimersByTime(FALLBACK_WINDOW_MS);
        }).not.toThrow();

        expect(errorText()).toContain('the hook is working');
        expect(toastCalls).toHaveLength(0);
    });
});
