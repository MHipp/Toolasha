/**
 * Tests for the game's own labyrinth formulas and reward tables.
 *
 * Moved out of labyrinth-clear-rate.test.js with the code they cover; like
 * the formulas themselves these need no game state.
 */

import { describe, test, expect } from 'vitest';

import {
    labyrinthFloorClearLevel,
    labyrinthFloorForLevel,
    labyrinthFloorLevelBand,
    labyrinthGridSize,
    labyrinthRoomRewards,
} from './labyrinth-formulas.js';

describe('official labyrinth reward tables', () => {
    test('a challenge room rolls MIN(Floor × 5%, 50%) for a token, capped from floor 10', () => {
        expect(labyrinthRoomRewards(1, 'combat').tokens).toBeCloseTo(0.05, 10);
        expect(labyrinthRoomRewards(7, 'skilling').tokens).toBeCloseTo(0.35, 10);
        expect(labyrinthRoomRewards(10, 'combat').tokens).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(25, 'combat').tokens).toBeCloseTo(0.5, 10);
    });

    test("a challenge room rolls MIN(Floor × 1%, 10%) for a Purdora's Box of its own kind", () => {
        const combat = labyrinthRoomRewards(7, 'combat');
        expect(combat.combatBoxes).toBeCloseTo(0.07, 10);
        expect(combat.skillingBoxes).toBe(0);

        // Enhancing rooms are skilling rooms, so they pay the Skilling box
        for (const kind of ['skilling', 'enhancing']) {
            const skilling = labyrinthRoomRewards(7, kind);
            expect(skilling.skillingBoxes).toBeCloseTo(0.07, 10);
            expect(skilling.combatBoxes).toBe(0);
        }

        expect(labyrinthRoomRewards(10, 'combat').combatBoxes).toBeCloseTo(0.1, 10);
        expect(labyrinthRoomRewards(30, 'combat').combatBoxes).toBeCloseTo(0.1, 10);
    });

    test('a treasure room always pays MIN(Floor, 10) tokens', () => {
        expect(labyrinthRoomRewards(3, 'treasure').tokens).toBe(3);
        expect(labyrinthRoomRewards(10, 'treasure').tokens).toBe(10);
        expect(labyrinthRoomRewards(14, 'treasure').tokens).toBe(10);
    });

    test('a treasure room rolls MIN(Floor × 5%, 50%) for one box of each type', () => {
        const mid = labyrinthRoomRewards(6, 'treasure');
        expect(mid.skillingBoxes).toBeCloseTo(0.3, 10);
        expect(mid.combatBoxes).toBeCloseTo(0.3, 10);

        const capped = labyrinthRoomRewards(12, 'treasure');
        expect(capped.skillingBoxes).toBeCloseTo(0.5, 10);
        expect(capped.combatBoxes).toBeCloseTo(0.5, 10);
    });

    test('the floor exit always pays 5 × Floor tokens', () => {
        expect(labyrinthRoomRewards(1, 'exit').tokens).toBe(5);
        expect(labyrinthRoomRewards(9, 'exit').tokens).toBe(45);
    });

    test('the floor exit pays both box types from floor 4, averaging (Floor − 3) / 2 each', () => {
        expect(labyrinthRoomRewards(3, 'exit').skillingBoxes).toBe(0);
        expect(labyrinthRoomRewards(3, 'exit').combatBoxes).toBe(0);

        expect(labyrinthRoomRewards(4, 'exit').skillingBoxes).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(4, 'exit').combatBoxes).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(9, 'exit').skillingBoxes).toBeCloseTo(3, 10);
        expect(labyrinthRoomRewards(9, 'exit').combatBoxes).toBeCloseTo(3, 10);
    });

    test('the floor exit pays a Refinement Chest from floor 6, averaging (Floor − 4) / 2', () => {
        expect(labyrinthRoomRewards(5, 'exit').refinementChests).toBe(0);
        expect(labyrinthRoomRewards(6, 'exit').refinementChests).toBeCloseTo(1, 10);
        expect(labyrinthRoomRewards(9, 'exit').refinementChests).toBeCloseTo(2.5, 10);
    });

    test('nothing drops below floor 1', () => {
        for (const kind of ['combat', 'skilling', 'treasure', 'exit']) {
            expect(labyrinthRoomRewards(0, kind)).toEqual({
                tokens: 0,
                skillingBoxes: 0,
                combatBoxes: 0,
                refinementChests: 0,
            });
        }
    });
});

describe('labyrinthGridSize', () => {
    test('a floor is MIN(3 + Floor, 8) rooms per side', () => {
        expect(labyrinthGridSize(1)).toBe(4);
        expect(labyrinthGridSize(4)).toBe(7);
        expect(labyrinthGridSize(5)).toBe(8);
        expect(labyrinthGridSize(12)).toBe(8);
    });

    test('there is no grid below floor 1', () => {
        expect(labyrinthGridSize(0)).toBe(0);
        expect(labyrinthGridSize(null)).toBe(0);
    });
});

/**
 * The band model came from the game's in-game guide, and a guide can be a
 * rounded retelling of the rule it describes. This is the check against reality:
 * 120 rooms a real character actually ran, read out of that character's stored
 * room log (`labyrinthRoomLogs_<charId>`, whose sessions carry both `floor` and
 * `roomLevel`) on 2026-09-08, reduced here to the observed level range per floor.
 *
 * Containment alone would be weak evidence, because the bands tile the whole
 * line above level 20 — every level belongs to some floor, so "no violations"
 * could not fail. What makes this corroboration is the EDGES: floors 12 and 15
 * produced rooms at both `20N` and `20N + 20` exactly, and floors 14 and 16 hit
 * their lower edge. A band wider or narrower than 20, or offset from `20N`,
 * would have put those rooms outside it.
 */
describe('the floor bands against rooms really observed', () => {
    // floor: [lowest level seen, highest level seen, rooms observed]
    const OBSERVED = {
        11: [224, 232, 3],
        12: [240, 260, 31],
        13: [262, 279, 16],
        14: [280, 299, 29],
        15: [300, 320, 29],
        16: [320, 337, 11],
        17: [353, 353, 1],
    };

    test('every room really observed falls inside its floor’s band', () => {
        for (const [floor, [lowest, highest]] of Object.entries(OBSERVED)) {
            const band = labyrinthFloorLevelBand(Number(floor));
            expect(lowest, `floor ${floor} lowest observed room`).toBeGreaterThanOrEqual(band.minLevel);
            expect(highest, `floor ${floor} highest observed room`).toBeLessThanOrEqual(band.maxLevel);
        }
    });

    test('and real rooms reach both edges, which is what pins the band', () => {
        const lowEdge = Object.entries(OBSERVED).filter(
            ([floor, [lowest]]) => lowest === labyrinthFloorLevelBand(Number(floor)).minLevel
        );
        const highEdge = Object.entries(OBSERVED).filter(
            ([floor, [, highest]]) => highest === labyrinthFloorLevelBand(Number(floor)).maxLevel
        );

        expect(lowEdge.map(([floor]) => Number(floor))).toEqual([12, 14, 15, 16]);
        expect(highEdge.map(([floor]) => Number(floor))).toEqual([12, 15]);
    });

    test('a floor those rooms belong to is the floor the inverse names', () => {
        // The exit level of floor N is the top of its band, so a room at that
        // level is the deepest room of N and the inverse must say N, not N+1
        for (const floor of Object.keys(OBSERVED).map(Number)) {
            expect(labyrinthFloorForLevel(labyrinthFloorClearLevel(floor))).toBe(floor);
        }
    });
});

describe('the floor ↔ room-level model', () => {
    test('floor 1 runs 20-40 and each floor adds 20', () => {
        expect(labyrinthFloorLevelBand(1)).toEqual({ minLevel: 20, maxLevel: 40 });
        expect(labyrinthFloorLevelBand(2)).toEqual({ minLevel: 40, maxLevel: 60 });
        expect(labyrinthFloorLevelBand(5)).toEqual({ minLevel: 100, maxLevel: 120 });
    });

    test('there is no band below floor 1', () => {
        expect(labyrinthFloorLevelBand(0)).toBeNull();
        expect(labyrinthFloorLevelBand(null)).toBeNull();
    });

    test('clearing a floor means clearing the top of its band, where the exit is', () => {
        expect(labyrinthFloorClearLevel(1)).toBe(40);
        expect(labyrinthFloorClearLevel(5)).toBe(120);
        expect(labyrinthFloorClearLevel(0)).toBe(0);
    });

    test('the inverse gives the deepest floor a level fully covers', () => {
        expect(labyrinthFloorForLevel(40)).toBe(1);
        expect(labyrinthFloorForLevel(120)).toBe(5);
        expect(labyrinthFloorForLevel(2000)).toBe(99);
    });

    test('a level one short of the exit does not reach the floor', () => {
        expect(labyrinthFloorForLevel(39)).toBe(0);
        expect(labyrinthFloorForLevel(119)).toBe(4);
        expect(labyrinthFloorForLevel(59)).toBe(1);
    });

    test('a level below the first floor’s exit reaches no floor at all', () => {
        expect(labyrinthFloorForLevel(0)).toBe(0);
        expect(labyrinthFloorForLevel(20)).toBe(0);
        expect(labyrinthFloorForLevel(null)).toBe(0);
    });

    test('the band and its inverse agree at every boundary', () => {
        for (let floor = 1; floor <= 30; floor++) {
            const band = labyrinthFloorLevelBand(floor);
            expect(labyrinthFloorForLevel(band.maxLevel)).toBe(floor);
            expect(labyrinthFloorForLevel(band.maxLevel - 1)).toBe(floor - 1);
        }
    });
});
