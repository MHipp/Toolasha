/** @vitest-environment happy-dom
 *
 * Buff and debuff bars under combat units.
 *
 * Four things are worth asserting and none of them is arithmetic:
 *
 * - the strips are seeded from the combatant list rather than waiting a tick;
 * - a tick's buff map is authoritative both ways — a new debuff appears, and an
 *   effect the map stops listing goes away;
 * - the map is filtered to fight state: a player's standing loadout is most of
 *   what it carries, and every chip has to be something an ability applied;
 * - the countdown is written only when its rounded second changes, which is the
 *   difference between one DOM write a second and one per observer callback in
 *   a panel that mutates at frame rate;
 * - teardown leaves nothing — no elements and no interval — and a character
 *   switch mid-battle is a teardown of the fight.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    enabled: true,
    clientData: null,
    handlers: [],
    readyHandlers: [],
    domReady: true,
    intervals: [],
    ws: new Map(),
    dm: new Map(),
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => opts.enabled, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => opts.clientData,
        on: (event, handler) => opts.dm.set(event, [...(opts.dm.get(event) || []), handler]),
        off: (event, handler) =>
            opts.dm.set(
                event,
                (opts.dm.get(event) || []).filter((entry) => entry !== handler)
            ),
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => opts.ws.set(type, [...(opts.ws.get(type) || []), handler]),
        off: (type, handler) =>
            opts.ws.set(
                type,
                (opts.ws.get(type) || []).filter((entry) => entry !== handler)
            ),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classNames, callback) => {
            const handler = { name, classNames, callback };
            opts.handlers.push(handler);
            return () => {
                opts.handlers = opts.handlers.filter((entry) => entry !== handler);
            };
        },
        onReady: (name, callback) => {
            const handler = { name, callback };
            opts.readyHandlers.push(handler);
            if (opts.domReady) callback();
            return () => {
                opts.readyHandlers = opts.readyHandlers.filter((entry) => entry !== handler);
            };
        },
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({
        registerInterval: (id) => opts.intervals.push(id),
        registerTimeout: (id) => opts.intervals.push(id),
        clearAll: () => {
            for (const id of opts.intervals.splice(0)) clearInterval(id);
        },
    }),
}));

const {
    STRIP_MARK,
    CHIP_MARK,
    readBuffMap,
    countdownText,
    slotNames,
    liveDurationSeconds,
    abilitySpriteHref,
    _resetSpriteUrl,
    _instance: bars,
    default: feature,
} = await import('./combat-unit-buff-bars.js');

const SECOND = 1e9;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

/** The ability map the effect index is built from */
const ABILITY_MAP = {
    '/abilities/toughness': {
        abilityEffects: [
            {
                targetType: 'self',
                effectType: '/ability_effect_types/buff',
                buffs: [
                    { uniqueHrid: '/buff_uniques/toughness', typeHrid: '/buff_types/armor', duration: 20 * SECOND },
                ],
            },
        ],
    },
    '/abilities/weaken': {
        abilityEffects: [
            {
                targetType: 'allEnemies',
                effectType: '/ability_effect_types/damage',
                buffs: [
                    {
                        uniqueHrid: '/buff_uniques/weaken',
                        typeHrid: '/buff_types/damage_taken',
                        duration: 15 * SECOND,
                    },
                ],
            },
        ],
    },
    // Two abilities whose buffs move the same stat: the pair that read as one
    // chip twice while the label came from the type
    '/abilities/elemental_affinity': {
        abilityEffects: [
            {
                targetType: 'self',
                effectType: '/ability_effect_types/buff',
                buffs: [
                    {
                        uniqueHrid: '/buff_uniques/elemental_affinity_fire_amplify',
                        typeHrid: '/buff_types/fire_amplify',
                        duration: 30 * SECOND,
                    },
                ],
            },
        ],
    },
    '/abilities/firestorm': {
        abilityEffects: [
            {
                targetType: 'self',
                effectType: '/ability_effect_types/buff',
                buffs: [
                    {
                        uniqueHrid: '/buff_uniques/firestorm_fire_amplify',
                        typeHrid: '/buff_types/fire_amplify',
                        duration: 25 * SECOND,
                    },
                ],
            },
        ],
    },
    // An ability effect the data states no duration for: the one case that
    // still reaches a chip with no countdown
    '/abilities/unending': {
        abilityEffects: [
            {
                targetType: 'self',
                effectType: '/ability_effect_types/buff',
                buffs: [{ uniqueHrid: '/buff_uniques/unending', typeHrid: '/buff_types/armor' }],
            },
        ],
    },
};

/** The Go zero-time sentinel a permanent passive carries instead of a start */
const ZERO_TIME = '0001-01-01T00:00:00Z';

/**
 * A player's real mid-dungeon buff map: 27 entries of 17 distinct types, of
 * which three were applied by an ability and the other 24 are their standing
 * loadout. Trimmed only in that the repeated passives are spelled out rather
 * than generated.
 */
function loadoutMap() {
    const passive = (uniqueHrid, typeHrid) => [uniqueHrid, { uniqueHrid, typeHrid, duration: 0, startTime: ZERO_TIME }];
    const drink = (uniqueHrid, typeHrid) => [
        uniqueHrid,
        { uniqueHrid, typeHrid, duration: 250 * SECOND, startTime: new Date(NOW).toISOString() },
    ];
    return Object.fromEntries([
        // Five sources of one stat, which drew five chips all reading 'WIS'
        passive('/buff_uniques/achievement_novice_experience', '/buff_types/wisdom'),
        passive('/buff_uniques/house_observatory', '/buff_types/wisdom'),
        passive('/buff_uniques/community_wisdom', '/buff_types/wisdom'),
        passive('/buff_uniques/achievement_expert_experience', '/buff_types/wisdom'),
        drink('/buff_uniques/wisdom_tea', '/buff_types/wisdom'),
        passive('/buff_uniques/achievement_attack', '/buff_types/attack_level'),
        drink('/buff_uniques/attack_coffee', '/buff_types/attack_level'),
        passive('/buff_uniques/achievement_cast_speed', '/buff_types/cast_speed'),
        drink('/buff_uniques/channeling_coffee', '/buff_types/cast_speed'),
        passive('/buff_uniques/achievement_magic', '/buff_types/magic_level'),
        passive('/buff_uniques/house_library', '/buff_types/magic_level'),
        passive('/buff_uniques/community_nature', '/buff_types/nature_amplify'),
        passive('/buff_uniques/house_garden', '/buff_types/nature_amplify'),
        passive('/buff_uniques/community_water', '/buff_types/water_amplify'),
        passive('/buff_uniques/house_well', '/buff_types/water_amplify'),
        passive('/buff_uniques/house_dojo', '/buff_types/fire_amplify'),
        // What the fight actually put on them
        [
            '/buff_uniques/elemental_affinity_fire_amplify',
            {
                uniqueHrid: '/buff_uniques/elemental_affinity_fire_amplify',
                typeHrid: '/buff_types/fire_amplify',
                duration: 30 * SECOND,
                startTime: new Date(NOW).toISOString(),
            },
        ],
        [
            '/buff_uniques/firestorm_fire_amplify',
            {
                uniqueHrid: '/buff_uniques/firestorm_fire_amplify',
                typeHrid: '/buff_types/fire_amplify',
                duration: 25 * SECOND,
                startTime: new Date(NOW).toISOString(),
            },
        ],
        [
            '/buff_uniques/toughness',
            {
                uniqueHrid: '/buff_uniques/toughness',
                typeHrid: '/buff_types/armor',
                duration: 20 * SECOND,
                startTime: new Date(NOW).toISOString(),
            },
        ],
    ]);
}

/** One live buff record, in the shape `combatBuffMap` states them */
function live(uniqueHrid, typeHrid, seconds, startedAt = NOW) {
    return {
        [uniqueHrid]: {
            uniqueHrid,
            typeHrid,
            duration: seconds * SECOND,
            startTime: new Date(startedAt).toISOString(),
        },
    };
}

/** A battle panel with two player tiles and two monster tiles */
function panel(playerNames = ['Alice', 'Bob'], monsterCount = 2) {
    document.body.innerHTML = `
        <div class="BattlePanel_battlePanel__1x2y3">
            <div class="BattlePanel_playersArea__3a4b5">
                ${playerNames
                    .map(
                        (name) => `<div class="CombatUnit_combatUnit__1p2q3">
                            <div class="CombatUnit_name__2r3s4">${name}</div>
                        </div>`
                    )
                    .join('')}
            </div>
            <div class="BattlePanel_monstersArea__6c7d8">
                ${Array.from(
                    { length: monsterCount },
                    (_, index) => `<div class="CombatUnit_combatUnit__1p2q3">
                        <div class="CombatUnit_name__2r3s4">Rat ${index}</div>
                    </div>`
                ).join('')}
            </div>
        </div>`;
}

const send = (type, payload) => {
    for (const handler of opts.ws.get(type) || []) handler(payload);
};
const strips = () => [...document.querySelectorAll(`[${STRIP_MARK}]`)];
const chipsOn = (area, index) =>
    [...document.querySelectorAll(`[class*="BattlePanel_${area}Area"] [class*="CombatUnit_combatUnit"]`)][
        index
    ].querySelectorAll(`[${CHIP_MARK}]`);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    opts.enabled = true;
    opts.domReady = true;
    opts.handlers = [];
    opts.readyHandlers = [];
    opts.ws = new Map();
    opts.dm = new Map();
    for (const id of opts.intervals.splice(0)) clearInterval(id);
    opts.clientData = { abilityDetailMap: ABILITY_MAP };
    _resetSpriteUrl();
    panel();
    feature.initialize();
});

afterEach(() => {
    feature.cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('reading a buff map', () => {
    test('the ability index names the effect and its sign', () => {
        const effects = readBuffMap(live('/buff_uniques/weaken', '/buff_types/damage_taken', 15), NOW, ABILITY_MAP);
        expect(effects.get('/buff_uniques/weaken')).toMatchObject({ kind: 'debuff', slug: 'weaken' });
    });

    test('a buff no ability declares is loadout, not fight state, and gets no chip', () => {
        const effects = readBuffMap(live('/buff_uniques/community', '/buff_types/experience', 60), NOW, ABILITY_MAP);
        expect(effects.size).toBe(0);
    });

    test('a permanent passive is dropped, rather than drawn with a nonsense countdown', () => {
        const map = {
            '/buff_uniques/house_observatory': {
                uniqueHrid: '/buff_uniques/house_observatory',
                typeHrid: '/buff_types/wisdom',
                duration: 0,
                startTime: ZERO_TIME,
            },
        };
        expect(readBuffMap(map, NOW, ABILITY_MAP).size).toBe(0);
    });

    test('a drink is pre-fight setup and gets no chip either', () => {
        const map = {
            '/buff_uniques/attack_coffee': {
                uniqueHrid: '/buff_uniques/attack_coffee',
                typeHrid: '/buff_types/attack_level',
                duration: 250 * SECOND,
                startTime: new Date(NOW).toISOString(),
            },
        };
        expect(readBuffMap(map, NOW, ABILITY_MAP).size).toBe(0);
    });

    test("a real loadout leaves only the fight's own effects, each reading differently", () => {
        const effects = readBuffMap(loadoutMap(), NOW, ABILITY_MAP);

        expect([...effects.keys()]).toEqual([
            '/buff_uniques/elemental_affinity_fire_amplify',
            '/buff_uniques/firestorm_fire_amplify',
            '/buff_uniques/toughness',
        ]);
        // Both fire amplifies are ability-applied and share a `typeHrid`, so a
        // type-derived label drew two chips reading 'FA'
        const labels = [...effects.values()].map((effect) => effect.label);
        expect(new Set(labels).size).toBe(labels.length);
    });

    test('the whole loadout draws three chips on the tile, not twenty-seven', () => {
        send('new_battle', { players: [{ name: 'Alice', combatBuffMap: loadoutMap() }], monsters: [] });
        const chips = [...chipsOn('players', 0)];
        expect(chips).toHaveLength(3);
        expect(new Set(chips.map((chip) => chip.firstElementChild.textContent)).size).toBe(3);
    });

    test('an already-expired record is not drawn and removed a frame later', () => {
        const map = live('/buff_uniques/toughness', '/buff_types/armor', 5, NOW - 10_000);
        expect(readBuffMap(map, NOW, ABILITY_MAP).size).toBe(0);
    });

    test('a duration nothing states falls back to the ability index', () => {
        const map = { '/buff_uniques/toughness': { uniqueHrid: '/buff_uniques/toughness', duration: 0 } };
        const effect = readBuffMap(map, NOW, ABILITY_MAP).get('/buff_uniques/toughness');
        expect(effect.expiresAt).toBe(NOW + 20_000);
    });

    test('nanoseconds are converted once, from the wire to the chip', () => {
        // A double conversion shows a 30-second buff as 30 nanoseconds or 30
        // billion seconds; a missed one shows it as 30 billion
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 30) }],
        });
        expect(chipsOn('monsters', 0)[0].lastElementChild.textContent).toBe('30');
    });

    test('durations are nanoseconds', () => {
        expect(liveDurationSeconds(15 * SECOND)).toBe(15);
        expect(liveDurationSeconds(0)).toBeNull();
        expect(liveDurationSeconds(undefined)).toBeNull();
    });
});

describe('countdown text', () => {
    test('whole seconds, minutes over a minute, nothing without an expiry', () => {
        expect(countdownText(NOW + 4200, NOW)).toBe('5');
        expect(countdownText(NOW + 95_000, NOW)).toBe('2m');
        expect(countdownText(NOW - 5000, NOW)).toBe('0');
        expect(countdownText(null, NOW)).toBe('');
    });
});

describe('seeding and reconciling', () => {
    test('a new battle seeds a strip for every unit that carries something', () => {
        send('new_battle', {
            players: [
                { name: 'Alice', combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) },
                { name: 'Bob', combatBuffMap: {} },
            ],
            monsters: [
                { combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) },
                { combatBuffMap: {} },
            ],
        });

        expect(strips()).toHaveLength(2);
        expect(chipsOn('players', 0)).toHaveLength(1);
        expect(chipsOn('players', 1)).toHaveLength(0);
        expect(chipsOn('monsters', 0)).toHaveLength(1);
    });

    test('the join for a player is the name, never the slot', () => {
        // Bob is in slot 0 of this fight; a strip matched by position would put
        // his effects on Alice, whose tile is first in the DOM
        send('new_battle', {
            players: [{ name: 'Bob', combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) }],
            monsters: [],
        });
        expect(chipsOn('players', 0)).toHaveLength(0);
        expect(chipsOn('players', 1)).toHaveLength(1);
    });

    test('slot names are read off the combatant list', () => {
        expect(slotNames({ players: [{ name: 'Alice' }, { character: { name: 'Bob' } }, {}] })).toEqual({
            0: 'Alice',
            1: 'Bob',
        });
    });

    test('a tick carrying a new debuff on a monster adds it', () => {
        send('new_battle', { players: [{ name: 'Alice' }], monsters: [{ combatBuffMap: {} }] });
        expect(chipsOn('monsters', 0)).toHaveLength(0);

        send('battle_updated', {
            mMap: { 0: { combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) } },
        });
        const chips = chipsOn('monsters', 0);
        expect(chips).toHaveLength(1);
        expect(chips[0].getAttribute(CHIP_MARK)).toBe('/buff_uniques/weaken');
    });

    test('a tick that stops listing an effect removes it', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        expect(chipsOn('monsters', 0)).toHaveLength(1);

        send('battle_updated', { mMap: { 0: { combatBuffMap: {} } } });
        expect(chipsOn('monsters', 0)).toHaveLength(0);
        // And the strip itself goes with the last chip, rather than sitting
        // there as an empty box holding the tile taller
        expect(strips()).toHaveLength(0);
    });

    test('an effect expires on the clock, without a message saying so', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        expect(chipsOn('monsters', 0)).toHaveLength(1);

        vi.setSystemTime(NOW + 16_000);
        feature.redraw();
        expect(chipsOn('monsters', 0)).toHaveLength(0);
    });
});

describe('unit identity', () => {
    test('a slot changing hands mid-battle lands nowhere rather than on the wrong player', () => {
        send('new_battle', {
            players: [{ name: 'Alice' }, { name: 'Bob' }],
            monsters: [],
        });

        // Bob leaves and Carol takes his seat, with no `new_battle` to say so.
        // The slot's effects are filed under the name the fight opened with,
        // which matches no tile — rather than being drawn on whoever is sitting
        // in slot 1 now.
        panel(['Alice', 'Carol']);
        send('battle_updated', {
            pMap: { 1: { combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) } },
        });

        expect(chipsOn('players', 0)).toHaveLength(0);
        expect(chipsOn('players', 1)).toHaveLength(0);
    });

    test('two of the same monster are told apart by slot, not by name', () => {
        panel(['Alice'], 2);
        document.querySelectorAll('[class*="BattlePanel_monstersArea"] [class*="CombatUnit_name"]').forEach((node) => {
            node.textContent = 'Rat';
        });

        send('new_battle', {
            players: [],
            monsters: [
                { combatBuffMap: {} },
                { combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) },
            ],
        });

        expect(chipsOn('monsters', 0)).toHaveLength(0);
        expect(chipsOn('monsters', 1)).toHaveLength(1);
    });

    test("a monster sharing a player's name gets the monster's effects", () => {
        panel(['Rat 0'], 1);
        send('new_battle', {
            players: [{ name: 'Rat 0', combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) }],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });

        expect(chipsOn('players', 0)[0].getAttribute(CHIP_MARK)).toBe('/buff_uniques/toughness');
        expect(chipsOn('monsters', 0)[0].getAttribute(CHIP_MARK)).toBe('/buff_uniques/weaken');
    });
});

describe('drawing no more than it must', () => {
    test('the countdown is written only when the rounded second changes', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        const chip = chipsOn('monsters', 0)[0];
        const countdown = chip.lastElementChild;
        expect(countdown.textContent).toBe('15');

        let writes = 0;
        const node = countdown.firstChild;
        Object.defineProperty(countdown, 'textContent', {
            configurable: true,
            get: () => node?.data ?? '',
            set: (value) => {
                writes += 1;
                if (node) node.data = value;
            },
        });

        // Four draws inside the same second write nothing
        vi.setSystemTime(NOW + 100);
        feature.redraw();
        feature.redraw();
        vi.setSystemTime(NOW + 300);
        feature.redraw();
        expect(writes).toBe(0);

        // Crossing into the next rounded second writes once
        vi.setSystemTime(NOW + 1200);
        feature.redraw();
        expect(writes).toBe(1);
        expect(countdown.textContent).toBe('14');
        feature.redraw();
        expect(writes).toBe(1);
    });

    test('another feature holding last place does not start a re-seat war', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        const tile = document.querySelectorAll(
            '[class*="BattlePanel_monstersArea"] [class*="CombatUnit_combatUnit"]'
        )[0];
        const strip = tile.querySelector(`[${STRIP_MARK}]`);

        // `portrait-dps.js` seats its meter as the tile's last child on every
        // draw. A strip that insisted on last place moved it, had its own moved
        // back, and rewrote its whole subtree once a tick for the rest of the
        // fight.
        const meter = document.createElement('div');
        meter.setAttribute('data-toolasha-portrait-dps', '1');
        tile.appendChild(meter);

        const observer = new MutationObserver(() => {});
        observer.observe(tile, { childList: true, subtree: true });
        feature.redraw();
        const records = observer.takeRecords().length;
        observer.disconnect();

        expect(records).toBe(0);
        expect(tile.lastElementChild).toBe(meter);
        expect(strip.parentElement).toBe(tile);
    });

    test('a game-owned node below the strip still moves the strip down', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        const tile = document.querySelectorAll(
            '[class*="BattlePanel_monstersArea"] [class*="CombatUnit_combatUnit"]'
        )[0];
        const strip = tile.querySelector(`[${STRIP_MARK}]`);

        const gameNode = document.createElement('div');
        gameNode.className = 'CombatUnit_hpBar__z';
        tile.appendChild(gameNode);

        feature.redraw();
        expect(tile.lastElementChild).toBe(strip);
    });

    test('the chip element survives a redraw rather than being rebuilt', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        const chip = chipsOn('monsters', 0)[0];
        vi.setSystemTime(NOW + 3000);
        feature.redraw();
        expect(chipsOn('monsters', 0)[0]).toBe(chip);
    });

    test('one interval for every unit, and none once the fight is clean', () => {
        send('new_battle', {
            players: [{ name: 'Alice', combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) }],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        expect(opts.intervals).toHaveLength(1);
        expect(bars.ticking).toBe(true);

        vi.setSystemTime(NOW + 30_000);
        feature.redraw();
        expect(bars.ticking).toBe(false);
        expect(opts.intervals).toHaveLength(0);
    });
});

describe('the interval does not outlive the fight', () => {
    test('an effect with no stated expiry does not tick for the rest of the session', () => {
        // Nothing states a duration for it, so it never expires — which on its
        // own kept `_hasEffects()` true and the interval running forever
        send('new_battle', {
            players: [],
            monsters: [
                {
                    combatBuffMap: {
                        '/buff_uniques/unending': { uniqueHrid: '/buff_uniques/unending' },
                    },
                },
            ],
        });
        expect(bars.ticking).toBe(true);

        // The fight ends: React takes the battle panel down and no further
        // message says the effect is gone
        document.body.innerHTML = '';
        feature.redraw();

        expect(bars.ticking).toBe(false);
        expect(opts.intervals).toHaveLength(0);
    });

    test('the panel coming back restarts it, with the state intact', () => {
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 300) }],
        });
        document.body.innerHTML = '';
        feature.redraw();
        expect(bars.ticking).toBe(false);

        panel();
        feature.redraw();
        expect(bars.ticking).toBe(true);
        expect(chipsOn('monsters', 0)).toHaveLength(1);
    });
});

describe('icons', () => {
    test('the sprite is scraped from an icon the game already drew', () => {
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<svg><use href="/static/media/abilities_sprite.a1b2.svg#fireball"></use></svg>'
        );
        expect(abilitySpriteHref('weaken')).toBe('/static/media/abilities_sprite.a1b2.svg#weaken');
    });

    test('an effect with no sprite falls back to its abbreviation', () => {
        // No ability icon on the page, so nothing resolves
        send('new_battle', {
            players: [],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        const chip = chipsOn('monsters', 0)[0];
        expect(chip.querySelector('svg')).toBeNull();
        // The effect's own name (`/buff_uniques/weaken`), not its stat type
        expect(chip.firstElementChild.textContent).toBe('WEA');
    });
});

describe('lifecycle', () => {
    test('cleanup leaves no elements and no interval', () => {
        send('new_battle', {
            players: [{ name: 'Alice', combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) }],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        expect(strips()).toHaveLength(2);

        feature.cleanup();
        expect(strips()).toHaveLength(0);
        expect(opts.intervals).toHaveLength(0);
        expect(opts.handlers).toHaveLength(0);
        expect(opts.ws.get('battle_updated')).toHaveLength(0);
        expect(opts.dm.get('character_switching')).toHaveLength(0);
    });

    test('a character switch mid-battle clears everything', () => {
        send('new_battle', {
            players: [{ name: 'Alice', combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) }],
            monsters: [{ combatBuffMap: live('/buff_uniques/weaken', '/buff_types/damage_taken', 15) }],
        });
        expect(strips()).toHaveLength(2);

        for (const handler of opts.dm.get('character_switching') || []) handler();
        expect(strips()).toHaveLength(0);
        expect(bars.ticking).toBe(false);

        // And the departing character's fight is not carried over: a tick for a
        // slot whose name is gone lands nowhere
        send('battle_updated', {
            pMap: { 0: { combatBuffMap: live('/buff_uniques/toughness', '/buff_types/armor', 20) } },
        });
        expect(strips()).toHaveLength(0);
    });

    test('the setting being off means nothing is subscribed at all', () => {
        feature.cleanup();
        opts.enabled = false;
        feature.initialize();
        expect(opts.ws.get('new_battle') || []).toHaveLength(0);
        expect(opts.handlers).toHaveLength(0);
    });
});
