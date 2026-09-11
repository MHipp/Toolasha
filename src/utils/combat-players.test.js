import { describe, test, expect } from 'vitest';
import { ownPlayer } from './combat-players.js';

describe('ownPlayer', () => {
    test('picks the flagged player regardless of slot', () => {
        const players = [
            { name: 'Slot0', isCurrentPlayer: false },
            { name: 'Me', isCurrentPlayer: true },
        ];
        expect(ownPlayer(players).name).toBe('Me');
    });

    test('an unflagged solo run still counts', () => {
        expect(ownPlayer([{ name: 'solo' }]).name).toBe('solo');
    });

    test('an unflagged party run is not attributed to slot 0', () => {
        // The bug this guards against: `find(isCurrentPlayer) || players[0]`
        // used to credit whoever sits first in the array with this run.
        const players = [{ name: 'Slot0' }, { name: 'Slot1' }];
        expect(ownPlayer(players)).toBeNull();
    });

    test('returns null for empty or non-array input', () => {
        expect(ownPlayer([])).toBeNull();
        expect(ownPlayer(null)).toBeNull();
        expect(ownPlayer(undefined)).toBeNull();
    });
});
