/**
 * What gets uploaded, and what must never be.
 *
 * The payload is deliberately the same shape as a full backup
 * (`utils/full-backup.js`) — `{formatVersion, exportedAt, stores}` — so a gist
 * can be downloaded by hand and fed straight into "Restore Backup", and so the
 * restore path is `importEverything()` rather than a second, subtly different
 * importer that has to be kept in step with it.
 *
 * It is built here rather than by calling `exportEverythingJSON()` for one
 * reason: redaction. The GitHub token is a setting, settings live in the
 * `settings` store, and both sync scopes include that store — so an unmodified
 * full backup would upload the token to the very service it authenticates
 * against, where a second device would then download and store it. The token,
 * and the device-local sync bookkeeping, are stripped on the way out.
 *
 * Like the full backup this serializes one store at a time and releases each
 * before reading the next, so peak memory is the finished text plus one store
 * rather than the whole database twice over.
 */

import storage from '../../core/storage.js';
import { importEverything, stripExcludedKeys } from '../../utils/full-backup.js';
import { mergeForKey } from '../../utils/sync-merge-registry.js';

/** Matches the full-backup format, because that is what this produces */
const FORMAT_VERSION = 1;

/** The store holding settings, and the only store a `settings` scope carries */
const SETTINGS_STORE = 'settings';

/**
 * Setting IDs removed from every payload.
 *
 * The token is a credential for the transport itself; uploading it would put a
 * gist-scoped GitHub credential inside a gist, and pulling would silently plant
 * it on another machine. The passphrase is the key to the payload's own
 * encryption; uploading it — even inside the ciphertext it unlocks — would be
 * circular, and pulling must never overwrite the one thing that made the pull
 * readable.
 */
export const REDACTED_SETTING_IDS = ['sync_token', 'sync_passphrase'];

/**
 * Storage keys removed from every payload.
 *
 * Which gist and how far this device has got with it are facts about the
 * device, not about the account. Syncing them would have each pull overwrite the
 * receiving device's idea of what it had already seen, which is exactly the
 * state conflict detection depends on.
 *
 * `toolasha_local_` is a different kind of never: not bookkeeping that would
 * confuse another device, but data that must not be published at all. The
 * preserved chat history under it
 * (`features/chat/chat-history-persistence.js`) is every tab's markup,
 * whispers and private messages included — stored on disk by the maintainer's
 * explicit choice, and a gist is not disk. Anything else that must stay on the
 * machine that wrote it belongs under this prefix too.
 *
 * Both prefixes are honoured on the way out (`redactSettingsStore`) and on the
 * way in (`applyPayload`), so a payload written by an older build that did not
 * strip them cannot plant one either.
 */
export const LOCAL_ONLY_KEY_PREFIXES = ['toolasha_sync_', 'toolasha_local_'];

/**
 * Strip credentials and device-local bookkeeping from a settings-store dump.
 *
 * Returns a new object; the input is not mutated, because it is a live read of
 * the user's storage and quietly editing it would delete their token.
 *
 * @param {Record<string, *>} entries - Raw settings store contents
 * @returns {Record<string, *>} Safe-to-upload copy
 */
export function redactSettingsStore(entries) {
    const safe = {};

    for (const [key, value] of Object.entries(entries || {})) {
        if (LOCAL_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;

        // The settings map is one key whose value is every setting; the token
        // is an entry inside it, not a key of its own
        if (!key.startsWith('script_settingsMap')) {
            safe[key] = value;
            continue;
        }

        const wasString = typeof value === 'string';
        let map = value;
        if (wasString) {
            try {
                map = JSON.parse(value);
            } catch {
                // Unparseable settings map: pass it through rather than drop it,
                // and accept that we cannot prove it is token-free
                safe[key] = value;
                continue;
            }
        }

        if (!map || typeof map !== 'object') {
            safe[key] = value;
            continue;
        }

        const cleaned = { ...map };
        for (const settingId of REDACTED_SETTING_IDS) delete cleaned[settingId];
        safe[key] = wasString ? JSON.stringify(cleaned) : cleaned;
    }

    return safe;
}

/**
 * Build the JSON text to upload.
 *
 * @param {'settings'|'everything'} scope - How much to carry
 * @returns {Promise<string>} Payload text, in full-backup format
 */
export async function buildPayloadJSON(scope = 'settings') {
    const allStores = await storage.listStores();
    const storeNames = scope === 'everything' ? allStores : allStores.filter((name) => name === SETTINGS_STORE);

    const parts = [
        `{"formatVersion":${FORMAT_VERSION},`,
        `"exportedAt":${JSON.stringify(new Date().toISOString())},`,
        `"syncScope":${JSON.stringify(scope)},`,
        '"stores":{',
    ];

    let first = true;
    for (const storeName of storeNames) {
        const entries = stripExcludedKeys(storeName, await storage.getAll(storeName));
        const safe = storeName === SETTINGS_STORE ? redactSettingsStore(entries) : entries;
        parts.push(`${first ? '' : ','}${JSON.stringify(storeName)}:${JSON.stringify(safe)}`);
        first = false;
    }

    parts.push('}}');
    return parts.join('');
}

/**
 * Fold this device's histories into an incoming payload, key by key.
 *
 * Everything `importEverything` writes, it writes whole — which for a history
 * that both devices added to means the loser's additions are gone. Every such
 * record already owns a fold (it needs one for two tabs on one machine); the
 * owning feature declares it through `utils/sync-merge-registry.js`, and this
 * is where a pull consults it.
 *
 * The payload value is *replaced* with the fold rather than written separately,
 * so the import that follows is still one transaction per store and there is
 * still exactly one writer.
 *
 * A key with no registration, or one this device has never stored, is left as
 * it came down — nothing to combine, so the whole-key write is correct.
 *
 * A key whose local value cannot be *read* is a different case, and the one
 * that has to be got right: `storage.tryGet` answers `null` for a read that
 * failed and `{found: false}` for a key that is simply not here, and treating
 * them alike meant an aborted read handed the record straight to the whole-key
 * write — this device's entries destroyed by the exact failure that made them
 * invisible, with nothing said about it. So the key is *dropped from the
 * payload* instead: whatever is on disk stays, and the caller is told, because
 * the record it names did not get the downloaded copy.
 *
 * The caller must have quiesced writers first. `storage.tryGet` reads
 * IndexedDB, and `storage.set` debounces for three seconds — so a base read
 * while writes are still queued omits everything recorded in that window,
 * `importEverything` flushes the queue on its way in, and the union computed
 * from the stale base is then written straight back over the entry that just
 * landed. See {@link applyPayload}.
 *
 * A merge that throws is not fatal to the pull — the key falls back to the
 * whole-key write it would have had anyway — but it is not nothing either: this
 * device's entries for that record are the ones being discarded, and a pull that
 * reports plain success over it tells the player their histories were combined
 * when one of them was overwritten. So the failures come back beside the
 * successes, for the caller to say so.
 *
 * @param {Object} payload - Parsed payload; its store values are mutated in place
 * @returns {Promise<{merged: Array<{store: string, key: string, label: string}>,
 *   failed: Array<{store: string, key: string, label: string}>,
 *   held: Array<{store: string, key: string, label: string}>}>} What was combined, what took
 *   the remote copy anyway, and what was held back because the local copy could not be read
 */
async function mergeLocalHistories(payload) {
    const merged = [];
    const failed = [];
    const held = [];

    for (const [storeName, entries] of Object.entries(payload?.stores || {})) {
        if (!entries || typeof entries !== 'object') continue;

        // Keys captured up front: an unreadable base deletes its own key below
        for (const key of Object.keys(entries)) {
            const registration = mergeForKey(storeName, key);
            if (!registration) continue;

            try {
                const probed = await storage.tryGet(key, storeName);
                if (probed === null) {
                    // Read failed — not "nothing stored". This device may hold
                    // entries the union would have kept, and they are exactly
                    // what a whole-key write would destroy. Hold the download
                    // back rather than overwrite a base we could not see.
                    console.error(`[Sync] ${storeName}/${key} could not be read; keeping this device's copy.`);
                    delete entries[key];
                    held.push({ store: storeName, key, label: registration.label });
                    continue;
                }
                if (!probed.found || probed.value == null) continue;
                entries[key] = registration.merge(probed.value, entries[key]);
                merged.push({ store: storeName, key, label: registration.label });
            } catch (error) {
                console.error(`[Sync] Merging ${storeName}/${key} failed; taking the remote copy:`, error);
                failed.push({ store: storeName, key, label: registration.label });
            }
        }
    }

    return { merged, failed, held };
}

/**
 * Write a downloaded payload into local storage.
 *
 * The local token is never overwritten — it was redacted before upload, so a
 * payload cannot carry one, and `importEverything` writes whole keys. The
 * settings map is one such key, so the incoming map is merged over the local one
 * with the local token put back, rather than replacing it wholesale and leaving
 * this device unable to sync again.
 *
 * Additive histories are combined rather than replaced, always — see
 * {@link mergeLocalHistories}. A record that can only gain entries has no
 * reading of "apply the remote copy" under which discarding this device's
 * entries is what the user meant, so there is no option to; the pull's only
 * real choice is what happens to the records that *can't* be combined, and
 * those still take the remote wholesale.
 *
 * @param {string} json - Payload text as produced by `buildPayloadJSON()`
 * @returns {Promise<{restored: Record<string, number>, expected: Record<string, number>,
 *   failed: Array<Object>, complete: boolean, merged: Array<Object>, mergeFailed: Array<Object>,
 *   mergeHeld: Array<Object>, exportedAt: string|null, applied: string}>}
 *   What landed, how many keys each store was asked for (the figure the pull summary
 *   subtracts the folds from), whether all of it did, which records could not be
 *   combined, which were held back because this device's copy could not be read, and
 *   the payload text as actually applied
 */
export async function applyPayload(json) {
    const payload = JSON.parse(json);
    const settingsStore = payload?.stores?.[SETTINGS_STORE];

    if (settingsStore) {
        const local = await storage.getAll(SETTINGS_STORE);
        for (const [key, incoming] of Object.entries(settingsStore)) {
            if (!key.startsWith('script_settingsMap')) continue;
            settingsStore[key] = preserveLocalSecrets(local[key], incoming);
        }
        // Device-local bookkeeping is never taken from a payload, even one
        // written by an older build that did not redact it
        for (const key of Object.keys(settingsStore)) {
            if (LOCAL_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) delete settingsStore[key];
        }
    }

    // Land the debounce queue BEFORE reading merge bases, not on the way into
    // `importEverything`. A history writes through `storage.set`, which holds
    // the value for three seconds; `mergeLocalHistories` reads through
    // `storage.tryGet`, which goes to IndexedDB and cannot see it. Flushing
    // afterwards — which is what `importEverything` does — makes the queued
    // value land and then be overwritten by a union computed without it, so a
    // pull arriving in the seconds after a kill, a fill or an XP sample threw
    // exactly those entries away. Flushing here makes the base current; the
    // flush inside `importEverything` then finds nothing left to do.
    await storage.beginRestore?.();

    try {
        const { merged, failed: mergeFailed, held: mergeHeld } = await mergeLocalHistories(payload);

        // What is remembered as "the state of this device" has to be what was
        // actually written. `mergeLocalHistories` (and the settings fix-ups
        // above) mutate the payload, so the downloaded text no longer describes
        // what landed — hashing it made every later rebuild compare unequal,
        // which read as "this device has changed" and raised a conflict on
        // every silent pull until an auto-push happened to reset it.
        // Re-serialising only when something was rewritten keeps the common
        // no-op pull free.
        const rewrote = merged.length > 0 || mergeHeld.length > 0 || Boolean(settingsStore);
        const applied = rewrote ? JSON.stringify(payload) : json;

        const { restored, expected, failed, complete } = await importEverything(payload);
        return {
            restored,
            expected,
            failed,
            complete,
            merged,
            mergeFailed,
            mergeHeld,
            exportedAt: payload?.exportedAt ?? null,
            applied,
        };
    } finally {
        // `importEverything` ends the hold itself on its way out; this covers
        // a throw between the flush above and reaching it, which would
        // otherwise leave every debounced write in the script held until the
        // unload flush. Ending an already-ended hold is a no-op.
        await storage.endRestore?.();
    }
}

/**
 * Fold an incoming settings map onto this device's, entry by entry.
 *
 * A settings map is a per-setting structure, not one record: taking the
 * incoming map whole meant every setting the *local* map had and the incoming
 * one did not was erased. That is not "the remote's choice wins" — the remote
 * expressed no choice. It happens whenever the two devices are on different
 * builds (the newer one's settings are simply absent from the older one's
 * saved map, which is written whole from whatever schema wrote it), and the
 * erased entries came back as shipped defaults on the next load, so settings
 * the player had turned off turned themselves back on after a pull.
 *
 * Per setting the incoming value still wins outright, which is the whole of
 * what the conflict dialog promises about settings. Only the entries the
 * payload says nothing about are kept.
 *
 * The redacted ids are the one exception in the other direction: they were
 * stripped before upload, so an incoming map either lacks them or carries some
 * other device's copy, and this device's own token and passphrase must survive
 * either way.
 *
 * @param {*} localValue - The settings map already on this device
 * @param {*} incomingValue - The settings map from the payload
 * @returns {*} Merged map, in whatever form the incoming value used
 */
function preserveLocalSecrets(localValue, incomingValue) {
    const wasString = typeof incomingValue === 'string';
    const parse = (value) => {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    };

    const incoming = parse(incomingValue);
    const local = parse(localValue);
    if (!incoming || typeof incoming !== 'object') return incomingValue;

    const merged = local && typeof local === 'object' ? { ...local, ...incoming } : { ...incoming };
    for (const settingId of REDACTED_SETTING_IDS) {
        if (local && typeof local === 'object' && local[settingId] !== undefined) {
            merged[settingId] = local[settingId];
        }
    }

    return wasString ? JSON.stringify(merged) : merged;
}

/**
 * A cheap content fingerprint, used to answer "has anything changed since the
 * last push?" without keeping a second copy of the payload around.
 *
 * FNV-1a: not a cryptographic hash and not meant to be. The consequence of a
 * collision is one skipped auto-push, which the next interval corrects.
 *
 * @param {string} text - Text to fingerprint
 * @returns {string} Hex digest
 */
export function hashPayload(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        // FNV prime, via shifts so the multiply stays in 32-bit range
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Hash a payload by its CONTENT, ignoring the `exportedAt` stamp.
 *
 * The payload text embeds the moment it was built, so hashing the raw text
 * makes every build look different: the auto-push's "unchanged, skip" never
 * fired, and worse, the hash remembered after a pull (the remote text, with
 * the remote's stamp) could never equal a local rebuild — so every later pull
 * read "this device has changed", raised the conflict dialog even from the
 * silent startup pull, and the unanswered modal held the sync busy for days.
 *
 * @param {string} text - Payload text as produced by `buildPayloadJSON()`
 * @returns {string} Hash of the payload with its `exportedAt` removed
 */
export function contentHash(text) {
    return hashPayload(String(text).replace(/"exportedAt":"[^"]*",/, ''));
}

/**
 * The `exportedAt` of a payload without parsing the whole thing.
 *
 * A full-scope payload can be megabytes; `JSON.parse` on it just to read one
 * timestamp is the sort of thing that makes a startup check feel like a freeze.
 *
 * @param {string} json - Payload text
 * @returns {string|null} ISO timestamp, or null when it is not there
 */
export function readExportedAt(json) {
    const match = /"exportedAt"\s*:\s*"([^"]+)"/.exec(json.slice(0, 512));
    return match ? match[1] : null;
}

export default {
    buildPayloadJSON,
    applyPayload,
    hashPayload,
    readExportedAt,
    redactSettingsStore,
};
