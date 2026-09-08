/**
 * Dual-install guard.
 *
 * Two copies of Toolasha on one page do not coexist — they share storage. The
 * database name and the exact settings and tab keys are the same for this fork
 * and for the script it forked from (deliberately: it is what lets a user move
 * between them without losing anything — see the note in `settings-storage.js`).
 * The database VERSION is kept in lockstep by hand — upstream bumps it as it
 * adds stores, and a fork left behind dies with a VersionError the moment the
 * newer script touches the shared database first (storage.js matches upstream's
 * version, creates its stores, and reopens versionless as a last resort). The cost of that sharing is that whichever copy saves
 * last wins the WHOLE map, because the settings map is written whole. A copy
 * with a smaller schema therefore deletes every setting the other one added,
 * silently, on the next toggle of anything. That is the confirmed cause of the
 * "all my settings reset" reports.
 *
 * Nothing on this side can stop the other copy writing. What it can do is
 * notice and say so, which is what this module is for. Two independent signals,
 * because neither alone covers every case:
 *
 * 1. **The page marker.** The first copy to run stamps its own instance id on
 *    `window.Toolasha`; a second copy finding a different id, or finding its
 *    own stamp gone at a later check, knows another full instance is running.
 *    This fires BEFORE any damage — but only for a copy that stamps, i.e.
 *    another build of this fork. It is deliberately NOT "window.Toolasha is
 *    already defined": every one of this fork's own @require bundles defines
 *    it, by design, so that test would fire on every single load.
 *
 * 2. **The settings fingerprint.** Every load records which setting ids the
 *    stored map held, alongside the build that saw them. When a later load of
 *    the SAME build finds ids missing that the previous load had, something
 *    that is not this build rewrote the map — which is exactly the shape of
 *    the damage. This one catches the other script whatever order the two load
 *    in, at the cost of only being able to say so after the first rewrite.
 *
 * The honest limit, stated plainly: there is no reliable way from inside this
 * script to see a co-installed copy of the *other* script before it writes. It
 * announces itself on no global this fork can distinguish from its own, and
 * userscript managers do not expose their peers. Signal 2 is the closest safe
 * approximation, and it is the one that matches the reported symptom.
 */

import storage from './storage.js';

const STORE = 'settings';

/** Where the instance stamp lives on the shared namespace object */
const INSTANCE_KEY = '__toolashaInstance';

/** Where the previous load's settings fingerprint lives */
const FINGERPRINT_KEY = 'toolasha_settingsFingerprint';

/** This page-load's identity — a new one every time the script runs */
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** What the user is told, once, when either signal fires */
export const DUAL_INSTALL_MESSAGE =
    'Two copies of Toolasha are running on this page. They share the same database, ' +
    'so each one overwrites the other’s settings and custom tabs — this is how settings ' +
    'get reset and tabs disappear. Open your userscript manager and keep exactly one ' +
    'Toolasha enabled, then reload.';

/** The namespace object both the bundles and any other copy would use */
function namespace() {
    if (typeof window === 'undefined') return null;
    if (!window.Toolasha) window.Toolasha = {};
    return window.Toolasha;
}

/**
 * Claim the page for this instance, and report whether someone got here first.
 *
 * Call once, as early as the script runs.
 * @returns {boolean} Whether another instance had already claimed the page
 */
export function claimPage() {
    const ns = namespace();
    if (!ns) return false;
    const existing = ns[INSTANCE_KEY];
    const taken = Boolean(existing && existing.id && existing.id !== INSTANCE_ID);
    ns[INSTANCE_KEY] = { id: INSTANCE_ID, at: Date.now() };
    if (taken) {
        console.warn('[DualInstall] Another Toolasha instance had already claimed this page:', existing);
    }
    return taken;
}

/**
 * Has anything replaced this instance's claim since {@link claimPage}?
 *
 * A second copy that loads after this one overwrites the stamp (or resets the
 * namespace object outright, which reads the same way here).
 * @returns {boolean} Whether the claim is gone
 */
export function claimLost() {
    if (typeof window === 'undefined') return false;
    const stamped = window.Toolasha?.[INSTANCE_KEY];
    const lost = !stamped || stamped.id !== INSTANCE_ID;
    if (lost) console.warn('[DualInstall] This instance’s page claim was replaced:', stamped);
    return lost;
}

/**
 * Compare the setting ids in the stored map against the ones the previous load
 * of this same build saw, and record the current set for next time.
 *
 * Only a LOSS counts, and only within one build: a build change legitimately
 * adds and removes schema ids, so the fingerprint is discarded whenever the
 * version differs rather than read as an accusation.
 *
 * Pure apart from the one record it keeps; safe to call when nothing is stored
 * (it records and says nothing).
 *
 * @param {string} characterKey - The settings key the map was read from
 * @param {Array<string>|null} storedIds - Ids in the stored map, or null when absent
 * @param {string} version - This build's version
 * @param {Array<string>|null} [schemaIds] - Every id this build's schema defines. A vanished id
 *   the CURRENT schema no longer carries was removed by this build on purpose — dev builds keep
 *   one version string across schema changes, so without this a deliberately deleted setting
 *   read as another script's overwrite on the next dev reload.
 * @returns {Promise<Array<string>>} The ids that went missing since the last load
 */
export async function checkSettingsFingerprint(characterKey, storedIds, version, schemaIds = null) {
    if (!Array.isArray(storedIds) || storedIds.length === 0) return [];
    const key = `${FINGERPRINT_KEY}_${characterKey}`;
    let missing = [];
    try {
        const previous = await storage.getJSON(key, STORE, null);
        if (previous && previous.version === version && Array.isArray(previous.ids)) {
            const now = new Set(storedIds);
            const known = Array.isArray(schemaIds) ? new Set(schemaIds) : null;
            missing = previous.ids.filter((id) => !now.has(id) && (!known || known.has(id)));
        }
        await storage.setJSON(key, { version, ids: storedIds, at: Date.now() }, STORE, true);
    } catch (error) {
        console.error('[DualInstall] Settings fingerprint check failed:', error);
        return [];
    }
    if (missing.length > 0) {
        console.warn(
            `[DualInstall] ${missing.length} setting(s) vanished from the stored map between loads of the same ` +
                'build — another Toolasha shares this storage and rewrote it:',
            missing
        );
    }
    return missing;
}

/**
 * MWITools exposes a versioned, non-writable API object on this key once its
 * `public-api` module has run. It is a plain data object rather than an
 * instance stamp, so identity is checked by shape (`name === 'MWITools'`)
 * rather than by value.
 */
const MWI_TOOLS_API_KEY = 'MWIToolsAPI';

/**
 * DOM id MWITools' `mobile-viewport-fix` feature creates unconditionally at
 * boot — it is registered with no `setting` key, so unlike most of its
 * features it is not behind a toggle a user could have turned off. Used only
 * as a fallback for a build where the API global has been renamed or removed;
 * the global is the primary signal because a `<style>` id is easy to collide
 * with by accident and says nothing about version.
 *
 * Adapted from MWITools src/features/mobile-viewport-fix.js, CC-BY-NC-SA-4.0,
 * see third-party/mwitools/.
 */
const MWI_TOOLS_DOM_FALLBACK_ID = 'mwitools-mobile-viewport-style';

/** What the user is told when MWITools is detected sharing the page */
export const MWI_TOOLS_MESSAGE =
    'MWITools is also running on this page. Its task sorting, market filters, DPS panel, net worth ' +
    'tracking, and item tooltips overlap with Toolasha’s own — expect duplicate panels, duplicate ' +
    'listeners, and numbers computed twice. Keep only one of the two enabled in your userscript manager.';

/**
 * Whether MWITools is also running on this page.
 *
 * Checked by the same two-signal shape as the dual-install guard above: a
 * global MWITools itself controls (its public API), with a DOM fallback for
 * a build that has changed the global's name. Unlike the dual-install guard,
 * there is no fingerprint signal here — MWITools does not share Toolasha's
 * database, so there is no settings map to watch for damage. The two scripts
 * simply duplicate each other's UI, which is a lesser but still real problem
 * this only needs to report once.
 *
 * @param {Window} [win] - Injected for tests
 * @returns {boolean}
 */
export function detectMwiTools(win = typeof window === 'undefined' ? null : window) {
    if (!win) return false;
    const api = win[MWI_TOOLS_API_KEY];
    if (api && typeof api === 'object' && api.name === 'MWITools') return true;
    return Boolean(win.document?.getElementById?.(MWI_TOOLS_DOM_FALLBACK_ID));
}

export default {
    claimPage,
    claimLost,
    checkSettingsFingerprint,
    detectMwiTools,
    DUAL_INSTALL_MESSAGE,
    MWI_TOOLS_MESSAGE,
};
