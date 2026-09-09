import { describe, test, expect, beforeEach, vi } from 'vitest';

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

vi.mock('../core/data-manager.js', () => ({ default: dataManagerMock }));

const { captureOwner, stillOurs, noteTeardown } = await import('./init-ownership.js');

describe('init ownership tickets', () => {
    beforeEach(() => {
        dataManagerMock.characterId = 'char1';
    });

    test('a ticket taken and checked with nothing in between is still ours', () => {
        const owner = {};
        expect(stillOurs(captureOwner(owner))).toBe(true);
    });

    test('a teardown of the same owner invalidates the ticket', () => {
        const owner = {};
        const ticket = captureOwner(owner);
        noteTeardown(owner);
        expect(stillOurs(ticket)).toBe(false);
    });

    test('a teardown of a different owner leaves the ticket alone', () => {
        const owner = {};
        const ticket = captureOwner(owner);
        noteTeardown({});
        expect(stillOurs(ticket)).toBe(true);
    });

    test('a character switch invalidates the ticket even without a teardown', () => {
        const owner = {};
        const ticket = captureOwner(owner);
        // The switch settles — `getCurrentCharacterId()` moves — before
        // `disable()` has had its turn, which is the window a generation-only
        // test would pass
        dataManagerMock.characterId = 'char2';
        expect(stillOurs(ticket)).toBe(false);
    });

    test('a reconnect re-initializing the same character is caught by the generation', () => {
        const owner = {};
        const ticket = captureOwner(owner);
        noteTeardown(owner);
        // Same character id throughout — only the generation separates the two
        expect(dataManagerMock.characterId).toBe('char1');
        expect(stillOurs(ticket)).toBe(false);
    });

    test('a ticket taken after the teardown is current again', () => {
        const owner = {};
        noteTeardown(owner);
        expect(stillOurs(captureOwner(owner))).toBe(true);
    });

    test('a missing ticket is never ours', () => {
        expect(stillOurs(null)).toBe(false);
        expect(stillOurs(undefined)).toBe(false);
    });

    test('no character in hand is a value like any other', () => {
        const owner = {};
        dataManagerMock.characterId = null;
        const ticket = captureOwner(owner);
        expect(stillOurs(ticket)).toBe(true);
        dataManagerMock.characterId = 'char1';
        expect(stillOurs(ticket)).toBe(false);
    });
});
