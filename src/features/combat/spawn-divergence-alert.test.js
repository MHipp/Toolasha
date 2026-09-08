/**
 * Tests for the spawn-divergence notice, and above all for its delivery guard:
 * the finding is marked announced only once `notify()` says it reached
 * somebody. See `3986c7ac8` for what the other order cost.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { spawnCensus_divergenceAlert: true },
    notifyCalls: [],
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (id) => mocks.settings[id] },
}));

vi.mock('../notifications/notification-service.js', () => ({
    default: {
        notify: (eventKey, message, options) => {
            mocks.notifyCalls.push({ eventKey, message, options });
            return mocks.notifyResult;
        },
    },
}));

const { default: spawnDivergenceAlert } = await import('./spawn-divergence-alert.js');

/** A report zone entry with sensible defaults. */
function zone(overrides = {}) {
    return {
        zoneHrid: '/actions/combat/chimerical_den',
        difficultyTier: 2,
        verdict: 'consistent',
        waves: 1204,
        scoredWaves: 1204,
        fingerprintChanged: false,
        unknownSpecies: [],
        silentSpecies: [],
        worst: null,
        bands: [],
        ...overrides,
    };
}

/** A report around one or more zone entries. */
function report(...zones) {
    return { ok: true, zones };
}

const NAMES = { '/actions/combat/chimerical_den': 'Chimerical Den', '/actions/combat/pirate_cove': 'Pirate Cove' };
const nameOf = (hrid) => NAMES[hrid] ?? hrid;

beforeEach(() => {
    mocks.settings = { spawnCensus_divergenceAlert: true };
    mocks.notifyCalls = [];
    mocks.notifyResult = { fired: true, channels: ['toast'] };
    spawnDivergenceAlert.reset();
});

describe('what it says nothing about', () => {
    test('the setting off', () => {
        mocks.settings.spawnCensus_divergenceAlert = false;
        expect(spawnDivergenceAlert.check(report(zone({ verdict: 'diverged' })))).toBeNull();
        expect(mocks.notifyCalls).toEqual([]);
    });

    test('a consistent census', () => {
        expect(spawnDivergenceAlert.check(report(zone()))).toBeNull();
        expect(mocks.notifyCalls).toEqual([]);
    });

    test('a merely drifting one — three sigma on one species is not news', () => {
        expect(spawnDivergenceAlert.check(report(zone({ verdict: 'drifting' })))).toBeNull();
        expect(mocks.notifyCalls).toEqual([]);
    });

    test('a report that could not be computed', () => {
        expect(spawnDivergenceAlert.check({ ok: false, reason: 'evicted', zones: [] })).toBeNull();
        expect(mocks.notifyCalls).toEqual([]);
    });
});

describe('what it does say', () => {
    test('a diverged species, once', () => {
        const diverged = report(
            zone({ verdict: 'diverged', worst: { hrid: '/monsters/dodocamel', z: 6.4, observed: 900, expected: 0.5 } })
        );

        expect(spawnDivergenceAlert.check(diverged, nameOf)?.fired).toBe(true);
        expect(mocks.notifyCalls).toHaveLength(1);
        expect(mocks.notifyCalls[0].message).toContain('Chimerical Den T2 draws dodocamel 6.4σ above its table');
        expect(mocks.notifyCalls[0].options.title).toBe('Spawn tables have diverged');

        expect(spawnDivergenceAlert.check(diverged, nameOf)).toBeNull();
        expect(mocks.notifyCalls).toHaveLength(1);
    });

    test('a species in no table, named', () => {
        spawnDivergenceAlert.check(
            report(zone({ verdict: 'diverged', unknownSpecies: ['/monsters/gobo_chef'] })),
            nameOf
        );
        expect(mocks.notifyCalls[0].message).toContain('spawned gobo_chef, which is in no eligible table');
    });

    test('a changed fingerprint, even while the counts still fit', () => {
        spawnDivergenceAlert.check(report(zone({ fingerprintChanged: true })), nameOf);
        expect(mocks.notifyCalls[0].message).toContain(
            "Chimerical Den T2's spawn tables changed while the census was recording"
        );
    });

    test('and counts the rest rather than sending one notice each', () => {
        spawnDivergenceAlert.check(
            report(
                zone({ verdict: 'diverged', unknownSpecies: ['/monsters/gobo_chef'] }),
                zone({ zoneHrid: '/actions/combat/pirate_cove', difficultyTier: 1, fingerprintChanged: true })
            ),
            nameOf
        );
        expect(mocks.notifyCalls).toHaveLength(1);
        expect(mocks.notifyCalls[0].message).toContain('(and 1 more)');
    });

    test('a new finding elsewhere is its own notice', () => {
        const first = zone({ verdict: 'diverged', unknownSpecies: ['/monsters/gobo_chef'] });
        spawnDivergenceAlert.check(report(first), nameOf);
        spawnDivergenceAlert.check(
            report(first, zone({ zoneHrid: '/actions/combat/pirate_cove', fingerprintChanged: true })),
            nameOf
        );
        expect(mocks.notifyCalls).toHaveLength(2);
    });
});

describe('the delivery guard', () => {
    test('a notice that reached no channel is retried, not swallowed', () => {
        const diverged = report(zone({ verdict: 'diverged', unknownSpecies: ['/monsters/gobo_chef'] }));

        mocks.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        expect(spawnDivergenceAlert.check(diverged, nameOf).fired).toBe(false);
        expect(mocks.notifyCalls).toHaveLength(1);

        // The same finding, the next time the check runs. Nothing was announced,
        // so it must be offered to the service again.
        expect(spawnDivergenceAlert.check(diverged, nameOf).fired).toBe(false);
        expect(mocks.notifyCalls).toHaveLength(2);

        mocks.notifyResult = { fired: true, channels: ['toast'] };
        expect(spawnDivergenceAlert.check(diverged, nameOf).fired).toBe(true);
        expect(mocks.notifyCalls).toHaveLength(3);

        // And now it is told, so it stops.
        expect(spawnDivergenceAlert.check(diverged, nameOf)).toBeNull();
        expect(mocks.notifyCalls).toHaveLength(3);
    });

    test('a digested notice counts as told', () => {
        mocks.notifyResult = { fired: true, channels: ['digest'], reason: 'digested' };
        const diverged = report(zone({ verdict: 'diverged', unknownSpecies: ['/monsters/gobo_chef'] }));

        spawnDivergenceAlert.check(diverged, nameOf);
        spawnDivergenceAlert.check(diverged, nameOf);
        expect(mocks.notifyCalls).toHaveLength(1);
    });
});
