/**
 * Update Check
 *
 * Tells the player when a newer Toolasha release exists. Off by default: the
 * userscript manager already updates on its own schedule, so this is for
 * whoever wants to hear about a release the moment they next refresh instead.
 *
 * The check itself is rate-limited by a second setting (hours between checks),
 * with the last answer cached — so a refresh inside the window costs no
 * request, only a cache read, and still surfaces a known-newer version. The
 * release feed is the fork's own GitHub releases endpoint, reached through the
 * same transport the sync feature already uses (GM_xmlhttpRequest, with a
 * fetch fallback outside the sandbox).
 *
 * Never notifies a dev build: the dev loader pins its version far above any
 * release, so the comparison keeps it silent by construction.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { httpRequest } from '../sync/gist-client.js';
import { openSettings } from './command-palette.js';
import { compareVersions } from '../../utils/compare-versions.js';
import { scriptVersion } from '../../utils/script-version.js';
import { showToast } from '../../utils/toast.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

const RELEASES_URL = 'https://api.github.com/repos/Millennium44/Toolasha/releases/latest';
const GREASYFORK_URL = 'https://greasyfork.org/en/scripts/589090-toolasha-millennium44';
const STORAGE_KEY = 'updateCheckState';
const INTRO_KEY = 'updateCheckIntroduced';
const STORE_NAME = 'settings';

/** Let the game (and the toast container's page) finish drawing first */
const STARTUP_DELAY_MS = 8 * 1000;

/** The in-session repeat never runs hotter than this, whatever the setting says */
const MIN_REPEAT_HOURS = 1;

// Lives in script-version.js so the what's-new changelog filter can order
// versions without importing this feature (and its transport, toasts and
// timers) to do it. Re-exported because this module's own tests and callers
// have always taken it from here.
export { compareVersions } from '../../utils/compare-versions.js';

/**
 * The latest release version according to GitHub, or null.
 * @returns {Promise<string|null>} A version like `3.17.0`, without the tag's `v`
 */
async function fetchLatestVersion() {
    const response = await httpRequest({
        method: 'GET',
        url: RELEASES_URL,
        headers: { Accept: 'application/vnd.github+json' },
    });
    if (response.status !== 200) return null;
    const tag = JSON.parse(response.text)?.tag_name || '';
    const version = tag.replace(/^v/, '');
    return /^\d+(\.\d+)*$/.test(version) ? version : null;
}

class UpdateCheck {
    constructor() {
        this.isInitialized = false;
        this.timerRegistry = createTimerRegistry();
        /** The version last announced this session, so repeats do not re-toast it */
        this.notifiedVersion = null;
    }

    initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const enabled = config.getSetting('updateCheck', false) === true;
        const run = () => {
            const work = enabled ? this._check() : this._introduce();
            work.catch((error) => {
                console.error('[UpdateCheck] Check failed:', error);
            });
        };
        this.timerRegistry.registerTimeout(setTimeout(run, STARTUP_DELAY_MS));

        // A tab left open for days should not need a refresh to hear about a
        // release: the same interval setting paces an in-session repeat, floored
        // so "0 = every refresh" cannot become a hot loop
        if (enabled) {
            const repeatMs = Math.max(MIN_REPEAT_HOURS, this._intervalHours()) * 60 * 60 * 1000;
            this.timerRegistry.registerInterval(setInterval(run, repeatMs));
        }
    }

    /**
     * The configured hours between checks. 0 is a real choice — check on every
     * refresh; negative or unparseable falls back to the default.
     * @returns {number}
     * @private
     */
    _intervalHours() {
        const raw = Number(config.getSettingValue('updateCheckHours', 6));
        return Number.isFinite(raw) && raw >= 0 ? raw : 6;
    }

    /**
     * Say once, ever, that the opt-in exists — a setting nobody has heard of is
     * a setting nobody turns on. Only while it is off; enabling it first counts
     * as having heard.
     * @private
     */
    async _introduce() {
        const introduced = await storage.getJSON(INTRO_KEY, STORE_NAME, false);
        if (introduced) return;
        await storage.setJSON(INTRO_KEY, true, STORE_NAME);
        showToast('Toolasha can tell you when a new release is out (off by default). Click to see the setting.', {
            kind: 'info',
            duration: 15 * 1000,
            action: {
                label: 'Open settings',
                onClick: () => openSettings('update check', 'updateCheck'),
            },
        });
    }

    /**
     * One check: read the cache, refresh it over the network when it has gone
     * stale, and say something only when what is known is newer than what is
     * running.
     * @private
     */
    async _check() {
        // Running with the setting on counts as having heard of it
        storage.setJSON(INTRO_KEY, true, STORE_NAME).catch(() => {});

        const current = scriptVersion();
        if (!current) return; // Outside the userscript sandbox there is nothing to compare

        const hours = this._intervalHours();
        const state = (await storage.getJSON(STORAGE_KEY, STORE_NAME, null)) || {};

        let latest = state.latestVersion || null;
        const stale = !state.checkedAt || Date.now() - state.checkedAt > hours * 60 * 60 * 1000;
        if (stale) {
            const fetched = await fetchLatestVersion();
            if (fetched) {
                latest = fetched;
                await storage.setJSON(STORAGE_KEY, { checkedAt: Date.now(), latestVersion: fetched }, STORE_NAME);
            }
        }

        if (latest && compareVersions(latest, current) > 0) {
            this._notify(latest, current);
        }
    }

    /**
     * The one thing this feature says.
     * @param {string} latest - The release version available
     * @param {string} current - The version running
     * @private
     */
    _notify(latest, current) {
        if (this.notifiedVersion === latest) return;
        this.notifiedVersion = latest;
        showToast(`Toolasha v${latest} is out (you have v${current}). Click to open GreasyFork.`, {
            kind: 'info',
            duration: 15 * 1000,
            action: {
                label: 'Open GreasyFork',
                onClick: () => window.open(GREASYFORK_URL, '_blank', 'noopener'),
            },
        });
    }

    cleanup() {
        this.timerRegistry.clearAll();
        this.isInitialized = false;
        this.notifiedVersion = null;
    }
}

const updateCheck = new UpdateCheck();

export default {
    name: 'Update Check',
    initialize: async () => updateCheck.initialize(),
    cleanup: () => {
        try {
            updateCheck.cleanup();
        } catch (error) {
            console.warn('[UpdateCheck] Disable failed part-way:', error);
        }
    },
};

export { updateCheck };
