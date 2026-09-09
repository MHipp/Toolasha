/**
 * Raw diagnostic trace of a guild trial's websocket stream.
 *
 * The trials feature analyses a trial through summaries — tallies, snapshots,
 * comparisons — and every one of them is a derivation. When a derived figure is
 * disputed, the only thing that settles it is the stream the derivation was made
 * from, and nothing keeps that today. This does: every trial battle message,
 * exactly as received and in order, timestamped so a reader can reconstruct the
 * timeline offline.
 *
 * Opt-in (`guildTrialDiagnosticTrace`, default off), because the file is large
 * and carries raw combat data with participant names in it.
 *
 * Persisted, not memory-only: a full-hour 50-player fight is ~36,000 ticks at
 * the observed ~10/s cadence, each tick 2–4KB of JSON — holding that as parsed
 * objects in a tab that must also render the fight is what used to make the
 * trace the thing that killed the evidence. Events are kept as pre-stringified
 * NDJSON lines, flushed to IndexedDB in gzipped chunks, and re-adopted on
 * reload, so a mid-fight refresh loses at most one flush interval instead of
 * the whole trace. Keys are character-scoped — two characters in two tabs each
 * keep their own trace.
 *
 * The websocket hook deliberately exempts `new_guild_battle` and
 * `guild_battle_updated` from its content-hash dedup (consecutive ticks open
 * with identical text), so the trace drops adjacent byte-identical
 * `guild_battle_updated` payloads itself and counts them — a trace that silently
 * kept doubles would read as twice the cadence it really had.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { compressionAvailable, gzipText, gunzipToText } from '../sync/sync-compress.js';
import { readScoped } from '../../utils/character-key.js';
import { scriptVersion } from '../../utils/script-version.js';

/** The settings toggle the capture is gated on */
export const TRACE_SETTING = 'guildTrialDiagnosticTrace';

/** What the export file names itself, so a reader knows what it is holding */
export const TRACE_FORMAT = 'toolasha-guild-trial-trace';

/**
 * Events kept across chunks before the oldest whole chunks fall off. A trial
 * hour of the 50-player firehose (~36k ticks) is well under this; the cap only
 * exists so a runaway stream cannot grow without bound.
 */
export const MAX_EVENTS = 200_000;

/**
 * Stored-bytes ceiling across chunks, enforced the same way as the event cap.
 * A full hour gzips to ~10–15MB; this is runaway protection, not a budget.
 */
export const MAX_STORED_BYTES = 64 * 1024 * 1024;

/** Pending lines that force a flush to IndexedDB */
export const FLUSH_EVENTS = 500;

/** How long pending lines may sit unflushed before the next message flushes them */
export const FLUSH_INTERVAL_MS = 10_000;

/** How recent a persisted trace must be for a reload to resume it rather than discard it */
export const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * How long a restore whose manifest read failed keeps waiting for storage before
 * it gives up and starts a fresh trace — and how many events it will hold in
 * memory meanwhile. The manifest is the index of every chunk on disk, and a
 * failed read is not "no trace": writing a new manifest over one that could not
 * be read orphans every chunk the old one named. So the trace holds its events
 * and re-probes, bounded because held events are parsed payloads in a tab that
 * also has to render the fight.
 */
export const UNKNOWN_MANIFEST_GIVE_UP_MS = 2 * 60 * 1000;
export const UNKNOWN_MANIFEST_GIVE_UP_EVENTS = 5000;

/**
 * The hard ceiling on held events, on every path — not just the unreadable
 * manifest one.
 *
 * `_retryProbe`'s bound only ever applied while the manifest was known
 * unreadable; a restore that was merely slow (a blocked IndexedDB upgrade,
 * storage pressure) held its queue with no ceiling at all, and a trial delivers
 * ~40 messages a second as live parsed payloads. Same number as the give-up
 * bound, because it is the same judgement: past this many held events the wait
 * has stopped being a wait.
 */
export const MAX_QUEUED_EVENTS = UNKNOWN_MANIFEST_GIVE_UP_EVENTS;

/**
 * The trial battle stream, verbatim. Mirrors the names `guild-trial-damage.js`
 * subscribes to: the tier-opening message (roster, tier-scaled boss — every one
 * is a boundary marker in the trace), the spectator tick firehose, the
 * end-of-trial message, and the server's own per-member totals.
 */
export const TRACE_MESSAGES = [
    'new_guild_battle',
    'guild_battle_updated',
    'end_guild_battle',
    'guild_trial_stats_updated',
];

/** The message whose absence at the head of a trace means the fight was joined late */
const BOUNDARY_MESSAGE = 'new_guild_battle';

/** Object store the chunks and manifest live in */
const TRACE_STORE = 'guildHistory';

/** Base key of the manifest record (character-scoped through writeScoped/readScoped) */
const MANIFEST_BASE = 'trialTraceManifest';

/**
 * How many orphaned chunk records one sweep will delete.
 *
 * The sweep is housekeeping running behind a restore, not a migration; a store
 * holding thousands of orphans is a bug elsewhere and deleting them all in one
 * pass would be a long run of IndexedDB deletes on the tab that has to render
 * the fight. Whatever is left is picked up by the next restore.
 */
export const MAX_ORPHAN_SWEEP_DELETES = 200;

/** Monotonic tail for traceId, so two starts in one millisecond still differ */
let traceSeq = 0;

/**
 * Base key of one chunk record.
 * @param {number} seq - The chunk's sequence number
 * @returns {string} Unscoped chunk key
 */
function chunkBase(seq) {
    return `trialTraceChunk_${seq}`;
}

/** The character a trace being started right now would belong to */
function traceCharId() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * One character's scoped key, built from an id the caller captured.
 *
 * Deliberately not `characterKey()`: that answers with whoever is current at
 * the moment it is called, and every key a trace touches — its chunks, its
 * manifest, the deletes that evict and clear them — has to belong to the
 * character the trace was started or adopted for. A flush that rebuilt its key
 * after a switch wrote one trace's chunks under two characters' keys, and the
 * manifest under whichever key was current last then named chunks that were not
 * there.
 * @param {string} base - The unscoped key
 * @param {string} charId - Whose key
 * @returns {string} `base_<charId>`
 */
function charKey(base, charId) {
    return `${base}_${charId}`;
}

/** Chunk keys belonging to one character, and the seq each one holds */
const CHUNK_KEY_RE = /^trialTraceChunk_(\d+)_(.+)$/;

class GuildTrialTrace {
    /**
     * @param {Object} [options] - Test seams; the singleton takes the defaults
     * @param {number} [options.maxEvents] - Total retained-event cap across chunks and pending
     * @param {number} [options.maxStoredBytes] - Total stored chunk bytes cap
     * @param {number} [options.flushEvents] - Pending lines that force a flush
     * @param {number} [options.flushIntervalMs] - Age of pending lines that forces a flush
     * @param {number} [options.resumeWindowMs] - How recent a persisted trace must be to resume
     * @param {number} [options.unknownGiveUpMs] - How long to wait on an unreadable manifest
     * @param {number} [options.unknownGiveUpEvents] - How many events to hold while waiting
     * @param {number} [options.maxQueuedEvents] - Hard ceiling on held events, on every path
     */
    constructor({
        maxEvents = MAX_EVENTS,
        maxStoredBytes = MAX_STORED_BYTES,
        flushEvents = FLUSH_EVENTS,
        flushIntervalMs = FLUSH_INTERVAL_MS,
        resumeWindowMs = RESUME_WINDOW_MS,
        unknownGiveUpMs = UNKNOWN_MANIFEST_GIVE_UP_MS,
        unknownGiveUpEvents = UNKNOWN_MANIFEST_GIVE_UP_EVENTS,
        maxQueuedEvents = unknownGiveUpEvents,
    } = {}) {
        this.maxEvents = maxEvents;
        this.maxStoredBytes = maxStoredBytes;
        this.flushEvents = flushEvents;
        this.flushIntervalMs = flushIntervalMs;
        this.resumeWindowMs = resumeWindowMs;
        this.unknownGiveUpMs = unknownGiveUpMs;
        this.unknownGiveUpEvents = unknownGiveUpEvents;
        this.maxQueuedEvents = maxQueuedEvents;
        this.initialized = false;
        this.handlers = null;
        this._restored = false;
        this._restorePromise = Promise.resolve();
        /** True while the manifest could not be read and the restore is still waiting on storage */
        this._manifestUnknown = false;
        this._unknownSince = 0;
        this._lastProbeAt = 0;
        this._probing = false;
        /**
         * Bumped by {@link disable}. A restore that began under the departing
         * character finds the number moved and refuses to adopt that
         * character's manifest into the arriving character's trace.
         */
        this._generation = 0;
        this._reset();
    }

    /** Empty-trace state, shared by the constructor and {@link clear} */
    _reset() {
        this.pending = []; // unflushed NDJSON lines
        this.chunks = []; // persisted chunks, oldest first: {seq, events, bytes}
        this.nextSeq = 0;
        this.storedBytes = 0;
        this.eventCount = 0; // retained events: persisted chunks + pending
        this.traceId = null;
        /**
         * Which character this trace belongs to. Set once — when a manifest is
         * adopted, or when the first event starts a fresh trace — and every key
         * the trace touches afterwards is built from it, never from whoever is
         * current at the moment of the write.
         */
        this.ownerId = null;
        this.startedAt = 0;
        this.duplicatesDiscarded = 0;
        this.eventsDropped = 0;
        this.maxGapMs = null;
        this.gapsOver5s = 0;
        this.firstEventType = null;
        this.lastEventAt = 0;
        this.lastFlushAt = 0;
        this.resumed = false;
        this.lastGuildBattleKey = null;
        this._queue = []; // messages that arrived before the restore settled
        /**
         * Held events the queue cap threw away. Kept apart from
         * {@link eventsDropped} until the restore settles: adopting a manifest
         * overwrites `eventsDropped` with the persisted number, so a drop
         * counted straight into it before that would be silently erased — the
         * one outcome worse than the drop itself.
         */
        this._queueDropped = 0;
        /**
         * Whether the trace stopped waiting for a restore that never answered
         * and started fresh. The events held meanwhile are still replayed, but
         * a persisted trace this session might have resumed was not read, so
         * anything from before this session is missing from the file.
         */
        this.restoreAbandoned = false;
        this._flushChain = Promise.resolve();
        this._flushQueued = false;
    }

    /** Whether the opt-in toggle is on right now */
    _enabled() {
        return config.getSetting(TRACE_SETTING, false);
    }

    /**
     * A key for the character this trace belongs to.
     *
     * Falls back to whoever is current only while no trace exists — the first
     * write of a trace is what fixes the owner, and there is nothing to
     * mis-file before that.
     * @param {string} base - The unscoped key
     * @returns {string} The scoped key
     */
    _key(base) {
        return charKey(base, this.ownerId || traceCharId());
    }

    /**
     * Listen for the trial stream and adopt or discard any persisted trace.
     * Capture itself stays gated on the setting per message. The restore is
     * async so it cannot block feature init; messages that arrive before it
     * settles are queued and replayed through the normal path afterwards, so an
     * early tick can never both start a fresh trace and adopt the old one.
     */
    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        this._restored = false;

        this.handlers = new Map();
        for (const type of TRACE_MESSAGES) {
            const handler = (data) => this._onMessage(type, data);
            this.handlers.set(type, handler);
            webSocketHook.on(type, handler);
        }

        this._restorePromise = this._restore()
            .catch((error) => {
                console.error('[GuildTrialTrace] Restoring the persisted trace failed:', error);
                return 'unknown';
            })
            .then((outcome) => {
                // The message path may have given up on this restore already
                // (see _abandonRestore); a late answer must not reopen the wait
                // or re-settle a trace that is running.
                if (this._restored) return;
                if (outcome === 'unknown') {
                    // The manifest could not be read. That is not "no trace": a
                    // fresh manifest written now would orphan every chunk the
                    // unreadable one names. Hold events and ask again; see
                    // _retryProbe for how long.
                    this._manifestUnknown = true;
                    this._unknownSince = Date.now();
                    this._lastProbeAt = this._unknownSince;
                    console.warn('[GuildTrialTrace] The trace manifest could not be read; holding events until it can');
                    return;
                }
                this._settleRestore(outcome === 'adopted' || outcome === 'fresh');
            });
    }

    /**
     * The restore is decided: replay what arrived meanwhile through the normal
     * path. Sequence numbers are only ever allocated from here on, so chunks
     * written after an adoption continue from the adopted manifest's last.
     *
     * @param {boolean} sweep - Whether the decision was trustworthy enough to
     *   reclaim orphaned chunks from. A restore a character switch superseded,
     *   or one that gave up on an unreadable manifest, knows nothing about
     *   which chunks are live and must not delete any.
     */
    _settleRestore(sweep) {
        this._manifestUnknown = false;
        this._restored = true;
        // After the restore, never before: an adoption has just overwritten
        // eventsDropped with the manifest's number
        this.eventsDropped += this._queueDropped;
        this._queueDropped = 0;
        const queued = this._queue;
        this._queue = [];
        for (const message of queued) this._record(message.type, message.data, message.at);
        // The manifest in hand is the authority on which chunks are live, so
        // this is the one moment orphans can be told apart from a trace that is
        // simply not adopted yet. Behind the flush chain, so the replay's own
        // chunks are on disk and in `this.chunks` before the sweep looks.
        if (!sweep) return;
        const owner = this.ownerId || traceCharId();
        this._flushChain = this._flushChain.then(() => this._sweepOrphanChunks(owner));
    }

    /**
     * Ask storage for the manifest again, from a message that arrived while it
     * was unknown. Rate-limited to the flush interval, and bounded: past
     * `unknownGiveUpMs` or `unknownGiveUpEvents` held, the trace gives up and
     * starts fresh — logged, because that fresh manifest may be orphaning chunks.
     */
    _retryProbe() {
        if (!this._manifestUnknown) return;
        if (this._probing) {
            // A probe that has been out long enough for the hold to overflow is
            // not coming back: a read that hangs rather than fails resolves
            // nothing, so neither this probe's `then` nor its `finally` ever
            // runs and `_probing` would latch for the rest of the session.
            if (this._queueDropped > 0) this._abandonRestore();
            return;
        }
        const now = Date.now();
        const overdue =
            now - this._unknownSince >= this.unknownGiveUpMs || this._queue.length >= this.unknownGiveUpEvents;
        if (!overdue && now - this._lastProbeAt < this.flushIntervalMs) return;

        this._probing = true;
        this._lastProbeAt = now;
        this._restorePromise = this._restore()
            .catch((error) => {
                console.error('[GuildTrialTrace] Re-reading the trace manifest failed:', error);
                return 'unknown';
            })
            .then((outcome) => {
                if (!this._manifestUnknown) return; // cleared meanwhile
                if (outcome === 'unknown') {
                    if (!overdue) return;
                    console.warn(
                        `[GuildTrialTrace] The trace manifest stayed unreadable for ${Math.round(
                            (Date.now() - this._unknownSince) / 1000
                        )}s with ${this._queue.length} events held; starting a fresh trace`
                    );
                }
                this._settleRestore(outcome === 'adopted' || outcome === 'fresh');
            })
            .finally(() => {
                this._probing = false;
            });
    }

    /**
     * Settles once any persisted trace has been adopted or discarded and the
     * queued early messages have been replayed.
     * @returns {Promise<void>}
     */
    whenReady() {
        return this._restorePromise;
    }

    /** Let go of every listener. The buffer and the persisted chunks are kept — an export can still read them. */
    cleanup() {
        if (this.handlers) {
            for (const [type, handler] of this.handlers) webSocketHook.off(type, handler);
            this.handlers = null;
        }
        this.initialized = false;
    }

    /**
     * Stand the departing character's trace down, on a character switch.
     *
     * `cleanup()` alone is not enough: it keeps the trace in memory, and
     * `_restore()` short-circuits on a trace already in hand, so the arriving
     * character's `initialize()` used to skip its own manifest entirely and
     * carry on appending to the departing character's trace — one traceId, one
     * event stream, two characters' fights in it, and the arriving character's
     * own persisted trace never read.
     *
     * The departing character's pending lines are flushed first, under their
     * keys, so nothing captured before the switch is lost; the persisted chunks
     * stay on disk for that character's next session to resume.
     * @returns {Promise<void>}
     */
    async disable() {
        this.cleanup();
        this._generation++;
        try {
            // Any restore in flight settles (refusing to adopt, now that the
            // generation has moved) before the flush that follows it
            await this._settle();
            this._scheduleFlush();
            await this._settle();
        } catch (error) {
            console.error('[GuildTrialTrace] Standing the trace down failed:', error);
        }
        this._reset();
        this._restored = false;
        this._manifestUnknown = false;
    }

    /**
     * Read the persisted manifest: resume a trace whose stream went quiet less
     * than the resume window ago, delete anything older. A live in-memory trace
     * (re-initialize without a reload) is never overwritten.
     *
     * A read that could not be made is told apart from "no manifest": the first
     * answers `'unknown'` and the caller waits; only a trustworthy absence goes
     * on to the legacy-adoption read and a fresh start.
     * @returns {Promise<'adopted'|'fresh'|'unknown'|'stale'>} What was decided; `'stale'`
     *   means a character switch superseded this read and nothing was adopted
     */
    async _restore() {
        if (this.traceId) return 'fresh';
        // Captured before the first read; every key below is built from it, and
        // a switch landing inside the reads stands the adoption down rather
        // than handing the departing character's trace to the arriving one.
        const charId = traceCharId();
        const started = this._generation;
        const stale = () => this._generation !== started || traceCharId() !== charId;

        const probe = await storage.tryGet(charKey(MANIFEST_BASE, charId), TRACE_STORE);
        if (stale()) return 'stale';
        if (probe === null) return 'unknown';
        const manifest = probe.found ? probe.value : await readScoped(MANIFEST_BASE, TRACE_STORE, null);
        if (stale()) return 'stale';
        if (!manifest) return 'fresh';

        const fresh =
            typeof manifest.lastEventAt === 'number' && Date.now() - manifest.lastEventAt <= this.resumeWindowMs;
        if (!fresh) {
            for (const seq of manifest.chunkSeqs || []) {
                await storage.delete(charKey(chunkBase(seq), charId), TRACE_STORE);
            }
            await storage.delete(charKey(MANIFEST_BASE, charId), TRACE_STORE);
            return stale() ? 'stale' : 'fresh';
        }
        if (stale()) return 'stale';

        const stats = Array.isArray(manifest.chunkStats)
            ? manifest.chunkStats
            : (manifest.chunkSeqs || []).map((seq) => ({ seq, events: 0, bytes: 0 }));
        this.chunks = stats.map((chunk) => ({
            seq: chunk.seq,
            events: chunk.events || 0,
            bytes: chunk.bytes || 0,
        }));
        this.storedBytes = this.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
        // Recomputed from the chunks rather than read back: pending lines the
        // old tab had not flushed died with it and must not be counted
        this.eventCount = this.chunks.reduce((sum, chunk) => sum + chunk.events, 0);
        this.nextSeq = this.chunks.length ? Math.max(...this.chunks.map((chunk) => chunk.seq)) + 1 : 0;
        this.ownerId = charId;
        this.traceId = manifest.traceId;
        this.startedAt = manifest.startedAt || 0;
        this.duplicatesDiscarded = manifest.duplicatesDiscarded || 0;
        this.eventsDropped = manifest.eventsDropped || 0;
        this.restoreAbandoned = Boolean(manifest.restoreAbandoned);
        this.maxGapMs = typeof manifest.maxGapMs === 'number' ? manifest.maxGapMs : null;
        this.gapsOver5s = manifest.gapsOver5s || 0;
        this.firstEventType = manifest.firstEventType || null;
        this.lastEventAt = manifest.lastEventAt;
        this.lastFlushAt = Date.now();
        this.resumed = true;
        return 'adopted';
    }

    /**
     * One message off the stream. Gated on the setting at message time rather
     * than at subscribe time, so turning the toggle off mid-session stops the
     * capture without discarding what is already held, and turning it on starts
     * one without a re-init.
     *
     * @param {string} type - The message name
     * @param {Object} data - The payload, exactly as the hook delivered it
     */
    _onMessage(type, data) {
        try {
            if (!this._enabled()) return;
            if (!this._restored) {
                // The restore has not settled: hold the message with its real
                // arrival time so replaying it cannot start a trace the restore
                // is about to adopt over
                this._queue.push({ type, data, at: Date.now() });
                const dropped = this._enforceQueueCap();
                if (this._manifestUnknown) this._retryProbe();
                // The hold is full and still overflowing: the restore in flight
                // has had a whole cap's worth of messages to answer in and has
                // not, so stop waiting for it and record.
                else if (dropped) this._abandonRestore();
                return;
            }
            this._record(type, data, Date.now());
        } catch (error) {
            console.error('[GuildTrialTrace] Recording a trial message failed:', error);
        }
    }

    /**
     * Hold the queue to {@link maxQueuedEvents}, dropping the oldest held
     * events and counting them.
     *
     * Oldest rather than newest, and dropping rather than refusing to hold at
     * all, because this is a diagnostic recorder: losing some events is
     * acceptable, wedging the tab the fight is being rendered in is not, and a
     * trace with an unmarked hole in it is worse than either. The same
     * judgement the chunk eviction already makes — keep the recent fight, count
     * what went — so the two overflow paths cannot disagree about what a full
     * trace does. Dropping the oldest also lands on the honest header: the
     * replay's first event is then no longer the tier-opening message, so
     * `startedMidFight` reads true by itself.
     *
     * @returns {boolean} Whether anything was dropped — the signal both waiting
     *   paths use to decide the restore is never going to answer
     */
    _enforceQueueCap() {
        if (this._queue.length <= this.maxQueuedEvents) return false;
        const excess = this._queue.length - this.maxQueuedEvents;
        this._queue.splice(0, excess);
        this._queueDropped += excess;
        return true;
    }

    /**
     * Stop waiting for a restore that has not answered, and record.
     *
     * Reached from either waiting path, on one signal: the hold is full and
     * has started dropping. A read that hangs rather than fails resolves
     * nothing, so no `.then` of ours ever runs and the wait would otherwise be
     * forever. At the observed ~40 messages a second, a full hold is over two
     * minutes of silence from storage — long past the point where the events
     * still arriving matter more than the ones on disk.
     *
     * The generation bump is the refusal {@link disable} uses: a restore that
     * began before this point checks the generation before it touches any
     * state, so a late answer cannot adopt a manifest into the fresh trace now
     * being recorded — nor may the sweep run, since nothing trustworthy is
     * known about which chunks are live. The restore promise is replaced with a
     * settled one so an export is not left awaiting the same hung read.
     */
    _abandonRestore() {
        console.warn(
            `[GuildTrialTrace] The trace restore did not settle with ${this._queue.length} events held; starting a fresh trace`
        );
        this.restoreAbandoned = true;
        this._generation++;
        this._probing = false;
        this._restorePromise = Promise.resolve();
        this._settleRestore(false);
    }

    /**
     * Keep one message: dedup, count, stringify once, and flush when due.
     * @param {string} type - The message name
     * @param {Object} data - The payload
     * @param {number} at - When the message arrived
     */
    _record(type, data, at) {
        try {
            if (!this.traceId) {
                // The trace starts on the first trial event, whatever it is — a
                // spectator joining mid-fight still gets a trace, and the file
                // says so via startedMidFight
                this.traceId = `${at.toString(36)}-${(traceSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                this.ownerId = traceCharId();
                this.startedAt = at;
                this.lastFlushAt = at;
            }

            if (type === 'guild_battle_updated') {
                // Drop an exact repeat of the previous tick: the hook exempts
                // this message from its own dedup (consecutive ticks open with
                // identical text), so byte-identity here is the only filter.
                // Only ticks — two identical lifecycle messages are two events.
                let key = null;
                try {
                    key = JSON.stringify(data);
                } catch {
                    // Unserializable payload: keep it rather than guess
                }
                if (key !== null && key === this.lastGuildBattleKey) {
                    this.duplicatesDiscarded++;
                    return;
                }
                if (key !== null) this.lastGuildBattleKey = key;
            }

            if (this.lastEventAt) {
                // Stalls in the feed, tracked as the stream goes by — a reader
                // trusting tick cadence needs to know where it went quiet (tab
                // throttled, fight view closed, page reloaded)
                const gap = at - this.lastEventAt;
                if (this.maxGapMs === null || gap > this.maxGapMs) this.maxGapMs = gap;
                if (gap > 5000) this.gapsOver5s++;
            }
            if (!this.firstEventType) this.firstEventType = type;

            this.pending.push(JSON.stringify({ at, rel: at - this.startedAt, type, payload: data }));
            this.eventCount++;
            this.lastEventAt = at;

            // A write failure keeps lines pending for a retry; do not let a dead
            // IndexedDB grow the buffer past the cap the chunks are held to
            if (this.pending.length > this.maxEvents) {
                const excess = this.pending.length - this.maxEvents;
                this.pending.splice(0, excess);
                this.eventsDropped += excess;
                this.eventCount -= excess;
            }

            if (
                this.pending.length >= this.flushEvents ||
                at - this.lastFlushAt >= this.flushIntervalMs ||
                type === 'end_guild_battle'
            ) {
                this._scheduleFlush();
            }
        } catch (error) {
            console.error('[GuildTrialTrace] Recording a trial message failed:', error);
        }
    }

    /** Queue one flush behind any in flight. Never throws into the message handler. */
    _scheduleFlush() {
        if (this._flushQueued) return;
        this._flushQueued = true;
        this._flushChain = this._flushChain
            .then(() => {
                this._flushQueued = false;
                return this._flushNow();
            })
            .catch((error) => console.error('[GuildTrialTrace] Flushing the trace failed:', error));
    }

    /** Write pending lines out as one chunk, evict over caps, update the manifest. */
    async _flushNow() {
        const lines = this.pending;
        if (lines.length) {
            this.pending = [];
            const seq = this.nextSeq++;
            const text = lines.join('\n');
            try {
                const gz = compressionAvailable();
                const data = gz ? await gzipText(text) : text;
                const bytes = gz ? data.byteLength : text.length;
                const ok = await storage.set(
                    this._key(chunkBase(seq)),
                    { seq, events: lines.length, gz, data },
                    TRACE_STORE,
                    true
                );
                if (!ok) throw new Error('storage refused the chunk write');
                this.chunks.push({ seq, events: lines.length, bytes });
                this.storedBytes += bytes;
            } catch (error) {
                console.error('[GuildTrialTrace] Persisting a trace chunk failed:', error);
                // Back into pending, ahead of anything recorded meanwhile — the
                // next flush retries, and capture never stops over a bad write
                this.pending = lines.concat(this.pending);
                this.lastFlushAt = Date.now();
                return;
            }
        }
        await this._evictOverCaps();
        await this._writeManifest();
        this.lastFlushAt = Date.now();
    }

    /**
     * Drop the oldest whole chunks while either cap is exceeded, counting their
     * events as dropped. The newest chunk is always kept — an overflowed trace
     * should hold the recent fight, and the count says the file is a window.
     */
    async _evictOverCaps() {
        while (this.chunks.length > 1 && (this.eventCount > this.maxEvents || this.storedBytes > this.maxStoredBytes)) {
            const oldest = this.chunks.shift();
            this.eventCount -= oldest.events;
            this.eventsDropped += oldest.events;
            this.storedBytes -= oldest.bytes;
            try {
                await storage.delete(this._key(chunkBase(oldest.seq)), TRACE_STORE);
            } catch (error) {
                console.error('[GuildTrialTrace] Evicting an old trace chunk failed:', error);
            }
        }
    }

    /** Persist the trace's identity and counters so a reload can pick it back up. */
    async _writeManifest() {
        try {
            await storage.set(
                this._key(MANIFEST_BASE),
                {
                    traceId: this.traceId,
                    startedAt: this.startedAt,
                    chunkSeqs: this.chunks.map((chunk) => chunk.seq),
                    chunkStats: this.chunks.map((chunk) => ({ ...chunk })),
                    storedBytes: this.storedBytes,
                    eventCount: this.eventCount,
                    duplicatesDiscarded: this.duplicatesDiscarded,
                    eventsDropped: this.eventsDropped,
                    restoreAbandoned: this.restoreAbandoned,
                    maxGapMs: this.maxGapMs,
                    gapsOver5s: this.gapsOver5s,
                    firstEventType: this.firstEventType,
                    lastEventAt: this.lastEventAt,
                    resumed: this.resumed,
                },
                TRACE_STORE,
                true
            );
        } catch (error) {
            console.error('[GuildTrialTrace] Writing the trace manifest failed:', error);
        }
    }

    /** Settle the restore and every flush queued so far, including ones queued while waiting. */
    async _settle() {
        await this._restorePromise;
        let chain;
        do {
            chain = this._flushChain;
            await chain;
        } while (chain !== this._flushChain);
    }

    /**
     * Whether the trace caught the fight already running.
     *
     * The tier-opening message is the only boundary marker on the stream, so a
     * trace that does not begin with one started mid-fight. Null until anything
     * at all has been seen — an empty trace has not started anywhere.
     *
     * One derivation shared by the export header and {@link status}, so the file
     * and the button can never disagree about it.
     *
     * @returns {boolean|null}
     */
    _startedMidFight() {
        return this.firstEventType ? this.firstEventType !== BOUNDARY_MESSAGE : null;
    }

    /**
     * How much has been traced, and how well. Counts persisted chunks plus the
     * unflushed pending lines.
     *
     * The quality fields are the same five the export header carries, and they
     * are here for the same reason they are there: a count of events says how
     * *much* was captured and nothing about whether it can be trusted. A trace
     * with a forty-second hole in it, or one that began halfway through a fight,
     * has an event count that looks perfectly healthy. Somebody deciding whether
     * to keep a recording should be able to see that before they close the tab,
     * not after they open the file.
     *
     * @returns {{running: boolean, eventCount: number, heldCount: number, duplicatesDiscarded: number,
     *   eventsDropped: number, traceId: string|null, startedAt: number|null, maxGapMs: number|null,
     *   gapsOver5s: number, startedMidFight: boolean|null, resumedAcrossReloads: boolean,
     *   restoreAbandoned: boolean, chunkCount: number}}
     */
    status() {
        return {
            running: Boolean(this.initialized && this.traceId && this._enabled()),
            eventCount: this.eventCount,
            // Events held back while the persisted manifest could not be read
            heldCount: this._queue.length,
            duplicatesDiscarded: this.duplicatesDiscarded,
            // Held drops included before the restore has folded them in, so the
            // number never dips while the wait is what is doing the dropping
            eventsDropped: this.eventsDropped + this._queueDropped,
            traceId: this.traceId,
            startedAt: this.startedAt || null,
            maxGapMs: this.maxGapMs,
            gapsOver5s: this.gapsOver5s,
            startedMidFight: this._startedMidFight(),
            resumedAcrossReloads: this.resumed,
            restoreAbandoned: this.restoreAbandoned,
            chunkCount: this.chunks.length,
        };
    }

    /**
     * The id of the trace in hand — active or held after the setting went off —
     * or null when nothing has been traced. The summary export stamps this so
     * the two files can be paired.
     * @returns {string|null}
     */
    activeTraceId() {
        return this.traceId;
    }

    /**
     * Throw the trace away, in memory and in IndexedDB. The next trial event
     * starts a fresh one, with a new id.
     * @returns {Promise<void>}
     */
    async clear() {
        try {
            await this._settle();
        } catch {
            // A wedged flush must not make the trace unclearable
        }
        const seqs = this.chunks.map((chunk) => chunk.seq);
        const owner = this.ownerId || traceCharId();
        const restored = this._restored;
        this._reset();
        this._restored = restored;
        // Whatever the unreadable manifest named is being thrown away anyway;
        // there is nothing left to wait for
        if (this._manifestUnknown) {
            this._manifestUnknown = false;
            this._restored = true;
        }
        try {
            for (const seq of seqs) await storage.delete(charKey(chunkBase(seq), owner), TRACE_STORE);
            await storage.delete(charKey(MANIFEST_BASE, owner), TRACE_STORE);
        } catch (error) {
            console.error('[GuildTrialTrace] Clearing the persisted trace failed:', error);
        }
        // "Throw the trace away" has to mean the bytes too, or a clear run to
        // free space leaves the orphans behind — the very records nothing else
        // reclaims
        await this._sweepOrphanChunks(owner);
    }

    /**
     * Delete this character's chunk records that no manifest names any more.
     *
     * A chunk is only reachable through the manifest, so one the manifest has
     * forgotten is unreadable weight that still counts against the store's
     * budget — and nothing else reclaims it. `clear()` deletes what the manifest
     * names, eviction walks `this.chunks`, and a chunk that fell out of both
     * (a write that landed after the manifest write failed, or anything the
     * pre-`ownerId` key drift left under the wrong character) was never
     * mentioned again.
     *
     * Only ever this character's keys: another character's chunks are theirs to
     * reclaim on their own restore, and their manifest is not readable from
     * here to decide with. Bounded by {@link MAX_ORPHAN_SWEEP_DELETES}, and the
     * live chunk list is re-read before every delete so a flush that lands
     * during the sweep cannot have its chunk swept out from under it.
     *
     * @param {string} charId - Whose chunks to sweep
     * @returns {Promise<number>} How many records were deleted
     */
    async _sweepOrphanChunks(charId) {
        let deleted = 0;
        try {
            const keys = await storage.getAllKeys(TRACE_STORE);
            if (!Array.isArray(keys)) return 0;
            let skipped = 0;
            for (const key of keys) {
                const match = typeof key === 'string' ? CHUNK_KEY_RE.exec(key) : null;
                if (!match || match[2] !== charId) continue;
                // The owner moved on: `this.chunks` is now some other
                // character's list and cannot say what is orphaned here
                if (this.ownerId && this.ownerId !== charId) break;
                const seq = Number(match[1]);
                if (this.chunks.some((chunk) => chunk.seq === seq)) continue;
                if (deleted >= MAX_ORPHAN_SWEEP_DELETES) {
                    skipped++;
                    continue;
                }
                await storage.delete(key, TRACE_STORE);
                deleted++;
            }
            if (skipped > 0) {
                console.warn(
                    `[GuildTrialTrace] Reclaimed ${deleted} orphaned trace chunks; ${skipped} left for the next restore`
                );
            }
        } catch (error) {
            console.error('[GuildTrialTrace] Sweeping orphaned trace chunks failed:', error);
        }
        return deleted;
    }

    /**
     * The trace metadata a reader needs to trust the stream: which script
     * produced it, against which server, how many repeated ticks were dropped,
     * whether the caps trimmed anything, where the stream went quiet, whether
     * the first event caught the fight already in progress, and whether the
     * trace was stitched back together across a reload.
     * @returns {Object} The metadata object, without events
     */
    _buildMetadata() {
        const host = typeof location !== 'undefined' ? location.hostname || null : null;
        return {
            format: TRACE_FORMAT,
            version: 2,
            traceId: this.traceId,
            toolashaVersion: scriptVersion(),
            host,
            isTestServer: host ? host.includes('test.') : null,
            recordedAt: this.startedAt || null,
            exportedAt: Date.now(),
            eventCount: this.eventCount,
            duplicatesDiscarded: this.duplicatesDiscarded,
            eventsDropped: this.eventsDropped + this._queueDropped,
            maxGapMs: this.maxGapMs,
            gapsOver5s: this.gapsOver5s,
            // The tier-opening message is the only boundary marker; a trace that
            // does not begin with one caught the fight already running
            startedMidFight: this._startedMidFight(),
            resumedAcrossReloads: this.resumed,
            // The restore never answered and the trace started fresh: whatever
            // was persisted before this session is not in the file
            restoreAbandoned: this.restoreAbandoned,
            chunkCount: this.chunks.length,
        };
    }

    /**
     * The whole trace as NDJSON: the metadata object on the first line, then
     * one JSON line per event — persisted chunks stitched back in order, the
     * unflushed pending lines after them. A reader can stream a large file line
     * by line rather than parsing one giant object.
     * @returns {Promise<string>}
     */
    async buildTraceNdjson() {
        await this._settle();
        const parts = [JSON.stringify(this._buildMetadata())];
        for (const chunk of this.chunks) {
            try {
                const record = await storage.get(this._key(chunkBase(chunk.seq)), TRACE_STORE, null);
                if (!record) {
                    console.error(`[GuildTrialTrace] Trace chunk ${chunk.seq} is missing from storage`);
                    continue;
                }
                const text = record.gz ? await gunzipToText(record.data) : record.data;
                if (text) parts.push(text);
            } catch (error) {
                console.error(`[GuildTrialTrace] Reading trace chunk ${chunk.seq} failed:`, error);
            }
        }
        for (const line of this.pending) parts.push(line);
        return parts.join('\n') + '\n';
    }

    /**
     * Write the trace out as a file — gzipped NDJSON where the environment can
     * compress, plain NDJSON where it cannot. The trace is kept afterwards; a
     * second press downloads the same trace again.
     * @returns {Promise<boolean>} Whether there was anything to write
     */
    async exportTrace() {
        try {
            await this._settle();
            if (!this.eventCount) return false;
            const text = await this.buildTraceNdjson();
            const gzip = compressionAvailable();
            const content = gzip ? await gzipText(text) : text;
            const type = gzip ? 'application/gzip' : 'application/x-ndjson';
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const name = `toolasha-trial-trace-${stamp}.ndjson${gzip ? '.gz' : ''}`;

            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            link.click();
            URL.revokeObjectURL(url);
            return true;
        } catch (error) {
            console.error('[GuildTrialTrace] Writing the trace failed:', error);
            return false;
        }
    }
}

/**
 * A gap, in the coarsest unit that still says how bad it was.
 *
 * Whole seconds up to ninety, whole minutes past that. A hole in the feed is
 * measured to nothing like that precision — it is bounded by two arrival times
 * and everything between them is unknown — so "40s" is the honest shape and
 * "40.317s" would be a claim about the missing part.
 *
 * @param {number} ms - Milliseconds
 * @returns {string} e.g. `40s`, `4m`
 */
export function formatGap(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 90) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
}

/**
 * What a trace's status reads as, for the button that offers to download it.
 *
 * Every line is one of the quality fields, worded as the consequence rather
 * than as the field: a reader deciding whether this recording is worth keeping
 * cares that the opening of the tier is missing, not that `startedMidFight` is
 * true. Silent about a field with nothing to report — a trace with no gaps says
 * nothing about gaps rather than "0 gaps", because a clean recording should read
 * as short.
 *
 * Pure, so the wording can be tested without a DOM or a stream.
 *
 * @param {Object|null} status - From {@link GuildTrialTrace#status}
 * @returns {string} Lines, newline-separated; empty when nothing has been traced
 */
export function describeTraceStatus(status) {
    if (!status?.traceId) return '';

    const lines = [];
    const chunks = status.chunkCount === 1 ? '1 stored chunk' : `${status.chunkCount || 0} stored chunks`;
    lines.push(`${status.running ? 'Recording' : 'Held, not recording'} — ${chunks}.`);

    if (status.gapsOver5s > 0) {
        const gaps = status.gapsOver5s === 1 ? '1 gap over 5s' : `${status.gapsOver5s} gaps over 5s`;
        const longest = Number.isFinite(status.maxGapMs) ? `, longest ${formatGap(status.maxGapMs)}` : '';
        lines.push(`${gaps}${longest} — the stream went quiet there and the events are simply absent.`);
    }
    if (status.eventsDropped > 0) {
        const dropped =
            status.eventsDropped === 1 ? '1 event was dropped' : `${status.eventsDropped} events were dropped`;
        lines.push(`${dropped} to keep the recording bounded — the file is a window, not the whole stream.`);
    }
    if (status.startedMidFight === true) {
        lines.push('Started mid-fight, so the opening of the tier is not in the file.');
    }
    if (status.restoreAbandoned) {
        lines.push('Gave up waiting for stored trace data, so anything from before this session is missing.');
    }
    if (status.resumedAcrossReloads) {
        lines.push('Stitched back together across a page reload.');
    }

    return lines.join('\n');
}

/**
 * The scoreboard's one-line warning about a hole in the recording, or nothing.
 *
 * Deliberately *not* about attribution coverage, which the damage module
 * accounts for separately and by a different measure: coverage is about which
 * ticks could be split out across players, and this is about ticks that never
 * arrived at all. Conflating them would let a fully-covered attribution look
 * unaffected by a forty-second hole in the feed it was computed from.
 *
 * Only while a trace is actually running. A trace held from an earlier session,
 * or the feature switched off, describes a recording the numbers on screen were
 * not computed from, and warning about it would be warning about nothing.
 *
 * @param {Object|null} status - From {@link GuildTrialTrace#status}
 * @returns {string} The line, or '' when there is nothing to warn about
 */
export function traceGapWarning(status) {
    if (!status?.running) return '';
    if (!(status.gapsOver5s > 0)) return '';
    if (!Number.isFinite(status.maxGapMs)) return '';

    return `recording gap ${formatGap(status.maxGapMs)} — attribution may undercount`;
}

const guildTrialTrace = new GuildTrialTrace();

export default guildTrialTrace;
export { guildTrialTrace, GuildTrialTrace };
