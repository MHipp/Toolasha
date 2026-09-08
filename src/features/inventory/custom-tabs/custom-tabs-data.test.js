/**
 * Tests for custom tabs loadout binding sync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    syncLoadoutBinding,
    cleanOrphanedBindings,
    getBaseHrid,
    collectItemsAboveTab,
    getAssignedItemSet,
    LINEBREAK_HRID,
    TOMBSTONE_MAX_AGE_MS,
    loadConfig,
    saveConfig,
    flushConfigWrites,
    addTab,
    removeTab,
    renameTab,
    setTabColor,
    moveTab,
    addItem,
    insertItem,
    moveItem,
    addLineBreak,
    reorderItem,
    removeItem,
    removeItemAtIndex,
    setTabOpen,
    setAllTabsOpen,
    findTab,
    sanitizeImportedConfig,
    tombstoneItem,
    MAX_ITEM_TOMBSTONES,
    _resetConfigRecords,
} = await import('./custom-tabs-data.js');

function buildConfig(tab) {
    return {
        version: 1,
        selectedTabId: null,
        tabs: [{ children: [], ...tab }],
    };
}

describe('getBaseHrid', () => {
    test('strips numeric enhancement suffix', () => {
        expect(getBaseHrid('/items/sword+7')).toBe('/items/sword');
    });

    test('leaves plain hrids untouched', () => {
        expect(getBaseHrid('/items/sword')).toBe('/items/sword');
    });
});

describe('collectItemsAboveTab', () => {
    const config = {
        version: 1,
        selectedTabId: null,
        tabs: [
            { id: 'currency', items: ['/items/token', LINEBREAK_HRID], children: [] },
            {
                id: 'loot',
                items: ['/items/hat'],
                children: [{ id: 'loot-child', items: ['/items/ring+5'], children: [] }],
            },
            { id: 'resources', items: ['/items/log'], children: [] },
            { id: 'junk', items: ['/items/scrap'], children: [] },
        ],
    };

    test('collects items from every tab above, not the tab itself or tabs below', () => {
        const above = collectItemsAboveTab(config, 'resources');
        expect(above).toEqual(new Set(['/items/token', '/items/hat', '/items/ring+5']));
    });

    test('a child tab sees its parent and earlier tabs as above', () => {
        const above = collectItemsAboveTab(config, 'loot-child');
        expect(above).toEqual(new Set(['/items/token', '/items/hat']));
    });

    test('the first tab has nothing above it', () => {
        expect(collectItemsAboveTab(config, 'currency').size).toBe(0);
    });

    test('excludes line break sentinels', () => {
        expect(collectItemsAboveTab(config, 'loot').has(LINEBREAK_HRID)).toBe(false);
    });
});

describe('syncLoadoutBinding', () => {
    test('removes an item replaced in the loadout', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/ring_a+5', '/items/hat'],
            loadoutBindings: { Zone1: ['/items/ring_a+5', '/items/hat'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', [
            '/items/ring_b+5',
            '/items/hat',
        ]);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).not.toContain('/items/ring_a+5');
        expect(next.tabs[0].items).toContain('/items/ring_b+5');
    });

    test('keeps a replaced item still referenced by another binding on the tab', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/ring_a+5', '/items/hat'],
            loadoutBindings: {
                Zone1: ['/items/ring_a+5', '/items/hat'],
                Zone2: ['/items/ring_a+5'],
            },
        });

        // Zone1 replaces ring_a with ring_b; Zone2 still uses ring_a
        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', [
            '/items/ring_b+5',
            '/items/hat',
        ]);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/ring_a+5');
        expect(next.tabs[0].items).toContain('/items/ring_b+5');
        expect(next.tabs[0].loadoutBindings.Zone2).toContain('/items/ring_a+5');
    });

    test('keeps an old enhancement level still referenced by another binding', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8'],
            loadoutBindings: {
                Zone1: ['/items/sword+8'],
                Zone2: ['/items/sword+8'],
            },
        });

        // Zone1 bumps the sword to +10; Zone2 still uses the +8
        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/sword+8');
        expect(next.tabs[0].items).toContain('/items/sword+10');
    });

    test('swaps enhancement level in place when no other binding references it', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8'],
            loadoutBindings: { Zone1: ['/items/sword+8'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/sword+10']);
    });

    test('does not duplicate when the new level already exists in the tab', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8', '/items/sword+10'],
            loadoutBindings: { Zone1: ['/items/sword+8'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/sword+10']);
    });

    test('appends items newly added to the loadout', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat'],
            loadoutBindings: { Zone1: ['/items/hat'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/hat', '/items/boots+3']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/boots+3');
        expect(next.tabs[0].loadoutBindings.Zone1).toEqual(['/items/hat', '/items/boots+3']);
    });

    test('reports no change when the snapshot matches the binding', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat'],
            loadoutBindings: { Zone1: ['/items/hat'] },
        });

        const { changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/hat']);

        expect(changed).toBe(false);
    });
});

describe('cleanOrphanedBindings', () => {
    test('removes orphaned binding items unless still bound elsewhere', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat', '/items/ring_a+5'],
            loadoutBindings: {
                Deleted: ['/items/hat', '/items/ring_a+5'],
                Kept: ['/items/hat'],
            },
        });

        const { config: next, changed } = cleanOrphanedBindings(config, 'tab1', new Set(['Kept']));

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/hat']);
        expect(next.tabs[0].loadoutBindings.Deleted).toBeUndefined();
        expect(next.tabs[0].loadoutBindings.Kept).toEqual(['/items/hat']);
    });
});

describe('the stored config', () => {
    const KEY = 'char1_inventoryTabs_config';
    const stored = () => storageMock.storeFor('settings').get(KEY);
    const tab = (id, items = []) => ({ id, name: id, items, children: [] });

    beforeEach(() => {
        storageMock.reset();
    });

    test('lives under the key it has always had, and reads back what was saved', async () => {
        await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: 'a' });
        await flushConfigWrites();
        expect(stored().tabs.map((t) => t.id)).toEqual(['a']);

        const config = await loadConfig('char1');
        expect(config).toEqual({ version: 1, tabs: [tab('a')], selectedTabId: 'a' });
    });

    test('a character with nothing stored starts from the default', async () => {
        expect(await loadConfig('char1')).toEqual({ version: 1, tabs: [], selectedTabId: null });
        expect(await loadConfig('')).toEqual({ version: 1, tabs: [], selectedTabId: null });
    });

    test('a load that cannot be made keeps the config in hand rather than blanking it', async () => {
        storageMock.storeFor('settings').set(KEY, { version: 1, tabs: [tab('a')], selectedTabId: null });
        const first = await loadConfig('char1');
        expect(first.tabs).toHaveLength(1);

        storageMock.unavailable = true;
        const again = await loadConfig('char1');
        expect(again.tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('a save over a store that cannot be read is skipped, and what is stored stays', async () => {
        storageMock.storeFor('settings').set(KEY, { version: 1, tabs: [tab('a')], selectedTabId: null });
        storageMock.unavailable = true;
        await loadConfig('char1');
        expect(await saveConfig('char1', { version: 1, tabs: [], selectedTabId: null })).toBe(false);

        storageMock.unavailable = false;
        expect(stored().tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('a save before the config was read back loses no stored tab', async () => {
        storageMock.storeFor('settings').set(KEY, { version: 1, tabs: [tab('a')], selectedTabId: null });
        storageMock.unavailable = true;
        await loadConfig('char1');
        storageMock.unavailable = false;

        // Built against an empty-looking config, because the read never landed
        await saveConfig('char1', { version: 1, tabs: [tab('b')], selectedTabId: 'b' });
        await flushConfigWrites();

        expect(
            stored()
                .tabs.map((t) => t.id)
                .sort()
        ).toEqual(['a', 'b']);
        expect(stored().selectedTabId).toBe('b');
    });

    test('after a readable load a removed tab stays removed', async () => {
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            tabs: [tab('a'), tab('b')],
            selectedTabId: null,
        });
        const config = await loadConfig('char1');
        await saveConfig('char1', { ...config, tabs: config.tabs.filter((t) => t.id !== 'a') });
        await flushConfigWrites();

        expect(stored().tabs.map((t) => t.id)).toEqual(['b']);
    });

    test('once storage is back, the next save lands', async () => {
        storageMock.unavailable = true;
        await loadConfig('char1');
        expect(await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: null })).toBe(false);

        storageMock.unavailable = false;
        expect(await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: null })).toBe(true);
        expect(stored().tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('each character has its own config', async () => {
        await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: null });
        await saveConfig('char2', { version: 1, tabs: [tab('z')], selectedTabId: null });
        await flushConfigWrites();

        expect((await loadConfig('char1')).tabs.map((t) => t.id)).toEqual(['a']);
        expect((await loadConfig('char2')).tabs.map((t) => t.id)).toEqual(['z']);
        expect(storageMock.storeFor('settings').has('char2_inventoryTabs_config')).toBe(true);
    });
});

describe('the sync merge', () => {
    test('a pull folds the gist copy in instead of replacing the key', async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'char1_inventoryTabs_config');
        expect(registration).toBeTruthy();

        const local = {
            version: 1,
            selectedTabId: 'b',
            tabs: [
                { id: 'a', name: 'Ores (renamed here)', items: ['/items/iron_ore'] },
                { id: 'b', name: 'New tab the gist never saw', items: [] },
            ],
        };
        const incoming = {
            version: 1,
            selectedTabId: 'a',
            tabs: [
                { id: 'a', name: 'Ores', items: [] },
                { id: 'c', name: 'Tab only the other device has', items: [] },
            ],
        };

        const merged = registration.merge(local, incoming);
        const ids = merged.tabs.map((tab) => tab.id).sort();

        // Union keeps everything either side has; the local copy wins per id
        expect(ids).toEqual(['a', 'b', 'c']);
        expect(merged.tabs.find((tab) => tab.id === 'a').name).toBe('Ores (renamed here)');
        expect(merged.selectedTabId).toBe('b');
    });

    test('a blank local side adopts the gist copy whole', async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'char9_inventoryTabs_config');

        const merged = registration.merge(
            { version: 1, tabs: [], selectedTabId: null },
            { version: 1, tabs: [{ id: 'x', name: 'Kept', items: [] }], selectedTabId: 'x' }
        );

        expect(merged.tabs.map((tab) => tab.id)).toEqual(['x']);
        expect(merged.selectedTabId).toBe('x');
    });
});

describe('modification stamps', () => {
    const node = (id, extra = {}) => ({
        id,
        name: id,
        color: null,
        open: false,
        items: [],
        children: [],
        ...extra,
    });
    const base = () => ({
        version: 1,
        selectedTabId: null,
        tabs: [node('a', { items: ['/items/hat', '/items/boots'] }), node('b')],
    });
    const stampOf = (config, id) => findTab(config, id)?.tab.updatedAt;

    test.each([
        ['renameTab', (c) => renameTab(c, 'a', 'Renamed')],
        ['setTabColor', (c) => setTabColor(c, 'a', '#fff')],
        ['addItem', (c) => addItem(c, 'a', '/items/ore')],
        ['insertItem', (c) => insertItem(c, 'a', '/items/ore', 0)],
        ['addLineBreak', (c) => addLineBreak(c, 'a')],
        ['reorderItem', (c) => reorderItem(c, 'a', 0, 1)],
        ['removeItem', (c) => removeItem(c, 'a', '/items/hat')],
        ['removeItemAtIndex', (c) => removeItemAtIndex(c, 'a', 0)],
    ])('%s stamps the tab it changed', (_name, mutate) => {
        const before = Date.now();
        const next = mutate(base());
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
        // Untouched tabs stay as they were
        expect(stampOf(next, 'b')).toBeUndefined();
    });

    test('addTab stamps the new tab, and its parent when it is nested', () => {
        const before = Date.now();
        const { config: rooted, tabId } = addTab(base(), null, 'Root tab');
        expect(stampOf(rooted, tabId)).toBeGreaterThanOrEqual(before);
        expect(stampOf(rooted, 'a')).toBeUndefined();

        const { config: nested, tabId: childId } = addTab(base(), 'a', 'Child');
        expect(stampOf(nested, childId)).toBeGreaterThanOrEqual(before);
        expect(stampOf(nested, 'a')).toBeGreaterThanOrEqual(before);
    });

    test('moveItem stamps both the source and the target tab', () => {
        const before = Date.now();
        const next = moveItem(base(), 'a', 'b', '/items/hat');
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
        expect(stampOf(next, 'b')).toBeGreaterThanOrEqual(before);
    });

    test('an edit to a nested tab stamps the root that carries it', () => {
        const { config, tabId } = addTab(base(), 'a', 'Child');
        const before = Date.now();
        const next = renameTab({ ...config, tabs: config.tabs.map((t) => ({ ...t })) }, tabId, 'New name');
        expect(stampOf(next, tabId)).toBeGreaterThanOrEqual(before);
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
    });

    test('moveTab stamps the list, not the tab', () => {
        const before = Date.now();
        const next = moveTab(base(), 'b', 0);
        expect(next.tabs.map((t) => t.id)).toEqual(['b', 'a']);
        expect(next.orderUpdatedAt).toBeGreaterThanOrEqual(before);
        expect(stampOf(next, 'a')).toBeUndefined();
        expect(stampOf(next, 'b')).toBeUndefined();
    });

    test('opening and closing tabs is not a modification', () => {
        const opened = setTabOpen(base(), 'a', true);
        expect(opened.tabs[0].open).toBe(true);
        expect(stampOf(opened, 'a')).toBeUndefined();
        expect(opened.orderUpdatedAt).toBeUndefined();

        const all = setAllTabsOpen(base(), true);
        expect(all.tabs.every((t) => t.updatedAt === undefined)).toBe(true);
    });

    test('removeTab records a tombstone for the tab and its descendants', () => {
        const { config: withChild, tabId: childId } = addTab(base(), 'a', 'Child');
        const before = Date.now();
        const next = removeTab(withChild, 'a');

        expect(next.tabs.map((t) => t.id)).toEqual(['b']);
        expect(next.removed.a).toBeGreaterThanOrEqual(before);
        expect(next.removed[childId]).toBeGreaterThanOrEqual(before);
        expect(next.removed.b).toBeUndefined();
    });

    test('removeTab of a nested tab stamps the parent that lost it', () => {
        const { config: withChild, tabId: childId } = addTab(base(), 'a', 'Child');
        const before = Date.now();
        const next = removeTab(withChild, childId);
        expect(findTab(next, childId)).toBeNull();
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
        expect(next.removed[childId]).toBeGreaterThanOrEqual(before);
    });

    test('a re-created id outlives its own tombstone', () => {
        const removedConfig = removeTab(base(), 'a');
        const { config, tabId } = addTab(removedConfig, null, 'Fresh');
        expect(config.removed[tabId]).toBeUndefined();
        expect(config.removed.a).toBeDefined();
    });
});

describe('the merge with stamps and tombstones', () => {
    const tab = (id, extra = {}) => ({ id, name: id, items: [], children: [], ...extra });

    let merge;
    beforeEach(async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        // The registry hands (local, incoming) and local is the side that wins ties
        merge = mergeForKey('settings', 'char1_inventoryTabs_config').merge;
    });

    test('a newer remote rename beats an older local copy', () => {
        const local = { version: 1, tabs: [tab('a', { name: 'Here', updatedAt: 100 })], selectedTabId: null };
        const incoming = { version: 1, tabs: [tab('a', { name: 'There', updatedAt: 200 })], selectedTabId: null };
        expect(merge(local, incoming).tabs[0].name).toBe('There');
    });

    test('an older remote rename loses', () => {
        const local = { version: 1, tabs: [tab('a', { name: 'Here', updatedAt: 300 })], selectedTabId: null };
        const incoming = { version: 1, tabs: [tab('a', { name: 'There', updatedAt: 200 })], selectedTabId: null };
        expect(merge(local, incoming).tabs[0].name).toBe('Here');
    });

    test('a stamped copy beats an unstamped one, whichever side it is on', () => {
        const stamped = { version: 1, tabs: [tab('a', { name: 'Stamped', updatedAt: 5 })], selectedTabId: null };
        const bare = { version: 1, tabs: [tab('a', { name: 'Bare' })], selectedTabId: null };
        expect(merge(bare, stamped).tabs[0].name).toBe('Stamped');
        expect(merge(stamped, bare).tabs[0].name).toBe('Stamped');
    });

    test('two unstamped copies keep ours', () => {
        const local = { version: 1, tabs: [tab('a', { name: 'Ours' })], selectedTabId: null };
        const incoming = { version: 1, tabs: [tab('a', { name: 'Theirs' })], selectedTabId: null };
        expect(merge(local, incoming).tabs[0].name).toBe('Ours');
    });

    test('a deletion newer than the tab sticks, in both directions', () => {
        const deleted = { version: 1, tabs: [], selectedTabId: null, removed: { a: 500 } };
        const carrier = { version: 1, tabs: [tab('a', { updatedAt: 100 })], selectedTabId: null };

        // Deleted locally, the other device still carries it
        const kept = merge(deleted, carrier);
        expect(kept.tabs).toEqual([]);
        expect(kept.removed).toEqual({ a: 500 });

        // Deleted remotely, this device still carries it — same answer
        const swapped = merge(carrier, deleted);
        expect(swapped.tabs).toEqual([]);
        expect(swapped.removed).toEqual({ a: 500 });
    });

    test('a tab edited after the deletion survives and drops the tombstone', () => {
        const deleted = { version: 1, tabs: [], selectedTabId: null, removed: { a: 500 } };
        const revived = { version: 1, tabs: [tab('a', { name: 'Back', updatedAt: 900 })], selectedTabId: null };

        for (const merged of [merge(deleted, revived), merge(revived, deleted)]) {
            expect(merged.tabs.map((t) => t.id)).toEqual(['a']);
            expect(merged.tabs[0].name).toBe('Back');
            expect(merged.removed).toBeUndefined();
        }
    });

    test('a tombstone reaches a nested tab too', () => {
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('root', { updatedAt: 900, children: [tab('kid', { updatedAt: 100 })] })],
        };
        const deleted = { version: 1, tabs: [], selectedTabId: null, removed: { kid: 500 } };
        const merged = merge(carrier, deleted);
        expect(merged.tabs.map((t) => t.id)).toEqual(['root']);
        expect(merged.tabs[0].children).toEqual([]);
    });

    test('tombstones union to the newest deletion per id', () => {
        const older = { version: 1, tabs: [], selectedTabId: null, removed: { a: 100, b: 700 } };
        const newer = { version: 1, tabs: [], selectedTabId: null, removed: { a: 400 } };
        expect(merge(older, newer).removed).toEqual({ a: 400, b: 700 });
    });

    test('order comes from the side with the newer orderUpdatedAt', () => {
        const local = {
            version: 1,
            selectedTabId: null,
            orderUpdatedAt: 100,
            tabs: [tab('a'), tab('b'), tab('c')],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            orderUpdatedAt: 900,
            tabs: [tab('c'), tab('b'), tab('a'), tab('d')],
        };

        const merged = merge(local, incoming);
        // Remote reordered last, and the id only it has appends after
        expect(merged.tabs.map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']);
        expect(merged.orderUpdatedAt).toBe(900);

        // The other way round: local reordered last
        const localLatest = { ...local, orderUpdatedAt: 1000 };
        expect(merge(localLatest, incoming).tabs.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('without orderUpdatedAt the order is stored-then-new, as it always was', () => {
        const local = { version: 1, selectedTabId: null, tabs: [tab('b'), tab('z')] };
        const incoming = { version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] };
        // mergeConfigs(incoming, local): incoming is "stored", so its order leads
        expect(merge(local, incoming).tabs.map((t) => t.id)).toEqual(['a', 'b', 'z']);
    });

    test('selectedTabId falls back when its tab was tombstoned', () => {
        const local = { version: 1, selectedTabId: 'a', tabs: [tab('a', { updatedAt: 100 })] };
        const incoming = { version: 1, selectedTabId: 'b', tabs: [tab('b')], removed: { a: 500 } };
        expect(merge(local, incoming).selectedTabId).toBe('b');

        const nothingLeft = { version: 1, selectedTabId: 'b', tabs: [], removed: { a: 500, b: 500 } };
        expect(merge(local, nothingLeft).selectedTabId).toBeNull();
    });

    test('a config with none of the new fields merges to exactly the old shape', () => {
        const local = {
            version: 1,
            selectedTabId: 'b',
            tabs: [
                { id: 'a', name: 'Ores (renamed here)', items: ['/items/iron_ore'] },
                { id: 'b', name: 'New tab the gist never saw', items: [] },
            ],
        };
        const incoming = {
            version: 1,
            selectedTabId: 'a',
            tabs: [
                { id: 'a', name: 'Ores', items: [] },
                { id: 'c', name: 'Tab only the other device has', items: [] },
            ],
        };

        const merged = merge(local, incoming);
        expect(merged).toEqual({
            version: 1,
            selectedTabId: 'b',
            // Stored order leads, ids only the local side has append after
            tabs: [local.tabs[0], incoming.tabs[1], local.tabs[1]],
        });
        expect(Object.keys(merged).sort()).toEqual(['selectedTabId', 'tabs', 'version']);
    });
});

describe('tombstone pruning', () => {
    const KEY = 'char1_inventoryTabs_config';

    beforeEach(() => {
        storageMock.reset();
    });

    /**
     * Five stamped tabs and four tombstones trips the mass-delete cap, which
     * holds the tombstones back un-applied — the one situation in which a
     * tombstone is still live after a load, and so the one that can show the
     * age prune and the dead prune apart.
     */
    const cappedConfig = (removed) => ({
        version: 1,
        selectedTabId: null,
        tabs: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
            id,
            name: id,
            items: [],
            children: [],
            updatedAt: 100,
        })),
        removed,
    });

    test('a load forgets deletions older than the max age and keeps the rest', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const now = Date.now();
        storageMock
            .storeFor('settings')
            .set(
                KEY,
                cappedConfig({ a: now - TOMBSTONE_MAX_AGE_MS - 1000, b: now - 1000, c: now - 2000, d: now - 3000 })
            );

        const config = await loadConfig('char1');
        expect(config.removed).toEqual({ b: now - 1000, c: now - 2000, d: now - 3000 });
        warn.mockRestore();
    });

    test('a load KEEPS a deletion for an id the config no longer carries', async () => {
        // That tombstone is the record of the deletion - the one thing that
        // stops a peer device's sync push from reviving the tab. Only age
        // forgets it.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const now = Date.now();
        storageMock
            .storeFor('settings')
            .set(KEY, cappedConfig({ a: now - 10, b: now - 10, c: now - 10, ghost: now - 1000 }));

        const config = await loadConfig('char1');
        expect(config.removed).toEqual({ a: now - 10, b: now - 10, c: now - 10, ghost: now - 1000 });
        warn.mockRestore();
    });

    test('a load with every tombstone expired drops the map entirely', async () => {
        const now = Date.now();
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [],
            removed: { stale: now - TOMBSTONE_MAX_AGE_MS - 1 },
        });

        expect(await loadConfig('char1')).toEqual({ version: 1, selectedTabId: null, tabs: [] });
    });

    test('a load keeps a fresh tombstone whose tab is already gone', async () => {
        // The absent id is not dead weight: it is what a peer device's copy of
        // the deleted tab will be folded against. Only the age prune ends it.
        const now = Date.now();
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [{ id: 'here', name: 'Here', items: [], children: [], updatedAt: now }],
            removed: { gone: now - 1000 },
        });

        const config = await loadConfig('char1');
        expect(config.tabs.map((t) => t.id)).toEqual(['here']);
        expect(config.removed).toEqual({ gone: now - 1000 });
    });
});

// -------------------------------------------------------------------------
// FIX 1 — a tombstone must never delete an unstamped tab
// -------------------------------------------------------------------------

describe('tombstones against unstamped tabs', () => {
    const KEY = 'char1_inventoryTabs_config';
    const tab = (id, extra = {}) => ({ id, name: id, items: [], children: [], ...extra });

    let merge;
    beforeEach(async () => {
        storageMock.reset();
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        merge = mergeForKey('settings', KEY).merge;
    });

    test('an unstamped tab survives a tombstone, and the tombstone is dropped', () => {
        // stampOf() is 0 for every tab written before stamps existed, and a
        // deletedAt is a Date.now()-scale number, so the old rule made EVERY
        // tombstone beat EVERY legacy tab
        const carrier = { version: 1, selectedTabId: null, tabs: [tab('a')] };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { a: Date.now() } };

        for (const merged of [merge(carrier, deleted), merge(deleted, carrier)]) {
            expect(merged.tabs.map((t) => t.id)).toEqual(['a']);
            expect(merged.removed).toBeUndefined();
        }
    });

    test('an unstamped NESTED tab survives a tombstone too', () => {
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('root', { updatedAt: 900, children: [tab('kid')] })],
        };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { kid: 500 } };
        const merged = merge(carrier, deleted);
        expect(merged.tabs[0].children.map((t) => t.id)).toEqual(['kid']);
        expect(merged.removed).toBeUndefined();
    });

    test('a revived subtree comes back whole, untouched siblings included', () => {
        // removeTab tombstones the root and every descendant at one instant, so
        // when the root's tombstone turns out to be stale the siblings' are too.
        // Comparing each child against its own stamp brought the root back
        // carrying only the child that happened to be edited.
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [
                tab('root', {
                    updatedAt: 400,
                    children: [tab('kid', { updatedAt: 400 }), tab('sib', { updatedAt: 100 })],
                }),
            ],
        };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { root: 300, kid: 300, sib: 300 } };

        for (const merged of [merge(carrier, deleted), merge(deleted, carrier)]) {
            expect(merged.tabs.map((t) => t.id)).toEqual(['root']);
            expect(merged.tabs[0].children.map((t) => t.id)).toEqual(['kid', 'sib']);
            expect(merged.removed).toBeUndefined();
        }
    });

    test('a LATER deletion of one child still applies after the subtree is revived', () => {
        // The revival only excuses the tombstones of the removal it undid — a
        // deletion recorded after the revival is an independent one
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [
                tab('root', {
                    updatedAt: 400,
                    children: [tab('kid', { updatedAt: 400 }), tab('sib', { updatedAt: 100 })],
                }),
            ],
        };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { root: 300, sib: 600 } };
        const merged = merge(carrier, deleted);
        expect(merged.tabs[0].children.map((t) => t.id)).toEqual(['kid']);
        expect(merged.removed).toEqual({ sib: 600 });
    });

    test('a stamped tab older than the tombstone is still deleted', () => {
        const carrier = { version: 1, selectedTabId: null, tabs: [tab('a', { updatedAt: 100 })] };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { a: 500 } };
        expect(merge(carrier, deleted).tabs).toEqual([]);
    });

    test('regression: a stored config of unstamped tabs plus a removed map naming them loads intact', async () => {
        // The reported loss, exactly: pre-3.22.0 tabs on disk, a tombstone map
        // naming them, and loadConfig — not a sync — pruning them at page load
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: 'ores',
            tabs: [
                { id: 'ores', name: 'Ores', items: ['/items/iron_ore'], children: [] },
                { id: 'gear', name: 'Gear', items: [], children: [{ id: 'weapons', name: 'W', items: [] }] },
            ],
            removed: { ores: Date.now(), weapons: Date.now() },
        });

        const config = await loadConfig('char1');
        expect(config.tabs.map((t) => t.id)).toEqual(['ores', 'gear']);
        expect(config.tabs[1].children.map((t) => t.id)).toEqual(['weapons']);
        expect(config.selectedTabId).toBe('ores');
        expect(config.removed).toBeUndefined();
    });
});

// -------------------------------------------------------------------------
// FIX 2 — one fold may not empty a curated list
// -------------------------------------------------------------------------

describe('the mass-delete cap', () => {
    const tab = (id, extra = {}) => ({ id, name: id, updatedAt: 100, items: [], children: [], ...extra });

    let merge;
    beforeEach(async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        merge = mergeForKey('settings', 'char1_inventoryTabs_config').merge;
    });

    test('a fold that would drop most of the list keeps every tab and holds the tombstones', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('a'), tab('b'), tab('c'), tab('d'), tab('e')],
        };
        const deleted = {
            version: 1,
            selectedTabId: null,
            tabs: [],
            removed: { a: 500, b: 500, c: 500, d: 500 },
        };

        const merged = merge(carrier, deleted);
        expect(merged.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
        // Un-applied, not forgotten: a real widespread deletion can still win
        expect(merged.removed).toEqual({ a: 500, b: 500, c: 500, d: 500 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('4 of 5'));
        warn.mockRestore();
    });

    test('a fold under the threshold applies normally', () => {
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('a'), tab('b'), tab('c'), tab('d'), tab('e')],
        };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { a: 500, b: 500 } };

        const merged = merge(carrier, deleted);
        expect(merged.tabs.map((t) => t.id)).toEqual(['c', 'd', 'e']);
        expect(merged.removed).toEqual({ a: 500, b: 500 });
    });

    test('a short list is not protected — three of three is more than two', () => {
        const carrier = { version: 1, selectedTabId: null, tabs: [tab('a'), tab('b'), tab('c')] };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { a: 500, b: 500, c: 500 } };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(merge(carrier, deleted).tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
        warn.mockRestore();
    });

    test('two of two still applies — nothing worth protecting in a majority of two', () => {
        const carrier = { version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] };
        const deleted = { version: 1, selectedTabId: null, tabs: [], removed: { a: 500, b: 500 } };
        expect(merge(carrier, deleted).tabs).toEqual([]);
    });
});

// -------------------------------------------------------------------------
// FIX 3 — an imported file must not be adopted verbatim
// -------------------------------------------------------------------------

describe('sanitizeImportedConfig', () => {
    beforeEach(() => {
        storageMock.reset();
    });

    const file = () => ({
        version: 1,
        selectedTabId: 'ores',
        removed: { ores: Date.now(), gear: Date.now() },
        orderUpdatedAt: 1,
        tabs: [
            { id: 'ores', name: 'Ores', items: ['/items/iron_ore'], children: [] },
            { id: 'gear', name: 'Gear', items: [], children: [{ id: 'weapons', name: 'W', items: [] }] },
        ],
    });

    test('the tombstone map never comes in', () => {
        expect(sanitizeImportedConfig(file()).removed).toBeUndefined();
    });

    test('every imported tab is stamped, nested ones included', () => {
        const now = 5_000;
        const config = sanitizeImportedConfig(file(), now);
        expect(config.tabs.map((t) => t.updatedAt)).toEqual([now, now]);
        expect(config.tabs[1].children[0].updatedAt).toBe(now);
        expect(config.orderUpdatedAt).toBe(now);
    });

    test('every tab gets a fresh id, and structure and selection follow it', () => {
        const config = sanitizeImportedConfig(file());
        const [ores, gear] = config.tabs;
        const weapons = gear.children[0];
        expect([ores.id, gear.id, weapons.id]).not.toContain('ores');
        expect([ores.id, gear.id, weapons.id]).not.toContain('gear');
        expect([ores.id, gear.id, weapons.id]).not.toContain('weapons');
        expect(new Set([ores.id, gear.id, weapons.id]).size).toBe(3);
        expect(config.selectedTabId).toBe(ores.id);
        expect(ores.items).toEqual(['/items/iron_ore']);
    });

    test('two imports of one file produce disjoint ids — the shared-id problem at its source', () => {
        const a = sanitizeImportedConfig(file());
        const b = sanitizeImportedConfig(file());
        expect(a.tabs[0].id).not.toBe(b.tabs[0].id);
    });

    test('loadout bindings survive the re-id — they are keyed by loadout name', () => {
        const config = sanitizeImportedConfig({
            version: 1,
            selectedTabId: null,
            tabs: [
                {
                    id: 'x',
                    name: 'X',
                    items: ['/items/sword+3'],
                    children: [],
                    loadoutBindings: { Melee: ['/items/sword+3'] },
                },
            ],
        });
        expect(config.tabs[0].loadoutBindings).toEqual({ Melee: ['/items/sword+3'] });
    });

    test('a sanitized import survives the next loadConfig intact', async () => {
        const config = sanitizeImportedConfig(file());
        await saveConfig('char1', config);
        await flushConfigWrites();

        const reloaded = await loadConfig('char1');
        expect(reloaded.tabs.map((t) => t.name)).toEqual(['Ores', 'Gear']);
        expect(reloaded.tabs[1].children.map((t) => t.name)).toEqual(['W']);
        expect(reloaded.removed).toBeUndefined();
    });
});

// -------------------------------------------------------------------------
// A config written by something that is not this module's CRUD helpers — an
// imported file, a sync pull, the upstream script sharing the same key — must
// not be able to crash the read helpers
// -------------------------------------------------------------------------

describe('tab shape coming in from outside', () => {
    const KEY = 'char1_inventoryTabs_config';

    beforeEach(() => {
        storageMock.reset();
    });

    test('a stored tab with no items or children array loads usable', async () => {
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [{ id: 'gear', name: 'Gear', children: [{ id: 'weapons', name: 'W' }] }, { id: 'bare' }],
        });

        const config = await loadConfig('char1');
        expect(config.tabs.map((t) => t.id)).toEqual(['gear', 'bare']);
        expect(config.tabs[0].children[0].items).toEqual([]);
        expect(config.tabs[0].children[0].children).toEqual([]);
        // These are what threw: every read helper walks children and items raw
        expect(() => getAssignedItemSet(config)).not.toThrow();
        expect(() => findTab(config, 'nothing-here')).not.toThrow();
        expect(() => collectItemsAboveTab(config, 'bare')).not.toThrow();
    });

    test('non-object and id-less entries are dropped rather than carried', async () => {
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [null, 'nope', { name: 'no id' }, { id: 'real', name: 'Real', items: ['/items/hat', 7] }],
        });

        const config = await loadConfig('char1');
        expect(config.tabs.map((t) => t.id)).toEqual(['real']);
        // A non-string in items would reach the DOM as an hrid lookup
        expect(config.tabs[0].items).toEqual(['/items/hat']);
    });

    test('an imported tab with no items array is given one', () => {
        const config = sanitizeImportedConfig({ version: 1, tabs: [{ id: 'x', name: 'X' }] });
        expect(config.tabs[0].items).toEqual([]);
        expect(() => getAssignedItemSet(config)).not.toThrow();
    });
});

// -------------------------------------------------------------------------
// FIX 5 — loading must not blank the shared record before the probe returns
// -------------------------------------------------------------------------

describe('the loadConfig wipe window', () => {
    const KEY = 'char1_inventoryTabs_config';

    beforeEach(() => {
        storageMock.reset();
    });

    const stored = () => ({
        version: 1,
        selectedTabId: null,
        tabs: [
            { id: 'a', name: 'Ores', items: ['/items/iron_ore'], children: [], updatedAt: 100 },
            { id: 'b', name: 'Gear', items: ['/items/hat'], children: [], updatedAt: 100 },
        ],
    });

    /**
     * Hold every tryGet open until released, so the load's probe and the
     * save's probe can be made to overlap the way they do in the browser.
     */
    function gateProbes() {
        const pending = [];
        const original = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementation(
            (key, store) => new Promise((resolve) => pending.push(() => resolve(original(key, store))))
        );
        return {
            /** Drain, letting each release schedule the probes queued behind it */
            releaseAll: async () => {
                for (let pass = 0; pass < 20; pass++) {
                    while (pending.length) pending.shift()();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            },
            restore: () => storageMock.tryGet.mockImplementation(original),
        };
    }

    test('an edit made inside the load window survives it, and lands on disk', async () => {
        // The exact interleaving the old code lost: `loadConfig` blanked the
        // SHARED record and then went away to await its probe, so an edit that
        // arrived in that window folded itself against an empty config.
        storageMock.storeFor('settings').set(KEY, stored());
        const first = await loadConfig('char1');
        expect(first.tabs).toHaveLength(2);

        const gate = gateProbes();
        // A reload starts — the panel's character_initialized handler, or the
        // bulk-sell assistant, both of which share this exact record
        const loading = loadConfig('char1');
        // …and the user renames a tab before its probe has come back
        const saving = saveConfig('char1', renameTab(first, 'a', 'Ores (renamed)'));

        await gate.releaseAll();
        await Promise.all([loading, saving]);
        await flushConfigWrites();
        gate.restore();

        const onDisk = storageMock.storeFor('settings').get(KEY);
        expect(onDisk.tabs.map((t) => t.id).sort()).toEqual(['a', 'b']);
        expect(onDisk.tabs.find((t) => t.id === 'a').name).toBe('Ores (renamed)');
    });

    test('a save whose probe resolves inside the load window never writes an empty config', async () => {
        storageMock.storeFor('settings').set(KEY, stored());
        const first = await loadConfig('char1');

        const gate = gateProbes();
        const saving = saveConfig('char1', first);
        const loading = loadConfig('char1');

        await gate.releaseAll();
        await Promise.all([loading, saving]);
        await flushConfigWrites();
        gate.restore();

        const onDisk = storageMock.storeFor('settings').get(KEY);
        expect(onDisk.tabs.map((t) => t.id).sort()).toEqual(['a', 'b']);
        expect((await loading).tabs).toHaveLength(2);
    });

    test('two overlapping loads both answer with the stored tabs, never an empty config', async () => {
        storageMock.storeFor('settings').set(KEY, stored());
        await loadConfig('char1');

        const gate = gateProbes();
        const a = loadConfig('char1');
        const b = loadConfig('char1');
        await gate.releaseAll();
        const [first, second] = await Promise.all([a, b]);
        gate.restore();

        expect(first.tabs).toHaveLength(2);
        expect(second.tabs).toHaveLength(2);
    });

    test('an unreadable load still answers with the config last held', async () => {
        storageMock.storeFor('settings').set(KEY, stored());
        const held = await loadConfig('char1');
        expect(held.tabs).toHaveLength(2);

        storageMock.unavailable = true;
        const again = await loadConfig('char1');
        storageMock.unavailable = false;
        expect(again.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    });
});
// -------------------------------------------------------------------------
// Two devices editing one tab: the items are a collection, not a property
// -------------------------------------------------------------------------

describe('the item merge', () => {
    const tab = (id, extra = {}) => ({ id, name: id, items: [], children: [], ...extra });

    let merge;
    beforeEach(async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        // The registry hands (local, incoming); local is the side that wins ties
        merge = mergeForKey('settings', 'char1_inventoryTabs_config').merge;
    });

    test('two devices adding to the same tab keep both items', () => {
        const local = { version: 1, selectedTabId: null, tabs: [tab('t', { updatedAt: 100, items: ['/items/x'] })] };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 200, items: ['/items/y'] })],
        };

        // The newer copy's order first, then what only the older one had
        expect(merge(local, incoming).tabs[0].items).toEqual(['/items/y', '/items/x']);
        expect(merge(incoming, local).tabs[0].items).toEqual(['/items/y', '/items/x']);
    });

    test('an item deleted on the newer side stays deleted though the older side still has it', () => {
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 100, items: ['/items/x', '/items/y'] })],
        };
        const deleter = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 200, items: ['/items/y'] })],
            removedItems: { t: { '/items/x': 200 } },
        };

        for (const merged of [merge(carrier, deleter), merge(deleter, carrier)]) {
            expect(merged.tabs[0].items).toEqual(['/items/y']);
            expect(merged.removedItems).toEqual({ t: { '/items/x': 200 } });
        }
    });

    test('a rename on one device and an item add on the other keep both', () => {
        const renamed = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { name: 'Renamed', updatedAt: 300, items: ['/items/x'] })],
        };
        const added = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { name: 'Old', updatedAt: 200, items: ['/items/x', '/items/y'] })],
        };

        const merged = merge(renamed, added);
        expect(merged.tabs[0].name).toBe('Renamed');
        expect(merged.tabs[0].items).toEqual(['/items/x', '/items/y']);
    });

    test('re-adding a tombstoned item outlives the tombstone and clears it', () => {
        const deleter = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 200, items: [] })],
            removedItems: { t: { '/items/x': 200 } },
        };
        const readded = { version: 1, selectedTabId: null, tabs: [tab('t', { updatedAt: 300, items: ['/items/x'] })] };

        const merged = merge(readded, deleter);
        expect(merged.tabs[0].items).toEqual(['/items/x']);
        expect(merged.removedItems).toBeUndefined();
    });

    test('an unstamped copy is never deleted from, and clears the tombstone', () => {
        const legacy = { version: 1, selectedTabId: null, tabs: [tab('t', { items: ['/items/x'] })] };
        const deleter = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 5_000_000, items: [] })],
            removedItems: { t: { '/items/x': 5_000_000 } },
        };

        const merged = merge(legacy, deleter);
        expect(merged.tabs[0].items).toEqual(['/items/x']);
        expect(merged.removedItems).toBeUndefined();
    });

    test('a tab only one side has is carried through unchanged', () => {
        const local = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('mine', { updatedAt: 100, items: ['/items/x', LINEBREAK_HRID, '/items/y'] })],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('theirs', { updatedAt: 200, items: ['/items/z'] })],
        };

        const merged = merge(local, incoming);
        expect(merged.tabs.find((t) => t.id === 'mine').items).toEqual(['/items/x', LINEBREAK_HRID, '/items/y']);
        expect(merged.tabs.find((t) => t.id === 'theirs').items).toEqual(['/items/z']);
    });

    test('an item added to a NESTED tab on the other device survives too', () => {
        const local = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('root', { updatedAt: 100, children: [tab('kid', { updatedAt: 100, items: ['/items/x'] })] })],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('root', { updatedAt: 200, children: [tab('kid', { updatedAt: 200, items: ['/items/y'] })] })],
        };

        expect(merge(local, incoming).tabs[0].children[0].items).toEqual(['/items/y', '/items/x']);
    });

    test("the winner's line breaks survive and are never duplicated", () => {
        const local = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 200, items: ['/items/x', LINEBREAK_HRID] })],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 100, items: [LINEBREAK_HRID, LINEBREAK_HRID, '/items/y'] })],
        };

        expect(merge(local, incoming).tabs[0].items).toEqual(['/items/x', LINEBREAK_HRID, '/items/y']);
    });

    test('enhancement levels are separate items — +0 and +5 both survive', () => {
        const local = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 100, items: ['/items/sword'] })],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 200, items: ['/items/sword+5'] })],
            removedItems: { t: { '/items/sword+5': 50 } },
        };

        // The tombstone names the +5 alone; the bare hrid is a different item
        expect(merge(local, incoming).tabs[0].items).toEqual(['/items/sword+5', '/items/sword']);
    });
});

describe('the item-level mass-delete cap', () => {
    const tab = (id, extra = {}) => ({ id, name: id, items: [], children: [], ...extra });
    const five = ['/items/a', '/items/b', '/items/c', '/items/d', '/items/e'];

    let merge;
    beforeEach(async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        merge = mergeForKey('settings', 'char1_inventoryTabs_config').merge;
    });

    const carrier = () => ({ version: 1, selectedTabId: null, tabs: [tab('t', { updatedAt: 100, items: five })] });
    const deleter = (gone) => ({
        version: 1,
        selectedTabId: null,
        tabs: [tab('t', { updatedAt: 200, items: five.filter((h) => !gone.includes(h)) })],
        removedItems: { t: Object.fromEntries(gone.map((h) => [h, 200])) },
    });

    test('a fold that would empty most of a tab keeps every item and holds the tombstones', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const merged = merge(carrier(), deleter(['/items/a', '/items/b', '/items/c', '/items/d']));

        // Every item survives, in the surviving copy's order then the rest
        expect(merged.tabs[0].items).toEqual(['/items/e', '/items/a', '/items/b', '/items/c', '/items/d']);
        // Un-applied, not forgotten: a real bulk clear-out can still win later
        expect(Object.keys(merged.removedItems.t)).toHaveLength(4);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('4 of 5 items'));
        warn.mockRestore();
    });

    test('a fold under the threshold applies normally', () => {
        const merged = merge(carrier(), deleter(['/items/a', '/items/b']));
        expect(merged.tabs[0].items).toEqual(['/items/c', '/items/d', '/items/e']);
    });

    test('a short list is not protected — three of three is more than two', () => {
        const short = ['/items/a', '/items/b', '/items/c'];
        const local = { version: 1, selectedTabId: null, tabs: [tab('t', { updatedAt: 100, items: short })] };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('t', { updatedAt: 200, items: [] })],
            removedItems: { t: Object.fromEntries(short.map((h) => [h, 200])) },
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(merge(local, incoming).tabs[0].items).toEqual(short);
        warn.mockRestore();
    });

    test('the cap is per tab — one tab holding back does not spare another', () => {
        const local = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('big', { updatedAt: 100, items: five }), tab('small', { updatedAt: 100, items: five })],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            tabs: [
                tab('big', { updatedAt: 200, items: ['/items/e'] }),
                tab('small', { updatedAt: 200, items: ['/items/c', '/items/d', '/items/e'] }),
            ],
            removedItems: {
                big: Object.fromEntries(five.slice(0, 4).map((h) => [h, 200])),
                small: { '/items/a': 200, '/items/b': 200 },
            },
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const merged = merge(local, incoming);
        expect(merged.tabs.find((t) => t.id === 'big').items).toEqual([
            '/items/e',
            '/items/a',
            '/items/b',
            '/items/c',
            '/items/d',
        ]);
        expect(merged.tabs.find((t) => t.id === 'small').items).toEqual(['/items/c', '/items/d', '/items/e']);
        warn.mockRestore();
    });
});

describe('item tombstone recording', () => {
    const seed = () => ({
        version: 1,
        selectedTabId: null,
        tabs: [{ id: 't', name: 't', items: ['/items/x', '/items/y'], children: [] }],
    });

    test('removing an item records a tombstone scoped to that tab', () => {
        const config = removeItem(seed(), 't', '/items/x');
        expect(Object.keys(config.removedItems.t)).toEqual(['/items/x']);
        expect(config.removedItems.t['/items/x']).toBeGreaterThan(0);
    });

    test('removing by index records the item that actually went', () => {
        const config = removeItemAtIndex(seed(), 't', 1);
        expect(Object.keys(config.removedItems.t)).toEqual(['/items/y']);
    });

    test('a line break leaves no tombstone — it has no identity to key one by', () => {
        const config = removeItemAtIndex(addLineBreak(seed(), 't'), 't', 2);
        expect(config.removedItems).toBeUndefined();
    });

    test('adding the item back clears its tombstone', () => {
        const removed = removeItem(seed(), 't', '/items/x');
        expect(addItem(removed, 't', '/items/x').removedItems).toBeUndefined();
        expect(insertItem(removed, 't', '/items/x', 0).removedItems).toBeUndefined();
    });

    test('a move tombstones the source and clears the target', () => {
        const two = seed();
        two.tabs.push({ id: 'u', name: 'u', items: [], children: [] });
        const moved = moveItem(two, 't', 'u', '/items/x');
        expect(moved.removedItems).toEqual({ t: { '/items/x': expect.any(Number) } });
        expect(moved.tabs[1].items).toEqual(['/items/x']);
    });

    test('a removal is not undone by the read-back fold at save time', async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        const merge = mergeForKey('settings', 'char1_inventoryTabs_config').merge;
        const stored = seed();
        stored.tabs[0].updatedAt = 100;
        const held = removeItem(stored, 't', '/items/x');
        expect(merge(held, stored).tabs[0].items).toEqual(['/items/y']);
    });

    test('the map is held to MAX_ITEM_TOMBSTONES, oldest evicted first', () => {
        let config = { version: 1, selectedTabId: null, tabs: [] };
        for (let i = 0; i <= MAX_ITEM_TOMBSTONES; i += 1) config = tombstoneItem(config, 't', `/items/i${i}`, 1000 + i);
        expect(Object.keys(config.removedItems.t)).toHaveLength(MAX_ITEM_TOMBSTONES);
        expect(config.removedItems.t['/items/i0']).toBeUndefined();
        expect(config.removedItems.t[`/items/i${MAX_ITEM_TOMBSTONES}`]).toBe(1000 + MAX_ITEM_TOMBSTONES);
    });
});

describe('item tombstone ageing', () => {
    const KEY = 'char1_inventoryTabs_config';

    beforeEach(() => {
        storageMock.reset();
        _resetConfigRecords();
    });

    test('a load forgets item deletions older than the max age and keeps the rest', async () => {
        const now = Date.now();
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [{ id: 't', name: 't', items: [], children: [], updatedAt: now }],
            removedItems: {
                t: { '/items/stale': now - TOMBSTONE_MAX_AGE_MS - 1000, '/items/fresh': now - 1000 },
                gone: { '/items/old': now - TOMBSTONE_MAX_AGE_MS - 1000 },
            },
        });

        const config = await loadConfig('char1');
        expect(config.removedItems).toEqual({ t: { '/items/fresh': now - 1000 } });
    });

    test('a load with every item deletion expired drops the map entirely', async () => {
        const now = Date.now();
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [{ id: 't', name: 't', items: [], children: [], updatedAt: now }],
            removedItems: { t: { '/items/stale': now - TOMBSTONE_MAX_AGE_MS - 1000 } },
        });

        expect((await loadConfig('char1')).removedItems).toBeUndefined();
    });

    test('an imported layout carries neither tombstone map', () => {
        const sanitized = sanitizeImportedConfig({
            version: 1,
            tabs: [{ id: 'a', name: 'a', items: ['/items/x'], children: [] }],
            removed: { a: 1 },
            removedItems: { a: { '/items/x': 1 } },
        });
        expect(sanitized.removed).toBeUndefined();
        expect(sanitized.removedItems).toBeUndefined();
    });
});
