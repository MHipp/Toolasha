/**
 * Tests for WebSocket Hook Module
 *
 * Scoped to the message-processing pipeline (isGameSocket, handler registration,
 * dedup/skip-dedup logic, cleanup) — the pieces that are pure logic once a message
 * string arrives. install()/wrapWebSocketConstructor() patch the global WebSocket and
 * MessageEvent.prototype and are integration surface better exercised manually in the
 * userscript itself.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./profile-manager.js', () => ({
    setCurrentProfile: vi.fn(),
}));

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn(async () => []),
        setJSON: vi.fn(async () => {}),
    },
}));

const { default: webSocketHook } = await import('./websocket.js');
const { setCurrentProfile } = await import('./profile-manager.js');
const storage = (await import('./storage.js')).default;

function msg(type, extra = {}) {
    return JSON.stringify({ type, ...extra });
}

/** A stand-in for one game connection — only its identity matters here. */
function gameSocket(url = 'wss://api.milkywayidle.com/ws') {
    return { url, send() {} };
}

beforeEach(() => {
    webSocketHook.messageHandlers.clear();
    webSocketHook.socketEventHandlers.clear();
    webSocketHook.processedMessages.clear();
    webSocketHook.recentActionCompleted.clear();
    vi.clearAllMocks();
    storage.getJSON.mockImplementation(async () => []);
    storage.setJSON.mockImplementation(async () => {});
});

describe('isGameSocket', () => {
    test('recognizes the live and test API hosts', () => {
        expect(webSocketHook.isGameSocket({ url: 'wss://api.milkywayidle.com/ws' })).toBe(true);
        expect(webSocketHook.isGameSocket({ url: 'wss://api-test.milkywayidle.com/ws' })).toBe(true);
    });

    test('rejects unrelated sockets and missing url/socket', () => {
        expect(webSocketHook.isGameSocket({ url: 'wss://example.com/ws' })).toBe(false);
        expect(webSocketHook.isGameSocket(null)).toBe(false);
        expect(webSocketHook.isGameSocket({})).toBe(false);
        // A url that is not a string is not a url
        expect(webSocketHook.isGameSocket({ url: 12 })).toBe(false);
    });

    test('accepts a socket from another realm', () => {
        // Another userscript replacing `window.WebSocket` with its own
        // constructor — a Tampermonkey sandbox and the page do not share
        // prototypes, so `instanceof WebSocket` would be silently false here
        // and the game's traffic would simply stop being seen
        class ForeignWebSocket {
            constructor(url) {
                this.url = url;
            }
            send() {}
        }

        expect(webSocketHook.isGameSocket(new ForeignWebSocket('wss://api.milkywayidle.com/ws'))).toBe(true);
    });
});

describe('on / off handler registration', () => {
    test('registers and invokes a handler for its message type', () => {
        const handler = vi.fn();
        webSocketHook.on('test_type', handler);
        webSocketHook.processMessage(msg('test_type', { foo: 'bar' }));
        // Handlers are invoked with the owning socket alongside the payload; a
        // message processed without one carries `socket: null`
        expect(handler).toHaveBeenCalledWith({ type: 'test_type', foo: 'bar' }, { socket: null });
    });

    test('does not register the same handler function twice', () => {
        const handler = vi.fn();
        webSocketHook.on('test_type', handler);
        webSocketHook.on('test_type', handler);
        webSocketHook.processMessage(msg('test_type'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('off() removes a handler so it no longer fires', () => {
        const handler = vi.fn();
        webSocketHook.on('test_type', handler);
        webSocketHook.off('test_type', handler);
        webSocketHook.processMessage(msg('test_type'));
        expect(handler).not.toHaveBeenCalled();
    });

    test('wildcard "*" handlers receive every message type', () => {
        const wildcard = vi.fn();
        webSocketHook.on('*', wildcard);
        webSocketHook.processMessage(msg('anything'));
        expect(wildcard).toHaveBeenCalledWith({ type: 'anything' }, { socket: null });
    });

    test('a handler that throws does not stop other handlers for the same type', () => {
        const throwing = () => {
            throw new Error('boom');
        };
        const ok = vi.fn();
        webSocketHook.on('test_type', throwing);
        webSocketHook.on('test_type', ok);
        expect(() => webSocketHook.processMessage(msg('test_type'))).not.toThrow();
        expect(ok).toHaveBeenCalled();
    });

    test('a rejecting async handler does not throw synchronously', async () => {
        webSocketHook.on('test_type', async () => {
            throw new Error('async boom');
        });
        expect(() => webSocketHook.processMessage(msg('test_type'))).not.toThrow();
        // Let the rejection's .catch() handler run
        await new Promise((r) => setTimeout(r, 0));
    });

    test('malformed JSON does not throw', () => {
        expect(() => webSocketHook.processMessage('not json{')).not.toThrow();
    });
});

describe('content-hash deduplication', () => {
    test('drops a byte-identical repeat of a message type not in the skip-dedup list', () => {
        const handler = vi.fn();
        webSocketHook.on('some_generic_type', handler);
        const message = msg('some_generic_type', { value: 1 });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('a message with different content is not deduped even with the same type', () => {
        const handler = vi.fn();
        webSocketHook.on('some_generic_type', handler);

        webSocketHook.processMessage(msg('some_generic_type', { value: 1 }));
        webSocketHook.processMessage(msg('some_generic_type', { value: 2 }));

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('skip-dedup message types (e.g. action_completed) are processed every time', () => {
        const handler = vi.fn();
        webSocketHook.on('quests_updated', handler);
        const message = msg('quests_updated', { value: 1 });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('new_battle survives the hash, so every baseline is re-seeded', () => {
        // It seeds every monster and player baseline there is, and two
        // consecutive waves of the same zone open identically for well past a
        // hundred characters. Dropped, the next fight is diffed against the
        // last one's units
        const handler = vi.fn();
        webSocketHook.on('new_battle', handler);

        const battle = (id) =>
            JSON.stringify({
                type: 'new_battle',
                combatMonsterHrid: '/monsters/abyssal_imp',
                players: [{ character: { name: 'MillenniumTest' } }],
                battleId: id,
            });

        expect(battle(41).slice(0, 100)).toBe(battle(42).slice(0, 100));
        webSocketHook.processMessage(battle(41));
        webSocketHook.processMessage(battle(42));

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('guild_battle_updated survives the hash, which its first 100 chars would not', () => {
        // The trial spectator stream is the worst collision of the lot: every
        // tick opens with the same type, battle and tier, and only the health
        // past the hash window differs. Hashed, a whole trial is one tick
        const handler = vi.fn();
        webSocketHook.on('guild_battle_updated', handler);

        const tick = (hp) =>
            JSON.stringify({
                type: 'guild_battle_updated',
                battleId: 1,
                tier: 2,
                pMap: { 1: { cHP: 2612, mHP: 2612, cMP: 2180, mMP: 2180, isActive: true, leftCombat: false } },
                mMap: { 0: { cHP: hp, mHP: 618_000 } },
            });

        // The two differ, and they differ only well past the window
        expect(tick(454_807).slice(0, 100)).toBe(tick(453_402).slice(0, 100));

        webSocketHook.processMessage(tick(454_807));
        webSocketHook.processMessage(tick(453_402));

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('the whole guild-trial family survives the hash', () => {
        // `guild_skilling_updated` is the worst of them: the window ends exactly
        // where `currentProgress` begins, and only `actionCounter` — the last
        // field in the message — ever changes between ticks. The lifecycle four
        // are short enough to fit inside the window whole, so a second trial of
        // the same skill would silently drop its own start or end
        const cases = {
            guild_skilling_updated: (n) =>
                `{"type":"guild_skilling_updated","trialHrid":"/guild_skilling/crafting","tier":10,` +
                `"currentProgress":0.243,"targetWorkValue":88920,"actionCounter":${n}}`,
            new_guild_battle: (n) => `{"type":"new_guild_battle","battleId":1,"wave":1,"tier":${n},"players":[]}`,
            new_guild_skilling: (n) =>
                `{"type":"new_guild_skilling","trialHrid":"/guild_skilling/crafting","tier":${n}}`,
            end_guild_battle: (n) => `{"type":"end_guild_battle","battleId":${n},"trialHrid":"/guild_combat/badger"}`,
            end_guild_skilling: (n) =>
                `{"type":"end_guild_skilling","trialHrid":"/guild_skilling/crafting","tier":${n}}`,
        };

        for (const [type, build] of Object.entries(cases)) {
            const handler = vi.fn();
            webSocketHook.on(type, handler);

            webSocketHook.processMessage(build(1));
            webSocketHook.processMessage(build(1));
            webSocketHook.processMessage(build(2));

            expect(handler, type).toHaveBeenCalledTimes(3);
        }

        // And the reason the first of them needs it at all
        expect(cases.guild_skilling_updated(83).slice(0, 100)).toBe(cases.guild_skilling_updated(84).slice(0, 100));
    });

    test('action_completed uses a 50ms TTL dedup instead of the content hash', () => {
        const handler = vi.fn();
        webSocketHook.on('action_completed', handler);
        const message = msg('action_completed', { value: 1 });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message); // duplicate within 50ms window -> dropped

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('loot_opened repeats within 50ms are deduped the same way as action_completed', () => {
        const handler = vi.fn();
        webSocketHook.on('loot_opened', handler);
        const message = msg('loot_opened', { chest: 'x' });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('community_buffs_updated repeats with identical openings are processed every time', () => {
        // Two donations to the same buff differ only past the 100-char hash
        // window (expireTime/level) — the type must skip the content hash
        const handler = vi.fn();
        webSocketHook.on('community_buffs_updated', handler);
        const message = msg('community_buffs_updated', { communityBuffs: [{ id: 'stable', level: 5 }] });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('guild_updated repeats with identical openings are processed every time', () => {
        const handler = vi.fn();
        webSocketHook.on('guild_updated', handler);
        const message = msg('guild_updated', { guild: { id: 'same-guild', name: 'Same Name', xp: 1 } });

        webSocketHook.processMessage(message);
        webSocketHook.processMessage(message);

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('the same payload from two different sockets is processed twice', () => {
        // A character switch overlaps two connections: the old socket is still
        // closing while the new one delivers the arriving character's opening
        // state. Two characters' first message of a type agree for far more than
        // a hundred characters, so a globally-keyed hash dropped the *new*
        // character's message as a duplicate of the old character's
        const handler = vi.fn();
        webSocketHook.on('some_generic_type', handler);
        const message = msg('some_generic_type', { value: 1 });

        webSocketHook.processMessage(message, gameSocket());
        webSocketHook.processMessage(message, gameSocket());

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('a repeat on the same socket is still dropped', () => {
        // The scoping must not cost the dedup its actual job: one physical frame
        // reaching two interception paths is still one message
        const handler = vi.fn();
        webSocketHook.on('some_generic_type', handler);
        const socket = gameSocket();
        const message = msg('some_generic_type', { value: 1 });

        webSocketHook.processMessage(message, socket);
        webSocketHook.processMessage(message, socket);

        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('the TTL dedup is socket-scoped too, so a new socket loses no loot_opened', () => {
        // `loot_opened` and `action_completed` skip the content hash and use the
        // 50 ms TTL key instead — same cross-socket collision, same data loss,
        // and for loot_opened the lost message is a chest that paid out
        const handler = vi.fn();
        webSocketHook.on('loot_opened', handler);
        const message = msg('loot_opened', { chest: 'x' });

        const oldSocket = gameSocket();
        webSocketHook.processMessage(message, oldSocket);
        webSocketHook.processMessage(message, oldSocket); // genuine duplicate: dropped
        webSocketHook.processMessage(message, gameSocket()); // a different connection: kept

        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('handlers are told which socket delivered the message', () => {
        const handler = vi.fn();
        const socket = gameSocket();
        webSocketHook.on('some_generic_type', handler);

        webSocketHook.processMessage(msg('some_generic_type', { value: 1 }), socket);

        expect(handler).toHaveBeenCalledWith({ type: 'some_generic_type', value: 1 }, { socket });
    });

    test('cleanupProcessedMessages trims down to the newest 50 entries once the cap is crossed', () => {
        // Cleanup triggers the instant size exceeds 100 (each message here has unique
        // content, so every one is added); the 101st push crosses the threshold and
        // trims immediately back down to 50.
        for (let i = 0; i < 101; i++) {
            webSocketHook.processMessage(msg('filler_type', { i }));
        }
        expect(webSocketHook.processedMessages.size).toBe(50);
    });
});

describe('saveCombatSimData side effects', () => {
    test('profile_shared stores the profile in memory and persists the profile list', async () => {
        const profileMessage = msg('profile_shared', {
            profile: { sharableCharacter: { id: 'char-1', name: 'Hero' } },
        });

        webSocketHook.processMessage(profileMessage);
        // saveCombatSimData is fire-and-forget async; flush microtasks
        await new Promise((r) => setTimeout(r, 0));

        expect(setCurrentProfile).toHaveBeenCalled();
        const savedProfile = setCurrentProfile.mock.calls[0][0];
        expect(savedProfile.characterID).toBe('char-1');
        expect(savedProfile.characterName).toBe('Hero');
        // Immediate: the GM copy an external page reads is written right after, and a
        // debounced IndexedDB write would leave the two disagreeing meanwhile.
        expect(storage.setJSON).toHaveBeenCalledWith('profile_list', expect.any(Array), 'combatExport', true);
    });

    test('a profile_shared message with no profile at all is ignored without throwing', async () => {
        const profileMessage = msg('profile_shared', {});
        expect(() => webSocketHook.processMessage(profileMessage)).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(setCurrentProfile).not.toHaveBeenCalled();
        expect(storage.setJSON).not.toHaveBeenCalled();
    });

    test('each share re-reads the stored list, so a second tab does not clobber the first', async () => {
        // The list used to be cached on the hook after the first read, which meant a
        // second game tab wrote its own copy over whatever the other tab had shared.
        let onDisk = [];
        storage.getJSON.mockImplementation(async (key) => (key === 'profile_list' ? onDisk : null));
        storage.setJSON.mockImplementation(async (key, value) => {
            if (key === 'profile_list') onDisk = value;
        });

        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-1', name: 'One' } } })
        );
        await new Promise((r) => setTimeout(r, 0));

        // Stands in for the other tab writing while this one holds no lock
        onDisk = [{ characterID: 'char-other', characterName: 'Other' }, ...onDisk];

        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-2', name: 'Two' } } })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(storage.getJSON.mock.calls.filter((c) => c[0] === 'profile_list')).toHaveLength(2);
        expect(onDisk.map((p) => p.characterID)).toEqual(['char-2', 'char-other', 'char-1']);
    });

    test('a repeat share of the same character moves it to the front rather than duplicating', async () => {
        let onDisk = [];
        storage.getJSON.mockImplementation(async (key) => (key === 'profile_list' ? onDisk : null));
        storage.setJSON.mockImplementation(async (key, value) => {
            if (key === 'profile_list') onDisk = value;
        });

        for (const id of ['char-1', 'char-2', 'char-1']) {
            webSocketHook.processMessage(msg('profile_shared', { profile: { sharableCharacter: { id, name: id } } }));
            await new Promise((r) => setTimeout(r, 0));
        }

        expect(onDisk.map((p) => p.characterID)).toEqual(['char-1', 'char-2']);
    });

    test('two shares in the same tick both survive rather than the later one winning', async () => {
        // The handler reads the list, merges, then writes — across two awaits. Fired
        // back to back, both used to read the same empty list and the second write
        // dropped the first profile from IndexedDB and the GM copy alike.
        let onDisk = [];
        storage.getJSON.mockImplementation(async (key) => {
            await new Promise((r) => setTimeout(r, 0)); // a real IDB read is not instant
            return key === 'profile_list' ? onDisk : null;
        });
        storage.setJSON.mockImplementation(async (key, value) => {
            if (key === 'profile_list') onDisk = value;
        });

        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-1', name: 'One' } } })
        );
        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-2', name: 'Two' } } })
        );
        // Wait on the serialising chain itself rather than a fixed delay
        await webSocketHook._profileChain;

        expect(onDisk.map((p) => p.characterID).sort()).toEqual(['char-1', 'char-2']);
    });

    test('a stored profile list that is not an array is treated as empty, not thrown on', async () => {
        // A corrupted or hand-edited record; `.filter` on it used to throw and lose the share
        storage.getJSON.mockImplementation(async (key) => (key === 'profile_list' ? { not: 'an array' } : null));
        let written = null;
        storage.setJSON.mockImplementation(async (key, value) => {
            if (key === 'profile_list') written = value;
        });

        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-1', name: 'One' } } })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(written.map((p) => p.characterID)).toEqual(['char-1']);
    });

    test('a profile_shared message with no resolvable character id is skipped without throwing', async () => {
        const profileMessage = msg('profile_shared', { profile: {} });
        expect(() => webSocketHook.processMessage(profileMessage)).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(setCurrentProfile).not.toHaveBeenCalled();
    });
});

describe('saveCombatSimData GM-storage bridge stamping', () => {
    // GM_setValue only exists in the Tampermonkey sandbox; stub it per-test so saveCombatSimData's
    // `hasGM` branch runs and so we can inspect exactly what got written.
    beforeEach(() => {
        globalThis.GM_setValue = vi.fn();
    });

    afterEach(() => {
        delete globalThis.GM_setValue;
    });

    function metaWrite(key) {
        const call = globalThis.GM_setValue.mock.calls.find(([k]) => k === key);
        expect(call).toBeDefined();
        return JSON.parse(call[1]);
    }

    test('stamps toolasha_init_character_data with the writing character and a fresh writtenAt, payload untouched', async () => {
        const before = Date.now();
        const characterMessage = msg('init_character_data', { character: { id: 'char-42', name: 'Milky' } });

        webSocketHook.processMessage(characterMessage);
        await new Promise((r) => setTimeout(r, 0));

        // Payload key keeps its original raw-message shape (external Shykai sim reads it directly).
        expect(globalThis.GM_setValue).toHaveBeenCalledWith('toolasha_init_character_data', characterMessage);

        const meta = metaWrite('toolasha_init_character_data_meta');
        expect(meta).toEqual({
            characterId: 'char-42',
            characterName: 'Milky',
            writtenAt: expect.any(Number),
        });
        expect(meta.writtenAt).toBeGreaterThanOrEqual(before);
    });

    test('stamps toolasha_init_client_data and toolasha_new_battle with the last character seen on this tab', async () => {
        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-7', name: 'Zog' } }));
        await new Promise((r) => setTimeout(r, 0));
        globalThis.GM_setValue.mockClear();

        webSocketHook.processMessage(msg('init_client_data', { levelExperienceTable: [] }));
        await new Promise((r) => setTimeout(r, 0));
        expect(metaWrite('toolasha_init_client_data_meta')).toMatchObject({ characterId: 'char-7' });

        globalThis.GM_setValue.mockClear();
        webSocketHook.processMessage(msg('new_battle', { players: [] }));
        await new Promise((r) => setTimeout(r, 0));
        expect(metaWrite('toolasha_new_battle_meta')).toMatchObject({ characterId: 'char-7' });
    });

    test('stamps toolasha_profile_list with the viewing (writer) character, not the profile being viewed', async () => {
        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-viewer', name: 'Viewer' } }));
        await new Promise((r) => setTimeout(r, 0));
        globalThis.GM_setValue.mockClear();

        webSocketHook.processMessage(
            msg('profile_shared', { profile: { sharableCharacter: { id: 'char-other', name: 'Other' } } })
        );
        await new Promise((r) => setTimeout(r, 0));

        expect(metaWrite('toolasha_profile_list_meta')).toMatchObject({ characterId: 'char-viewer' });
    });

    test('a character switch updates the stamp used for subsequent writes', async () => {
        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-a', name: 'A' } }));
        await new Promise((r) => setTimeout(r, 0));
        globalThis.GM_setValue.mockClear();

        webSocketHook.processMessage(msg('init_character_data', { character: { id: 'char-b', name: 'B' } }));
        await new Promise((r) => setTimeout(r, 0));

        expect(metaWrite('toolasha_init_character_data_meta')).toMatchObject({
            characterId: 'char-b',
            characterName: 'B',
        });
    });
});

describe('socket lifecycle events', () => {
    test('onSocketEvent registers a handler invoked by emitSocketEvent', () => {
        const handler = vi.fn();
        webSocketHook.onSocketEvent('open', handler);
        const fakeEvent = {};
        const fakeSocket = {};
        webSocketHook.emitSocketEvent('open', fakeEvent, fakeSocket);
        expect(handler).toHaveBeenCalledWith(fakeEvent, fakeSocket);
    });

    test('offSocketEvent removes the handler', () => {
        const handler = vi.fn();
        webSocketHook.onSocketEvent('close', handler);
        webSocketHook.offSocketEvent('close', handler);
        webSocketHook.emitSocketEvent('close', {}, {});
        expect(handler).not.toHaveBeenCalled();
    });

    test('a throwing socket event handler does not prevent emitSocketEvent from returning', () => {
        webSocketHook.onSocketEvent('error', () => {
            throw new Error('boom');
        });
        expect(() => webSocketHook.emitSocketEvent('error', {}, {})).not.toThrow();
    });
});

describe('isMessageEventProcessed / markMessageEventProcessed', () => {
    test('marks an event object as processed so it is recognized on a second check', () => {
        const event = {};
        expect(webSocketHook.isMessageEventProcessed(event)).toBe(false);
        webSocketHook.markMessageEventProcessed(event);
        expect(webSocketHook.isMessageEventProcessed(event)).toBe(true);
    });

    test('handles non-object input without throwing', () => {
        expect(webSocketHook.isMessageEventProcessed(null)).toBe(false);
        expect(() => webSocketHook.markMessageEventProcessed(null)).not.toThrow();
    });
});

describe('native WebSocket listener semantics (prototype wrapping removed)', () => {
    // The prototype patch used to wrap every addEventListener('message', ...) in a fresh
    // closure without patching removeEventListener, so callers could never remove a message
    // listener by its original reference, and re-registering one bypassed native duplicate
    // suppression. These pin the native semantics the removal restored (upstream 5824eca).
    function makeFakeWebSocket(url = 'wss://api.milkywayidle.com/ws') {
        const target = new EventTarget();
        return {
            url,
            addEventListener: target.addEventListener.bind(target),
            removeEventListener: target.removeEventListener.bind(target),
            dispatchEvent: target.dispatchEvent.bind(target),
        };
    }

    function makeMessageEvent(data) {
        return Object.assign(new Event('message'), { data });
    }

    test('the prototype-wrapping method itself is gone', () => {
        expect(webSocketHook.wrapWebSocketPrototype).toBeUndefined();
    });

    test('add then remove: listener does not fire after removal', () => {
        const socket = makeFakeWebSocket();
        const cb = vi.fn();
        socket.addEventListener('message', cb);
        socket.removeEventListener('message', cb);
        socket.dispatchEvent(makeMessageEvent('{}'));
        expect(cb).not.toHaveBeenCalled();
    });

    test('adding the same listener twice fires it only once', () => {
        const socket = makeFakeWebSocket();
        const cb = vi.fn();
        socket.addEventListener('message', cb);
        socket.addEventListener('message', cb);
        socket.dispatchEvent(makeMessageEvent('{}'));
        expect(cb).toHaveBeenCalledTimes(1);
    });

    test('non-MWI socket message does not reach processMessage', () => {
        const socket = makeFakeWebSocket('wss://unrelated.example.com/ws');
        const spy = vi.spyOn(webSocketHook, 'processMessage');
        socket.addEventListener('message', () => {});
        socket.dispatchEvent(makeMessageEvent('{"type":"test"}'));
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('one message dispatches once even with the page data-getter live', () => {
        // In the page, MessageEvent.prototype.data is hooked: reading .data on
        // an UNMARKED event makes the getter itself run processMessage and then
        // mark the event. The socket listener's old `typeof event.data` probe
        // did exactly that read before marking — so the getter dispatched, then
        // the listener dispatched again, and every skip-dedup type (this test's
        // battle_updated among them) reached each handler twice. This fake
        // getter reproduces the page's semantics; the handler must fire once.
        const socket = makeFakeWebSocket();
        webSocketHook.attachSocketListeners(socket);

        const raw = JSON.stringify({ type: 'battle_updated', pMap: { p: { cHP: 1 } } });
        const event = new Event('message');
        Object.defineProperty(event, 'data', {
            get() {
                if (!webSocketHook.isMessageEventProcessed(this)) {
                    webSocketHook.markMessageEventProcessed(this);
                    webSocketHook.processMessage(raw);
                }
                return raw;
            },
        });

        const calls = [];
        const handler = (payload) => calls.push(payload);
        webSocketHook.on('battle_updated', handler);
        try {
            socket.dispatchEvent(event);
        } finally {
            webSocketHook.off('battle_updated', handler);
            webSocketHook.attachedSockets.delete(socket);
        }

        expect(calls).toHaveLength(1);
    });
});

describe('handler dispatch snapshots (upstream 03204a5)', () => {
    test('a message handler that off()s itself does not make the next handler get skipped', () => {
        const calls = [];
        const first = () => {
            calls.push('first');
            webSocketHook.off('snap_type', first);
        };
        const second = () => calls.push('second');

        webSocketHook.on('snap_type', first);
        webSocketHook.on('snap_type', second);
        webSocketHook.processMessage(msg('snap_type'));

        expect(calls).toEqual(['first', 'second']);
    });

    test('a socket event handler that offSocketEvent()s itself does not skip the next one', () => {
        const calls = [];
        const first = () => {
            calls.push('first');
            webSocketHook.offSocketEvent('open', first);
        };
        const second = () => calls.push('second');

        webSocketHook.onSocketEvent('open', first);
        webSocketHook.onSocketEvent('open', second);
        webSocketHook.emitSocketEvent('open', {}, {});

        expect(calls).toEqual(['first', 'second']);
    });
});

describe('reading past a broken foreign MessageEvent hook', () => {
    beforeEach(() => {
        webSocketHook.nativeDataGet = undefined;
        webSocketHook.notedForeignHookFailure = false;
    });

    test('a seeded native getter recovers the data and says so once', () => {
        webSocketHook.nativeDataGet = function () {
            return this._raw;
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const event = { _raw: msg('items_updated') };

        const first = webSocketHook.readDataBypassingForeignHooks(event, new Error('foreign hook threw'));
        const second = webSocketHook.readDataBypassingForeignHooks(event, new Error('again'));

        expect(first).toBe(event._raw);
        expect(second).toBe(event._raw);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    test('with no native getter obtainable it yields undefined rather than throwing', () => {
        webSocketHook.nativeDataGet = null; // already tried, nothing found

        expect(webSocketHook.readDataBypassingForeignHooks({}, new Error('x'))).toBeUndefined();
    });

    test('a native getter that itself fails on this event yields undefined', () => {
        webSocketHook.nativeDataGet = function () {
            throw new Error('not a MessageEvent');
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(webSocketHook.readDataBypassingForeignHooks({}, new Error('x'))).toBeUndefined();
        warn.mockRestore();
    });
});

/**
 * Whether the hook was in place before the handshake finished.
 *
 * This is the only evidence there is that the one-shot `init_character_data`
 * was missed rather than merely late: the payload arrives once, immediately
 * after the socket opens, and nothing replays it. DataManager's startup
 * recovery will only reload a page for which this says yes, so a false positive
 * here is a reload nobody asked for and a false negative is a script that stays
 * dead for the session.
 */
describe('attachedAfterSocketOpen', () => {
    /** A socket-shaped object with a readyState, the way attach sees one. */
    function socketAt(readyState) {
        return { url: 'wss://api.milkywayidle.com/ws', send() {}, readyState, addEventListener() {} };
    }

    beforeEach(() => {
        webSocketHook.attachedAfterSocketOpen = false;
    });

    test('starts false: nothing has been attached to yet', () => {
        expect(webSocketHook.attachedAfterSocketOpen).toBe(false);
    });

    test('attaching during the handshake leaves it false', () => {
        // The constructor-wrapper path: readyState CONNECTING, so every frame
        // this connection will ever deliver still passes through us
        webSocketHook.attachSocketListeners(socketAt(0));
        expect(webSocketHook.attachedAfterSocketOpen).toBe(false);
    });

    test('attaching to an already-open socket sets it', () => {
        // The MessageEvent.data path: the first frame we are asked to read is
        // already not the first frame the game received
        webSocketHook.attachSocketListeners(socketAt(1));
        expect(webSocketHook.attachedAfterSocketOpen).toBe(true);
    });

    test('a later clean attach does not clear a miss that already happened', () => {
        webSocketHook.attachSocketListeners(socketAt(1));
        webSocketHook.attachSocketListeners(socketAt(0));
        expect(webSocketHook.attachedAfterSocketOpen).toBe(true);
    });

    test('a socket that does not belong to the game never sets it', () => {
        webSocketHook.attachSocketListeners({
            url: 'wss://example.com/ws',
            send() {},
            readyState: 1,
            addEventListener() {},
        });
        expect(webSocketHook.attachedAfterSocketOpen).toBe(false);
    });

    test('a socket-shaped object with no readyState is not read as a miss', () => {
        // isGameSocket is duck-typed on purpose, so a foreign wrapper standing
        // in for a socket need not expose one. Guessing here would reload a
        // page that was never broken.
        webSocketHook.attachSocketListeners({ url: 'wss://api.milkywayidle.com/ws', send() {}, addEventListener() {} });
        expect(webSocketHook.attachedAfterSocketOpen).toBe(false);
    });
});

describe('closeActiveGameSocket', () => {
    /**
     * A socket-shaped object that records the close and, like a real one,
     * fires its close listener.
     */
    function liveSocket(readyState = 1) {
        const listeners = new Map();
        return {
            url: 'wss://api.milkywayidle.com/ws',
            send() {},
            readyState,
            closes: 0,
            closeArgs: null,
            addEventListener(type, handler) {
                listeners.set(type, handler);
            },
            close(...args) {
                this.closes += 1;
                this.closeArgs = args;
                this.readyState = 3;
                listeners.get('close')?.({ type: 'close' });
            },
        };
    }

    beforeEach(() => {
        webSocketHook.activeGameSocket = null;
        webSocketHook.attachedSockets = new WeakSet();
    });

    test('closes the game socket the hook is listening to', () => {
        const socket = liveSocket();
        webSocketHook.attachSocketListeners(socket);

        expect(webSocketHook.closeActiveGameSocket()).toBe(true);
        expect(socket.closes).toBe(1);
    });

    test('sends nothing: a plain close, no code and no reason', () => {
        const socket = liveSocket();
        const send = vi.spyOn(socket, 'send');
        webSocketHook.attachSocketListeners(socket);

        webSocketHook.closeActiveGameSocket();

        expect(socket.closeArgs).toEqual([]);
        expect(send).not.toHaveBeenCalled();
    });

    test('a closed socket stops being the active one, so nothing closes twice', () => {
        const socket = liveSocket();
        webSocketHook.attachSocketListeners(socket);

        expect(webSocketHook.closeActiveGameSocket()).toBe(true);
        expect(webSocketHook.activeGameSocket).toBeNull();
        expect(webSocketHook.closeActiveGameSocket()).toBe(false);
        expect(socket.closes).toBe(1);
    });

    test('no socket at all is a false, not a throw', () => {
        expect(webSocketHook.closeActiveGameSocket()).toBe(false);
    });

    test('a socket still connecting is left alone', () => {
        const socket = liveSocket(0);
        webSocketHook.attachSocketListeners(socket);

        expect(webSocketHook.closeActiveGameSocket()).toBe(false);
        expect(socket.closes).toBe(0);
    });

    test('a socket already closing is left alone', () => {
        const socket = liveSocket(2);
        webSocketHook.attachSocketListeners(socket);

        expect(webSocketHook.closeActiveGameSocket()).toBe(false);
        expect(socket.closes).toBe(0);
    });

    test('a foreign wrapper with no readyState is taken at its word', () => {
        const socket = liveSocket();
        delete socket.readyState;
        webSocketHook.attachSocketListeners(socket);

        expect(webSocketHook.closeActiveGameSocket()).toBe(true);
        expect(socket.closes).toBe(1);
    });

    test('a socket that is not the game', () => {
        webSocketHook.attachSocketListeners({ ...liveSocket(), url: 'wss://example.com/ws' });
        expect(webSocketHook.closeActiveGameSocket()).toBe(false);
    });

    test('the newest game socket is the one that would be closed', () => {
        const first = liveSocket();
        const second = liveSocket();
        webSocketHook.attachSocketListeners(first);
        webSocketHook.attachSocketListeners(second);

        expect(webSocketHook.closeActiveGameSocket()).toBe(true);
        expect(second.closes).toBe(1);
        expect(first.closes).toBe(0);
    });

    test("a departing socket's close does not clear the arriving one", () => {
        // A character switch: the new socket attaches before the old one has
        // finished closing, and the stale close must not leave us with nothing
        const departing = liveSocket();
        const arriving = liveSocket();
        webSocketHook.attachSocketListeners(departing);
        webSocketHook.attachSocketListeners(arriving);

        departing.close();

        expect(webSocketHook.activeGameSocket).toBe(arriving);
    });

    test('a close that throws is reported, not propagated', () => {
        const socket = liveSocket();
        socket.close = () => {
            throw new Error('InvalidStateError');
        };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        webSocketHook.attachSocketListeners(socket);

        expect(webSocketHook.closeActiveGameSocket()).toBe(false);
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
    });
});
