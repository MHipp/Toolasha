/**
 * @vitest-environment happy-dom
 *
 * Getting the monsters' names back after a mid-fight reload.
 *
 * The tick says `cHP` and nothing else, so a page reloaded mid-battle files
 * everything under "Unknown Enemy" until the next fight starts. The names are on
 * screen the whole time; this is the join back to them.
 *
 * The cases that matter are the ones where a wrong answer would be worse than no
 * answer: two monsters that cannot be told apart, a panel that is not there, and
 * a tile whose shape has changed. Every one of them has to produce nothing.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { parseUnitTexts, readMonsterUnits, matchMonsterNames, recoverMonsterNames } from './battle-panel-monsters.js';
import { _resetGameNumberSeparators } from './number-parser.js';

/**
 * The battle panel, with one tile per monster.
 * @param {Array<{name: string, hp: number, max: number}>} monsters - What to draw
 * @returns {HTMLElement} A root to read from
 */
function panel(monsters) {
    const root = document.createElement('div');
    const tiles = monsters
        .map(
            (monster) =>
                `<div><div>${monster.name}</div><div>${monster.hp}/${monster.max}</div>` +
                `<div>${monster.max}/${monster.max}</div><div>T2</div><div>Auto Attack</div><div>0/s</div></div>`
        )
        .join('');

    root.innerHTML = `<div class="BattlePanel_monstersArea__aB1"><div class="BattlePanel_combatUnitGrid__x9">${tiles}</div></div>`;
    return root;
}

describe('reading one tile', () => {
    const TILE = ['Eyes', '2215/2215', '2215/2215', 'T2', 'Auto Attack', '0/s'];

    test('the name is the first part with no digit in it', () => {
        expect(parseUnitTexts(TILE)).toEqual({ name: 'Eyes', hp: 2215 });
    });

    test('the health is the first bar, not the mana one under it', () => {
        expect(parseUnitTexts(['Eye', '1348/2035', '2035/2035'])).toEqual({ name: 'Eye', hp: 1348 });
    });

    test('the health is read from the bar alone, not from a run-together string', () => {
        // Flattened, this tile reads `2215/22152215/2215` and there is no way to
        // tell where the first denominator ends. Only the numerator is taken now,
        // because the tick states the maximum itself as `mHP`.
        expect(parseUnitTexts(TILE).hp).toBe(2215);
        expect(parseUnitTexts(TILE).max).toBeUndefined();
    });

    test('thousands separators are read as numbers', () => {
        expect(parseUnitTexts(['Giant Eye', '12,480/40,000'])).toEqual({ name: 'Giant Eye', hp: 12480 });
    });

    test('bars that are not their own parts still give the health', () => {
        expect(parseUnitTexts(['Eyes', '2215/22152215/2215'])).toEqual({ name: 'Eyes', hp: 2215 });
    });

    test('a tile with no separable name is nothing at all', () => {
        expect(parseUnitTexts(['Eyes2215/22152215/2215T2'])).toBeNull();
    });

    test('something that is not a unit tile is nothing', () => {
        expect(parseUnitTexts(['Abilities'])).toBeNull();
        expect(parseUnitTexts([])).toBeNull();
        expect(parseUnitTexts(null)).toBeNull();
    });

    test('a bar with no name beside it is nothing', () => {
        // Rather than an empty name, which would become an enemy called ""
        expect(parseUnitTexts(['1185/1420'])).toBeNull();
    });
});

describe('locale-grouped health bars', () => {
    const asLocale = (value) => {
        localStorage.setItem('i18nextLng', value);
        _resetGameNumberSeparators();
    };

    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    test('en-US comma grouping', () => {
        asLocale('en-US');
        expect(parseUnitTexts(['Giant Eye', '12,480/40,000'])).toEqual({ name: 'Giant Eye', hp: 12480 });
    });

    test('de-DE period grouping — the bug this replaces', () => {
        // A hardcoded `\d[\d,]*` captures "1.348/2.035" as just "1": the period
        // isn't in the class, so the match stops at the first group boundary.
        asLocale('de-DE');
        expect(parseUnitTexts(['Eye', '1.348/2.035'])).toEqual({ name: 'Eye', hp: 1348 });
        expect(parseUnitTexts(['Giant Eye', '12.480/40.000'])).toEqual({ name: 'Giant Eye', hp: 12480 });
    });

    test('de-DE period grouping via the loose fallback (bars not their own parts)', () => {
        asLocale('de-DE');
        expect(parseUnitTexts(['Eyes', '2.215/2.2152.215/2.215'])).toEqual({ name: 'Eyes', hp: 2215 });
    });
});

describe('reading the panel', () => {
    test('every monster the game is drawing', () => {
        const units = readMonsterUnits(
            panel([
                { name: 'Eyes', hp: 2215, max: 2215 },
                { name: 'Veyes', hp: 1200, max: 2395 },
            ])
        );

        expect(units).toEqual([
            { name: 'Eyes', hp: 2215 },
            { name: 'Veyes', hp: 1200 },
        ]);
    });

    test('no panel is no monsters, not an error', () => {
        expect(readMonsterUnits(document.createElement('div'))).toEqual([]);
    });
});

describe('joining the panel to the tick', () => {
    test('a monster is identified by the health both sides agree on', () => {
        // Positionally would be an assumption about how the panel handles a dead
        // monster; health is a fact both sides state
        const units = [
            { name: 'Eyes', hp: 2215 },
            { name: 'Veyes', hp: 1200 },
        ];
        const names = matchMonsterNames(units, { 0: { cHP: 1200 }, 1: { cHP: 2215 } });

        expect(names).toEqual({ 0: 'Veyes', 1: 'Eyes' });
    });

    test('two of a kind at the same health are not ambiguous', () => {
        // A wave of three Eyes at full health is the common case, and whichever
        // one this is, it is called Eyes
        const units = [
            { name: 'Eyes', hp: 2215 },
            { name: 'Eyes', hp: 2215 },
        ];
        expect(matchMonsterNames(units, { 0: { cHP: 2215 } })).toEqual({ 0: 'Eyes' });
    });

    test('two different monsters at the same health claim nothing', () => {
        // A wrong name is worse than no name: it would move damage from one
        // monster of the wave onto another and read as evidence
        const units = [
            { name: 'Eye', hp: 2215 },
            { name: 'Eyes', hp: 2215 },
        ];
        expect(matchMonsterNames(units, { 0: { cHP: 2215 } })).toEqual({});
    });

    test('a monster whose health matches nothing drawn is left alone', () => {
        const units = [{ name: 'Eyes', hp: 2215 }];
        expect(matchMonsterNames(units, { 0: { cHP: 9 } })).toEqual({});
    });

    test('some identified and some not is a partial answer, not none', () => {
        const units = [
            { name: 'Eye', hp: 100 },
            { name: 'Eye', hp: 2215 },
            { name: 'Eyes', hp: 2215 },
        ];
        expect(matchMonsterNames(units, { 0: { cHP: 100 }, 1: { cHP: 2215 } })).toEqual({
            0: 'Eye',
        });
    });

    test('nothing drawn is nothing claimed', () => {
        expect(matchMonsterNames([], { 0: { cHP: 2215 } })).toEqual({});
    });
});

describe('end to end, from a panel and a tick', () => {
    test('the fight the reload landed in gets its names back', () => {
        const root = panel([
            { name: 'Eyes', hp: 2215, max: 2215 },
            { name: 'Eyes', hp: 1900, max: 2215 },
            { name: 'Veyes', hp: 2395, max: 2395 },
        ]);
        const names = recoverMonsterNames({ 0: { cHP: 2215 }, 1: { cHP: 1900 }, 2: { cHP: 2395 } }, root);

        expect(names).toEqual({
            0: 'Eyes',
            1: 'Eyes',
            2: 'Veyes',
        });
    });

    test('a panel that is not there changes nothing', () => {
        expect(recoverMonsterNames({ 0: { cHP: 2215 } }, document.createElement('div'))).toEqual({});
    });
});
