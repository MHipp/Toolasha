/**
 * One ledger of who has already claimed what is in the bag.
 *
 * Every planning feature in this script computes its shortfall the same way and
 * on its own: what the plan needs, minus what the inventory holds. Each of them
 * is right in isolation and the set of them is wrong together — two plans that
 * each need 500 logs both read the same 500 logs as theirs, both report nothing
 * missing, and the second one discovers the truth when the first has already
 * spent them. Nothing in the script had a place to write down "these 500 are
 * spoken for", so nothing could.
 *
 * This is that place. A feature `reserve()`s the lines its current plan needs
 * under an owner id of its own, and asks `effectiveInventory()` for what is left
 * once *everyone else's* claims come off — never its own, or a plan would
 * subtract itself from itself and grow a shortfall on every recompute.
 *
 * ## What a reservation is
 *
 * A claim, not a counter. `reserve(owner, lines)` REPLACES that owner's lines
 * rather than adding to them, because a plan has one current need and the point
 * is what it wants now, not the sum of everything it has ever wanted. That is
 * also what makes the sync fold below newer-`updatedAt`-wins per owner rather
 * than a union of counts: two devices holding one plan hold two versions of one
 * claim, and the later version is the claim.
 *
 * ## When it does nothing
 *
 * The `inventoryReservations` setting is off by default, and off means off at
 * the seam rather than in each consumer: `effectiveInventory()` answers the
 * held count untouched, `reservedElsewhere()` answers zero, and `reserve()`
 * writes nothing at all. A consumer therefore behaves exactly as it did before
 * this module existed without having to branch on the setting for anything but
 * its own visibility line.
 *
 * `release()` and `releaseMissing()` are the exception and run either way: they
 * only ever remove a claim, so they cannot make a figure wrong, and a release
 * refused while off is a claim left in storage for a panel the player has since
 * closed — which comes back as a phantom when the setting is switched on again.
 * The stored ledger is not wiped when the setting goes off, so an accidental
 * toggle does not discard the persistent goal-planner and crafting-plan
 * claims.
 *
 * ## Owners that go away
 *
 * A reservation outliving its owner is worse than no reservation: it holds
 * stock back from every plan for a goal the player deleted last week. Two
 * mechanisms, because the owners are of two kinds:
 *
 * - **Observable.** The goal planner knows its full goal list every time it
 *   replans, so `releaseMissing(prefix, liveIds)` drops every `goal:` owner
 *   that is no longer on it. Transient owners (an open panel, the sell queue)
 *   release themselves when they close.
 * - **Not observable.** A crafting-plan owner is keyed by the item the panel
 *   was showing; nothing ever announces that the player is done with it. Those
 *   expire by age — {@link RESERVATION_TTL_MS}, seven days — swept on load and
 *   on every write. Expiry always fails safe: the stock comes back, which is
 *   the behaviour of the whole feature being off.
 *
 * Either way the removal has to be *written down* rather than merely done. The
 * ledger is synced, so an owner that is simply gone is indistinguishable from
 * one this device has never seen, and the fold puts a peer's still-live copy
 * back. See {@link RELEASED_KEY}.
 *
 * Adapted from MWITools procurementAssistant, CC-BY-NC-SA-4.0, see
 * third-party/mwitools/.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';

import { createPersistedRecord } from './persisted-record.js';
import { registerSyncMerge } from './sync-merge-registry.js';

/** Unscoped key for the reservation ledger; the real key carries the character id */
export const RESERVATIONS_KEY = 'inventoryReservationLedger';

/** The setting that switches the whole feature on; off is the shipped default */
export const RESERVATIONS_SETTING = 'inventoryReservations';

/** Object store the ledger lives in */
const STORE = 'settings';

/** Only stock sitting in the bag can be claimed; equipped and listed copies cannot */
const INVENTORY_LOCATION = '/item_locations/inventory';

/**
 * How long a reservation nobody has restamped survives.
 *
 * Long enough that a plan the player comes back to next weekend is still
 * holding its materials, short enough that a browser crash mid-panel does not
 * hide stock from every other plan indefinitely. Owners whose deletion IS
 * observable are released the moment it is, and do not wait for this.
 */
export const RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the ledger remembers the owners it has RELEASED.
 *
 * The ledger is synced, and a removal that leaves no trace cannot be told from
 * an owner this device has simply never seen. `delete ledger[owner]` was
 * exactly that: {@link mergeReservations} folds per owner, finds no local
 * entry — precisely because it was deleted — and writes the peer's still-live
 * copy straight back. A plan the player finished, deleted or closed the panel
 * on then holds stock back from every other plan for up to
 * {@link RESERVATION_TTL_MS}, with nothing on screen to say why.
 *
 * So a release writes a tombstone here instead of nothing, the fold unions the
 * two sides' tombstones — a removal only ever moves forward — and applies them
 * to both sides on the way through.
 *
 * Shape: `{[ownerId]: releasedAt}`. Nothing but the moment, because the owner
 * id is the key and nothing displays a tombstone. `releasedAt` is *the moment
 * of the release*, not the released claim's own `updatedAt`, and the
 * difference matters: a peer may have restamped the claim later than this
 * device's copy without this device having pulled it, so pruning on the copy
 * we happened to hold would drop the tombstone while a newer stale copy was
 * still alive. The release moment bounds every copy that could exist.
 *
 * It lives inside the ledger rather than beside it in a key of its own so that
 * one fold sees both halves at once: a tombstone and the claim it suppresses
 * can never arrive in the wrong order, and there is no second record to keep
 * in step. The cost is one reserved id in the owner namespace, kept out of
 * sight by {@link allReservations} and refused by {@link reserve}.
 */
export const RELEASED_KEY = '__released';

/** A runaway ledger is a slow read on every shortfall in the script */
const MAX_OWNERS = 200;
/** Per owner: a bill of materials, not a catalogue */
const MAX_LINES_PER_OWNER = 200;

/**
 * @typedef {Object} ReservationLine
 * @property {string} itemHrid - The item claimed
 * @property {number} enhancementLevel - Which copy; 0 for a plain material
 * @property {number} count - Units claimed
 */

/**
 * @typedef {Object} Reservation
 * @property {string} label - Human name for the visibility line ("Goal: Cheese sword")
 * @property {number} updatedAt - When this claim was last made, in epoch ms
 * @property {Array<ReservationLine>} lines - What the owner claims
 */

/**
 * Two devices' ledgers as one: per owner, the claim that was made later.
 *
 * Not a union of counts and not a max. An owner's lines are one plan's current
 * need — replaced wholesale on every recompute — so two copies of one owner are
 * two versions of one claim, and summing them would double the claim of any
 * plan that had been recomputed on both devices. A copy with no usable stamp
 * loses to one that has a stamp, and to nothing else; a tie resolves to the
 * incoming copy on the registry's `(local, incoming)` convention.
 *
 * Newer-wins alone, though, is newer-wins against the owners this device
 * RELEASED — an owner with no local entry loses to a peer's copy every time,
 * which is exactly how a finished plan came back as a live claim. So the two
 * sides' {@link RELEASED_KEY} tombstones are folded first, as a union, and
 * applied to both sides: the incoming one because it may carry a claim this
 * device released, the local one because it may carry a claim the peer
 * released and this device has not dropped yet.
 *
 * @param {Object|*} local - This device's ledger
 * @param {Object|*} incoming - The downloaded ledger
 * @returns {Object} The folded ledger
 */
export function mergeReservations(local, incoming) {
    const out = {};
    const base = local && typeof local === 'object' ? local : {};
    const fresh = incoming && typeof incoming === 'object' ? incoming : {};
    const released = mergeTombstones(base[RELEASED_KEY], fresh[RELEASED_KEY]);

    for (const [owner, reservation] of Object.entries(base)) {
        if (owner === RELEASED_KEY) continue;
        if (reservation && typeof reservation === 'object' && !isReleased(released, owner, reservation)) {
            out[owner] = reservation;
        }
    }
    for (const [owner, reservation] of Object.entries(fresh)) {
        if (owner === RELEASED_KEY) continue;
        if (!reservation || typeof reservation !== 'object') continue;
        if (isReleased(released, owner, reservation)) continue;
        const held = out[owner];
        const mine = Number(held?.updatedAt);
        const theirs = Number(reservation.updatedAt);
        const keepMine = held && Number.isFinite(mine) && (!Number.isFinite(theirs) || mine > theirs);
        if (!keepMine) out[owner] = reservation;
    }
    if (Object.keys(released).length) out[RELEASED_KEY] = released;
    return out;
}

/**
 * Fold two sets of tombstones: the union, keeping the later release per owner.
 *
 * A union because a removal only moves forward — a device that has not seen a
 * release holds no entry for it, and letting its silence win is the release
 * coming undone, which is the whole bug. The *later* of two releases for one
 * owner because that is the one that is still true: an owner id is reused (a
 * crafting plan is keyed by the item its panel was showing, and the player
 * reopens it), so release-claim-release is ordinary, and the last release is
 * the one whose moment bounds every stale copy still in flight. Symmetric in
 * both arguments, so a pull reads the same whichever side it arrives on.
 *
 * @param {*} local - This device's tombstones
 * @param {*} incoming - The downloaded tombstones
 * @returns {Object<string, number>} Owner id → the moment it was released
 */
function mergeTombstones(local, incoming) {
    const out = {};
    for (const side of [local, incoming]) {
        if (!side || typeof side !== 'object') continue;
        for (const [ownerId, at] of Object.entries(side)) {
            // A tombstone that cannot be placed in time cannot be pruned by the
            // TTL either, so it is not kept at all — an unbounded ledger is the
            // thing this must not become, and losing one is a resurrection of
            // one claim, which the TTL sweep already bounds
            const stamp = Number(at);
            if (!ownerId || ownerId === RELEASED_KEY || !Number.isFinite(stamp) || !(stamp > 0)) continue;
            if (!(ownerId in out) || stamp > out[ownerId]) out[ownerId] = stamp;
        }
    }
    return out;
}

/**
 * Whether a tombstone covers this copy of an owner's claim.
 *
 * Covered means the claim was made no later than the release: it is the copy
 * that was released, or an older one. A claim stamped *after* the release is a
 * genuinely new claim on a reused owner id and survives — which is how a
 * re-claim travels to a peer that still holds the tombstone, with no revival
 * flag to sync. A claim with no usable stamp is covered, matching
 * {@link sweepExpired}, which expires a stampless claim at once for the same
 * reason: nothing can ever say when it was made.
 *
 * @param {Object<string, number>} released - Folded tombstones
 * @param {string} ownerId - The owner
 * @param {Object} reservation - The claim being folded
 * @returns {boolean} Whether to drop it
 */
function isReleased(released, ownerId, reservation) {
    if (!(ownerId in released)) return false;
    const stamp = Number(reservation?.updatedAt);
    return !Number.isFinite(stamp) || stamp <= released[ownerId];
}

/**
 * The ledger as owners only, with the tombstones kept out of sight.
 *
 * Every caller that treats the ledger as "owner id → reservation" goes through
 * here, so the reserved id cannot be mistaken for a plan by anything that
 * iterates. The common ledger has no tombstones at all and is returned as-is.
 *
 * @param {Object} ledger - The stored ledger
 * @returns {Object} Owner id → reservation
 */
function ownersOnly(ledger) {
    if (!ledger || typeof ledger !== 'object') return {};
    if (!(RELEASED_KEY in ledger)) return ledger;
    const out = {};
    for (const [ownerId, reservation] of Object.entries(ledger)) {
        if (ownerId !== RELEASED_KEY) out[ownerId] = reservation;
    }
    return out;
}

/**
 * Write down that an owner's claim was released, so no copy can bring it back.
 * @param {Object} ledger - The ledger, mutated in place
 * @param {string} ownerId - The owner released
 * @param {number} now - Epoch ms
 * @returns {void}
 */
function tombstone(ledger, ownerId, now) {
    const released = ledger[RELEASED_KEY] && typeof ledger[RELEASED_KEY] === 'object' ? ledger[RELEASED_KEY] : {};
    released[ownerId] = now;
    ledger[RELEASED_KEY] = released;
}

/*
 * Registered so a cross-device sync PULL folds the two ledgers instead of
 * writing one over the other: a claim made on the phone this morning and one
 * made on the desktop this afternoon are two different plans' claims, and a
 * whole-key write drops whichever the payload did not carry.
 * See utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: STORE,
    base: RESERVATIONS_KEY,
    merge: mergeReservations,
    label: 'Inventory reservations',
});

/**
 * The ledger as stored, per character.
 *
 * Per character and nothing else would do: the iron cow's plans have no call on
 * the market character's bag. A plain persisted record rather than a curated
 * one — an owner's entry is replaced or explicitly released, never edited, so
 * folding the stored ledger under memory cannot resurrect anything the player
 * removed; what it does do is keep a second tab's claims alive across this
 * tab's writes, which is the whole point of the ledger.
 *
 * 'discard' rather than 'adopt': there is no legacy global ledger to inherit.
 */
const record = createPersistedRecord({
    base: RESERVATIONS_KEY,
    store: STORE,
    empty: () => ({}),
    merge: mergeReservations,
    migrate: 'discard',
    label: 'InventoryReservations',
});

/** Whose ledger is in memory, so a character switch never spends the other's bag */
let owner = null;

/** The in-flight or finished load for the character in `owner`, so it happens once */
let loading = null;

/**
 * Point the record at the character logged in now.
 * @returns {void}
 */
function claim() {
    const who = dataManager.getCurrentCharacterId?.() || null;
    if (who === owner) return;
    record.reset();
    // The in-flight read belongs to the character just left. `record.reset()`
    // has pulled the record out from under it, so it will come back having
    // loaded nothing — and an `ensureLoaded()` that awaited it would hand the
    // arriving character an EMPTY ledger that the next overwrite-save would
    // file under their key, losing every claim they had stored. Dropped here
    // so the next caller starts a read of its own.
    loading = null;
    owner = who;
}

/**
 * Whether the reservation ledger is switched on.
 *
 * Every read and write in this module goes through it, so "off" is one branch
 * here rather than one in each of the five consumers — and off is bit-for-bit
 * the behaviour before the ledger existed.
 * @returns {boolean} True when reservations are honoured
 */
export function reservationsEnabled() {
    try {
        return config.getSetting(RESERVATIONS_SETTING) === true;
    } catch {
        return false;
    }
}

/**
 * Drop reservations nobody has restamped inside {@link RESERVATION_TTL_MS}.
 * @param {Object} ledger - The ledger to sweep, mutated in place
 * @param {number} now - Epoch ms
 * @returns {boolean} Whether anything was dropped
 */
function sweepExpired(ledger, now) {
    let dropped = false;
    for (const [id, reservation] of Object.entries(ledger)) {
        if (id === RELEASED_KEY) continue;
        const stamp = Number(reservation?.updatedAt);
        // A stampless entry is one this version did not write; it expires at
        // once rather than never, since nothing can ever restamp it
        if (!Number.isFinite(stamp) || now - stamp > RESERVATION_TTL_MS) {
            delete ledger[id];
            dropped = true;
        }
    }
    return sweepTombstones(ledger, now) || dropped;
}

/**
 * Drop the tombstones that can no longer change an outcome.
 *
 * {@link RESERVATION_TTL_MS} is the exact bound, and it is already the rule
 * this file lives by rather than a horizon invented for the tombstones. A
 * tombstone released at R only ever suppresses claims stamped at or before R,
 * and the sweep above drops every claim older than one TTL wherever it came
 * from — so once `now - R` passes the TTL there is no copy left anywhere that
 * the tombstone could still be deciding about, and it goes. Exact, not merely
 * sound: a claim stamped at R itself is suppressed right up to that moment.
 *
 * The count cap is the second half of the bound, for a session that churns
 * more than {@link MAX_OWNERS} owners inside one TTL window. It evicts the
 * oldest, which are the ones closest to being pruned anyway.
 *
 * @param {Object} ledger - The ledger, mutated in place
 * @param {number} now - Epoch ms
 * @returns {boolean} Whether anything was dropped
 */
function sweepTombstones(ledger, now) {
    const released = ledger[RELEASED_KEY];
    if (!released || typeof released !== 'object') return false;

    let dropped = false;
    for (const [ownerId, at] of Object.entries(released)) {
        const stamp = Number(at);
        if (!Number.isFinite(stamp) || now - stamp > RESERVATION_TTL_MS) {
            delete released[ownerId];
            dropped = true;
        }
    }

    const ids = Object.keys(released);
    if (ids.length > MAX_OWNERS) {
        ids.sort((a, b) => Number(released[a]) - Number(released[b]));
        for (const id of ids.slice(0, ids.length - MAX_OWNERS)) delete released[id];
        dropped = true;
    }

    // An empty container is a key every reader would have to keep skipping and
    // every sync payload would have to keep carrying
    if (!Object.keys(released).length) {
        delete ledger[RELEASED_KEY];
        dropped = true;
    }
    return dropped;
}

/**
 * Read the ledger back from storage, whatever the setting says.
 *
 * Separate from {@link loadReservations} because a release must be able to load
 * while the feature is off: a claim can only be removed by rewriting the record
 * it lives in, and refusing the load is what leaves the claim behind. Nothing
 * that reads the ledger for a figure goes through here — every one of those
 * gates on {@link reservationsEnabled} in its own right — so an off-switch load
 * changes no number anywhere.
 *
 * @returns {Promise<Object>} The ledger, expired owners already dropped
 */
async function readLedger() {
    try {
        claim();
        await record.load({ authoritative: true });
        const ledger = record.get();
        if (sweepExpired(ledger, Date.now())) await record.save({ overwrite: true });
        return ledger;
    } catch (error) {
        console.error('[InventoryReservations] Loading the ledger failed:', error);
        return {};
    }
}

/**
 * Read the ledger back from storage.
 *
 * Call once at start-up and after a character switch; every other entry point
 * reads what is already in memory, because a shortfall is recomputed on every
 * keystroke and must not await storage.
 *
 * @returns {Promise<Object>} The ledger, expired owners already dropped; empty while the feature is off
 */
export async function loadReservations() {
    if (!reservationsEnabled()) return {};
    return ownersOnly(await readLedger());
}

/**
 * Read the ledger back once per character, from wherever first needs it.
 *
 * `effectiveInventory` and its friends are called from render paths and cannot
 * await anything, so somebody has to have loaded the ledger before they run.
 * Every async entry point here does this, which means the first `reserve()`,
 * `release()` or explicit `loadReservations()` of a session is enough and no
 * consumer has to remember a boot step.
 *
 * Goes through {@link readLedger} rather than {@link loadReservations} so that a
 * release still has the stored record in hand while the feature is off.
 *
 * @returns {Promise<void>}
 */
async function ensureLoaded() {
    claim();
    if (record.isLoaded()) return;
    if (!loading) {
        loading = readLedger().finally(() => {
            loading = null;
        });
    }
    await loading;
}

/**
 * The ledger held in memory. Empty while the feature is off.
 * @returns {Object} Owner id → reservation
 */
export function allReservations() {
    if (!reservationsEnabled()) return {};
    claim();
    return ownersOnly(record.get());
}

/**
 * Normalise what a consumer asked to reserve.
 * @param {Array<Object>|*} lines - Raw lines
 * @returns {Array<ReservationLine>} Positive whole claims, one per item+level
 */
function cleanLines(lines) {
    const byKey = new Map();
    for (const line of Array.isArray(lines) ? lines : []) {
        const itemHrid = line?.itemHrid;
        if (typeof itemHrid !== 'string' || !itemHrid) continue;
        // `Number.isFinite`, not just `> 0`: an Infinity that reached the
        // ledger would claim every copy of the item from every other plan and
        // print as "∞ reserved", and nothing downstream re-checks it
        const count = Math.floor(Number(line.count) || 0);
        if (!Number.isFinite(count) || !(count > 0)) continue;
        const enhancementLevel = Math.max(0, Math.floor(Number(line.enhancementLevel) || 0));
        const key = `${itemHrid}|${enhancementLevel}`;
        const held = byKey.get(key);
        // One plan naming an item twice wants the sum of the two lines: it is
        // one claim being described in parts, not two claims
        if (held) held.count += count;
        else byKey.set(key, { itemHrid, enhancementLevel, count });
    }
    return [...byKey.values()].slice(0, MAX_LINES_PER_OWNER);
}

/**
 * Record what one owner currently claims, replacing whatever it claimed before.
 *
 * Replacing rather than adding is the contract: an owner has one current need.
 * A `reserve` with no usable lines is a `release` — a plan that needs nothing
 * holds nothing.
 *
 * @param {string} ownerId - Stable id for the plan, goal or queue making the claim
 * @param {Array<{itemHrid: string, count: number, enhancementLevel?: number}>} lines - What it needs
 * @param {Object} [options]
 * @param {string} [options.label] - What to call this owner in another consumer's shortfall line
 * @returns {Promise<boolean>} Whether a write landed
 */
export async function reserve(ownerId, lines, { label = '' } = {}) {
    if (!reservationsEnabled() || typeof ownerId !== 'string' || !ownerId || ownerId === RELEASED_KEY) return false;
    const clean = cleanLines(lines);
    if (!clean.length) return release(ownerId);

    try {
        await ensureLoaded();
        // Every write below is an `overwrite` one, which takes no probe of its
        // own — so a ledger that could not be READ would be answered by writing
        // this one claim over whatever is stored, losing every other plan's.
        // The record only stays unloaded when the probe was unreadable, which
        // makes this exactly the "no blind overwrites" rule the record keeps.
        if (!record.isLoaded()) {
            console.warn('[InventoryReservations] Not reserving: the ledger could not be read first');
            return false;
        }
        const ledger = record.get();
        const now = Date.now();
        sweepExpired(ledger, now);
        ledger[ownerId] = { label: String(label || ownerId), updatedAt: now, lines: clean };
        // The claim is stamped `now`, later than any tombstone the sweep just
        // left standing, so the fold would keep it either way — dropping the
        // entry is housekeeping, not correctness, and it is what keeps a
        // reopened crafting-plan panel from carrying its own gravestone about
        if (ledger[RELEASED_KEY]) {
            delete ledger[RELEASED_KEY][ownerId];
            if (!Object.keys(ledger[RELEASED_KEY]).length) delete ledger[RELEASED_KEY];
        }

        // A cap that evicts the oldest claims rather than refusing the new one:
        // the newest claim is the one the player is looking at
        const ids = Object.keys(ledger).filter((id) => id !== RELEASED_KEY);
        if (ids.length > MAX_OWNERS) {
            ids.sort((a, b) => Number(ledger[a]?.updatedAt || 0) - Number(ledger[b]?.updatedAt || 0));
            for (const id of ids.slice(0, ids.length - MAX_OWNERS)) delete ledger[id];
        }

        // `overwrite`: a release inside this write (the sweep, the cap) is meant
        // to lose entries, and the merge-save would fold them straight back in
        return await record.save({ overwrite: true });
    } catch (error) {
        console.error('[InventoryReservations] Reserving failed:', error);
        return false;
    }
}

/**
 * Drop an owner's claim.
 *
 * Runs whether or not the feature is on. A release only ever removes a claim,
 * so it can make no figure wrong; refusing one is what leaves a claim in
 * storage for a panel that has since closed, to surface as a phantom the next
 * time the setting is switched back on. The stored ledger is never wiped
 * wholesale on the setting going off for the opposite reason — the goal
 * planner's and crafting plan's claims outlive a mistaken toggle.
 *
 * @param {string} ownerId - The owner
 * @returns {Promise<boolean>} Whether a write landed
 */
export async function release(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId === RELEASED_KEY) return false;
    try {
        await ensureLoaded();
        const ledger = record.get();
        if (!(ownerId in ledger)) return false;
        const now = Date.now();
        delete ledger[ownerId];
        // Not just `delete`: a peer that has not released yet still holds this
        // claim, and the fold cannot tell a deletion from a claim it has never
        // seen. See {@link RELEASED_KEY}.
        tombstone(ledger, ownerId, now);
        sweepTombstones(ledger, now);
        return await record.save({ overwrite: true });
    } catch (error) {
        console.error('[InventoryReservations] Releasing failed:', error);
        return false;
    }
}

/**
 * Release every owner under `prefix` that is not on `liveIds` — an orphan sweep
 * for a consumer that can see its own full list of owners.
 *
 * The goal planner is the case: it replans from the whole goal list, so a
 * `goal:` owner missing from that list is a goal the player deleted, and its
 * claim must go with it.
 *
 * Like {@link release}, runs regardless of the setting: it only ever removes.
 *
 * @param {string} prefix - Owner-id prefix this consumer owns, e.g. `'goal:'`
 * @param {Iterable<string>} liveIds - Owner ids that still exist
 * @returns {Promise<number>} How many claims were dropped
 */
export async function releaseMissing(prefix, liveIds) {
    if (typeof prefix !== 'string' || !prefix) return 0;
    try {
        await ensureLoaded();
        const live = new Set(liveIds || []);
        const ledger = record.get();
        const now = Date.now();
        let dropped = 0;
        for (const id of Object.keys(ledger)) {
            if (id === RELEASED_KEY || !id.startsWith(prefix) || live.has(id)) continue;
            delete ledger[id];
            // Same reason as {@link release}: a deleted goal whose claim is
            // only deleted comes back from the first peer that has not replanned
            tombstone(ledger, id, now);
            dropped += 1;
        }
        if (dropped) {
            sweepTombstones(ledger, now);
            await record.save({ overwrite: true });
        }
        return dropped;
    } catch (error) {
        console.error('[InventoryReservations] Orphan sweep failed:', error);
        return 0;
    }
}

/**
 * How many unenhanced-at-`enhancementLevel` copies are in the bag.
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which copy
 * @returns {number} Units held
 */
export function heldInInventory(itemHrid, enhancementLevel = 0) {
    const items = dataManager.getInventory?.();
    if (!Array.isArray(items)) return 0;
    const level = Math.max(0, Math.floor(Number(enhancementLevel) || 0));
    let total = 0;
    for (const item of items) {
        if (item?.itemHrid !== itemHrid) continue;
        if (item.itemLocationHrid !== INVENTORY_LOCATION) continue;
        if ((item.enhancementLevel || 0) !== level) continue;
        total += item.count || 0;
    }
    return total;
}

/**
 * Who else has claimed an item, and how much each of them claims.
 *
 * This is what a visibility line is built from: a shortfall that exists only
 * because another plan got there first is not a shortfall the player can
 * understand from the number alone.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which copy
 * @param {Object} [options]
 * @param {string|null} [options.excludeOwner] - The asking owner, whose own claim never counts
 * @returns {{total: number, byOwner: Array<{ownerId: string, label: string, count: number}>}}
 *   Claims by everyone else, largest first
 */
export function reservationDetail(itemHrid, enhancementLevel = 0, { excludeOwner = null } = {}) {
    if (!reservationsEnabled() || typeof itemHrid !== 'string') return { total: 0, byOwner: [] };

    const level = Math.max(0, Math.floor(Number(enhancementLevel) || 0));
    const byOwner = [];
    let total = 0;

    for (const [ownerId, reservation] of Object.entries(allReservations())) {
        if (ownerId === excludeOwner) continue;
        let count = 0;
        for (const line of reservation?.lines || []) {
            if (line?.itemHrid !== itemHrid || (line.enhancementLevel || 0) !== level) continue;
            count += Math.max(0, Number(line.count) || 0);
        }
        if (!(count > 0)) continue;
        total += count;
        byOwner.push({ ownerId, label: reservation.label || ownerId, count });
    }

    byOwner.sort((a, b) => b.count - a.count);
    return { total, byOwner };
}

/**
 * How many units of an item everyone but `excludeOwner` has claimed.
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which copy
 * @param {Object} [options]
 * @param {string|null} [options.excludeOwner] - The asking owner
 * @returns {number} Units claimed elsewhere; zero while the feature is off
 */
export function reservedElsewhere(itemHrid, enhancementLevel = 0, { excludeOwner = null } = {}) {
    return reservationDetail(itemHrid, enhancementLevel, { excludeOwner }).total;
}

/**
 * What is actually available to one owner: what is held, less everyone else's
 * claims, floored at zero.
 *
 * `held` is the seam that keeps this usable by consumers that count "held"
 * their own way — the action calculator adds bought-but-unclaimed market units,
 * the goal planner counts only the bag. Pass yours and the ledger only does the
 * subtracting; omit it and the bag is counted here.
 *
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which copy
 * @param {Object} [options]
 * @param {string|null} [options.excludeOwner] - The asking owner, whose own claim is not deducted
 * @param {number} [options.held] - Units held, if the caller counts them itself
 * @returns {number} Units this owner may plan against
 */
export function effectiveInventory(itemHrid, enhancementLevel = 0, { excludeOwner = null, held } = {}) {
    const owned = held === undefined ? heldInInventory(itemHrid, enhancementLevel) : Math.max(0, Number(held) || 0);
    if (!reservationsEnabled()) return owned;
    return Math.max(0, owned - reservedElsewhere(itemHrid, enhancementLevel, { excludeOwner }));
}

/**
 * Inventory rows with everyone else's claims already taken out of them, for a
 * consumer that works over the raw row list rather than item by item.
 *
 * Rows are returned in the order they arrived, with claimed counts reduced and
 * fully-claimed rows dropped; the array is a copy, so the caller cannot write
 * through it into `dataManager`'s inventory. Returned as-is while the feature
 * is off, which is what keeps such a consumer bit-for-bit unchanged.
 *
 * @param {Array<Object>} rows - Inventory rows from `dataManager.getInventory()`
 * @param {Object} [options]
 * @param {string|null} [options.excludeOwner] - The asking owner
 * @returns {Array<Object>} Rows the asking owner may plan against
 */
export function effectiveInventoryRows(rows, { excludeOwner = null } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!reservationsEnabled()) return list;

    // One budget per item+level, spent across however many rows carry it, so a
    // stack split over two rows is not decremented twice
    const budget = new Map();
    const out = [];
    for (const row of list) {
        if (!row?.itemHrid) continue;
        const level = row.enhancementLevel || 0;
        const key = `${row.itemHrid}|${level}`;
        if (!budget.has(key)) {
            budget.set(key, reservedElsewhere(row.itemHrid, level, { excludeOwner }));
        }
        const claimed = budget.get(key);
        const count = row.count || 0;
        if (claimed <= 0) {
            out.push(row);
            continue;
        }
        const taken = Math.min(claimed, count);
        budget.set(key, claimed - taken);
        if (count - taken > 0) out.push({ ...row, count: count - taken });
    }
    return out;
}

/**
 * One line saying why a shortfall exists that the bag does not explain.
 *
 * Empty string when nothing else has claimed the item, so a caller can append
 * it unconditionally.
 *
 * @param {number} short - The shortfall being reported
 * @param {string} itemHrid - The item
 * @param {number} [enhancementLevel] - Which copy
 * @param {Object} [options]
 * @param {string|null} [options.excludeOwner] - The asking owner
 * @returns {string} e.g. `120 short — 300 reserved by "Goal: Cheese sword"`
 */
export function shortfallNote(short, itemHrid, enhancementLevel = 0, { excludeOwner = null } = {}) {
    const { total, byOwner } = reservationDetail(itemHrid, enhancementLevel, { excludeOwner });
    if (!(total > 0) || !byOwner.length) return '';

    const [largest, ...rest] = byOwner;
    // Named individually up to two claimants; past that the list is longer than
    // the fact it is explaining
    let who = `"${largest.label}"`;
    if (rest.length === 1) who += ` and "${rest[0].label}"`;
    else if (rest.length > 1) who += ` and ${rest.length} other plans`;

    return (
        `${Math.max(0, Math.floor(Number(short) || 0)).toLocaleString()} short — ` +
        `${total.toLocaleString()} reserved by ${who}`
    );
}

/**
 * Test-only: forget the ledger in memory and whose it was.
 * @returns {void}
 */
export function _resetReservations() {
    record.reset();
    owner = null;
    loading = null;
}

/**
 * Read the ledger back if this is the first thing this session to want it.
 * @returns {Promise<void>}
 */
export async function ensureReservationsLoaded() {
    if (!reservationsEnabled()) return;
    await ensureLoaded();
}

/*
 * The render paths that ask what is available cannot await a load, and the
 * first of them can run before anything has reserved anything — so a page that
 * had claims stored would spend its first seconds planning as though it had
 * none. Settings are what say whether the ledger is even on, so the read is
 * hung off the moment they land, and off the switch being turned on later.
 * Both are optional so a test double that is only `getSetting` still works.
 */
config.onSettingsLoaded?.(() => {
    if (reservationsEnabled()) ensureLoaded().catch(() => {});
});
config.onSettingChange?.(RESERVATIONS_SETTING, (on) => {
    if (on) ensureLoaded().catch(() => {});
    else _resetReservations();
});

/*
 * A switch moves the whole ledger: the arriving character's claims are in their
 * own record and the departing character's are none of their business. Nothing
 * else announces it — every entry point notices lazily, in `claim()` — and the
 * paths that ask what is available cannot await, so without this the arriving
 * character plans against an EMPTY ledger (every claim invisible, every plan
 * reporting stock another plan has taken) until the next write happens to load
 * it. Reading it here also bumps the record's generation at the moment of the
 * switch, which is what makes a save queued by the departing character stand
 * down instead of landing under the arriving character's key.
 *
 * `character_switched` rather than `character_switching`: the id has moved by
 * then, so the read is of the arriving character's record, and a release the
 * departing character's teardown started still ran against theirs.
 */
dataManager.on?.('character_switched', () => {
    if (reservationsEnabled()) ensureLoaded().catch(() => {});
    else _resetReservations();
});

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushReservationWrites() {
    return record.flushed();
}

export default {
    RESERVATIONS_KEY,
    RESERVATIONS_SETTING,
    RESERVATION_TTL_MS,
    RELEASED_KEY,
    reservationsEnabled,
    loadReservations,
    ensureReservationsLoaded,
    allReservations,
    reserve,
    release,
    releaseMissing,
    heldInInventory,
    reservationDetail,
    reservedElsewhere,
    effectiveInventory,
    effectiveInventoryRows,
    shortfallNote,
    mergeReservations,
};
