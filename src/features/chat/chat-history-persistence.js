/**
 * Chat History Persistence
 *
 * The history buffer that `chat-history-extender.js` keeps above live chat is
 * lost on every reload, because it is built from `cloneNode(true)` of nodes the
 * game has already thrown away. This module writes that markup to IndexedDB and
 * puts it back on the next load.
 *
 * ## Why the markup, and why the links have to be rebuilt
 *
 * A live message is made clickable by reading its React fiber props at clone
 * time — `props.onClick`, `props.goToMarketplaceHandler` — and keeping the
 * *function references* in a map. Functions do not serialize, so nothing that
 * comes back off disk can carry the game's own callbacks. Restored item links
 * are therefore re-wired to this script's own navigation
 * (`navigateToMarketplace`), resolved from the icon sprite the markup already
 * carries, and a link whose item cannot be resolved is left inert: it loses
 * `.mwi-interactive` too, because a pointer cursor over a dead link is worse
 * than a plain one.
 *
 * Player names this script itself decorated travel with the message: the name
 * attribute and the class that styles it are both kept, so the delegated
 * listener in `chat-profile-link.js` works on a restored message without
 * waiting for anything to re-decorate it. This used to claim that decorator
 * would re-link them wherever they appeared; it does not, because it skips any
 * node that already carries its class — which a restored one does.
 *
 * The *sender* name of an ordinary chat line is the game's own element
 * (`ChatMessage_name ChatMessage_clickable`), carries no attribute of ours, and
 * is clickable only through a React handler — so it dies with the session
 * exactly like an item link does, and is re-wired here the same way. The name
 * is read back out of the `CharacterName_name` text the markup already carries
 * rather than from anything saved, which is what lets messages stored long
 * before this existed come back clickable with no migration. A sender whose
 * name cannot be read or does not look like a player name loses
 * `ChatMessage_clickable` as well, for the same reason an unresolvable item
 * link loses `.mwi-interactive`: on a restored node that class is a promise
 * nothing can keep.
 *
 * ## Why it never leaves the device
 *
 * Every tab is persisted, whispers and private messages included — a deliberate
 * choice, made knowing this puts private conversations on disk. Disk is the
 * whole of it: the cross-device sync uploads to a GitHub gist, and a whisper
 * reaching a gist would be a real privacy failure. The key is prefixed
 * `toolasha_local_`, which `features/sync/sync-payload.js` strips from the
 * settings store on the upload path (`redactSettingsStore`) and again on the
 * import path (`applyPayload`), and which `utils/full-backup.js` strips from
 * every manual backup file as well.
 *
 * The `settings` store is used rather than a store of this feature's own,
 * because a new object store means a `dbVersion` bump and this database's
 * version is held in lockstep with the upstream script that shares it — see
 * `core/storage.js`. A store-level exclusion would also have been needed then,
 * since `buildPayloadJSON('everything')` walks every store `listStores()`
 * reports; keeping the record in `settings` puts it under the key-prefix
 * exclusion that already exists and is already applied on both paths.
 *
 * ## Caps
 *
 * Markup for a dozen tabs at 150 messages each is not small, so three caps hold
 * the write down and every one of them trims oldest-first. See
 * {@link MAX_MESSAGE_CHARS}, {@link MAX_MESSAGES_PER_TAB} and
 * {@link MAX_TOTAL_CHARS}.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { characterKey } from '../../utils/character-key.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';

/**
 * Unscoped storage key. The `toolasha_local_` prefix is the load-bearing part:
 * it is what keeps this record out of a sync payload and out of a backup file.
 * Changing it without changing `LOCAL_ONLY_KEY_PREFIXES` in
 * `features/sync/sync-payload.js` would publish whispers to a gist.
 */
export const CHAT_HISTORY_KEY_BASE = 'toolasha_local_chatHistory';

/** The store the record lives in — deliberately not a new one; see the header. */
export const CHAT_HISTORY_STORE = 'settings';

/** Record shape version, so a future change can drop what it cannot read. */
const RECORD_VERSION = 1;

/**
 * Longest single message kept, in characters of serialized HTML.
 *
 * A chat line is a few hundred characters; anything past this is markup that
 * has grown a shape we did not expect, and storing it would let one message eat
 * the whole budget. Such a message is dropped rather than truncated — half a
 * message's HTML restores as broken markup, which is worse than its absence.
 */
export const MAX_MESSAGE_CHARS = 8 * 1024;

/** Hard ceiling on messages kept per tab, whatever the user's max-history is. */
export const MAX_MESSAGES_PER_TAB = 150;

/**
 * Ceiling on the whole record, in characters of serialized HTML summed across
 * every tab. 256k characters is roughly a quarter-megabyte of UTF-8 for ASCII
 * chat and comfortably under it in practice; it is a bound, not a target, and
 * the trim that enforces it takes from the largest tab first so one busy
 * channel cannot starve the quiet ones.
 */
export const MAX_TOTAL_CHARS = 256 * 1024;

/** How long writes are coalesced before one hits storage. */
const WRITE_DEBOUNCE_MS = 5000;

/** Attributes stripped on the way in — stale handles into a dead session. */
/**
 * Handles that mean nothing in the next session and have to come off.
 *
 * `data-mwi-profile-name` is deliberately NOT among them, though it used to be.
 * It is a player's name — stable text, not a handle into this session's caches —
 * and `chat-profile-link.js` writes it beside the `mwi-chat-profile-name` class
 * that carries the styling. Stripping one and keeping the other left restored
 * messages looking exactly like links, cursor and all, whose click handler read
 * an empty name and returned; and the decorator skips any node already carrying
 * the class, so nothing ever put it back. The pair has to travel together.
 */
const STALE_ATTRIBUTES = ['data-mwi-uid', 'data-mwi-hydrated', 'data-mwi-profile-link', 'data-mwi-key-names-linked'];

/**
 * Serialize one live/cloned chat message node for storage.
 *
 * The node is copied first: the handles that only mean something in this
 * session are removed from the copy, never from the node the buffer is
 * rendering. `data-processed` is deliberately *kept* — it is
 * `dungeon-tracker-chat-annotations.js`'s "already counted" marker, and a
 * restored key-counts line that still carries it is one that annotator skips.
 *
 * @param {Element} node - A `ChatMessage_chatMessage` element
 * @returns {string|null} HTML text, or null when the node is unusable or over
 *   {@link MAX_MESSAGE_CHARS}
 */
export function serializeMessage(node) {
    if (!node || node.nodeType !== 1) return null;

    let copy;
    try {
        copy = node.cloneNode(true);
    } catch {
        return null;
    }

    const all = [copy, ...copy.querySelectorAll('*')];
    for (const el of all) {
        for (const attribute of STALE_ATTRIBUTES) el.removeAttribute(attribute);
        el.classList?.remove('mwi-interactive');
    }
    // Annotations this script drew are rebuilt from stored runs on the next
    // pass; keeping them would double them up.
    copy.querySelectorAll('.dungeon-timer-annotation, .dungeon-timer-average').forEach((span) => span.remove());

    const html = copy.outerHTML;
    if (typeof html !== 'string' || !html || html.length > MAX_MESSAGE_CHARS) return null;
    return html;
}

/**
 * Elements removed from restored markup outright.
 *
 * The first five execute or load; `base` and `meta` rewrite how every URL
 * around them resolves; and the SMIL trio (`animate`, `animateTransform`,
 * `set`) is the one that gets missed — they run *after* a sanitizer has been
 * over the tree and put back the attribute it just took, so
 * `<svg><a><animate attributeName="href" to="javascript:…"/></a></svg>`
 * survives an attribute-only pass. Chat markup animates nothing, so there is
 * nothing to lose by removing them.
 */
const UNSAFE_ELEMENT_SELECTOR =
    'script, iframe, object, embed, link, style, base, meta, animate, animateTransform, set';

/**
 * Attributes naming something the browser fetches or navigates to.
 *
 * `xlink:href` is here because that is how the game's item icons reference the
 * sprite sheet, so it is the one attribute in restored markup that reliably
 * carries a URL; the values kept are the fragment references those icons use
 * (`#itemName`), which no scheme test can match.
 */
const URL_ATTRIBUTES = ['href', 'xlink:href', 'src', 'action', 'formaction', 'ping', 'srcdoc'];

/** Schemes that run code when the URL is followed, tested after {@link normalizeURL}. */
const SCRIPTABLE_SCHEME = /^(?:javascript|vbscript):/i;

/**
 * A URL attribute's value reduced to what the browser will actually resolve.
 *
 * Leading whitespace and C0 control characters are ignored by the URL parser
 * and stripped from anywhere inside the scheme, so a tab-split `javascript:`
 * and a newline-padded one both navigate — and both walk past a naive
 * `startsWith('javascript:')`.
 *
 * @param {string} value - Raw attribute value
 * @returns {string} The value with whitespace and control characters removed
 */
function normalizeURL(value) {
    return String(value || '').replace(/[\x00-\x20]/g, '');
}

/**
 * Strip everything scriptable from one restored element, in place.
 *
 * Attribute-only sanitizing is not enough on its own — see
 * {@link UNSAFE_ELEMENT_SELECTOR} — so the elements go first and the
 * attributes second, over what is left.
 *
 * @param {Element} el - Parsed message element, still inside its template
 */
function sanitizeRestoredMarkup(el) {
    el.querySelectorAll(UNSAFE_ELEMENT_SELECTOR).forEach((bad) => bad.remove());

    for (const node of [el, ...el.querySelectorAll('*')]) {
        for (const attribute of [...(node.attributes || [])]) {
            const name = attribute.name;
            if (/^on/i.test(name)) {
                node.removeAttribute(name);
                continue;
            }
            const lower = name.toLowerCase();
            if (lower === 'srcdoc') {
                // A whole document's worth of markup that no pass over *this*
                // tree can reach, because it is parsed in the frame instead.
                node.removeAttribute(name);
                continue;
            }
            if (URL_ATTRIBUTES.includes(lower) && SCRIPTABLE_SCHEME.test(normalizeURL(attribute.value))) {
                node.removeAttribute(name);
                continue;
            }
            // An inline `url()` is a request to a third party the moment the
            // node is laid out — a read receipt on restored scrollback, fired
            // without a click. Colours and spacing are why chat markup carries
            // `style` at all, so only the ones with a fetch in them go.
            if (lower === 'style' && /url\s*\(/i.test(attribute.value || '')) node.removeAttribute(name);
        }
    }
}

/**
 * Parse stored HTML back into an element, with the parts that could execute
 * removed.
 *
 * The markup came from the game's own React render, so it should hold nothing
 * scriptable — but it has been round-tripped through storage since, and
 * `innerHTML` re-parses whatever is handed to it. `<script>` inserted this way
 * does not run; an `onerror` on an `<img>` does. Both go, along with the
 * element and URL forms an `on*` sweep alone would walk straight past — see
 * {@link sanitizeRestoredMarkup}.
 *
 * @param {string} html - Stored message markup
 * @returns {Element|null} The message element, or null when it does not parse
 */
export function parseStoredMessage(html) {
    if (typeof html !== 'string' || !html) return null;

    let template;
    try {
        template = document.createElement('template');
        template.innerHTML = html;
    } catch {
        return null;
    }

    const el = template.content.firstElementChild;
    if (!el) return null;

    sanitizeRestoredMarkup(el);

    // Mark it as scrollback from a previous session. The dungeon tracker scans
    // every `ChatMessage_chatMessage` in the document, buffer included, and
    // banks runs from pairs of "Key counts" lines — so without this a restored
    // key count pairs with this session's first live one and invents a run
    // spanning the reload. `data-processed` is preserved by the serializer for
    // lines already counted, but a reset clears that marker from the whole
    // document; this one is a property of where the node came from, so it
    // survives.
    //
    // Every node the tracker's own query would match is marked, not just the
    // root: it queries `[class*="ChatMessage_chatMessage"]` over the whole
    // document, which finds a nested one too, and a nested one carrying no mark
    // is a restored line the tracker reads as live.
    el.dataset.mwiRestored = '1';
    for (const nested of el.querySelectorAll('[class*="ChatMessage_chatMessage"]')) {
        nested.dataset.mwiRestored = '1';
    }

    return el;
}

/**
 * The item an icon element draws, read off its sprite reference.
 *
 * Same handle the rest of the codebase uses (`utils/marketplace-autofill.js`,
 * `features/alchemy/alchemy-success-stamp.js`): item icons carry the sprite id
 * on `xlink:href`, and only some also carry a plain `href`.
 *
 * @param {Element} container - An `Item_itemContainer` element
 * @returns {string|null} Item HRID, or null when no item sprite is drawn
 */
function itemHridFrom(container) {
    const use = container.querySelector('svg use[href], svg use[xlink\\:href]');
    const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
    const slug = href.match(/#(.+)$/)?.[1];
    return slug ? `/items/${slug}` : null;
}

/** The game's sender-name element on a chat line — the one it makes clickable. */
const SENDER_SELECTOR = '[class*="ChatMessage_name"]';

/** The name itself, inside the sender element; a rank badge or icon sits beside it. */
const CHARACTER_NAME_SELECTOR = '[class*="CharacterName_name"]';

/**
 * The class prefix behind the sender's pointer cursor. A CSS module, so the
 * live class is `ChatMessage_clickable__<hash>` and only the prefix is stable.
 */
const CLICKABLE_CLASS_PREFIX = 'ChatMessage_clickable';

/**
 * The player name a restored sender element shows.
 *
 * Read from the markup, never from a stored attribute: `CharacterName_name`'s
 * text is the name and nothing strips it, so this works on records written
 * before any of this code existed. `data-name` is preferred where the game
 * wrote one (it does on some surfaces) because it is the name without whatever
 * decoration sits around the text.
 *
 * @param {Element} sender - A `ChatMessage_name` element
 * @returns {string} The name, or '' when the markup does not yield one
 */
function senderNameFrom(sender) {
    const inner = sender.querySelector(CHARACTER_NAME_SELECTOR) || sender;
    const raw = inner.getAttribute?.('data-name') || inner.textContent || '';
    // The fallback path can pick up the separator the game draws after the name.
    return raw.trim().replace(/:$/, '').trim();
}

/**
 * Re-wire the sender name of a restored message to this script's own profile open.
 *
 * The live element's clickability is a React handler, which no serialization can
 * carry — so a restored sender is a name styled as a link with nothing behind it.
 * Marking is an attribute rather than a listener, so a node re-processed (or
 * cloned into another buffer) cannot accumulate handlers.
 *
 * @param {Element} el - A restored message element
 * @returns {number} How many sender names were made clickable
 */
function rewireRestoredSender(el) {
    let senders;
    try {
        senders = el.querySelectorAll(SENDER_SELECTOR);
    } catch {
        return 0;
    }

    let wired = 0;
    for (const sender of senders) {
        try {
            const name = senderNameFrom(sender);
            if (name && VALID_PLAYER_NAME_RE.test(name)) {
                sender.dataset.mwiRestoredSender = name;
                wired += 1;
                continue;
            }
            // Nothing can honour the click, so nothing may advertise one.
            delete sender.dataset.mwiRestoredSender;
            for (const cls of [...sender.classList]) {
                if (cls.startsWith(CLICKABLE_CLASS_PREFIX)) sender.classList.remove(cls);
            }
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not re-wire a sender name:', error);
        }
    }
    return wired;
}

/**
 * Re-wire the clickable parts of a restored message.
 *
 * Fails soft by design: a game update will eventually change this markup, and
 * when it does the only correct outcome is a message that still reads as text.
 * So every step is best-effort, nothing throws out of here, and an item link
 * that cannot be resolved — unknown sprite, sprite naming an item this build's
 * game data does not know — is left without `.mwi-interactive` rather than
 * given a cursor it cannot honour.
 *
 * @param {Element} el - A restored message element, not yet in the document
 * @returns {number} How many links were made clickable, sender name included
 */
export function rewireRestoredMessage(el) {
    if (!el) return 0;

    let wired = rewireRestoredSender(el);
    let containers;
    try {
        containers = el.querySelectorAll('[class*="Item_itemContainer"]');
    } catch {
        return wired;
    }

    for (const container of containers) {
        try {
            const hrid = itemHridFrom(container);
            // `getItemDetails` is the same validation `utils/item-navigation.js`
            // does before handing an HRID to the game: an unknown one crashes
            // the game's own renderer, so an unresolvable link stays inert.
            if (!hrid || !dataManager.getItemDetails?.(hrid)) continue;

            const level = parseInt(
                container.querySelector('[class*="Item_enhancementLevel"]')?.textContent?.replace(/\D/g, ''),
                10
            );
            const enhancementLevel = Number.isFinite(level) ? level : 0;

            // The clickable target is the element the player sees, which is the
            // container itself; the handler is this script's own navigation,
            // not the game callback the live node had.
            container.dataset.mwiRestoredItem = hrid;
            container.dataset.mwiRestoredEnh = String(enhancementLevel);
            container.classList.add('mwi-interactive');
            wired += 1;
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not re-wire an item link:', error);
        }
    }

    return wired;
}

/**
 * Handle a click inside a restored message. Attached once per buffer by
 * `chat-history-extender.js`; a click on anything not re-wired does nothing.
 *
 * The sender name goes through `openPlayerProfile` — the same helper the
 * delegated listener in `chat-profile-link.js` calls, so the click behaviour is
 * shared rather than duplicated. What is deliberately *not* reused is that
 * module's `markAsProfileLink`: it recolours the name to this script's link
 * blue (restored lines would stop matching live ones) and it is gated on
 * `chat_profileLink`, which turns off decorating names the game left plain.
 * Putting back a sender the game itself made clickable is not that feature, so
 * it is not that feature's setting to switch off; the history buffer's own
 * setting already gates all of this.
 *
 * @param {Event} event
 */
export function handleRestoredClick(event) {
    const sender = event.target?.closest?.('[data-mwi-restored-sender]');
    if (sender) {
        openPlayerProfile(sender.dataset.mwiRestoredSender, { logPrefix: 'ChatHistoryPersistence' });
        return;
    }

    const target = event.target?.closest?.('[data-mwi-restored-item]');
    if (!target) return;

    const hrid = target.dataset.mwiRestoredItem;
    const enhancementLevel = parseInt(target.dataset.mwiRestoredEnh, 10) || 0;
    try {
        navigateToMarketplace(hrid, enhancementLevel);
    } catch (error) {
        console.error('[ChatHistoryPersistence] Marketplace navigation failed:', error);
    }
}

/**
 * Prefix every key this module will accept, and the marker of the key format.
 *
 * The generation number is load-bearing rather than decorative. Two earlier
 * formats named a *slot* instead of a tab: `idx:<n>` named a position in the
 * tab strip, and `tab:<label>` claimed to name the tab but was resolved by
 * index alignment against a strip that renders one container for *every* tab —
 * so in practice every tab's history went under the first button's name. A
 * record under either is an unattributable mixture of whichever tabs the player
 * used, whispers included, and nothing on disk says which message came from
 * where. They cannot be migrated; see {@link dropForeignKeys}.
 *
 * Bumping the prefix rather than reusing `tab:` is what makes that drop safe:
 * a key written by an older build can never be mistaken for one written by this
 * one, so no record can mix content across the change.
 */
export const TAB_KEY_PREFIX = 'tab2:';

/**
 * Copy a stored `{tabKey: [html]}` map without keys this build cannot have
 * written.
 *
 * The only survivors are {@link TAB_KEY_PREFIX} keys, which are produced by one
 * function (`chatTabKey` in `chat-history-extender.js`) and name the tab that
 * was open when the message was recorded. Everything else is a slot-named
 * record from an older format: restoring one puts whatever it holds into
 * whichever tab happens to be open, which is a whisper in Global. A tab whose
 * history is missing is recoverable; a private conversation in a public tab's
 * scrollback is not.
 *
 * This is deliberately a format test and not a one-shot migration flag. It is
 * idempotent, needs nothing remembered on disk, and can only ever discard keys
 * that no current writer produces — so there is no later run of it that can eat
 * good data. The drop reaches storage on the next flush, because the working
 * record is what this returns.
 *
 * @param {Record<string, Array<string>>} tabs - Not mutated
 * @returns {Record<string, Array<string>>} A fresh map holding only current-format keys
 */
export function dropForeignKeys(tabs) {
    return Object.fromEntries(Object.entries(tabs || {}).filter(([key]) => String(key).startsWith(TAB_KEY_PREFIX)));
}

/**
 * Apply the three caps to a `{tabKey: [html]}` map, oldest-first, in place.
 *
 * Per-tab count first (cheap, and the cap the user's setting talks about), then
 * the total: the total's victim is always the oldest message of whichever tab
 * is currently largest, so a chatty channel is trimmed before a quiet one loses
 * anything.
 *
 * @param {Record<string, Array<string>>} tabs - Mutated
 * @param {number} perTab - Message cap per tab
 * @returns {Record<string, Array<string>>} The same object
 */
export function applyCaps(tabs, perTab = MAX_MESSAGES_PER_TAB) {
    const limit = Math.max(1, Math.min(perTab || MAX_MESSAGES_PER_TAB, MAX_MESSAGES_PER_TAB));

    let total = 0;
    for (const key of Object.keys(tabs)) {
        let list = tabs[key];
        if (!Array.isArray(list)) {
            delete tabs[key];
            continue;
        }
        // Everything this module writes is a non-empty string, but a record
        // read back off disk is whatever is on disk — and one entry that is not
        // a string makes `html.length` throw out of here, which is the eviction
        // handler on the recording path and an unhandled rejection on the load
        // path. A corrupt record costs its own contents, nothing else.
        if (list.some((html) => typeof html !== 'string')) {
            list = list.filter((html) => typeof html === 'string');
            tabs[key] = list;
        }
        if (list.length > limit) list.splice(0, list.length - limit);
        if (!list.length) {
            delete tabs[key];
            continue;
        }
        total += list.reduce((sum, html) => sum + html.length, 0);
    }

    // Guard the loop as well as the budget: an empty map cannot get smaller, and
    // a run of zero-length entries must not spin.
    let guard = 0;
    while (total > MAX_TOTAL_CHARS && guard++ < 100000) {
        let biggestKey = null;
        let biggestSize = -1;
        for (const [key, list] of Object.entries(tabs)) {
            if (!list.length) continue;
            const size = list.reduce((sum, html) => sum + html.length, 0);
            if (size > biggestSize) {
                biggestSize = size;
                biggestKey = key;
            }
        }
        if (!biggestKey) break;
        total -= tabs[biggestKey].shift().length;
        if (!tabs[biggestKey].length) delete tabs[biggestKey];
    }

    return tabs;
}

/**
 * The per-character record of preserved chat, and the reads and writes over it.
 */
class ChatHistoryPersistence {
    constructor() {
        /** @type {Record<string, Array<string>>|null} Working record, null until loaded or first recorded */
        this.tabs = null;
        /** @type {Record<string, Array<string>>|null} What the last read found on disk; what a restore renders */
        this.snapshot = null;
        this.enabled = false;
        this.writeTimer = null;
        this.loadPromise = null;
        this.getMaxHistory = () => MAX_MESSAGES_PER_TAB;
    }

    /**
     * Turn persistence on for a session.
     * @param {() => number} getMaxHistory - Reads the user's per-tab cap
     */
    enable(getMaxHistory) {
        this.enabled = true;
        if (typeof getMaxHistory === 'function') this.getMaxHistory = getMaxHistory;
    }

    /**
     * Read the record, and answer with what was on disk.
     *
     * The answer is a *snapshot*, deliberately not the working record. A tab's
     * restore is fire-and-forget while its buffer is already taking evictions,
     * so a message evicted during the read is appended to the working record
     * before the restore walks it — and a restore walking the working record
     * rendered that message a second time, above the clone the buffer had
     * already made of it.
     *
     * Never awaited on the path that makes chat usable: callers fire it and
     * fill their buffer when it lands.
     *
     * @returns {Promise<Record<string, Array<string>>>} What was stored, oldest first per tab
     */
    async load() {
        if (!this.enabled) return {};
        if (this.loadPromise) return this.loadPromise;

        this.loadPromise = (async () => {
            let record = null;
            try {
                record = await storage.get(characterKey(CHAT_HISTORY_KEY_BASE), CHAT_HISTORY_STORE, null);
            } catch (error) {
                console.error('[ChatHistoryPersistence] Could not read stored chat history:', error);
            }
            // A record from a version we do not understand is discarded rather
            // than half-read; the cost is one session's history.
            const stored = record && record.v === RECORD_VERSION && record.tabs ? record.tabs : {};
            const loaded = applyCaps(dropForeignKeys(stored), this.getMaxHistory());

            // Anything recorded while the read was in flight belongs after what
            // was on disk, not instead of it.
            const pending = this.tabs;
            this.tabs = loaded;
            if (pending) {
                for (const [key, list] of Object.entries(pending)) {
                    this.tabs[key] = [...(this.tabs[key] || []), ...list];
                }
                applyCaps(this.tabs, this.getMaxHistory());
            }

            this.snapshot = Object.fromEntries(Object.entries(loaded).map(([key, list]) => [key, [...list]]));
            return this.snapshot;
        })();

        return this.loadPromise;
    }

    /**
     * Append one message to a tab's record and schedule a write.
     * @param {string} tabKey - Stable-ish identity of the chat tab
     * @param {string} html - As produced by {@link serializeMessage}
     */
    record(tabKey, html) {
        if (!this.enabled || !tabKey || !html) return;
        // Belt and braces beside `chatTabKey`: only a key in the current
        // format names a tab rather than a slot, and nothing else may enter the
        // record — a key this build would not write is one a restore has to
        // throw away again.
        if (!tabKey.startsWith(TAB_KEY_PREFIX)) return;
        if (!this.tabs) this.tabs = {};
        if (!this.tabs[tabKey]) this.tabs[tabKey] = [];
        this.tabs[tabKey].push(html);
        applyCaps(this.tabs, this.getMaxHistory());
        this._scheduleWrite();
    }

    /** Coalesce the burst of evictions a busy channel produces into one write. */
    _scheduleWrite() {
        if (this.writeTimer) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush();
        }, WRITE_DEBOUNCE_MS);
    }

    /**
     * Write the record now.
     * @returns {Promise<boolean>} Whether the write was attempted and accepted
     */
    async flush() {
        if (!this.enabled || !this.tabs) return false;
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }

        // A recorder that keeps writing into a full quota just fails on every
        // flush; chat history is the most disposable thing in the database, so
        // it stands down first.
        if (storage.isQuotaExceeded?.()) return false;

        applyCaps(this.tabs, this.getMaxHistory());
        try {
            return await storage.set(
                characterKey(CHAT_HISTORY_KEY_BASE),
                { v: RECORD_VERSION, savedAt: Date.now(), tabs: this.tabs },
                CHAT_HISTORY_STORE
            );
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not write chat history:', error);
            return false;
        }
    }

    /** Drop the session's state. Storage is left alone — a disable is not a wipe. */
    reset() {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        this.tabs = null;
        this.snapshot = null;
        this.loadPromise = null;
        this.enabled = false;
        this.getMaxHistory = () => MAX_MESSAGES_PER_TAB;
    }
}

const chatHistoryPersistence = new ChatHistoryPersistence();
export default chatHistoryPersistence;
