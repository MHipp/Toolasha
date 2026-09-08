/**
 * Spawn Divergence Alert
 *
 * The one moment the divergence check is worth interrupting somebody for: the
 * rosters the census is recording have stopped being draws from the tables the
 * simulator was fitted to, or the tables themselves have moved underneath it.
 *
 * Deliberately not for `drifting`. Three sigma on one species out of the fifteen
 * or so a dungeon draws from, across three bands, is an event that happens by
 * chance every few zone-tiers; it belongs in the census readout where it can be
 * looked at, not in a notification. Five sigma, a species that is in no table at
 * all, a table species that never appears, or a changed fingerprint are all
 * things that do not happen by chance.
 *
 * The delivery guard is the one from `3986c7ac8`: `notify()` returns
 * `fired: false` without throwing whenever a notice reaches no channel — no
 * browser permission, no toast surface yet — and marking the finding announced
 * on that would silence it permanently, for a feature whose whole value is
 * being told once, on the day it happens.
 */

import config from '../../core/config.js';
import notificationService from '../notifications/notification-service.js';
import { alertWorthy } from './spawn-divergence.js';

/** Master switch; nothing below it is consulted while this is off. */
export const MASTER_SETTING = 'spawnCensus_divergenceAlert';

/** Prefix for the notification service's event keys. */
export const EVENT_KEY_PREFIX = 'spawn-divergence';

/** `/monsters/dodocamel` reads as `dodocamel`. */
function shortName(hrid) {
    const text = String(hrid ?? '');
    return text.slice(text.lastIndexOf('/') + 1);
}

/**
 * What one zone/tier's finding says, in one clause.
 * @param {Object} zone - A report zone entry
 * @param {Function} nameOf - Zone hrid to a display name
 * @returns {string} The clause
 */
function clauseFor(zone, nameOf) {
    const label = `${nameOf(zone.zoneHrid)} T${zone.difficultyTier}`;
    if (zone.unknownSpecies.length) {
        return `${label} spawned ${zone.unknownSpecies.map(shortName).join(', ')}, which is in no eligible table`;
    }
    if (zone.silentSpecies.length) {
        return `${label} has not spawned ${zone.silentSpecies.map(shortName).join(', ')} once in ${zone.scoredWaves.toLocaleString()} waves`;
    }
    if (zone.verdict === 'diverged' && zone.worst) {
        const direction = zone.worst.z > 0 ? 'above' : 'below';
        return `${label} draws ${shortName(zone.worst.hrid)} ${Math.abs(zone.worst.z).toFixed(1)}σ ${direction} its table`;
    }
    return `${label}'s spawn tables changed while the census was recording`;
}

class SpawnDivergenceAlert {
    constructor() {
        /** Findings already delivered, so a steady state is announced once. */
        this.announced = new Set();
    }

    /**
     * Say so, once, if a report has anything a player would act on.
     *
     * @param {{ok: boolean, zones: Array<Object>}} report - `analyzeSpawnDivergence()`'s output
     * @param {Function} [nameOf] - Zone hrid to a display name
     * @returns {Object|null} The notification service's result, or null if nothing was said
     */
    check(report, nameOf = shortName) {
        if (!config.getSetting(MASTER_SETTING)) return null;

        const worthy = alertWorthy(report);
        if (!worthy.length) return null;

        // Keyed by the finding rather than by the zone, so a census that stays
        // diverged is one notice while a *new* divergence somewhere else is
        // another. `notify()`'s own cooldown handles repetition within a key.
        const key = `${EVENT_KEY_PREFIX}:${worthy
            .map(
                (zone) =>
                    `${zone.zoneHrid}|${zone.difficultyTier}|${zone.verdict}|${zone.fingerprintChanged ? 'f' : ''}`
            )
            .sort()
            .join(' ')}`;
        if (this.announced.has(key)) return null;

        const head = clauseFor(worthy[0], nameOf);
        const rest = worthy.length > 1 ? ` (and ${worthy.length - 1} more)` : '';
        const result = notificationService.notify(
            key,
            `The spawn census no longer matches the simulator's tables: ${head}${rest}. The dungeon clear estimates may be off until the fit is redone.`,
            { title: 'Spawn tables have diverged', subject: nameOf(worthy[0].zoneHrid) }
        );

        // Only a delivered notice counts as told. Setting the guard before
        // `notify()` returned would record a finding as announced that reached
        // no channel, and this one is checked on a long throttle — the next
        // chance to say it could be an hour away, or never.
        if (result?.fired) this.announced.add(key);
        return result;
    }

    /** Forget what has been announced — a fresh census is a fresh finding. */
    reset() {
        this.announced.clear();
    }
}

const spawnDivergenceAlert = new SpawnDivergenceAlert();

export default spawnDivergenceAlert;
