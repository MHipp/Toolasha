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
 * held count untouched, `reservedElsewhere()` answers zero, and `reserve()` and
 * `release()` write nothing at all. A consumer therefore behaves exactly as it
 * did before this module existed without having to branch on the setting for
 * anything but its own visibility line.
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
 * @param {Object|*} local - This device's ledger
 * @param {Object|*} incoming - The downloaded ledger
 * @returns {Object} The folded ledger
 */
export function mergeReservations(local, incoming) {
    const out = {};
    const base = local && typeof local === 'object' ? local : {};
    const fresh = incoming && typeof incoming === 'object' ? incoming : {};

    for (const [owner, reservation] of Object.entries(base)) {
        if (reservation && typeof reservation === 'object') out[owner] = reservation;
    }
    for (const [owner, reservation] of Object.entries(fresh)) {
        if (!reservation || typeof reservation !== 'object') continue;
        const held = out[owner];
        const mine = Number(held?.updatedAt);
        const theirs = Number(reservation.updatedAt);
        const keepMine = held && Number.isFinite(mine) && (!Number.isFinite(theirs) || mine > theirs);
        if (!keepMine) out[owner] = reservation;
    }
    return out;
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

/**
 * Point the record at the character logged in now.
 * @returns {void}
 */
function claim() {
    const who = dataManager.getCurrentCharacterId?.() || null;
    if (who === owner) return;
    record.reset();
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
        const stamp = Number(reservation?.updatedAt);
        // A stampless entry is one this version did not write; it expires at
        // once rather than never, since nothing can ever restamp it
        if (!Number.isFinite(stamp) || now - stamp > RESERVATION_TTL_MS) {
            delete ledger[id];
            dropped = true;
        }
    }
    return dropped;
}

/**
 * Read the ledger back from storage.
 *
 * Call once at start-up and after a character switch; every other entry point
 * reads what is already in memory, because a shortfall is recomputed on every
 * keystroke and must not await storage.
 *
 * @returns {Promise<Object>} The ledger, expired owners already dropped
 */
export async function loadReservations() {
    if (!reservationsEnabled()) return {};
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

/** The in-flight or finished load for the character in `owner`, so it happens once */
let loading = null;

/**
 * Read the ledger back once per character, from wherever first needs it.
 *
 * `effectiveInventory` and its friends are called from render paths and cannot
 * await anything, so somebody has to have loaded the ledger before they run.
 * Every async entry point here does this, which means the first `reserve()`,
 * `release()` or explicit `loadReservations()` of a session is enough and no
 * consumer has to remember a boot step.
 *
 * @returns {Promise<void>}
 */
async function ensureLoaded() {
    claim();
    if (record.isLoaded()) return;
    if (!loading) {
        loading = loadReservations().finally(() => {
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
    return record.get();
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
        const count = Math.floor(Number(line.count) || 0);
        if (!(count > 0)) continue;
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
    if (!reservationsEnabled() || typeof ownerId !== 'string' || !ownerId) return false;
    const clean = cleanLines(lines);
    if (!clean.length) return release(ownerId);

    try {
        await ensureLoaded();
        const ledger = record.get();
        const now = Date.now();
        sweepExpired(ledger, now);
        ledger[ownerId] = { label: String(label || ownerId), updatedAt: now, lines: clean };

        // A cap that evicts the oldest claims rather than refusing the new one:
        // the newest claim is the one the player is looking at
        const ids = Object.keys(ledger);
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
 * @param {string} ownerId - The owner
 * @returns {Promise<boolean>} Whether a write landed
 */
export async function release(ownerId) {
    if (!reservationsEnabled() || typeof ownerId !== 'string' || !ownerId) return false;
    try {
        await ensureLoaded();
        const ledger = record.get();
        if (!(ownerId in ledger)) return false;
        delete ledger[ownerId];
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
 * @param {string} prefix - Owner-id prefix this consumer owns, e.g. `'goal:'`
 * @param {Iterable<string>} liveIds - Owner ids that still exist
 * @returns {Promise<number>} How many claims were dropped
 */
export async function releaseMissing(prefix, liveIds) {
    if (!reservationsEnabled() || typeof prefix !== 'string' || !prefix) return 0;
    try {
        await ensureLoaded();
        const live = new Set(liveIds || []);
        const ledger = record.get();
        let dropped = 0;
        for (const id of Object.keys(ledger)) {
            if (!id.startsWith(prefix) || live.has(id)) continue;
            delete ledger[id];
            dropped += 1;
        }
        if (dropped) await record.save({ overwrite: true });
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

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushReservationWrites() {
    return record.flushed();
}

export default {
    RESERVATIONS_KEY,
    RESERVATIONS_SETTING,
    RESERVATION_TTL_MS,
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
