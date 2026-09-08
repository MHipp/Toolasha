/**
 * @vitest-environment happy-dom
 *
 * A frame that is not JSON must cost exactly that frame.
 *
 * The `MessageEvent.prototype.data` hook runs `processMessage` inside the
 * getter and returns the value the *game* then reads, so anything thrown in
 * there is thrown out of the game's own `event.data` — our parsing breaking
 * the game rather than only ourselves. These tests drive the real installed
 * getter (happy-dom's MessageEvent has no `data` accessor to wrap, so the hook
 * is installed against a stand-in prototype exposed as `unsafeWindow`).
 */

import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('./profile-manager.js', () => ({ setCurrentProfile: vi.fn() }));
vi.mock('./storage.js', () => ({
    default: { getJSON: vi.fn(async () => []), setJSON: vi.fn(async () => {}) },
}));

/** Stands in for the page's MessageEvent: a prototype `data` accessor to wrap. */
class FakeMessageEvent {
    constructor(data, currentTarget) {
        this._data = data;
        this.currentTarget = currentTarget;
    }
}
Object.defineProperty(FakeMessageEvent.prototype, 'data', {
    configurable: true,
    get() {
        return this._data;
    },
});

globalThis.unsafeWindow = { MessageEvent: FakeMessageEvent };

const { default: webSocketHook } = await import('./websocket.js');

webSocketHook.install();

/** A game connection whose listeners are never dispatched — only the getter path runs. */
function gameSocket() {
    return { url: 'wss://api.milkywayidle.com/ws', addEventListener() {}, send() {} };
}

let errorSpy;

beforeEach(() => {
    webSocketHook.messageHandlers.clear();
    webSocketHook.processedMessages.clear();
    webSocketHook.recentActionCompleted.clear();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
    delete globalThis.unsafeWindow;
});

describe('a frame that is not JSON', () => {
    test.each([
        ['a binary frame', new Uint8Array([1, 2, 3])],
        ['an empty string keep-alive', ''],
        ['a truncated payload', '{"type":"action_com'],
        ['plain text', 'pong'],
    ])('%s reaches the game unchanged and reaches no handler', (_label, frame) => {
        const handler = vi.fn();
        const wildcard = vi.fn();
        webSocketHook.on('action_completed', handler);
        webSocketHook.on('*', wildcard);

        const event = new FakeMessageEvent(frame, gameSocket());

        // The game's own read: it must produce the frame, not throw
        expect(() => event.data).not.toThrow();
        expect(event.data).toBe(frame);
        expect(handler).not.toHaveBeenCalled();
        expect(wildcard).not.toHaveBeenCalled();
    });

    test('does not stop the next JSON frame from being delivered', () => {
        const handler = vi.fn();
        webSocketHook.on('action_completed', handler);
        const socket = gameSocket();

        void new FakeMessageEvent(new Uint8Array([0]), socket).data;
        void new FakeMessageEvent('', socket).data;

        const good = new FakeMessageEvent(JSON.stringify({ type: 'action_completed', endCharacterAction: {} }), socket);
        expect(good.data).toBe(good._data);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].type).toBe('action_completed');
    });

    test('a handler that throws costs only that handler, not the game\u2019s data read', () => {
        const thrower = vi.fn(() => {
            throw new Error('handler exploded');
        });
        const after = vi.fn();
        webSocketHook.on('action_completed', thrower);
        webSocketHook.on('action_completed', after);

        const event = new FakeMessageEvent(JSON.stringify({ type: 'action_completed' }), gameSocket());
        expect(() => event.data).not.toThrow();
        expect(after).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();
    });
});
