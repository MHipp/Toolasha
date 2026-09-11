/**
 * A character switch landing inside the stored chat-history read.
 *
 * `load()` caches its promise and fills `this.tabs` when the read lands. The
 * teardown in between — `chat-history-extender.js`'s `disable()`, which flushes
 * and then `reset()`s — nulls `tabs`, `snapshot` and `loadPromise`, but it
 * cannot cancel a read already in flight. Resumed afterwards, the tail put the
 * DEPARTING character's messages back into `this.tabs`, and `enable()` on the
 * arriving character's re-initialise does not clear them: the arriving
 * character's own `load()` then folded that leftover in as "recorded while the
 * read was in flight", and the first eviction wrote the pair under
 * `chatHistory_<arriving id>`.
 *
 * That is one character's chat — whispers included — rendered in another
 * character's tabs and written permanently over their record.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

const storageMock = vi.hoisted(() => ({
    /** Set to a promise to hold the history read open */
    gate: null,
    stored: {},
}));

vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback = null) => {
            if (storageMock.gate) await storageMock.gate;
            return key in storageMock.stored ? storageMock.stored[key] : fallback;
        },
        set: async (key, value) => {
            storageMock.stored[key] = JSON.parse(JSON.stringify(value));
            return true;
        },
        isQuotaExceeded: () => false,
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_${dataManagerMock.getCurrentCharacterId() || 'default'}`,
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: vi.fn() }));
vi.mock('../../utils/profile-command.js', () => ({
    openPlayerProfile: vi.fn(),
    fillProfileCommand: vi.fn(),
    findChatInput: vi.fn(() => null),
    getGameCore: vi.fn(() => null),
    VALID_PLAYER_NAME_RE: /^[A-Za-z0-9_]+$/,
}));

const {
    default: chatHistoryPersistence,
    CHAT_HISTORY_KEY_BASE,
    TAB_KEY_PREFIX,
} = await import('./chat-history-persistence.js');

const TAB = `${TAB_KEY_PREFIX}General`;
const keyFor = (charId) => `${CHAT_HISTORY_KEY_BASE}_${charId}`;

/** A stored record in the shape `load()` accepts. */
function record(messages) {
    return { v: 1, savedAt: Date.now(), tabs: { [TAB]: messages } };
}

describe('a character switch landing inside the chat history read', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        chatHistoryPersistence.reset();
    });

    /**
     * Hold char1's read open, tear the feature down the way
     * `chat-history-extender.disable()` does, settle the switch, and let the
     * read land afterwards.
     * @returns {Promise<Record<string, Array<string>>>} What the interrupted read answered
     */
    async function switchDuringLoad() {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });

        chatHistoryPersistence.enable(() => 150);
        const pending = chatHistoryPersistence.load();

        // `character_switching`: the registry tears the feature layer down.
        // `getCurrentCharacterId()` has not moved yet — it moves after the
        // awaited emit — so the flush that goes first is still char1's.
        await chatHistoryPersistence.flush();
        chatHistoryPersistence.reset();

        // …and the switch settles.
        dataManagerMock.characterId = 'char2';

        release();
        storageMock.gate = null;
        return pending;
    }

    test("the interrupted read does not leave char1's messages in the working record", async () => {
        storageMock.stored[keyFor('char1')] = record(['<div>char1 whisper</div>']);

        await switchDuringLoad();

        expect(chatHistoryPersistence.tabs).toBeNull();
        expect(chatHistoryPersistence.snapshot).toBeNull();
    });

    test("char1's messages are never written under char2's key", async () => {
        storageMock.stored[keyFor('char1')] = record(['<div>char1 whisper</div>']);
        storageMock.stored[keyFor('char2')] = record(['<div>char2 message</div>']);

        await switchDuringLoad();

        // `character_switched`: the feature comes back up for char2 and its
        // tabs restore from their own record.
        chatHistoryPersistence.enable(() => 150);
        const restored = await chatHistoryPersistence.load();
        expect(restored[TAB]).toEqual(['<div>char2 message</div>']);

        // The first eviction after that writes the working record out.
        chatHistoryPersistence.record(TAB, '<div>char2 later</div>');
        await chatHistoryPersistence.flush();

        expect(storageMock.stored[keyFor('char2')].tabs[TAB]).toEqual([
            '<div>char2 message</div>',
            '<div>char2 later</div>',
        ]);
        // char1's own record is untouched either way
        expect(storageMock.stored[keyFor('char1')].tabs[TAB]).toEqual(['<div>char1 whisper</div>']);
    });
});
