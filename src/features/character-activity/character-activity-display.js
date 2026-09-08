/**
 * Character Activity Status — display model
 *
 * Everything the character-select screen decides *about* a persisted projection, with no DOM and
 * no game data behind it: the offline-cap overlay, the staleness rules, and the exact two lines
 * of text and the dot colour that go in a slot.
 *
 * Split out from `character-activity-projection.js` on purpose. That module reaches into Action
 * Time Display, which lives in the actions bundle; this one reaches nothing but the formatters,
 * so it stays cheap to import and trivial to test.
 */

import { formatActivityStatusTime, timeReadable } from '../../utils/formatters.js';
import { MAX_RECORD_AGE_MS } from './character-activity-storage.js';

/**
 * How far a character's own offline timestamp may sit past the moment we observed its queue
 * before the record is considered to describe a session that has already been superseded.
 * Both numbers come from different clocks; a few seconds of slack keeps a clean switch from
 * reading as stale.
 */
const STALE_TOLERANCE_MS = 5000;

/** Above this much runway the dot is green rather than amber. */
const ONE_HOUR_MS = 60 * 60 * 1000;

const FUTURE_LABELS = {
    action: 'Action ends',
    queue: 'Queue ends',
    materials: 'Materials run out',
    offline: 'Offline limit',
};

const PAST_LABELS = {
    action: 'Action ended',
    queue: 'Queue ended',
    materials: 'Materials ran out',
    offline: 'Offline progress stopped',
};

export const COLOR_HEX = {
    green: '#51cf66',
    yellow: '#f0a830',
    red: '#ff6b6b',
    neutral: '#888888',
};

/**
 * Resolve a persisted projection into what should actually be displayed right now, applying the
 * offline-progress-cap overlay against a freshly-observed offline timestamp — never a value
 * baked in at observation time, since while the character was still connected it had not gone
 * offline and the true offline boundary was not knowable.
 *
 * Never asserts a green/amber offline deadline across a MooPass expiry boundary: the server's
 * semantics for a pass expiring mid-offline-period are not provable from client evidence, so
 * this falls back to a neutral "unknown" rather than a false reassurance.
 * @param {Object} stored - A persisted character-activity record
 * @param {number|null} freshLastOfflineTime - Epoch ms the character last went offline, or null
 * @returns {{terminalCause: string, terminalAt: number|null, segments: Array}}
 */
export function resolveDisplayProjection(stored, freshLastOfflineTime) {
    const { segments = [], terminalCause, terminalAt = null } = stored.projection || {};

    // Already uncertain or idle at observation time — the offline cap can never turn that into a
    // safe assertion, so there is nothing to overlay.
    if (terminalCause === 'unknown' || terminalCause === 'idle') {
        return { segments, terminalCause, terminalAt };
    }

    const offlineHourCap = stored.offline?.hourCap;
    if (!(offlineHourCap > 0) || freshLastOfflineTime == null) {
        // No trustworthy cap, or no evidence the character has gone offline at all. An endless
        // chain then has no other possible deadline; a finite chain's own end still stands.
        return terminalCause === 'infinite'
            ? { segments, terminalCause: 'unknown', terminalAt: null }
            : { segments, terminalCause, terminalAt };
    }

    const mooPassExpireTime = stored.offline?.mooPassExpireTime;
    const offlineLimitAt = freshLastOfflineTime + offlineHourCap * 3600 * 1000;

    if (mooPassExpireTime != null && mooPassExpireTime > freshLastOfflineTime && mooPassExpireTime < offlineLimitAt) {
        // Only a MooPass that was still active when this offline interval started (strictly after
        // freshLastOfflineTime) and that expires before the projected cap can make the honoured
        // hours uncertain. A pass that had already expired before the interval began was never
        // active during it and cannot make a trustworthy cap ambiguous. Fail closed rather than
        // assert a deadline that assumes the full cap held.
        return terminalCause === 'infinite'
            ? { segments, terminalCause: 'unknown', terminalAt: null }
            : { segments, terminalCause, terminalAt };
    }

    if (terminalCause === 'infinite' || terminalAt === null || offlineLimitAt < terminalAt) {
        return { segments, terminalCause: 'offline', terminalAt: offlineLimitAt };
    }

    return { segments, terminalCause, terminalAt };
}

/**
 * Find whichever segment covers a given instant. Segments are stored in chronological order with
 * contiguous boundaries, so the first match walking forward is always the right one.
 * @param {Array} segments
 * @param {number} time - Epoch ms
 * @returns {{segment: Object, index: number}|null} null if every segment had already ended
 */
export function findSegmentAtTime(segments, time) {
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (segment.endAt === null || segment.endAt === undefined || segment.endAt > time) {
            return { segment, index: i };
        }
    }
    return null;
}

/**
 * The first line: what the character is doing, plus how much is queued behind it.
 * @param {Object} segment
 * @param {boolean} isPaused - Whether progress has already stopped at this segment
 * @param {number} queuedCount - Segments still behind this one
 * @returns {string}
 */
export function formatActivityLine(segment, isPaused, queuedCount) {
    let text = segment.actionName;
    if (isPaused) text += ' ⏸';
    if (queuedCount > 0) text += ` +${queuedCount} queued`;
    return text;
}

/**
 * Whether a record is too old to describe anything the player would recognise.
 *
 * Upstream leans entirely on the native `lastOfflineTime` for this, which is only available when
 * the fiber read succeeds. This fork also ages records out on their own timestamp, so a slot
 * still says something honest when the native read fails or the character has simply not been
 * played in a week.
 * @param {Object} record
 * @param {number} now - Epoch ms
 * @returns {boolean}
 */
export function isRecordExpired(record, now) {
    return !(record?.observedAt > 0) || now - record.observedAt > MAX_RECORD_AGE_MS;
}

/**
 * How long ago a record was observed, in the same rounded units the rest of the panel uses for
 * durations — so "expired" and "outdated" say something a player can act on instead of just
 * naming the state.
 * @param {number} observedAt - Epoch ms the record was last written
 * @param {number} now - Epoch ms
 * @returns {string}
 */
export function formatStaleness(observedAt, now) {
    const ageSec = Math.max(0, (now - observedAt) / 1000);
    return timeReadable(ageSec);
}

/**
 * Resolve the exact two-line display state for one character. Pure — no DOM, no storage.
 * @param {Object|null} record - `loadCharacterActivity()` result, or null if never observed
 * @param {Object} character - What is known about the slot: `{id, name, lastOfflineTime}`
 * @param {Object} prefs - Account-level date/time preferences
 * @param {number} [now]
 * @returns {{firstLineText: string, limiterColor: string, limiterText: string, actionTypeHrid: string|null}}
 */
export function computeSlotDisplayState(record, character, prefs, now = Date.now()) {
    if (!record) {
        return {
            firstLineText: 'No activity data yet',
            limiterColor: 'neutral',
            limiterText: 'Open character once to enable status',
            actionTypeHrid: null,
        };
    }

    if (isRecordExpired(record, now)) {
        return {
            firstLineText: 'Activity status expired',
            limiterColor: 'neutral',
            limiterText: `Open character to refresh · last seen ${formatStaleness(record.observedAt, now)} ago`,
            actionTypeHrid: null,
        };
    }

    const lastOfflineTime = character?.lastOfflineTime ?? null;
    if (lastOfflineTime != null && lastOfflineTime > record.observedAt + STALE_TOLERANCE_MS) {
        return {
            firstLineText: 'Activity status outdated',
            limiterColor: 'neutral',
            limiterText: `Open character to refresh · last seen ${formatStaleness(record.observedAt, now)} ago`,
            actionTypeHrid: null,
        };
    }

    const { segments, terminalCause, terminalAt } = resolveDisplayProjection(record, lastOfflineTime);

    if (terminalCause === 'idle') {
        return {
            firstLineText: 'No active action',
            limiterColor: 'red',
            limiterText: 'Character is idle',
            actionTypeHrid: null,
        };
    }

    if (terminalCause === 'unknown' || segments.length === 0) {
        const last = segments[segments.length - 1];
        return {
            firstLineText: last ? formatActivityLine(last, false, 0) : 'No active action expected',
            limiterColor: 'neutral',
            limiterText: 'End time unavailable',
            actionTypeHrid: last?.actionTypeHrid ?? null,
        };
    }

    const hasPassed = terminalAt !== null && terminalAt <= now;
    const time = formatActivityStatusTime(terminalAt, prefs, now);

    if (hasPassed) {
        if (terminalCause === 'offline') {
            const found = findSegmentAtTime(segments, terminalAt) || {
                segment: segments[segments.length - 1],
                index: segments.length - 1,
            };
            const queuedCount = segments.length - found.index - 1;
            return {
                firstLineText: formatActivityLine(found.segment, true, queuedCount),
                limiterColor: 'red',
                limiterText: `${PAST_LABELS.offline} · ${time}`,
                actionTypeHrid: found.segment?.actionTypeHrid ?? null,
            };
        }
        return {
            firstLineText: 'No active action expected',
            limiterColor: 'red',
            limiterText: `${PAST_LABELS[terminalCause]} · ${time}`,
            actionTypeHrid: null,
        };
    }

    const found = findSegmentAtTime(segments, now);
    const queuedCount = found ? segments.length - found.index - 1 : 0;
    const color = terminalAt - now > ONE_HOUR_MS ? 'green' : 'yellow';

    return {
        firstLineText: found ? formatActivityLine(found.segment, false, queuedCount) : 'No active action expected',
        limiterColor: color,
        limiterText: `${FUTURE_LABELS[terminalCause]} · ${time}`,
        actionTypeHrid: found?.segment?.actionTypeHrid ?? null,
    };
}
