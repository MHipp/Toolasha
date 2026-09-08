/**
 * Labyrinth run ledger
 *
 * What each run left unspent. The Consumables panel plans a run as full
 * consumption of the whole torch/shroud/beacon capacity — the honest ceiling —
 * but the interesting question afterwards is the opposite one: how much came
 * back. A run that keeps ending with two hundred torches to spare is a run
 * whose "rush for exit" floor could come down (rushing fewer floors means
 * fully clearing more of them, and a full clear costs a floor's whole grid in
 * torches where a rush costs one path across it).
 *
 * So every run's ending is recorded: the last supply counts the run reported
 * before it ended, the deepest floor it reached, and when. A bounded ring,
 * character-scoped, in the labyrinth store.
 *
 * The transition detection mirrors labyrinth-run-alerts, including its two
 * traps: a payload that says nothing about the run is not evidence the run
 * ended, and the server re-sends labyrinth messages after a run ends, so each
 * ending is keyed by the run's own start stamp and recorded once.
 *
 * ## The run that ended twice
 *
 * "Recorded once" has to hold across a reload as well as within a session. A
 * post-run re-send that omits `isActive` still carries the grid and the queued
 * path, which is exactly what the active test falls back on, so it reads as a
 * live run — and the supply figures on it are no longer the run's own stock but
 * the restocked pile (the trap `labyrinth-supplies` documents from the other
 * side). Re-opening the finished run on those counts banked it a second time
 * with a whole capacity left unspent, and the ring's merge lets the newer
 * record win: the run's true leftovers were replaced by its capacity. So a key
 * seen to end is never re-opened, and an ending already in the ring is never
 * appended over.
 *
 * ## Endings nobody watched
 *
 * A socket that drops mid-run and reconnects after the next run has started
 * shows a new `startedAt` with no `ended` sighting in between. The run in hand
 * did end — so it is closed out on the last counts seen and marked
 * `endedByInference`, rather than dropped, which used to lose that run's whole
 * torch/shroud/beacon spend. The mark is load-bearing: those counts are a lower
 * bound (whatever the run spent after the last sighting went unseen), so an
 * inferred close is kept as a record but excluded from every average, on the
 * same grounds as a run joined mid-way.
 *
 * ## The grid arithmetic
 *
 * From the game's own guide: floor 1 is a 4×4 grid, each floor one wider, to
 * 8×8 at floor 5 and beyond; entry at one corner, exit at the opposite. A
 * torch is spent per room entered, so a full clear costs the grid squared and
 * a rush costs the shortest corner-to-corner path — one room per step,
 * (g−1)+(g−1)+1 rooms. Those two figures per floor are what the rush-floor
 * advisor sums.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { labyrinthRunState } from '../notifications/notification-predicates.js';

const STORAGE_KEY = 'labyrinthRunLedger';
const STORE = 'labyrinth';
/** Endings kept; older ones fall off the back */
const MAX_RUNS = 30;

/** Newest ending first, the order the ring is kept in */
const newestFirst = (a, b) => (Number(b?.endedAt) || 0) - (Number(a?.endedAt) || 0);

/**
 * The ring on disk, kept through the shared load/save discipline: a read that
 * could not be made cannot truncate it to one run, and a save folds in
 * endings another tab recorded. Merged by the run's own start stamp (`key`),
 * newest first, capped at MAX_RUNS.
 */
const mergeLedgers = (base, fresh) => mergeById((run) => run?.key, newestFirst)(base, fresh).slice(0, MAX_RUNS);

const ledgerRecord = createPersistedRecord({
    base: STORAGE_KEY,
    store: STORE,
    empty: () => [],
    merge: mergeLedgers,
    label: 'LabyrinthRunLedger',
});

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({ store: STORE, base: STORAGE_KEY, merge: mergeLedgers, label: 'Labyrinth run ledger' });

/**
 * The grid width of a floor — 4×4 on floor 1, one wider per floor, 8×8 from
 * floor 5 on (the game guide's own table).
 * @param {number} floor - 1-based floor number
 * @returns {number}
 */
export function gridSize(floor) {
    const f = Math.max(1, Math.floor(Number(floor) || 1));
    return Math.min(3 + f, 8);
}

/** Rooms a full clear of a floor enters — the whole grid. */
export function roomsFullClear(floor) {
    const g = gridSize(floor);
    return g * g;
}

/** Rooms a rush across a floor enters — the shortest corner-to-corner path. */
export function roomsRush(floor) {
    const g = gridSize(floor);
    return 2 * g - 1;
}

/**
 * Rooms a run enters: floors at or under the rush floor are crossed by the
 * shortest path, floors above it are fully cleared.
 *
 * ("Rush for exit up to floor N" — the game's own setting — rushes the early
 * floors and clears the rest, which is the shape this sums.)
 *
 * @param {number} rushFloor - Floors 1..rushFloor are rushed; 0 rushes none
 * @param {number} deepestFloor - The last floor the run reaches
 * @returns {number} Rooms entered
 */
export function roomsForPlan(rushFloor, deepestFloor) {
    const deepest = Math.max(1, Math.floor(Number(deepestFloor) || 1));
    const rush = Math.max(0, Math.floor(Number(rushFloor) || 0));
    let rooms = 0;
    for (let floor = 1; floor <= deepest; floor++) {
        rooms += floor <= rush ? roomsRush(floor) : roomsFullClear(floor);
    }
    return rooms;
}

/**
 * The chance a torch is handed back on use, read off the item's own text.
 *
 * The game states it in the description — "20% chance to preserve" on an
 * expert torch — and nowhere else this codebase has found in the data, so the
 * description is parsed. A torch with no such sentence preserves nothing.
 *
 * @param {string} itemHrid - The torch
 * @param {Object} [itemDetailMap] - Game data; read from the client by default
 * @returns {number} 0..1
 */
export function preserveChance(itemHrid, itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap) {
    const text = String(itemDetailMap?.[itemHrid]?.description || '');
    const match = text.match(/(\d+(?:\.\d+)?)\s*%\s*chance\s+to\s+preserve/i);
    if (!match) return 0;
    const pct = Number(match[1]);
    return Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0;
}

/**
 * Torches a run costs: one per room entered, less the share the torch tier
 * hands back.
 *
 * @param {number} rushFloor - Floors 1..rushFloor are rushed; 0 rushes none
 * @param {number} deepestFloor - The last floor the run reaches
 * @param {number} [preserve=0] - Chance a use is preserved, 0..1
 * @returns {number} Expected torches spent, whole
 */
export function torchesForPlan(rushFloor, deepestFloor, preserve = 0) {
    const keep = Number.isFinite(preserve) ? Math.min(1, Math.max(0, preserve)) : 0;
    return Math.ceil(roomsForPlan(rushFloor, deepestFloor) * (1 - keep));
}

/**
 * The advisor's table: what a run to `deepestFloor` costs in torches at each
 * candidate rush floor, beside the capacity, so "can I rush less?" is a read
 * rather than a calculation.
 *
 * @param {number} deepestFloor - The floor runs actually reach
 * @param {number} torchCap - What a run can carry
 * @param {number} [preserve=0] - The torch tier's preserve chance, 0..1
 * @returns {Array<{rushFloor: number, torches: number, fits: boolean}>}
 */
export function rushFloorTable(deepestFloor, torchCap, preserve = 0) {
    const deepest = Math.max(1, Math.floor(Number(deepestFloor) || 1));
    const cap = Math.max(0, Math.floor(Number(torchCap) || 0));
    const rows = [];
    for (let rush = 0; rush <= deepest; rush++) {
        const torches = torchesForPlan(rush, deepest, preserve);
        rows.push({ rushFloor: rush, torches, fits: cap > 0 ? torches <= cap : false });
    }
    return rows;
}

/**
 * What recorded runs actually spent of one supply, for every run that knows
 * it. Newest first, as the ledger is.
 *
 * This is the figure the grid math only estimates — it has the real rush
 * floor, the rooms actually entered, and the preserves actually rolled in it.
 *
 * Prefers the run's `spent` figure — the sum of sighting-to-sighting
 * *decreases*, accumulated as the run was watched (see `foldSighting`) —
 * over `start - left`. The labyrinth shop sells more of all three supplies
 * for points earned mid-run, so `left` does not fall monotonically: a run
 * that buys back up partway through has `start - left` net against the
 * purchase, reading as spending less than it did, sometimes negative. `spent`
 * only counts falls, so a mid-run top-up cannot erase the drops that came
 * before it. Older records carry no `spent` field and fall back to
 * `start - left`, which is exactly `spent` would have been for a run that
 * never bought back in.
 *
 * @param {Array<Object>} runs - Ledger records
 * @param {string} kind - 'torch' | 'shroud' | 'beacon'
 * @returns {number[]}
 */
export function observedUse(runs, kind) {
    const out = [];
    for (const run of runs || []) {
        // A run first seen mid-way (a reload, a tab opened late) has its
        // "start" set to wherever it was seen, so its spend is a floor, not a
        // measurement — averaging those in is how 350-torch runs read as 106.
        // Only runs watched from the door count. Records from before the flag
        // existed cannot say which they were, so they do not count either. A
        // run closed by inference is excluded for the mirror-image reason: its
        // end was never seen, so its spend is a floor at the other end.
        if (run?.startTrusted !== true) continue;
        // A run closed by inference was never watched to its end, so its spend
        // is a lower bound in the same way an untrusted start is
        if (run?.endedByInference === true) continue;
        const spent = Number(run?.spent?.[kind]);
        if (Number.isFinite(spent)) {
            out.push(Math.max(0, spent));
            continue;
        }
        const start = Number(run?.start?.[kind]);
        const left = Number(run?.left?.[kind]);
        if (!Number.isFinite(start) || !Number.isFinite(left)) continue;
        out.push(Math.max(0, start - left));
    }
    return out;
}

/**
 * What the trusted runs burned of one supply, as one summary.
 *
 * `observedUse` already answers "what did each run spend"; this is the reading
 * a supply row wants beside it — how many runs are actually behind the average,
 * and the spread they cover. The average is what the panel plans at, and an
 * average over two runs and an average over twenty deserve to be told apart.
 *
 * Untrusted runs are excluded by `observedUse` itself, so a run joined mid-way
 * cannot drag the average down (a 350-torch run first seen on floor 3 reads as
 * 106, which is the mistake this whole flag exists to prevent).
 *
 * @param {Array<Object>} runs - Ledger records
 * @param {string} kind - 'torch' | 'shroud' | 'beacon'
 * @returns {{runs: number, total: number, average: number, min: number, max: number}|null}
 *   Null when no trusted run has anything to say about this supply
 */
export function burnSummary(runs, kind) {
    const used = observedUse(runs, kind);
    if (!used.length) return null;
    const total = used.reduce((sum, n) => sum + n, 0);
    return {
        runs: used.length,
        total,
        average: total / used.length,
        min: Math.min(...used),
        max: Math.max(...used),
    };
}

/**
 * Torches per floor, run by run — the trend that survives a change of plan.
 *
 * Raw torch spend is not comparable between runs: a run that stopped on floor 3
 * and a run that reached floor 7 spent wildly different amounts for exactly the
 * same play. Dividing by the deepest floor reached takes the run's length out
 * of the figure and leaves the thing worth watching — whether a floor is
 * getting cheaper or dearer to cross.
 *
 * Only runs watched from the door *and* seen to end count, for the reason
 * `observedUse` gives: a run first seen mid-way has a start of "wherever we
 * came in", and a run closed by inference has an end of "wherever we last
 * looked", so both its spend and its per-floor rate are floors rather than
 * measurements.
 *
 * @param {Array<Object>} runs - Ledger records, newest first as the ledger keeps them
 * @returns {Array<{perFloor: number, torches: number, floor: number, endedAt: number}>}
 *   Newest first, the ledger's own order
 */
export function torchesPerFloor(runs) {
    const out = [];
    for (const run of runs || []) {
        if (run?.startTrusted !== true) continue;
        if (run?.endedByInference === true) continue;
        const floor = Math.floor(Number(run?.floor) || 0);
        if (floor < 1) continue;
        const spent = Number(run?.spent?.torch);
        const start = Number(run?.start?.torch);
        const left = Number(run?.left?.torch);
        let torches = null;
        if (Number.isFinite(spent)) torches = Math.max(0, spent);
        else if (Number.isFinite(start) && Number.isFinite(left)) torches = Math.max(0, start - left);
        if (torches === null) continue;
        out.push({ perFloor: torches / floor, torches, floor, endedAt: Number(run?.endedAt) || 0 });
    }
    return out;
}

/** The eight heights a text sparkline can draw, lowest first */
const SPARK_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A series as one string of block characters.
 *
 * Text rather than an SVG or a canvas because of where it goes: one line in the
 * Consumables panel's supply block, beside numbers, at the panel's own font
 * size. A chart there would be a chart nobody asked for, and a charts library
 * for eight glyphs would be a dependency nobody asked for either.
 *
 * A flat series is drawn flat — every bar mid-height — rather than having its
 * noise magnified to full scale, which is the standard sparkline trap: a run
 * of 40, 40, 41 must not read as a doubling.
 *
 * @param {number[]} values - The series, in the order it should be drawn
 * @returns {string} One glyph per value; empty when there is nothing to draw
 */
export function sparkText(values) {
    const series = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (!series.length) return '';
    const low = Math.min(...series);
    const high = Math.max(...series);
    const span = high - low;
    // A flat line sits in the middle: it has a level but no shape
    if (span <= 0) return SPARK_BARS[3].repeat(series.length);
    return series
        .map(
            (value) =>
                SPARK_BARS[Math.min(SPARK_BARS.length - 1, Math.floor(((value - low) / span) * SPARK_BARS.length))]
        )
        .join('');
}

/**
 * Fold one labyrinth sighting into the tracker's state, pure.
 *
 * @param {Object} state - `{phase, run, endedKey}` where run is
 *   `{key, floor, left: {torch, shroud, beacon}, itemHrids}` and `endedKey`
 *   names the last run seen to end, which no re-send may re-open
 * @param {Object|null} labyrinth - A payload's labyrinth object
 * @param {number} nowMs - Clock
 * @returns {{state: Object, ended: Object|null}} The next state, and a
 *   completed run record when this sighting was the run's ending
 */
export function foldSighting(state, labyrinth, nowMs) {
    const phase = labyrinthRunState(labyrinth);
    // Nothing about the run is not the run ending — the alerts' hard lesson
    if (phase === 'unknown') return { state, ended: null };

    if (phase === 'active') {
        const key = labyrinth?.startedAt ? String(labyrinth.startedAt) : (state.run?.key ?? `run-${nowMs}`);
        // The run that just ended is not a new run. The server re-sends
        // labyrinth messages after a run ends, and a re-send that omits
        // `isActive` still carries the grid and the queued path — which is
        // what `labyrinthRunState` falls back on, so it reads as active. That
        // re-opened the finished run on counts that are no longer the run's:
        // once it is over the payload's supply figures are the restocked pile,
        // so the run was banked a second time with a whole capacity left
        // unspent. Remembered by key, so a genuinely new `startedAt` is
        // followed as normal.
        if (!state.run && state.endedKey && state.endedKey === key) return { state, ended: null };
        const previous = state.run?.key === key ? state.run : null;
        // A different run arriving with no `ended` sighting between them — the
        // socket dropped mid-run and reconnected after the next run had begun.
        // The run in hand did end; nothing was here to watch it. Closing it on
        // the last counts seen keeps its spend, where discarding it lost the
        // whole run. Marked, because those counts are a lower bound: whatever
        // the run spent after the last sighting is unrecorded.
        const inferred =
            state.phase === 'active' && state.run && state.run.key !== key
                ? { ...state.run, endedAt: nowMs, endedByInference: true }
                : null;
        const count = (field) => {
            const n = Number(labyrinth?.[field]);
            return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : (previous?.left?.[field] ?? null);
        };
        const left = {
            torch: count('torchCount'),
            shroud: count('shroudCount'),
            beacon: count('beaconCount'),
        };
        // The first counts a run was seen with stand as its start, so the
        // ending can say what was spent. A run first seen mid-way (a reload)
        // starts from wherever it was seen — the usage it reports is a floor,
        // not an overstatement
        const start = {
            torch: previous?.start?.torch ?? left.torch,
            shroud: previous?.start?.shroud ?? left.shroud,
            beacon: previous?.start?.beacon ?? left.beacon,
        };
        // Only a run first seen at the door measures true spend; one first
        // seen on floor 2+ was joined mid-way and its start is just "wherever
        // we came in"
        const firstFloor = Math.floor(Number(labyrinth?.currentFloor) || 0);
        const startTrusted = previous ? (previous.startTrusted ?? false) : firstFloor <= 1;
        // True spend, accumulated sighting to sighting: a fall in `left` is a
        // room entered and is added in, a rise is a mid-run shop purchase (the
        // labyrinth shop sells more supplies for points earned in the run) and
        // is left alone rather than netted against past spending. See
        // observedUse for why this beats `start - left` once a run can buy
        // back in.
        const spent = {};
        for (const kind of ['torch', 'shroud', 'beacon']) {
            const prevLeft = previous?.left?.[kind];
            const fall = Number.isFinite(prevLeft) && Number.isFinite(left[kind]) ? prevLeft - left[kind] : 0;
            spent[kind] = (previous?.spent?.[kind] ?? 0) + Math.max(0, fall);
        }
        return {
            state: {
                phase: 'active',
                endedKey: state.endedKey ?? null,
                run: {
                    key,
                    startTrusted,
                    floor: Math.max(previous?.floor ?? 0, Math.floor(Number(labyrinth?.currentFloor) || 0)),
                    left,
                    start,
                    spent,
                    itemHrids: {
                        torch: labyrinth?.torchItemHrid || previous?.itemHrids?.torch || null,
                        shroud: labyrinth?.shroudItemHrid || previous?.itemHrids?.shroud || null,
                        beacon: labyrinth?.beaconItemHrid || previous?.itemHrids?.beacon || null,
                    },
                },
            },
            ended: inferred,
        };
    }

    // phase === 'ended': only an active→ended edge with a run in hand records
    if (state.phase !== 'active' || !state.run) {
        return { state: { phase: 'ended', run: null, endedKey: state.endedKey ?? null }, ended: null };
    }
    return {
        state: { phase: 'ended', run: null, endedKey: state.run.key },
        ended: { ...state.run, endedAt: nowMs },
    };
}

class LabyrinthRunLedger {
    constructor() {
        this.state = { phase: 'unknown', run: null };
        this.unregister = null;
        this.recorded = new Set();
        /** Whose endings the record in memory holds; a change means forget them first */
        this.ledgerOwner = null;
        /** Whose run `state` is following; the same rule, for the run in flight */
        this.stateOwner = null;
    }

    /**
     * The ring, with the departing character's endings forgotten when the
     * character has changed since — the key is resolved per access, and the
     * memory behind it must never be written under another character's key.
     * @returns {Object} The persisted record
     */
    _ledger() {
        const owner = dataManager.getCurrentCharacterId?.() || null;
        if (owner !== this.ledgerOwner) {
            ledgerRecord.reset();
            this.ledgerOwner = owner;
        }
        return ledgerRecord;
    }

    initialize() {
        if (this.unregister) return;
        const onUpdate = (data) => {
            try {
                this.observe(data?.labyrinth);
            } catch (error) {
                console.error('[LabyrinthRunLedger] Handling a labyrinth update failed:', error);
            }
        };
        webSocketHook.on('labyrinth_updated', onUpdate);
        this.unregister = () => webSocketHook.off('labyrinth_updated', onUpdate);

        // The character data in hand at start-up says whether a run is already
        // going, so an ending seen later has an active edge to fall from
        const lab = dataManager.characterData?.characterLabyrinth || dataManager.characterData?.labyrinth;
        if (lab) this.observe(lab);
    }

    cleanup() {
        this.unregister?.();
        this.unregister = null;
        this.state = { phase: 'unknown', run: null };
        this.stateOwner = null;
        this.recorded.clear();
    }

    /**
     * The feature registry tears features down by calling `disable()`, so a
     * `cleanup()` alone is never called on a character switch — which left the
     * websocket handler hooked and the departing character's run still in
     * flight. Aliased rather than renamed: the module has always called this
     * cleanup, and both names are now honoured.
     */
    disable() {
        this.cleanup();
    }

    /** @param {Object|null} labyrinth - A payload's labyrinth object */
    observe(labyrinth) {
        // A run in flight belongs to whoever was running it. The arriving
        // character's first sighting reports no active labyrinth, which reads
        // as the active→ended edge and would file the departing character's
        // torch and shroud spend into the arriving character's ledger — the
        // key is resolved when the append runs, not when the run started.
        // Forgetting the run instead loses it, which is the trade `_ledger`
        // already makes for the same reason: a lost run beats a misfiled one.
        const owner = dataManager.getCurrentCharacterId?.() || null;
        if (owner !== this.stateOwner) {
            this.state = { phase: 'unknown', run: null };
            this.recorded.clear();
            this.stateOwner = owner;
        }

        const { state, ended } = foldSighting(this.state, labyrinth, Date.now());
        this.state = state;
        if (ended && !this.recorded.has(ended.key)) {
            this.recorded.add(ended.key);
            this._append(ended).catch((error) =>
                console.error('[LabyrinthRunLedger] Recording a run ending failed:', error)
            );
        }
    }

    /**
     * Append one ending to the ring. Loaded first, so a read that could not be
     * made keeps what is in memory rather than truncating the ring to this
     * one run; the save itself folds in what another tab stored meanwhile.
     * @param {Object} ended - The ending
     * @returns {Promise<boolean>} Whether a write landed
     */
    async _append(ended) {
        const ledger = this._ledger();
        await ledger.load();
        // A run's first ending stands. `recorded` only knows this session, and
        // the ring's merge lets what is in memory win over what is stored — so
        // a run re-recorded after a reload (the server's post-run re-sends land
        // with no memory of what was already banked) would replace its true
        // leftovers with a post-run snapshot rather than sit beside it.
        if (ledger.get().some((run) => run?.key === ended.key)) return false;
        return ledger.update((runs) => [ended, ...runs].slice(0, MAX_RUNS));
    }

    /**
     * The recorded endings, newest first.
     * @returns {Promise<Array<Object>>}
     */
    async runs() {
        if (!config.getSetting('labyrinthRunLedger')) return [];
        const ledger = this._ledger();
        await ledger.load();
        return ledger.get().slice();
    }
}

const labyrinthRunLedger = new LabyrinthRunLedger();
export default labyrinthRunLedger;
