/**
 * Tests for the watchlist price-target alert.
 *
 * The value under watch — "the ask is under 4.2M" — stays true for as long as
 * somebody is listing there, so every case that matters is about the *crossing*:
 * the first sighting that says so, the same sighting replayed, the price moving
 * back and returning, and the target moved under a pin that had already been
 * announced.
 *
 * The freshness rule gets its own block, because it is the whole reason this
 * alert reads the pooled dataset rather than the price panel's own cache: a
 * sighting older than the cache window proves nothing and must fire nothing,
 * and every message has to carry the sighting's real age.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const NOW = new Date('2026-01-01T12:00:00Z').getTime();
const CACHE_DURATION = 15 * 60 * 1000;
const POOLED_HISTORY_SETTING = 'market_pooledHistory';

const game = vi.hoisted(() => ({
    settings: {},
    pins: [],
    /** `itemHrid:level` → the rows `fetchHistory` hands back */
    history: {},
    fetched: [],
    dmHandlers: {},
    notified: [],
    /** Reaches handed to the watchlist for the aftermath record */
    reaches: [],
    fired: true,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { CACHE_DURATION: 15 * 60 * 1000 },
}));
vi.mock('../market/mooket/market-history-api.js', () => ({
    default: {
        fetchHistory: async (itemHrid, enhancementLevel) => {
            game.fetched.push(`${itemHrid}:${enhancementLevel}`);
            return game.history[`${itemHrid}:${enhancementLevel}`] || [];
        },
    },
}));
vi.mock('../market/mooket/market-history-data.js', () => ({
    // The real `freshestSighting` reduces rows to the newest; the rows the tests
    // hand over are already that, so the mock is the identity on the first one
    freshestSighting: (rows) => rows?.[0] || null,
}));
vi.mock('../market/mooket/index.js', () => ({
    watchedPriceTargets: () => game.pins.map((pin) => ({ ...pin })),
    // Storage only — the alert records the reach on the pin so the history
    // panel can measure what happened after it. Captured, not asserted on,
    // except where a test is about the record itself.
    noteWatchedTargetReached: (key, sighting) => {
        game.reaches.push({ key, sighting });
        return true;
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return { fired: game.fired, channels: game.fired ? ['toast'] : [] };
        },
    },
}));

const { default: priceTargetAlerts, MASTER_SETTING } = await import('./price-target-alerts.js');
const { registeredCommands, resetCommands } = await import('../../utils/command-registry.js');

/** A pin as `watchedPriceTargets` returns it */
function pin({ side = 'ask', price = 4_200_000, level = 0 } = {}) {
    return {
        key: `/items/cheese_sword:${level}`,
        itemHrid: '/items/cheese_sword',
        enhancementLevel: level,
        name: level > 0 ? `Cheese Sword +${level}` : 'Cheese Sword',
        target: { side, price },
    };
}

/** Put a sighting in the pool and let the alert pick it up */
async function sight({ ask = null, bid = null, ageMs = 60_000, level = 0 } = {}) {
    game.history[`/items/cheese_sword:${level}`] = [{ ask, bid, time: NOW - ageMs }];
    await priceTargetAlerts.refreshObservations();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    game.settings = { [MASTER_SETTING]: true, [POOLED_HISTORY_SETTING]: true };
    game.pins = [];
    game.history = {};
    game.fetched = [];
    game.dmHandlers = {};
    game.notified = [];
    game.reaches = [];
    game.fired = true;
    priceTargetAlerts.disable();
});

describe('the setting', () => {
    test('is in the schema, off by default like its sibling alerts', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
    });

    test('the help text says the alert is quiet without the pooled dataset', () => {
        // A switched-on alert that can never fire is worse than one that says so
        const help = getSettingDefinition(MASTER_SETTING).help;
        expect(help).toMatch(/pooled/i);
        expect(help).toMatch(/silent|quiet/i);
    });
});

describe('crossing', () => {
    test('fires once when the ask comes under the target', async () => {
        game.pins = [pin({ price: 4_200_000 })];
        await sight({ ask: 4_500_000 });
        priceTargetAlerts.check();
        expect(game.notified).toHaveLength(0);

        await sight({ ask: 4_100_000 });
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Cheese Sword hit your target (under 4.2M ask)');
        expect(game.notified[0].options.subject).toBe('Cheese Sword');
        expect(game.notified[0].options.title).toBe('Price target reached');
    });

    test('a reach that reached no channel is retried on the next sighting, not lost until the price recovers', async () => {
        game.fired = false;
        game.pins = [pin({ price: 4_200_000 })];
        await sight({ ask: 4_100_000 });
        expect(game.notified).toHaveLength(1);

        // Still under target, still nothing delivered — the pin's armed bit
        // must not have been spent on a notice nobody saw
        await sight({ ask: 4_050_000 });
        expect(game.notified).toHaveLength(2);

        game.fired = true;
        await sight({ ask: 4_000_000 });
        expect(game.notified).toHaveLength(3);

        // Delivered: a further sighting under the same target is the ordinary
        // one-message-per-reach case again
        await sight({ ask: 3_900_000 });
        expect(game.notified).toHaveLength(3);
    });

    test('the reach is recorded on the pin, dated by the sighting rather than by now', async () => {
        game.pins = [pin({ price: 4_200_000 })];
        await sight({ ask: 4_100_000, ageMs: 5 * 60_000 });

        expect(game.reaches).toHaveLength(1);
        expect(game.reaches[0].key).toBe('/items/cheese_sword:0');
        // The sighting's own time, five minutes back — the aftermath is measured
        // forward from the reach, so the moment has to be the real one
        expect(game.reaches[0].sighting.at).toBe(NOW - 5 * 60_000);
        expect(game.reaches[0].sighting.price.ask).toBe(4_100_000);
    });

    test('a target that never crosses records nothing', async () => {
        game.pins = [pin({ price: 4_200_000 })];
        await sight({ ask: 4_500_000 });
        expect(game.reaches).toHaveLength(0);
    });

    test('a bid target fires when the bid comes up to it', async () => {
        game.pins = [pin({ side: 'bid', price: 1_000_000 })];
        await sight({ bid: 900_000 });
        expect(game.notified).toHaveLength(0);

        await sight({ bid: 1_050_000 });
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('over 1.0M bid');
    });

    test('a target already reached on the first look is worth one message', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);
    });

    test('does not fire again while the price stays there', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        priceTargetAlerts.check();
        priceTargetAlerts.check();
        expect(game.notified).toHaveLength(1);
    });

    test('a replayed sighting is deduped', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        for (let i = 0; i < 5; i++) await priceTargetAlerts.refreshObservations();
        expect(game.notified).toHaveLength(1);
    });

    test('a pin with no target is never looked up, let alone announced', async () => {
        game.pins = [{ ...pin(), target: null }];
        await priceTargetAlerts.refreshObservations();
        expect(game.fetched).toHaveLength(0);
        expect(game.notified).toHaveLength(0);
    });

    test('an unquoted side is unknown rather than reached', async () => {
        game.pins = [pin()];
        // A bid-only sighting says nothing about the ask
        await sight({ bid: 10 });
        expect(game.notified).toHaveLength(0);
    });

    test('an unquoted side does not re-arm an announced target either', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);

        await sight({ ask: null, bid: 10 });
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);
    });
});

describe('freshness', () => {
    test('a sighting older than the cache window fires nothing', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000, ageMs: CACHE_DURATION + 1000 });
        expect(game.notified).toHaveLength(0);
    });

    test('a stale sighting does not re-arm an announced target either', async () => {
        // Both directions are gated on the same evidence: a figure from this
        // morning saying the price is back up proves no more than one saying it
        // is down, and re-arming on it would spend the next fresh sighting
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);

        await sight({ ask: 9_000_000, ageMs: CACHE_DURATION + 1000 });
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);
    });

    test('the message carries the sighting’s true age, not the moment it was read', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000, ageMs: 8 * 60 * 1000 });
        expect(game.notified[0].message).toMatch(/seen ~8m ago/);
    });

    test('a sighting from within the last minute says so plainly', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000, ageMs: 5_000 });
        expect(game.notified[0].message).toContain('seen just now');
    });

    test('nothing is looked up while the pooled dataset is off', async () => {
        // The pins live in that panel and the evidence comes from its dataset,
        // so with it off there is nothing to compare against
        game.settings[POOLED_HISTORY_SETTING] = false;
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.fetched).toHaveLength(0);
        expect(game.notified).toHaveLength(0);
    });
});

describe('re-arming', () => {
    test('the price moving back over the target re-arms it', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);

        await sight({ ask: 9_000_000 });
        expect(game.notified).toHaveLength(1);

        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(2);
    });

    test('moving the target is a new intention, announced on its own terms', async () => {
        game.pins = [pin({ price: 4_200_000 })];
        await sight({ ask: 4_000_000 });
        expect(game.notified).toHaveLength(1);

        // Lowered under the price that had already been announced: still
        // unreached, so nothing is said
        game.pins = [pin({ price: 3_000_000 })];
        priceTargetAlerts.check();
        expect(game.notified).toHaveLength(1);

        // And raised over it: reached again, and the event key differs from the
        // announced one so the service's cooldown cannot swallow it
        game.pins = [pin({ price: 5_000_000 })];
        priceTargetAlerts.check();
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].key).not.toBe(game.notified[0].key);
    });

    test('unpinning and re-pinning starts armed rather than inheriting a spent bit', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);

        game.pins = [];
        priceTargetAlerts.check();

        game.pins = [pin()];
        priceTargetAlerts.check();
        expect(game.notified).toHaveLength(2);
    });

    test('each pin gets its own bit and its own event key', async () => {
        game.pins = [pin({ level: 0 }), pin({ level: 5 })];
        game.history['/items/cheese_sword:0'] = [{ ask: 1_000_000, bid: null, time: NOW - 60_000 }];
        game.history['/items/cheese_sword:5'] = [{ ask: 1_000_000, bid: null, time: NOW - 60_000 }];
        await priceTargetAlerts.refreshObservations();

        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
        expect(game.notified[1].message).toContain('Cheese Sword +5');
    });
});

describe('the master switch', () => {
    test('nothing is checked or looked up while it is off', async () => {
        game.settings[MASTER_SETTING] = false;
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        priceTargetAlerts.check();
        expect(game.fetched).toHaveLength(0);
        expect(game.notified).toHaveLength(0);
    });

    test('initialize does nothing while it is off', async () => {
        game.settings[MASTER_SETTING] = false;
        await priceTargetAlerts.initialize();
        expect(game.dmHandlers.character_initialized).toBeUndefined();
    });
});

describe('disable', () => {
    test('drops the armed bits, so a re-enable does not inherit another session’s idea', async () => {
        game.pins = [pin()];
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(1);

        priceTargetAlerts.disable();
        await sight({ ask: 1_000_000 });
        expect(game.notified).toHaveLength(2);
    });

    test('a character switch takes the listeners with it', async () => {
        await priceTargetAlerts.initialize();
        expect(game.dmHandlers.character_switching).toBeTypeOf('function');

        game.dmHandlers.character_switching();
        expect(game.dmHandlers.character_initialized).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('a second initialize does not double the listeners', async () => {
        await priceTargetAlerts.initialize();
        const first = game.dmHandlers.character_initialized;
        await priceTargetAlerts.initialize();
        expect(game.dmHandlers.character_initialized).toBe(first);
    });
});

/**
 * The sweep runs every fifteen minutes, which is the right cadence for watching
 * a price and the wrong one for somebody who has just named a target and wants
 * to know where the price is now.
 */
describe('the refresh verb', () => {
    /** @returns {Object|undefined} The verb, as the palette would see it */
    const verb = () => registeredCommands().find((entry) => entry.name === 'Refresh watchlist prices');

    beforeEach(async () => {
        resetCommands();
        await priceTargetAlerts.initialize();
    });

    test('initialising offers it as a verb; disabling withdraws it', async () => {
        expect(verb()?.kind).toBe('verb');
        priceTargetAlerts.disable();
        expect(verb()).toBeUndefined();
    });

    test('it counts the pins it will actually look up', async () => {
        game.pins = [pin(), pin({ level: 1 }), { ...pin({ level: 2 }), target: null }];
        game.history['/items/cheese_sword:0'] = [{ ask: 1, bid: null, time: NOW }];
        game.history['/items/cheese_sword:1'] = [{ ask: 1, bid: null, time: NOW }];

        // The untargeted pin is never fetched, so counting it would over-report
        expect(await verb().run()).toBe('2 pins refreshed');
    });

    test('one pin is one pin', async () => {
        game.pins = [pin()];
        game.history['/items/cheese_sword:0'] = [{ ask: 1, bid: null, time: NOW }];
        expect(await verb().run()).toBe('1 pin refreshed');
    });

    test('an empty watchlist says so rather than reporting a sweep of nothing', async () => {
        game.pins = [];
        expect(await verb().run()).toBe('no pins with targets');
        expect(game.fetched).toEqual([]);
    });

    test('a sweep already running is not doubled — the third-party limit is shared', async () => {
        game.pins = [pin()];
        priceTargetAlerts.refreshInFlight = true;
        try {
            expect(await verb().run()).toBe('already refreshing');
            expect(game.fetched).toEqual([]);
        } finally {
            priceTargetAlerts.refreshInFlight = false;
        }
    });

    test('without the pooled dataset it is not offered at all', () => {
        // Genuine unavailability, not "nothing to do": there is no source, and
        // the pins themselves live in that panel
        game.settings[POOLED_HISTORY_SETTING] = false;
        expect(verb()).toBeUndefined();

        game.settings[POOLED_HISTORY_SETTING] = true;
        expect(verb()).toBeDefined();
    });
});
