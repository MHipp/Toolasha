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
    parseStoredMessage,
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

/**
 * What a restored message may not bring back with it.
 *
 * The markup was the game's own when it was written, but it spent a session on
 * disk in between and `innerHTML` re-parses whatever it is handed. The `on*`
 * sweep was never the whole job: a URL attribute and an SMIL element both carry
 * script past an attribute-only pass, and an inline `url()` fires a request at
 * a third party with no click at all.
 */
describe('restored markup cannot execute or phone home', () => {
    test('a javascript: URL is dropped, however it is spelled', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">' +
                '<a href="javascript:alert(1)">a</a>' +
                '<a id="padded" href="  java	script:alert(2)">b</a>' +
                '<a id="fine" href="#anchor">c</a>' +
                '</div>'
        );

        expect(el.querySelector('a').hasAttribute('href')).toBe(false);
        expect(el.querySelector('#padded').hasAttribute('href')).toBe(false);
        // A real link is left alone — the sanitizer must not eat the markup
        expect(el.querySelector('#fine').getAttribute('href')).toBe('#anchor');
    });

    test('an item icon’s sprite reference survives it', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z"><div class="Item_itemContainer__1">' +
                '<svg><use href="/static/media/items_sprite.svg#cheese"></use></svg></div></div>'
        );
        expect(rewireRestoredMessage(el)).toBe(1);
    });

    test('SMIL animation is removed — it rewrites attributes after any sweep', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z"><svg><a>' +
                '<animate attributeName="href" to="javascript:alert(1)"></animate>' +
                '<set attributeName="href" to="javascript:alert(2)"></set>' +
                '</a></svg></div>'
        );
        expect(el.querySelector('animate')).toBeNull();
        expect(el.querySelector('set')).toBeNull();
    });

    test('a base element, a meta refresh and a srcdoc are all removed', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">' +
                '<base href="https://example.invalid/">' +
                '<meta http-equiv="refresh" content="0;url=https://example.invalid/">' +
                '<img srcdoc="<script>1</script>" alt="x">' +
                '</div>'
        );
        expect(el.querySelector('base')).toBeNull();
        expect(el.querySelector('meta')).toBeNull();
        expect(el.querySelector('img').hasAttribute('srcdoc')).toBe(false);
    });

    test('an inline style that fetches is dropped; one that only paints is kept', () => {
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">' +
                '<span id="beacon" style="background:url(https://example.invalid/?seen)">a</span>' +
                '<span id="paint" style="color: red">b</span>' +
                '</div>'
        );
        expect(el.querySelector('#beacon').hasAttribute('style')).toBe(false);
        expect(el.querySelector('#paint').getAttribute('style')).toBe('color: red');
    });

    test('a nested chat message is marked restored too, not just the root', () => {
        // The dungeon tracker queries `[class*="ChatMessage_chatMessage"]` over
        // the whole document and skips only what carries the mark, so a nested
        // match with no mark is a restored line it reads as live.
        const el = parseStoredMessage(
            '<div class="ChatMessage_chatMessage__z">outer' +
                '<div class="ChatMessage_chatMessage__z">inner</div></div>'
        );
        expect(el.dataset.mwiRestored).toBe('1');
        expect(el.querySelector('.ChatMessage_chatMessage__z').dataset.mwiRestored).toBe('1');
    });
});

describe('a corrupt record costs its own contents and nothing else', () => {
    test('applyCaps drops entries that are not strings rather than throwing', () => {
        const tabs = { 'tab:General': ['<div>ok</div>', null, 7, undefined, '<div>also ok</div>'] };
        expect(() => applyCaps(tabs, MAX_MESSAGES_PER_TAB)).not.toThrow();
        expect(tabs['tab:General']).toEqual(['<div>ok</div>', '<div>also ok</div>']);
    });

    test('a load over such a record still resolves, and recording still works', async () => {
        db.settings[STORAGE_KEY] = { v: 1, savedAt: 1, tabs: { 'tab:General': [null, '<div>kept</div>'] } };
        chatHistoryPersistence.enable(() => MAX_MESSAGES_PER_TAB);

        await expect(chatHistoryPersistence.load()).resolves.toEqual({ 'tab:General': ['<div>kept</div>'] });
        expect(() => chatHistoryPersistence.record('tab:General', '<div>new</div>')).not.toThrow();
    });
});

/**
 * A tab is identified by its label or not at all.
 *
 * The tab strip is not always rendered when a container appears, and history
 * keyed by the container's *position* in that case restores into whichever tab
 * later sits at that index — a whisper into Global, which is exactly the thing
 * the persistence choice was not meant to cost.
 */
describe('tab identity is a name, never a position', () => {
    beforeEach(() => {
        settingValues.chatHistoryExtender = true;
        settingValues.chatHistoryExtender_maxHistory = null;
        observerReady.handlers = [];
        observerReady.domReady = true;
        db.settings = {};
        db.quota = false;
        db.writes = 0;
    });

    afterEach(() => {
        chatHistoryExtender.disable();
        chatHistoryPersistence.reset();
        document.body.innerHTML = '';
    });

    /**
     * Chat containers with no tab strip at all — what the DOM looks like in the
     * window between the containers mounting and the strip rendering.
     * @param {number} count - How many containers
     * @returns {Array<Element>} The containers, in order
     */
    function buildChatWithoutTabStrip(count = 1) {
        document.body.innerHTML = '<div id="root"></div>';
        const root = document.getElementById('root');
        return Array.from({ length: count }, () => {
            const container = document.createElement('div');
            container.className = 'ChatHistory_chatHistory__abc';
            root.appendChild(container);
            return container;
        });
    }

    test('an unnamed tab is not keyed at all', () => {
        const [container] = buildChatWithoutTabStrip(1);
        expect(chatTabKey(container)).toBeNull();
    });

    test('an unnamed tab writes no history rather than a positional key', async () => {
        const [container] = buildChatWithoutTabStrip(2);
        const secret = makeMessage('[1/2 10:00:00] Alice: meet me at the tower');
        container.appendChild(secret);

        chatHistoryExtender.initialize();
        await settle();
        await evict(container, secret);
        await chatHistoryPersistence.flush();

        const stored = db.settings[STORAGE_KEY];
        const keys = stored ? Object.keys(stored.tabs) : [];
        expect(keys).toEqual([]);
    });

    test('a tab named only after its container appeared starts persisting under that name', async () => {
        const [container] = buildChatWithoutTabStrip(1);
        chatHistoryExtender.initialize();
        await settle();

        // The strip renders late, which is the whole reason the fallback existed
        const strip = document.createElement('div');
        strip.className = 'Chat_tabsComponentContainer__x';
        const button = document.createElement('button');
        button.setAttribute('role', 'tab');
        button.textContent = 'Whispers';
        strip.appendChild(button);
        document.getElementById('root').prepend(strip);

        const secret = makeMessage('[1/2 10:00:00] Alice: meet me at the tower');
        container.appendChild(secret);
        await evict(container, secret);
        await chatHistoryPersistence.flush();

        expect(Object.keys(db.settings[STORAGE_KEY].tabs)).toEqual(['tab:Whispers']);
    });

    test('a stored positional record is dropped, never restored into the tab now at that index', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'idx:0': ['<div class="ChatMessage_chatMessage__z">Alice: meet me at the tower</div>'],
                'tab:General': ['<div class="ChatMessage_chatMessage__z">hello</div>'],
            },
        };

        const [general] = buildChat(['General']);
        chatHistoryExtender.initialize();
        await settle();

        const rendered = [...document.querySelectorAll('.mwi-history-buffer [class*="ChatMessage_chatMessage"]')].map(
            (el) => el.textContent
        );
        expect(rendered).toEqual(['hello']);
        expect(general.textContent).not.toContain('meet me at the tower');

        // And it is gone from the record, not merely unread this session
        await chatHistoryPersistence.flush();
        expect(Object.keys(db.settings[STORAGE_KEY].tabs)).toEqual(['tab:General']);
    });

    test('a key matching no current tab is skipped and renders nowhere', async () => {
        db.settings[STORAGE_KEY] = {
            v: 1,
            savedAt: 1,
            tabs: {
                'tab:Whispers': ['<div class="ChatMessage_chatMessage__z">Alice: meet me at the tower</div>'],
            },
        };

        buildChat(['General', 'Party']);
        chatHistoryExtender.initialize();
        await settle();

        expect(document.body.textContent).not.toContain('meet me at the tower');
    });
});

describe('a restored message keeps its clickable player name', () => {
    // The bug: `data-mwi-profile-name` was stripped on save while the
    // `mwi-chat-profile-name` class that styles it was kept. A restored message
    // looked exactly like a link — blue, pointer cursor, hover underline — and
    // its click handler read an empty name and returned. The decorator could not
    // repair it either, because it skips any node already carrying the class.
    const messageWithName = () => {
        const el = document.createElement('div');
        el.className = 'ChatMessage_chatMessage__2wc4V';
        const name = document.createElement('span');
        name.className = 'mwi-chat-profile-name';
        name.dataset.mwiProfileName = 'Millennium';
        name.textContent = 'Millennium';
        el.appendChild(name);
        return el;
    };

    test('the name and the class that styles it both survive serialization', () => {
        const html = serializeMessage(messageWithName());
        expect(html).toBeTruthy();

        const restored = document.createElement('div');
        restored.innerHTML = html;
        const link = restored.querySelector('.mwi-chat-profile-name');

        expect(link, 'the styled span survives').toBeTruthy();
        expect(link.dataset.mwiProfileName, 'and so does the name it needs').toBe('Millennium');
    });

    test('session-scoped handles are still stripped', () => {
        const el = messageWithName();
        el.dataset.mwiUid = 'abc123';
        el.dataset.mwiHydrated = 'true';

        const restored = document.createElement('div');
        restored.innerHTML = serializeMessage(el);
        const message = restored.firstElementChild;

        expect(message.dataset.mwiUid).toBeUndefined();
        expect(message.dataset.mwiHydrated).toBeUndefined();
    });
});
