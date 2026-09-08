/** @vitest-environment happy-dom
 *
 * Portrait DPS.
 *
 * The join between a portrait and a tally row is the whole of the risk here, and
 * it is the same trap the damage tally itself fell into: matching by position
 * works right up until somebody leaves, and then it silently draws one
 * character's damage on another's face. So the matching is by name, and these
 * tests are mostly about what happens when a name is not there to match.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    position: 'above',
    players: [],
    fight: { players: {}, enemies: {} },
    taken: [],
    battleTaken: {},
    mana: {},
    settings: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        // Every checkbox on unless a test says otherwise — the optional lines
        // are what most of these tests are about
        getSetting: (key) => opts.settings[key] ?? true,
        getSettingValue: () => opts.position,
    },
}));
vi.mock('./damage-tracker.js', () => ({
    damageBreakdown: () => ({ players: opts.players }),
    battleBreakdown: () => opts.fight,
    manaSamples: () => opts.mana,
}));
vi.mock('./damage-taken-tracker.js', () => ({
    takenBreakdown: () => ({ players: opts.taken }),
    battleTakenBreakdown: () => ({ seconds: 0, enemies: opts.battleTaken }),
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerInterval: () => {}, clearAll: () => {} }),
}));

const {
    matchPortraits,
    portraitName,
    meterText,
    enemyMeterText,
    drawSignature,
    _instance: instance,
    default: portraitDps,
} = await import('./portrait-dps.js');
const { default: domObserver } = await import('../../core/dom-observer.js');

// The feature's catch-up runs through the real observer's onReady, which only fires
// once the observer is attached; attach it so initialize() draws immediately, as it
// does in the game's steady state.
domObserver.start();

beforeEach(() => {
    opts.position = 'above';
    opts.players = [];
    opts.fight = { players: {}, enemies: {} };
    opts.taken = [];
    opts.battleTaken = {};
    opts.mana = {};
    opts.settings = {};
});

/** A line's text, whether it is a bare string or carries its own colour */
const lineText = (line) => (typeof line === 'string' ? line : line.text);

/** A portrait tile as the game builds it, hashed class names and all */
const portrait = (name) => {
    const unit = document.createElement('div');
    unit.className = 'CombatUnit_combatUnit__1a2b3';
    const label = document.createElement('div');
    label.className = 'CombatUnit_name__4c5d6';
    label.textContent = name;
    unit.appendChild(label);
    return unit;
};

describe('reading a portrait', () => {
    test('the name is what the tile says', () => {
        expect(portraitName(portrait('Millennium44'))).toBe('Millennium44');
    });

    test('a tile with no name is not a match for anybody', () => {
        const bare = document.createElement('div');
        expect(portraitName(bare)).toBe('');
        expect(portraitName(null)).toBe('');
    });
});

describe('pairing portraits with the tally', () => {
    const players = [
        { name: 'Millennium44', damage: 98000, dps: 239 },
        { name: 'Gold999', damage: 58000, dps: 142 },
    ];

    test('each portrait gets the row with its own name', () => {
        const units = [portrait('Gold999'), portrait('Millennium44')];
        const pairs = matchPortraits(units, players);

        expect(pairs).toHaveLength(2);
        expect(pairs[0].player.name).toBe('Gold999');
        expect(pairs[1].player.name).toBe('Millennium44');
    });

    test('order is irrelevant, which is the entire point', () => {
        // Matching by position would put Gold999's damage on Millennium44's
        // portrait here, which is the bug the damage tally already had once
        const [first] = matchPortraits([portrait('Gold999')], players);

        expect(first.player.damage).toBe(58000);
    });

    test('a portrait nobody has damage for gets nothing', () => {
        // Rather than falling back to position and borrowing somebody else's
        expect(matchPortraits([portrait('Stranger')], players)).toHaveLength(0);
    });

    test('a tally row with no portrait is simply not drawn', () => {
        expect(matchPortraits([portrait('Gold999')], players)).toHaveLength(1);
    });

    test('nothing to match is nothing, not a crash', () => {
        expect(matchPortraits([], players)).toEqual([]);
        expect(matchPortraits(null, null)).toEqual([]);
    });
});

describe('what a meter says', () => {
    test('the run alone still reserves the fight line, dashed', () => {
        // Two lines whether or not this player has acted this fight: a meter
        // that grows a line when they do gives five portraits three different
        // heights, and shifts them all again at every fight boundary
        const meter = meterText({ name: 'A', damage: 98000, dps: 239.4 });

        expect(meter.lines).toHaveLength(2);
        expect(meter.lines[0]).toBe('— cur');
        expect(meter.lines[1]).toContain('239');
        expect(meter.lines[1]).toContain('total');
    });

    test('with a fight in progress it is two, this fight first', () => {
        // DPs' order, and the point of it: the fight in front of you is the one
        // you can still change, the run is what you read it against
        const meter = meterText({ name: 'A', damage: 88500, dps: 374 }, { damage: 1900, dps: 1052 });

        expect(meter.lines).toHaveLength(2);
        expect(meter.lines[0]).toContain('cur');
        expect(meter.lines[1]).toContain('total');
        expect(meter.lines[0]).toContain('1,052');
    });

    test('too early for a rate reads as no rate, not as zero', () => {
        const meter = meterText({ name: 'A', damage: 120, dps: null });

        expect(meter.lines[1]).toContain('—');
        expect(meter.lines[1]).not.toContain('0 DPS');
        expect(meter.title).toContain('not yet long enough');
    });
});

describe('putting a meter on the tile', () => {
    /** The players area as the game builds it, with one portrait inside */
    const battlePanel = (name) => {
        document.body.innerHTML = '';
        const area = document.createElement('div');
        area.className = 'BattlePanel_playersArea__9xk2j';
        const unit = portrait(name);
        area.appendChild(unit);
        document.body.appendChild(area);
        return unit;
    };

    const meterOf = (unit) => unit.querySelector('[data-toolasha-portrait-dps]');

    beforeEach(() => {
        opts.position = 'above';
        opts.players = [{ name: 'Millennium44', damage: 20_100, dps: 316 }];
        opts.fight = { players: {}, enemies: {} };
    });

    afterEach(() => portraitDps.cleanup());

    test('the meter is a child of the tile, not hung outside it', () => {
        // The first version positioned it at `top: -14px`, outside the tile's
        // box. The battle panel clips its children, so it drew nothing at all —
        // present in the DOM and cropped away.
        const unit = battlePanel('Millennium44');
        portraitDps.initialize();

        const meter = meterOf(unit);
        expect(meter).not.toBeNull();
        expect(meter.style.position).not.toBe('absolute');
        expect(meter.textContent).toContain('316');
    });

    test('above puts it first, below puts it last', () => {
        const unit = battlePanel('Millennium44');
        portraitDps.initialize();
        expect(unit.firstElementChild).toBe(meterOf(unit));

        opts.position = 'below';
        portraitDps.redraw();
        expect(unit.lastElementChild).toBe(meterOf(unit));
    });

    test('a redraw does not leave two', () => {
        const unit = battlePanel('Millennium44');
        portraitDps.initialize();
        portraitDps.redraw();
        portraitDps.redraw();

        expect(unit.querySelectorAll('[data-toolasha-portrait-dps]')).toHaveLength(1);
    });

    test('a portrait with nobody to match gets no meter', () => {
        const unit = battlePanel('Stranger');
        portraitDps.initialize();

        expect(meterOf(unit)).toBeNull();
    });
});

describe('a rate on the monsters', () => {
    test('per slot, so two of the same monster differ', () => {
        // Averaging by name would put one number on both tiles that was true of
        // neither — which is the whole reason enemies are keyed by slot for a
        // fight and by name for a run
        expect(enemyMeterText({ name: 'Veyes', damage: 987, dps: 493 }).text).toBe('493/s');
        expect(enemyMeterText({ name: 'Veyes', damage: 1188, dps: 594 }).text).toBe('594/s');
    });

    test('too early for a rate is a dash', () => {
        expect(enemyMeterText({ name: 'Eye', damage: 40, dps: null }).text).toBe('—');
    });
});

describe('drawing on the monster tiles', () => {
    const monstersArea = (count) => {
        document.body.innerHTML = '';
        const area = document.createElement('div');
        area.className = 'BattlePanel_monstersArea__7z1k';
        for (let i = 0; i < count; i++) area.appendChild(portrait('Veyes'));
        document.body.appendChild(area);
        return [...area.children];
    };

    afterEach(() => portraitDps.cleanup());

    test('each tile gets its own slot’s rate', () => {
        const tiles = monstersArea(2);
        opts.players = [];
        opts.fight = {
            players: {},
            enemies: { 0: { name: 'Veyes', damage: 987, dps: 493 }, 1: { name: 'Veyes', damage: 1188, dps: 594 } },
        };

        portraitDps.initialize();

        expect(tiles[0].textContent).toContain('493/s');
        expect(tiles[1].textContent).toContain('594/s');
    });

    test('a tile with no slot in the fight gets nothing', () => {
        const tiles = monstersArea(2);
        opts.players = [];
        opts.fight = { players: {}, enemies: { 0: { name: 'Veyes', damage: 987, dps: 493 } } };

        portraitDps.initialize();

        expect(tiles[1].querySelector('[data-toolasha-portrait-dps]')).toBeNull();
    });
});

describe('the optional player lines', () => {
    const extras = (overrides = {}) => ({
        showSustain: true,
        taken: null,
        showAccuracy: true,
        showMana: true,
        manaRunway: null,
        ...overrides,
    });

    test('every player renders the same lines, earned or dashed', () => {
        // The invariant the meters live by: a line one player has earned and
        // another has not still renders on both, as figure and dash, so five
        // portraits keep one height
        const earned = meterText(
            { name: 'A', damage: 98000, dps: 239, hits: 47, misses: 3, crits: 15 },
            { damage: 1900, dps: 1052 },
            extras({ taken: { dps: 220, hps: 185 }, manaRunway: 40 })
        );
        const fresh = meterText({ name: 'B', damage: 0, dps: null, hits: 0, misses: 0, crits: 0 }, null, extras());

        expect(earned.lines).toHaveLength(5);
        expect(fresh.lines).toHaveLength(5);
        expect(earned.lines.map(lineText)).toEqual([
            expect.stringContaining('cur'),
            expect.stringContaining('total'),
            'taken 220/s · net −35/s',
            '94% hit · 32% crit',
            'mana ~40s',
        ]);
        expect(fresh.lines.map(lineText)).toEqual([
            '— cur',
            expect.stringContaining('total'),
            '— taken',
            '— hit',
            '— mana',
        ]);
    });

    test('a negative net is red and a positive one is not', () => {
        const losing = meterText({ name: 'A', damage: 0 }, null, extras({ taken: { dps: 220, hps: 185 } }));
        const holding = meterText({ name: 'A', damage: 0 }, null, extras({ taken: { dps: 220, hps: 260 } }));

        expect(losing.lines[2].color).toBe('#f87171');
        expect(holding.lines[2].color).not.toBe('#f87171');
    });

    test('a comfortable mana runway dashes rather than reassures', () => {
        // The line is a warning; "mana ~4:10" would bury the readings that matter
        const meter = meterText({ name: 'A', damage: 0 }, null, extras({ manaRunway: 250 }));
        expect(lineText(meter.lines[4])).toBe('— mana');
    });

    test('too few swings is a dash, not a rate', () => {
        const meter = meterText({ name: 'A', damage: 0, hits: 5, misses: 1, crits: 2 }, null, extras());
        expect(lineText(meter.lines[3])).toBe('— hit');
    });

    test('with everything off the meter is the two lines it always was', () => {
        const meter = meterText({ name: 'A', damage: 98000, dps: 239 });
        expect(meter.lines).toHaveLength(2);
    });
});

describe('the optional enemy lines', () => {
    const extras = (overrides = {}) => ({
        showTimeToKill: true,
        showWaveClear: true,
        waveSeconds: null,
        showOutgoing: true,
        outgoingDps: null,
        showEnrage: true,
        now: 0,
        ...overrides,
    });

    test('every enemy renders the same lines, earned or dashed', () => {
        const boss = enemyMeterText(
            { name: 'Veyes', damage: 987, dps: 100, hp: 800, enrageAt: 102_000 },
            extras({ waveSeconds: 19, outgoingDps: 210 })
        );
        const untouched = enemyMeterText({ name: 'Eye', damage: 0, dps: null, hp: null, enrageAt: null }, extras());

        expect(boss.lines).toHaveLength(5);
        expect(untouched.lines).toHaveLength(5);
        expect(boss.lines.map(lineText)).toEqual(['100/s', 'dead ~8s', 'wave ~19s', 'hits for 210/s', 'enrage 1:42']);
        expect(untouched.lines.map(lineText)).toEqual(['—', '— dead', '— wave', '— hits', '— enrage']);
    });

    test('the outgoing line is red and the enrage line goes amber when close', () => {
        const meter = enemyMeterText(
            { name: 'Veyes', damage: 0, dps: null, hp: null, enrageAt: 29_000 },
            extras({ outgoingDps: 210 })
        );

        expect(meter.lines[3]).toEqual({ text: 'hits for 210/s', color: '#f87171' });
        expect(meter.lines[4].text).toBe('enrage 29s');
        expect(meter.lines[4].color).toBe('#ffcf5c');
    });

    test('past the timer it reads enraged', () => {
        const meter = enemyMeterText({ name: 'Veyes', damage: 0, dps: null, enrageAt: 0 }, extras({ now: 5_000 }));
        expect(meter.lines[4].text).toBe('enraged');
    });

    test('with everything off it is the single rate it always was', () => {
        const meter = enemyMeterText({ name: 'Veyes', damage: 987, dps: 493 });
        expect(meter.lines).toEqual(['493/s']);
        expect(meter.text).toBe('493/s');
    });
});

describe('drawing the optional lines on the panel', () => {
    const panel = () => {
        document.body.innerHTML = '';
        const players = document.createElement('div');
        players.className = 'BattlePanel_playersArea__9xk2j';
        players.appendChild(portrait('Millennium44'));
        players.appendChild(portrait('Gold999'));
        const monsters = document.createElement('div');
        monsters.className = 'BattlePanel_monstersArea__7z1k';
        monsters.appendChild(portrait('Veyes'));
        monsters.appendChild(portrait('Veyes'));
        document.body.appendChild(players);
        document.body.appendChild(monsters);
        return {
            players: [...players.querySelectorAll('[class*="CombatUnit_combatUnit"]')],
            monsters: [...monsters.children],
        };
    };

    const meterLines = (unit) => [...unit.querySelector('[data-toolasha-portrait-dps]').children];

    afterEach(() => portraitDps.cleanup());

    test('a player with data and a player without keep the same height', () => {
        const tiles = panel();
        opts.players = [
            { index: '0', name: 'Millennium44', damage: 20_100, dps: 316, hits: 40, misses: 2, crits: 9 },
            { index: '1', name: 'Gold999', damage: 0, dps: null, hits: 0, misses: 0, crits: 0 },
        ];
        opts.taken = [{ name: 'Millennium44', damage: 900, dps: 220, hps: 185 }];

        portraitDps.initialize();

        const first = meterLines(tiles.players[0]).map((row) => row.textContent);
        const second = meterLines(tiles.players[1]).map((row) => row.textContent);
        expect(first).toHaveLength(second.length);
        expect(first[2]).toBe('taken 220/s · net −35/s');
        expect(second[2]).toBe('— taken');
    });

    test('the wave figure lives on the topmost tile and the rest dash it', () => {
        const tiles = panel();
        opts.fight = {
            players: {},
            enemies: {
                0: { name: 'Veyes', damage: 987, dps: 100, hp: 800, enrageAt: null },
                1: { name: 'Veyes', damage: 1188, dps: 100, hp: 1200, enrageAt: null },
            },
        };

        portraitDps.initialize();

        const first = meterLines(tiles.monsters[0]).map((row) => row.textContent);
        const second = meterLines(tiles.monsters[1]).map((row) => row.textContent);
        expect(first).toHaveLength(second.length);
        // 2,000 health at a combined 200/s
        expect(first).toContain('wave ~10s');
        expect(second).toContain('— wave');
    });

    test('turning a line off removes it from everybody at once', () => {
        const tiles = panel();
        opts.players = [
            { index: '0', name: 'Millennium44', damage: 20_100, dps: 316 },
            { index: '1', name: 'Gold999', damage: 5_000, dps: 80 },
        ];
        opts.settings = {
            portraitDps_sustain: false,
            portraitDps_accuracy: false,
            portraitDps_manaRunway: false,
        };

        portraitDps.initialize();

        expect(meterLines(tiles.players[0])).toHaveLength(2);
        expect(meterLines(tiles.players[1])).toHaveLength(2);
    });
});

describe('observer-driven redraws', () => {
    const panel = () => {
        document.body.innerHTML = '';
        const players = document.createElement('div');
        players.className = 'BattlePanel_playersArea__9xk2j';
        players.appendChild(portrait('Millennium44'));
        document.body.appendChild(players);
        return players;
    };

    afterEach(() => portraitDps.cleanup());

    test('the signature moves with damage and the line-up, not with the clock', () => {
        const run = { players: [{ name: 'A', damage: 10, hits: 1, misses: 0, dps: 5 }] };
        const fight = { players: {}, enemies: { 0: { name: 'V', damage: 3, hp: 90, dps: 1 } } };
        const same = drawSignature(run, fight);
        expect(drawSignature({ players: [{ ...run.players[0], dps: 2 }] }, fight)).toBe(same);
        expect(drawSignature({ players: [{ ...run.players[0], damage: 11 }] }, fight)).not.toBe(same);
        expect(drawSignature(run, { ...fight, enemies: { 0: { ...fight.enemies[0], hp: 80 } } })).not.toBe(same);
    });

    test('a mutation that changed nothing the meter shows does not redraw', () => {
        const players = panel();
        opts.players = [{ name: 'Millennium44', damage: 100, dps: 10, hits: 1, misses: 0 }];
        portraitDps.initialize();
        expect(players.querySelectorAll('[data-toolasha-portrait-dps]')).toHaveLength(1);

        const spy = vi.spyOn(instance, '_draw');
        instance._drawIfChanged();
        expect(spy).not.toHaveBeenCalled();

        // A rebuild that lost the meter is drawn again even with the same data
        players.querySelector('[data-toolasha-portrait-dps]').remove();
        instance._drawIfChanged();
        expect(spy).toHaveBeenCalledTimes(1);

        // And so is new damage
        opts.players = [{ name: 'Millennium44', damage: 120, dps: 10, hits: 2, misses: 0 }];
        instance._drawIfChanged();
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });
});

describe('a spectated guild trial draws nothing', () => {
    // The trial's fight view renders the same `BattlePanel_playersArea` /
    // `BattlePanel_monstersArea` and the same `CombatUnit` tiles, inside the
    // Guild panel. Nothing here has ever read the trial's own stream, so the
    // live fight's own figures were what got painted onto a tile that just
    // happens to share the selector — see `combat-unit-buff-bars.js`'s
    // `isTrialArea`, which the fix reuses.
    const trialPanel = (playerName = 'Millennium44', monsterName = 'Trial Chameleon') => {
        const guild = document.createElement('div');
        guild.className = 'GuildPanel_guildPanel__9z8y7';
        guild.innerHTML = `
            <div class="BattlePanel_playersArea__3a4b5">
                <div class="CombatUnit_combatUnit__1p2q3">
                    <div class="CombatUnit_name__2r3s4">${playerName}</div>
                </div>
            </div>
            <div class="BattlePanel_monstersArea__6c7d8">
                <div class="CombatUnit_combatUnit__1p2q3">
                    <div class="CombatUnit_name__2r3s4">${monsterName}</div>
                </div>
            </div>`;
        document.body.appendChild(guild);
        return guild;
    };

    const meterOn = (el) => el.querySelector('[data-toolasha-portrait-dps]');

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => portraitDps.cleanup());

    test('the watcher’s own live meter does not land on their trial tile', () => {
        opts.players = [{ name: 'Millennium44', damage: 20_100, dps: 316 }];
        const guild = trialPanel();

        portraitDps.initialize();

        expect(meterOn(guild)).toBeNull();
    });

    test('the trial’s boss gets no monster meter either — slots join positionally', () => {
        // Monsters are matched by slot, not name, so the live fight's slot 0
        // would land on whatever the trial happens to draw first
        opts.fight = { players: {}, enemies: { 0: { name: 'Veyes', damage: 987, dps: 493 } } };
        const guild = trialPanel();

        portraitDps.initialize();

        expect(guild.querySelectorAll('[data-toolasha-portrait-dps]')).toHaveLength(0);
    });

    test('a meter already on a tile is removed when the trial view takes over', () => {
        opts.players = [{ name: 'Millennium44', damage: 20_100, dps: 316 }];
        const players = document.createElement('div');
        players.className = 'BattlePanel_playersArea__9xk2j';
        players.appendChild(portrait('Millennium44'));
        document.body.appendChild(players);
        portraitDps.initialize();
        expect(meterOn(players)).not.toBeNull();

        // Not "reset on trial start": the same node, now inside the guild panel —
        // the discriminator is structural, so nothing has to be told the trial began
        players.remove();
        const guild = document.createElement('div');
        guild.className = 'GuildPanel_guildPanel__9z8y7';
        guild.appendChild(players);
        document.body.appendChild(guild);

        portraitDps.redraw();

        expect(meterOn(players)).toBeNull();
    });

    test('ordinary combat is unchanged, and works again once the trial view goes', () => {
        opts.players = [{ name: 'Millennium44', damage: 20_100, dps: 316 }];
        const guild = trialPanel();
        portraitDps.initialize();
        expect(meterOn(guild)).toBeNull();

        // The trial ends, or the Combat tab is returned to: the own panel comes
        // back and needs no timeout or flag to draw on again
        guild.remove();
        const players = document.createElement('div');
        players.className = 'BattlePanel_playersArea__9xk2j';
        players.appendChild(portrait('Millennium44'));
        document.body.appendChild(players);

        portraitDps.redraw();

        expect(meterOn(players)).not.toBeNull();
    });

    test('the party’s own panel is still drawn when a trial panel shares the page', () => {
        opts.players = [{ name: 'Millennium44', damage: 20_100, dps: 316 }];
        opts.fight = { players: {}, enemies: { 0: { name: 'Veyes', damage: 987, dps: 493 } } };

        const players = document.createElement('div');
        players.className = 'BattlePanel_playersArea__9xk2j';
        players.appendChild(portrait('Millennium44'));
        document.body.appendChild(players);

        const monsters = document.createElement('div');
        monsters.className = 'BattlePanel_monstersArea__7z1k';
        monsters.appendChild(portrait('Veyes'));
        document.body.appendChild(monsters);

        const guild = trialPanel();

        portraitDps.initialize();

        expect(meterOn(players)).not.toBeNull();
        expect(meterOn(monsters)).not.toBeNull();
        expect(guild.querySelectorAll('[data-toolasha-portrait-dps]')).toHaveLength(0);
    });
});
