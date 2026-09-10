/**
 * Tests for the cheap half of the missed-payload recovery: closing the game
 * socket so the client reconnects, and only reloading when that fails.
 *
 * `init_character_data` is server state pushed once per connection. A reload
 * gets a fresh connection and therefore a fresh copy — but it throws away
 * everything the tab holds. A close does not: the client opens a new socket on
 * its own, the server sends the payload down it, and the player loses nothing.
 *
 * The close is unproven in one respect (a client that does not reconnect would
 * be left with no socket at all), so the reload it replaces is kept behind it
 * as a fallback with every gate it has today.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const hookMock = vi.hoisted(() => ({
    handlers: new Map(),
    messagesSeen: 0,
    attachedAfterSocketOpen: false,
    /** Whether there is a live game socket the hook could close. */
    hasSocket: true,
    /** Every close the recovery asked for. */
    closes: 0,
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
        closeActiveGameSocket: vi.fn(() => {
            if (!hookMock.hasSocket) return false;
            hookMock.closes += 1;
            return true;
        }),
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

/** The evidenced-miss path: 10 ticks of the 500 ms poll. */
const EARLY_WINDOW_MS = 5_000;

/** How long the reconnect is given before the reload takes over. */
const RECONNECT_WINDOW_MS = 8_000;

/** Matches the session key data-manager guards the automatic reload with. */
const RELOAD_GUARD_KEY = 'toolasha.missedCharacterData.autoReloaded';

/** Matches the session key data-manager guards the recovery close with. */
const CLOSE_GUARD_KEY = 'toolasha.missedCharacterData.socketClosed';

let errors = [];
let logs = [];
let toastCalls = [];
let reloads = 0;

const errorText = () => errors.join('\n');
const logText = () => logs.join('\n');

/** The live failure: frames arriving through a hook that attached too late. */
const enterProvenMissedState = () => {
    hookMock.messagesSeen = 14;
    hookMock.attachedAfterSocketOpen = true;
};

beforeEach(() => {
    vi.useFakeTimers();
    errors = [];
    logs = [];
    toastCalls = [];
    reloads = 0;
    hookMock.messagesSeen = 0;
    hookMock.attachedAfterSocketOpen = false;
    hookMock.hasSocket = true;
    hookMock.closes = 0;

    vi.spyOn(console, 'error').mockImplementation((...args) => {
        errors.push(args.map((a) => String(a)).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...args) => {
        logs.push(args.map((a) => String(a)).join(' '));
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

    vi.spyOn(dataManager, '_performReload').mockImplementation(() => {
        reloads += 1;
    });

    try {
        window.sessionStorage.clear();
        window.localStorage.clear();
    } catch {
        // A happy-dom without session storage is not what these tests are about
    }

    dataManager.cleanupIntervals();
    dataManager.characterData = null;
    dataManager.missedCharacterDataPrompt = null;
    dataManager._missedCharacterDataReported = false;
    dataManager._pageInteracted = false;
    dataManager._interactionWatchInstalled = false;
    dataManager._reconnectRecoveryAttempted = false;
});

afterEach(() => {
    dataManager.cleanupIntervals();
    dataManager.missedCharacterDataPrompt = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete window.Toolasha;
});

describe('the socket close comes first', () => {
    test('a proven miss closes the socket instead of reloading straight away', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(hookMock.closes).toBe(1);
        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(0);
        expect(errorText()).toContain('closing the game socket');
    });

    test('the payload coming back through the reconnect ends the recovery, with no reload', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(hookMock.closes).toBe(1);

        // What the reconnect delivers: a fresh init_character_data
        dataManager.characterData = { character: { id: 30404 } };
        vi.advanceTimersByTime(RECONNECT_WINDOW_MS * 4);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(0);
        expect(logText()).toContain('reconnected');
    });

    test('nothing coming back falls through to the reload once the window is up', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(reloads).toBe(0);

        // Still inside the window: the reconnect is given its full chance
        vi.advanceTimersByTime(RECONNECT_WINDOW_MS - 1);
        expect(reloads).toBe(0);

        vi.advanceTimersByTime(1);
        expect(reloads).toBe(1);
        expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe('1');
        expect(errorText()).toContain('did not produce');
    });

    test('the close happens once per page, however long the page stays broken', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(hookMock.closes).toBe(1);

        vi.advanceTimersByTime(RECONNECT_WINDOW_MS * 10);

        expect(hookMock.closes).toBe(1);
        expect(reloads).toBe(1);
    });

    test('a tab that has already closed a socket for this failure goes straight to the reload', () => {
        enterProvenMissedState();
        window.sessionStorage.setItem(CLOSE_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(hookMock.closes).toBe(0);
        expect(reloads).toBe(1);
    });

    test('the close is recorded before it is taken, so a second one cannot slip in', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(window.sessionStorage.getItem(CLOSE_GUARD_KEY)).toBe('1');
    });

    test('a host with no socket to close falls straight through to the reload it ships today', () => {
        enterProvenMissedState();
        hookMock.hasSocket = false;

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(hookMock.closes).toBe(0);
        expect(reloads).toBe(1);
        expect(errorText()).toContain('Recovering: reloading the page once');
    });
});

describe('the close is gated exactly as the reload is', () => {
    test('the setting turned off closes nothing and asks instead', () => {
        enterProvenMissedState();
        dataManager.rememberAutoReloadPreference(false);

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS + RECONNECT_WINDOW_MS);

        expect(hookMock.closes).toBe(0);
        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('turned off in the settings');
        // Neither half of the recovery was spent
        expect(window.sessionStorage.getItem(CLOSE_GUARD_KEY)).toBeNull();
        expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
    });

    test('the setting turned on closes the socket and keeps the reload behind it', () => {
        enterProvenMissedState();
        dataManager.rememberAutoReloadPreference(true);

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(hookMock.closes).toBe(1);

        vi.advanceTimersByTime(RECONNECT_WINDOW_MS);
        expect(reloads).toBe(1);
    });

    test('a page the player has started using is never closed out from under them', () => {
        enterProvenMissedState();

        dataManager.initialize();
        window.dispatchEvent(new Event('keydown'));
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(hookMock.closes).toBe(0);
        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('already started using this page');
    });

    test('a tab that has already spent its reload still gets the close', () => {
        // The reload was tried and the tab came back into the same failure, so
        // the expensive recovery is known not to work here. The cheap one has
        // not been tried and cannot loop — it has its own mark. Refusing it
        // left the player being offered the reload that had just failed them.
        enterProvenMissedState();
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);

        expect(hookMock.closes).toBe(1);
        expect(reloads).toBe(0);
    });

    test('with the reload spent and the reconnect working, nothing else happens', () => {
        enterProvenMissedState();
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(hookMock.closes).toBe(1);

        // What the reconnect delivers: a fresh init_character_data
        dataManager.characterData = { character: { id: 30404 } };
        vi.advanceTimersByTime(RECONNECT_WINDOW_MS * 2);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(0);
    });

    test('with the reload spent and the reconnect failing, the toast is offered not the reload', () => {
        enterProvenMissedState();
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1');

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(hookMock.closes).toBe(1);

        // No payload arrives. The reload guard is spent, so the fallback cannot
        // reload either — the player is asked rather than looped.
        vi.advanceTimersByTime(RECONNECT_WINDOW_MS + 1000);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        expect(errorText()).toContain('already reloaded once');
    });

    test('an unproven miss neither closes nor reloads', () => {
        hookMock.messagesSeen = 27;
        hookMock.attachedAfterSocketOpen = false;

        dataManager.initialize();
        vi.advanceTimersByTime(30_000 + RECONNECT_WINDOW_MS);

        expect(hookMock.closes).toBe(0);
        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
    });
});

describe('when the reconnect silently fails', () => {
    test('a page interacted with during the window is offered the reload, not reloaded', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        expect(hookMock.closes).toBe(1);

        // The player comes back to the tab while the reconnect is being waited on
        window.dispatchEvent(new Event('keydown'));
        vi.advanceTimersByTime(RECONNECT_WINDOW_MS);

        expect(reloads).toBe(0);
        expect(toastCalls).toHaveLength(1);
        // The socket is gone, so the old "the game itself is unaffected" line
        // would no longer be true
        expect(toastCalls[0].message).not.toContain('The game itself is unaffected');
        expect(toastCalls[0].options.duration).toBe(0);
        expect(typeof toastCalls[0].options.action.onClick).toBe('function');
    });

    test('the offer made after a failed reconnect still reloads when taken', () => {
        enterProvenMissedState();

        dataManager.initialize();
        vi.advanceTimersByTime(EARLY_WINDOW_MS);
        window.dispatchEvent(new Event('keydown'));
        vi.advanceTimersByTime(RECONNECT_WINDOW_MS);

        toastCalls[0].options.action.onClick();
        expect(reloads).toBe(1);
    });
});
