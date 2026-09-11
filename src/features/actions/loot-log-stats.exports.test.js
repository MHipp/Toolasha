/**
 * @vitest-environment happy-dom
 *
 * The export-shape contract between `loot-log-stats.js` and the things that
 * import it.
 *
 * This exists because of a bug that shipped: `loot-log-pivot-panel.js` imported
 * the module's *default* export and called instance helpers on it, but the
 * default is the feature descriptor the registry consumes — `{name, initialize,
 * cleanup}` — which has none of them. Opening the Loot & XP Analytics panel
 * threw "calculateTotalValue is not a function" on the first row it drew.
 *
 * The panel's own suite stayed green throughout, because its `vi.mock` of this
 * module had been written to match what the panel *did* rather than what the
 * module *exports*. A mock can only ever prove the caller agrees with itself.
 * So this file mocks nothing it is asserting about: it imports the real module
 * and checks the shape, which is the only thing that would have caught it.
 */

import { describe, test, expect, vi } from 'vitest';

// The real module's own dependencies, stubbed only enough that importing it
// works. Nothing here is what the test asserts about.
vi.mock('../../core/websocket.js', () => ({
    default: { on: vi.fn(), off: vi.fn(), onSocketEvent: vi.fn(), offSocketEvent: vi.fn() },
}));

import webSocketHook from '../../core/websocket.js';
import lootLogStatsFeature, { LootLogStats } from './loot-log-stats.js';

/** Every helper `loot-log-pivot-panel.js` calls on a LootLogStats. */
const PANEL_USES = ['calculateTotalValue', 'getActionName', 'getActionCategory', 'buildItemBreakdown'];

describe('what loot-log-stats exports', () => {
    test('the class carries every helper the pivot panel calls', () => {
        const instance = new LootLogStats();
        for (const method of PANEL_USES) {
            expect(typeof instance[method], `LootLogStats#${method}`).toBe('function');
        }
    });

    test('the default export is the feature descriptor, and carries none of them', () => {
        expect(lootLogStatsFeature).toMatchObject({
            name: expect.any(String),
            initialize: expect.any(Function),
        });
        for (const method of PANEL_USES) {
            expect(lootLogStatsFeature[method], `default.${method}`).toBeUndefined();
        }
    });

    test('constructing one registers nothing, so a formatting-only instance is free', () => {
        // The panel keeps its own instance purely to reach the four helpers.
        // That is only safe while the constructor stays a field initialiser — if
        // it ever starts listening or timing, the panel needs the registry's
        // instance instead and this test is where that shows up.
        webSocketHook.on.mockClear();
        new LootLogStats();
        expect(webSocketHook.on).not.toHaveBeenCalled();
    });
});
