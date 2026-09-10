/** @vitest-environment happy-dom */

/**
 * The health checks, tested against faked anchors.
 *
 * They live on the registration entries rather than in a module, which is right
 * — a check is about how a feature is wired into the page, not about the
 * feature's own logic — but it means the only way to reach one is to boot the
 * entrypoint and take the registry it hands over. That is what this does: every
 * library is a stub, `replaceFeatures` is the seam, and the predicates come out
 * the other side as ordinary functions to run against a DOM built by hand.
 *
 * What is worth asserting is not that a present marker reads as healthy — it is
 * the two ways a health pass turns into noise. A panel that is not open must
 * read as "cannot tell", and a readout the player switched off must read as
 * healthy, because "N features failed to start" is a claim that stops being
 * believed the first time it is wrong.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { GAME } from './utils/selectors.js';

// The real feature registry, imported alongside the entrypoint so the mapping
// can be tested against the thing that consumes it rather than against a copy
// of the field list. The entrypoint itself reads everything off
// `window.Toolasha.*` and imports no `src/core` module, so these mocks are
// invisible to it — they exist only to keep `feature-registry.js` off real
// config, real IndexedDB-backed data and the real performance monitor.
vi.mock('./core/config.js', () => ({
    default: {
        isFeatureEnabled: () => true,
        clearSettingsCache: () => {},
        loadSettings: async () => {},
        applyColorSettings: () => {},
    },
}));

vi.mock('./core/data-manager.js', () => ({
    default: {
        getIsCharacterSwitching: () => false,
        getCurrentCharacterId: () => null,
        on: () => {},
    },
}));

vi.mock('./utils/performance-monitor.js', () => ({
    default: { mark: () => {}, sinceBoot: () => 0, snapshot: () => {} },
}));

const realFeatureRegistry = (await import('./core/feature-registry.js')).default;

/** How long the two probe initializers park, in ms. Long enough to interleave, short enough to run. */
const PROBE_AWAIT_MS = 20;

/**
 * Live count of probe initializers between their first and last statement, and
 * the high-water mark. Serial initialization can never push the mark above 1.
 */
const probe = { active: 0, peak: 0 };

/**
 * The two `concurrent: true` UI features whose stand-in modules really suspend.
 * Both are flagged in the registry list, so a mapping that forwards the flag
 * lets them overlap and one that drops it cannot.
 */
const probeModules = { tabReorder: makeProbeModule(), sessionBriefing: makeProbeModule() };

/**
 * What the character-switch race module did, per test.
 *
 * `instances` are the objects its `initialize()` returned; `disabledWith` is
 * what the mapping's `disable` closure handed its teardown each time.
 */
const race = { instances: [], disabledWith: [], release: () => {} };

/**
 * A module stand-in that returns an instance and takes one back on teardown —
 * the shape the mapping's comment calls out ("some cleanup(instance)
 * implementations expect the instance returned by initialize()") and the only
 * shape in which the mid-flight teardown race is observable.
 */
const raceModules = {
    overlayPanel: {
        initialize: async () => {
            await new Promise((resolve) => {
                race.release = resolve;
            });
            const instance = { id: race.instances.length + 1 };
            race.instances.push(instance);
            return instance;
        },
        disable: (instance) => {
            race.disabledWith.push(instance);
        },
    },
};

/**
 * A module stand-in whose `initialize()` genuinely suspends.
 *
 * The library stubs below answer every call with another stub, which resolves
 * in a microtask and so cannot show the difference between awaiting sixteen
 * features and overlapping them. These two do.
 *
 * @returns {{initialize: Function}} A feature module
 */
function makeProbeModule() {
    return {
        initialize: async () => {
            probe.active += 1;
            probe.peak = Math.max(probe.peak, probe.active);
            await new Promise((resolve) => setTimeout(resolve, PROBE_AWAIT_MS));
            probe.active -= 1;
        },
    };
}

/** Settings the fake config answers with; mutated per test */
const settings = {};

/** The registry entries the entrypoint hands to `replaceFeatures` */
let registered = [];

/** `(css, id)` pairs passed to `Utils.dom.addStyles` while the entrypoint loaded */
const styleCalls = [];

/** Every `dataManager.on(event, handler)` the entrypoint registered, by event */
const dataManagerHandlers = new Map();

/** How many times the entrypoint asked the registry to bring the feature layer up */
let initializeFeaturesCalls = 0;

/** The entrypoint module's own exports, once it has loaded */
let entrypointModule;

/** What `dualInstallGuard.detectMwiTools()` answers; mutated per test */
let mwiToolsDetected = false;

/** `(message, options)` pairs passed to `Utils.toast.showToast` while the entrypoint loaded */
const toastCalls = [];

/** Storage lifecycle methods the entrypoint's page-teardown listeners called, in order */
const storageCalls = [];

/** A library stand-in: every property is a callable that returns another one */
function makeStub() {
    return new Proxy(function stub() {}, {
        get: (target, prop) => {
            // Nothing here is a promise, and pretending otherwise breaks `await`
            if (prop === 'then') return undefined;
            return makeStub();
        },
        apply: () => makeStub(),
    });
}

beforeAll(async () => {
    window.Toolasha = {
        Core: {
            storage: {
                initialize: async () => {},
                flushAll: () => {
                    storageCalls.push('flushAll');
                },
                closeForTeardown: () => {
                    storageCalls.push('closeForTeardown');
                },
                reopenAfterRestore: () => {
                    storageCalls.push('reopenAfterRestore');
                },
                diagnostics: () => ({}),
            },
            config: {
                Z_FLOATING_PANEL: 1100,
                getSetting: (key) => settings[key],
                getSettingValue: (key, fallback) => (key in settings ? settings[key] : fallback),
                isFeatureEnabled: () => true,
                initialize: async () => {},
                loadSettings: async () => {},
                applyColorSettings: () => {},
                getFeaturesByCategory: () => [],
                setFeatureEnabled: () => {},
                toggleFeature: () => {},
                getFeatureInfo: () => {},
            },
            webSocketHook: { install: () => {}, captureClientDataFromLocalStorage: () => {} },
            domObserver: { start: () => {} },
            dataManager: {
                initialize: () => {},
                on: (event, handler) => {
                    if (!dataManagerHandlers.has(event)) dataManagerHandlers.set(event, []);
                    dataManagerHandlers.get(event).push(handler);
                },
                getIsCharacterSwitching: () => false,
            },
            featureRegistry: {
                replaceFeatures: (features) => {
                    registered = features;
                },
                setupCharacterSwitchHandler: () => {},
                checkFeatureHealth: () => [],
                retryFailedFeatures: async () => [],
                initializeFeatures: async () => {
                    initializeFeaturesCalls += 1;
                    return [];
                },
            },
            performanceMonitor: { mark: () => {} },
            marketAPI: { fetch: async () => null },
            errorLog: { install: () => true, getEntries: () => [], clear: () => {} },
            dualInstallGuard: {
                claimPage: () => false,
                claimLost: () => false,
                checkSettingsFingerprint: async () => [],
                detectMwiTools: () => mwiToolsDetected,
                DUAL_INSTALL_MESSAGE: 'dual-install stand-in message',
                MWI_TOOLS_MESSAGE: 'MWITools stand-in message',
            },
        },
        Utils: {
            dom: {
                setupScrollTooltipDismissal: () => {},
                addStyles: (css, id) => styleCalls.push({ css, id }),
            },
            toast: { showToast: (message, options) => toastCalls.push({ message, options }) },
            selectors: { GAME },
        },
        Market: makeStub(),
        Actions: makeStub(),
        Combat: makeStub(),
        // Two of the UI library's members are real modules that suspend, so the
        // registry entries the entrypoint builds for them can be run for real
        // below; everything else is the usual stub.
        UI: new Proxy(function stub() {}, {
            get: (target, prop) => {
                if (prop === 'then') return undefined;
                if (Object.hasOwn(probeModules, prop)) return probeModules[prop];
                if (Object.hasOwn(raceModules, prop)) return raceModules[prop];
                return makeStub();
            },
            apply: () => makeStub(),
        }),
    };

    entrypointModule = await import('./entrypoint.js');
});

/**
 * The health check registered under a feature key.
 * @param {string} key - Feature key
 * @returns {Function} Its health check
 */
function checkFor(key) {
    const entry = registered.find((feature) => feature.key === key);
    expect(entry, `no feature registered under ${key}`).toBeTruthy();
    expect(typeof entry.healthCheck, `${key} has no health check`).toBe('function');
    return entry.healthCheck;
}

beforeEach(() => {
    document.body.innerHTML = '';
    for (const key of Object.keys(settings)) delete settings[key];
});

describe('select option contrast', () => {
    // Firefox opens a native <select>'s dropdown on its own popup rather than
    // the select's own dark background, so every injected select carries a
    // shared `toolasha-select` class and one global rule gives its <option>s
    // an explicit dark background *and* light text — see entrypoint.js. A
    // rule that set only `color` would still read as light-on-white there.
    test('injects one rule giving every toolasha-select option both a background and a text color', () => {
        const call = styleCalls.find((c) => c.id === 'toolasha-select-option-contrast');
        expect(call, 'expected addStyles to be called with the option-contrast rule').toBeTruthy();
        expect(call.css).toMatch(/\.toolasha-select\s+option\s*\{[^}]*background-color\s*:[^}]+\}/);
        expect(call.css).toMatch(/\.toolasha-select\s+option\s*\{[^}]*\bcolor\s*:[^}]+\}/);
    });
});

describe('the registry the entrypoint builds', () => {
    test('carries health checks through, which is the whole point', () => {
        const withChecks = registered.filter((feature) => typeof feature.healthCheck === 'function');
        expect(withChecks.length).toBeGreaterThanOrEqual(12);
    });
});

/**
 * The page-teardown listeners.
 *
 * Three events say "the page may be going away" and they do not mean the same
 * thing, which is what this is about. On 3.47.0 all three did the same thing —
 * start a flush, open readwrite transactions, and never tell the connection to
 * finalise — and a tab refreshed twice in quick succession left a transaction
 * outstanding on the `settings` store. IndexedDB serialises a store across every
 * connection on the origin, so that one orphan stopped the script in every tab
 * until the *other* tabs were reloaded.
 *
 * What these tests prove is the wiring: which lifecycle call each event makes.
 * They prove nothing about IndexedDB — happy-dom has no bfcache, and no test
 * here can reproduce a browser holding a store across connections.
 */
describe('page-teardown listeners', () => {
    /**
     * Fire an event at a target and hand back what storage was asked to do.
     * @param {EventTarget} target - `window` or `document`
     * @param {string} type - Event type
     * @returns {Array<string>} Storage lifecycle methods called, in order
     */
    function dispatch(target, type) {
        storageCalls.length = 0;
        target.dispatchEvent(new Event(type));
        return storageCalls.slice();
    }

    /**
     * Run a block with `document.visibilityState` forced.
     * @param {string} state - `hidden` or `visible`
     * @param {Function} run - What to run while it is forced
     * @returns {*} Whatever `run` returned
     */
    function withVisibility(state, run) {
        const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
        try {
            return run();
        } finally {
            delete document.visibilityState;
            if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
        }
    }

    // The event that must close, and the reason the whole change exists. It is
    // also the only one of the three that cannot be called off.
    test('pagehide gives the connection back', () => {
        expect(dispatch(window, 'pagehide')).toEqual(['closeForTeardown']);
    });

    // A bfcache restore resumes a page whose connection was closed, and
    // everything above the storage module still expects a database.
    test('pageshow asks for the connection back', () => {
        expect(dispatch(window, 'pageshow')).toEqual(['reopenAfterRestore']);
    });

    // `beforeunload` fires when a navigation *starts*, and any handler on the
    // page that asks for confirmation gives the user a Stay button. A page that
    // stays must still have a database — and when the navigation does go
    // through, `pagehide` follows and closes there, so nothing is lost.
    test('beforeunload flushes and does not close — the navigation can still be cancelled', () => {
        expect(dispatch(window, 'beforeunload')).toEqual(['flushAll']);
    });

    // This one fires every time the tab is backgrounded, which is constantly,
    // and the page keeps running the whole time.
    test('visibilitychange→hidden flushes and does not close — the tab comes back', () => {
        expect(withVisibility('hidden', () => dispatch(document, 'visibilitychange'))).toEqual(['flushAll']);
    });

    test('visibilitychange→visible does nothing at all', () => {
        expect(withVisibility('visible', () => dispatch(document, 'visibilitychange'))).toEqual([]);
    });
});

describe('net worth health check', () => {
    const check = () => checkFor('networth')();

    test('says nothing when the header is not drawn', () => {
        expect(check()).toBeNull();
    });

    test('fails when the header is there and the readout is not', () => {
        document.body.innerHTML = '<div class="Header_totalLevel__1Ku1r">Total 1500</div>';
        expect(check()).toBe(false);
    });

    test('passes once the readout is beside it', () => {
        document.body.innerHTML =
            '<div class="Header_totalLevel__1Ku1r">Total 1500</div><div class="mwi-networth-header">12M</div>';
        expect(check()).toBe(true);
    });
});

describe('task icons health check', () => {
    const check = () => checkFor('taskIcons')();

    const taskList = (attrs = '') =>
        `<div class="TasksPanel_taskList__2xy1"><div class="RandomTask_randomTask__pzB4z" ${attrs}></div></div>`;

    test('says nothing while the Tasks panel is closed', () => {
        expect(check()).toBeNull();
    });

    test('fails on an unprocessed task card', () => {
        document.body.innerHTML = taskList();
        expect(check()).toBe(false);
    });

    test('passes once a card has been stamped', () => {
        document.body.innerHTML = taskList('data-mwi-task-processed="Kill - Jerry"');
        expect(check()).toBe(true);
    });

    test('an empty task list is not a failure — there is nothing to mark', () => {
        document.body.innerHTML = '<div class="TasksPanel_taskList__2xy1"></div>';
        expect(check()).toBeNull();
    });
});

describe('overlay tab button health check', () => {
    const check = () => checkFor('overlayTabButton')();

    const tabStrip = (extra = '') =>
        `<div role="tablist"><button role="tab">Inventory</button>${extra}</div>` +
        '<div role="tablist"><button role="tab">Something else</button></div>';

    beforeEach(() => {
        settings.overlayPanel = true;
    });

    test('a switched-off overlay is healthy, not broken', () => {
        settings.overlayPanel = false;
        document.body.innerHTML = tabStrip();
        expect(check()).toBe(true);
    });

    test('says nothing when no tab strip holds an Inventory tab', () => {
        document.body.innerHTML = '<div role="tablist"><button role="tab">Abilities</button></div>';
        expect(check()).toBeNull();
    });

    test('fails when the strip is drawn and the button is missing', () => {
        document.body.innerHTML = tabStrip();
        expect(check()).toBe(false);
    });

    test('passes once the button is in the strip', () => {
        document.body.innerHTML = tabStrip('<button id="toolasha-overlay-tab">⧉ Overlay</button>');
        expect(check()).toBe(true);
    });
});

describe('item count display health check', () => {
    const check = () => checkFor('itemCountDisplay')();

    const marketTiles = (extra = '') =>
        `<div class="MarketplacePanel_marketItems__1lLm4"><div><svg><use href="#iron_bar"></use></svg>${extra}</div></div>`;

    test('a switched-off count is healthy', () => {
        settings.market_visibleItemCount = false;
        document.body.innerHTML = marketTiles();
        expect(check()).toBe(true);
    });

    test('fails when the tiles are drawn and no count is on them', () => {
        settings.market_visibleItemCount = true;
        document.body.innerHTML = marketTiles();
        expect(check()).toBe(false);
    });

    test('passes once a count is drawn', () => {
        settings.market_visibleItemCount = true;
        document.body.innerHTML = marketTiles('<div class="mwi-item-count">12</div>');
        expect(check()).toBe(true);
    });
});

describe('inventory badge prices health check', () => {
    const check = () => checkFor('inventoryBadgePrices')();

    const inventory = (dataset, extra = '') =>
        `<div class="Inventory_items__6SXv0"><div class="Item_itemContainer__x7kH1" ${dataset}>${extra}</div></div>`;

    beforeEach(() => {
        settings.invBadgePrices = true;
    });

    test('says nothing when nothing in view is worth anything', () => {
        document.body.innerHTML = inventory('data-ask-price="0"');
        expect(check()).toBeNull();
    });

    test('fails when a priced item carries no badge', () => {
        document.body.innerHTML = inventory('data-ask-price="1200"');
        expect(check()).toBe(false);
    });

    test('passes once the badge is on it', () => {
        document.body.innerHTML = inventory('data-ask-price="1200"', '<div class="mwi-badge-price-ask">1.2K</div>');
        expect(check()).toBe(true);
    });
});

describe('the debug console API', () => {
    test('exposes health() so the report can be opened on demand', () => {
        expect(typeof window.Toolasha.debug.health).toBe('function');
    });
});

describe('the selector canary', () => {
    // window.Toolasha.debug is where the entrypoint already exposes internal
    // checks for console use; the canary rides along on that seam rather than
    // needing its own.
    const canary = () => window.Toolasha.debug.canary();

    /**
     * All four ever-present anchors, drawn as a healthy loaded game page would.
     * The level and XP bar sit inside a nav entry, as they do in the game —
     * `canaryNavBar` is gated on the level being drawn, so a fixture that drew
     * a level with no nav around it would be a page the game never renders.
     */
    const allAnchorsPresent = () => {
        document.body.innerHTML = `
            <div class="Header_totalLevel__1Ku1r">Total 1500</div>
            <div class="GamePage_gamePanel__3uNKN"></div>
            <div class="NavigationBar_nav__3uyeQ">
                <span class="NavigationBar_level__2abcd">12</span>
                <div class="NavigationBar_currentExperience__9wxyz" style="width: 40%"></div>
            </div>
        `;
    };

    test('finds nothing wrong on a normally-drawn page', () => {
        allAnchorsPresent();
        expect(canary()).toEqual([]);
    });

    test('reports every anchor missing on a blank page as the game having updated', () => {
        document.body.innerHTML = '';
        const failures = canary();

        expect(failures).toHaveLength(4);
        for (const failure of failures) {
            expect(failure.reason).toBe('selector missing — game update?');
            expect(failure.key).toBeTruthy();
            expect(failure.name).toBeTruthy();
        }
    });

    test('reports only the anchor that actually went missing, not the whole page', () => {
        allAnchorsPresent();
        document.querySelector(GAME.GAME_PANEL).remove();

        const failures = canary();
        expect(failures).toHaveLength(1);
        expect(failures[0].reason).toBe('selector missing — game update?');
    });

    describe('the React fiber root canary', () => {
        afterEach(() => {
            document.getElementById('root')?.remove();
        });

        const gameRoot = () => {
            const root = document.createElement('div');
            root.id = 'root';
            document.body.appendChild(root);
            return root;
        };

        test('a game page whose root lost the legacy fiber key is the alarm', () => {
            allAnchorsPresent();
            gameRoot(); // no _reactRootContainer — a createRoot migration
            const failures = canary();
            expect(failures.map((f) => f.key)).toContain('canaryFiberRoot');
            expect(failures.find((f) => f.key === 'canaryFiberRoot').reason).toBe(
                'fiber key missing — game React update?'
            );
        });

        test('a reachable fiber is healthy', () => {
            allAnchorsPresent();
            gameRoot()._reactRootContainer = { current: {} };
            expect(canary().map((f) => f.key)).not.toContain('canaryFiberRoot');
        });

        test('no root element is no evidence — the game page never rendered', () => {
            allAnchorsPresent();
            expect(canary().map((f) => f.key)).not.toContain('canaryFiberRoot');
        });
    });

    test('does not canary a screen-specific selector — only the ever-present ones', () => {
        // TASK_LIST only exists while the Tasks panel is open; its absence here,
        // on an otherwise fully-drawn page, must not turn into a false alarm.
        allAnchorsPresent();
        expect(document.querySelector(GAME.TASK_LIST)).toBeNull();
        expect(canary()).toEqual([]);
    });

    describe('gated canaries — high-fanout selectors that only exist on their own screen', () => {
        test('a closed screen is no evidence: the gate is absent, so nothing is reported', () => {
            // No skill panel, no inventory, no chat, no combat — every gated
            // canary must sit this page out rather than call it broken.
            allAnchorsPresent();
            expect(canary()).toEqual([]);
        });

        test('the gate surviving while the canaried class vanished is the alarm', () => {
            // A skill panel whose name element is drawn but whose wrapper class
            // is not what the script expects: the game renamed one class.
            allAnchorsPresent();
            document.body.innerHTML += '<div class="SkillActionDetail_name__2P1Nw">Milking</div>';

            const failures = canary();
            expect(failures).toHaveLength(1);
            expect(failures[0].key).toBe('canarySkillActionDetail');
            expect(failures[0].reason).toBe('selector missing — game update?');
        });

        test('and the fully-drawn screen is healthy', () => {
            allAnchorsPresent();
            document.body.innerHTML +=
                '<div class="SkillActionDetail_skillActionDetail__1p3aX">' +
                '<div class="SkillActionDetail_name__2P1Nw">Milking</div></div>';
            expect(canary()).toEqual([]);
        });

        test('the alchemy panel carries no name and must not be called broken', () => {
            // Alchemy (and enhancing) reuse the SkillActionDetail wrapper but
            // draw no name heading. The wrapper on screen with no name is a
            // healthy alchemy panel, not a renamed class — the name canary gates
            // on the regular component so it sits this screen out.
            allAnchorsPresent();
            document.body.innerHTML +=
                '<div class="SkillActionDetail_skillActionDetail__1p3aX">' +
                '<div class="SkillActionDetail_alchemyComponent__2bQ8n"></div></div>';
            expect(canary()).toEqual([]);
        });

        test('the regular panel losing its name is the alarm', () => {
            // A gathering/production/crafting panel is drawn (regularComponent)
            // but the name class it always carries is gone: a real rename.
            allAnchorsPresent();
            document.body.innerHTML +=
                '<div class="SkillActionDetail_skillActionDetail__1p3aX">' +
                '<div class="SkillActionDetail_regularComponent__3oCgr"></div></div>';

            const failures = canary();
            expect(failures).toHaveLength(1);
            expect(failures[0].key).toBe('canarySkillActionName');
            expect(failures[0].reason).toBe('selector missing — game update?');
        });

        test('the regular panel with its name drawn is healthy', () => {
            allAnchorsPresent();
            document.body.innerHTML +=
                '<div class="SkillActionDetail_skillActionDetail__1p3aX">' +
                '<div class="SkillActionDetail_regularComponent__3oCgr">' +
                '<div class="SkillActionDetail_name__2P1Nw">Milking</div></div></div>';
            expect(canary()).toEqual([]);
        });

        describe('the leaderboard table', () => {
            test('a closed leaderboard is no evidence', () => {
                allAnchorsPresent();
                expect(canary().map((f) => f.key)).not.toContain('canaryLeaderboardTable');
            });

            test('the panel content drawn with no table in it is the alarm', () => {
                allAnchorsPresent();
                document.body.innerHTML += '<div class="LeaderboardPanel_content__1TsXo"></div>';

                const failures = canary();
                expect(failures).toHaveLength(1);
                expect(failures[0].key).toBe('canaryLeaderboardTable');
                expect(failures[0].reason).toBe('selector missing — game update?');
            });

            test('an open leaderboard with its table is healthy', () => {
                allAnchorsPresent();
                document.body.innerHTML +=
                    '<div class="LeaderboardPanel_content__1TsXo">' +
                    '<table class="LeaderboardPanel_leaderboardTable__2Kd7q"></table></div>';
                expect(canary()).toEqual([]);
            });
        });

        describe('the item picker', () => {
            const alchemySlot = (inner) =>
                `<div class="SkillActionDetail_primaryItemSelectorContainer__nrvNW">${inner}</div>`;

            test('no skill action panel is no evidence', () => {
                allAnchorsPresent();
                expect(canary().map((f) => f.key)).not.toContain('canaryItemSelector');
            });

            test('a filled picker is healthy', () => {
                allAnchorsPresent();
                document.body.innerHTML += alchemySlot('<div class="ItemSelector_itemSelector__2eTV6"></div>');
                expect(canary()).toEqual([]);
            });

            test('an empty picker is healthy too — the slot has its own class', () => {
                // The alchemize slot before anything is put in it. Accepting only
                // the filled shape would alarm on every freshly-opened panel.
                allAnchorsPresent();
                document.body.innerHTML += alchemySlot('<div class="ItemSelector_emptySlot__1ns6h"></div>');
                expect(canary()).toEqual([]);
            });

            test('the container drawn with neither shape inside it is the alarm', () => {
                allAnchorsPresent();
                document.body.innerHTML += alchemySlot('<div class="SomethingElse_box__9aZ"></div>');

                const failures = canary();
                expect(failures).toHaveLength(1);
                expect(failures[0].key).toBe('canaryItemSelector');
            });

            test('an open dropdown alone is not canaried', () => {
                // `ItemSelector_menu` exists only while a picker is open and
                // nothing witnesses that, so it is deliberately not an anchor —
                // a page with one and no picker container reports nothing.
                allAnchorsPresent();
                document.body.innerHTML += '<div class="ItemSelector_menu__12sEM"></div>';
                expect(canary()).toEqual([]);
            });
        });

        describe('guild trial stats member names', () => {
            test('no trial stats modal is no evidence', () => {
                allAnchorsPresent();
                expect(canary().map((f) => f.key)).not.toContain('canaryTrialStatsName');
            });

            test('the stats table drawn with no named member is the alarm', () => {
                // A rename of CharacterName_name empties every row's name, and
                // the scraper drops nameless rows without a word.
                allAnchorsPresent();
                document.body.innerHTML +=
                    '<table class="GuildPanel_trialStatsTable__3xWq2"><tbody><tr>' +
                    '<td><div class="Renamed_name__9aZ" data-name="Someone">Someone</div></td>' +
                    '</tr></tbody></table>';

                const failures = canary();
                expect(failures).toHaveLength(1);
                expect(failures[0].key).toBe('canaryTrialStatsName');
            });

            test('a named member makes it healthy', () => {
                allAnchorsPresent();
                document.body.innerHTML +=
                    '<table class="GuildPanel_trialStatsTable__3xWq2"><tbody><tr>' +
                    '<td><div class="CharacterName_name__1Ug3T" data-name="Someone">Someone</div></td>' +
                    '</tr></tbody></table>';
                expect(canary()).toEqual([]);
            });

            test('a name without data-name does not satisfy it — the exact name lives there', () => {
                allAnchorsPresent();
                document.body.innerHTML +=
                    '<table class="GuildPanel_trialStatsTable__3xWq2"><tbody><tr>' +
                    '<td><div class="CharacterName_name__1Ug3T">Someone…</div></td>' +
                    '</tr></tbody></table>';
                expect(canary().map((f) => f.key)).toEqual(['canaryTrialStatsName']);
            });
        });

        test('a cross-component gate: chat input drawn, messages unfindable', () => {
            // The chat panel (Chat_) survived while the message class
            // (ChatMessage_) renamed — exactly the wholesale-rename slice the
            // dungeon tracker and profile links would go dark on.
            allAnchorsPresent();
            document.body.innerHTML += '<div class="Chat_chatInputContainer__2z5cJ"></div>';

            const failures = canary();
            expect(failures).toHaveLength(1);
            expect(failures[0].key).toBe('canaryChatMessage');
        });

        test('the inventory pair watches each other, so either class renaming alone is caught', () => {
            allAnchorsPresent();
            document.body.innerHTML += '<div class="Inventory_items__6SXv0"></div>';
            expect(canary().map((failure) => failure.key)).toEqual(['canaryItemContainer']);

            allAnchorsPresent();
            document.body.innerHTML += '<div class="Item_itemContainer__x7kH1"></div>';
            expect(canary().map((failure) => failure.key)).toEqual(['canaryInventoryItems']);
        });

        test('a tab strip is found by its unhashed role, so a TabsComponent rename cannot hide', () => {
            // [role="tablist"] comes from the game's accessibility markup, not
            // from a hashed class — the one gate a wholesale rename cannot take
            // down with it.
            allAnchorsPresent();
            document.body.innerHTML += '<div role="tablist"><button role="tab">Inventory</button></div>';

            const failures = canary();
            expect(failures.map((failure) => failure.key)).toEqual(['canaryTabsContainer']);
        });

        test('the header action pair watches each other, so either class renaming alone is caught', () => {
            // The community buff row is drawn inside the action-info block, so
            // one present without the other is a header refactor, not a screen
            // that happens not to draw them.
            allAnchorsPresent();
            document.body.innerHTML += '<div class="Header_communityBuffs__2mNqZ"></div>';
            expect(canary().map((failure) => failure.key)).toEqual(['canaryHeaderActionInfo']);

            allAnchorsPresent();
            document.body.innerHTML += '<div class="Header_actionInfo__1kPqR"></div>';
            expect(canary().map((failure) => failure.key)).toEqual(['canaryHeaderCommunityBuffs']);

            allAnchorsPresent();
            document.body.innerHTML +=
                '<div class="Header_actionInfo__1kPqR"><div class="Header_communityBuffs__2mNqZ"></div></div>';
            expect(canary()).toEqual([]);
        });

        test('a badge-less tab strip reports only the badge', () => {
            allAnchorsPresent();
            document.body.innerHTML +=
                '<div role="tablist" class="TabsComponent_tabsContainer__3B9iF">' +
                '<button role="tab">Inventory</button></div>';
            expect(canary().map((failure) => failure.key)).toEqual(['canaryTabBadge']);

            document.querySelector('[role="tab"]').innerHTML =
                '<span class="TabsComponent_badge__1Du26">Inventory</span>';
            expect(canary()).toEqual([]);
        });
    });
});

describe('the character_initialized startup block', () => {
    /**
     * Feed the entrypoint's `character_initialized` listeners one payload and
     * let the 100 ms startup timer and its async body run.
     *
     * Real timers rather than fake ones on purpose: the block ends in a 500 ms
     * health-check timer whose canaries want a DOM this test has not built, and
     * a short real wait runs the part under test without reaching it.
     * @param {Object} payload - The event data
     * @returns {Promise<void>}
     */
    async function fireCharacterInitialized(payload) {
        for (const handler of dataManagerHandlers.get('character_initialized') || []) {
            handler(payload);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    test('the entrypoint listens for character_initialized at all', () => {
        expect(dataManagerHandlers.get('character_initialized')?.length).toBeGreaterThan(0);
    });

    /**
     * A second `init_character_data` for the character that is already loaded —
     * a socket reconnect, or a trip out to character select and back into the
     * same character — is not a switch: data-manager compares the incoming id
     * against `currentCharacterId`, finds them equal, and emits neither
     * `character_switching` nor `character_switched`. It emits
     * `character_initialized` with `_isCharacterSwitch: false`, which is
     * indistinguishable from the first login.
     *
     * So the startup block runs a second time, and the half of the lifecycle
     * that would have taken the first run down — feature-registry's teardown,
     * which only ever runs off `character_switching` — never ran. Every
     * feature's `initialize()` executes over the top of a live one: observers,
     * DOM injections and `config.onSettingChange` callbacks registered twice,
     * and the instance the first run stored dropped on the floor where no
     * later `disable()` can reach it.
     */
    test('does not run a second time when the same character is initialized again', async () => {
        initializeFeaturesCalls = 0;

        await fireCharacterInitialized({ character: { id: 'char-1', name: 'One' }, _isCharacterSwitch: false });
        expect(initializeFeaturesCalls).toBe(1);

        await fireCharacterInitialized({ character: { id: 'char-1', name: 'One' }, _isCharacterSwitch: false });
        expect(initializeFeaturesCalls).toBe(1);
    });

    test('still skips the block outright on a switch, which the registry owns', async () => {
        initializeFeaturesCalls = 0;

        await fireCharacterInitialized({ character: { id: 'char-2', name: 'Two' }, _isCharacterSwitch: true });
        expect(initializeFeaturesCalls).toBe(0);
    });
});

describe('checkMwiToolsWithRetries', () => {
    /**
     * Exercised directly rather than through `character_initialized`: the real
     * call site sits inside a startup block that runs at most once for the
     * life of this module (see `startupBegun` above), so a second attempt at
     * firing it from a later test would be a silent no-op. The exported
     * `_checkMwiToolsWithRetries` reaches the same module-scoped
     * `dualInstallGuard`/`mwiToolsWarned` state without that restriction.
     */
    beforeEach(() => {
        mwiToolsDetected = false;
        toastCalls.length = 0;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const mwiToastShown = () => toastCalls.some((call) => call.message === 'MWITools stand-in message');

    // Order matters within this describe: `mwiToolsWarned` is a one-shot flag
    // on the module, by design ("say it once per page load") — once a test
    // makes it warn, no later test in this file can observe a fresh warning.
    // This one stays negative throughout, so it is safe regardless of order.
    test('MWITools genuinely absent stays silent once every retry has run', async () => {
        entrypointModule._checkMwiToolsWithRetries();

        await vi.advanceTimersByTimeAsync(30_000);

        expect(mwiToastShown()).toBe(false);
    });

    test('an immediate miss is not the last word — a later retry still catches it', async () => {
        entrypointModule._checkMwiToolsWithRetries();
        expect(mwiToastShown()).toBe(false); // nothing detected yet

        // MWITools finishes its own boot in the gap between the immediate
        // check and the first retry.
        mwiToolsDetected = true;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(mwiToastShown()).toBe(true);
    });
});

/**
 * The seam between the entrypoint's feature list and the registry that runs it.
 *
 * The registry's own tests call `replaceFeatures()` with hand-written entries,
 * which is why they never noticed that `concurrent: true` — set on sixteen
 * features and read by `initializeFeatures()` — was being dropped by the
 * entrypoint's mapping and had never once reached production. The mapping
 * builds each entry from an explicit field list, so any field the registry
 * learns to read is dead until somebody remembers to add it here too.
 *
 * These tests close that gap from both ends: one derives the field list from
 * `feature-registry.js` itself so a newly-read field fails until it is
 * forwarded, and one runs two entrypoint-built entries through the real
 * registry and watches them overlap.
 */
describe('the registry entries the entrypoint hands over', () => {
    /**
     * Every field `feature-registry.js` reads off a registry entry, taken from
     * its source rather than from a list kept alongside it — a list would go
     * stale in exactly the way the mapping did.
     * @returns {Array<string>} Field names, sorted
     */
    function fieldsTheRegistryReads() {
        // Resolved off the vitest root rather than `import.meta.url`: under the
        // transform this file runs through, `import.meta.url` is not a file: URL.
        const source = readFileSync(resolve(process.cwd(), 'src/core/feature-registry.js'), 'utf8');
        const fields = new Set();
        for (const match of source.matchAll(/\b(?:feature|featureInstance|f)\.([A-Za-z_$][\w$]*)/g)) {
            fields.add(match[1]);
        }
        return [...fields].sort();
    }

    /**
     * Fields the registry reads that the mapping deliberately does not forward,
     * each with the reason it is not an oversight.
     */
    const notForwarded = {
        // `getFeatureInstance()` reads `feature.module || feature`, and the
        // fallback is the point: teardown has to go through the entry's own
        // `disable` closure, which clears the instance the initializer stored.
        // Forwarding the raw module would hand teardown the module instead and
        // strand that instance.
        module: 'getFeatureInstance falls back to the entry, which carries the disable closure',
    };

    test('every field the registry reads survives the mapping', () => {
        const missing = fieldsTheRegistryReads().filter(
            (field) => !(field in notForwarded) && !registered.some((entry) => entry[field] !== undefined)
        );

        expect(
            missing,
            `feature-registry.js reads ${missing.join(', ')} but no registered entry carries it — ` +
                'either forward it in the entrypoint mapping or record why not in `notForwarded`'
        ).toEqual([]);
    });

    test('a feature marked concurrent is still marked concurrent by the time the registry sees it', () => {
        const tabReorder = registered.find((entry) => entry.key === 'tabReorder');

        expect(tabReorder, 'tabReorder is no longer registered').toBeTruthy();
        expect(tabReorder.concurrent).toBe(true);
        // Not a count assertion: the point is that the flag is not being
        // silently dropped for the whole list, which one surviving flag could
        // still hide if it were the only one hand-written.
        expect(registered.filter((entry) => entry.concurrent).length).toBeGreaterThan(1);
    });

    test('two concurrent features run through the real registry overlap', async () => {
        probe.active = 0;
        probe.peak = 0;

        const entries = registered.filter((entry) => entry.key in probeModules);
        expect(entries).toHaveLength(2);

        realFeatureRegistry.replaceFeatures(entries);
        const failures = await realFeatureRegistry.initializeFeatures();

        expect(failures).toEqual([]);
        // 1 means the registry awaited the first before starting the second,
        // which is what a dropped `concurrent` flag produces.
        expect(probe.peak).toBe(2);
        expect(probe.active).toBe(0);
    });

    /**
     * The features vetted in the second pass over the blocking startup chain,
     * with what each one was found to wait on. Listed here rather than counted,
     * because the count is not the point: a flag silently falling off one of
     * these is a feature quietly back on the critical path, and nothing else in
     * the suite would notice.
     */
    const widenedConcurrent = {
        combatStats: 'its own consumable trackers and last-run snapshot',
        dungeonTrackerChatAnnotations: 'its own dungeon run store',
        labyrinthTracker: 'its own best-levels record',
        overlayPanel: 'its own panel settings and applied layout',
        draggableModals: 'its own modal offsets',
        collectionFilters: 'its own filter record',
        xpTracker: 'its own XP history',
        taskRerollTracker: 'its own stored reroll map, with every post-await registration re-scanning on its own',
    };

    test.each(Object.entries(widenedConcurrent))('%s is handed to the registry marked concurrent', (key, waitsOn) => {
        const entry = registered.find((feature) => feature.key === key);

        expect(entry, `no feature registered under ${key}`).toBeTruthy();
        expect(entry.concurrent, `${key} waits on ${waitsOn} and should overlap, not block`).toBe(true);
    });

    /**
     * Features on the same blocking list that were vetted and deliberately left
     * serial, each with the finding that decided it. Asserted so that flagging
     * one is a deliberate act with a test to change, rather than a tidy-up.
     */
    const deliberatelySerial = {
        chatHistoryExtender:
            'its initialize() has no await at all — the cost is 45 ms of its own CPU, ' +
            'which the flag cannot move off the critical path',
        alchemy_actionProtection:
            'what it installs after its await is the double-confirm guarding an ' +
            'irreversible decompose, not a readout',
    };

    test.each(Object.entries(deliberatelySerial))('%s is left serial', (key, reason) => {
        const entry = registered.find((feature) => feature.key === key);

        expect(entry, `no feature registered under ${key}`).toBeTruthy();
        expect(entry.concurrent, `${key} was left serial because ${reason}`).toBeUndefined();
    });

    test('a teardown that lands mid-initialize does not hand the late instance to the next one', async () => {
        // The concurrency change widened this from one in-flight initializer to
        // fifteen: a `character_switching` teardown now lands in the middle of a
        // whole batch. The teardown reads the instance slot and empties it; the
        // late-resolving initializer used to fill it back in, so the *arriving*
        // character's `disable()` was handed the departing character's instance
        // and the arriving one's was never torn down at all.
        race.instances = [];
        race.disabledWith = [];
        const entry = registered.find((feature) => feature.key === 'overlayPanel');
        expect(entry, 'overlayPanel is no longer registered').toBeTruthy();

        const initializing = entry.initialize();
        // The switch's teardown, while the initializer is still parked.
        entry.disable();
        race.release();
        await initializing;
        // The arriving character's teardown, one switch later.
        entry.disable();

        expect(race.instances).toHaveLength(1);
        expect(race.disabledWith).toEqual([null, null]);
    });

    test('marking a feature concurrent does not move where it starts', async () => {
        // The whole survey rests on this: a concurrent feature is *started* in
        // its turn and only the waiting is deferred, so its own post-await work
        // lands no later in wall-clock than it did before — what moves is only
        // its position relative to the features after it. If the registry ever
        // started the flagged ones as a group instead, every "it waits only on
        // its own record" verdict above would need re-deriving.
        const keys = Object.keys(widenedConcurrent);
        const inRegistryOrder = registered.filter((entry) => keys.includes(entry.key)).map((entry) => entry.key);
        expect(inRegistryOrder).toHaveLength(keys.length);

        const entered = [];
        const entries = inRegistryOrder.map((key) => {
            const real = registered.find((entry) => entry.key === key);
            return {
                key,
                name: key,
                // The real flag, off the real mapping — the point is that these
                // reorder nothing, so substituting `concurrent: true` here would
                // test the stand-in rather than the entrypoint.
                concurrent: real.concurrent,
                // Suspends for a length that runs backwards through the list, so
                // completion order is the reverse of start order and an
                // assertion on `entered` cannot be passing by accident.
                initialize: async () => {
                    entered.push(key);
                    await new Promise((resolve) => setTimeout(resolve, PROBE_AWAIT_MS - entered.length));
                },
            };
        });

        realFeatureRegistry.replaceFeatures(entries);
        const failures = await realFeatureRegistry.initializeFeatures();

        expect(failures).toEqual([]);
        expect(entered).toEqual(inRegistryOrder);
    });
});
