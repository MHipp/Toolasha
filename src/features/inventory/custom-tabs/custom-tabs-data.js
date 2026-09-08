/**
 * Custom Inventory Tabs — Data Module
 * Manages tab configuration storage and CRUD operations.
 * All mutating helpers return new objects (never mutate in place).
 */

import { createCuratedRecord } from '../../../utils/persisted-record.js';
import { registerSyncMerge } from '../../../utils/sync-merge-registry.js';

const STORAGE_KEY = 'inventoryTabs_config';
const STORE = 'settings';
const CONFIG_VERSION = 1;

export const LINEBREAK_HRID = '__linebreak__';

/**
 * How long a deletion is remembered.
 *
 * The sync-merge registration below explains why the union has to keep
 * everything either side has: without time information a pull cannot tell a
 * tab the other device has not seen yet from one this device deleted, so it
 * keeps both. A tombstone supplies exactly that missing fact, and only needs
 * to outlive the slowest device's catch-up - a month of not opening the game
 * on the other device is well past the point where reviving a stale tab is
 * the worse outcome than carrying the record forever.
 */
export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many item deletions are remembered at once, across every tab.
 *
 * Item tombstones outnumber tab ones by roughly the number of items a tab
 * holds, and they all live inside the ONE settings key this config occupies -
 * the store's key-count budget (`STORE_KEY_BUDGETS.settings`, 500 keys) is
 * untouched by them, so the number to watch is bytes in that record, not keys.
 * One entry is an hrid and a millisecond stamp, about 55 bytes of JSON
 * (`"/items/azure_alembic+5":1757000000000,`) plus ~40 bytes once per tab for
 * the uuid bucket key. 500 entries is therefore ~30 KB - the same order as a
 * heavily used config's own tab list, and small against any quota - while
 * 30 days of unbounded deleting is bounded by nothing at all. Oldest entries
 * are evicted first: the newest deletion is the one a peer has least likely
 * seen yet, and an evicted tombstone degrades to the old behaviour for that
 * one item (a peer that still carries it revives it), never to data loss.
 */
export const MAX_ITEM_TOMBSTONES = 500;

/**
 * Generate a unique ID
 * @returns {string}
 */
export function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Build the character-scoped storage key
 * @param {string} characterId
 * @returns {string}
 */
function getStorageKey(characterId) {
    return `${characterId}_${STORAGE_KEY}`;
}

/**
 * Return a blank config
 * @returns {Object}
 */
function defaultConfig() {
    return { version: CONFIG_VERSION, tabs: [], selectedTabId: null };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * A tab's modification stamp, treating an unstamped tab as beginning-of-time.
 * @param {Object} tab
 * @returns {number}
 */
function stampOf(tab) {
    const at = Number(tab?.updatedAt);
    return Number.isFinite(at) ? at : 0;
}

/**
 * A config's deletion tombstones (`tabId → when`), absent map included.
 * @param {Object} config
 * @returns {Object<string, number>}
 */
function tombstonesOf(config) {
    const removed = config?.removed;
    return removed && typeof removed === 'object' ? removed : {};
}

/**
 * Union two tombstone maps, the later deletion winning per id.
 * @param {Object} a
 * @param {Object} b
 * @returns {Object<string, number>}
 */
function unionTombstones(a, b) {
    const out = {};
    for (const [id, at] of Object.entries(a)) out[id] = Number(at) || 0;
    for (const [id, at] of Object.entries(b)) {
        const when = Number(at) || 0;
        if (!(id in out) || when > out[id]) out[id] = when;
    }
    return out;
}

/**
 * A config's item-deletion tombstones (`tabId -> itemHrid -> when`), absent
 * map included. Buckets are per tab because that is the scope an item lives
 * in: the same hrid removed from one tab and kept in another is two facts.
 * @param {Object} config
 * @returns {Object<string, Object<string, number>>}
 */
function itemGravesOf(config) {
    const graves = config?.removedItems;
    return graves && typeof graves === 'object' ? graves : {};
}

/**
 * Union two item-tombstone maps, the later deletion winning per (tab, item).
 * Buckets are rebuilt rather than shared, so the caller may clear entries out
 * of the result without reaching into either input.
 * @param {Object} a
 * @param {Object} b
 * @returns {Object<string, Object<string, number>>}
 */
function unionItemGraves(a, b) {
    const out = {};
    for (const source of [a, b]) {
        for (const [tabId, bucket] of Object.entries(source)) {
            if (!bucket || typeof bucket !== 'object') continue;
            const into = out[tabId] || (out[tabId] = {});
            for (const [hrid, at] of Object.entries(bucket)) {
                const when = Number(at) || 0;
                if (!(hrid in into) || when > into[hrid]) into[hrid] = when;
            }
        }
    }
    for (const [tabId, bucket] of Object.entries(out)) {
        if (Object.keys(bucket).length === 0) delete out[tabId];
    }
    return out;
}

/**
 * Hold the item-tombstone map to `MAX_ITEM_TOMBSTONES` entries, newest kept.
 * @param {Object} graves
 * @param {number} [max]
 * @returns {Object} The map, a new one only if something had to go
 */
function capItemGraves(graves, max = MAX_ITEM_TOMBSTONES) {
    const flat = [];
    for (const [tabId, bucket] of Object.entries(graves)) {
        for (const [hrid, at] of Object.entries(bucket)) flat.push([tabId, hrid, Number(at) || 0]);
    }
    if (flat.length <= max) return graves;
    flat.sort((one, two) => two[2] - one[2]);
    const out = {};
    for (const [tabId, hrid, at] of flat.slice(0, max)) {
        const into = out[tabId] || (out[tabId] = {});
        into[hrid] = at;
    }
    return out;
}

/**
 * Fold one tab's item list against the rival copy of the same tab.
 *
 * Items are a COLLECTION the user builds an entry at a time, not a property of
 * the tab, so resolving them by the tab's `updatedAt` the way a rename is
 * resolved loses one device's addition whenever the other device touched the
 * same tab later. They are unioned instead - the winner's list in the winner's
 * order, then whatever only the loser has, appended - and item tombstones
 * supply the fact a bare union lacks: which absences are deletions.
 *
 * A tombstone is judged per COPY, exactly as `applyTombstones` judges a tab's:
 * a copy that still holds the item and was stamped at or after the deletion is
 * evidence the deletion is stale news (the item was re-added, or the tombstone
 * predates this copy's whole history), so the item survives and the tombstone
 * is cleared. An UNSTAMPED copy is never deleted from, for the same reason an
 * unstamped tab is not: the ordering is unknowable and a hand-built list is the
 * wrong thing to guess about. The one case this deliberately gives up on is a
 * deletion CONCURRENT with an unrelated edit to the same tab on the other
 * device - that copy's stamp outlives the deletion though it never saw it, and
 * the item comes back. Reviving one item costs a click; a fold that loses one
 * costs the user something they cannot see is gone.
 *
 * Line breaks are exempt from all of it: they are positional decoration, may
 * repeat, and so have no identity to key a tombstone or a de-duplication by.
 * The winner's line-break layout is the one that survives.
 * @param {Object} winner - The copy whose fields and order win
 * @param {Object} loser
 * @param {Object<string, number>|undefined} graves - This tab's tombstones
 * @param {Array<Array<string>>} cleared - Appended to: [tabId, hrid] to forget
 * @returns {Array<string>} The merged list (the winner's own array if unchanged)
 */
function foldItemList(winner, loser, graves, cleared) {
    const mine = Array.isArray(winner.items) ? winner.items : [];
    const theirs = Array.isArray(loser.items) ? loser.items : [];
    const union = [...mine];
    const seen = new Set(mine);
    for (const hrid of theirs) {
        if (typeof hrid !== 'string' || hrid === LINEBREAK_HRID || seen.has(hrid)) continue;
        seen.add(hrid);
        union.push(hrid);
    }
    const unioned = union.length === mine.length ? mine : union;
    if (!graves || Object.keys(graves).length === 0) return unioned;

    const revived = [];
    const kept = union.filter((hrid) => {
        const at = graves[hrid];
        if (at === undefined || hrid === LINEBREAK_HRID) return true;
        const stamps = [];
        if (mine.includes(hrid)) stamps.push(stampOf(winner));
        if (theirs.includes(hrid)) stamps.push(stampOf(loser));
        if (!stamps.some((stamp) => stamp === 0 || at <= stamp)) return false;
        revived.push(hrid);
        return true;
    });

    // The mass-delete cap, per tab: a tab's item list is a curated list of its
    // own, and "most of this tab emptied itself on a load" is the same accident
    // as "most of my tabs vanished". Refused whole rather than partly, for the
    // same reason - a half-applied fold is a list the user cannot reason about
    // - and the tombstones stay in the map un-applied, so a real bulk clear-out
    // still wins once the surviving copy carries a stamp that proves it came
    // after. The threshold is the tab one: more than two items AND more than
    // half, since a two-item list has no majority worth protecting.
    const dropped = union.length - kept.length;
    const real = union.filter((hrid) => hrid !== LINEBREAK_HRID).length;
    if (dropped > 2 && dropped * 2 > real) {
        console.warn(
            `[CustomTabs] Refusing a fold that would delete ${dropped} of ${real} items from tab ` +
                `"${winner.name ?? winner.id}" at once; keeping every item and holding the item ` +
                'tombstones back un-applied.'
        );
        return unioned;
    }
    for (const hrid of revived) cleared.push([winner.id, hrid]);
    return kept.length === mine.length && kept.every((hrid, i) => hrid === mine[i]) ? mine : kept;
}

/**
 * Merge the item lists of two copies of one top-level subtree.
 *
 * Everything except `items` comes from the winner - a rename, a colour, the
 * child list and its order all stay last-write-wins by `updatedAt`, which is
 * what those fields are. Nested tabs are paired by id wherever the loser has
 * the same id, so an item added to a CHILD tab on the other device survives
 * too; a child only the loser has is still dropped with the rest of the loser's
 * structure, which is the existing whole-subtree rule and not what this fixes.
 * @param {Object} winner
 * @param {Object} loser
 * @param {Object} graves - The config-level item-tombstone map
 * @param {Array<Array<string>>} cleared - Appended to: [tabId, hrid] to forget
 * @returns {Object} The winner, a new copy only where items actually changed
 */
function mergeSubtreeItems(winner, loser, graves, cleared) {
    const loserById = new Map();
    const index = (tabs) => {
        for (const node of Array.isArray(tabs) ? tabs : []) {
            if (node?.id != null) loserById.set(node.id, node);
            index(node?.children);
        }
    };
    index([loser]);

    const rewrite = (tab) => {
        if (!tab || typeof tab !== 'object') return tab;
        const rival = tab.id != null ? loserById.get(tab.id) : undefined;
        const items = rival && rival !== tab ? foldItemList(tab, rival, graves[tab.id], cleared) : tab.items;
        const children = Array.isArray(tab.children) ? tab.children.map(rewrite) : tab.children;
        const childrenChanged = Array.isArray(children) && children.some((child, i) => child !== tab.children[i]);
        if (items === tab.items && !childrenChanged) return tab;
        const next = { ...tab };
        if (items !== tab.items) next.items = items;
        if (childrenChanged) next.children = children;
        return next;
    };
    return rewrite(winner);
}

/**
 * Drop every tab in a subtree whose id was deleted after that copy was last
 * touched, and clear the tombstone of every tab that survives it (the tab was
 * re-created or edited after the deletion, so the deletion is stale news).
 *
 * Applied through the whole tree, not just the top level: `removeTab` takes a
 * subtree with it, so a nested id can be tombstoned while its root survives.
 *
 * An UNSTAMPED tab is never deleted by a tombstone. `stampOf` answers 0 for
 * every tab written before stamps existed (pre-3.22.0), and a tombstone's
 * `deletedAt` is a Date.now()-scale number, so the plain comparison made ANY
 * tombstone beat EVERY legacy tab — and this runs at LOAD, not only on sync, so
 * a stored `removed` map naming legacy tabs pruned them off disk on the next
 * page load. When the stamp is 0 the ordering is genuinely unknowable, and for
 * a list the user authored by hand the safe answer is to keep the tab and drop
 * the tombstone: reviving one deleted tab costs a second click, losing a
 * curated tree costs an evening.
 *
 * A REVIVED SUBTREE comes back whole. `removeTab` tombstones the root and every
 * descendant at the same instant, so when the root's tombstone turns out to be
 * stale news — the other device edited the subtree after the deletion — every
 * descendant tombstone from that same removal is stale news too. Comparing each
 * descendant against its own stamp instead resurrected the root carrying only
 * the children that happened to be edited and silently dropped the untouched
 * siblings, which is the one outcome worse than either "deleted" or "kept".
 * `revivedAt` carries the cleared ancestor's `deletedAt` down: a descendant
 * tombstone no newer than it belongs to the removal that was just undone, while
 * a NEWER one is an independent later deletion and still applies.
 * @param {Object} tab
 * @param {Object<string, number>} removed - Mutated: surviving ids are cleared
 * @param {number} [revivedAt] - Deletion an ancestor was just revived from
 * @returns {Object|null} The tab (a new copy only if a descendant was dropped)
 */
function applyTombstones(tab, removed, revivedAt = -1) {
    if (!tab || typeof tab !== 'object') return null;
    const deletedAt = removed[tab.id];
    let revived = revivedAt;
    if (deletedAt !== undefined) {
        if (stampOf(tab) === 0 || deletedAt <= stampOf(tab) || deletedAt <= revivedAt) {
            delete removed[tab.id];
            if (deletedAt > revived) revived = deletedAt;
        } else return null;
    }
    const children = Array.isArray(tab.children) ? tab.children : null;
    if (!children || children.length === 0) return tab;
    const kept = children.map((child) => applyTombstones(child, removed, revived)).filter(Boolean);
    if (kept.length === children.length && kept.every((child, i) => child === children[i])) return tab;
    return { ...tab, children: kept };
}

/**
 * Every tab in a tree, nested ones included.
 * @param {Array} tabs
 * @returns {number}
 */
function _countTabs(tabs) {
    let n = 0;
    for (const tab of tabs) {
        if (!tab || typeof tab !== 'object') continue;
        n += 1;
        if (Array.isArray(tab.children)) n += _countTabs(tab.children);
    }
    return n;
}

/**
 * Depth-first: does any tab in this tree carry the id?
 * @param {Array} tabs
 * @param {string} id
 * @returns {boolean}
 */
function _treeHasId(tabs, id) {
    for (const tab of tabs) {
        if (tab?.id === id) return true;
        if (Array.isArray(tab?.children) && _treeHasId(tab.children, id)) return true;
    }
    return false;
}

/**
 * Fold a stored config under the one in memory — the read-back fold (see
 * `createCuratedRecord`) and the sync merge below both run through here, and
 * both hand the side that must win as the SECOND argument.
 *
 * Tabs are unioned by id. Where both sides carry an id the newer `updatedAt`
 * wins, unstamped counting as beginning-of-time so a stamped copy beats an
 * unstamped one and two unstamped copies fall back to ours. A tab whose id
 * carries a tombstone newer than that copy is dropped from both sides; one
 * touched after the deletion survives and clears the tombstone.
 *
 * ITEMS are the exception to "the newer tab wins". A tab's item list is a
 * collection two devices add to independently, so it is unioned per tab
 * (`foldItemList`) against per-item tombstones, and only the tab's other
 * fields follow the newer stamp. Taking the newer tab wholesale silently
 * dropped whatever the other device had added to it since the last sync. Tab
 * ORDER
 * comes from the side with the newer `orderUpdatedAt` (order is a property of
 * the list, not of any one tab), falling back to stored-then-new as before.
 * @param {Object} stored - The config as read back / the side that loses ties
 * @param {Object} memory - The config as held / the side that wins ties
 * @returns {Object} The merged config
 */
function mergeConfigs(stored, memory) {
    const theirs = stored && typeof stored === 'object' ? stored : {};
    const ours = memory && typeof memory === 'object' ? memory : {};
    const theirTabs = Array.isArray(theirs.tabs) ? theirs.tabs : [];
    const ourTabs = Array.isArray(ours.tabs) ? ours.tabs : [];

    // Per-tab: the newer stamp wins, ours on a tie (two unstamped copies tie).
    // Where both sides carry an id the winner's ITEMS are folded against the
    // loser's rather than replacing them - see `foldItemList`.
    const itemGraves = unionItemGraves(itemGravesOf(theirs), itemGravesOf(ours));
    const clearedItems = [];
    const byId = new Map();
    for (const tab of theirTabs) if (tab?.id != null) byId.set(tab.id, tab);
    for (const tab of ourTabs) {
        if (tab?.id == null) continue;
        const rival = byId.get(tab.id);
        if (!rival) {
            byId.set(tab.id, tab);
            continue;
        }
        const [winner, loser] = stampOf(rival) > stampOf(tab) ? [rival, tab] : [tab, rival];
        byId.set(tab.id, mergeSubtreeItems(winner, loser, itemGraves, clearedItems));
    }
    // An item that survived its own tombstone has outlived it (`foldItemList`)
    for (const [tabId, hrid] of clearedItems) {
        const bucket = itemGraves[tabId];
        if (!bucket) continue;
        delete bucket[hrid];
        if (Object.keys(bucket).length === 0) delete itemGraves[tabId];
    }

    // Tombstones: the union of both sides, newest deletion per id. Applied to a
    // TRIAL copy first, so the mass-delete cap below can decline the whole
    // application rather than half of it (`applyTombstones` mutates the map it
    // is handed, clearing the ids that survived).
    const union = unionTombstones(tombstonesOf(theirs), tombstonesOf(ours));
    const trialRemoved = { ...union };
    const trialById = new Map();
    for (const [id, tab] of byId) {
        const kept = applyTombstones(tab, trialRemoved);
        if (kept) trialById.set(id, kept);
    }

    // A single fold must never empty a curated list. Tombstones are the one
    // thing in this merge that can delete, they arrive from a store or a peer
    // that may be wrong about them, and "most of the user's tabs vanished at
    // once" is never the outcome the user wanted from a load. So a fold that
    // would drop more than half the tabs — and more than two, since a
    // two-tab list has no majority worth protecting — keeps every tab and
    // holds the tombstones back UN-APPLIED. They stay in the map, so a
    // genuinely widespread deletion still wins later, once the surviving tabs
    // carry stamps that prove the deletion came after them.
    const before = _countTabs([...byId.values()]);
    const after = _countTabs([...trialById.values()]);
    const dropped = before - after;
    const capped = dropped > 2 && dropped * 2 > before;
    let removed = union;
    if (capped) {
        console.warn(
            `[CustomTabs] Refusing a fold that would delete ${dropped} of ${before} tabs at once; ` +
                `keeping every tab and holding ${Object.keys(union).length} tombstone(s) back un-applied. ` +
                'If the deletions are real they will apply again once the surviving tabs are edited.'
        );
    } else {
        byId.clear();
        for (const [id, tab] of trialById) byId.set(id, tab);
        removed = trialRemoved;
    }

    // Order: from the side that reordered last, ids only one side has appended
    const theirOrderAt = Number(theirs.orderUpdatedAt) || 0;
    const ourOrderAt = Number(ours.orderUpdatedAt) || 0;
    const idsOf = (tabs) => tabs.map((tab) => tab?.id).filter((id) => id != null);
    const [primary, secondary] =
        ourOrderAt > theirOrderAt ? [idsOf(ourTabs), idsOf(theirTabs)] : [idsOf(theirTabs), idsOf(ourTabs)];
    const order = [...primary, ...secondary.filter((id) => !primary.includes(id))];
    const tabs = order.map((id) => byId.get(id)).filter(Boolean);

    const preferred = ours.selectedTabId ?? theirs.selectedTabId ?? null;
    let selectedTabId = null;
    if (preferred != null && _treeHasId(tabs, preferred)) selectedTabId = preferred;
    else if (theirs.selectedTabId != null && _treeHasId(tabs, theirs.selectedTabId)) {
        selectedTabId = theirs.selectedTabId;
    }

    const merged = { ...defaultConfig(), ...theirs, ...ours, tabs, selectedTabId };

    // Neither field is written unless something asked for it, so a config that
    // predates stamps merges to exactly the shape it always did
    if (Object.keys(removed).length > 0) merged.removed = removed;
    else delete merged.removed;
    const cappedItemGraves = capItemGraves(itemGraves);
    if (Object.keys(cappedItemGraves).length > 0) merged.removedItems = cappedItemGraves;
    else delete merged.removedItems;
    const orderAt = Math.max(theirOrderAt, ourOrderAt);
    if (orderAt > 0) merged.orderUpdatedAt = orderAt;
    else delete merged.orderUpdatedAt;
    return merged;
}

/**
 * Give every tab in a tree the shape the read helpers assume.
 *
 * `_findNode`, `_walkTabs`, `getAssignedItemSet` and `collectItemsAboveTab` all
 * reach `tab.children.length` and iterate `tab.items` unguarded, so a single
 * node missing either field throws and the whole panel stops drawing — and,
 * once that config is in hand, keeps throwing on every load until the key is
 * cleared by hand. Three things write this key without going through the CRUD
 * helpers: an imported layout file, a sync pull, and the upstream script that
 * shares `<charId>_inventoryTabs_config` in the same database. None of them is
 * obliged to produce the shape this module builds, so the shape is imposed on
 * the way in rather than trusted.
 *
 * Deliberately conservative: only the two fields that crash are filled, other
 * keys are carried through untouched, and the only tabs dropped are the ones
 * `mergeConfigs` already drops (non-objects and ids it cannot key by).
 * @param {*} tabs
 * @returns {Array<Object>} The tree, every node with `items` and `children`
 */
function normalizeTabs(tabs) {
    if (!Array.isArray(tabs)) return [];
    const out = [];
    for (const tab of tabs) {
        if (!tab || typeof tab !== 'object' || tab.id == null) continue;
        out.push({
            ...tab,
            items: Array.isArray(tab.items) ? tab.items.filter((hrid) => typeof hrid === 'string') : [],
            children: normalizeTabs(tab.children),
        });
    }
    return out;
}

/**
 * Forget deletions older than `TOMBSTONE_MAX_AGE_MS`.
 *
 * Item tombstones age on the same clock as tab ones - the age is sized to the
 * slowest device's catch-up, which is a property of the devices, not of what
 * was deleted - and are additionally held to `MAX_ITEM_TOMBSTONES`, since a
 * month of deleting items is a much larger number than a month of deleting
 * tabs.
 * @param {Object} config
 * @param {number} [now]
 * @returns {Object} The config, tombstone maps replaced only if some expired
 */
function pruneTombstones(config, now = Date.now()) {
    let out = config;
    const removed = out?.removed;
    if (removed && typeof removed === 'object') {
        const kept = Object.fromEntries(
            Object.entries(removed).filter(([, at]) => now - (Number(at) || 0) < TOMBSTONE_MAX_AGE_MS)
        );
        if (Object.keys(kept).length !== Object.keys(removed).length) {
            if (Object.keys(kept).length === 0) {
                const { removed: _expired, ...rest } = out;
                out = rest;
            } else out = { ...out, removed: kept };
        }
    }

    const graves = out?.removedItems;
    if (!graves || typeof graves !== 'object') return out;
    let expired = false;
    const keptGraves = {};
    for (const [tabId, bucket] of Object.entries(graves)) {
        if (!bucket || typeof bucket !== 'object') {
            expired = true;
            continue;
        }
        const fresh = Object.entries(bucket).filter(([, at]) => now - (Number(at) || 0) < TOMBSTONE_MAX_AGE_MS);
        if (fresh.length !== Object.keys(bucket).length) expired = true;
        if (fresh.length > 0) keptGraves[tabId] = Object.fromEntries(fresh);
    }
    const capped = capItemGraves(keptGraves);
    if (!expired && capped === keptGraves) return out;
    if (Object.keys(capped).length === 0) {
        const { removedItems: _gone, ...rest } = out;
        return rest;
    }
    return { ...out, removedItems: capped };
}

/**
 * A pull folds the gist's config into the one on disk instead of replacing it.
 *
 * The key is character-scoped with the id FIRST (`<charId>_inventoryTabs_config`),
 * so the registry's `base` matcher cannot say it and a predicate does. Local
 * wins per tab id and the union keeps everything either side has: without
 * per-tab timestamps, "which side is newer" is unknowable, and a pull that
 * replaced the key wholesale was reverting days of tab work to whatever the
 * gist last saw. Per-tab `updatedAt` stamps and deletion tombstones (see
 * `TOMBSTONE_MAX_AGE_MS`) supply the time information the config itself lacked,
 * so within a tombstone's lifetime the fold no longer guesses: the newer edit
 * wins, and a deletion is no longer undone by a device that still carries the
 * tab. Configs written before the stamps existed fall back to the old rule.
 */
registerSyncMerge({
    store: STORE,
    match: (key) => key === STORAGE_KEY || key.endsWith(`_${STORAGE_KEY}`),
    // The registry hands (local, incoming); mergeConfigs favours its second
    // argument per tab, and local is the side a pull must not erase
    merge: (local, incoming) => mergeConfigs(incoming, local),
    label: 'Custom inventory tabs',
});

/**
 * One curated record per character, under the exact key the config has always
 * lived at (`<charId>_inventoryTabs_config`, built here rather than through
 * character-key.js, so `scoped: false`). A read that cannot be made leaves the
 * config in hand rather than blanking it, and no write goes out over a store
 * that could not be read first; once the config has been read back, what the
 * panel holds is the config and a removed tab stays removed.
 * @type {Map<string, Object>}
 */
const records = new Map();

/**
 * @param {string} characterId
 * @returns {Object} The character's record
 */
function recordFor(characterId) {
    let record = records.get(characterId);
    if (!record) {
        record = createCuratedRecord({
            base: getStorageKey(characterId),
            store: STORE,
            scoped: false,
            empty: defaultConfig,
            merge: mergeConfigs,
            label: 'CustomTabs',
        });
        records.set(characterId, record);
    }
    return record;
}

/**
 * Load the tab config for a character.
 *
 * A readable load returns what is stored; one that cannot be made returns the
 * config last held for this character (the default when there is none) and
 * leaves the next save merging rather than overwriting.
 *
 * The record is SHARED — the panel, the bulk-sell assistant, and the reload on
 * every `character_initialized` all reach the same handle through `records` —
 * so this must never blank its memory and then go away to await a probe. It
 * used to: `record.set(defaultConfig())` ran before `record.load()`, and for
 * the length of an IndexedDB round trip the shared record held an empty
 * config. Anything that saved in that window folded its write against
 * emptiness, and a second `loadConfig` overlapping the first captured the
 * blank as its own "previous" and handed the panel an empty config back.
 * `authoritative: true` gets the same result — stored wins over held — with
 * the discarding moved to after the probe returns, so the window never exists
 * and an edit that lands mid-load is still folded in.
 * @param {string} characterId
 * @returns {Promise<Object>} { version, tabs, selectedTabId }
 */
export async function loadConfig(characterId) {
    if (!characterId) return defaultConfig();
    const record = recordFor(characterId);
    await record.load({ authoritative: true });
    const saved = record.get();
    const raw = !saved || !Array.isArray(saved.tabs) ? defaultConfig() : { ...defaultConfig(), ...saved };
    // Age pruning only. A tombstone whose id names no tab here is not dead
    // weight: it is the record of a deletion, and the one thing that stops a
    // peer device's sync push from reviving the tab. Pruning it because the id
    // is absent would make every deletion single-load-lived - the id is
    // *always* absent after the deletion applied. The clamp above protects
    // unstamped copies and import hygiene protects re-imports, so the only
    // copies a surviving tombstone can still delete are the synced ones it is
    // meant to.
    const config = pruneTombstones(raw);
    config.tabs = normalizeTabs(config.tabs);
    record.set(config);
    return config;
}

/**
 * Persist the tab config for a character
 * @param {string} characterId
 * @param {Object} config
 * @returns {Promise<boolean|undefined>} Whether the write landed
 */
export async function saveConfig(characterId, config) {
    if (!characterId) return;
    const record = recordFor(characterId);
    record.set(config);
    return record.save();
}

/**
 * Make an imported layout file safe to adopt as this character's config.
 *
 * A file used to be restored verbatim, which produced a config that destroyed
 * itself:
 *
 * - It carried the exporter's `removed` and `removedItems` maps. Tombstones
 *   name ids, the file
 *   names the same ids, and the next `loadConfig` applied one to the other —
 *   the imported tabs deleted themselves on the next page load. Stripped.
 * - Its tabs were unstamped, so every fold treated them as beginning-of-time
 *   and any tombstone or rival copy outranked them. Every imported tab is
 *   stamped `updatedAt = now`: it IS the newest thing that happened to this
 *   config, which is exactly what an import is.
 * - Its ids were the exporter's ids. Two characters importing one file — the
 *   ordinary way a layout is shared, including with yourself — ended up with
 *   different tabs under the same id, and any merge that saw both treated them
 *   as one tab and picked a winner. Fresh ids per tab end that at the source.
 *   Structure is preserved (children stay under their parent) and
 *   `selectedTabId` is remapped; nothing else in a config references a tab id
 *   (loadout bindings are keyed by loadout NAME and hold item hrids), so the
 *   remap is complete.
 *
 * `orderUpdatedAt` is left to the caller's config shape: the export no longer
 * writes one, and a file that still carries an old one is stamped forward here
 * so the imported order is the current order.
 *
 * @param {Object} parsed - The parsed layout file, minus its `_toolasha` marker
 * @param {number} [now]
 * @returns {Object} A config safe to hold and save
 */
export function sanitizeImportedConfig(parsed, now = Date.now()) {
    const {
        removed: _removed,
        removedItems: _removedItems,
        ...rest
    } = parsed && typeof parsed === 'object' ? parsed : {};
    const idMap = new Map();
    const rebuild = (tabs) =>
        (Array.isArray(tabs) ? tabs : [])
            .filter((tab) => tab && typeof tab === 'object')
            .map((tab) => {
                const id = makeId();
                if (tab.id != null) idMap.set(tab.id, id);
                // `items` is normalized for the same reason the ids are replaced:
                // the file came from outside and the read helpers iterate it
                // unguarded (see `normalizeTabs`)
                return {
                    ...tab,
                    id,
                    updatedAt: now,
                    items: Array.isArray(tab.items) ? tab.items.filter((hrid) => typeof hrid === 'string') : [],
                    children: rebuild(tab.children),
                };
            });
    const tabs = rebuild(rest.tabs);
    const selectedTabId = rest.selectedTabId != null ? (idMap.get(rest.selectedTabId) ?? null) : null;
    return { ...defaultConfig(), ...rest, tabs, selectedTabId, orderUpdatedAt: now };
}

/**
 * Test-only: drop every per-character record held here.
 *
 * The records are keyed by character id and deliberately outlive any one panel,
 * so in a test file they also outlive the test that created them: a record that
 * has already read a character's config folds the next save against what it
 * holds rather than against what the (by then re-seeded) store says.
 * @returns {void}
 */
export function _resetConfigRecords() {
    records.clear();
}

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushConfigWrites() {
    return Promise.all([...records.values()].map((record) => record.flushed()));
}

// ---------------------------------------------------------------------------
// Deep-clone helper (structuredClone with fallback)
// ---------------------------------------------------------------------------

function clone(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Modification stamps
//
// Every helper that CHANGES what a tab holds stamps that tab's `updatedAt`, so
// a fold can tell which side edited it last instead of guessing (see
// `mergeConfigs`). Pure-view state deliberately does NOT stamp: `setTabOpen`,
// `setAllTabsOpen` and a change of `selectedTabId` say where the user is
// looking, not what the tab is, and a fold that read them as edits would let
// collapsing a tree on one device outrank a rename on another.
//
// Reordering the tab LIST is not a change to any one tab, so `moveTab` stamps
// a config-level `orderUpdatedAt` instead, and the merge takes the order from
// whichever side reordered last.
// ---------------------------------------------------------------------------

/**
 * Stamp a tab and every ancestor of it (mutates), because the merge resolves
 * whole top-level subtrees by id: an edit to a nested tab is an edit to the
 * root copy that carries it, and only the root's stamp is compared.
 * @param {Array} tabs
 * @param {string} id
 * @param {number} at
 * @returns {boolean} Whether the id was found
 */
function _stampNode(tabs, id, at) {
    for (const tab of tabs) {
        if (tab.id === id) {
            tab.updatedAt = at;
            return true;
        }
        if (tab.children?.length && _stampNode(tab.children, id, at)) {
            tab.updatedAt = at;
            return true;
        }
    }
    return false;
}

/**
 * Stamp a tab as modified now. No-op when the id is not in the tree.
 * @param {Object} config - Mutated in place (callers pass their fresh clone)
 * @param {string} tabId
 * @param {number} [at]
 * @returns {Object} The same config
 */
function stampTab(config, tabId, at = Date.now()) {
    if (tabId != null && Array.isArray(config?.tabs)) _stampNode(config.tabs, tabId, at);
    return config;
}

/**
 * Record a deletion, so a device that still carries the tab does not revive it.
 * The whole subtree is recorded: `removeTab` takes the descendants with it, and
 * no helper moves a tab out of its parent, so none of them can be alive
 * elsewhere under a different root.
 * @param {Object} config - Mutated in place
 * @param {Object} tab - The tab being removed
 * @param {number} [at]
 */
function tombstone(config, tab, at = Date.now()) {
    if (!config.removed || typeof config.removed !== 'object') config.removed = {};
    _walkTabs([tab], (node) => {
        config.removed[node.id] = at;
    });
}

/**
 * Record an item's removal from a tab, so neither a peer device's copy nor the
 * config on disk revives it through the item union (see `foldItemList`).
 *
 * EVERY path that takes an hrid out of a `tab.items` must call this, the
 * derived ones (a loadout binding sync, an orphaned binding cleanup, an
 * enhancement-level swap) included: the read-back fold at save time folds the
 * stored copy under the held one, so an untombstoned removal is undone by the
 * very next save, not only by a sync.
 *
 * Line breaks are not recorded - they repeat, so they have no identity to key
 * a tombstone by, and the union never duplicates them.
 * @param {Object} config - Mutated in place (callers pass their fresh clone)
 * @param {string} tabId
 * @param {string} itemHrid
 * @param {number} [at]
 * @returns {Object} The same config
 */
export function tombstoneItem(config, tabId, itemHrid, at = Date.now()) {
    if (!config || tabId == null || typeof itemHrid !== 'string' || itemHrid === LINEBREAK_HRID) return config;
    if (!config.removedItems || typeof config.removedItems !== 'object') config.removedItems = {};
    const bucket = config.removedItems[tabId] || (config.removedItems[tabId] = {});
    bucket[itemHrid] = at;
    config.removedItems = capItemGraves(config.removedItems);
    return config;
}

/**
 * Forget an item's removal, because it is back in the tab - the counterpart of
 * `addTab` clearing a re-created tab's own tombstone.
 * @param {Object} config - Mutated in place
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} The same config
 */
export function clearItemTombstone(config, tabId, itemHrid) {
    const bucket = config?.removedItems?.[tabId];
    if (!bucket || bucket[itemHrid] === undefined) return config;
    delete bucket[itemHrid];
    if (Object.keys(bucket).length === 0) delete config.removedItems[tabId];
    if (Object.keys(config.removedItems).length === 0) delete config.removedItems;
    return config;
}

// ---------------------------------------------------------------------------
// CRUD helpers — all return a new config object
// ---------------------------------------------------------------------------

/**
 * Add a tab (at root level or inside a parent)
 * @param {Object} config
 * @param {string|null} parentId - null for root level
 * @param {string} name
 * @returns {Object} { config, tabId }
 */
export function addTab(config, parentId, name) {
    const c = clone(config);
    const now = Date.now();
    const tab = {
        id: makeId(),
        name,
        color: null,
        open: false,
        items: [],
        children: [],
        updatedAt: now,
    };
    if (!parentId) {
        c.tabs.push(tab);
    } else {
        const result = _findNode(c.tabs, parentId);
        if (result) {
            result.tab.children.push(tab);
            result.tab.open = true;
            stampTab(c, parentId, now);
        } else {
            c.tabs.push(tab);
        }
    }
    // Ids are fresh UUIDs, so this only matters if a caller ever re-creates a
    // known id — then the tab must outlive its own tombstone
    if (c.removed && typeof c.removed === 'object') delete c.removed[tab.id];
    return { config: c, tabId: tab.id };
}

/**
 * Remove a tab (and all its descendants)
 * @param {Object} config
 * @param {string} tabId
 * @returns {Object} new config
 */
export function removeTab(config, tabId) {
    const c = clone(config);
    if (c.selectedTabId === tabId) c.selectedTabId = null;
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;
    const now = Date.now();
    tombstone(c, result.tab, now);
    const parentId = result.parent?.id ?? null;
    _removeFromArray(c.tabs, tabId);
    if (parentId) stampTab(c, parentId, now);
    return c;
}

/**
 * Rename a tab
 * @param {Object} config
 * @param {string} tabId
 * @param {string} name
 * @returns {Object} new config
 */
export function renameTab(config, tabId, name) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) {
        result.tab.name = name;
        stampTab(c, tabId);
    }
    return c;
}

/**
 * Set a tab's accent color
 * @param {Object} config
 * @param {string} tabId
 * @param {string|null} color
 * @returns {Object} new config
 */
export function setTabColor(config, tabId, color) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) {
        result.tab.color = color;
        stampTab(c, tabId);
    }
    return c;
}

/**
 * Move a tab to a new position within its parent's children (or root)
 * @param {Object} config
 * @param {string} tabId
 * @param {number} newIndex - target index in the parent's children array
 * @returns {Object} new config
 */
export function moveTab(config, tabId, newIndex) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;

    const arr = result.parent ? result.parent.children : c.tabs;
    const oldIndex = arr.findIndex((t) => t.id === tabId);
    if (oldIndex === -1) return c;

    const [moved] = arr.splice(oldIndex, 1);
    const clampedIndex = Math.max(0, Math.min(newIndex, arr.length));
    arr.splice(clampedIndex, 0, moved);
    // Order belongs to the list, not the tab: the config carries the stamp, and
    // a nested reorder also touches the parent that owns that child list
    const now = Date.now();
    c.orderUpdatedAt = now;
    if (result.parent) stampTab(c, result.parent.id, now);
    return c;
}

/**
 * Add an item to a tab (no-op if already present)
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} new config
 */
export function addItem(config, tabId, itemHrid) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result && !result.tab.items.includes(itemHrid)) {
        result.tab.items.push(itemHrid);
        clearItemTombstone(c, tabId, itemHrid);
        stampTab(c, tabId);
    }
    return c;
}

/**
 * Insert an item at a specific index in a tab's items array (no-op if already present)
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @param {number} index - Position to insert at (clamped to array bounds)
 * @returns {Object} new config
 */
export function insertItem(config, tabId, itemHrid, index) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result && !result.tab.items.includes(itemHrid)) {
        const clamped = Math.max(0, Math.min(index, result.tab.items.length));
        result.tab.items.splice(clamped, 0, itemHrid);
        clearItemTombstone(c, tabId, itemHrid);
        stampTab(c, tabId);
    }
    return c;
}

/**
 * Move an item from one tab to another (atomic remove + insert)
 * @param {Object} config
 * @param {string} sourceTabId - Tab to remove from
 * @param {string} targetTabId - Tab to insert into
 * @param {string} itemHrid
 * @param {number} [insertIndex] - Position in target tab (appends if omitted)
 * @returns {Object} new config
 */
export function moveItem(config, sourceTabId, targetTabId, itemHrid, insertIndex) {
    if (sourceTabId === targetTabId) return config;
    const c = clone(config);
    const now = Date.now();
    // Remove from source
    const source = _findNode(c.tabs, sourceTabId);
    if (source) {
        source.tab.items = source.tab.items.filter((h) => h !== itemHrid);
        tombstoneItem(c, sourceTabId, itemHrid, now);
        stampTab(c, sourceTabId, now);
    }
    // Insert into target
    const target = _findNode(c.tabs, targetTabId);
    if (target && !target.tab.items.includes(itemHrid)) {
        if (insertIndex !== undefined) {
            const clamped = Math.max(0, Math.min(insertIndex, target.tab.items.length));
            target.tab.items.splice(clamped, 0, itemHrid);
        } else {
            target.tab.items.push(itemHrid);
        }
        clearItemTombstone(c, targetTabId, itemHrid);
        stampTab(c, targetTabId, now);
    }
    return c;
}

/**
 * Append a line break sentinel to a tab's items array.
 * Multiple line breaks are allowed, so no duplicate check is performed.
 * @param {Object} config
 * @param {string} tabId
 * @returns {Object} new config
 */
export function addLineBreak(config, tabId) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) {
        result.tab.items.push(LINEBREAK_HRID);
        stampTab(c, tabId);
    }
    return c;
}

/**
 * Reorder an item within a tab's items array
 * @param {Object} config
 * @param {string} tabId
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {Object} new config
 */
export function reorderItem(config, tabId, fromIndex, toIndex) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;
    const items = result.tab.items;
    if (fromIndex < 0 || fromIndex >= items.length) return c;
    const clamped = Math.max(0, Math.min(toIndex, items.length - 1));
    const [moved] = items.splice(fromIndex, 1);
    items.splice(clamped, 0, moved);
    stampTab(c, tabId);
    return c;
}

/**
 * Remove an item from a tab
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} new config
 */
export function removeItem(config, tabId, itemHrid) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) {
        const now = Date.now();
        result.tab.items = result.tab.items.filter((h) => h !== itemHrid);
        tombstoneItem(c, tabId, itemHrid, now);
        stampTab(c, tabId, now);
    }
    return c;
}

/**
 * Remove a single item at a specific index from a tab.
 * Preferred over removeItem when duplicates may exist (e.g. line breaks).
 * @param {Object} config
 * @param {string} tabId
 * @param {number} index
 * @returns {Object} new config
 */
export function removeItemAtIndex(config, tabId, index) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result && index >= 0 && index < result.tab.items.length) {
        const now = Date.now();
        const [gone] = result.tab.items.splice(index, 1);
        tombstoneItem(c, tabId, gone, now);
        stampTab(c, tabId, now);
    }
    return c;
}

/**
 * Toggle a tree node open/closed.
 *
 * Deliberately unstamped: which nodes are expanded is where the user is
 * looking, not what the tab holds, and stamping it would let a collapse on one
 * device outrank a real edit on another.
 * @param {Object} config
 * @param {string} tabId
 * @param {boolean} open
 * @returns {Object} new config
 */
export function setTabOpen(config, tabId, open) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) result.tab.open = open;
    return c;
}

/**
 * Set the open state on every tab in the tree (including nested children).
 * Unstamped for the same reason as `setTabOpen`.
 * @param {Object} config
 * @param {boolean} open
 * @returns {Object} new config
 */
export function setAllTabsOpen(config, open) {
    const c = clone(config);
    const walk = (tabs) => {
        for (const tab of tabs) {
            tab.open = open;
            if (tab.children?.length) walk(tab.children);
        }
    };
    walk(c.tabs);
    return c;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Depth-first search for a tab by ID
 * @param {Object} config
 * @param {string} tabId
 * @returns {{ tab: Object, parent: Object|null } | null}
 */
export function findTab(config, tabId) {
    return _findNode(config.tabs, tabId);
}

/**
 * Collect all assigned itemHrids across every tab
 * @param {Object} config
 * @returns {Set<string>}
 */
export function getAssignedItemSet(config) {
    const set = new Set();
    _walkTabs(config.tabs, (tab) => {
        for (const hrid of tab.items) {
            if (hrid !== LINEBREAK_HRID) set.add(hrid);
        }
    });
    return set;
}

/**
 * Collect itemHrids from a tab and all its descendants
 * @param {Object} tab - A single TabNode
 * @returns {Set<string>}
 */
export function collectTabItems(tab) {
    const set = new Set();
    _walkTabs([tab], (t) => {
        for (const hrid of t.items) set.add(hrid);
    });
    return set;
}

/**
 * Collect itemHrids from every tab that appears above a tab in the panel's
 * top-to-bottom display order (depth-first pre-order). The tab itself, its
 * descendants, and everything below it are not included.
 * @param {Object} config
 * @param {string} tabId
 * @returns {Set<string>}
 */
export function collectItemsAboveTab(config, tabId) {
    const set = new Set();
    let found = false;
    const walk = (tabs) => {
        for (const tab of tabs) {
            if (found) return;
            if (tab.id === tabId) {
                found = true;
                return;
            }
            for (const hrid of tab.items) {
                if (hrid !== LINEBREAK_HRID) set.add(hrid);
            }
            if (tab.children.length > 0) walk(tab.children);
        }
    };
    walk(config.tabs);
    return set;
}

// ---------------------------------------------------------------------------
// Loadout binding helpers
// ---------------------------------------------------------------------------

/**
 * Strip the +N enhancement suffix from an HRID to get the base item
 * @param {string} hrid - e.g. "/items/sword+3"
 * @returns {string} e.g. "/items/sword"
 */
export function getBaseHrid(hrid) {
    const plusIdx = hrid.lastIndexOf('+');
    if (plusIdx === -1) return hrid;
    const suffix = hrid.substring(plusIdx + 1);
    return /^\d+$/.test(suffix) ? hrid.substring(0, plusIdx) : hrid;
}

/**
 * Record which items were added from a loadout
 * @param {Object} config
 * @param {string} tabId
 * @param {string} loadoutName
 * @param {string[]} items - HRIDs added from this loadout
 * @returns {Object} new config
 */
export function addLoadoutBinding(config, tabId, loadoutName, items) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;
    if (!result.tab.loadoutBindings) result.tab.loadoutBindings = {};
    const existing = result.tab.loadoutBindings[loadoutName] || [];
    // Merge new items into the binding (avoid duplicates)
    const merged = new Set(existing);
    for (const h of items) merged.add(h);
    result.tab.loadoutBindings[loadoutName] = [...merged];
    return c;
}

/**
 * Remove a specific item from all loadout bindings in a tab
 * Called when the user manually removes an item via the UI
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} new config
 */
export function removeItemFromBindings(config, tabId, itemHrid) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result || !result.tab.loadoutBindings) return c;
    for (const [name, items] of Object.entries(result.tab.loadoutBindings)) {
        result.tab.loadoutBindings[name] = items.filter((h) => h !== itemHrid);
        // Clean up empty bindings
        if (result.tab.loadoutBindings[name].length === 0) {
            delete result.tab.loadoutBindings[name];
        }
    }
    return c;
}

/**
 * Check whether any other loadout binding on the tab still references an item
 * @param {Object} tab
 * @param {string} excludeLoadoutName - Binding to skip (the one being synced)
 * @param {string} itemHrid
 * @returns {boolean}
 */
function isBoundElsewhere(tab, excludeLoadoutName, itemHrid) {
    for (const [name, items] of Object.entries(tab.loadoutBindings || {})) {
        if (name === excludeLoadoutName) continue;
        if (items.includes(itemHrid)) return true;
    }
    return false;
}

/**
 * Sync a tab's loadout binding against a new snapshot.
 * Matches items by base HRID to detect enhancement level changes.
 * Items still referenced by another binding on the same tab are preserved.
 * @param {Object} config
 * @param {string} tabId
 * @param {string} loadoutName
 * @param {string[]} newSnapshotItems - Current items from the loadout snapshot
 * @returns {{ config: Object, changed: boolean }}
 */
export function syncLoadoutBinding(config, tabId, loadoutName, newSnapshotItems) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result || !result.tab.loadoutBindings?.[loadoutName]) {
        return { config: c, changed: false };
    }

    const tab = result.tab;
    const oldBound = tab.loadoutBindings[loadoutName];
    const oldByBase = new Map(oldBound.map((h) => [getBaseHrid(h), h]));
    const newByBase = new Map(newSnapshotItems.map((h) => [getBaseHrid(h), h]));
    let changed = false;

    // Enhancement level changed → swap in items[]
    for (const [base, newHrid] of newByBase) {
        const oldHrid = oldByBase.get(base);
        if (oldHrid && oldHrid !== newHrid) {
            const idx = tab.items.indexOf(oldHrid);
            if (idx === -1) continue;
            if (isBoundElsewhere(tab, loadoutName, oldHrid)) {
                // Another loadout on this tab still uses the old item — keep it
                // and add the new one alongside
                if (!tab.items.includes(newHrid)) {
                    tab.items.push(newHrid);
                    clearItemTombstone(c, tabId, newHrid);
                    changed = true;
                }
            } else if (tab.items.includes(newHrid)) {
                tab.items.splice(idx, 1);
                tombstoneItem(c, tabId, oldHrid);
                changed = true;
            } else {
                tab.items[idx] = newHrid;
                tombstoneItem(c, tabId, oldHrid);
                clearItemTombstone(c, tabId, newHrid);
                changed = true;
            }
        }
    }

    // Items removed from loadout → remove from items[] unless another binding
    // on this tab still references them
    for (const [base, oldHrid] of oldByBase) {
        if (newByBase.has(base)) continue;
        if (isBoundElsewhere(tab, loadoutName, oldHrid)) continue;
        const filtered = tab.items.filter((h) => h !== oldHrid);
        if (filtered.length !== tab.items.length) {
            tab.items = filtered;
            tombstoneItem(c, tabId, oldHrid);
            changed = true;
        }
    }

    // Items added to loadout → append to items[]
    for (const [base, newHrid] of newByBase) {
        if (!oldByBase.has(base) && !tab.items.includes(newHrid)) {
            tab.items.push(newHrid);
            clearItemTombstone(c, tabId, newHrid);
            changed = true;
        }
    }

    // Update binding to reflect new state
    tab.loadoutBindings[loadoutName] = [...newSnapshotItems];
    return { config: c, changed };
}

/**
 * Remove orphaned bindings (loadout no longer exists) and their exclusive items.
 * Items that appear in other remaining bindings are preserved.
 * @param {Object} config
 * @param {string} tabId
 * @param {Set<string>} currentSnapshotNames - Set of loadout names that currently exist
 * @returns {{ config: Object, changed: boolean }}
 */
export function cleanOrphanedBindings(config, tabId, currentSnapshotNames) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result || !result.tab.loadoutBindings) return { config: c, changed: false };

    const tab = result.tab;
    const orphanedNames = Object.keys(tab.loadoutBindings).filter((n) => !currentSnapshotNames.has(n));
    if (orphanedNames.length === 0) return { config: c, changed: false };

    // Collect items still tracked by non-orphaned bindings
    const stillBound = new Set();
    for (const [name, items] of Object.entries(tab.loadoutBindings)) {
        if (!orphanedNames.includes(name)) {
            items.forEach((h) => stillBound.add(h));
        }
    }

    // Remove orphaned bindings and their exclusive items
    for (const orphanName of orphanedNames) {
        const orphanItems = tab.loadoutBindings[orphanName] || [];
        for (const hrid of orphanItems) {
            if (!stillBound.has(hrid)) {
                const shorter = tab.items.filter((h) => h !== hrid);
                if (shorter.length !== tab.items.length) tombstoneItem(c, tabId, hrid);
                tab.items = shorter;
            }
        }
        delete tab.loadoutBindings[orphanName];
    }

    return { config: c, changed: true };
}

// ---------------------------------------------------------------------------
// Internal tree traversal helpers
// ---------------------------------------------------------------------------

/**
 * Find a node by id in a tab tree, returning { tab, parent }
 * @param {Array} tabs
 * @param {string} id
 * @param {Object|null} parent
 * @returns {{ tab: Object, parent: Object|null } | null}
 */
function _findNode(tabs, id, parent = null) {
    for (const tab of tabs) {
        if (tab.id === id) return { tab, parent };
        if (tab.children.length > 0) {
            const found = _findNode(tab.children, id, tab);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Remove a node by id from a tab tree (mutates the array)
 * @param {Array} tabs
 * @param {string} id
 * @returns {boolean} true if removed
 */
function _removeFromArray(tabs, id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx !== -1) {
        tabs.splice(idx, 1);
        return true;
    }
    for (const tab of tabs) {
        if (_removeFromArray(tab.children, id)) return true;
    }
    return false;
}

/**
 * Walk all tabs depth-first, calling fn(tab) on each
 * @param {Array} tabs
 * @param {Function} fn
 */
function _walkTabs(tabs, fn) {
    for (const tab of tabs) {
        fn(tab);
        if (tab.children.length > 0) _walkTabs(tab.children, fn);
    }
}
