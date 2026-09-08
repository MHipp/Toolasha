/** @vitest-environment happy-dom
 *
 * Combat unit badges.
 *
 * Two things are worth asserting and neither is arithmetic. The first is the
 * join: a badge matched by position puts one player's damage on another's face
 * the moment somebody leaves, so every test here that involves a name is really
 * a test that positions are not used. The second is the re-attach — React
 * rebuilds the battle panel when the Combat tab is left and returned to, and a
 * feature that anchors once comes back to a panel with no badges on it and no
 * way to notice.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    enabled: true,
    run: { players: [] },
    trial: null,
    handlers: [],
    readyHandlers: [],
    domReady: true,
    intervals: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        // portraitDps answers its own switch so the yield-to-portrait gate
        // stays out of tests that are not about it
        getSetting: (key) => (key === 'portraitDps' ? (opts.portraitDps ?? false) : opts.enabled),
        getSettingValue: (_key, fallback) => fallback,
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
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
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
vi.mock('./damage-tracker.js', () => ({ damageBreakdown: () => opts.run }));
vi.mock('../guild/guild-trial-damage.js', () => ({ liveTrialSplit: () => opts.trial }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({
        registerInterval: (id) => opts.intervals.push(id),
        clearAll: () => {
            for (const id of opts.intervals.splice(0)) clearInterval(id);
        },
    }),
}));

const {
    BADGE_MARK,
    COMPACT_MARK,
    badgeStyle,
    badgeRows,
    badgeSource,
    badgeText,
    matchTiles,
    tilesForSource,
    partyTiles,
    default: feature,
    combatUnitBadges,
} = await import('./combat-unit-badges.js');

/** A full combat card as the game builds it, hashed class names and all */
const card = (name) => {
    const unit = document.createElement('div');
    unit.className = 'CombatUnit_combatUnit__1a2b3';
    const label = document.createElement('div');
    label.className = 'CombatUnit_name__9z8y7';
    label.textContent = name;
    unit.appendChild(label);
    return unit;
};

/** A mini unit line — everybody but the watcher, in a spectated trial */
const mini = (name) => {
    const unit = document.createElement('div');
    unit.className = 'MiniUnit_miniUnit__4c5d6';
    const label = document.createElement('div');
    label.className = 'MiniUnit_name__7e8f9';
    label.textContent = name;
    unit.appendChild(label);
    return unit;
};

/** The players area with the given tiles in it */
function panel(...tiles) {
    const area = document.createElement('div');
    area.className = 'BattlePanel_playersArea__2b3c4';
    for (const tile of tiles) area.appendChild(tile);
    document.body.appendChild(area);
    return area;
}

const badgeOf = (tile) => tile.querySelector(`[${BADGE_MARK}]`);

beforeEach(() => {
    opts.enabled = true;
    opts.run = { players: [] };
    opts.trial = null;
    opts.handlers = [];
    opts.readyHandlers = [];
    opts.domReady = true;
    document.body.replaceChildren();
});

afterEach(() => {
    feature.cleanup();
});

describe('choosing which table to badge with', () => {
    test('a live trial outranks this client’s own fight', () => {
        // During a trial the local tracker is measuring side-combat: a member
        // farming a zone while the trial runs on the server
        opts.run = { players: [{ name: 'Alice', damage: 999, dps: 999 }] };
        opts.trial = { players: [{ name: 'Alice', damage: 10, dps: 10, share: 100 }], partyDps: 10 };

        expect(badgeSource()).toEqual({ players: opts.trial.players, source: 'trial' });
    });

    test('no live trial falls back to the run', () => {
        opts.run = { players: [{ name: 'Alice', damage: 5 }] };
        expect(badgeSource()).toEqual({ players: opts.run.players, source: 'run' });
    });

    test('an empty trial table is not a trial', () => {
        // A watched trial that produced no split must not blank the badges a
        // personal fight could still fill
        opts.trial = { players: [], partyDps: null };
        opts.run = { players: [{ name: 'Alice', damage: 5 }] };

        expect(badgeSource().source).toBe('run');
    });
});

describe('the rows a badge is drawn from', () => {
    test('a share is computed when the table does not carry one', () => {
        const rows = badgeRows([
            { name: 'Alice', damage: 750, dps: 75 },
            { name: 'Bob', damage: 250, dps: 25 },
        ]);

        expect(rows.get('alice').share).toBeCloseTo(75, 9);
        expect(rows.get('bob').share).toBeCloseTo(25, 9);
    });

    test('a share the table states is used as stated', () => {
        // The trial summary's share is over the *trial's* total, which is not
        // the total of the rows this client could attribute
        const rows = badgeRows([{ name: 'Alice', damage: 100, dps: 10, share: 4.2 }]);
        expect(rows.get('alice').share).toBe(4.2);
    });

    test('nobody has done anything yet, so there is no share to divide', () => {
        expect(badgeRows([{ name: 'Alice', damage: 0, dps: null }]).get('alice').share).toBeNull();
    });

    test('the biggest of a duplicated name wins, and a blank name is dropped', () => {
        const rows = badgeRows([
            { name: 'Alice', damage: 900 },
            { name: 'alice', damage: 100 },
            { name: '  ', damage: 50 },
        ]);

        expect(rows.size).toBe(1);
        expect(rows.get('alice').damage).toBe(900);
    });
});

describe('what a badge says', () => {
    test('a rate and a share, the rate first', () => {
        const badge = badgeText({ name: 'Alice', damage: 12_400, dps: 1240.4, share: 22.3 });

        expect(badge.text).toBe('1,240/s · 22%');
        expect(badge.title).toContain('Alice');
        expect(badge.title).toContain('22.3% of the split');
    });

    test('a share under ten keeps its decimal, and is drawn dim', () => {
        const badge = badgeText({ name: 'Bob', damage: 100, dps: 10, share: 3.4 });

        expect(badge.text).toBe('10/s · 3.4%');
        expect(badge.color).toBe('rgba(232, 236, 245, 0.55)');
    });

    test('too early for a rate dashes rather than showing a zero', () => {
        // A rate of nothing is an accusation; not enough seconds to divide by
        // is not the same statement
        const badge = badgeText({ name: 'Cara', damage: 0, dps: null, share: null });

        expect(badge.text).toBe('— · —');
        expect(badge.title).toContain('too early for a rate');
    });

    test('the tooltip names where the figures came from', () => {
        expect(badgeText({ name: 'Alice', dps: 1, share: 1 }, 'trial').title).toContain('spectated guild trial');
        expect(badgeText({ name: 'Alice', dps: 1, share: 1 }, 'run').title).toContain('own battle feed');
    });
});

describe('the compact badge a mini unit gets', () => {
    test('the share is dropped — the tile is too narrow to hold both', () => {
        const badge = badgeText({ name: 'Alice', damage: 12_400, dps: 1240.4, share: 22.3 }, 'run', true);

        expect(badge.text).toBe('1,240/s');
        expect(badge.text).not.toContain('%');
        expect(badge.text).not.toContain('·');
        // Moved, not lost: the share is still one hover away
        expect(badge.title).toContain('22.3% of the split');
    });

    test('the full card keeps both values', () => {
        expect(badgeText({ name: 'Alice', damage: 12_400, dps: 1240.4, share: 22.3 }, 'run', false).text).toBe(
            '1,240/s · 22%'
        );
    });

    test('it is lifted out of the flow and pinned to the foot, smaller', () => {
        // happy-dom computes no layout, so what is asserted is the rule that
        // makes the overlap impossible: taken out of the flow entirely, so a
        // badge of any height cannot push the name above it anywhere
        const compact = badgeStyle(true);

        expect(compact.position).toBe('absolute');
        expect(compact.bottom).toBe('0px');
        expect(compact.fontSize).toBe('9px');
        expect(compact.maxWidth).toBe('100%');
        expect(compact.textOverflow).toBe('ellipsis');
        expect(badgeStyle(false).position).toBeUndefined();
        expect(badgeStyle(false).fontSize).toBe('10px');
    });

    test('drawn on a mini unit: compact, marked, and its tile made a positioning context', () => {
        const area = panel(card('Alice'), mini('Bob'));
        opts.run = [
            { name: 'Alice', damage: 750, dps: 75 },
            { name: 'Bob', damage: 250, dps: 25 },
        ];
        opts.run = { players: opts.run };

        feature.initialize();

        const full = badgeOf(area.children[0]);
        const small = badgeOf(area.children[1]);

        expect(full.hasAttribute(COMPACT_MARK)).toBe(false);
        expect(full.textContent).toBe('75/s · 75%');

        expect(small.hasAttribute(COMPACT_MARK)).toBe(true);
        expect(small.textContent).toBe('25/s');
        expect(small.textContent).not.toContain('%');
        expect(small.style.position).toBe('absolute');
        expect(small.style.bottom).toBe('0px');
        expect(small.style.fontSize).toBe('9px');
        // Absolute to its own tile, or it escapes onto somebody else's
        expect(area.children[1].style.position).toBe('relative');
        // And never over the name, which is the first child of the mini tile
        expect(area.children[1].firstElementChild.textContent).toBe('Bob');
    });

    test('cleanup gives the tile its own positioning back', () => {
        const area = panel(mini('Bob'));
        opts.run = { players: [{ name: 'Bob', damage: 250, dps: 25 }] };
        feature.initialize();
        expect(area.children[0].style.position).toBe('relative');

        feature.cleanup();

        expect(area.children[0].style.position).toBe('');
    });
});

describe('finding the tiles and joining them to a table', () => {
    test('full cards and mini units are both party tiles', () => {
        const area = panel(card('Alice'), mini('Bob'));
        expect(partyTiles(area).map((tile) => tile.name)).toEqual(['Alice', 'Bob']);
    });

    test('a tile whose name is not in the table gets nothing rather than a neighbour’s', () => {
        const area = panel(card('Alice'), mini('Stranger'));
        const pairs = matchTiles(partyTiles(area), badgeRows([{ name: 'Alice', damage: 10, dps: 1 }]));

        expect(pairs).toHaveLength(1);
        expect(pairs[0].row.name).toBe('Alice');
        // The tile's shape travels with the pair, because it decides which
        // badge gets drawn on it
        expect(pairs[0].fullCard).toBe(true);
    });

    test('the join survives a difference in case', () => {
        const area = panel(mini('ALICE'));
        expect(matchTiles(partyTiles(area), badgeRows([{ name: 'Alice', damage: 10 }]))).toHaveLength(1);
    });
});

describe('drawing, and coming back after a rebuild', () => {
    test('a panel mounted before the shared observer is ready is badged at readiness', () => {
        opts.domReady = false;
        const area = panel(card('Alice'));
        opts.run = { players: [{ name: 'Alice', damage: 750, dps: 75 }] };

        feature.initialize();
        expect(badgeOf(area.children[0])).toBeNull();

        opts.readyHandlers.forEach((h) => h.callback());
        expect(badgeOf(area.children[0])).not.toBeNull();
    });

    test('every matched tile gets exactly one badge', () => {
        const area = panel(card('Alice'), mini('Bob'));
        opts.run = {
            players: [
                { name: 'Alice', damage: 750, dps: 75 },
                { name: 'Bob', damage: 250, dps: 25 },
            ],
        };

        feature.initialize();

        expect(badgeOf(area.children[0]).textContent).toBe('75/s · 75%');
        // The mini unit's is compact — the share would cover the name
        expect(badgeOf(area.children[1]).textContent).toBe('25/s');
        // The badge is the last child, in the tile's flow — the panel clips
        // anything hung outside the box
        expect(area.children[0].lastElementChild.hasAttribute(BADGE_MARK)).toBe(true);
    });

    test('a redraw over a kept badge produces one badge, not two', () => {
        const area = panel(card('Alice'));
        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };

        feature.initialize();
        feature.redraw();
        feature.redraw();

        expect(area.children[0].querySelectorAll(`[${BADGE_MARK}]`)).toHaveLength(1);
    });

    test('a tile whose player left the table loses its badge', () => {
        const area = panel(card('Alice'), card('Bob'));
        opts.run = {
            players: [
                { name: 'Alice', damage: 10, dps: 1 },
                { name: 'Bob', damage: 10, dps: 1 },
            ],
        };
        feature.initialize();
        expect(badgeOf(area.children[1])).not.toBeNull();

        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };
        feature.redraw();

        expect(badgeOf(area.children[1])).toBeNull();
        expect(badgeOf(area.children[0])).not.toBeNull();
    });

    test('leaving the Combat tab and coming back re-badges the rebuilt panel', () => {
        // The failure this feature is shaped around: React throws the panel
        // away and builds a new one, taking every injected node with it. An
        // anchor captured once is stale and nothing notices
        const area = panel(card('Alice'));
        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };
        feature.initialize();
        expect(badgeOf(area.children[0])).not.toBeNull();

        // The tab change: the whole players area is replaced
        area.remove();
        const rebuilt = panel(card('Alice'));
        expect(badgeOf(rebuilt.children[0])).toBeNull();

        // The observer fires on the new subtree
        expect(opts.handlers).toHaveLength(1);
        for (const handler of opts.handlers) handler.callback(rebuilt);
        feature.redraw();

        expect(badgeOf(rebuilt.children[0])).not.toBeNull();
    });

    test('the observer watches the tiles as well as the area, since either may arrive alone', () => {
        feature.initialize();
        expect(opts.handlers[0].classNames).toEqual([
            'BattlePanel_playersArea',
            'CombatUnit_combatUnit',
            'MiniUnit_miniUnit',
        ]);
    });

    test('a draw that changed nothing does not rewrite the badge', () => {
        const area = panel(card('Alice'));
        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };
        feature.initialize();

        const badge = badgeOf(area.children[0]);
        badge.dataset.probe = 'same node';
        feature.redraw();

        expect(badgeOf(area.children[0]).dataset.probe).toBe('same node');
    });
});

describe('lifecycle', () => {
    test('the setting off draws nothing at all', () => {
        opts.enabled = false;
        const area = panel(card('Alice'));
        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };

        feature.initialize();

        expect(badgeOf(area.children[0])).toBeNull();
        expect(opts.handlers).toHaveLength(0);
    });

    test('cleanup takes the badges and the observer away, and runs twice safely', () => {
        const area = panel(card('Alice'));
        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };
        feature.initialize();

        feature.cleanup();

        expect(document.querySelectorAll(`[${BADGE_MARK}]`)).toHaveLength(0);
        expect(opts.handlers).toHaveLength(0);
        expect(combatUnitBadges.isInitialized).toBe(false);
        expect(() => feature.cleanup()).not.toThrow();
        expect(area.isConnected).toBe(true);
    });

    test('a draw with no battle panel on screen is not an error', () => {
        opts.run = { players: [{ name: 'Alice', damage: 10, dps: 1 }] };
        expect(() => feature.initialize()).not.toThrow();
        expect(() => feature.redraw()).not.toThrow();
    });
});

describe('a spectated guild trial and a background fight never cross wires', () => {
    // The trial's own portraits live inside the Guild panel, which is where a
    // `trial`-sourced badge belongs — but `badgeSource` can fall back to `run`
    // (this client's own fight) while that trial view is still on the page, if
    // the trial's split is momentarily empty or the watcher is also farming a
    // zone in the background. `playersAreaFor` is the fence: a `run` badge
    // must never land on the trial's tiles, and a `trial` badge must never be
    // left on the character's own once the source that drew it is gone.
    const guildPanel = (...tiles) => {
        const guild = document.createElement('div');
        guild.className = 'GuildPanel_guildPanel__9z8y7';
        const area = document.createElement('div');
        area.className = 'BattlePanel_playersArea__3a4b5';
        for (const tile of tiles) area.appendChild(tile);
        guild.appendChild(area);
        document.body.appendChild(guild);
        return { guild, area };
    };

    test('a run-sourced badge does not land on the trial’s tiles', () => {
        opts.trial = null;
        opts.run = { players: [{ name: 'Alice', damage: 750, dps: 75 }] };
        const { area } = guildPanel(card('Alice'));

        feature.initialize();

        expect(badgeOf(area.children[0])).toBeNull();
    });

    test('a badge already on the trial’s tile is removed once the source stops being the trial', () => {
        opts.trial = { players: [{ name: 'Alice', damage: 10, dps: 10, share: 100 }], partyDps: 10 };
        const { area } = guildPanel(card('Alice'));
        feature.initialize();
        expect(badgeOf(area.children[0])).not.toBeNull();

        // The trial's split goes empty — a member farming in the background,
        // say — and the source falls back to the run
        opts.trial = null;
        opts.run = { players: [{ name: 'Alice', damage: 750, dps: 75 }] };
        feature.redraw();

        expect(badgeOf(area.children[0])).toBeNull();
    });

    test('ordinary combat is unchanged, and works again once the trial view goes', () => {
        opts.trial = null;
        opts.run = { players: [{ name: 'Alice', damage: 750, dps: 75 }] };
        const { guild } = guildPanel(card('Alice'));
        feature.initialize();

        guild.remove();
        const area = panel(card('Alice'));
        feature.redraw();

        expect(badgeOf(area.children[0])).not.toBeNull();
    });

    test('the character’s own panel is still badged when a trial panel shares the page', () => {
        opts.trial = { players: [{ name: 'Alice', damage: 10, dps: 10, share: 100 }], partyDps: 10 };
        opts.run = { players: [{ name: 'Bob', damage: 750, dps: 75 }] };

        const ownArea = panel(card('Bob'));
        const { area: trialArea } = guildPanel(card('Alice'));

        feature.initialize();

        // The trial wins as the source (see `badgeSource`), so it is the
        // trial's own tile that gets badged — and the character's own tile,
        // matched against a table that has nothing named Bob, correctly gets
        // nothing rather than the trial's figures
        expect(badgeOf(trialArea.children[0])).not.toBeNull();
        expect(badgeOf(ownArea.children[0])).toBeNull();
    });
});

describe('yielding the full cards to Portrait DPS', () => {
    const tiles = [
        { el: {}, name: 'A', fullCard: true },
        { el: {}, name: 'B', fullCard: false },
    ];

    test('a run-sourced badge with Portrait DPS on keeps only the mini units', () => {
        expect(tilesForSource(tiles, 'run', true)).toEqual([tiles[1]]);
    });

    test('with Portrait DPS off, run badges draw everywhere', () => {
        expect(tilesForSource(tiles, 'run', false)).toEqual(tiles);
    });

    test('a trial split is a different metric and always draws everywhere', () => {
        expect(tilesForSource(tiles, 'trial', true)).toEqual(tiles);
    });
});
