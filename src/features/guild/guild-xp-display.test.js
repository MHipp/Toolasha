/** @vitest-environment happy-dom */

/**
 * The guild sign-up block, and the two class names it used to depend on.
 *
 * Not a test of the whole module — the charts and the sortable columns are
 * their own problem. This is about the failure mode that took the trials
 * feature off the screen without a word: an injection hung off a class name
 * nobody has verified against a live client, plus a second unverified class
 * name used as a *precondition* rather than as a place to put something.
 *
 * Both are invisible when they go wrong. Nothing throws, nothing is logged, and
 * the feature simply is not there — which is indistinguishable, from the
 * player's side, from a feature that was never written.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const game = vi.hoisted(() => ({
    settings: {},
    observers: {},
    wsHandlers: {},
    members: [],
    meta: {},
    currentWeek: '2026-07-31T00:00:00Z',
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => fallback,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (id, classNames, callback) => {
            const names = Array.isArray(classNames) ? classNames : [classNames];
            for (const name of names) game.observers[name] = callback;
            return () => {
                for (const name of names) delete game.observers[name];
            };
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        // Resolves a tick late on purpose: the fold preference arrives from
        // IndexedDB after the block has drawn, which is the race under test
        get: async (key, store, fallback) => {
            await Promise.resolve();
            return game.stored?.[key] ?? fallback;
        },
        set: async (key, value) => {
            (game.stored ??= {})[key] = value;
            return true;
        },
    },
}));
vi.mock('../chat/chat-profile-link.js', () => ({ markAsProfileLink: () => {} }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerInterval: () => {}, registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getMemberList: () => game.members,
        getMemberMeta: (id) => game.meta[id] || null,
        getCurrentWeekStartAt: () => game.currentWeek,
        getOwnGuildName: () => 'Milky Way',
    },
}));

/**
 * Re-imported per test, not held from module load.
 *
 * The remembered fold lives in two module-level bindings — the boolean and the
 * memoised promise that hydrates it once per page load. Memoising is right for
 * the page (the first render has to have something to await, and a boolean
 * latch left the fold unapplied on every reload), but it means the FIRST test
 * to draw the block fixes the answer for the whole file: a later test that puts
 * `guildTrialSignupsCollapsed: true` in storage gets the earlier test's `false`
 * back, because nothing reads storage a second time. A fresh module per test is
 * a fresh page load, which is what each test is written as.
 */
let guildXPDisplay;

/**
 * A member who has signed up for neither trial this week.
 * @param {string} name - Character name
 * @returns {Object} A member and its meta, registered with the fake tracker
 */
function unsignedMember(name) {
    const characterID = name.toLowerCase();
    const meta = {
        name,
        characterID,
        joinTime: '2026-07-01T00:00:00Z',
        signupWeekStartAt: null,
        signedUpSkillingTrialHrid: '',
        signedUpCombatTrialHrid: '',
    };
    game.members.push({ characterID });
    game.meta[characterID] = meta;
    return meta;
}

/**
 * The trials tab, with or without the two class names in question.
 * @param {Object} [options] - `{container, statusRow}`
 * @returns {Element} The panel root
 */
function buildTab({ container = 'GuildPanel_trialsContent__a', statusRow = true } = {}) {
    document.body.innerHTML = '';

    const panel = document.createElement('div');
    panel.className = 'GuildPanel_guildPanel__z';

    const tab = document.createElement('div');
    tab.className = container;

    if (statusRow) {
        const status = document.createElement('div');
        status.className = 'GuildPanel_eventStatusRow__b';
        status.textContent = 'In progress — 42:15 remaining';
        tab.appendChild(status);
    }

    const card = document.createElement('div');
    card.className = 'GuildPanel_tile__c';
    card.innerHTML =
        '<div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
        '<div class="GuildPanel_tileSummary__e">Lv.140</div>';
    tab.appendChild(card);

    panel.appendChild(tab);
    document.body.appendChild(panel);
    return panel;
}

/** The injected block, if it is there. @returns {Element|null} */
const block = () => document.querySelector('.mwi-trial-signups');

beforeEach(async () => {
    vi.resetModules();
    ({ guildXPDisplay } = await import('./guild-xp-display.js'));
    game.settings = { guildXPDisplay: true, guildTrialSignupDisplay: true };
    game.observers = {};
    game.wsHandlers = {};
    game.members = [];
    game.meta = {};
    game.stored = {};
    guildXPDisplay.initialized = false;
    guildXPDisplay.unregisterObservers = [];
    document.body.innerHTML = '';
});

afterEach(() => {
    guildXPDisplay.disable();
    document.body.innerHTML = '';
});

describe('the trial sign-up block', () => {
    test('a remembered fold is applied even though it loads after the first draw', async () => {
        // The production report: the tooltip promises "remembered across
        // reloads", but the async read landed after the block was drawn and
        // nothing re-applied it — every reload came back unfolded
        game.stored = { guildTrialSignupsCollapsed: true };
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab();
        game.observers['GuildPanel_trialsContent']();

        await vi.waitFor(() => {
            const body = block().children[1];
            expect(body.style.display).toBe('none');
            expect(block().textContent).toContain('▸');
        });
    });

    test('is drawn when the tab is called what it was assumed to be called', () => {
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab();
        game.observers['GuildPanel_trialsContent']();

        expect(block()).toBeTruthy();
        expect(block().textContent).toContain('Ada');
    });

    test('and when it is called something else entirely', () => {
        // The bug in one line: the tab container has never been verified, and
        // one wrong guess withheld the block with nothing logged anywhere
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab({ container: 'GuildPanel_whateverTheyCallItNow__q' });
        game.observers['GuildPanel_tileSummary']();

        expect(block()).toBeTruthy();
        expect(block().textContent).toContain('Ada');
    });

    test('a missing status row is a placement problem, not a reason to withhold it', () => {
        // Who has not signed up does not depend on the game drawing a status
        // line above the cards
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab({ statusRow: false });
        game.observers['GuildPanel_tileSummary']();

        expect(block()).toBeTruthy();

        // Placed above the first card, which is where the status row would have been
        const card = document.querySelector('[class*="GuildPanel_tile__"]');
        expect(block().compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('it goes under the status row when there is one', () => {
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab();
        game.observers['GuildPanel_tileSummary']();

        expect(block().previousElementSibling.className).toContain('GuildPanel_eventStatusRow');
    });

    test('the In Progress tab is not the sign-up sheet’s tab', () => {
        // Reported: the roster appeared over the In Progress tab after the trial
        // advanced a tier — which is precisely when that tab redraws and the
        // observer fires again. Both tabs are trial cards under one panel, so
        // the root finder cannot tell them apart and this has to ask.
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__z"><div class="GuildPanel_inProgress__p">' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
            '<div class="ProgressBar_text__f">506,273 / 669,500</div></div></div></div>';
        game.observers['GuildPanel_tileSummary']();

        expect(block()).toBeNull();
    });

    test('switching to In Progress takes the block away with it', () => {
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab();
        game.observers['GuildPanel_tileSummary']();
        expect(block()).toBeTruthy();

        document.body.innerHTML =
            '<div class="GuildPanel_guildPanel__z"><div class="GuildPanel_inProgress__p">' +
            '<div class="GuildPanel_tile__c"><div class="GuildPanel_tileName__d">Trial Chameleon</div>' +
            '<div class="ProgressBar_text__f">506,273 / 669,500</div></div></div></div>';
        game.observers['GuildPanel_tileSummary']();

        expect(block()).toBeNull();
    });

    test('a guild page with no trial cards on it is not drawn into', () => {
        // The members tab is a guild panel too, and the fallback root is the
        // panel — so "is there a card" has to be what decides
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        document.body.innerHTML = '<div class="GuildPanel_guildPanel__z"><table></table></div>';
        game.observers['GuildPanel_tileSummary']();

        expect(block()).toBeNull();
    });

    test('everybody signed up says so rather than drawing an empty list', () => {
        const ada = unsignedMember('Ada');
        ada.signupWeekStartAt = game.currentWeek;
        ada.signedUpSkillingTrialHrid = '/guild_trials/milking';
        ada.signedUpCombatTrialHrid = '/guild_trials/chameleon';

        guildXPDisplay.initialize();
        buildTab();
        game.observers['GuildPanel_tileSummary']();

        expect(block().textContent).toContain('All signed up');
        expect(block().textContent).not.toContain('Ada');
    });

    test('drawing twice leaves one block, not two', () => {
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab();
        game.observers['GuildPanel_tileSummary']();
        game.observers['GuildPanel_tileSummary']();

        expect(document.querySelectorAll('.mwi-trial-signups')).toHaveLength(1);
    });

    test('the setting still switches it off', () => {
        game.settings.guildTrialSignupDisplay = false;
        unsignedMember('Ada');
        guildXPDisplay.initialize();

        buildTab();
        game.observers['GuildPanel_tileSummary']();

        expect(block()).toBeNull();
    });
});

describe('_parseWeeklyXP — locale-grouped figures', () => {
    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    test('en-US comma grouping, with K/M suffixes', () => {
        localStorage.setItem('i18nextLng', 'en-US');
        _resetGameNumberSeparators();
        expect(guildXPDisplay._parseWeeklyXP('1,234')).toBe(1234);
        expect(guildXPDisplay._parseWeeklyXP('12K')).toBe(12_000);
    });

    test('de-DE period grouping — the bug this replaces', () => {
        // A hardcoded `[\d,.]+` already tolerates comma/period swapped roles
        // (both are in the class either way), so this pins that the fix keeps
        // it working, not that it was broken.
        localStorage.setItem('i18nextLng', 'de-DE');
        _resetGameNumberSeparators();
        expect(guildXPDisplay._parseWeeklyXP('1.234')).toBe(1234);
    });
});
