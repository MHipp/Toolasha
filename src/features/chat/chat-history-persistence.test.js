/** @vitest-environment happy-dom */

/**
 * Persistence for the chat history buffer.
 *
 * The buffer is built from clones of nodes the game has thrown away, so before
 * this it was empty on every load. These tests pin the round trip, the fact
 * that a restored link is wired to *this script's* navigation rather than the
 * game callback it can no longer carry, and the two things that make the
 * feature safe rather than merely useful: the caps, and the exclusion from
 * anything that leaves the device (that last one lives in
 * `chat-history-sync-exclusion.test.js`, against the real payload builder).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { settingValues } = vi.hoisted(() => ({
    settingValues: { chatHistoryExtender: true, chatHistoryExtender_maxHistory: null },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn((key) => settingValues[key] ?? true),
        getSettingValue: vi.fn((key) => settingValues[key]),
    },
}));

const observerReady = vi.hoisted(() => ({ handlers: [], domReady: true }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(() => () => {}),
        onReady: vi.fn((name, callback) => {
            const handler = { name, callback };
            observerReady.handlers.push(handler);
            if (observerReady.domReady) callback();
            return () => {
                observerReady.handlers = observerReady.handlers.filter((h) => h !== handler);
            };
        }),
    },
}));

const db = vi.hoisted(() => ({ settings: {}, quota: false, writes: 0 }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback = null) => {
            const bucket = db[store] || {};
            return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : fallback;
        }),
        set: vi.fn(async (key, value, store) => {
            db.writes += 1;
            db[store] = db[store] || {};
            // Round-trip through JSON, the way IndexedDB's structured clone
            // would: a test that shared the live object would "restore" a
            // reference and prove nothing.
            db[store][key] = JSON.parse(JSON.stringify(value));
            return true;
        }),
        isQuotaExceeded: vi.fn(() => db.quota),
    },
}));

vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char1`,
}));

const itemDb = vi.hoisted(() => ({ known: new Set(['/items/cheese']) }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: vi.fn((hrid) => (itemDb.known.has(hrid) ? { hrid, name: 'Cheese' } : null)),
    },
}));

const navigateToMarketplace = vi.hoisted(() => vi.fn());
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace }));

import chatHistoryExtender, { chatTabKey } from './chat-history-extender.js';
import chatHistoryPersistence, {
    applyCaps,
    CHAT_HISTORY_KEY_BASE,
    CHAT_HISTORY_STORE,
    MAX_MESSAGES_PER_TAB,
    MAX_TOTAL_CHARS,
    rewireRestoredMessage,
    serializeMessage,
} from './chat-history-persistence.js';

const STORAGE_KEY = `${CHAT_HISTORY_KEY_BASE}_char1`;

/**
 * Build the chat DOM: a tab strip whose buttons name the tabs, and one message
 * container per tab in the same order — which is how `chatTabKey` names them.
 * @param {Array<string>} tabNames
 * @returns {Array<Element>} The message containers, in tab order
 */
function buildChat(tabNames = ['General']) {
    document.body.innerHTML = '<div id="root"><div class="Chat_tabsComponentContainer__x"></div></div>';
    const strip = document.querySelector('.Chat_tabsComponentContainer__x');
    const root = document.getElementById('root');
    return tabNames.map((name) => {
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.textContent = name;
        strip.appendChild(button);

        const container = document.createElement('div');
        container.className = 'ChatHistory_chatHistory__abc';
        root.appendChild(container);
        return container;
    });
}

/**
 * A plain system message.
 * @param {string} text
 * @returns {Element}
 */
function makeMessage(text) {
    const el = document.createElement('div');
    el.className = 'ChatMessage_chatMessage__xyz';
    el.textContent = text;
    return el;
}

/**
 * A message carrying an item icon, the way a marketplace listing line does.
 * @param {string} slug - Sprite id, e.g. `cheese`
 * @returns {Element}
 */
function makeItemMessage(slug) {
    const el = document.createElement('div');
    el.className = 'ChatMessage_chatMessage__xyz';
    el.innerHTML = `<span>sold </span><div class="Item_itemContainer__1"><svg><use href="/static/media/items_sprite.svg#${slug}"></use></svg></div>`;
    return el;
}

/** Evict a live message so the buffer takes a clone of it. */
async function evict(container, node) {
    container.removeChild(node);
    await Promise.resolve();
    await Promise.resolve();
}

/** Let the fire-and-forget restore land. */
async function settle() {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('chat history persistence', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
        itemDb.known = new Set(['/items/cheese']);
        navigateToMarketplace.mockClear();
    });

    afterEach(() => {
        chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    test('messages survive a simulated reload, in order', async () => {
        const [container] = buildChat(['General']);
        const first = makeMessage('[1/2 10:00:00] first');
        const second = makeMessage('[1/2 10:00:01] second');
        container.append(first, second);

        chatHistoryExtender.initialize();
        await settle();

        await evict(container, first);
        await evict(container, second);
        await chatHistoryPersistence.flush();

        expect(db.settings[STORAGE_KEY]).toBeTruthy();

        // Reload: the module is torn down, the DOM is rebuilt from nothing, and
        // only what reached storage can come back.
        chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['General']);
        chatHistoryExtender.initialize();
        await settle();

        const buffer = reloaded.querySelector('.mwi-history-buffer');
        const texts = [...buffer.querySelectorAll('[class*="ChatMessage_chatMessage"]')].map((el) => el.textContent);
        expect(texts).toEqual(['[1/2 10:00:00] first', '[1/2 10:00:01] second']);
    });

    test('a restored item link navigates through this script’s own helper', async () => {
        const [container] = buildChat(['General']);
        const message = makeItemMessage('cheese');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, message);
        await chatHistoryPersistence.flush();

        chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        const [reloaded] = buildChat(['General']);
        chatHistoryExtender.initialize();
        await settle();

        const link = reloaded.querySelector('.mwi-history-buffer [class*="Item_itemContainer"]');
        expect(link).not.toBeNull();
        expect(link.classList.contains('mwi-interactive')).toBe(true);

        link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(navigateToMarketplace).toHaveBeenCalledWith('/items/cheese', 0);
    });

    test('a link whose markup cannot be understood renders inert rather than throwing', () => {
        // Two ways the markup can defeat us: no sprite at all (a game update
        // that stopped drawing one), and a sprite naming an item this build's
        // game data does not know.
        const noSprite = document.createElement('div');
        noSprite.className = 'ChatMessage_chatMessage__xyz';
        noSprite.innerHTML = '<div class="Item_itemContainer__1"><span>???</span></div>';

        const unknownItem = document.createElement('div');
        unknownItem.className = 'ChatMessage_chatMessage__xyz';
        unknownItem.innerHTML =
            '<div class="Item_itemContainer__1"><svg><use href="/s.svg#not_an_item"></use></svg></div>';

        for (const el of [noSprite, unknownItem]) {
            expect(() => rewireRestoredMessage(el)).not.toThrow();
            expect(rewireRestoredMessage(el)).toBe(0);
            expect(el.querySelector('.mwi-interactive')).toBeNull();
            expect(el.querySelector('[data-mwi-restored-item]')).toBeNull();
            // Still readable as text, which is the whole requirement
            expect(el.textContent).toBeDefined();
        }
    });

    test('whisper and private tabs are persisted too — the maintainer’s explicit choice', async () => {
        const [general, whispers] = buildChat(['General', 'Whispers']);
        expect(chatTabKey(whispers)).toBe('tab:Whispers');

        const secret = makeMessage('[1/2 10:00:00] Alice: meet me at the tower');
        whispers.appendChild(secret);
        const public_ = makeMessage('[1/2 10:00:00] hello');
        general.appendChild(public_);

        chatHistoryExtender.initialize();
        await settle();
        await evict(whispers, secret);
        await evict(general, public_);
        await chatHistoryPersistence.flush();

        const stored = db.settings[STORAGE_KEY];
        expect(Object.keys(stored.tabs).sort()).toEqual(['tab:General', 'tab:Whispers']);
        expect(stored.tabs['tab:Whispers'][0]).toContain('meet me at the tower');
    });

    test('caps trim oldest-first and hold the write bounded', () => {
        // Message cap: the newest survive, the oldest go.
        const tabs = { 'tab:General': Array.from({ length: MAX_MESSAGES_PER_TAB + 20 }, (_, i) => `<div>${i}</div>`) };
        applyCaps(tabs, MAX_MESSAGES_PER_TAB);
        expect(tabs['tab:General']).toHaveLength(MAX_MESSAGES_PER_TAB);
        expect(tabs['tab:General'][0]).toBe('<div>20</div>');

        // Byte cap: many tabs of large messages, each within the message cap and
        // the per-tab count, still may not add up past the total.
        const big = 'x'.repeat(4000);
        const many = {};
        for (let t = 0; t < 12; t += 1) {
            many[`tab:${t}`] = Array.from({ length: MAX_MESSAGES_PER_TAB }, () => big);
        }
        const before = JSON.stringify(many).length;
        applyCaps(many, MAX_MESSAGES_PER_TAB);
        const after = Object.values(many).reduce(
            (sum, list) => sum + list.reduce((inner, html) => inner + html.length, 0),
            0
        );
        expect(before).toBeGreaterThan(MAX_TOTAL_CHARS);
        expect(after).toBeLessThanOrEqual(MAX_TOTAL_CHARS);

        // A single message past the per-message cap is not stored at all —
        // half a message's HTML would restore as broken markup.
        const huge = document.createElement('div');
        huge.className = 'ChatMessage_chatMessage__xyz';
        huge.textContent = 'y'.repeat(20000);
        expect(serializeMessage(huge)).toBeNull();
    });

    test('with the setting off nothing is written and nothing is restored', async () => {
        // Something is already on disk, so "nothing restored" cannot pass by
        // there being nothing to restore.
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { 'tab:General': ['<div class="ChatMessage_chatMessage__z">old</div>'] },
        };
        settingValues.chatHistoryExtender = false;

        const [container] = buildChat(['General']);
        const message = makeMessage('[1/2 10:00:00] hello');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();

        expect(container.querySelector('.mwi-history-buffer')).toBeNull();
        expect(container.textContent).not.toContain('old');

        await evict(container, message);
        await chatHistoryPersistence.flush();
        expect(db.writes).toBe(0);
    });

    test('the record is keyed per character and under the device-local prefix', async () => {
        const [container] = buildChat(['General']);
        const message = makeMessage('[1/2 10:00:00] hello');
        container.appendChild(message);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, message);
        await chatHistoryPersistence.flush();

        expect(Object.keys(db.settings)).toEqual([STORAGE_KEY]);
        expect(STORAGE_KEY.startsWith('toolasha_local_')).toBe(true);
        expect(CHAT_HISTORY_STORE).toBe('settings');
    });

    test('stale markup that no longer parses is skipped, not fatal to the rest', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'tab:General': ['', 'not markup at all', '<div class="ChatMessage_chatMessage__z">survivor</div>'],
            },
        };

        const [container] = buildChat(['General']);
        chatHistoryExtender.initialize();
        await settle();

        const buffer = container.querySelector('.mwi-history-buffer');
        const texts = [...buffer.querySelectorAll('[class*="ChatMessage_chatMessage"]')].map((el) => el.textContent);
        expect(texts).toEqual(['survivor']);
    });

    test('restored history stays above messages this session evicts', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: { 'tab:General': ['<div class="ChatMessage_chatMessage__z">older</div>'] },
        };

        const [container] = buildChat(['General']);
        const fresh = makeMessage('newer');
        container.appendChild(fresh);

        chatHistoryExtender.initialize();
        await evict(container, fresh);
        await settle();

        const buffer = container.querySelector('.mwi-history-buffer');
        const texts = [...buffer.querySelectorAll('[class*="ChatMessage_chatMessage"]')].map((el) => el.textContent);
        expect(texts).toEqual(['older', 'newer']);
    });
});
