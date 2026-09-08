/**
 * Records a Reset can empty, kept so the Reset survives a sync pull.
 *
 * A record that only ever gains entries folds by union, and a union cannot
 * express "the user threw this away". Emptying such a record locally is
 * therefore undone the moment anything merges: `sync-payload.js` hands the
 * fold the local copy and the remote one, only the pulling device merges, and
 * the peer's still-full copy wins — so an emptied record comes straight back,
 * and comes back to the device that emptied it on the next pull.
 *
 * Per-entry tombstones are the wrong shape for a button that clears the whole
 * record: there is nothing to name. What a whole-record clear has instead is a
 * moment. A single `clearedAt` epoch stored beside the entries, unioned as a
 * max, is enough for the fold to drop every entry recorded before it — and,
 * because it is compared against each entry's own timestamp, it leaves alone
 * the entries the other device recorded *after* the clear. That ordering
 * hazard is the reason the epoch is the right shape and a boolean is not.
 *
 * The stored shape is `{ clearedAt, entries }`. A bare array is what every one
 * of these records held before, and reads as an uncleared record.
 */

/**
 * How many entries one fold may drop on a clear the local side does not hold.
 *
 * The mass-delete refusal from `custom-tabs-data.js`, in epoch form: a fold
 * must never be the thing that empties a record the user did not just clear.
 * The clear arrives from a store or a peer that may be wrong about it, and a
 * hundred-odd sessions of history disappearing during a pull is worse than a
 * Reset that has to be pressed again on this device — the clear still stands
 * where it was pressed, because that side holds the epoch and is exempt.
 *
 * A hundred is above the whole capacity of the small ring-capped records this
 * wraps (the replay check keeps 24 observations and 8 checks), so for those the
 * refusal cannot fire and the clear always lands: those records are a handful
 * of rows about recent runs, and losing them to a button pressed on another
 * device is the outcome the user asked for. It is below the labyrinth fight
 * pool's cap of a thousand, which is the record worth protecting — it is
 * passively accumulated over many runs and cannot be rebuilt on demand.
 */
export const CLEAR_FOLD_LIMIT = 100;

/**
 * The entries of a record in either shape.
 * @param {*} value - A stored record, or the bare array it used to be
 * @returns {Array<Object>} The entries, empty when there are none
 */
export function entriesOf(value) {
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.entries) ? value.entries : [];
}

/**
 * When a record was last cleared.
 * @param {*} value - A stored record, or the bare array it used to be
 * @returns {number} Epoch milliseconds, or 0 for a record no clear has touched
 */
export function clearedAtOf(value) {
    if (Array.isArray(value)) return 0;
    return Number(value?.clearedAt) || 0;
}

/**
 * A record in the stored shape.
 * @param {Array<Object>} [entries] - The entries
 * @param {number} [clearedAt] - The clear epoch to carry
 * @returns {{clearedAt: number, entries: Array<Object>}}
 */
export function clearedRecord(entries = [], clearedAt = 0) {
    return { clearedAt: Number(clearedAt) || 0, entries: Array.isArray(entries) ? entries : [] };
}

/**
 * Wrap a list fold so a whole-record clear survives it.
 *
 * The union runs exactly as it did; what is new is that entries older than the
 * newer of the two clear epochs are dropped afterwards, and the epoch is
 * carried on the result so the next fold — on this device or another — knows
 * about the clear too.
 *
 * `base` must be **this device's** copy and `fresh` the other one. Both callers
 * are that way round: `persisted-record.js` folds the stored copy under memory,
 * and a sync pull folds the local base under the remote copy. It is what the
 * refusal tests — a clear the local side already holds is one this device made
 * or already took, and always applies.
 *
 * @param {Function} merge - The existing `(base, fresh) => Array` union
 * @param {Function} timeOf - `(entry) => number`, when the entry was recorded
 * @param {Object} [options]
 * @param {number} [options.limit] - See {@link CLEAR_FOLD_LIMIT}
 * @param {string} [options.label] - Named in the refusal warning
 * @returns {Function} `(base, fresh) => {clearedAt, entries}`
 */
export function mergeClearable(merge, timeOf, { limit = CLEAR_FOLD_LIMIT, label = 'record' } = {}) {
    return (base, fresh) => {
        const ours = clearedAtOf(base);
        const theirs = clearedAtOf(fresh);
        const merged = merge(entriesOf(base), entriesOf(fresh)) || [];

        const apply = (at) => (at > 0 ? merged.filter((entry) => (Number(timeOf(entry)) || 0) > at) : merged);
        const newest = Math.max(ours, theirs);
        const kept = apply(newest);

        // Held back rather than half-applied: the epoch is not carried either,
        // so the next fold does not silently finish what this one refused.
        if (ours < theirs && merged.length - kept.length > limit) {
            console.warn(
                `[ClearedRecord] Refusing a fold that would drop ${merged.length - kept.length} ${label} entries ` +
                    'at once on a clear this device did not make; every entry is kept. Reset here to clear them.'
            );
            return clearedRecord(apply(ours), ours);
        }
        return clearedRecord(kept, newest);
    };
}

/**
 * Empty a persisted record and stamp the clear on it.
 *
 * What `record.clear()` does, plus the epoch — which is the whole difference
 * between a Reset that holds and one a peer restores on the next pull.
 *
 * @param {Object} record - From `createPersistedRecord`
 * @param {number} [clearedAt] - The moment to stamp; injectable for tests
 * @returns {Promise<boolean>} Whether the write landed
 */
export function clearRecord(record, clearedAt = Date.now()) {
    record.set(clearedRecord([], clearedAt));
    return record.save({ overwrite: true });
}
