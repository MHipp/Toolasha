/**
 * Toolasha Entrypoint
 * Minimal bootstrap script that loads libraries and initializes features
 *
 * Libraries are loaded via @require in userscript header:
 * - Core (core modules, API)
 * - Utils (all utilities)
 * - Market (market, inventory, economy)
 * - Actions (production, gathering, alchemy)
 * - Combat (combat, stats, abilities)
 * - UI (tasks, skills, settings, misc)
 */

// ---------------------------------------------------------------------------
// Library-load guard.
//
// The @require bundles populate window.Toolasha.{Core,Utils,…}. They load as raw
// repository content from a CDN, so a GitHub or CDN outage can leave one or more
// unset — and every read below would then throw a cryptic "window.Toolasha is
// undefined" with no hint why. Catch that here, tell the user what actually
// happened using nothing from the libraries (they are the thing missing), and —
// since the usual cause is GitHub itself — confirm it against GitHub's status
// page, which lives on separate infrastructure and stays up during a GitHub
// outage. (2026-08-17: a GitHub incident that 50%-errored raw content downloads
// broke the @require loads for everyone, presenting only as this cryptic throw.)
// ---------------------------------------------------------------------------

const REQUIRED_LIBRARIES = ['Core', 'Utils', 'Market', 'Actions', 'Combat', 'UI'];

/** Which required library globals did not load. */
function missingLibraries(ns) {
    return REQUIRED_LIBRARIES.filter((lib) => !ns || !ns[lib]);
}

/** GM's cross-origin request, whichever grant this manager exposes, or null. */
function gmRequest() {
    if (typeof GM_xmlhttpRequest !== 'undefined') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest;
    return null;
}

/** A self-contained banner — the libraries' own toast may be the thing missing. */
function showLoadErrorBanner(html) {
    try {
        let el = document.getElementById('toolasha-load-error');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toolasha-load-error';
            el.style.cssText =
                'position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:2147483647; ' +
                'max-width:min(92vw,520px); padding:12px 16px; border-radius:8px; background:#2a1418; ' +
                'border:1px solid #7a2e34; color:#f3d6d6; font:13px/1.5 system-ui,sans-serif; ' +
                'box-shadow:0 6px 24px rgba(0,0,0,0.5);';
            (document.body || document.documentElement).appendChild(el);
        }
        el.innerHTML = html;
        return el;
    } catch {
        return null;
    }
}

/** The line the banner settles on, given GitHub's status indicator. */
function githubOutageLine(indicator, description) {
    if (indicator && indicator !== 'none') {
        return (
            '<b>GitHub is having an outage right now</b>' +
            (description ? ` (${description})` : '') +
            ' — that is why Toolasha could not load its code, not a bug in the script. It will fix ' +
            'itself; refresh once GitHub is back.'
        );
    }
    return (
        'Toolasha could not load its code libraries, but GitHub reports no outage — this may be your ' +
        'network or the CDN. Refresh in a minute or two.'
    );
}

/**
 * Explain a failed library load, confirming the usual cause (GitHub) against its
 * status page. Best-effort and self-contained; never throws.
 * @param {string[]} missing - The library globals that did not load
 */
function reportLibraryLoadFailure(missing) {
    const heading = '<div style="font-weight:600; margin-bottom:4px;">Toolasha didn’t load</div>';
    const link = '<a href="https://www.githubstatus.com" target="_blank" style="color:#ffb3b3;">githubstatus.com</a>';
    showLoadErrorBanner(
        heading +
            `<div>Its code libraries (${missing.join(', ')}) failed to download — almost always a ` +
            `temporary GitHub or CDN outage, since they load as raw repository content. Checking ${link}…</div>`
    );
    const request = gmRequest();
    if (!request) return;
    try {
        request({
            method: 'GET',
            url: 'https://www.githubstatus.com/api/v2/status.json',
            timeout: 8000,
            onload: (response) => {
                try {
                    const data = JSON.parse(response?.responseText || '{}');
                    const line = githubOutageLine(data?.status?.indicator, data?.status?.description);
                    showLoadErrorBanner(`${heading}<div>${line} ${link}</div>`);
                } catch {
                    /* the "checking…" message stands */
                }
            },
            onerror: () => {},
            ontimeout: () => {},
        });
    } catch {
        /* the base message stands */
    }
}

// Access libraries from the global namespace — resolved from window, or from
// unsafeWindow on a manager that isolates the page context.
const toolashaNamespace =
    (typeof window !== 'undefined' && window.Toolasha) ||
    (typeof unsafeWindow !== 'undefined' && unsafeWindow.Toolasha) ||
    null;

const missingLibs = missingLibraries(toolashaNamespace);
if (missingLibs.length) {
    reportLibraryLoadFailure(missingLibs);
    throw new Error(
        `Toolasha libraries failed to load (${missingLibs.join(', ')}) — likely a GitHub/CDN outage. Refresh shortly.`
    );
}

const Core = toolashaNamespace.Core;
const Utils = toolashaNamespace.Utils;
const Market = toolashaNamespace.Market;
const Actions = toolashaNamespace.Actions;
const Combat = toolashaNamespace.Combat;
const UI = toolashaNamespace.UI;

// Destructure core modules
const {
    storage,
    config,
    webSocketHook,
    domObserver,
    dataManager,
    featureRegistry,
    performanceMonitor,
    marketAPI,
    errorLog,
    dualInstallGuard,
} = Core;

// Claim the page before anything else can. Two Toolasha userscripts share one
// database and one settings map, and the loser of that race has its settings
// and custom tabs deleted — so the earliest possible moment is the right one to
// find out. See dual-install-guard.js for what each signal can and cannot see.
let dualInstallClaimed = false;
try {
    dualInstallClaimed = dualInstallGuard?.claimPage?.() || false;
} catch (error) {
    console.error('[Toolasha] Dual-install claim failed:', error);
}

/** Say it once, however many signals fired */
let dualInstallWarned = false;
function warnDualInstall() {
    if (dualInstallWarned) return;
    dualInstallWarned = true;
    console.warn(`[Toolasha] ${dualInstallGuard.DUAL_INSTALL_MESSAGE}`);
    // duration 0 — this one stays until the user dismisses it, because the
    // damage keeps happening for as long as both copies are enabled
    try {
        showToast(dualInstallGuard.DUAL_INSTALL_MESSAGE, { kind: 'error', duration: 0 });
    } catch (error) {
        console.error('[Toolasha] Dual-install warning could not be shown:', error);
    }
}

/**
 * Say it once per page load, no matter how many character switches follow.
 *
 * MWITools does not share Toolasha's database, so this is not the settings-loss
 * emergency the dual-install warning is — a plain once-per-session toast is
 * enough, with no persisted mute: the two scripts still duplicate each other's
 * task sorting, market filters, DPS panel, net worth tracking, and tooltips
 * for as long as both stay enabled, which the user finds out about once and
 * then acts on or ignores for the rest of the session.
 */
let mwiToolsWarned = false;
function warnMwiTools() {
    if (mwiToolsWarned) return;
    mwiToolsWarned = true;
    console.warn(`[Toolasha] ${dualInstallGuard.MWI_TOOLS_MESSAGE}`);
    try {
        showToast(dualInstallGuard.MWI_TOOLS_MESSAGE, { kind: 'error', duration: 0 });
    } catch (error) {
        console.error('[Toolasha] MWITools warning could not be shown:', error);
    }
}

/**
 * Delays (ms) after the first check at which {@link checkMwiToolsWithRetries}
 * tries again, for as long as MWITools still has not been seen.
 */
const MWI_TOOLS_RETRY_DELAYS_MS = [1000, 3000, 7000];

/**
 * Check for MWITools now, then again a few times over the following seconds
 * if the first check found nothing.
 *
 * The call site below runs once, from the settled block of startup — already
 * well past where both scripts' own boot code normally lands, per its own
 * comment. "Normally" is not a guarantee, though: a userscript manager does
 * not order two independent scripts against each other, and MWITools' own
 * public-api module can just as easily sit behind an async chain gated on the
 * same kind of game-ready signal this startup block is. If that chain happens
 * to settle after this point, a single check finding nothing is
 * indistinguishable from MWITools not being installed — and since the caller
 * only ever calls this once per page load, that miss would otherwise last the
 * whole session. Retrying a few times over the following seconds closes that
 * window without turning this into an open-ended poll.
 * @returns {void}
 */
function checkMwiToolsWithRetries() {
    const check = () => {
        try {
            if (dualInstallGuard.detectMwiTools()) {
                warnMwiTools();
                return true;
            }
        } catch (error) {
            console.error('[Toolasha] MWITools check failed:', error);
        }
        return false;
    };

    if (check()) return;
    const retry = () => {
        if (mwiToolsWarned) return;
        check();
    };
    for (const delay of MWI_TOOLS_RETRY_DELAYS_MS) {
        setTimeout(retry, delay);
    }
}

// Start catching our own errors before anything below can produce one. The
// hooks only ever record and never throw, so nothing here is made riskier by
// installing them first; a Core bundle without the module (a stale cache of an
// older library) just leaves the Diagnostics section's error list empty.
errorLog?.install?.();

const { setupScrollTooltipDismissal, addStyles } = Utils.dom;
const { showToast } = Utils.toast;
const { GAME } = Utils.selectors;

// Every native <select> the script injects carries the `toolasha-select` class
// (see AGENTS.md / the select-option-contrast sweep). Firefox's open dropdown
// renders on its own native popup rather than picking up the select's inline
// dark background, so an option with only its `color` set (light, to match
// the closed control) reads as light-on-white — unreadable except for the
// highlighted row. Options need an explicit background *and* text color of
// their own; setting both here (rather than per-select inline styles) covers
// every current and future `toolasha-select` from one rule, and reads
// correctly whether the platform's native popup default is light or dark.
addStyles('.toolasha-select option { background-color: #1a1a2e; color: #e0e0e0; }', 'toolasha-select-option-contrast');

// Publishes --toolasha-visual-viewport-height/-offset-top on <html> so panel
// CSS can size against the visible viewport rather than the layout one, which
// does not shrink for the mobile on-screen keyboard. `<html>` exists at
// document-start, so this needs no delay; never torn down, since it runs for
// the life of the page the same as the select-option-contrast style above.
Utils.visualViewport?.initVisualViewportTracking?.();

/**
 * Detect if running on a supported Combat Simulator page.
 *
 * Kept inline rather than imported: this bundle imports nothing from `src/` (it reads the
 * @require'd libraries off `window.Toolasha`, which are not loaded on a simulator page).
 * The canonical list lives in `src/features/combat/combat-sim-targets.js`, and
 * `combat-sim-targets.test.js` asserts this copy stays in sync with it.
 *
 * @returns {boolean} True if on a Combat Simulator
 */
function isCombatSimulatorPage() {
    const url = window.location.href;
    return (
        url.includes('shykai.github.io/MWICombatSimulatorTest/dist/') ||
        url.includes('szerra.github.io/mwi-shrine-combat-simulator/')
    );
}

/* ------------------------------------------------------------------------- *
 * Health checks
 *
 * `featureRegistry.checkFeatureHealth()` has run since the beginning and has
 * always found nothing, because it skips any feature without a `healthCheck`
 * and no feature had one. The registry entry is the right place to put them:
 * a check belongs to how the feature is wired into the page, not to the module,
 * and writing them here keeps ~150 feature modules untouched.
 *
 * The contract the registry expects, from `checkFeatureHealth`:
 *
 *   true   — healthy
 *   false  — broken; the feature is retried once and then reported
 *   null   — cannot tell right now; ignored
 *
 * The registry has already skipped anything switched off (`customCheck`, or
 * `config.isFeatureEnabled(key)`) before calling these, so a check never has to
 * ask whether its own feature is on. It does have to ask about the sub-settings
 * that gate what gets drawn — `actionBar_enabled` under `actionTimeDisplay`,
 * for instance — because a feature whose output the player turned off is not a
 * feature that failed. Those cases return true.
 *
 * Every check is the same shape: *given the game has drawn the thing this
 * feature attaches to, did the feature's own mark appear on it?* No anchor
 * means the panel is not open, which is not evidence of anything — null. The
 * predicates, feature by feature:
 *
 *   networth              header total-level block exists  → .mwi-networth-header
 *   marketOrderTotals     header total-level block exists  → .mwi-market-order-totals
 *   actionTimeDisplay     header action-name block exists  → #mwi-action-time-display
 *   taskIcons             a task card is on screen         → [data-mwi-task-processed]
 *   taskStatistics        the Tasks tab strip exists       → .toolasha-task-stats-btn
 *   overlayTabButton      the tab strip holding Inventory  → #toolasha-overlay-tab
 *   skillExpPercentage    a nav XP bar with a width        → .mwi-exp-percentage
 *   skillRemainingXP      a nav XP bar with a label        → .mwi-remaining-xp
 *   inventoryBadgeManager inventory item containers        → [data-ask-value] on one
 *   inventoryBadgePrices  an item priced above zero        → .mwi-badge-price-ask/bid
 *   itemCountDisplay      marketplace item tiles           → .mwi-item-count
 *   zoneIndices           combat zone tab buttons          → span.script_mapIndex
 *   combatScore           a profile overview tab is open   → #mwi-combat-score-panel
 *
 * None of the above can catch the game renaming its own classes wholesale — an
 * absent anchor just reads as "null, ignored" everywhere above. `checkAnchorCanaries`
 * is the separate check for that: a handful of selectors for elements that exist
 * on any loaded game page no matter which panel is open (the header, the page's
 * own wrapper, the persistent skill nav bars). It runs once, on the same delay as
 * the health pass, and reports through the same `UI.healthStatus.reportFailures`
 * channel with reason "selector missing — game update?".
 *
 * `UI.schemaCanary` is the third of these, and the one that looks at neither the
 * page nor the features but at the game's own data: the top-level maps this
 * script indexes by literal key, the item and buff-type hrids it matches by
 * literal string, and the dungeon wave counts it falls back to. Those fail even
 * more quietly than a selector does — a renamed map is `{}`, a renamed hrid is
 * `null` — so it runs beside the selector canary and reports through the same
 * channel with reason "data shape changed — game update?".
 * ------------------------------------------------------------------------- */

/**
 * The shape every check shares: no anchor is no evidence, an anchor without the
 * mark is a failure.
 *
 * @param {string} anchor - Selector for the game element the feature attaches to
 * @param {string} marker - Selector for what the feature injects
 * @returns {boolean|null} true healthy, false broken, null undecidable
 */
function injectedInto(anchor, marker) {
    if (!document.querySelector(anchor)) return null;
    return Boolean(document.querySelector(marker));
}

/**
 * A check that only applies while a sub-setting is on.
 *
 * A switched-off readout must never read as a broken one — that is the failure
 * mode that would make the whole health pass noise the moment anybody turned
 * something off.
 *
 * @param {string} setting - Setting key gating the visible output
 * @param {Function} check - The predicate to run when it is on
 * @returns {boolean|null} true when the setting is off, else the predicate
 */
function whenSetting(setting, check) {
    if (!config.getSetting(setting)) return true;
    return check();
}

/**
 * The character panel's tab strip, identified by holding an Inventory tab —
 * every tab strip in the game shares the same classes.
 * @returns {HTMLElement|null} The strip, or null if it is not drawn
 */
function findCharacterTabList() {
    for (const list of document.querySelectorAll('[role="tablist"]')) {
        for (const tab of list.querySelectorAll('[role="tab"]')) {
            if (tab.textContent.trim() === 'Inventory') return list;
        }
    }
    return null;
}

/**
 * One list of failures from several, with each feature named once.
 *
 * A feature whose initializer threw will usually also fail its health check, and
 * a toast that says "2 features failed" about one feature is a toast nobody
 * trusts the next time. The first reason wins, because the throw says more than
 * "its mark is missing" does.
 *
 * @param {...Array<{key: string, name: string, reason: string}>} lists - Failure lists
 * @returns {Array<{key: string, name: string, reason: string}>} Deduplicated by key
 */
function mergeFailures(...lists) {
    const byKey = new Map();
    for (const list of lists) {
        for (const failure of list || []) {
            if (!byKey.has(failure.key)) byKey.set(failure.key, failure);
        }
    }
    return [...byKey.values()];
}

/**
 * The failed-features half of the startup health pass: wait for the DOM to
 * settle, check health, retry what still looks broken once, and report
 * whatever survives that.
 *
 * Shared between boot and a character switch's `initializeFeatures()`. Boot
 * has always had this — a health check, one retry pass, and a user-facing
 * toast for what does not come back — but the switch handler used to discard
 * `initializeFeatures()`'s return value entirely, so a feature that threw
 * during a character switch stayed dead, silently, until the page was
 * reloaded. Routing both paths through the same function means a feature that
 * fails a switch's init gets exactly the recovery boot gives it.
 *
 * @param {Array<{key: string, name: string, reason: string}>} initFailures - What initializeFeatures() reported
 * @returns {void}
 */
function scheduleFailedFeatureRecovery(initFailures) {
    setTimeout(async () => {
        const failedFeatures = mergeFailures(initFailures, featureRegistry.checkFeatureHealth());
        if (failedFeatures.length === 0) return;

        console.warn(
            '[Toolasha] Health check found failed features:',
            failedFeatures.map((f) => f.name)
        );

        setTimeout(async () => {
            // What the retry could not fix, plus whatever the second health
            // pass still objects to. A feature that came up on the second
            // attempt — usually because the panel it anchors to had not been
            // drawn yet — is not worth interrupting anybody about.
            const retryFailures = await featureRegistry.retryFailedFeatures(failedFeatures);
            const stillFailed = mergeFailures(retryFailures, featureRegistry.checkFeatureHealth());

            if (stillFailed.length > 0) {
                console.warn(
                    '[Toolasha] These features could not initialize:',
                    stillFailed.map((f) => f.name)
                );
                console.warn('[Toolasha] Try refreshing the page or reopening the relevant game panels');
                UI.healthStatus.reportFailures(stillFailed);
            }
        }, 1000);
    }, 500);
}

/**
 * The selectors that should exist on a loaded game page, checked once, well
 * after startup, to catch the one failure a per-feature health check cannot:
 * the game renaming its classes out from under every selector at once. A
 * missing feature mark says "reopen the panel"; a missing anchor says the game
 * updated.
 *
 * Two kinds of entry:
 *
 * - **Ungated** (the first four): anchors that exist on any loaded page no
 *   matter which panel is open — the header, the page's own wrapper, the
 *   persistent skill nav bars. Their absence is always evidence.
 * - **Gated** (`when`): the highest-fanout hashed-class selectors in the
 *   codebase — `Item_itemContainer` alone is load-bearing in twenty-odd files
 *   — which only exist on particular screens. Each is checked only while its
 *   `when` selector matches: an element from the same screen that cannot be
 *   drawn without the canaried one. A closed panel therefore reads as "no
 *   evidence" rather than as a failure, which is what keeps this from being
 *   noise on every page where a panel is legitimately shut.
 *
 * Gates are taken from a *different* CSS-module component wherever one
 * co-exists (Inventory_↔Item_, Chat_→ChatMessage_, BattlePanel_→CombatUnit_,
 * [role="tablist"]→TabsComponent_), so a whole component renaming still trips
 * the canary whose gate survived. Where no cross-component witness exists
 * (SkillActionDetail, RandomTask) the pair gates on a sibling class: a rename
 * of one class in the component is caught, a rename of the whole component
 * falls back to the ungated four.
 *
 * The name half of the SkillActionDetail pair gates on the *regular* component
 * (`SkillActionDetail_regularComponent`) rather than the shared detail wrapper,
 * because the alchemy and enhancing panels reuse that wrapper but draw no name
 * heading — gating on the wrapper alarmed on every alchemy or enhancing screen.
 * Detection of a real `_name` rename survives: the regular panel still carries
 * the name, so a rename there trips it as before.
 *
 * Left out on purpose, despite their fanout: `Item_enhancementLevel` (only
 * drawn when an enhanced item happens to be on screen — no screen guarantees
 * one, so its absence is never evidence) and `ProgressBar_text` (absent
 * whenever the action queue is empty, and only one file leans on it).
 *
 * Left out for want of a gate: `GuildPanel_exchangeModalContent`, the guild
 * credit exchange modal the exchange advisor hangs off. Every witness available
 * for "that modal is open" is satisfied on screens where it is not — the guild
 * panel is open far more often than the modal is, the shared `Modal_` wrapper
 * belongs to every modal in the game, and the item selector inside it is drawn
 * by other guild modals too — so any gate would alarm on a healthy screen. Its
 * own class is the only thing that witnesses it, which is not a canary. Same
 * reasoning for `ItemSelector_menu`, handled below by canarying the picker it
 * belongs to rather than the dropdown itself.
 *
 * @returns {Array<{key: string, name: string, reason: string}>} One entry per missing anchor
 */
function checkAnchorCanaries() {
    // A disconnected game is not a broken one. When the socket drops (another
    // tab logs the account in, a server restart), the game replaces itself
    // with a full-screen connection message and tears the header and nav down
    // — three ungated anchors gone at once, none of them evidence of a game
    // update. No anchor means anything until the game is back.
    if (document.querySelector(GAME.CONNECTION_MESSAGE)) return [];
    const ANCHORS = [
        { key: 'canaryHeaderTotalLevel', name: 'Header (total level)', selector: GAME.TOTAL_LEVEL },
        { key: 'canaryGamePanel', name: 'Game panel wrapper', selector: GAME.GAME_PANEL },
        { key: 'canaryNavLevel', name: 'Navigation bar (skill levels)', selector: GAME.NAV_LEVEL },
        { key: 'canaryNavExperience', name: 'Navigation bar (skill XP)', selector: GAME.NAV_CURRENT_EXPERIENCE },
        // Gated: checked only while `when` matches
        { key: 'canaryNavBar', name: 'Navigation bar (nav entries)', selector: GAME.NAV_BAR, when: GAME.NAV_LEVEL },
        {
            key: 'canaryTabsContainer',
            name: 'Tab strip (container)',
            selector: GAME.TABS_CONTAINER,
            when: '[role="tablist"]',
        },
        { key: 'canaryTabBadge', name: 'Tab strip (badges)', selector: GAME.TAB_BADGE, when: GAME.TABS_CONTAINER },
        {
            key: 'canaryItemContainer',
            name: 'Item tiles',
            selector: GAME.ITEM_CONTAINER,
            when: GAME.INVENTORY_ITEMS,
        },
        {
            key: 'canaryInventoryItems',
            name: 'Inventory item grid',
            selector: GAME.INVENTORY_ITEMS,
            when: GAME.ITEM_CONTAINER,
        },
        {
            key: 'canaryItemName',
            name: 'Item names (requirements list)',
            selector: GAME.ITEM_NAME,
            when: GAME.SKILL_ACTION_ITEM_REQUIREMENTS,
        },
        {
            key: 'canarySkillActionDetail',
            name: 'Skill action panel',
            selector: GAME.SKILL_ACTION_DETAIL,
            when: GAME.SKILL_ACTION_NAME,
        },
        {
            key: 'canarySkillActionName',
            name: 'Skill action panel (name)',
            selector: GAME.SKILL_ACTION_NAME,
            // Gated on the regular component, not the shared detail wrapper: the
            // alchemy and enhancing panels reuse that wrapper but draw no name,
            // so gating on the wrapper false-alarms whenever one is on screen.
            when: GAME.SKILL_ACTION_DETAIL_REGULAR,
        },
        { key: 'canaryTaskCard', name: 'Task cards', selector: GAME.TASK_CARD, when: GAME.TASK_NAME },
        {
            key: 'canaryChatMessage',
            name: 'Chat messages',
            selector: GAME.CHAT_MESSAGE,
            when: GAME.CHAT_INPUT_CONTAINER,
        },
        {
            key: 'canaryCombatUnit',
            name: 'Combat units',
            selector: GAME.COMBAT_UNIT,
            when: GAME.BATTLE_MONSTERS_AREA,
        },
        // Marketplace anchors. The item grid is present whenever the panel is
        // open; the current-item and order-books halves only appear once an item
        // is selected, so they gate on each other (a mirrored pair: renaming
        // either one is caught by the other, as long as the sibling survives).
        {
            key: 'canaryMarketItems',
            name: 'Marketplace item grid',
            selector: GAME.MARKETPLACE_ITEMS,
            when: GAME.MARKETPLACE_PANEL,
        },
        {
            key: 'canaryMarketCurrentItem',
            name: 'Marketplace current item',
            selector: GAME.MARKETPLACE_CURRENT_ITEM,
            when: GAME.MARKETPLACE_ORDER_BOOKS,
        },
        {
            key: 'canaryMarketOrderBooks',
            name: 'Marketplace order books',
            selector: GAME.MARKETPLACE_ORDER_BOOKS,
            when: GAME.MARKETPLACE_CURRENT_ITEM,
        },
        {
            key: 'canaryMarketNewListingButtons',
            name: 'Marketplace new-listing buttons',
            selector: GAME.MARKETPLACE_NEW_LISTING_BUTTONS,
            when: GAME.MARKETPLACE_CURRENT_ITEM,
        },
        // Header current-action anchors, another mirrored pair. The community
        // buff row is drawn inside the action-info block, so the two always
        // render together and either one renaming is caught by the other. They
        // are gated on each other rather than on the header as a whole because
        // the action block is not drawn on every screen the header is.
        {
            key: 'canaryHeaderActionInfo',
            name: 'Header (current action block)',
            selector: GAME.HEADER_ACTION_INFO,
            when: GAME.HEADER_COMMUNITY_BUFFS,
        },
        {
            key: 'canaryHeaderCommunityBuffs',
            name: 'Header (community buff row)',
            selector: GAME.HEADER_COMMUNITY_BUFFS,
            when: GAME.HEADER_ACTION_INFO,
        },
        // The leaderboard table, read by both the standalone leaderboard's XP
        // tracker and the guild panel's. Gated on the panel's own content
        // wrapper — a sibling class, the SkillActionDetail case: the table is
        // reached from it with closest(), so an open leaderboard always has
        // both, and a closed one has neither.
        {
            key: 'canaryLeaderboardTable',
            name: 'Leaderboard table',
            selector: GAME.LEADERBOARD_TABLE,
            when: GAME.LEADERBOARD_CONTENT,
        },
        // The item-picker component behind alchemy's and enhancing's pins and
        // dimming, and the guild exchange advisor's read of what is selected.
        // `ItemSelector_menu` — the class those features actually name — is the
        // dropdown, drawn only while the player holds one open, and nothing
        // else on the page witnesses that; canarying it would alarm on every
        // screen. The component is caught one level out instead: the alchemy
        // panel's primary slot container (a SkillActionDetail_ class, so a
        // cross-component gate) always holds a picker, drawn as an empty slot
        // until an item is in it and as a filled selector after. Either shape
        // satisfies it; the component renaming leaves neither.
        {
            key: 'canaryItemSelector',
            name: 'Item picker (skill action slot)',
            selector: `${GAME.ITEM_SELECTOR_SLOT}, ${GAME.ITEM_SELECTOR_EMPTY_SLOT}`,
            when: GAME.SKILL_ACTION_PRIMARY_ITEM_SELECTOR,
        },
        // Character names in the post-trial stats modal — the only place this
        // script reads the class. The name is where the exact `data-name` lives,
        // and a rename empties every row's name, which the scraper drops
        // silently. Gated on the modal's own table (a different component's
        // class in the same modal): the rows are inside it, so the table on
        // screen with no name in it is the rename.
        {
            key: 'canaryTrialStatsName',
            name: 'Guild trial stats (member names)',
            selector: GAME.CHARACTER_NAME,
            when: GAME.GUILD_TRIAL_STATS_TABLE,
        },
    ];

    const failures = [];
    for (const { key, name, selector, when } of ANCHORS) {
        if (when && !document.querySelector(when)) continue;
        if (!document.querySelector(selector)) {
            failures.push({ key, name, reason: 'selector missing — game update?' });
        }
    }

    // The React fiber root. Fifteen features climb it for game methods
    // (profile popups, marketplace navigation, chat commands, task tools),
    // every one via the legacy `_reactRootContainer` key — which a React 18
    // createRoot migration renames to `__reactContainer$<random>` in one
    // stroke, failing all of them to null with no error. Not a selector, so
    // it cannot ride the ANCHORS table; gated on the game page having
    // rendered (the panel wrapper), the same way the table gates on `when`.
    const rootEl = document.getElementById('root');
    if (rootEl && document.querySelector(GAME.GAME_PANEL)) {
        const fiber = rootEl._reactRootContainer?.current || rootEl._reactRootContainer?._internalRoot?.current;
        if (!fiber) {
            failures.push({
                key: 'canaryFiberRoot',
                name: 'React fiber root (game internals)',
                reason: 'fiber key missing — game React update?',
            });
        }
    }
    return failures;
}

/**
 * Is any element matching `selector` carrying a value above zero in `field`?
 * @param {string} selector - Element selector
 * @param {string} field - dataset key
 * @returns {boolean} True if at least one is positive
 */
function anyPositiveDataset(selector, field) {
    for (const el of document.querySelectorAll(selector)) {
        if (parseFloat(el.dataset[field]) > 0) return true;
    }
    return false;
}

/**
 * Register all features from libraries into the feature registry
 */
function registerFeatures() {
    // Market Features
    const marketFeatures = [
        {
            key: 'tooltipPrices',
            name: 'Tooltip Prices',
            category: 'Market',
            module: Market.tooltipPrices,
            async: true,
            // Start the feature when ANY tooltip section is on, not just
            // prices/pin-to-top — otherwise the registry skips it and never
            // calls initialize for a profit/EV/enhancement-only setup.
            customCheck: () => Market.tooltipPrices.shouldEnable(),
        },
        {
            key: 'expectedValueCalculator',
            name: 'Expected Value Calculator',
            category: 'Market',
            module: Market.expectedValueCalculator,
            async: true,
        },
        {
            key: 'tooltipConsumables',
            name: 'Tooltip Consumables',
            category: 'Market',
            module: Market.tooltipConsumables,
            async: true,
        },
        {
            key: 'dungeonTokenTooltips',
            name: 'Dungeon Token Tooltips',
            category: 'Inventory',
            module: Market.dungeonTokenTooltips,
            async: true,
        },
        { key: 'marketFilter', name: 'Market Filter', category: 'Market', module: Market.marketFilter, async: false },
        { key: 'marketSort', name: 'Market Sort', category: 'Market', module: Market.marketSort, async: false },
        {
            key: 'autoFillPrice',
            name: 'Auto Fill Price',
            category: 'Market',
            module: Market.autoFillPrice,
            async: false,
        },
        {
            key: 'autoClickMax',
            name: 'Auto Click Max',
            category: 'Market',
            module: Market.autoClickMax,
            async: false,
        },
        {
            key: 'itemCountDisplay',
            name: 'Item Count Display',
            category: 'Market',
            module: Market.itemCountDisplay,
            async: false,
            healthCheck: () =>
                whenSetting('market_visibleItemCount', () =>
                    injectedInto('[class*="MarketplacePanel_marketItems"] use', '.mwi-item-count')
                ),
        },
        {
            key: 'estimatedListingAge',
            name: 'Estimated Listing Age',
            category: 'Market',
            module: Market.estimatedListingAge,
            async: true,
        },
        {
            key: 'listingPriceDisplay',
            name: 'Listing Price Display',
            category: 'Market',
            module: Market.listingPriceDisplay,
            async: false,
        },
        {
            key: 'collectableListingsSort',
            name: 'Collectable Listings Sort',
            category: 'Market',
            module: Market.collectableListingsSort,
            async: false,
        },
        {
            key: 'marketplaceBadgeFilter',
            name: 'Marketplace Badge Filter',
            category: 'Market',
            module: Market.marketplaceBadgeFilter,
            async: false,
        },
        {
            key: 'marketHistoryPanel',
            name: 'Market History Panel',
            category: 'Market',
            module: Market.marketHistoryPanel,
            async: true,
        },
        {
            key: 'myListingsPriceRefresh',
            name: 'My Listings Mooket Price Refresh',
            category: 'Market',
            module: Market.myListingsPriceRefresh,
            async: false,
        },
        {
            key: 'queueLengthEstimator',
            name: 'Queue Length Estimator',
            category: 'Market',
            module: Market.queueLengthEstimator,
            async: false,
        },
        {
            key: 'marketDepthCap',
            name: 'Market Depth Cap',
            category: 'Market',
            module: Market.marketDepthCap,
            async: false,
        },
        {
            key: 'marketOrderTotals',
            name: 'Market Order Totals',
            category: 'Market',
            module: Market.marketOrderTotals,
            async: false,
            healthCheck: () =>
                whenSetting('market_showOrderTotals', () =>
                    injectedInto('[class*="Header_totalLevel"]', '.mwi-market-order-totals')
                ),
        },
        {
            key: 'marketHistoryViewer',
            name: 'Market History Viewer',
            category: 'Market',
            module: Market.marketHistoryViewer,
            async: false,
        },
        {
            key: 'listingRefreshNavigator',
            name: 'Listing Refresh Navigator',
            category: 'Market',
            module: Market.listingRefreshNavigator,
            async: false,
        },
        {
            key: 'listingNextNavigator',
            name: 'Listing Next Navigator',
            category: 'Market',
            module: Market.listingNextNavigator,
            async: false,
        },
        {
            key: 'marketItemHop',
            name: 'Market Item Hop',
            category: 'Market',
            module: Market.marketItemHop,
            async: false,
        },
        {
            key: 'bulkSellAssistant',
            name: 'Bulk Sell Assistant',
            category: 'Market',
            module: Market.bulkSellAssistant,
            async: true,
        },
        {
            key: 'philoCalculator',
            name: 'Philo Calculator',
            category: 'Market',
            module: Market.philoCalculator,
            async: false,
        },
        { key: 'tradeHistory', name: 'Trade History', category: 'Market', module: Market.tradeHistory, async: false },
        {
            key: 'tradeLedgerStore',
            name: 'Trade Ledger',
            category: 'Market',
            module: Market.tradeLedgerStore,
            async: false,
        },
        {
            key: 'tradeLedgerView',
            name: 'Trade Ledger View',
            category: 'Market',
            module: Market.tradeLedgerView,
            async: false,
        },
        {
            key: 'tradeHistoryDisplay',
            name: 'Trade History Display',
            category: 'Market',
            module: Market.tradeHistoryDisplay,
            async: false,
        },
        {
            key: 'sellQueue',
            name: 'Sell Queue',
            category: 'Market',
            module: Market.sellQueue,
            async: false,
        },
        {
            key: 'networth',
            name: 'Net Worth',
            category: 'Economy',
            module: Market.networthFeature,
            async: false,
            healthCheck: () => injectedInto('[class*="Header_totalLevel"]', '.mwi-networth-header'),
        },
        {
            key: 'offlineProgressEconomics',
            name: 'Offline Progress Economics',
            category: 'Economy',
            module: Market.offlineProgressEconomics,
            async: false,
        },
        {
            key: 'inventoryBadgeManager',
            name: 'Inventory Badge Manager',
            category: 'Inventory',
            module: Market.inventoryBadgeManager,
            async: false,
            // The manager prices item containers, but only when a badge provider
            // drives a render — which is asynchronous, throttled, and may not
            // have run (or the price-badge provider may be off entirely) by the
            // time the health pass fires. A drawn-but-unpriced inventory is
            // "not yet", not "broken", so this confirms health when a priced
            // container exists and otherwise stands down — it must never report
            // `false`, or it cries wolf on every marketplace/mobile open. The
            // real badge output is health-checked by inventoryBadgePrices, which
            // handles the not-yet case the same way.
            healthCheck: () => {
                if (!document.querySelector('[class*="Inventory_items"] [class*="Item_itemContainer"]')) return null;
                return document.querySelector(
                    '[class*="Inventory_items"] [class*="Item_itemContainer"][data-ask-value]'
                )
                    ? true
                    : null;
            },
        },
        {
            key: 'treasureTracker',
            name: 'Treasure Tracker',
            category: 'Inventory',
            module: Market.treasureTracker,
            async: true,
            // Waits only on its own ledger and settings record; the sole
            // loot_opened listener, and consumers read it lazily at render time.
            concurrent: true,
        },
        {
            key: 'combatText',
            name: 'Combat Text',
            category: 'UI',
            module: UI.combatText,
            async: false,
            // Either half being on is enough; the module subscribes to nothing
            // when both are off
            customCheck: () => config.getSetting('combatText_floating') || config.getSetting('combatText_scrolling'),
        },
        {
            key: 'watchlist',
            name: 'Watchlist',
            category: 'Inventory',
            module: Market.watchlist,
            async: false,
        },
        {
            // The list itself is always live — the overlay tile and the panel
            // read it whatever this says. What the switch turns on is only the
            // button in the game's own item menu.
            key: 'equipmentSavings_menuButton',
            name: 'Equipment Savings',
            category: 'Inventory',
            module: Market.equipmentSavings,
            async: false,
            customCheck: () => true,
        },
        {
            key: 'inventorySort',
            name: 'Inventory Sort',
            category: 'Inventory',
            module: Market.inventorySort,
            async: false,
        },
        {
            key: 'inventoryBadgePrices',
            name: 'Inventory Badge Prices',
            category: 'Inventory',
            module: Market.inventoryBadgePrices,
            async: false,
            // A badge is only drawn for an item worth something, so the anchor is
            // not "an inventory" but "an item the manager has priced above zero"
            healthCheck: () =>
                whenSetting('invBadgePrices', () => {
                    const items = '[class*="Inventory_items"] [class*="Item_itemContainer"]';
                    if (!anyPositiveDataset(items, 'askPrice')) return null;
                    return Boolean(document.querySelector('.mwi-badge-price-ask, .mwi-badge-price-bid'));
                }),
        },
        {
            key: 'invCategoryTotals',
            name: 'Inventory Category Totals',
            category: 'Inventory',
            module: Market.inventoryCategoryTotals,
            async: false,
        },
        {
            key: 'autoAllButton',
            name: 'Auto All Button',
            category: 'Inventory',
            module: Market.autoAllButton,
            async: false,
        },
        {
            key: 'inventoryTabs',
            name: 'Custom Inventory Tabs',
            category: 'Inventory',
            module: Market.customTabsFeature,
            async: true,
        },
    ];

    // Actions Features
    const actionsFeatures = [
        {
            key: 'actionTimeDisplay',
            name: 'Action Time Display',
            category: 'Actions',
            module: Actions.actionTimeDisplay,
            async: false,
            healthCheck: () =>
                whenSetting('actionBar_enabled', () =>
                    injectedInto('div[class*="Header_actionName"]', '#mwi-action-time-display')
                ),
        },
        {
            key: 'actionCountdown',
            name: 'Action Bar Countdown',
            category: 'Actions',
            module: Actions.actionCountdown,
            async: false,
        },
        {
            // Off by default: a diagnostic that measures rather than draws, and one
            // the maintainer turns on to chase a report. Its storage read is its own
            // and nothing downstream is ordered against it.
            key: 'actionTimingMonitor',
            name: 'Action Timing Monitor',
            category: 'Actions',
            module: Actions.actionTimingMonitor,
            async: true,
            concurrent: true,
        },
        {
            key: 'actionPanelLayout',
            name: 'Action Panel Layout',
            category: 'Actions',
            module: Actions.actionPanelLayout,
            async: false,
        },
        {
            key: 'quickInputButtons',
            name: 'Quick Input Buttons',
            category: 'Actions',
            module: Actions.quickInputButtons,
            async: false,
        },
        { key: 'outputTotals', name: 'Output Totals', category: 'Actions', module: Actions.outputTotals, async: false },
        {
            key: 'maxProduceable',
            name: 'Max Produceable',
            category: 'Actions',
            module: Actions.maxProduceable,
            async: true,
            // Half a second of it is the shared sort manager's storage read,
            // which nothing after this feature is ordered against; the counts
            // it draws are absolutely positioned, so the observer landing later
            // does not move them.
            concurrent: true,
        },
        {
            key: 'gatheringStats',
            name: 'Gathering Stats',
            category: 'Actions',
            module: Actions.gatheringStats,
            async: true,
            // Waits on the same sort-manager read as max produceable, and
            // overlaps it rather than queueing behind it.
            concurrent: true,
        },
        {
            key: 'requiredMaterials',
            name: 'Required Materials',
            category: 'Actions',
            module: Actions.requiredMaterials,
            async: false,
        },
        {
            key: 'drinkTimer',
            name: 'Drink Timer',
            category: 'Actions',
            module: Actions.drinkTimer,
            async: false,
        },
        {
            key: 'missingMaterialsButton',
            name: 'Missing Materials Button',
            category: 'Actions',
            module: Actions.missingMaterialsButton,
            async: false,
        },
        {
            key: 'budgetCalculator',
            name: 'Budget Calculator',
            category: 'Actions',
            module: Actions.budgetCalculator,
            async: false,
        },
        {
            key: 'costSummary',
            name: 'Cost Summary',
            category: 'Actions',
            module: Actions.costSummary,
            async: false,
        },
        {
            key: 'craftingPlan',
            name: 'Crafting Plan',
            category: 'Actions',
            module: Actions.craftingPlan,
            async: false,
        },
        {
            key: 'productionArbitrageBoard',
            name: 'Production Arbitrage Board',
            category: 'Actions',
            module: Actions.productionArbitrageBoard,
            async: false,
            customCheck: () => config.getSetting('actions_arbitrageBoard'),
            // The button only belongs on a production skill page, so a gathering
            // page (which shares the title class) is not a verdict either way
            healthCheck: () =>
                whenSetting('actions_arbitrageBoard', () => {
                    const title = document.querySelector('[class*="GatheringProductionSkillPanel_title"]');
                    if (!title) return null;
                    const production = ['Cheesesmithing', 'Crafting', 'Tailoring', 'Cooking', 'Brewing'];
                    if (!production.some((name) => title.textContent.includes(name))) return null;
                    return Boolean(title.querySelector('.mwi-arbitrage-open'));
                }),
        },
        {
            key: 'alchemyProfitDisplay',
            name: 'Alchemy Profit Display',
            category: 'Alchemy',
            module: Actions.alchemyProfitDisplay,
            async: false,
        },
        {
            key: 'alchemyBestItems',
            name: 'Alchemy Best Items',
            category: 'Alchemy',
            module: Actions.alchemyBestItems,
            async: false,
            customCheck: () => config.getSetting('alchemy_bestItems'),
        },
        {
            key: 'alchemyItemPins',
            name: 'Alchemy Item Pins',
            category: 'Alchemy',
            module: Actions.alchemyItemPins,
            async: true,
            // Waits only on its own pin record. The menu observer it registers
            // afterwards shares a class with alchemy item dimming, which styles
            // individual items rather than reordering them, so which of the two
            // registers first does not show.
            concurrent: true,
        },
        {
            key: 'teaRecommendation',
            name: 'Tea Recommendation',
            category: 'Actions',
            module: Actions.teaRecommendation,
            async: false,
        },
        {
            key: 'lootLogStats',
            name: 'Loot Log Statistics',
            category: 'Actions',
            module: UI.lootLogStats,
            async: true,
        },
        {
            key: 'lootLogPivot',
            name: 'Loot Log Analytics',
            category: 'Actions',
            module: UI.lootLogPivot,
            async: true,
        },
        {
            key: 'inventoryCountDisplay',
            name: 'Inventory Count Display',
            category: 'Actions',
            module: Actions.inventoryCountDisplay,
            async: false,
        },
        {
            key: 'pinnedActionsPage',
            name: 'Pinned Actions Page',
            category: 'Actions',
            module: Actions.pinnedActionsPage,
            async: false,
        },
        {
            key: 'skillingOptimizer',
            name: 'Skilling Optimizer',
            category: 'Actions',
            module: Actions.skillingOptimizer,
            async: false,
        },
        {
            key: 'goalPlanner',
            name: 'Goal Planner',
            category: 'General',
            module: Actions.goalPlanner,
            async: true,
        },
    ];

    // Combat Features
    const combatFeatures = [
        {
            key: 'damageTracker',
            name: 'Damage Tracker',
            category: 'Combat',
            // `.default` because the global is the module namespace — see
            // the note in libraries/combat.js
            module: Combat.damageTracker.default,
            async: false,
        },
        {
            key: 'damageTakenTracker',
            name: 'Damage Taken Tracker',
            category: 'Combat',
            module: Combat.damageTakenTracker.default,
            async: false,
        },
        {
            key: 'combatRecorder_autoStart',
            name: 'Combat Recorder',
            category: 'Combat',
            module: Combat.combatRecorder,
            async: false,
            // The module is always reachable from the Damage panel's Record
            // button; what this switch turns on is only the automatic start
            customCheck: () => true,
        },
        {
            key: 'manaTracker',
            name: 'Mana Tracker',
            category: 'Combat',
            module: Combat.manaTracker,
            async: false,
        },
        {
            key: 'abilityBookCalculator',
            name: 'Ability Book Calculator',
            category: 'Combat',
            module: Combat.abilityBookCalculator,
            async: false,
        },
        {
            key: 'abilityTooltipTiming',
            name: 'Ability Tooltip Timing',
            category: 'Combat',
            module: Combat.abilityTooltipTiming,
            async: false,
            customCheck: () => config.getSetting('abilityTooltip_effectiveTiming'),
        },
        {
            key: 'abilityDictionaryButton',
            name: 'Ability Dictionary Button',
            category: 'Combat',
            module: Combat.abilityDictionaryButton,
            async: false,
        },
        {
            key: 'chestKeyMarketButton',
            name: 'Chest Key Market Button',
            category: 'Combat',
            module: Combat.chestKeyMarketButton,
            async: false,
        },
        {
            key: 'zoneIndices',
            name: 'Zone Indices',
            category: 'Combat',
            module: Combat.zoneIndices,
            async: false,
            // The map numbering is the unconditional half — every zone button
            // gets one. The task numbering only applies to combat tasks, so it
            // is not what this asks about.
            healthCheck: () =>
                whenSetting('mapIndex', () =>
                    injectedInto(
                        'div.MainPanel_subPanelContainer__1i-H9 div.CombatPanel_tabsComponentContainer__GsQlg ' +
                            'div.MuiTabs-root.MuiTabs-vertical button.MuiButtonBase-root.MuiTab-root span.MuiBadge-root',
                        'span.script_mapIndex'
                    )
                ),
        },
        {
            key: 'combatScore',
            name: 'Combat Score',
            category: 'Profile',
            module: Combat.combatScore,
            async: false,
            // Prefix-matched: anchoring this on the same hashed selector the
            // feature itself uses meant a game rehash blinded check and feature
            // together — the one failure the health pass exists to catch
            healthCheck: () => injectedInto('div[class*="SharableProfile_overviewTab"]', '#mwi-combat-score-panel'),
        },
        {
            key: 'characterCardButton',
            name: 'Character Card Button',
            category: 'Profile',
            module: Combat.characterCardButton,
            async: false,
        },
        {
            key: 'eliteAchievementReminder',
            name: 'Elite Achievement Reminder',
            category: 'Profile',
            module: Combat.eliteAchievementReminder,
            async: false,
        },
        {
            key: 'loadoutEnhancementDisplay',
            name: 'Loadout Enhancement Display',
            category: 'Combat',
            module: Combat.loadoutEnhancementDisplay,
            async: false,
        },
        {
            key: 'dungeonTracker',
            name: 'Dungeon Tracker',
            category: 'Combat',
            module: Combat.dungeonTracker,
            async: false,
        },
        {
            key: 'dungeonTrackerUI',
            name: 'Dungeon Tracker UI',
            category: 'Combat',
            module: Combat.dungeonTrackerUI,
            async: false,
        },
        {
            key: 'dungeonTrackerChatAnnotations',
            name: 'Dungeon Tracker Chat',
            category: 'Combat',
            module: Combat.dungeonTrackerChatAnnotations,
            async: false,
        },
        {
            key: 'combatBattleCounter',
            name: 'Combat Battle Counter',
            category: 'Combat',
            module: Combat.combatBattleCounter,
            async: false,
        },
        {
            key: 'spawnCensus',
            name: 'Spawn Census',
            category: 'Combat',
            module: Combat.spawnCensus,
            async: true,
            // Awaits only its own storage record, and nothing downstream is
            // ordered against what it does afterwards — see initializeFeatures.
            concurrent: true,
        },
        {
            key: 'combatBossEta',
            name: 'Combat Boss ETA',
            category: 'Combat',
            module: Combat.combatBossEta,
            async: false,
        },
        {
            key: 'combatSummary',
            name: 'Combat Summary',
            category: 'Combat',
            module: Combat.combatSummary,
            async: false,
        },
        {
            key: 'combatDropLuck',
            name: 'Combat Drop Luck',
            category: 'Combat',
            // `.default` because the global is the module namespace — see
            // the note in libraries/combat.js
            module: Combat.combatDropLuck,
            async: false,
        },
        {
            key: 'combatDps',
            name: 'Combat DPS',
            category: 'Combat',
            module: Combat.combatDPS,
            async: false,
        },
        {
            key: 'portraitDps',
            name: 'Portrait DPS',
            category: 'Combat',
            module: Combat.portraitDps,
            async: false,
        },
        {
            key: 'combatUnitBadges',
            name: 'Combat Unit Badges',
            category: 'Combat',
            module: Combat.combatUnitBadges,
            async: false,
        },
        {
            key: 'combatUnitBuffBars',
            name: 'Combat Unit Buff Bars',
            category: 'Combat',
            module: Combat.combatUnitBuffBars,
            async: false,
        },
        {
            key: 'combatConsumableRunway',
            name: 'Combat Consumable Runway',
            category: 'Combat',
            module: Combat.combatConsumableRunway,
            async: false,
        },
        {
            key: 'combatDpsPanel',
            name: 'Combat DPS Panel',
            category: 'Combat',
            module: Combat.combatDpsPanel,
            async: false,
        },
        {
            key: 'partyProfileButton',
            name: 'Party Profile Button',
            category: 'Combat',
            module: Combat.partyProfileButton,
            async: false,
            customCheck: () => config.getSetting('combatProfileButton'),
        },
        { key: 'combatStats', name: 'Combat Stats', category: 'Combat', module: Combat.combatStats, async: false },
        {
            key: 'labyrinthTracker',
            name: 'Labyrinth Tracker',
            category: 'Combat',
            module: Combat.labyrinthTracker,
            async: false,
        },
        {
            key: 'labyrinthRunLedger',
            name: 'Labyrinth Run Ledger',
            category: 'Combat',
            module: Combat.labyrinthRunLedger,
            async: false,
        },
        {
            key: 'labyrinthBestLevel',
            name: 'Labyrinth Best Level',
            category: 'Combat',
            module: Combat.labyrinthBestLevel,
            async: false,
        },
        {
            key: 'labyrinthShopPrices',
            name: 'Labyrinth Shop Prices',
            category: 'Combat',
            module: Combat.labyrinthShopPrices,
            async: false,
        },
        {
            key: 'labyrinthClearRate',
            name: 'Labyrinth Clear Rate',
            category: 'Combat',
            module: Combat.labyrinthClearRate,
            async: false,
        },
        {
            key: 'labyrinthMonsterStatCheck',
            name: 'Monster Stat Check',
            category: 'Combat',
            module: Combat.monsterStatCheckUI,
            async: false,
        },
        {
            key: 'labyrinthRoomLogs',
            name: 'Labyrinth Room Logs',
            category: 'Combat',
            module: Combat.labyrinthRoomLogs,
            async: true,
            // Waits only on its own record; its tab re-asserts its place after
            // the Lab Sim button itself, so registration order does not decide it.
            concurrent: true,
        },
        {
            key: 'loadoutSnapshot',
            name: 'Loadout Snapshots',
            category: 'Combat',
            module: Combat.loadoutSnapshot,
            async: true,
        },
        {
            key: 'scrollSimulatorUI',
            name: 'Scroll Simulator UI',
            category: 'Combat',
            module: Combat.scrollSimulatorUI,
            async: false,
        },
        {
            key: 'combatSim',
            name: 'Combat Simulator',
            category: 'Combat',
            module: Combat.combatSim,
            async: false,
        },
        {
            key: 'labSim',
            name: 'Lab Simulator',
            category: 'Combat',
            module: Combat.labSim,
            async: false,
        },
    ];

    // UI Features
    const uiFeatures = [
        {
            key: 'equipmentLevelDisplay',
            name: 'Equipment Level Display',
            category: 'UI',
            module: UI.equipmentLevelDisplay,
            async: false,
        },
        {
            key: 'alchemyItemDimming',
            name: 'Alchemy Item Dimming',
            category: 'UI',
            module: UI.alchemyItemDimming,
            async: false,
        },
        {
            key: 'skillExperiencePercentage',
            name: 'Skill Experience Percentage',
            category: 'UI',
            module: UI.skillExperiencePercentage,
            async: false,
            // The percentage is read off the bar's inline width, so a bar
            // without one is not yet something the feature could have acted on
            healthCheck: () =>
                injectedInto('[class*="NavigationBar_currentExperience"][style*="width"]', '.mwi-exp-percentage'),
        },
        {
            key: 'combatLevelProgress',
            name: 'Decimal Combat Level',
            category: 'UI',
            module: UI.combatLevelProgress,
            async: false,
            healthCheck: () =>
                injectedInto(
                    '[class*="NavigationBar_nav__"]:has(svg[aria-label="navigationBar.combat"]) [class*="NavigationBar_level"]',
                    '.mwi-combat-level-precise'
                ),
        },
        { key: 'externalLinks', name: 'External Links', category: 'UI', module: UI.externalLinks, async: false },
        {
            key: 'equipmentMismatchWarning',
            name: 'Equipment Mismatch Warning',
            category: 'UI',
            module: UI.equipmentMismatchWarning,
            async: false,
        },
        {
            key: 'hideLabyrinthBadge',
            name: 'Hide Labyrinth Badge',
            category: 'UI',
            module: UI.hideLabyrinthBadge,
            async: false,
        },
        {
            key: 'hideGuildBadge',
            name: 'Hide Guild Badge',
            category: 'UI',
            module: UI.hideGuildBadge,
            async: false,
        },
        {
            key: 'combatScale',
            name: 'Combat Panel Scale',
            category: 'UI',
            module: UI.combatPanelScale,
            async: false,
        },
        {
            key: 'updateCheck',
            name: 'Update Check',
            category: 'UI',
            module: UI.updateCheck,
            async: false,
            // Always initialized: with the setting off it says once, ever, that
            // the opt-in exists; the setting gates the actual checking inside
            customCheck: () => true,
        },
        {
            key: 'welcomeBackValue',
            name: 'Welcome Back Value',
            category: 'UI',
            module: UI.welcomeBackValue,
            async: false,
        },
        {
            key: 'panelSizeMemory',
            name: 'Panel Size Memory',
            category: 'UI',
            module: UI.panelSizeMemory,
            async: false,
        },
        {
            key: 'tabReorder',
            name: 'Tab Reorder',
            category: 'UI',
            module: UI.tabReorder,
            async: true,
            // Waits only on its own stored order and applies it by CSS order
            // with a deferred re-apply; nothing later shares the strip.
            concurrent: true,
        },
        {
            key: 'overlayPanel',
            name: 'Overlay Panel',
            category: 'Interface',
            module: UI.overlayPanel,
            async: true,
        },
        {
            key: 'overlayTabButton',
            name: 'Overlay Tab Button',
            category: 'Interface',
            module: UI.overlayTabButton,
            async: false,
            // The button is a switch for the overlay and the module refuses to
            // draw one when the overlay itself is off
            healthCheck: () =>
                whenSetting('overlayPanel', () => {
                    if (!findCharacterTabList()) return null;
                    return Boolean(document.getElementById('toolasha-overlay-tab'));
                }),
        },
        {
            key: 'commandPalette',
            name: 'Command Palette',
            category: 'Interface',
            module: UI.commandPalette,
            async: false,
            // No entry in config's own feature map, so the schema switch is what
            // decides — without this the palette would be on regardless
            customCheck: () => config.getSetting('commandPalette'),
        },
        {
            key: 'draggableModals',
            name: 'Draggable Modals',
            category: 'UI',
            module: UI.draggableModals,
            async: true,
        },
        {
            key: 'altClickNavigation',
            name: 'Alt+Click Navigation',
            category: 'Navigation',
            module: UI.altClickNavigation,
            async: false,
        },
        {
            key: 'collectionNavigation',
            name: 'Collection Navigation',
            category: 'Navigation',
            module: UI.collectionNavigation,
            async: false,
        },
        {
            key: 'collectionFilters',
            name: 'Collection Filters',
            category: 'Collection',
            module: UI.collectionFilters,
            async: true,
            customCheck: () =>
                config.isFeatureEnabled('collectionFilters') || config.isFeatureEnabled('collectionFavorites'),
        },
        { key: 'chatCommands', name: 'Chat Commands', category: 'Chat', module: UI.chatCommands, async: true },
        {
            key: 'chatProfileLink',
            name: 'Chat Profile Link',
            category: 'Chat',
            module: UI.chatProfileLink,
            async: false,
        },
        { key: 'mentionTracker', name: 'Mention Tracker', category: 'Chat', module: UI.mentionTracker, async: true },
        { key: 'popOutChat', name: 'Pop-Out Chat', category: 'Chat', module: UI.popOutChat, async: true },
        { key: 'chatBlockList', name: 'Chat Block List', category: 'Chat', module: UI.chatBlockList, async: false },
        {
            key: 'chatHistoryExtender',
            name: 'Chat History Extender',
            category: 'Chat',
            module: UI.chatHistoryExtender,
            async: false,
        },
        {
            key: 'taskProfitDisplay',
            name: 'Task Profit Display',
            category: 'Tasks',
            module: UI.taskProfitDisplay,
            async: false,
            customCheck: () =>
                config.getSetting('taskProfitCalculator') ||
                config.getSetting('taskGoMerge') ||
                config.getSetting('taskQueuedIndicator') ||
                config.getSetting('taskMaterialsIndicator') ||
                config.getSetting('taskEfficiencyRating'),
        },
        {
            key: 'taskRerollTracker',
            name: 'Task Reroll Tracker',
            category: 'Tasks',
            module: UI.taskRerollTracker,
            async: false,
        },
        { key: 'taskSorter', name: 'Task Sorter', category: 'Tasks', module: UI.taskSorter, async: false },
        {
            key: 'taskIcons',
            name: 'Task Icons',
            category: 'Tasks',
            module: UI.taskIcons,
            async: false,
            // The attribute rather than `.mwi-task-icon`: it is stamped on every
            // card the feature has looked at, whereas an icon depends on a sprite
            // resolving, and a missing sprite is a different complaint
            healthCheck: () =>
                injectedInto(
                    '[class*="TasksPanel_taskList"] [class*="RandomTask_randomTask"]',
                    '[class*="RandomTask_randomTask"][data-mwi-task-processed]'
                ),
        },
        {
            key: 'taskInventoryHighlighter',
            name: 'Task Inventory Highlighter',
            category: 'Tasks',
            module: UI.taskInventoryHighlighter,
            async: false,
        },
        {
            key: 'taskStatistics',
            name: 'Task Statistics',
            category: 'Tasks',
            module: UI.taskStatistics,
            async: false,
            healthCheck: () =>
                injectedInto(
                    '[class*="TasksPanel_tabsComponentContainer"] [class*="TabsComponent_tabsContainer"]',
                    '.toolasha-task-stats-btn'
                ),
        },
        {
            key: 'taskClaimCollector',
            name: 'Task Claim Collector',
            category: 'Tasks',
            module: UI.taskClaimCollector,
            async: false,
        },
        {
            key: 'taskClaimToast',
            name: 'Task Claim Toast',
            category: 'Tasks',
            module: UI.taskClaimToast,
            async: false,
        },
        {
            key: 'taskRerollSpendBadge',
            name: 'Task Reroll Spend Badge',
            category: 'Tasks',
            module: UI.taskRerollBadge,
            async: false,
        },
        {
            key: 'taskRerollProtection',
            name: 'Task Reroll Protection',
            category: 'Tasks',
            module: UI.taskRerollProtection,
            async: true,
        },
        {
            key: 'taskAutoReroll',
            name: 'Task Auto-Reroll Reminder',
            category: 'Tasks',
            module: UI.taskAutoReroll,
            async: true,
        },
        {
            key: 'tasks_rerollWalk',
            name: 'Task Reroll Walk',
            category: 'Tasks',
            module: UI.taskRerollWalk,
            async: true,
            // Last of the task-panel features: waits only on its own records and
            // nothing after it touches the task panel header.
            concurrent: true,
        },
        {
            key: 'tasks_mergedCraftingWalk',
            name: 'Merged Crafting Walk',
            category: 'Tasks',
            // From the actions bundle, where the crafting plan and the walk it
            // drives already live; registered here because the task board is the
            // surface it attaches to. Gated on its own setting inside, like the
            // reroll walk above.
            module: Actions.taskCraftingTrain,
            async: false,
        },
        {
            key: 'skillRemainingXP',
            name: 'Remaining XP',
            category: 'Skills',
            module: UI.remainingXP,
            async: false,
            // Needs a nav entry that both has an XP bar and names its skill —
            // the name is what the remaining figure is computed from
            healthCheck: () => {
                const bars = [...document.querySelectorAll('[class*="NavigationBar_currentExperience"]')];
                const named = bars.some((bar) =>
                    bar.closest('[class*="NavigationBar_nav"]')?.querySelector('[class*="NavigationBar_label"]')
                );
                if (!named) return null;
                return Boolean(document.querySelector('.mwi-remaining-xp'));
            },
        },
        { key: 'xpTracker', name: 'XP/hr Tracker', category: 'Skills', module: UI.xpTracker, async: false },
        {
            key: 'housePanelObserver',
            name: 'House Panel Observer',
            category: 'House',
            module: UI.housePanelObserver,
            async: true,
        },
        {
            key: 'transmuteRates',
            name: 'Transmute Rates',
            category: 'Dictionary',
            module: UI.transmuteRates,
            async: false,
        },
        {
            key: 'alchemy_transmuteHistory',
            name: 'Transmute History Tracker',
            category: 'Alchemy',
            module: UI.transmuteHistoryTracker,
            async: false,
        },
        {
            key: 'alchemy_transmuteHistoryViewer',
            name: 'Transmute History Viewer',
            category: 'Alchemy',
            module: UI.transmuteHistoryViewer,
            async: false,
        },
        {
            key: 'alchemy_coinifyHistory',
            name: 'Coinify History Tracker',
            category: 'Alchemy',
            module: UI.coinifyHistoryTracker,
            async: false,
        },
        {
            key: 'alchemy_coinifyHistoryViewer',
            name: 'Coinify History Viewer',
            category: 'Alchemy',
            module: UI.coinifyHistoryViewer,
            async: false,
        },
        {
            key: 'alchemy_decomposeHistory',
            name: 'Decompose History Tracker',
            category: 'Alchemy',
            module: UI.decomposeHistoryTracker,
            async: false,
        },
        {
            key: 'alchemy_decomposeHistoryViewer',
            name: 'Decompose History Viewer',
            category: 'Alchemy',
            module: UI.decomposeHistoryViewer,
            async: false,
        },
        {
            key: 'alchemy_actionProtection',
            name: 'Alchemy Action Protection',
            category: 'Alchemy',
            module: UI.alchemyActionProtection,
            async: true,
            // Deliberately NOT concurrent, though it satisfies the ordering
            // rule the flag is about (it waits only on its own protection map,
            // the other users of its anchor are registered earlier, and its
            // click guard is its own).
            //
            // What it registers after that await is an interlock: the
            // double-confirm that stands between a Decompose click and an
            // irreversible loss of protected items. Deferring it moves that
            // guard from "up shortly after this feature's own storage read" to
            // "up when the slowest member of the whole concurrent batch has
            // finished", which is several hundred milliseconds later on a cold
            // start. Every other flagged feature pays for a late arrival in a
            // readout that fills in a moment; this one pays in an item the
            // player cannot get back. Its await is a single settings read, so
            // it is one of the cheapest members of the batch to give up.
        },
        {
            key: 'enhancementFeature',
            name: 'Enhancement Tracker',
            category: 'Enhancement',
            module: UI.enhancementFeature,
            async: false,
        },
        {
            key: 'enhancementXPH',
            name: 'Enhancement XPH Calculator',
            category: 'Enhancement',
            module: UI.xphCalculator,
            async: false,
        },
        {
            key: 'enhancementItemPins',
            name: 'Enhancement Item Pins',
            category: 'Enhancement',
            module: UI.enhancementItemPins,
            async: true,
            // Waits only on its own pin record; the menu observer it
            // registers afterwards does not race anything else on the panel.
            concurrent: true,
        },
        {
            key: 'riskOfRuin',
            name: 'Risk of Ruin Calculator',
            category: 'Risk of Ruin',
            module: UI.riskOfRuinUI,
            async: false,
        },
        {
            key: 'guildXPTracker',
            name: 'Guild XP Tracker',
            category: 'Guild',
            module: Combat.guildXPTracker,
            async: false,
        },
        {
            key: 'guildXPDisplay',
            name: 'Guild XP Display',
            category: 'Guild',
            module: Combat.guildXPDisplay,
            async: false,
        },
        {
            key: 'guildCreditValue',
            name: 'Guild Credit Value',
            category: 'Guild',
            module: Combat.guildCreditValue,
            async: false,
        },
        {
            key: 'guildRoster',
            name: 'Guild Roster',
            category: 'Guild',
            module: Combat.guildRosterView,
            async: false,
        },
        {
            key: 'guildTrialsInfo',
            name: 'Guild Trials',
            category: 'Guild',
            module: Combat.guildTrials,
            async: true,
            // Registers every observer and handler before its first await by
            // design; what it then waits on is its own trial record.
            concurrent: true,
        },
        {
            key: 'guildTrialLedger',
            name: 'Guild Trial Ledger',
            category: 'Guild',
            module: Combat.guildTrialLedgerView,
            async: true,
        },
        {
            key: 'insights_calibration',
            name: 'Prediction Calibration',
            category: 'Insights',
            module: UI.predictionCalibration,
            async: true,
        },
        {
            key: 'leaderboardXPTracker',
            name: 'Leaderboard XP Tracker',
            category: 'Leaderboard',
            module: UI.leaderboardXPTracker,
            async: false,
        },
        {
            key: 'leaderboardXPDisplay',
            name: 'Leaderboard XP Display',
            category: 'Leaderboard',
            module: UI.leaderboardXPDisplay,
            async: false,
        },
        {
            key: 'emptyQueueNotification',
            name: 'Empty Queue Notification',
            category: 'Notifications',
            module: UI.emptyQueueNotification,
            async: true,
        },
        {
            key: 'communityBuffAlerts',
            name: 'Community Buff Expiry Alerts',
            category: 'Notifications',
            module: UI.communityBuffAlerts,
            async: true,
            // No entry in config's feature map, so the schema setting is the
            // only gate — an unknown registry key would otherwise default to on
            customCheck: () => config.getSetting('notifications_communityBuffExpiring'),
        },
        {
            key: 'labyrinthRunAlerts',
            name: 'Labyrinth Stopped Alerts',
            category: 'Notifications',
            module: UI.labyrinthRunAlerts,
            async: true,
            // As above: no feature-map entry, so the schema setting is the only
            // gate and an unknown registry key would otherwise default to on
            customCheck: () => config.getSetting('notifications_labyrinthRunFinished'),
        },
        {
            key: 'combatConsumableAlerts',
            name: 'Combat Consumable Alerts',
            category: 'Notifications',
            module: UI.combatConsumableAlerts,
            async: true,
            // Schema setting is the only gate; no feature-map entry
            customCheck: () => config.getSetting('notifications_combatConsumableLow'),
        },
        {
            key: 'labyrinthEntryAlerts',
            name: 'Labyrinth Entry Alerts',
            category: 'Notifications',
            module: UI.labyrinthEntryAlerts,
            async: true,
            // Schema setting is the only gate; no feature-map entry.
            customCheck: () => config.getSetting('notifications_labyrinthEntryAvailable'),
        },
        {
            key: 'combatDeathAlerts',
            name: 'Combat Death Alerts',
            category: 'Notifications',
            module: UI.combatDeathAlerts,
            async: true,
            customCheck: () => config.getSetting('notifications_combatDeath'),
        },
        {
            key: 'skillLevelUpAlerts',
            name: 'Skill Milestone Alerts',
            category: 'Notifications',
            module: UI.skillLevelUpAlerts,
            async: true,
            // Schema setting is the only gate; no feature-map entry.
            customCheck: () => config.getSetting('notifications_skillLevelUp'),
        },
        {
            key: 'ttlTargetAlerts',
            name: 'Time-to-Level Target Alerts',
            category: 'Notifications',
            module: UI.ttlTargetAlerts,
            async: true,
            // Schema setting is the only gate; no feature-map entry.
            customCheck: () => config.getSetting('notifications_ttlTargetReached'),
        },
        {
            key: 'marketUndercutAlerts',
            name: 'Market Undercut Alerts',
            category: 'Notifications',
            module: UI.marketUndercutAlerts,
            async: true,
            customCheck: () => config.getSetting('notifications_marketListingUndercut'),
        },
        {
            key: 'savingsGoalAlerts',
            name: 'Savings Goal Alerts',
            category: 'Notifications',
            // In the Market bundle rather than the UI one: it reads the
            // Equipment Savings panel's costed lists, which live there.
            module: Market.savingsGoalAlerts,
            async: true,
            customCheck: () => config.getSetting('notifications_savingsGoalReached'),
        },
        {
            key: 'priceTargetAlerts',
            name: 'Price Target Alerts',
            category: 'Notifications',
            // In the Market bundle for the same reason as the savings-goal
            // alert: it reads the price panel's pins and that panel's pooled
            // dataset, both of which live there.
            module: Market.priceTargetAlerts,
            async: true,
            customCheck: () => config.getSetting('notifications_priceTargetReached'),
        },
        {
            key: 'enhancementTargetAlerts',
            name: 'Enhancement Target Alerts',
            category: 'Notifications',
            module: UI.enhancementTargetAlerts,
            async: true,
            customCheck: () => config.getSetting('notifications_enhancementTarget'),
        },
        {
            key: 'taskSlotAlerts',
            name: 'Task Slot Alerts',
            category: 'Notifications',
            module: UI.taskSlotAlerts,
            async: true,
            customCheck: () => config.getSetting('notifications_taskSlotsFull'),
        },
        {
            key: 'queueMonitor',
            name: 'Queue Monitor',
            category: 'General',
            module: UI.queueMonitor,
            async: false,
        },
        {
            key: 'characterActivityStatus',
            name: 'Character Activity Status',
            category: 'General',
            module: Actions.characterActivity,
            async: true,
            // Writes only this character's own projection record; nothing else reads it while
            // the game is running
            concurrent: true,
        },
        {
            key: 'sessionBriefing',
            name: 'Session Briefing',
            category: 'General',
            module: UI.sessionBriefing,
            async: true,
            // Awaits only its own stored listing snapshot before showing its own
            // panel; nothing else reads or writes either.
            concurrent: true,
        },
        {
            // Registry key stays ironCowFarm (persisted enable/disable state);
            // the display name is "Iron Bell Farming".
            key: 'ironCowFarm',
            name: 'Iron Bell Farming',
            category: 'General',
            module: UI.ironCowFarmPanel,
            async: true,
            // Waits only on its own stored loop and overrides, and reopens its
            // own panel; nothing else touches either.
            concurrent: true,
        },
        {
            key: 'accountView',
            name: 'Account View',
            category: 'General',
            module: UI.accountView,
            async: true,
            // Last in the registry and waits only on its own character record,
            // so nothing is ordered after what it does.
            concurrent: true,
            // No entry in settings-schema yet, so `getSetting`'s own default is
            // what decides — an unknown key returns whatever is passed here
            customCheck: () => config.getSetting('accountView', true),
        },
    ];

    // Combine all features
    const allFeatures = [...marketFeatures, ...actionsFeatures, ...combatFeatures, ...uiFeatures];

    // Convert to feature registry format
    const features = allFeatures.map((feature) => {
        // Modules may export either disable() or cleanup() as their teardown;
        // some cleanup(instance) implementations expect the instance returned by initialize().
        const teardown =
            typeof feature.module.disable === 'function'
                ? (instance) => feature.module.disable(instance)
                : typeof feature.module.cleanup === 'function'
                  ? (instance) => feature.module.cleanup(instance)
                  : undefined;
        let instance = null;
        return {
            key: feature.key,
            name: feature.name,
            category: feature.category,
            // Always await: modules whose initialize() is async but were
            // registered without the async flag would otherwise store a
            // pending Promise as the instance and escape error handling
            initialize: async () => {
                instance = await feature.module.initialize();
            },
            disable: teardown
                ? () => {
                      const current = instance;
                      instance = null;
                      return teardown(current);
                  }
                : undefined,
            // Forwarded, and it has to be listed here: this mapping builds each
            // registry entry from an explicit field list, so anything the
            // definitions above set and this object does not name is dropped on
            // the way in. `concurrent` was dropped for its whole life —
            // `initializeFeatures` read `feature.concurrent`, found `undefined`
            // on every entry, and awaited all sixteen flagged features one after
            // another, which is the ~1.3 s of blocking startup the flag exists
            // to remove. `src/entrypoint.test.js` now derives the field list
            // from what `feature-registry.js` actually reads, so the next field
            // added there fails a test instead of arriving dead.
            //
            // (`async:` used to be forwarded here too. Nothing has ever read it
            // off a registry entry — the registry decides on the returned value,
            // not on a flag — so it is not carried across. The annotations on
            // the definitions above are left as documentation of which module
            // initializers are async.)
            concurrent: feature.concurrent || undefined,
            customCheck: feature.customCheck || undefined,
            // Without this the checks above would be dropped on the way into the
            // registry, and `checkFeatureHealth` would go on finding nothing
            healthCheck: feature.healthCheck || undefined,
        };
    });

    // Replace feature registry's features array
    featureRegistry.replaceFeatures(features);
}

if (isCombatSimulatorPage()) {
    // Initialize combat sim integration only
    Combat.combatSimIntegration.initialize();

    // Skip all other initialization
} else {
    // CRITICAL: Install WebSocket hook FIRST, before game connects
    webSocketHook.install();

    // CRITICAL: Start centralized DOM observer SECOND, before features initialize
    domObserver.start();

    // Always-on character-select watcher. Registered here rather than through the feature
    // registry because character select can be the very first screen of a session, with no
    // character initialized and so no feature lifecycle running to start it.
    Actions.characterSelectRenderer.startWatching();

    // Set up scroll listener to dismiss stuck tooltips
    setupScrollTooltipDismissal();

    // Initialize network alert (must be early, before market features)
    Market.networkAlert.initialize();

    // Start capturing client data from localStorage (for Combat Sim export)
    webSocketHook.captureClientDataFromLocalStorage();

    // From here on, every interval the script creates reports into the rolling
    // stats while measuring is on — the stall ledger's attribution net
    Core.installIntervalTracing?.();

    performanceMonitor.mark('script:start');

    // Register all features from libraries
    registerFeatures();

    // Initialize action panel observer (special case - not a regular feature)
    Actions.initActionPanelObserver();

    // Initialize storage and config THIRD (async)
    // Store the promise so character_initialized can wait for storage readiness
    const storageReady = (async () => {
        try {
            // Initialize storage (opens IndexedDB)
            await storage.initialize();
            performanceMonitor.mark('storage:open');

            // Initialize config (loads settings from storage)
            await config.initialize();
            performanceMonitor.mark('config:loaded');

            // Flush pending writes on every way a page can go away.
            //
            // `beforeunload` alone is not enough: a mobile tab that is
            // backgrounded and then killed, or a bfcache-eligible navigation,
            // never fires it, and up to three seconds of debounced writes go
            // with the page. `pagehide` covers the bfcache case and
            // `visibilitychange`→hidden covers backgrounding, which is the last
            // event a discarded tab reliably gets.
            const flushPendingWrites = () => {
                storage.flushAll();
            };
            window.addEventListener('beforeunload', flushPendingWrites);
            window.addEventListener('pagehide', flushPendingWrites);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flushPendingWrites();
            });

            // Initialize Data Manager immediately
            // Don't wait for localStorageUtil - it handles missing data gracefully
            dataManager.initialize();
        } catch (error) {
            console.error('[Toolasha] Storage/config initialization failed:', error);
            // Initialize anyway
            dataManager.initialize();
        }
    })();

    // Setup character switch handler once (NOT inside character_initialized listener).
    // scheduleFailedFeatureRecovery gives a switch's initializeFeatures() the same
    // health-check/retry/report treatment boot gives its own initializeFeatures().
    featureRegistry.setupCharacterSwitchHandler(scheduleFailedFeatureRecovery);

    // Whether the one-time startup block below has already run this page load.
    //
    // `init_character_data` arrives again whenever the game opens a new socket
    // for a character that is already loaded — a reconnect, or a trip out to
    // character select and straight back into the same character. Data-manager
    // compares the incoming id against `currentCharacterId`, finds them equal,
    // and so emits neither `character_switching` nor `character_switched`; what
    // it does emit is `character_initialized` with `_isCharacterSwitch: false`,
    // which is indistinguishable from the first login.
    //
    // Without this guard the whole block ran a second time with nothing having
    // taken the first run down — teardown only ever runs off `character_switching`
    // — so every feature's `initialize()` executed over the top of a live one:
    // observers and `config.onSettingChange` callbacks registered twice, panels
    // built twice, and the instance the first run stored dropped where no later
    // `disable()` could reach it. A same-character re-init needs nothing from
    // here; a different character is a switch, which feature-registry owns.
    let startupBegun = false;

    dataManager.on('character_initialized', (_data) => {
        performanceMonitor.mark('character:data');
        // Skip full initialization during character switches
        // The character_switched handler in feature-registry already handles reinitialization
        if (_data._isCharacterSwitch) {
            return;
        }

        if (startupBegun) {
            return;
        }
        startupBegun = true;

        // Initialize all features using the feature registry
        setTimeout(async () => {
            try {
                // Ensure storage/config are initialized before loading character settings
                // On Steam, character data can arrive before IndexedDB is open
                await storageReady;
                // Sub-mark inside the character:data → settings:character gap: this
                // one says whether storageReady was still pending (should not be —
                // storage:open/config:loaded land within the first ~100ms) or whether
                // the setTimeout below it had to wait for a busy main thread before
                // this line even ran. A trace where this sits right after
                // character:data means the delay was all in config.loadSettings();
                // one where it doesn't means the machine was contended before this
                // code got a turn at all.
                performanceMonitor.mark('settings:storageReady');

                // Start the one startup market load now, not awaited: the
                // first market feature used to force a fresh fetch inside its
                // initializer and every feature after it waited behind that
                // network round trip. Kicked off here — storage is open and the
                // socket is connected, the two things the fetch needs — it
                // overlaps the settings load and the features that follow;
                // callers that need it join the in-flight request.
                marketAPI.fetch().catch((error) => {
                    console.error('[Toolasha] Startup market fetch failed:', error);
                });

                // Reload config settings with character-specific data
                await config.loadSettings();
                // Isolates config.loadSettings() itself — the IndexedDB reads for
                // the character's settings key and the one-time-rewrite flag — from
                // applyColorSettings() and everything after settings:character.
                performanceMonitor.mark('settings:loaded');
                config.applyColorSettings();
                performanceMonitor.mark('settings:character');

                // Both dual-install signals, once the settings map has been
                // read: the page claim (a second copy that ran before or after
                // this one) and the fingerprint (setting ids that vanished from
                // the stored map between two loads of this same build, which
                // only another script sharing the storage can do).
                try {
                    const missing = await dualInstallGuard.checkSettingsFingerprint(
                        Core.settingsStorage.getCharacterStorageKey(),
                        await config.storedSettingIds(),
                        Utils.scriptVersion.scriptVersion() || 'unknown',
                        Core.getAllSettingIds()
                    );
                    if (dualInstallClaimed || dualInstallGuard.claimLost() || missing.length > 0) warnDualInstall();
                } catch (error) {
                    console.error('[Toolasha] Dual-install check failed:', error);
                }

                // MWITools, checked here rather than at import time for the same
                // reason as the signals above: its own public-api and
                // mobile-viewport-fix modules need a turn to run first, and this
                // point — after the settings load that follows character init —
                // is well past that in the common case. checkMwiToolsWithRetries
                // covers the uncommon one, where MWITools' own boot is gated
                // behind a similar async chain and has not settled yet.
                checkMwiToolsWithRetries();

                // Before features initialise: the conservative-defaults policy
                // has to turn a new switch off before anything reads it — a
                // feature switched off after startup has already run once
                await UI.whatsNew.applyPolicy();

                // Start the Settings UI now and let it settle alongside the
                // scroll-simulator read rather than ahead of it: its synchronous
                // half (styles, the panel observer) runs at once, the custom
                // price overrides read it still owes the features overlaps
                // the read below, and its panel-only state loads on first
                // panel open.
                const settingsUIReady = UI.settingsUI.initialize().catch((error) => {
                    console.error('[Toolasha] Settings UI initialization failed:', error);
                });

                // Initialize scroll simulator storage (character-specific)
                await Combat.scrollSimulator.initialize().catch((error) => {
                    console.error('[Toolasha] Scroll simulator initialization failed:', error);
                });

                // The overrides read is the one thing features expect settled
                await settingsUIReady;

                const initFailures = await featureRegistry.initializeFeatures();
                performanceMonitor.mark('startup:complete');

                // Offer a full backup before the What's New popup can change any
                // settings, so a first-time fork user keeps a restore point of
                // their pre-fork state. Awaited so the two popups never overlap.
                await UI.forkBackupPrompt.maybeShow();

                UI.whatsNew.maybeShow();

                // Health check after initialization. The failed-features half
                // (health check, one retry, report) is shared with the
                // character-switch path — see scheduleFailedFeatureRecovery.
                scheduleFailedFeatureRecovery(initFailures);

                // Selector canary: runs regardless of whether any single feature
                // reported unhealthy, because a game update can rename every
                // class at once without a single per-feature check noticing —
                // each one's anchor is just "not open," which reads as null.
                //
                // The schema canary is the same argument one layer down: the
                // script hardcodes the game's own data keys and hrids, and a
                // renamed one produces empty maps and null lookups rather
                // than an error. Both are reported together — two toasts
                // about the same game update is one toast too many.
                //
                // Note: Settings tab health check removed - tab only appears when user opens settings panel
                setTimeout(() => {
                    const canaryFailures = [...checkAnchorCanaries(), ...UI.schemaCanary.runSchemaCanary()];
                    if (canaryFailures.length > 0) {
                        console.warn(
                            '[Toolasha] Canary found missing anchors or game data — the game may have updated:',
                            canaryFailures.map((f) => f.name)
                        );
                        UI.healthStatus.reportFailures(canaryFailures);
                    }
                }, 500); // Wait 500ms after initialization to check health
            } catch (error) {
                // Nothing below this point ran, so the console was the only place
                // that said so — and a script that silently did not start is
                // indistinguishable from one that was never installed
                console.error('[Toolasha] Feature initialization failed:', error);
                showToast(`Toolasha failed to start: ${error.message}`, {
                    kind: 'error',
                    duration: 0,
                    action: {
                        label: 'Diagnostics',
                        onClick: () =>
                            UI.healthStatus.showHealthStatus([
                                {
                                    key: 'startup',
                                    name: 'Toolasha startup',
                                    reason: error.message || String(error),
                                },
                            ]),
                    },
                });
            }
        }, 100);
    });

    // Expose minimal user-facing API
    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    targetWindow.Toolasha.version = '3.45.0';
    // Which fork this build came from. Version numbers are shared with
    // upstream, so the what's-new popup keys on the (fork, version) pair —
    // the same number on a different fork is still an update.
    targetWindow.Toolasha.fork = 'Millennium44/Toolasha';

    // Feature toggle API (for users to manage settings via console)
    targetWindow.Toolasha.features = {
        list: () => config.getFeaturesByCategory(),
        enable: (key) => config.setFeatureEnabled(key, true),
        disable: (key) => config.setFeatureEnabled(key, false),
        toggle: (key) => config.toggleFeature(key),
        status: (key) => config.isFeatureEnabled(key),
        info: (key) => config.getFeatureInfo(key),
    };

    // Guild XP data management
    targetWindow.Toolasha.guild = {
        resetMemberXP: () => Combat.guildXPTracker.resetMemberData(),
        memberSample: (name) => Combat.guildXPTracker.getRawMemberSample(name),
    };

    // The per-player trial panel, so the command palette can reach it the way it
    // reaches every other panel — through the page rather than through an import
    targetWindow.Toolasha.guildTrialScoreboard = Combat.guildTrialScoreboard;

    // Debug utilities (for diagnosing issues via console)
    targetWindow.Toolasha.debug = {
        storage: () => {
            const diag = storage.diagnostics();
            console.log('=== Storage Diagnostics ===');
            console.log('DB connection exists:', diag.dbExists);
            console.log('Storage available:', diag.available);
            console.log('DB name:', diag.dbName);
            console.log('DB version:', diag.dbVersion);
            console.log('Reconnecting:', diag.reconnecting);
            console.log('Last null reason:', diag.lastNullReason || 'never');
            console.log('Pending writes:', diag.pendingWrites);
            console.log('Active timers:', diag.activeTimers);
            return diag;
        },
        // The errors this script's own code has logged or thrown this session,
        // newest first — what the settings panel's Diagnostics section shows
        errors: () => errorLog?.getEntries?.() || [],
        clearErrors: () => errorLog?.clear?.(),
        // The selector canary, callable directly for a spot-check without
        // waiting for the delayed health pass to run it on its own.
        canary: checkAnchorCanaries,
        // Diff the whole selector registry against the game's stylesheets —
        // the after-a-game-update sweep, without visiting a single screen.
        // Extra selectors (a feature's private ones) can be handed in.
        selectorAudit: (extra) => UI.selectorAudit.runSelectorAudit(extra),
        // The same, for the shape of the game data rather than the page
        schema: () => UI.schemaCanary.runSchemaCanary(),
        // The health report on demand, rather than only when a startup toast
        // leads to it. Assembles the failures the delayed pass would — minus the
        // startup-only init failures, which are not available once the page is
        // running — refreshes the storage numbers so the report is current,
        // logs it so it is copyable straight from the console, and opens the
        // panel with its Copy button. Returns the report text, or null on error.
        health: async () => {
            try {
                const failures = mergeFailures(featureRegistry.checkFeatureHealth(), [
                    ...checkAnchorCanaries(),
                    ...UI.schemaCanary.runSchemaCanary(),
                ]);
                await UI.healthStatus.refreshStorageFacts();
                const report = UI.healthStatus.buildDiagnosticReport(failures);
                console.log(report);
                UI.healthStatus.showHealthStatus(failures);
                return report;
            } catch (error) {
                console.error('[Toolasha] Building the health report failed:', error);
                return null;
            }
        },
    };
}

/**
 * Test-only. `entrypoint.js` otherwise has no exports — it is a boot script run
 * for its side effects — but `checkMwiToolsWithRetries` schedules real timers
 * from deep inside a one-shot, hard-to-re-trigger startup sequence
 * (`startupBegun` in the `character_initialized` handler below), which makes it
 * impractical to exercise through that path alone. Exported so a test can call
 * it directly against the same module-scoped `dualInstallGuard`/`mwiToolsWarned`
 * state the real call site uses.
 */
export { checkMwiToolsWithRetries as _checkMwiToolsWithRetries };
