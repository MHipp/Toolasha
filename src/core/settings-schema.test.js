/**
 * Tests for the settings schema.
 *
 * Only the defaults that are a judgement call get pinned here — a default that
 * quietly flips changes what every new install does, and there is nothing else
 * in the codebase that would notice.
 */

import { describe, test, expect } from 'vitest';
import { getSettingDefinition } from './settings-schema.js';

describe('guild trial defaults', () => {
    test('the raw diagnostic trace is opt-in, and its help states the cost plainly', () => {
        const setting = getSettingDefinition('guildTrialDiagnosticTrace');
        // A default-on trace would have every player holding a large buffer of
        // raw combat data — with participant names in it — that almost none of
        // them will ever export
        expect(setting.default).toBe(false);
        expect(setting.help).toMatch(/large/i);
        expect(setting.help).toMatch(/participant names/i);
    });
});

describe('labyrinth defaults', () => {
    test('the path planner assumes the worst about a room it cannot see', () => {
        const setting = getSettingDefinition('labyrinthPathUnknownMode');
        // An optimistic default routes you through rooms that turn out to need
        // a shroud you did not bring; the pessimistic one only ever overpays
        expect(setting.default).toBe('shroud');
        expect(setting.options.map((o) => o.value)).toContain('shroud');
    });

    test('replaying the live fight is opt-in, not something every player pays for', () => {
        // It runs the real combat engine hundreds of times mid-fight
        expect(getSettingDefinition('labyrinthLiveCombatSim').default).toBe(false);
    });

    test('the sim precision help describes the stopping rule it actually governs', () => {
        const help = getSettingDefinition('labyrinthSimPrecision').help;
        expect(help).toContain('percentage points');
        expect(help).toMatch(/confidence interval/i);
    });
});

describe('startup recovery defaults', () => {
    test('automatic recovery ships off, and its help says what turning it on does', () => {
        const setting = getSettingDefinition('startupRecovery_autoReload');
        // Acting on the player's session without being asked is opt-in, even
        // on a page that has already failed to load anything
        expect(setting.default).toBe(false);
        expect(setting.type).toBe('checkbox');
        // Off means "ask me", never "do nothing", and the help has to say so
        expect(setting.help).toMatch(/turn this on/i);
        expect(setting.help).toMatch(/reload button/i);
    });
});
