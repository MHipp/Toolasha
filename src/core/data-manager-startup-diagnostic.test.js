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
    attachedAfterSocketOpen: false,
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
        get attachedAfterSocketOpen() {
            return hookMock.attachedAfterSocketOpen;
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

/** The evidenced-miss path: 10 ticks of 500 ms. */
const EARLY_WINDOW_MS = 5_000;

const HOOK_FAILURE_TEXT = 'WebSocket hook may have failed';

/** Matches the session key data-manager guards the automatic reload with. */
const RELOAD_GUARD_KEY = 'toolasha.missedCharacterData.autoReloaded';

let errors = [];
let toastCalls = [];
let reloads = 0;

/** Every console.error emitted so far, joined, for substring assertions. */
const errorText = () => errors.join('\n');

beforeEach(() => {
    vi.useFakeTimers();
    errors = [];
    toastCalls = [];
    reloads = 0;
    hookMock.messagesSeen = 0;
    hookMock.attachedAfterSocketOpen = false;

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

    // Never navigate the test environment; count instead.
    vi.spyOn(dataManager, '_performReload').mockImplementation(() => {
        reloads += 1;
    });

    try {
        window.sessionStorage.clear();
    } catch {
        // A happy-dom without session storage is not what these tests are about
    }

    dataManager.cleanupIntervals();
    dataManager.characterData = null;
    dataManager.missedCharacterDataPrompt = null;
    dataManager._missedCharacterDataReported = false;
    dataManager._pageInteracted = false;
    dataManager._interactionWatchInstalled = false;
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

    test('an unproven miss is offered, never taken automatically', () => {
        hookMock.messagesSeen = 27;
        hookMock.attachedAfterSocketOpen = false;

        dataManager.initialize();
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('Automatic recovery was not attempted');
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

/**
 * The recovery itself.
 *
 * The failure this covers was watched live twice: the script logged the
 * diagnostic above and then sat dead until a manual reload. What was missing was
 * an attempt to get the data back — and there is no way to get it back, because
 * the payload is server state pushed once per connection and nothing on the
 * client keeps a copy. The only thing that makes the server send it again is a
 * new socket, and the safest way to get one is the reload the player would have
 * done by hand.
 *
 * So the interesting properties are not "does it recover" but "does it recover
 * only when it is allowed to, and never more than once".
 */
describe('automatic recovery from a proven missed payload', () => {
    /** The live failure: frames arriving through a hook that attached too late. */
    const enterProvenMissedState = () => {
        hookMock.messagesSeen = 14;
        hookMock.attachedAfterSocketOpen = true;
    };

    test('the miss is proven and reloaded within five seconds, not thirty', () => {
        enterProvenMissedState();

        dataManager.initialize();

        // Nothing has happened yet: the socket that opened during our own
        // startup still gets its chance to deliver a late payload
        vi.advanceTimersByTime(EARLY_WINDOW_MS - 500);
        expect(reloads).toBe(0);

        vi.advanceTimersByTime(500);

        expect(reloads).toBe(1);
        const text = errorText();
        expect(text).toContain('attached to a game socket that was already open');
        expect(text).toContain('14 later messages');
        expect(text).toContain('Recovering');
        // The player is not asked to do what has already been done for them
        expect(toastCalls).toHaveLength(0);
    });

    test('recovery runs once and cannot loop within a page', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(reloads).toBe(1);

        // The poll is stopped at the same moment, so no later tick can fire a
        // second reload however long the page stays in the broken state
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS * 4);
        expect(reloads).toBe(1);
        expect(toastCalls).toHaveLength(0);
    });

    test('recovery cannot loop across reloads: the second time it asks instead', () => {
        enterProvenMissedState();

        // Standing in for the page that has just come back from the automatic
        // reload and landed in the same state again
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('already reloaded once for the same failure');

        vi.advanceTimersByTime(FALLBACK_WINDOW_MS * 2);
        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
    });

    test('the guard is written before the reload, so the page that comes back is guarded', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(reloads).toBe(1);
        expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe('1');
    });

    test('a page the player has already started using is offered the reload, not reloaded', () => {
        enterProvenMissedState();

        dataManager.initialize();
        window.dispatchEvent(new Event('keydown'));

        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('already started using this page');
        // Nothing was thrown away silently: the guard is untouched, so a later
        // page can still take its automatic reload
        expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
    });

    test('session storage refusing the guard means no reload at all', () => {
        enterProvenMissedState();

        // happy-dom's Storage is a Proxy whose set trap stores an *item* rather
        // than replacing a method, so the whole object is swapped instead — and
        // put back by hand, since restoreAllMocks cannot see through the proxy
        // either.
        const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
        Object.defineProperty(window, 'sessionStorage', {
            configurable: true,
            get: () => ({
                getItem: () => null,
                setItem: () => {
                    throw new Error('site data blocked');
                },
            }),
        });

        try {
            dataManager.initialize();
            vi.advanceTimersByTime(EARLY_WINDOW_MS);
        } finally {
            Object.defineProperty(window, 'sessionStorage', descriptor);
        }

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('Could not record the recovery reload');
    });

    test('a payload that arrives inside the window cancels the whole thing', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(2_000);
        dataManager.characterData = { character: { id: 30404 } };
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(0);
        expect(errorText()).not.toContain('already open');
    });

    test('a hook that never delivered anything is not a missed payload and never reloads', () => {
        hookMock.messagesSeen = 0;
        hookMock.attachedAfterSocketOpen = true;

        dataManager.initialize();
        vi.advanceTimersByTime(FALLBACK_WINDOW_MS);

        expect(reloads).toBe(0);
        expect(errorText()).toContain(HOOK_FAILURE_TEXT);
    });

    test('when recovery falls back to the offer, the diagnostic still says everything', () => {
        enterProvenMissedState();
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        const text = errorText();
        // What went wrong
        expect(text).toContain('init_character_data is sent once');
        expect(text).toContain('nothing replays it');
        // That recovery was tried, and why it stopped
        expect(text).toContain('Recovery attempted');
        expect(text).toContain('already reloaded once for the same failure');
        // And what the player can do
        expect(toastCalls[0].message).toContain('reload the page');
        expect(toastCalls[0].options.duration).toBe(0);
    });

    test('the offered reload goes through the same one place as the automatic one', () => {
        enterProvenMissedState();
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(reloads).toBe(0);
        toastCalls[0].options.action.onClick();
        expect(reloads).toBe(1);
    });
});
