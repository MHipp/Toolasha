/**
 * @vitest-environment happy-dom
 *
 * The Trial Abilities panel, exercised rather than reasoned about.
 *
 * The load-bearing assertion is the dull one: the panel draws every section
 * and none of them reports a failure. Beyond that, the panel's claims are what
 * matter — an honest denominator before the roster is fully captured,
 * `MISSING` only after, and a stat-only sighting drawn as unavailable rather
 * than empty.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** The game data the panel reads, swapped between tests */
const game = vi.hoisted(() => ({ abilityDetailMap: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: game.abilityDetailMap }),
        getCurrentCharacterId: () => 'me',
        on: () => {},
        off: () => {},
    },
}));

// Sessions and geometry live in IndexedDB, which is not what this file is about
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => null,
        set: async () => {},
        getJSON: async () => null,
        setJSON: async () => {},
        tryGet: async () => ({ found: false, value: null }),
    },
}));

vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));

/** The loadout capture, reduced to the two calls the panel makes */
const capture = vi.hoisted(() => ({ listeners: [], players: {} }));

vi.mock('./guild-loadout-capture.js', () => ({
    default: {
        onCaptured: (listener) => {
            capture.listeners.push(listener);
            return () => {
                capture.listeners = capture.listeners.filter((entry) => entry !== listener);
            };
        },
        forPlayer: (name) =>
            capture.players[
                String(name || '')
                    .trim()
                    .toLowerCase()
            ] || null,
    },
}));

const { guildTrialAbilities, SESSION_MAX_AGE_MS } = await import('./guild-trial-abilities.js');
const feature = (await import('./guild-trial-abilities-ui.js')).default;
const {
    guildTrialAbilitiesPanel,
    setControls,
    openTrialAbilitiesPanel,
    openNextTrialUnit,
    retryTrialUnit,
    resetTrialUnitRequests,
    resetControls,
    tierRangeLabel,
    headerLine,
    completionLine,
    staleSessionNote,
    classTagText,
    openTrialUnitFor,
    isAwaitingCapture,
    auraGapText,
    CHIP_LIMIT,
    offPlanExportText,
} = await import('./guild-trial-abilities-ui.js');
const { resetPlanUi, resetChipUi } = await import('./guild-trial-abilities-ui.js');
const guildTrialPlan = (await import('./guild-trial-plan.js')).default;
const { REQUEST_TIMEOUT_MS } = await import('./guild-member-skills.js');
const memberSkills = (await import('./guild-member-skills.js')).default;

const NOW = 1_800_000_000_000;

const aura = (name) => ({
    name,
    isSpecialAbility: true,
    abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
});

/** A snapshot as the loadout store would hand it back */
function snapshot(name, characterId, abilities, over = {}) {
    return {
        name,
        characterId,
        abilities,
        abilitiesAuthoritative: true,
        source: 'battle_unit_fetched',
        at: NOW,
        ...over,
    };
}

/** Tell the listeners a sheet landed, whatever the store now holds for them */
function announce(event) {
    for (const listener of [...capture.listeners]) {
        listener({ abilitiesAuthoritative: true, characterId: null, ...event });
    }
}

/** Put a snapshot in the store and announce it, as a landed sheet would */
function land(snap) {
    capture.players[snap.name.toLowerCase()] = snap;
    announce({
        characterId: snap.characterId ?? null,
        name: snap.name,
        source: snap.source,
        abilitiesAuthoritative: snap.abilitiesAuthoritative === true,
        at: snap.at,
    });
}

const text = () => guildTrialAbilitiesPanel.panel.textContent;
const FAILED = 'could not be drawn';

/** The card whose heading starts with the given text */
function card(title) {
    for (const heading of guildTrialAbilitiesPanel.panel.querySelectorAll('div')) {
        // Collapsible headings carry a ▾/▸ state marker before the title
        const text = (heading.firstChild?.textContent || '').replace(/^[▾▸]\s*/, '');
        if (text.startsWith(title)) return heading;
    }
    return null;
}

const button = (label) =>
    [...guildTrialAbilitiesPanel.panel.querySelectorAll('button')].find((el) => el.textContent === label);

describe('trial abilities panel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        document.body.replaceChildren();
        game.abilityDetailMap = {
            '/abilities/fierce_aura': aura('Fierce Aura'),
            '/abilities/aqua_aura': aura('Aqua Aura'),
            '/abilities/sweep': { name: 'Sweep', isSpecialAbility: false, abilityEffects: [] },
        };
        capture.listeners = [];
        capture.players = {};
        resetTrialUnitRequests();
        resetPlanUi();
        resetChipUi();
        // `controls` is module state: a test that wires its own openNext /
        // retryCurrent / captureFor replaces the built-in action for every
        // test that follows, so a chip press lands in the previous test's spy
        // instead of clicking a unit box
        resetControls();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        feature.cleanup();
        // A panel remembers its state between openings; a test must not
        guildTrialAbilities.session = null;
        guildTrialAbilities.roster = [];
        guildTrialAbilities.guildName = null;
        guildTrialAbilities.currentTier = null;
        guildTrialAbilities.casts = {};
        guildTrialPlan.record?.set({});
        guildTrialPlan.cache = null;
        vi.useRealTimers();
    });

    test('header counts the roster and hedges the coverage while collecting', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob', 'Cara']);
        guildTrialAbilities.setTier(4);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));

        openTrialAbilitiesPanel();
        expect(text()).toContain('Trial abilities — 1/3 captured');
        expect(text()).toContain('2 players still need Battle Info');
        expect(text()).toContain('Aura coverage is read against the 1 captured so far');
        expect(text()).toContain('T4');
        expect(text()).not.toContain(FAILED);
    });

    test('a complete single-tier roster reads "on T4"; mixed tiers read "across"', () => {
        expect(completionLine({ complete: true, capturedCount: 2, rosterCount: 2, capturedTiers: [4] })).toBe(
            '2/2 captured on T4'
        );
        expect(
            completionLine({ complete: true, capturedCount: 5, rosterCount: 5, capturedTiers: [4, 5], captureTier: 4 })
        ).toBe('5/5 captured across T4-T5');
        expect(completionLine({ complete: false })).toBeNull();
        expect(tierRangeLabel([5, 4, 5])).toBe('T4-T5');
        expect(headerLine({ capturedCount: 42, rosterCount: 50 })).toBe('Trial abilities — 42/50 captured');
    });

    test('a session outliving the trial hour is named as the last trial’s', async () => {
        // The trial ended and the panel is opened afterwards: the completed
        // roster stays viewable, headed as the last trial's rather than posing
        // as a capture of one that is not running
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.setTier(4);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));

        vi.setSystemTime(NOW + SESSION_MAX_AGE_MS + 30 * 60_000);
        openTrialAbilitiesPanel();

        expect(text()).toContain('From the last trial');
        expect(text()).toContain('1/1 captured');
        expect(text()).toContain('Fierce Aura');
        expect(text()).not.toContain(FAILED);
    });

    test('staleSessionNote speaks only past the trial hour', () => {
        expect(staleSessionNote({ startedAt: NOW }, NOW + SESSION_MAX_AGE_MS - 1)).toBeNull();
        expect(staleSessionNote({ startedAt: null }, NOW)).toBeNull();
        expect(staleSessionNote(null, NOW)).toBeNull();

        const note = staleSessionNote({ startedAt: NOW }, NOW + 2 * 60 * 60_000);
        expect(note).toContain('From the last trial');
        expect(note).toContain('2h');
    });

    test('coverage names its denominator before completion and MISSING only after', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 78 }]));

        guildTrialAbilitiesPanel.show();
        const coverage = () => card('Equipped aura coverage').textContent;
        expect(coverage()).toContain('Lv78 — Alice');
        // The partial claim, said in full rather than as a shrug: what was
        // looked at, and what was not
        expect(coverage()).toContain('none among 1 captured · 1 unseen');
        expect(coverage()).not.toContain('MISSING');

        guildTrialAbilities.recordCapture(snapshot('Bob', 2, [{ hrid: '/abilities/sweep', level: 50 }]));
        guildTrialAbilitiesPanel.render();
        expect(coverage()).toContain('MISSING');
        expect(coverage()).not.toContain('unseen');
        expect(text()).toContain('2/2 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('the partial coverage row counts the captured, never waiting on the last player', () => {
        // 31 of 50 is the shape that made the old wording useless: `unknown`
        // for the whole hour because the fiftieth click never came
        const partial = auraGapText({ capturedCount: 31, rosterCount: 50, complete: false });
        expect(partial.text).toBe('none among 31 captured · 19 unseen');
        expect(partial.title).toContain('No provider among the 31 captured; 19 unseen');
        expect(partial.title).toContain('not MISSING');

        const done = auraGapText({ capturedCount: 50, rosterCount: 50, complete: true });
        expect(done.text).toBe('MISSING');
        expect(done.title).toBe('Every participant is captured and nobody equips it.');

        // A roster with nothing outstanding is complete however it is flagged
        expect(auraGapText({ capturedCount: 3, rosterCount: 3 }).text).toBe('MISSING');
    });

    test('no roster at all is not proof that nobody equips the aura', () => {
        // `unseen === 0` was doing the work of "everybody has been captured",
        // and an empty roster satisfies it trivially: nothing outstanding
        // because there is nothing. Opening the panel outside a trial, or
        // before the first roster message lands, drew every aura as a red
        // MISSING titled "Every participant is captured and nobody equips it"
        // — the exact false claim the partial wording exists to avoid.
        const empty = auraGapText({ capturedCount: 0, rosterCount: 0, complete: false });
        expect(empty.text).not.toBe('MISSING');
        expect(empty.title).not.toContain('Every participant is captured');
    });

    test('a duplicated aura names its redundant copies without double-counting', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 78 }]));
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, [{ hrid: '/abilities/fierce_aura', level: 40 }]));

        guildTrialAbilitiesPanel.show();
        const coverage = card('Equipped aura coverage').textContent;
        expect(coverage).toContain('Lv78 — Alice');
        expect(coverage).toContain('1 redundant copy');
        expect(text()).not.toContain(FAILED);
    });

    test('a stat-only capture draws as unavailable, not as an empty kit', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [], { abilitiesAuthoritative: false, source: 'popup' }));

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('abilities unavailable');
        expect(text()).not.toContain('no abilities equipped');
        expect(text()).toContain('0/1 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('an authoritative empty kit draws as captured with none equipped', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, []));

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('no abilities equipped');
        expect(text()).toContain('1/1 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('outstanding players sort first while collecting, alphabetical when complete', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Zed']);
        guildTrialAbilities.recordCapture(snapshot('Ann', 1, []));

        guildTrialAbilitiesPanel.show();
        let players = card('Players (').textContent;
        expect(players.indexOf('Zed')).toBeLessThan(players.indexOf('Ann'));

        guildTrialAbilities.recordCapture(snapshot('Zed', 2, []));
        guildTrialAbilitiesPanel.render();
        players = card('Players (').textContent;
        expect(players.indexOf('Ann')).toBeLessThan(players.indexOf('Zed'));
        expect(text()).not.toContain(FAILED);
    });

    /** A unit box as the game draws one, recording clicks into `log` */
    function unitBox(kind, name, log) {
        const box = document.createElement('div');
        box.className = kind === 'combat' ? 'CombatUnit_combatUnit__1m3XT' : 'MiniUnit_miniUnit__379cK';
        const nameEl = document.createElement('div');
        nameEl.className = kind === 'combat' ? 'CombatUnit_name__1SlO1' : 'MiniUnit_name__3Rczb';
        nameEl.textContent = name;
        box.appendChild(nameEl);
        box.addEventListener('click', () => log.push(name));
        return box;
    }

    /**
     * A spectated trial fight, structured as the real DOM draws it: the
     * watcher's own full card plus mini units in the players area, and a
     * "Trial …" boss in the monsters grid anchoring the whole thing.
     * @returns {{clicks: string[]}} The clicks the units received
     */
    function fightView(miniNames, { boss = 'Trial Chameleon', self = null } = {}) {
        const clicks = [];
        const panel = document.createElement('div');
        panel.className = 'BattlePanel_battlePanel__1yPCP';

        const players = document.createElement('div');
        if (self) players.appendChild(unitBox('combat', self, clicks));
        for (const name of miniNames) players.appendChild(unitBox('mini', name, clicks));

        const monsters = document.createElement('div');
        monsters.className = 'BattlePanel_combatUnitGrid__2hTAM';
        if (boss) monsters.appendChild(unitBox('combat', boss, clicks));

        panel.append(players, monsters);
        document.body.appendChild(panel);
        return { clicks };
    }

    // The defaults are what is under test here; `resetControls()` in the
    // beforeEach puts them back whatever an earlier test wired up
    test('the default controls click outstanding fighters even when the roster store holds fresh sheets', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Me', 'Ada']);
        // The roster feature would call both of these "fresh" — a new_battle
        // kit and a stat-only popup sighting, seconds old — and its cycler
        // would therefore never click either. The trial session accepts
        // neither source, so the trial's own cycler must still click them,
        // the watcher's own full card included.
        capture.players.me = snapshot('Me', 1, [], { source: 'new_battle' });
        capture.players.ada = snapshot('Ada', 2, [], { abilitiesAuthoritative: false, source: 'popup' });
        const { clicks } = fightView(['Ada'], { self: 'Me' });

        guildTrialAbilitiesPanel.show();
        button('Open next Battle Info').click();
        button('Open next Battle Info').click();
        expect(clicks).toEqual(['Me', 'Ada']);
        expect(text()).not.toContain(FAILED);
    });

    test('a captured player is skipped; an unanswered request is retried after its window, never skipped', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Ann', 1, []));
        const { clicks } = fightView(['Ann', 'Bob']);

        expect(openNextTrialUnit(NOW)).toMatchObject({ opened: 'Bob', how: 'unit' });
        // Asked a moment ago: in flight, so neither re-clicked nor skipped
        expect(openNextTrialUnit(NOW + 1000)).toMatchObject({ opened: null, how: 'awaiting' });
        // The window lapsed with no sheet: the same player is offered again
        expect(openNextTrialUnit(NOW + REQUEST_TIMEOUT_MS)).toMatchObject({ opened: 'Bob', how: 'unit' });
        expect(clicks).toEqual(['Bob', 'Bob']);
    });

    test('retry re-asks at once, and a landed sheet both captures and clears the in-flight window', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Bob', 'Cara']);
        const { clicks } = fightView(['Bob', 'Cara']);

        expect(openNextTrialUnit(NOW)).toMatchObject({ opened: 'Bob', how: 'unit' });
        // The retry button's gesture: the request window is ignored
        expect(retryTrialUnit('Bob', NOW + 1000)).toMatchObject({ opened: 'Bob', how: 'unit' });

        guildTrialAbilitiesPanel.show();
        land(snapshot('Bob', 1, []));
        // Bob answered: captured, out of the cycle; the next click moves on
        expect(text()).toContain('1/2 captured');
        expect(openNextTrialUnit(NOW + 2000)).toMatchObject({ opened: 'Cara', how: 'unit' });
        expect(clicks).toEqual(['Bob', 'Bob', 'Cara']);
    });

    test('with no fight on screen the cycler answers no-unit and clicks nothing', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann']);
        vi.spyOn(memberSkills, 'openNextUnit').mockReturnValue({ opened: null, how: 'no-unit', logged: 0, total: 0 });
        expect(openNextTrialUnit(NOW)).toEqual({ opened: null, how: 'no-unit' });
        expect(retryTrialUnit('Ann', NOW)).toEqual({ opened: null, how: 'no-unit' });
    });

    test('when the trial finder sees no units, the roster opener is reused as the fallback', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);
        // No fight view fixture: findBattleUnits genuinely finds nothing, as
        // observed at a live trial where the roster button still worked
        const openNextUnit = vi
            .spyOn(memberSkills, 'openNextUnit')
            .mockReturnValue({ opened: 'Ann', how: 'unit', logged: 0, total: 2 });

        expect(openNextTrialUnit(NOW)).toEqual({ opened: 'Ann', how: 'unit' });
        expect(openNextUnit).toHaveBeenCalledWith(NOW);

        // The fallback click starts the trial's own request window: when the
        // finder does see units again, Ann is in flight, not re-asked
        openNextUnit.mockReturnValue({ opened: null, how: 'no-unit', logged: 0, total: 2 });
        const { clicks } = fightView(['Ann', 'Bob']);
        expect(openNextTrialUnit(NOW + 1000)).toEqual({ opened: 'Bob', how: 'unit' });
        expect(clicks).toEqual(['Bob']);
        // ...and the window lapsing offers Ann again, never skips her
        expect(openNextTrialUnit(NOW + REQUEST_TIMEOUT_MS)).toEqual({ opened: 'Ann', how: 'unit' });
    });

    test('the fallback is not consulted while the trial finder is offering units', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann']);
        const openNextUnit = vi.spyOn(memberSkills, 'openNextUnit');
        const { clicks } = fightView(['Ann']);

        expect(openNextTrialUnit(NOW)).toEqual({ opened: 'Ann', how: 'unit' });
        // Ann is in flight: the answer is a wait, not a detour through the
        // roster cycler's freshness rules
        expect(openNextTrialUnit(NOW + 1000)).toEqual({ opened: null, how: 'awaiting' });
        expect(openNextUnit).not.toHaveBeenCalled();
        expect(clicks).toEqual(['Ann']);
    });

    test('the controls invoke their callbacks, and retry names the outstanding player', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, []));

        const openNext = vi.fn();
        const retryCurrent = vi.fn();
        setControls({ openNext, retryCurrent });

        guildTrialAbilitiesPanel.show();
        button('Open next Battle Info').click();
        expect(openNext).toHaveBeenCalledTimes(1);

        button('Retry current player').click();
        expect(retryCurrent).toHaveBeenCalledWith('Alice');
        expect(text()).not.toContain(FAILED);
    });

    /** Every outstanding-player chip the header is drawing, in order */
    const chips = () => [...guildTrialAbilitiesPanel.panel.querySelectorAll('[data-trial-chip]')];

    /** The chip bearing this name */
    const chip = (name) => chips().find((el) => el.dataset.trialChip === name.toLowerCase());

    test('every outstanding player gets a chip, and a captured one loses it', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob', 'Cara']);
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, []));

        openTrialAbilitiesPanel();
        expect(chips().map((el) => el.textContent)).toEqual(['Ann', 'Cara']);
        expect(chip('Ann').title).toContain("Open Ann's Battle Info");
        expect(text()).toContain('2 players still need Battle Info');

        land(snapshot('Ann', 1, []));
        expect(chips().map((el) => el.textContent)).toEqual(['Cara']);
        expect(text()).not.toContain(FAILED);
    });

    test('a chip asks for its own player and for nobody else', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob', 'Cara']);
        const { clicks } = fightView(['Ann', 'Bob', 'Cara']);

        guildTrialAbilitiesPanel.show();
        // The third chip, which the fixed order would have reached last
        chip('Cara').click();
        expect(clicks).toEqual(['Cara']);

        chip('Bob').click();
        expect(clicks).toEqual(['Cara', 'Bob']);
        expect(text()).not.toContain(FAILED);
    });

    test('a chip whose request is in flight is inert until the window lapses', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);
        const { clicks } = fightView(['Ann', 'Bob']);

        guildTrialAbilitiesPanel.show();
        chip('Ann').click();
        expect(clicks).toEqual(['Ann']);
        expect(isAwaitingCapture('Ann', Date.now())).toBe(true);

        // Drawn as pending, and pressing it again inside the window asks nothing
        expect(chip('Ann').getAttribute('aria-disabled')).toBe('true');
        expect(chip('Ann').title).toContain('waiting for the sheet');
        chip('Ann').click();
        chip('Ann').click();
        expect(clicks).toEqual(['Ann']);

        // The window lapsing offers the same player again — never a skip
        vi.setSystemTime(NOW + REQUEST_TIMEOUT_MS);
        guildTrialAbilitiesPanel.render();
        expect(chip('Ann').getAttribute('aria-disabled')).toBe('false');
        chip('Ann').click();
        expect(clicks).toEqual(['Ann', 'Ann']);
    });

    test('the targeted opener honours the shared request window and never opens a stand-in', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);
        const { clicks } = fightView(['Ann', 'Bob']);

        expect(openTrialUnitFor('Bob', NOW)).toEqual({ opened: 'Bob', how: 'unit' });
        expect(openTrialUnitFor('Bob', NOW + 1000)).toEqual({ opened: null, how: 'awaiting' });
        expect(openTrialUnitFor('Bob', NOW + REQUEST_TIMEOUT_MS)).toEqual({ opened: 'Bob', how: 'unit' });
        // Not outstanding, not on screen, not named: nothing is opened in their
        // place — a chip must never fetch somebody else's sheet
        guildTrialAbilities.recordCapture(snapshot('Ann', 1, []));
        expect(openTrialUnitFor('Ann', NOW)).toEqual({ opened: null, how: 'no-unit' });
        expect(openTrialUnitFor('Nobody', NOW)).toEqual({ opened: null, how: 'no-unit' });
        expect(openTrialUnitFor('', NOW)).toEqual({ opened: null, how: 'no-unit' });
        expect(clicks).toEqual(['Bob', 'Bob']);
    });

    test('a chip press moves focus to the next askable player, and a capture keeps it there', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob', 'Cara']);
        fightView(['Ann', 'Bob', 'Cara']);

        guildTrialAbilitiesPanel.show();
        chip('Ann').click();
        // Ann is in flight and inert; the press-press-press rhythm needs the
        // focus already on the next player
        expect(document.activeElement).toBe(chip('Bob'));

        chip('Bob').click();
        expect(document.activeElement).toBe(chip('Cara'));

        // The sheet lands and the whole block is rebuilt: focus comes back by
        // name, not by element identity
        land(snapshot('Bob', 2, []));
        expect(chips().map((el) => el.textContent)).toEqual(['Ann', 'Cara']);
        expect(document.activeElement).toBe(chip('Cara'));
    });

    test('focus lands where a captured chip stood when its name is gone', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob', 'Cara']);
        fightView(['Ann', 'Bob', 'Cara']);

        guildTrialAbilitiesPanel.show();
        chip('Cara').focus();
        expect(document.activeElement).toBe(chip('Cara'));

        // Cara answered: her chip is gone, and focus takes the place it held
        // (the row's end) rather than jumping back to the start
        land(snapshot('Cara', 3, []));
        expect(chips().map((el) => el.textContent)).toEqual(['Ann', 'Bob']);
        expect(document.activeElement).toBe(chip('Bob'));
    });

    test('the chips take no focus from a reader who never touched them', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);

        guildTrialAbilitiesPanel.show();
        expect(chips()).toHaveLength(2);
        expect(document.activeElement).not.toBe(chip('Ann'));

        land(snapshot('Ann', 1, []));
        expect(document.activeElement).not.toBe(chip('Bob'));
    });

    test('a player name is drawn as text, never as markup', async () => {
        await feature.initialize('Cats');
        const nasty = '<img src=x onerror=alert(1)>';
        guildTrialAbilities.setRoster([nasty, 'Ann & Bob']);

        openTrialAbilitiesPanel();
        const drawn = chips().map((el) => el.textContent);
        expect(drawn).toContain(nasty);
        // Written, not parsed: no element came out of the name, and the
        // ampersand is still an ampersand rather than an entity
        expect(chip(nasty).querySelectorAll('*')).toHaveLength(0);
        expect(chip(nasty).innerHTML).not.toContain('<img');
        expect(drawn).toContain('Ann & Bob');
        expect(text()).not.toContain(FAILED);
    });

    test('a big roster shows the front of the queue and folds the rest behind "+N more"', async () => {
        await feature.initialize('Cats');
        const roster = Array.from({ length: 50 }, (_, index) => `P${String(index).padStart(2, '0')}`);
        guildTrialAbilities.setRoster(roster);

        openTrialAbilitiesPanel();
        expect(chips()).toHaveLength(CHIP_LIMIT);
        const more = button(`+${50 - CHIP_LIMIT} more`);
        expect(more).toBeTruthy();

        more.click();
        expect(chips()).toHaveLength(50);
        expect(button(`+${50 - CHIP_LIMIT} more`)).toBeUndefined();
        expect(text()).not.toContain(FAILED);
    });

    test('the chip press goes through the wired control, once per press', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Ann', 'Bob']);
        const captureFor = vi.fn();
        setControls({ captureFor });

        guildTrialAbilitiesPanel.show();
        chip('Bob').click();
        expect(captureFor).toHaveBeenCalledTimes(1);
        expect(captureFor).toHaveBeenCalledWith('Bob');
    });

    test('recapture throws the session away from the panel', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, []));

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('1/1 captured');
        button('Recapture trial roster').click();
        expect(text()).toContain('0/1 captured');
        expect(text()).toContain('needs Battle Info');
        expect(text()).not.toContain(FAILED);
    });

    test('a landed sheet re-renders the panel through onCaptured', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);

        guildTrialAbilitiesPanel.show();
        expect(text()).toContain('0/1 captured');

        land(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));
        expect(text()).toContain('1/1 captured');
        expect(card('Equipped aura coverage').textContent).toContain('Lv70 — Alice');
        expect(text()).not.toContain(FAILED);
    });

    test('a Battle Info sheet a later new_battle folded over is still captured', async () => {
        // The reported symptom, exactly: three popups opened, three sheets on
        // disk, the panel still saying "needs Battle Info". The event names the
        // popup; the store is read back a moment later and by then a wave of
        // `new_battle` has taken over the entry's `source`, and the read-back's
        // source was what the panel judged the capture by
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        capture.players.alice = snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }], {
            source: 'new_battle',
            at: NOW + 500,
            abilitiesAt: NOW,
        });
        announce({ name: 'Alice', characterId: 1, source: 'battle_unit_fetched', at: NOW });

        openTrialAbilitiesPanel();
        expect(text()).toContain('1/1 captured');
        expect(card('Equipped aura coverage').textContent).toContain('Lv70 — Alice');
        expect(text()).not.toContain(FAILED);
    });

    test('a new_battle event is still refused, whatever the store holds', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        land(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }], { source: 'new_battle' }));

        openTrialAbilitiesPanel();
        expect(text()).toContain('0/1 captured');
        expect(text()).not.toContain(FAILED);
    });

    test('a sheet landing while the session is still being restored is heard', async () => {
        // The subscription used to be made after the restore's storage read had
        // been awaited, so a popup answered during the read reached the store
        // and nothing else
        const pending = feature.initialize('Cats');
        expect(capture.listeners).toHaveLength(1);
        land(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));
        await pending;

        expect(guildTrialAbilities.session?.players['id:1']?.abilitiesAuthoritative).toBe(true);
    });

    test('a saved plan draws verdict lines and a header status, and stays quiet about the unplanned', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob', 'Cara', 'Dana']);
        guildTrialAbilities.recordCapture(
            snapshot('Alice', 1, [
                { hrid: '/abilities/fierce_aura', level: 200 },
                { hrid: '/abilities/sweep', level: 40 },
            ])
        );
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, [{ hrid: '/abilities/sweep', level: 50 }]));
        guildTrialAbilities.recordCapture(snapshot('Cara', 3, [{ hrid: '/abilities/aqua_aura', level: 90 }]));
        guildTrialAbilities.recordCapture(snapshot('Dana', 4, [{ hrid: '/abilities/sweep', level: 10 }]));

        openTrialAbilitiesPanel();
        const box = guildTrialAbilitiesPanel.panel.querySelector('textarea');
        box.value = [
            '# the plan',
            'Alice: Fierce Aura 200',
            'Bob: Aqua Aura',
            'Cara: Aqua Aura 150',
            'Zed: Flurry',
        ].join('\n');
        box.dispatchEvent(new Event('input'));
        button('Save plan').click();
        await vi.waitFor(() => expect(text()).toContain('on plan'));

        const status = card('Plan').textContent;
        expect(status).toContain('1/3 on plan');
        expect(status).toContain('1 with no plan');
        expect(status).toContain('1 not in trial');
        expect(status).toContain('1 unrecognised ability: Flurry');

        const players = card('Players (').textContent;
        expect(players).toContain('missing: Aqua Aura');
        expect(players).toContain('under level: Aqua Aura 90 < 150');
        expect(players).toContain('on plan · extra: Sweep');
        // Dana is on nobody's plan, so her row says nothing about one
        expect(players.slice(players.indexOf('Dana'))).not.toContain('on plan');
        expect(text()).not.toContain(FAILED);
    });

    test('the Controls card draws first, above the summary', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);

        openTrialAbilitiesPanel();
        const content = text();
        expect(content.indexOf('Controls')).toBeGreaterThan(-1);
        expect(content.indexOf('Controls')).toBeLessThan(content.indexOf('Trial abilities —'));
        expect(content).not.toContain(FAILED);
    });

    test('offPlanExportText lists every deviation under a counted header, and stays null with nothing to say', () => {
        const state = {
            capturedTiers: [4],
            captureTier: 4,
            startedAt: NOW,
            planCompare: {
                verdicts: [
                    { name: 'Alice', status: 'ok', missing: [], underLevel: [], extra: ['Sweep'] },
                    { name: 'Bob', status: 'missing', missing: ['Aqua Aura'], underLevel: [], extra: [] },
                    {
                        name: 'Cara',
                        status: 'missing',
                        missing: ['Fierce Aura'],
                        underLevel: [{ name: 'Aqua Aura', level: 90, required: 150 }],
                        extra: [],
                    },
                    { name: 'Dana', status: 'uncaptured', missing: [], underLevel: [], extra: [] },
                ],
                summary: { planLines: 4, plannedPlayers: 4, onPlan: 1 },
            },
        };

        expect(offPlanExportText(state)).toBe(
            [
                `Off plan 3/4 (T4, ${new Date(NOW).toISOString().slice(0, 10)})`,
                'Bob — missing: Aqua Aura',
                'Cara — missing: Fierce Aura · under level: Aqua Aura 90 < 150',
                'Dana — not captured — needs Battle Info',
            ].join('\n')
        );

        // Everyone on plan, and no plan at all, are both a null — the button
        // speaks instead of copying an empty list
        expect(
            offPlanExportText({
                planCompare: {
                    verdicts: [{ name: 'Alice', status: 'ok', missing: [], underLevel: [], extra: [] }],
                    summary: { planLines: 1, plannedPlayers: 1, onPlan: 1 },
                },
            })
        ).toBeNull();
        expect(
            offPlanExportText({ planCompare: { verdicts: [], summary: { planLines: 0, plannedPlayers: 0 } } })
        ).toBeNull();
        expect(offPlanExportText(null)).toBeNull();
    });

    test('the Plan heading’s export button copies the off-plan list and flashes Copied', async () => {
        let copied = null;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            copied = value;
            return Promise.resolve();
        });

        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.setTier(4);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 200 }]));
        guildTrialAbilities.recordCapture(snapshot('Bob', 2, [{ hrid: '/abilities/sweep', level: 50 }]));
        await guildTrialPlan.setText('Alice: Fierce Aura 200\nBob: Aqua Aura');

        openTrialAbilitiesPanel();
        const exportButton = button('Export off-plan');
        // In the heading row, so it is pressable with the card folded
        expect(card('Plan').contains(exportButton)).toBe(true);

        exportButton.click();
        await vi.waitFor(() => expect(exportButton.textContent).toBe('Copied ✓'));
        expect(copied).toContain('Off plan 1/2 (T4,');
        expect(copied).toContain('Bob — missing: Aqua Aura');
        expect(copied).not.toContain('Alice');

        // The flash gives the label back
        vi.advanceTimersByTime(2000);
        expect(button('Export off-plan')).toBeTruthy();
        expect(text()).not.toContain(FAILED);
    });

    test('with everyone on plan the export says so instead of copying', async () => {
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 200 }]));
        await guildTrialPlan.setText('Alice: Fierce Aura');

        openTrialAbilitiesPanel();
        button('Export off-plan').click();
        await vi.waitFor(() =>
            expect(
                [...guildTrialAbilitiesPanel.panel.querySelectorAll('button')].some(
                    (el) => el.textContent === 'All on plan ✓'
                )
            ).toBe(true)
        );
        expect(writeText).not.toHaveBeenCalled();
    });

    test('a plan naming nobody who turned up does not report everyone on plan', async () => {
        // The lead wrote the plan for last week's roster: every line matches a
        // name not in this trial, so nothing was compared. "All on plan ✓" is
        // the one thing that must not be said about it
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 200 }]));
        await guildTrialPlan.setText('Zed: Fierce Aura');

        openTrialAbilitiesPanel();
        button('Export off-plan').click();
        await vi.waitFor(() =>
            expect(
                [...guildTrialAbilitiesPanel.panel.querySelectorAll('button')].some(
                    (el) => el.textContent === 'Nobody planned is here'
                )
            ).toBe(true)
        );
        expect(writeText).not.toHaveBeenCalled();
    });

    test('a guild switch drops an unsaved plan draft instead of leaking it onto the new guild', async () => {
        // One account running a main plus alts sees this mid-session: the lead
        // starts typing a plan, then the trial's guild name resolves to (or the
        // character switches to) a different guild before "Save plan" is clicked.
        // The draft used to survive the redraw regardless of guild, so the box
        // kept showing the old guild's half-written text over the new guild's
        // saved plan — and clicking Save would have written it there.
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        await guildTrialPlan.setText('Alice: Sweep');

        openTrialAbilitiesPanel();
        const box = () => guildTrialAbilitiesPanel.panel.querySelector('textarea');
        expect(box().value).toBe('Alice: Sweep');
        box().value = 'Alice: Fierce Aura 200 (not saved yet)';
        box().dispatchEvent(new Event('input'));

        await guildTrialAbilities.setGuildName('Dogs');
        guildTrialAbilitiesPanel.render();

        // Dogs has no saved plan, and the stale Cats draft must not stand in for it
        expect(box().value).toBe('');
        expect(text()).not.toContain(FAILED);
    });

    test('the Plan card reports what the save changed, and says nothing on the first save', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);

        openTrialAbilitiesPanel();
        const box = () => guildTrialAbilitiesPanel.panel.querySelector('textarea');
        box().value = 'Alice: Fierce Aura 150';
        box().dispatchEvent(new Event('input'));
        button('Save plan').click();
        await vi.waitFor(() => expect(text()).toContain('on plan'));
        // Nothing preceded this save, so there is no change to report
        expect(card('Plan').textContent).not.toContain('Since last save');

        box().value = ['Alice: Fierce Aura 200, Sweep', 'Bob: Aqua Aura'].join('\n');
        box().dispatchEvent(new Event('input'));
        button('Save plan').click();
        await vi.waitFor(() => expect(card('Plan').textContent).toContain('Since last save'));

        const plan = card('Plan').textContent;
        expect(plan).toContain('1 changed (Alice: +Sweep Fierce Aura 150→200)');
        expect(plan).toContain('1 added');
        expect(text()).not.toContain(FAILED);
    });

    test('the export carries the plan and each captured player’s verdict', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice']);
        guildTrialAbilities.recordCapture(snapshot('Alice', 1, [{ hrid: '/abilities/fierce_aura', level: 70 }]));
        await guildTrialPlan.setText('Alice: Fierce Aura 200');

        const exported = guildTrialAbilities.exportSnapshot(game.abilityDetailMap);
        expect(exported.plan.text).toBe('Alice: Fierce Aura 200');
        expect(exported.plan.summary).toMatchObject({ plannedPlayers: 1, onPlan: 0 });
        expect(exported.players['1'].planVerdict).toMatchObject({
            status: 'underLevel',
            underLevel: [{ name: 'Fierce Aura', level: 70, required: 200 }],
        });
    });

    test('cleanup unsubscribes from the capture events', async () => {
        await feature.initialize('Cats');
        expect(capture.listeners).toHaveLength(1);
        feature.cleanup();
        expect(capture.listeners).toHaveLength(0);
    });
});

describe('class tags on the players card', () => {
    const fireball = {
        name: 'Fireball',
        abilityEffects: [
            {
                effectType: '/ability_effect_types/damage',
                combatStyleHrid: '/combat_styles/magic',
                damageType: '/damage_types/fire',
            },
        ],
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        document.body.replaceChildren();
        game.abilityDetailMap = { '/abilities/fireball': fireball };
        capture.listeners = [];
        capture.players = {};
        resetTrialUnitRequests();
        resetPlanUi();
        resetChipUi();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        feature.cleanup();
        guildTrialAbilities.session = null;
        guildTrialAbilities.roster = [];
        guildTrialAbilities.guildName = null;
        guildTrialAbilities.currentTier = null;
        guildTrialAbilities.casts = {};
        guildTrialPlan.record?.set({});
        guildTrialPlan.cache = null;
        vi.useRealTimers();
    });

    test('a chip sits beside the name of a player whose casts have been watched', async () => {
        await feature.initialize('Cats');
        guildTrialAbilities.setRoster(['Alice', 'Bob']);
        guildTrialAbilities.noteTrialStart(NOW);
        guildTrialAbilities.noteAbilityCast('Alice', '/abilities/fireball');

        openTrialAbilitiesPanel();

        const chips = [...guildTrialAbilitiesPanel.panel.querySelectorAll('span')].filter(
            (span) => span.textContent === 'FIRE'
        );
        expect(chips).toHaveLength(1);
        expect(chips[0].title).toContain('Fire Mage');
        // The evidence, so a reader can check the claim against the person
        expect(chips[0].title).toContain('fireball');
        // Bob cast nothing and gets no chip, rather than a default one
        expect(text()).toContain('Bob');
        expect(text()).not.toContain(FAILED);
    });

    test('the wording says it is an inference, never a capture', () => {
        const tag = classTagText({
            key: 'healer',
            label: 'Healer',
            short: 'HEAL',
            basis: 'an ally heal in the ability stream',
            evidence: ['/abilities/bloom'],
        });

        expect(tag.text).toBe('HEAL');
        expect(tag.title).toContain('inferred from an ally heal in the ability stream: bloom');
        expect(tag.title).toContain('Battle Info capture is the only authority');
    });

    test('no verdict draws nothing at all', () => {
        expect(classTagText(null)).toBeNull();
        expect(classTagText({ label: 'Mage' })).toBeNull();
    });
});
