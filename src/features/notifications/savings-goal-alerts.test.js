/**
 * Tests for the savings goal alert.
 *
 * The value under watch — `affordable` — is true for as long as the coins sit
 * in the purse, so every case that matters is about the *crossing* rather than
 * the value: the first observation that says so, the same observation repeated
 * on a reconnect replay, the coins spent and saved again, and the target moved
 * under a goal that had already been announced. The message is under test too,
 * since carrying the age of the figures behind the cost — and saying so when
 * they are stale — is a stated requirement.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const NOW = new Date('2026-01-01T12:00:00Z').getTime();
const CACHE_DURATION = 15 * 60 * 1000;

const game = vi.hoisted(() => ({
    settings: {},
    targets: [],
    abilityGoals: [],
    houseGoals: [],
    dmHandlers: {},
    priceListeners: [],
    notified: [],
    fired: true,
    /** `itemHrid:level` → epoch ms; `''` is the bare snapshot timestamp */
    priceTimestamps: {},
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
    default: {
        CACHE_DURATION: 15 * 60 * 1000,
        getPriceTimestamp: (itemHrid, enhancementLevel = 0) => {
            const keyed = game.priceTimestamps[`${itemHrid}:${enhancementLevel}`];
            return keyed ?? game.priceTimestamps[''] ?? null;
        },
        on: (callback) => {
            game.priceListeners.push(callback);
        },
        off: (callback) => {
            game.priceListeners = game.priceListeners.filter((cb) => cb !== callback);
        },
    },
}));
vi.mock('../inventory/equipment-savings-row.js', () => ({
    watchedTargets: () => game.targets.map((target) => ({ ...target })),
    watchedAbilityGoals: () => game.abilityGoals.map((goal) => ({ ...goal })),
    watchedHouseGoals: () => game.houseGoals.map((goal) => ({ ...goal })),
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return { fired: game.fired, channels: game.fired ? ['toast'] : [] };
        },
    },
}));

const { default: savingsGoalAlerts, MASTER_SETTING, savingsGoalReadings } = await import('./savings-goal-alerts.js');

/** A gear target as `watchedTargets` returns it */
function gearTarget({ cost = 1_000_000, affordable = false, enhancementLevel = 0 } = {}) {
    return {
        itemHrid: '/items/cheese_sword',
        name: 'Cheese Sword',
        enhancementLevel,
        cost,
        affordable,
        fraction: affordable ? 1 : 0.5,
        needed: affordable ? 0 : cost,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    game.settings = { [MASTER_SETTING]: true };
    game.targets = [];
    game.abilityGoals = [];
    game.houseGoals = [];
    game.dmHandlers = {};
    game.priceListeners = [];
    game.notified = [];
    game.fired = true;
    game.priceTimestamps = { '': NOW - 2 * 60 * 1000 };
    savingsGoalAlerts.disable();
});

describe('the setting', () => {
    test('is in the schema, off by default like its sibling alerts', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
    });
});

describe('crossing', () => {
    test('fires once when a goal becomes affordable', () => {
        game.targets = [gearTarget({ affordable: false })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(0);

        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Cheese Sword is now affordable');
        expect(game.notified[0].options.subject).toBe('Cheese Sword');
    });

    test('a reach that reached no channel is retried on the next look, not lost until the goal resolves', () => {
        game.fired = false;
        game.targets = [gearTarget({ affordable: false })];
        savingsGoalAlerts.check();

        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);

        // Still affordable, still nothing delivered — the goal's armed bit
        // must not have been spent on a notice nobody saw
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(2);

        game.fired = true;
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(3);

        // Delivered: further re-reads of the same affordable goal are the
        // ordinary one-message-per-goal case again
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(3);
    });

    test('a goal already affordable on the first look is worth one message', () => {
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);
    });

    test('does not fire again while the goal stays affordable', () => {
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        savingsGoalAlerts.check();
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);
    });

    test('a replayed observation on reconnect is deduped', () => {
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        // A reconnect republishes the same character state — same coins, same
        // costs, same list. Nothing has happened.
        for (let i = 0; i < 5; i++) savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);
    });

    test('an unpriced goal is unknown rather than unaffordable, and changes nothing', () => {
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);

        // The market stops quoting the item: cost null, and `savingsProgress`
        // reports affordable false. That must not re-arm the goal.
        game.targets = [{ ...gearTarget(), cost: null, affordable: false }];
        savingsGoalAlerts.check();
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);
    });
});

describe('re-arming', () => {
    test('spending back below the cost re-arms the goal', () => {
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);

        game.targets = [gearTarget({ affordable: false })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);

        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(2);
    });

    test('changing the target re-arms it, and changes the event key', () => {
        game.abilityGoals = [
            {
                abilityHrid: '/abilities/fierce_aura',
                itemHrid: '/items/fierce_aura',
                name: 'Fierce Aura Lv46',
                targetLevel: 46,
                cost: 500_000,
                affordable: true,
                done: false,
            },
        ];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);

        // Raised to Lv51 and still affordable: a new intention, not the old one
        game.abilityGoals = [
            {
                abilityHrid: '/abilities/fierce_aura',
                itemHrid: '/items/fierce_aura',
                name: 'Fierce Aura Lv51',
                targetLevel: 51,
                cost: 700_000,
                affordable: true,
                done: false,
            },
        ];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
        expect(game.notified[1].key).toContain('Lv51');
    });

    test('a goal taken off the list and put back starts armed again', () => {
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        game.targets = [];
        savingsGoalAlerts.check();
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(2);
    });
});

describe('what is on the list', () => {
    test('a level already reached without buying is skipped', () => {
        game.abilityGoals = [
            {
                abilityHrid: '/abilities/fierce_aura',
                itemHrid: '/items/fierce_aura',
                name: 'Fierce Aura Lv46',
                targetLevel: 46,
                cost: 0,
                affordable: true,
                done: true,
            },
        ];
        game.houseGoals = [
            {
                houseRoomHrid: '/house_rooms/dojo',
                itemHrid: '',
                name: 'Dojo Lv5',
                targetLevel: 5,
                cost: 0,
                affordable: true,
                done: true,
            },
        ];
        savingsGoalAlerts.check();
        expect(savingsGoalReadings()).toHaveLength(0);
        expect(game.notified).toHaveLength(0);
    });

    test('house rooms are on the list, keyed by room', () => {
        game.houseGoals = [
            {
                houseRoomHrid: '/house_rooms/dojo',
                itemHrid: '',
                name: 'Dojo Lv5',
                targetLevel: 5,
                cost: 2_000_000,
                affordable: true,
                done: false,
            },
        ];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].key).toContain('house:/house_rooms/dojo');
    });
});

describe('the message', () => {
    test('carries the age of the figures behind the cost', () => {
        game.priceTimestamps = { '': NOW - 4 * 60 * 1000 };
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified[0].message).toContain('priced ~4m ago');
    });

    test('says a figure older than the cache window may have moved', () => {
        game.priceTimestamps = { '': NOW - 3 * 60 * 60 * 1000 };
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified[0].message).toContain('so it may have moved');
        expect(game.notified[0].message).toContain('3h');
    });

    test('a figure fresher than a minute reads as just now', () => {
        game.priceTimestamps = { '': NOW - 5_000 };
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified[0].message).toContain('priced just now');
    });

    test('an undated figure says its age is unknown rather than inventing one', () => {
        game.priceTimestamps = {};
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified[0].message).toContain('price age unknown');
    });

    test('a per-item patch newer than the snapshot dates the cost', () => {
        game.priceTimestamps = { '': NOW - CACHE_DURATION * 2, '/items/cheese_sword:0': NOW - 60_000 };
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified[0].message).not.toContain('so it may have moved');
    });
});

describe('the switch', () => {
    test('says nothing while the master setting is off', () => {
        game.settings[MASTER_SETTING] = false;
        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(0);
    });

    test('initialize registers nothing while the master setting is off', async () => {
        game.settings[MASTER_SETTING] = false;
        await savingsGoalAlerts.initialize();
        expect(Object.keys(game.dmHandlers)).toHaveLength(0);
        expect(game.priceListeners).toHaveLength(0);
    });

    test('initialize twice registers one set of listeners', async () => {
        await savingsGoalAlerts.initialize();
        const first = game.priceListeners.length;
        await savingsGoalAlerts.initialize();
        expect(game.priceListeners).toHaveLength(first);
    });

    test('disable unhooks everything and resets the armed bits', async () => {
        await savingsGoalAlerts.initialize();
        expect(game.priceListeners.length).toBeGreaterThan(0);
        expect(game.dmHandlers.items_updated).toBeTruthy();

        game.targets = [gearTarget({ affordable: true })];
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(1);

        savingsGoalAlerts.disable();
        expect(game.priceListeners).toHaveLength(0);
        expect(game.dmHandlers.items_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();

        // Armed state went with the listeners: the same goal is news again
        savingsGoalAlerts.check();
        expect(game.notified).toHaveLength(2);
    });
});
