/**
 * Cross-device sync.
 *
 * Two devices, one account, and no server of ours: the settings and history
 * this script accumulates live in IndexedDB, which is per-browser, so a second
 * machine starts empty and a reinstall starts empty again. This carries them
 * across via a single private GitHub gist that the user owns, using a personal
 * access token they supply.
 *
 * The conflict model is deliberately small. Every payload carries an
 * `exportedAt`, newest wins, and the only case that asks a question is the one
 * where both sides moved: the remote is newer than what this device last
 * exchanged *and* this device has changed since then. Anything else resolves
 * without a dialog, because a sync that interrogates you on startup is a sync
 * you turn off.
 *
 * Applying a payload is not an overwrite. Records that can only grow — chest
 * tallies, market listings, XP series, trial records, labyrinth runs — are
 * combined with this device's copy key by key (see `sync-payload.js` and
 * `utils/sync-merge-registry.js`), because there is no reading of "take the
 * remote copy" under which throwing away entries the remote has never seen is
 * what anyone meant. What the conflict dialog actually decides is the fate of
 * the records that *cannot* be combined — settings, watchlists, plans — and
 * whether the union goes straight back up to the gist.
 *
 * "Has this device changed" is answered by fingerprinting the payload rather
 * than by watching writes. Watching writes would mean a hook on every store; the
 * fingerprint costs one build of a payload we were about to build anyway.
 *
 * Everything fails soft. A missing token, a spent rate limit, a plane with no
 * wifi — each is a toast and a no-op, never a thrown error into whatever called
 * us, and never a partial write.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { GAME } from '../../utils/selectors.js';
import storage from '../../core/storage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { showToast } from '../../utils/toast.js';
import { askChoice } from '../../utils/choice-dialog.js';
import { GistError, findSyncGist, readSyncGist, writeSyncGist, chunkPayload } from './gist-client.js';
import { compressionAvailable, gzipText, gunzipToText } from './sync-compress.js';
import { encryptText, encryptBytes, decryptText, decryptBytes, bytesToBase64, base64ToBytes } from './sync-crypto.js';
import { buildPayloadJSON, applyPayload, contentHash, hashPayload } from './sync-payload.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

const STORE = 'settings';

/** Which gist this device is using. Never uploaded — see sync-payload.js */
const KEY_GIST_ID = 'toolasha_sync_gistId';

/** `exportedAt` of the payload this device last pushed or pulled */
const KEY_LAST_SYNCED_AT = 'toolasha_sync_lastSyncedAt';

/**
 * When this device last pushed its own data to the gist.
 *
 * Separate from KEY_LAST_SYNCED_AT, which a pull overwrites with the *remote's*
 * exportedAt: after a pull that stamp says "this device applied someone else's
 * export", which is not the same question as "is this device's data in the gist".
 * Written only on a successful push.
 */
const KEY_LAST_PUSHED_AT = 'toolasha_sync_lastPushedAt';

/** Fingerprint of that payload, so local drift since then is detectable */
const KEY_LAST_HASH = 'toolasha_sync_lastHash';

/** How many chunk files the gist holds, so a shrinking payload can delete the rest */
const KEY_CHUNK_COUNT = 'toolasha_sync_chunkCount';

/**
 * How often auto-sync considers pushing.
 *
 * Long, on purpose. Each tick rebuilds the payload to fingerprint it, which for
 * the `everything` scope is a full database read; doing that every minute would
 * be a visible stutter in exchange for freshness nobody asked for.
 */
export const AUTO_PUSH_INTERVAL_MS = 15 * 60 * 1000;

/** How long after a character switch the on-switch push waits for the dust. */
const SWITCH_PUSH_DELAY_MS = 5 * 1000;

/**
 * Startup pulls, staggered. One pull twenty seconds in raced the handoff: a
 * phone logging in pulls before the tab it kicked has finished pushing, and
 * misses it by seconds. The retries are nearly free — a pull whose remote is
 * not newer stops at the manifest read.
 */
const STARTUP_PULL_DELAYS_MS = [20 * 1000, 80 * 1000, 200 * 1000];

/** The periodic silent pull sits between the pushes rather than beside them. */
const AUTO_PULL_OFFSET_MS = Math.floor(AUTO_PUSH_INTERVAL_MS / 2);

/**
 * The character the manager last initialised for. Module-scoped on purpose:
 * a character switch tears the feature down and re-initialises it, and the
 * only thing that survives to say "this is a switch, not a page load" is the
 * module itself.
 */
let lastCharacterId = null;

/** A sync busy longer than this is wedged, and a new one may take over. */
const BUSY_STUCK_MS = 5 * 60 * 1000;

class SyncManager {
    constructor() {
        this.timers = createTimerRegistry();
        this.busy = false;
        this.isInitialized = false;
        this.settingListeners = [];
    }

    /**
     * Start the feature. Safe to call when sync is off — it wires the setting
     * listeners and returns, so turning sync on later does not need a reload.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const restart = () => {
            this.timers.clearAll();
            this.handoffUnregister?.();
            this.handoffUnregister = null;
            this._startAuto();
            this._watchHandoff();
        };
        for (const key of ['sync_enabled', 'sync_auto']) {
            config.onSettingChange(key, restart);
            this.settingListeners.push([key, restart]);
        }

        this._startAuto();
        this._watchHandoff();

        // Offered only when a push or pull could actually succeed. Asked
        // fresh each time the palette opens rather than once here: sync is
        // configured from the settings panel, without a re-initialise
        registerCommand({
            name: 'Sync push',
            hint: 'Push settings and data to GitHub now',
            run: () => this.push(),
            when: () => this.isConfigured(),
        });
        registerCommand({
            name: 'Sync pull',
            hint: 'Pull the GitHub copy onto this device',
            run: () => this.pull(),
            when: () => this.isConfigured(),
        });

        // A re-initialise for a DIFFERENT character is a switch: push shortly,
        // so the character just left has its changes on GitHub without waiting
        // out the quarter-hour timer. The unchanged-skip makes this free when
        // nothing moved; the first initialise of a page load never fires it.
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (
            lastCharacterId !== null &&
            characterId !== null &&
            characterId !== lastCharacterId &&
            config.getSetting('sync_onSwitch', false) &&
            this.isConfigured()
        ) {
            this.timers.registerTimeout(
                setTimeout(() => {
                    this.push({ silent: true });
                }, SWITCH_PUSH_DELAY_MS)
            );
        }
        if (characterId !== null) lastCharacterId = characterId;
    }

    /** Stop timers and setting listeners. */
    cleanup() {
        unregisterCommand('Sync push');
        unregisterCommand('Sync pull');
        this.handoffUnregister?.();
        this.handoffUnregister = null;
        this.handoffPushed = false;
        this.timers.clearAll();
        for (const [key, callback] of this.settingListeners) config.offSettingChange(key, callback);
        this.settingListeners = [];
        this.isInitialized = false;
    }

    /**
     * Whether sync is switched on and has something to authenticate with.
     * @returns {boolean} True when a push or pull could succeed
     */
    isConfigured() {
        return Boolean(config.getSetting('sync_enabled', false) && this._token());
    }

    /**
     * Push local data to the gist.
     * @param {Object} [options] - Options
     * @param {boolean} [options.silent=false] - Skip when nothing changed, and
     *   only speak up on failure. Used by the interval.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     */
    async push({ silent = false } = {}) {
        return this._run('push', silent, (opToken) => this._doPush(silent, opToken));
    }

    /**
     * The upload itself, with no guard around it.
     *
     * Split out from `push()` so the conflict dialog's "keep this device" can
     * reach it: calling `push()` from inside a running `pull()` would be turned
     * away by the same `busy` flag that is protecting the pull, and the user's
     * choice would silently do nothing.
     *
     * @param {boolean} silent - Skip an unchanged payload, and say nothing on success
     * @param {number} [opToken] - This call's `busy` ownership token, from `_run`. Checked
     *   before every write that follows a wait a takeover could have happened during (a
     *   confirmation dialog left open, a hung request) — see `_stillOwns`.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _doPush(silent, opToken) {
        const token = this._token();
        const scope = config.getSetting('sync_scope', 'settings');

        // `buildPayloadJSON` reads IndexedDB, and `storage.set` holds a value
        // for three seconds before it gets there — so an unflushed payload is
        // this session's data minus whatever it recorded last. The interval
        // push can shrug that off, because the next tick picks the write up.
        // The two pushes that exist *because* there will be no next tick
        // cannot: the handoff push fires when another device has taken the
        // session over, and the character-switch push fires as the character
        // being left goes away. Both would upload a copy with the final
        // seconds cut off, and nothing would ever put them back.
        await storage.flushAll?.();

        const payload = await buildPayloadJSON(scope);
        const hash = contentHash(payload);

        if (silent && hash === (await storage.get(KEY_LAST_HASH, STORE, null))) {
            return { ok: true, skipped: true, reason: 'unchanged' };
        }

        const gistId = await this._resolveGistId(token);

        // A device that has never exchanged with the gist has no idea what it
        // would be overwriting — a fresh phone pushing before its first pull
        // would replace a year of data with an empty database. Ask, with the
        // right answer suggested; the interval never asks, it just declines.
        if (gistId && !(await storage.get(KEY_LAST_SYNCED_AT, STORE, null))) {
            if (silent) return { ok: true, skipped: true, reason: 'never-synced' };
            const answer = await askChoice({
                title: 'Overwrite the gist?',
                message:
                    'This device has never synced with the gist already on this account. Pushing replaces ' +
                    "everything in the gist with this device's data. If this device is the new or empty one, " +
                    'Pull first instead.',
                choices: [
                    { value: 'push', label: 'Push and overwrite the gist', tone: 'danger' },
                    { value: null, label: 'Cancel' },
                ],
            });
            if (answer !== 'push') return { ok: true, skipped: true, reason: 'cancelled' };
            // The dialog just above can sit open for as long as the player
            // ignores it — the paradigm case of "wedged" that lets a takeover
            // happen at all (see `_run`). If one did, this push is racing an
            // operation that has already run with a fresher view of both the
            // database and the gist; writing now would stomp whatever it just
            // wrote. Stand down instead of overwriting a newer sync.
            if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push');
        }

        // The hash above is always of the plaintext — compression and
        // encryption both change the bytes without changing the data (and a
        // fresh salt makes ciphertext different every push), so hashing
        // anything later in the pipeline would make every payload look changed.
        //
        // Pipeline order is gzip first, encrypt second: JSON compresses ~5-10×
        // and ciphertext does not compress at all. This is what fits the
        // "everything" scope under the gist ceiling.
        const passphrase = this._passphrase();
        const compressed = compressionAvailable() ? 'gzip' : null;
        const bodyBytes = compressed ? await gzipText(payload) : null;

        let body;
        let encrypted = null;
        if (passphrase) {
            const sealed = compressed
                ? await encryptBytes(bodyBytes, passphrase)
                : await encryptText(payload, passphrase);
            body = sealed.ciphertext;
            encrypted = {
                v: 1,
                algorithm: sealed.algorithm,
                kdf: sealed.kdf,
                iterations: sealed.iterations,
                salt: sealed.salt,
                iv: sealed.iv,
            };
        } else {
            body = compressed ? bytesToBase64(bodyBytes) : payload;
        }

        const chunks = chunkPayload(body);
        const previousChunks = Number(await storage.get(KEY_CHUNK_COUNT, STORE, 0)) || 0;

        const exportedAt = new Date().toISOString();
        const manifest = {
            toolashaSync: 1,
            scope,
            exportedAt,
            chunks: chunks.length,
            bytes: payload.length,
            hash,
            ...(compressed ? { compressed } : {}),
            ...(encrypted ? { encrypted } : {}),
        };

        // Last check before the write that actually reaches GitHub. Nothing
        // between the top of this method and here normally takes long enough
        // for a takeover to happen without the dialog above, but a `fetch`
        // fallback (no GM manager) has no timeout of its own and can hang
        // indefinitely — the same "wedged" shape, just without a dialog to
        // point at.
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push');

        const written = await writeSyncGist(token, gistId, manifest, chunks, previousChunks);

        // The upload already landed — that part cannot be undone or is not
        // worth undoing, since the takeover's own more-recent write (if any)
        // will win the next read anyway. What must not happen is THIS call's
        // bookkeeping clobbering whatever the takeover has since recorded:
        // this `exportedAt`/`hash` describe a snapshot from before the wait,
        // and stamping them now would make a perfectly good later sync look
        // unsynced again.
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push');

        await this._remember({ gistId: written.id, exportedAt, hash, chunkCount: chunks.length });
        await rememberLocal({ [KEY_LAST_PUSHED_AT]: exportedAt });

        if (!silent) {
            showToast(`Synced to GitHub (${scope === 'everything' ? 'everything' : 'settings only'}).`);
        }
        return { ok: true };
    }

    /**
     * Pull remote data down, newest-wins, asking first if both sides moved.
     * @param {Object} [options] - Options
     * @param {boolean} [options.silent=false] - Only act when the remote is
     *   strictly newer, and stay quiet otherwise. Used at startup.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     */
    async pull({ silent = false } = {}) {
        return this._run('pull', silent, (opToken) => this._doPull(silent, opToken));
    }

    /**
     * The download itself, with no guard around it.
     * @param {boolean} silent - Only act on a strictly newer remote, and stay quiet otherwise
     * @param {number} [opToken] - This call's `busy` ownership token, from `_run`. See `_stillOwns`.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _doPull(silent, opToken) {
        const token = this._token();
        const gistId = await this._resolveGistId(token);
        if (!gistId) {
            if (!silent) {
                showToast('No sync gist found for this token yet. Push once to create it.', { kind: 'warn' });
            }
            return { ok: true, skipped: true, reason: 'no-gist' };
        }

        const remote = await readSyncGist(token, gistId);
        const manifest = remote.manifest;
        let payload = remote.payload;

        // Unwind the push pipeline: decrypt first, then decompress. A manifest
        // without either flag is a payload from before they existed, and reads
        // exactly as it always did.
        if (manifest?.encrypted) {
            const passphrase = this._passphrase();
            if (!passphrase) {
                throw new GistError(
                    'passphrase',
                    'This sync gist is encrypted, and no sync passphrase is set on this device.'
                );
            }
            const sealed = { ...manifest.encrypted, ciphertext: payload };
            payload = manifest.compressed
                ? await gunzipToText(await decryptBytes(sealed, passphrase))
                : await decryptText(sealed, passphrase);
        } else if (manifest?.compressed) {
            payload = await gunzipToText(base64ToBytes(payload));
        }

        verifyAgainstManifest(manifest, payload);

        const remoteAt = manifest?.exportedAt ?? null;
        const lastSyncedAt = await storage.get(KEY_LAST_SYNCED_AT, STORE, null);

        if (!isNewer(remoteAt, lastSyncedAt)) {
            if (!silent) showToast('Already up to date with GitHub.');
            return { ok: true, skipped: true, reason: 'not-newer' };
        }

        // Both sides moved: the remote is ahead of what we last exchanged, and so
        // are we. Newest-wins would throw away whichever is older without saying
        // so, which is not a thing to do to a year of history.
        const localHash = contentHash(await buildPayloadJSON(config.getSetting('sync_scope', 'settings')));
        const lastHash = await storage.get(KEY_LAST_HASH, STORE, null);
        const localChanged = Boolean(lastHash) && localHash !== lastHash;

        /** Whether the union this pull produces is sent straight back up */
        let pushBack = false;

        if (localChanged) {
            // The silent path is the unattended one (the startup pull). A
            // modal it raises sits unanswered behind the game while `busy`
            // stays held, and every 15-minute auto-push for the rest of the
            // session returns 'busy' without a word — the "auto-sync randomly
            // stops until I reload" report. Unattended pulls stand down and
            // leave the decision to a human-initiated sync.
            if (silent) {
                console.warn('[Sync] Startup pull found both sides changed; leaving it for a manual sync.');
                return { ok: true, skipped: true, reason: 'conflict' };
            }
            const answer = await askChoice({
                title: 'Sync conflict',
                message:
                    `The copy on GitHub is newer (${formatWhen(remoteAt)}), and this device has changed ` +
                    'since it last synced.\n\n' +
                    'Histories that only ever grow — treasure tallies, market listings, XP series, trial ' +
                    'records, labyrinth runs — are combined either way, so nothing recorded on either side ' +
                    'is lost. Settings and edited lists (watchlists, plans, custom tabs) can only take one ' +
                    "side, and that is what this asks: applying the GitHub copy replaces this device's.",
                choices: [
                    { value: 'merge', label: 'Merge and push the result back', tone: 'primary' },
                    { value: 'pull', label: 'Apply the GitHub copy here only' },
                    { value: 'push', label: 'Keep this device and push' },
                    { value: null, label: 'Do nothing' },
                ],
            });
            // The dialog above is the one this file's "wedged" comments are
            // about — it can sit open for as long as the player ignores it.
            // A takeover during that wait means an operation with a fresher
            // view of both the database and the gist has already run; this
            // pull's decision was made against a snapshot that no longer
            // exists, and applying it now would silently undo whatever that
            // operation just did.
            if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'pull');
            if (answer === 'push') return this._doPush(false, opToken);
            if (answer !== 'pull' && answer !== 'merge') return { ok: true, skipped: true, reason: 'cancelled' };
            pushBack = answer === 'merge';
        }

        // Last check before the write that actually lands in IndexedDB. On the
        // no-dialog path this only catches a `fetch` fallback (no GM manager,
        // no timeout of its own) hanging long enough for a takeover — the same
        // "wedged" shape as the dialog above, just without a dialog to point at.
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'pull');

        const { merged, mergeFailed, mergeHeld, complete, failed, applied } = await applyPayload(payload);

        // A pull that wrote nothing must not move the stamp. Remembering the
        // remote's `exportedAt` after a failed apply makes every later pull
        // answer 'not-newer' — the data never arrives and sync reports success
        // for ever. One store aborting its transaction is enough to get here.
        if (complete === false) {
            const stores = (failed || []).map((entry) => entry.store).join(', ');
            console.error('[Sync] The pull did not apply cleanly; leaving the sync stamp alone.', failed);
            showToast(
                `Sync pull could not write ${stores || 'some stores'}. Nothing was recorded as synced — ` +
                    'free some space or reload and try again.',
                { kind: 'error', duration: 0 }
            );
            return { ok: false, reason: 'incomplete-apply' };
        }

        await this._remember({
            gistId,
            exportedAt: remoteAt,
            // The CONTENT hash of what was APPLIED — remembered so the next
            // local rebuild of the same content compares equal. Not the raw
            // download: a merging pull rewrites the payload before importing
            // it, so the downloaded text describes something that was never
            // stored. The manifest's own hash (older devices hashed the raw
            // text, stamp included) could never match a rebuild either, and
            // manufactured a permanent conflict.
            hash: contentHash(applied ?? payload),
            chunkCount: Number(manifest?.chunks) || 0,
        });

        const combined = merged?.length
            ? ` ${merged.length} ${merged.length === 1 ? 'record was' : 'records were'} combined rather than replaced.`
            : '';
        // A record whose fold threw took the remote copy whole, which is this
        // device's entries for it gone. The pull still succeeded, so this is a
        // sentence rather than an error — but an unqualified "records were
        // combined" over it would be a claim about data that was in fact
        // overwritten.
        const notCombined = mergeFailed?.length
            ? ` ${mergeFailed.length} could not be combined and took the downloaded copy ` +
              `(${mergeFailed.map((entry) => entry.label).join(', ')}).`
            : '';
        // A record whose local copy could not be READ kept that copy and did
        // not take the download at all — the opposite outcome to the line
        // above, and one the player has to be able to tell apart, because the
        // fix is different: this one says the database is unhealthy and the
        // downloaded entries are still waiting on the next pull.
        const heldBack = mergeHeld?.length
            ? ` ${mergeHeld.length} could not be read here and kept this device's copy ` +
              `(${mergeHeld.map((entry) => entry.label).join(', ')}); pull again once storage is healthy.`
            : '';
        // Not politeness: the stores this pull replaced stop accepting writes
        // until the reload (see `storage.finishRestore`), because anything this
        // session still holds in memory is the pre-pull copy and writing it
        // back would undo the pull. Saying so is the difference between a
        // reload the player chooses and changes they lose without being told.
        showToast(
            `Synced from GitHub.${combined}${notCombined}${heldBack} Reload now — changes made before ` +
                'reloading will not be kept.',
            { duration: 0, kind: notCombined || heldBack ? 'warn' : 'info' }
        );

        // The union only exists on this device until it is sent up. Pushing it
        // now is what stops the other device pulling the pre-merge copy back
        // and re-opening the same conflict. `_remember` above already recorded
        // the remote's stamp, so this push is no longer a "never synced" one
        // and will not stop to ask.
        if (pushBack) {
            const pushed = await this._doPush(false, opToken);
            return { ok: true, merged: merged?.length || 0, pushedBack: pushed?.ok === true };
        }

        return { ok: true, merged: merged?.length || 0 };
    }

    /**
     * Forget which gist this device uses, without touching the gist itself.
     * The next push discovers or creates one.
     * @returns {Promise<void>}
     */
    async forgetGist() {
        await rememberLocal({
            [KEY_GIST_ID]: null,
            [KEY_LAST_SYNCED_AT]: null,
            [KEY_LAST_HASH]: null,
            [KEY_CHUNK_COUNT]: 0,
            // The push stamp belongs to the gist we just forgot. Leaving it behind makes
            // the next gist look like somewhere this device has already pushed to, which
            // is exactly the check that decides whether a first push stops to ask.
            [KEY_LAST_PUSHED_AT]: null,
        });
    }

    /**
     * A one-line summary for the settings panel.
     * @returns {Promise<string>} Status text
     */
    async describeStatus() {
        if (!config.getSetting('sync_enabled', false)) return 'Sync is off.';
        if (!this._token()) return 'Sync is on, but no GitHub token is set.';
        const gistId = await storage.get(KEY_GIST_ID, STORE, null);
        const lastSyncedAt = await storage.get(KEY_LAST_SYNCED_AT, STORE, null);
        if (!gistId) return 'Ready. No gist yet — press Push to create one.';
        return lastSyncedAt ? `Last synced ${formatWhen(lastSyncedAt)}.` : 'Linked to a gist, not yet synced.';
    }

    /**
     * The token, trimmed. Never logged, never put in a URL, never returned to
     * anything outside this module.
     * @returns {string} Token, or empty string
     * @private
     */
    _token() {
        const raw = config.getSetting('sync_token', '');
        return typeof raw === 'string' ? raw.trim() : '';
    }

    /**
     * The sync passphrase, trimmed. Empty means "sync in the clear", which is
     * what every gist written before this setting existed is.
     * @returns {string} Passphrase, or empty string
     * @private
     */
    _passphrase() {
        const raw = config.getSetting('sync_passphrase', '');
        return typeof raw === 'string' ? raw.trim() : '';
    }

    /**
     * Start (or decline to start) the automatic schedule.
     * @private
     */
    _startAuto() {
        if (!config.getSetting('sync_auto', false) || !this.isConfigured()) return;

        for (const delay of STARTUP_PULL_DELAYS_MS) {
            this.timers.registerTimeout(
                setTimeout(() => {
                    this.pull({ silent: true });
                }, delay)
            );
        }

        this.timers.registerInterval(
            setInterval(() => {
                this.push({ silent: true });
            }, AUTO_PUSH_INTERVAL_MS)
        );

        // The other half of a two-device loop: the pushes above put changes up,
        // and this brings the other device's changes down while both stay open.
        // A silent pull is safe to run unattended — it applies only a clean
        // fast-forward (remote newer, nothing changed here) and stands down on
        // a conflict without asking.
        this.timers.registerTimeout(
            setTimeout(() => {
                this.timers.registerInterval(
                    setInterval(() => {
                        this.pull({ silent: true });
                    }, AUTO_PUSH_INTERVAL_MS)
                );
                this.pull({ silent: true });
            }, AUTO_PULL_OFFSET_MS)
        );
    }

    /**
     * Push the moment another login takes this session over.
     *
     * The game replaces the page with its connection banner when a second
     * device logs the character in; the socket is gone but GitHub is not, so
     * this is the last, best moment to hand the session's changes to the
     * device that just took over — whose own staggered startup pulls will
     * collect them seconds later. Once per banner: the flag rearms only after
     * the banner goes away (a reconnect), so a flickering connection does not
     * hammer the gist.
     * @private
     */
    _watchHandoff() {
        if (!config.getSetting('sync_onSwitch', false) || !this.isConfigured()) return;
        this.handoffUnregister = domObserver.onClass('SyncHandoff', 'GamePage_connectionMessage', () => {
            if (this.handoffPushed) return;
            if (!document.querySelector(GAME.CONNECTION_MESSAGE)) return;
            this.handoffPushed = true;
            this.push({ silent: true });
            // Rearm when the banner clears — checked lazily on the next appearance
            const rearm = setInterval(() => {
                if (!document.querySelector(GAME.CONNECTION_MESSAGE)) {
                    this.handoffPushed = false;
                    clearInterval(rearm);
                }
            }, 30 * 1000);
            this.timers.registerInterval(rearm);
        });
    }

    /**
     * The gist to use: the one this device remembers, else one already on the
     * account (which is how a second device finds the first one's gist from
     * nothing but the same token), else none.
     *
     * Null is the answer for "there isn't one", which `push` reads as "create
     * it" and `pull` reads as "nothing to read yet".
     *
     * @param {string} token - GitHub token
     * @returns {Promise<string|null>} Gist id, or null when the account has none
     * @private
     */
    async _resolveGistId(token) {
        const stored = await storage.get(KEY_GIST_ID, STORE, null);
        if (stored) return stored;

        const found = await findSyncGist(token);
        if (found) {
            await rememberLocal({ [KEY_GIST_ID]: found });
            return found;
        }

        return null;
    }

    /**
     * Record what this device now believes about the gist.
     * @param {{gistId: string, exportedAt: string, hash: string, chunkCount: number}} state - New state
     * @private
     */
    async _remember({ gistId, exportedAt, hash, chunkCount }) {
        await rememberLocal({
            [KEY_GIST_ID]: gistId,
            [KEY_LAST_SYNCED_AT]: exportedAt,
            [KEY_LAST_HASH]: hash,
            [KEY_CHUNK_COUNT]: chunkCount,
        });
    }

    /**
     * Guard, classify and report one sync operation.
     *
     * The `busy` lock is not politeness: two pushes racing can interleave chunk
     * writes and leave a gist whose manifest describes neither payload, and a
     * push racing a pull tears `buildPayloadJSON`, which reads the stores one
     * after another while the pull is rewriting them.
     *
     * It holds a token rather than `true` because of the takeover below. When a
     * wedged operation is taken over, the wedged one is still running — and its
     * own `finally` would clear a flag it no longer owns, unlocking mid-takeover
     * and admitting a third operation alongside the second. Each operation
     * clears the lock only if the token in it is still the one it took.
     *
     * @param {string} label - 'push' or 'pull', for messages
     * @param {boolean} silent - Suppress the "nothing to do" chatter
     * @param {Function} operation - The work
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    /**
     * Run a sync under a browser-wide lock, so tabs queue instead of racing.
     *
     * Four characters open is four tabs on the same interval pushing the same
     * gist, and GitHub answers the losers with 409s. The `busy` flag above is
     * per-tab; this is the cross-tab half, and it never waits: the lock is
     * taken only if free (a held lock is a sync running in another tab), and
     * Web Locks release on their own when a tab dies, so nothing can wedge it
     * open for ever. A takeover of a stuck same-tab sync bypasses this — the
     * stuck operation is the one holding the lock. No Web Locks API (an old
     * browser) runs unguarded, as before.
     *
     * @param {boolean} silent - Whether this is an interval sync nobody asked for
     * @param {Function} operation - What to run, called with this call's `busy` token
     * @param {number} opToken - This call's `busy` ownership token, forwarded to `operation`
     * @returns {Promise<*>} The operation's result, or a skipped outcome
     * @private
     */
    async _withCrossTabLock(silent, operation, opToken) {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
        if (typeof locks?.request !== 'function') return operation(opToken);

        let ran = false;
        let outcome;
        await locks.request('toolasha-sync', { ifAvailable: true }, async (lock) => {
            if (!lock) return;
            ran = true;
            outcome = await operation(opToken);
        });
        if (ran) return outcome;

        // Another tab's sync holds the lock right now. An interval tick has
        // nothing to add — the database is shared and the winner is pushing it
        // as we speak; the next tick re-checks. A push somebody clicked runs
        // anyway: it must not silently do nothing, and the 409 retry absorbs
        // the race it might lose.
        if (silent) return { ok: true, skipped: true, reason: 'another-tab' };
        return operation(opToken);
    }

    /**
     * Whether the `busy` lock this call took is still the one in effect.
     *
     * A takeover (see `_run`) does not stop the operation it replaces — it
     * cannot; there is nothing to cancel a hung request or a dialog nobody has
     * answered. It only stops *honouring* that operation's lock. The operation
     * itself is still running, and when it finally gets an answer — a user
     * clicking a conflict dialog they left open ten minutes ago, or a `fetch`
     * fallback's request finally resolving — it is about to act on a
     * database and a gist that have since moved on under a newer operation.
     * Every write that follows such a wait checks this first, so a superseded
     * operation stands down instead of overwriting what the takeover wrote.
     *
     * @param {number} opToken - The token this operation's `_run` call took
     * @returns {boolean} True while this operation still owns `busy`
     * @private
     */
    _stillOwns(opToken) {
        return this.busy === opToken;
    }

    /**
     * What a push or pull returns when it discovers, after a wait, that a
     * takeover has already run in its place.
     * @param {boolean} silent - Whether to say anything about it
     * @param {string} label - 'push' or 'pull'
     * @returns {{ok: boolean, skipped: boolean, reason: string}} Outcome
     * @private
     */
    _supersededResult(silent, label) {
        console.warn(`[Sync] A ${label} was superseded by a takeover while it was waiting; discarding its result.`);
        if (!silent) {
            showToast(
                `Sync ${label} was overtaken by a newer sync while it waited. Nothing was lost — try again if needed.`
            );
        }
        return { ok: true, skipped: true, reason: 'superseded' };
    }

    async _run(label, silent, operation) {
        if (!config.getSetting('sync_enabled', false)) {
            if (!silent) showToast('Cross-device sync is turned off.', { kind: 'warn' });
            return { ok: false, reason: 'disabled' };
        }
        if (!this._token()) {
            if (!silent) showToast('Add a GitHub token in Settings → Cross-Device Sync first.', { kind: 'warn' });
            return { ok: false, reason: 'no-token' };
        }
        let takingOver = false;
        if (this.busy) {
            // A sync that has been "running" this long is a wedged one — a
            // hung request or an abandoned dialog — and honouring its lock
            // forever is how auto-push died quietly for days. Take over.
            if (Date.now() - (this.busySince || 0) > BUSY_STUCK_MS) {
                console.warn(
                    `[Sync] A ${label} is taking over a sync stuck busy since ${new Date(this.busySince).toISOString()}.`
                );
                takingOver = true;
            } else {
                if (!silent) showToast('A sync is already running.', { kind: 'warn' });
                return { ok: false, reason: 'busy' };
            }
        }

        const token = (this._busySeq = (this._busySeq || 0) + 1);
        this.busy = token;
        this.busySince = Date.now();
        try {
            // A takeover skips the cross-tab lock: the wedged operation it is
            // replacing is the very thing still holding it
            return await (takingOver ? operation(token) : this._withCrossTabLock(silent, operation, token));
        } catch (error) {
            // GistError messages are written to be shown; anything else is a bug
            // here and gets a generic message with the detail in the console.
            // Neither path can carry the token: it only ever appears in a header.
            if (error instanceof GistError) {
                console.warn(`[Sync] ${label} failed (${error.kind})`, error.githubMessage || '');
                if (error.kind === 'not-found') await this.forgetGist();
                showToast(describeFailure(label, error), {
                    kind: error.kind === 'rate-limit' ? 'warn' : 'error',
                    // A failure the player has to act on must not fade before
                    // they have read what to do about it
                    duration: ACTIONABLE_KINDS.has(error.kind) ? 0 : undefined,
                });
            } else {
                console.error(`[Sync] ${label} failed:`, error);
                showToast(
                    `Sync ${label} failed: ${error?.message || 'unexpected error'}. Try again; if it keeps ` +
                        'happening, reload the page — the console has the detail.',
                    { kind: 'error' }
                );
            }
            return { ok: false, reason: error instanceof GistError ? error.kind : 'error' };
        } finally {
            // Only if nobody took over: the wedged operation this one replaced
            // may still be in flight, and its `finally` must not unlock ours
            if (this.busy === token) this.busy = false;
        }
    }
}

/**
 * What to do about each kind of failure.
 *
 * `GistError.message` already says what went wrong, and for the two failures
 * that resolve themselves — a rate limit, a dead network — it also says when to
 * come back, so those get nothing added. The rest need a next step, because a
 * toast that says only "GitHub rejected the token" leaves the reader with no
 * idea that the token is a text box two clicks away.
 */
const REMEDIES = {
    auth: 'Check the token in Settings → Cross-Device Sync — it needs the "gist" scope.',
    'not-found': 'This device has forgotten that gist; press Push to make a new one.',
    'too-large': 'Set Sync scope to "Settings only" in Settings → Cross-Device Sync.',
    passphrase: 'Enter the same sync passphrase in Settings → Cross-Device Sync on every device that shares the gist.',
    parse: 'Push from a device whose data is good to replace what is in the gist.',
    http: 'Try again shortly; githubstatus.com says whether GitHub itself is unwell.',
};

/** Failures the player has to do something about, so their toast stays up */
const ACTIONABLE_KINDS = new Set(Object.keys(REMEDIES));

/**
 * One line saying which half of sync failed, why, and what to do about it.
 * @param {string} label - 'push' or 'pull'
 * @param {GistError} error - The classified failure
 * @returns {string} Toast text
 */
function describeFailure(label, error) {
    const remedy = REMEDIES[error.kind];
    return `Sync ${label} failed: ${error.message}${remedy ? ` ${remedy}` : ''}`;
}

/**
 * Write this device's sync bookkeeping.
 *
 * Through `putAll` rather than `set`, for one reason: applying a pull latches
 * the stores it replaced against pre-restore writes (see
 * `storage.finishRestore`), and the settings store is always one of them. This
 * bookkeeping is written *after* the apply and is not pre-restore state — it is
 * the record that the apply happened — so it goes down the bulk path and says
 * so explicitly with `bypassRestoreLatch`. Written through `set` it would be
 * silently refused, and a pull that cannot record its own stamp re-applies the
 * same payload for ever. The flag is deliberate rather than inherited: the bulk
 * path is latched like every other write now, because the recorders that hold a
 * store in memory flush through it too.
 *
 * One transaction for the lot is also simply what these four keys want.
 *
 * @param {Record<string, *>} entries - Bookkeeping keys to write
 * @returns {Promise<void>}
 */
async function rememberLocal(entries) {
    const written = await storage.putAll(STORE, entries, { bypassRestoreLatch: true });
    const expected = Object.keys(entries).length;
    if (written !== expected) {
        console.error(`[Sync] Only ${written}/${expected} sync bookkeeping keys were written`);
    }
}

/**
 * Check a reassembled payload against what the manifest says it should be.
 *
 * The manifest already carries the plaintext length and a content hash, and
 * nothing was checking either — so a chunk file truncated by a hand edit, a
 * half-written push, or a gist the API returned short would be parsed as far as
 * it went and applied. A pull that fails loudly is recoverable; a pull that
 * applies half a database is not.
 *
 * Both fields are optional: a gist written by a build from before they existed
 * has neither, and must still read. `hash` is accepted in either of the two
 * forms this script has written — the content hash, and the older raw-text hash
 * that included the `exportedAt` stamp.
 *
 * @param {Object} manifest - The gist's manifest
 * @param {string} payload - The decrypted, decompressed payload text
 * @returns {void}
 * @throws {GistError} With kind 'parse' when the payload is not what was pushed
 */
function verifyAgainstManifest(manifest, payload) {
    const expectedBytes = Number(manifest?.bytes);
    if (Number.isFinite(expectedBytes) && expectedBytes > 0 && payload.length !== expectedBytes) {
        throw new GistError(
            'parse',
            `The sync gist is incomplete: its manifest describes ${expectedBytes} characters but ` +
                `${payload.length} came back.`
        );
    }

    const expectedHash = manifest?.hash;
    if (typeof expectedHash === 'string' && expectedHash) {
        if (contentHash(payload) !== expectedHash && hashPayload(payload) !== expectedHash) {
            throw new GistError(
                'parse',
                'The sync gist does not match its own manifest checksum — it looks corrupted or edited by hand.'
            );
        }
    }
}

/**
 * Is `candidate` strictly after `reference`? An absent reference counts as
 * "never synced", so anything at all is newer.
 * @param {string|null} candidate - ISO timestamp
 * @param {string|null} reference - ISO timestamp
 * @returns {boolean} True when candidate wins
 */
function isNewer(candidate, reference) {
    if (!candidate) return false;
    if (!reference) return true;
    const a = Date.parse(candidate);
    const b = Date.parse(reference);
    if (!Number.isFinite(a)) return false;
    if (!Number.isFinite(b)) return true;
    return a > b;
}

/**
 * A timestamp a person can read.
 * @param {string|null} iso - ISO timestamp
 * @returns {string} Local string, or 'unknown'
 */
function formatWhen(iso) {
    if (!iso) return 'unknown';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

const syncManager = new SyncManager();
export default syncManager;
export { SyncManager, isNewer };
