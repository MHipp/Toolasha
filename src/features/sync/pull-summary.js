/**
 * What a pull actually reconciled.
 *
 * A pull writes a downloaded payload over this device's stores, folding the
 * records that own a merge registration and taking the rest whole. Until now
 * the only thing said about it was a sentence counting the folds — so a player
 * whose watchlist came back different, or whose history did not, had no way to
 * ask which records the pull touched and how.
 *
 * Everything here is derived from what `applyPayload` already returned. There
 * is deliberately no second pass over storage: re-reading every key to diff it
 * against what was just written would double the cost of the one operation in
 * this script that already reads the whole database, and it would be reading
 * *after* the write, so it could not answer "what changed" anyway.
 *
 * That bounds what can be reported, and the bound is stated rather than papered
 * over. Per store the pull result carries the keys that were folded, the keys
 * held back because the local copy could not be read, the keys whose fold threw,
 * and how many keys the store was asked to write. Written-whole is the
 * difference. **Unchanged is not derivable at all** — a key written whole with
 * byte-identical content is indistinguishable from one that moved, and keys the
 * payload never mentioned are not in the result — so it is reported as unknown,
 * never as zero.
 *
 * The summary lives in memory for the session and nowhere else. It is a
 * diagnostic about one operation, not a record of the account, and it belongs to
 * the device rather than the character — a switch clears it (see
 * `sync-manager.js#initialize`).
 */

/**
 * Why the unchanged count is missing, in the words the panel prints.
 *
 * Named rather than inlined so the panel and any caller that renders the
 * summary as text say the same thing about the same gap.
 */
export const UNCHANGED_UNKNOWN = 'not derivable — a pull result does not say which whole writes changed anything';

/** The last pull's summary, for this session only. Never persisted. */
let lastSummary = null;

/**
 * @typedef {Object} PullStoreSummary
 * @property {string} store - Object store name
 * @property {number} combined - Records a registered merge folded
 * @property {number|null} writtenWhole - Records written whole, or null when the store's
 *   expected count did not come back (an unknown store the import skipped)
 * @property {number} held - Records kept because this device's copy could not be read
 * @property {number} overwritten - Records whose fold threw and took the download whole
 * @property {null} unchanged - Always null; see {@link UNCHANGED_UNKNOWN}
 * @property {Array<{key: string, label: string}>} combinedRecords - Folded keys and their registration
 * @property {Array<{key: string, label: string}>} heldRecords - Held keys and their registration
 * @property {Array<{key: string, label: string}>} overwrittenRecords - Failed folds and their registration
 */

/**
 * Roll a pull result up into what the toast and the panel draw.
 *
 * Tolerant of a partial result on purpose: a pull that reported nothing about a
 * store still has to produce a summary, and the missing figure is reported as
 * unknown rather than guessed at.
 *
 * @param {Object} [result] - What `applyPayload` returned
 * @param {Array<{store: string, key: string, label: string}>} [result.merged] - Folded records
 * @param {Array<{store: string, key: string, label: string}>} [result.mergeFailed] - Folds that threw
 * @param {Array<{store: string, key: string, label: string}>} [result.mergeHeld] - Records held back
 * @param {Record<string, number>} [result.expected] - Keys each store was asked to write
 * @param {string|null} [result.at] - When the pull landed, ISO
 * @returns {{at: string|null, combined: number, writtenWhole: number, writtenWholePartial: boolean,
 *   held: number, overwritten: number, unchanged: null, stores: Array<PullStoreSummary>}}
 */
export function buildPullSummary({ merged = [], mergeFailed = [], mergeHeld = [], expected = {}, at = null } = {}) {
    const rows = new Map();
    /**
     * @param {string} store - Store name
     * @returns {PullStoreSummary}
     */
    const row = (store) => {
        if (!rows.has(store)) {
            rows.set(store, {
                store,
                combined: 0,
                writtenWhole: null,
                held: 0,
                overwritten: 0,
                unchanged: null,
                combinedRecords: [],
                heldRecords: [],
                overwrittenRecords: [],
            });
        }
        return rows.get(store);
    };

    for (const entry of merged || []) {
        if (!entry?.store) continue;
        const store = row(entry.store);
        store.combined += 1;
        store.combinedRecords.push({ key: entry.key, label: entry.label || '' });
    }
    for (const entry of mergeHeld || []) {
        if (!entry?.store) continue;
        const store = row(entry.store);
        store.held += 1;
        store.heldRecords.push({ key: entry.key, label: entry.label || '' });
    }
    for (const entry of mergeFailed || []) {
        if (!entry?.store) continue;
        const store = row(entry.store);
        store.overwritten += 1;
        store.overwrittenRecords.push({ key: entry.key, label: entry.label || '' });
    }

    // A held key was deleted from the payload before the import, so it is not in
    // the expected count; a failed fold was written whole, so it is. What is
    // left after the folds is therefore exactly the whole writes.
    for (const [store, count] of Object.entries(expected || {})) {
        if (!Number.isFinite(count)) continue;
        const target = row(store);
        target.writtenWhole = Math.max(0, count - target.combined);
    }

    const stores = [...rows.values()].sort((a, b) => a.store.localeCompare(b.store));
    const sum = (pick) => stores.reduce((total, store) => total + pick(store), 0);

    return {
        at,
        combined: sum((store) => store.combined),
        writtenWhole: sum((store) => store.writtenWhole ?? 0),
        // True when at least one store never reported an expected count, so the
        // whole-write total is a floor rather than the figure
        writtenWholePartial: stores.some((store) => store.writtenWhole === null),
        held: sum((store) => store.held),
        overwritten: sum((store) => store.overwritten),
        unchanged: null,
        stores,
    };
}

/**
 * @param {number} count - How many
 * @param {string} word - Singular
 * @returns {string} `1 record` / `2 records`
 */
function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The one line the pull toast carries.
 *
 * Only the outcomes that happened are named: a pull with nothing held should
 * not spend a clause saying so, and a zero next to "held unreadable" reads as a
 * warning that did not fire rather than as an absence.
 *
 * @param {Object|null} summary - From {@link buildPullSummary}
 * @returns {string} A sentence, or '' when there is no summary
 */
export function formatPullSummaryLine(summary) {
    if (!summary) return '';

    const parts = [];
    if (summary.combined > 0) parts.push(`${plural(summary.combined, 'record')} combined`);
    if (summary.writtenWhole > 0) {
        parts.push(`${summary.writtenWholePartial ? 'at least ' : ''}${summary.writtenWhole} written whole`);
    }
    if (summary.held > 0) parts.push(`${summary.held} held unreadable`);

    return parts.length ? `Pull applied: ${parts.join(', ')}.` : 'Pull applied: no records changed.';
}

/**
 * One store's counts, for the panel and for anything rendering the summary as text.
 *
 * @param {PullStoreSummary} store - One row of the summary
 * @returns {string} e.g. `settings: 1 combined, 3 written whole, 1 held, unchanged unknown`
 */
export function formatPullStoreLine(store) {
    if (!store) return '';
    const parts = [`${store.combined} combined`];
    parts.push(store.writtenWhole === null ? 'written whole unknown' : `${store.writtenWhole} written whole`);
    parts.push(`${store.held} held`);
    if (store.overwritten > 0) parts.push(`${store.overwritten} overwritten`);
    parts.push('unchanged unknown');
    return `${store.store}: ${parts.join(', ')}`;
}

/**
 * Keep this pull's summary until the next one, or until the character changes.
 * @param {Object|null} summary - From {@link buildPullSummary}
 * @returns {void}
 */
export function rememberPullSummary(summary) {
    lastSummary = summary || null;
}

/**
 * @returns {Object|null} The last pull's summary this session, or null
 */
export function lastPullSummary() {
    return lastSummary;
}

/**
 * Forget it. Called on a character switch: the summary describes what this
 * device downloaded, and carrying it across a switch would attach one
 * character's pull to another character's screen.
 * @returns {void}
 */
export function clearPullSummary() {
    lastSummary = null;
}

export default {
    UNCHANGED_UNKNOWN,
    buildPullSummary,
    formatPullSummaryLine,
    formatPullStoreLine,
    rememberPullSummary,
    lastPullSummary,
    clearPullSummary,
};
