/** @vitest-environment happy-dom
 *
 * The pop-out chat window is a separate self-contained document (window.open with its own
 * inline <script>), so its runtime can't be imported and unit-tested directly. What we can
 * check from here is what PopOutChat._buildPopoutHTML() produces: that the clickable-name
 * behavior reuses chat-profile-link.js's exact ANNOUNCE_RE/VALID_NAME_RE (not a hand
 * duplicated copy), that the supporting CSS/JS made it into the template, and that the
 * interpolation didn't produce broken JavaScript.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, def) => def },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterName: () => 'Tester' } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
const blockState = vi.hoisted(() => ({ blockedNames: new Set() }));
vi.mock('./chat-block-list.js', () => ({
    chatBlockList: { isBlocked: (name) => blockState.blockedNames.has(name) },
}));

const viewportState = vi.hoisted(() => ({ stop: null, calls: [] }));
vi.mock('../../utils/visual-viewport.js', () => ({
    initVisualViewportTracking: (options) => {
        viewportState.calls.push(options);
        viewportState.stop = vi.fn();
        return viewportState.stop;
    },
}));

const { PopOutChat, buildPopoutWindowFeatures, POPOUT_GEOMETRY_KEY } = await import('./pop-out-chat.js');
const { ANNOUNCE_RE, KICK_RE, PARTY_RE, UPGRADE_RE, VALID_NAME_RE, getProfileLinkNames } =
    await import('./chat-profile-link.js');

describe('pop-out chat window: clickable names', () => {
    test('embeds the exact ANNOUNCE_RE and VALID_NAME_RE from chat-profile-link.js', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        expect(html).toContain(`const ANNOUNCE_RE = ${ANNOUNCE_RE};`);
        expect(html).toContain(`const VALID_NAME_RE = ${VALID_NAME_RE};`);
    });

    test('embeds the kick/upgrade/party regexes and the shared getProfileLinkNames logic (not a duplicate)', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        expect(html).toContain(`const KICK_RE = ${KICK_RE};`);
        expect(html).toContain(`const UPGRADE_RE = ${UPGRADE_RE};`);
        expect(html).toContain(`const PARTY_RE = ${PARTY_RE};`);
        expect(html).toContain(`const getProfileLinkNames = ${getProfileLinkNames.toString()};`);
        // The two-name kick case is wrapped by the shared announcement-linkifier
        expect(html).toContain('function appendAnnouncementText(textEl, text, paneObj)');
    });

    test('wires up the clickable-name CSS and the shared fill helper', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        expect(html).toContain('.msg-name-link');
        expect(html).toContain('function fillProfileCommand(paneObj, name)');
        // Both the regular sender name and the system-announcement name reuse the helper
        expect(html).toContain('fillProfileCommand(paneObj, msg.sName)');
    });

    test("carries its own select-option contrast rule — the game page's injected one cannot reach this document", () => {
        const html = new PopOutChat()._buildPopoutHTML();
        // The selects carry the shared class, but this window is its own
        // document: without a local rule, Firefox's native dropdown popup
        // still renders their options light-on-white
        expect(html).toContain('toolasha-select');
        expect(html).toMatch(/\.toolasha-select option \{[^}]*background-color[^}]*\}/);
    });

    test('the generated inner <script> is syntactically valid JavaScript', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
        // Throws a SyntaxError if the regex/name interpolation broke the script. It is never
        // invoked, so this needs none of the popout's runtime globals (BroadcastChannel, DOM).
        expect(() => new Function(script)).not.toThrow();
    });
});

/**
 * BroadcastChannel is shared by every same-origin tab, not scoped per tab or per pop-out
 * window. A second game tab (a second character logged in in another browser tab, common
 * in this genre) runs its own PopOutChat instance on the same two channel names. Without
 * an instance id, that second tab's _onSendChannelMessage would answer the first tab's
 * pop-out handshake and execute sends meant for the first tab's character. These tests
 * exercise the instance-id guard directly (relayChannel/sendChannel are replaced with
 * plain spies — a real BroadcastChannel would fan the same behavior out across instances,
 * which is exactly the bug being guarded against).
 */
describe('pop-out chat window: cross-tab isolation', () => {
    test("_relayPost tags every outgoing message with this tab's pop-out instance id", () => {
        const chat = new PopOutChat();
        chat.relayChannel = { postMessage: vi.fn() };
        chat.popoutInstanceId = 'tab-a-instance';

        chat._relayPost({ type: 'ping' });

        expect(chat.relayChannel.postMessage).toHaveBeenCalledWith({ type: 'ping', instanceId: 'tab-a-instance' });
    });

    test("ignores a send-channel message tagged with a different tab's instance id", () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = 'tab-a-instance';
        chat._sendInit = vi.fn();
        chat._executeSend = vi.fn();

        // A second game tab's pop-out sent this (its own, different, instance id).
        chat._onSendChannelMessage({ type: 'ready', instanceId: 'tab-b-instance' });
        chat._onSendChannelMessage({
            type: 'send',
            channel: '/chat_channel_types/general',
            text: 'hi',
            instanceId: 'tab-b-instance',
        });

        expect(chat._sendInit).not.toHaveBeenCalled();
        expect(chat._executeSend).not.toHaveBeenCalled();
    });

    test("handles a send-channel message tagged with this tab's own instance id", () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = 'tab-a-instance';
        chat._sendInit = vi.fn();
        chat._executeSend = vi.fn();

        chat._onSendChannelMessage({ type: 'ready', instanceId: 'tab-a-instance' });
        chat._onSendChannelMessage({
            type: 'send',
            channel: '/chat_channel_types/general',
            text: 'hi',
            instanceId: 'tab-a-instance',
        });

        expect(chat._sendInit).toHaveBeenCalledTimes(1);
        expect(chat._executeSend).toHaveBeenCalledWith('/chat_channel_types/general', 'hi');
    });

    test('ignores send-channel messages entirely before this tab has opened its own pop-out', () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = null;
        chat._sendInit = vi.fn();

        chat._onSendChannelMessage({ type: 'ready', instanceId: 'anything' });

        expect(chat._sendInit).not.toHaveBeenCalled();
    });

    test("the generated pop-out script embeds this tab's instance id and stamps it on every outgoing message", () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = 'tab-a-instance';

        const html = chat._buildPopoutHTML();

        expect(html).toContain(`const INSTANCE_ID = 'tab-a-instance';`);
        expect(html).toContain(`sendCh.postMessage({ type: 'ready', instanceId: INSTANCE_ID });`);
        expect(html).toContain('instanceId: INSTANCE_ID });');
        expect(html).toContain('if (data.instanceId !== INSTANCE_ID) return;');
    });
});

describe('pop-out chat window: remembered size and position', () => {
    test('with no saved geometry, falls back to the fixed default size and no position', () => {
        expect(buildPopoutWindowFeatures(null, { availWidth: 1920, availHeight: 1080 })).toBe(
            'width=960,height=720,resizable=yes'
        );
    });

    test('restores a saved size and position that fits on screen', () => {
        const features = buildPopoutWindowFeatures(
            { width: 700, height: 500, left: 200, top: 100 },
            { availWidth: 1920, availHeight: 1080 }
        );
        expect(features).toBe('width=700,height=500,resizable=yes,left=200,top=100');
    });

    test('still caps a saved size that is absurdly larger than the current screen', () => {
        // Size is the only thing still bounded (to a generous multiple of the primary
        // screen), since a corrupted saved value could otherwise produce an unusable window.
        const features = buildPopoutWindowFeatures(
            { width: 30000, height: 20000, left: 0, top: 0 },
            { availWidth: 1280, availHeight: 800 }
        );
        // 1280*2=2560, 800*2=1600
        expect(features).toBe('width=2560,height=1600,resizable=yes,left=0,top=0');
    });

    test('never shrinks below a sane minimum even if a bad value was saved', () => {
        const features = buildPopoutWindowFeatures(
            { width: 10, height: 10, left: 0, top: 0 },
            { availWidth: 1920, availHeight: 1080 }
        );
        expect(features).toBe('width=320,height=240,resizable=yes,left=0,top=0');
    });

    test('passes a saved position through verbatim, even far beyond the primary screen', () => {
        // This is what a pop-out placed on a second monitor to the right of/below the
        // primary looks like: coordinates well past the primary screen's availWidth/Height.
        // Firefox has no Window Management API to tell a real second monitor apart from a
        // bogus position, so position is no longer clamped to the primary screen at all.
        const features = buildPopoutWindowFeatures(
            { width: 700, height: 500, left: 5000, top: 5000 },
            { availWidth: 1920, availHeight: 1080 }
        );
        expect(features).toBe('width=700,height=500,resizable=yes,left=5000,top=5000');
    });

    test('passes a negative saved position through verbatim (a monitor above/left of primary)', () => {
        const features = buildPopoutWindowFeatures(
            { width: 700, height: 500, left: -1200, top: -300 },
            { availWidth: 1920, availHeight: 1080 }
        );
        expect(features).toBe('width=700,height=500,resizable=yes,left=-1200,top=-300');
    });

    test('ignores a malformed geometry object and falls back to defaults', () => {
        expect(buildPopoutWindowFeatures({ width: 'nope' }, { availWidth: 1920, availHeight: 1080 })).toBe(
            'width=960,height=720,resizable=yes'
        );
    });

    test('the generated pop-out script saves its own geometry under the shared key on resize and unload', () => {
        const chat = new PopOutChat();
        const html = chat._buildPopoutHTML();

        expect(html).toContain(`const GEOMETRY_KEY = '${POPOUT_GEOMETRY_KEY}';`);
        expect(html).toContain("window.addEventListener('resize'");
        expect(html).toContain("window.addEventListener('beforeunload', saveGeometry);");
        expect(html).toContain('localStorage.setItem(GEOMETRY_KEY');
    });
});

describe('pop-out chat window: _readSavedGeometry', () => {
    afterEach(() => {
        localStorage.removeItem(POPOUT_GEOMETRY_KEY);
    });

    test('returns null when nothing has been saved yet', () => {
        const chat = new PopOutChat();
        expect(chat._readSavedGeometry()).toBeNull();
    });

    test('returns the parsed geometry object when one is stored', () => {
        localStorage.setItem(POPOUT_GEOMETRY_KEY, JSON.stringify({ width: 800, height: 600, left: 10, top: 20 }));
        const chat = new PopOutChat();
        expect(chat._readSavedGeometry()).toEqual({ width: 800, height: 600, left: 10, top: 20 });
    });

    test('returns null instead of throwing on corrupted stored JSON', () => {
        localStorage.setItem(POPOUT_GEOMETRY_KEY, '{not json');
        const chat = new PopOutChat();
        expect(chat._readSavedGeometry()).toBeNull();
    });
});

describe('pop-out chat window: reset saved geometry (recovery affordance)', () => {
    afterEach(() => {
        localStorage.removeItem(POPOUT_GEOMETRY_KEY);
    });

    test('_resetSavedGeometry clears the saved geometry so the next open uses defaults', () => {
        localStorage.setItem(POPOUT_GEOMETRY_KEY, JSON.stringify({ width: 800, height: 600, left: 5000, top: 5000 }));
        const chat = new PopOutChat();

        chat._resetSavedGeometry();

        expect(chat._readSavedGeometry()).toBeNull();
        expect(localStorage.getItem(POPOUT_GEOMETRY_KEY)).toBeNull();
    });

    test('_resetSavedGeometry is a no-op, not a throw, when nothing was saved', () => {
        const chat = new PopOutChat();
        expect(() => chat._resetSavedGeometry()).not.toThrow();
    });

    test('injects a reset-position button next to the pop-out button', () => {
        document.body.innerHTML = `
            <div>
                <div class="Chat_tabsComponentContainer">
                    <button class="TabsComponent_expandCollapseButton">v</button>
                </div>
            </div>
        `;
        const chat = new PopOutChat();
        const outer = document.querySelector('.Chat_tabsComponentContainer').parentElement;

        chat._injectButton(outer);

        const popoutBtn = outer.querySelector('[data-mwi-popout-chat]');
        const resetBtn = outer.querySelector('[data-mwi-popout-chat-reset]');
        expect(popoutBtn).not.toBeNull();
        expect(resetBtn).not.toBeNull();
        // Sits right after the pop-out button, the least intrusive spot in that row.
        expect(popoutBtn.nextElementSibling).toBe(resetBtn);
    });

    test('clicking the reset button clears the saved geometry', () => {
        localStorage.setItem(POPOUT_GEOMETRY_KEY, JSON.stringify({ width: 800, height: 600, left: 5000, top: 5000 }));
        document.body.innerHTML = `
            <div>
                <div class="Chat_tabsComponentContainer">
                    <button class="TabsComponent_expandCollapseButton">v</button>
                </div>
            </div>
        `;
        const chat = new PopOutChat();
        const outer = document.querySelector('.Chat_tabsComponentContainer').parentElement;
        chat._injectButton(outer);

        outer.querySelector('[data-mwi-popout-chat-reset]').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(localStorage.getItem(POPOUT_GEOMETRY_KEY)).toBeNull();
    });
});

describe('pop-out chat window: blocked-message count', () => {
    afterEach(() => {
        blockState.blockedNames.clear();
    });

    test('a blocked sender is dropped and bumps the count instead of buffering the message', () => {
        blockState.blockedNames.add('Griefer');
        const chat = new PopOutChat();
        chat.relayChannel = { postMessage: vi.fn() };

        chat._onChatMessage({
            message: { chan: '/chat_channel_types/general', sName: 'Griefer', m: 'spam', isSystemMessage: false },
        });

        expect(chat.blockedCount).toBe(1);
        expect(chat.messageBuffer.has('/chat_channel_types/general')).toBe(false);
    });

    test('relays the running count to the pop-out each time a message is dropped', () => {
        blockState.blockedNames.add('Griefer');
        const chat = new PopOutChat();
        chat.relayChannel = { postMessage: vi.fn() };

        chat._onChatMessage({
            message: { chan: '/chat_channel_types/general', sName: 'Griefer', m: 'spam', isSystemMessage: false },
        });
        chat._onChatMessage({
            message: { chan: '/chat_channel_types/general', sName: 'Griefer', m: 'more spam', isSystemMessage: false },
        });

        const calls = chat.relayChannel.postMessage.mock.calls.map((c) => c[0]);
        expect(calls).toContainEqual(expect.objectContaining({ type: 'blocked_count', count: 1 }));
        expect(calls).toContainEqual(expect.objectContaining({ type: 'blocked_count', count: 2 }));
    });

    test('a system message from a blocked name is never dropped (isSystem bypasses the block check)', () => {
        blockState.blockedNames.add('Griefer');
        const chat = new PopOutChat();
        chat.relayChannel = { postMessage: vi.fn() };

        chat._onChatMessage({
            message: { chan: '/chat_channel_types/general', sName: 'Griefer', m: 'sys', isSystemMessage: true },
        });

        expect(chat.blockedCount).toBe(0);
        expect(chat.messageBuffer.has('/chat_channel_types/general')).toBe(true);
    });

    test('_sendInit includes the running blocked count', () => {
        const chat = new PopOutChat();
        chat.relayChannel = { postMessage: vi.fn() };
        chat.blockedCount = 5;

        chat._sendInit();

        expect(chat.relayChannel.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'init', blockedCount: 5 })
        );
    });

    test('disable() resets the count for the next session', () => {
        const chat = new PopOutChat();
        chat.blockedCount = 7;
        chat.disable();
        expect(chat.blockedCount).toBe(0);
    });

    test('the generated pop-out script wires up the blocked-count display', () => {
        const chat = new PopOutChat();
        const html = chat._buildPopoutHTML();

        expect(html).toContain('id="blocked-count"');
        expect(html).toContain("data.type === 'blocked_count'");
        expect(html).toContain('function setBlockedCount(count)');
    });
});

/**
 * The pop-out is a separate document, so `--toolasha-visual-viewport-height` has to be
 * published into it by this side. What is worth asserting is the lifecycle, not the layout:
 * happy-dom does no layout at all, so any test reading a height would pass with and without
 * the fix. So: the tracking starts when the window opens, and — the repo's recurring bug
 * class — it is torn down when the window goes away, both on the user closing it and on the
 * feature being disabled.
 */
describe('pop-out chat window: visual-viewport tracking lifecycle', () => {
    let openSpy;
    let fakePopout;
    let listeners;

    beforeEach(() => {
        viewportState.stop = null;
        viewportState.calls = [];
        listeners = new Map();
        fakePopout = {
            closed: false,
            focus: () => {},
            close: () => {
                fakePopout.closed = true;
            },
            document: { readyState: 'complete' },
            addEventListener: (type, fn) => listeners.set(type, fn),
            removeEventListener: (type) => listeners.delete(type),
        };
        openSpy = vi.spyOn(window, 'open').mockReturnValue(fakePopout);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('starts tracking against the pop-out window and document once it has loaded', () => {
        const chat = new PopOutChat();
        chat._openPopout();

        expect(openSpy).toHaveBeenCalled();
        expect(viewportState.calls).toHaveLength(1);
        expect(viewportState.calls[0].windowRef).toBe(fakePopout);
        expect(viewportState.calls[0].documentRef).toBe(fakePopout.document);
    });

    test('stops tracking when the user closes the pop-out window', () => {
        const chat = new PopOutChat();
        chat._openPopout();
        const stop = viewportState.stop;
        expect(stop).toBeTypeOf('function');
        expect(stop).not.toHaveBeenCalled();

        // The pop-out document being torn down
        listeners.get('pagehide')();

        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('stops tracking when the feature is disabled with a pop-out still open', () => {
        const chat = new PopOutChat();
        chat._openPopout();
        const stop = viewportState.stop;

        chat.disable();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(chat.popoutViewportCleanup).toBeNull();
    });

    test('does not start tracking when the browser blocks the pop-out', () => {
        openSpy.mockReturnValue(null);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const chat = new PopOutChat();
        chat._openPopout();

        expect(viewportState.calls).toHaveLength(0);
    });
});
