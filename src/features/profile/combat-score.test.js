/**
 * @vitest-environment happy-dom
 *
 * The trigger-condition formatters: turning `{dependencyHrid, conditionHrid,
 * comparatorHrid, value}` into the sentence a player reads on the panel.
 * Pinned here because a renamed HRID or a swapped operand silently reads as
 * a different rule than the one actually configured.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stub = vi.hoisted(() => ({
    currentCharacterId: 7,
    toggles: 0,
    renders: 0,
    shows: 0,
    hides: 0,
    open: false,
    ownerChanged: false,
    frontmost: true,
    minimized: false,
    expands: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        onSettingChange: () => {},
        getSetting: () => false,
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_ACCENT: '#5b8def',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => stub.currentCharacterId },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./score-calculator.js', () => ({ calculateCombatScore: () => ({}) }));
vi.mock('../combat/combat-sim-export.js', () => ({ constructExportObject: () => ({}) }));
vi.mock('../combat/milkonomy-export.js', () => ({ constructMilkonomyExport: () => ({}) }));
vi.mock('./character-card-button.js', () => ({
    handleViewCardClick: () => {},
    handleViewCardFromSnapshot: () => {},
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({ default: {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({ buildPlayerDTOFromProfile: () => ({}) }));
vi.mock('../../utils/enhancement-worker-manager.js', () => ({ terminateWorkerPool: () => {} }));
// Modelled on the real panel api rather than on what the caller happens to
// reach for. The old stub offered `panel`, `render` and `toggle` only, so a
// caller asking the reliable question -- is it actually on the page -- got a
// stub that could not answer, and a caller trusting the raw handle looked
// correct here while doing nothing on a real page. `isOpen` reports document
// membership, exactly as `simple-panel.js` does.
vi.mock('./build-score-panel.js', () => ({
    buildScorePanel: {
        panel: null,
        isOpen: () => stub.open,
        isFrontmost: () => stub.open && stub.frontmost,
        isMinimized: () => stub.open && stub.minimized,
        expand: () => {
            stub.expands += 1;
            stub.minimized = false;
        },
        render: () => {
            stub.renders += 1;
        },
        show: () => {
            stub.shows += 1;
            stub.open = true;
        },
        hide: () => {
            stub.hides += 1;
            stub.open = false;
        },
        toggle: () => {
            stub.toggles += 1;
            stub.open = !stub.open;
        },
    },
    setScoreSource: () => stub.ownerChanged,
}));
vi.mock('./build-score-row.js', () => ({ readOwnScore: () => null }));

const combatScore = (await import('./combat-score.js')).default;

describe('formatDependency', () => {
    test('known dependencies read as short labels', () => {
        expect(combatScore.formatDependency('/combat_trigger_dependencies/self')).toBe('Self');
        expect(combatScore.formatDependency('/combat_trigger_dependencies/targeted_enemy')).toBe('Target');
        expect(combatScore.formatDependency('/combat_trigger_dependencies/all_enemies')).toBe('All Enemies');
        expect(combatScore.formatDependency('/combat_trigger_dependencies/all_allies')).toBe('All Allies');
    });

    test('an unknown dependency falls back to a de-slugged tail', () => {
        expect(combatScore.formatDependency('/combat_trigger_dependencies/random_ally')).toBe('random ally');
    });
});

describe('formatCondition', () => {
    test('known conditions read as short labels', () => {
        expect(combatScore.formatCondition('/combat_trigger_conditions/current_hp')).toBe('HP');
        expect(combatScore.formatCondition('/combat_trigger_conditions/missing_hp')).toBe('Missing HP');
        expect(combatScore.formatCondition('/combat_trigger_conditions/current_mp')).toBe('MP');
    });

    test('an unknown condition is title-cased from its hrid tail', () => {
        expect(combatScore.formatCondition('/combat_trigger_conditions/enemy_count')).toBe('Enemy Count');
    });
});

describe('formatComparator', () => {
    test('known comparators map to their symbol or phrase', () => {
        expect(combatScore.formatComparator('/combat_trigger_comparators/greater_than_equal')).toBe('≥');
        expect(combatScore.formatComparator('/combat_trigger_comparators/less_than_equal')).toBe('≤');
        expect(combatScore.formatComparator('/combat_trigger_comparators/greater_than')).toBe('>');
        expect(combatScore.formatComparator('/combat_trigger_comparators/less_than')).toBe('<');
        expect(combatScore.formatComparator('/combat_trigger_comparators/equal')).toBe('=');
        expect(combatScore.formatComparator('/combat_trigger_comparators/is_active')).toBe('is active');
        expect(combatScore.formatComparator('/combat_trigger_comparators/is_inactive')).toBe('is inactive');
    });

    test('an unknown comparator falls back to its de-slugged tail', () => {
        expect(combatScore.formatComparator('/combat_trigger_comparators/roughly_equal')).toBe('roughly equal');
    });
});

describe('formatTriggerCondition', () => {
    test('a value comparator reads as dependency: condition comparator value', () => {
        const text = combatScore.formatTriggerCondition({
            dependencyHrid: '/combat_trigger_dependencies/self',
            conditionHrid: '/combat_trigger_conditions/current_hp',
            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
            value: 50,
        });

        expect(text).toBe('Self: HP ≤ 50');
    });

    test('is_active/is_inactive never appends a trailing value', () => {
        const text = combatScore.formatTriggerCondition({
            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
            conditionHrid: '/combat_trigger_conditions/current_hp',
            comparatorHrid: '/combat_trigger_comparators/is_active',
            value: 999,
        });

        expect(text).toBe('Target: HP is active');
        expect(text).not.toContain('999');
    });
});

describe('formatTriggers', () => {
    test('no conditions reads as "No trigger", not an empty string', () => {
        expect(combatScore.formatTriggers([])).toBe('No trigger');
        expect(combatScore.formatTriggers(null)).toBe('No trigger');
        expect(combatScore.formatTriggers(undefined)).toBe('No trigger');
    });

    test('multiple conditions are joined with AND, in the given order', () => {
        const text = combatScore.formatTriggers([
            {
                dependencyHrid: '/combat_trigger_dependencies/self',
                conditionHrid: '/combat_trigger_conditions/current_hp',
                comparatorHrid: '/combat_trigger_comparators/less_than',
                value: 30,
            },
            {
                dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                conditionHrid: '/combat_trigger_conditions/current_mp',
                comparatorHrid: '/combat_trigger_comparators/greater_than',
                value: 10,
            },
        ]);

        expect(text).toBe('Self: HP < 30 AND Target: MP > 10');
    });
});

describe('getAbilitiesSpriteUrl / getItemsSpriteUrl', () => {
    test('null when no matching sprite sheet is on the page', () => {
        document.body.innerHTML = '';
        expect(combatScore.getAbilitiesSpriteUrl()).toBeNull();
        expect(combatScore.getItemsSpriteUrl()).toBeNull();
    });

    test('reads the sheet path (without the fragment) from the use element', () => {
        document.body.innerHTML = `
            <svg><use href="/sprites/abilities_sprite.svg?v=3#fireball"></use></svg>
            <svg><use href="/sprites/items_sprite.svg?v=3#bronze_bar"></use></svg>
        `;

        expect(combatScore.getAbilitiesSpriteUrl()).toBe('/sprites/abilities_sprite.svg?v=3');
        expect(combatScore.getItemsSpriteUrl()).toBe('/sprites/items_sprite.svg?v=3');
    });
});

describe('buildGuildShrineHTML', () => {
    /**
     * A scored profile with shrine levels read off the current character.
     * @param {Object} overrides - Fields to change
     * @returns {Object} scoreData in the shape `calculateCombatScore` returns
     */
    function scored(overrides = {}) {
        return {
            guildShrineKnown: true,
            guildShrineCombat: 12,
            guildShrineCombatTokens: 340,
            skillerGuildShrine: 3,
            skillerGuildShrineTokens: 60,
            breakdown: { guildShrinesCombat: [{ name: 'Force 4', value: '12.0' }] },
            skillerBreakdown: { guildShrines: [{ name: 'Scholar 2', value: '3.0' }] },
            ...overrides,
        };
    }

    test('the combat line reads the combat figure and lists its shrines', () => {
        const html = combatScore.buildGuildShrineHTML(scored(), 'combat');

        expect(html).toContain('Guild Shrine: 12');
        expect(html).toContain('Force 4');
        expect(html).toContain('id="mwi-guild-shrine-toggle"');
        expect(html).not.toContain('Scholar 2');
    });

    test('the skiller line reads the skilling figure and its own shrines', () => {
        const html = combatScore.buildGuildShrineHTML(scored(), 'skiller');

        expect(html).toContain('Guild Shrine: 3');
        expect(html).toContain('Scholar 2');
        expect(html).toContain('id="mwi-skiller-guild-shrine-toggle"');
        expect(html).not.toContain('Force 4');
    });

    test('tokens are named in the tooltip and never in the score', () => {
        const html = combatScore.buildGuildShrineHTML(scored(), 'combat');

        expect(html).toContain('340 guild tokens');
        expect(html).toContain('Guild Shrine: 12');
    });

    test("another player's profile draws no line at all, rather than a zero", () => {
        const html = combatScore.buildGuildShrineHTML(
            {
                guildShrineKnown: false,
                guildShrineCombat: 0,
                skillerGuildShrine: 0,
                breakdown: {},
                skillerBreakdown: {},
            },
            'combat'
        );

        expect(html).toBe('');
    });

    test('a shared profile missing every shrine field neither throws nor shows a zero', () => {
        expect(combatScore.buildGuildShrineHTML({ breakdown: {}, skillerBreakdown: {} }, 'combat')).toBe('');
        expect(combatScore.buildGuildShrineHTML({}, 'skiller')).toBe('');
        expect(combatScore.buildGuildShrineHTML(null, 'combat')).toBe('');
    });

    test('a character who has bought nothing gets no line either', () => {
        const html = combatScore.buildGuildShrineHTML(
            scored({ guildShrineCombat: 0, guildShrineCombatTokens: 0, breakdown: { guildShrinesCombat: [] } }),
            'combat'
        );

        expect(html).toBe('');
    });
});

describe('buildAbilitiesTriggersHTML', () => {
    test('empty when the profile has no abilities and no triggers at all', () => {
        document.body.innerHTML = '';
        expect(combatScore.buildAbilitiesTriggersHTML({ profile: {} })).toBe('');
    });

    test('an ability with no configured trigger reads as "No trigger"', () => {
        document.body.innerHTML = `<svg><use href="/sprites/abilities_sprite.svg#fireball"></use></svg>`;

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: { equippedAbilities: [{ abilityHrid: '/abilities/fireball' }] },
        });

        expect(html).toContain('No trigger');
        expect(html).toContain('#fireball');
    });

    test('an ability with a configured trigger renders the formatted condition', () => {
        document.body.innerHTML = `<svg><use href="/sprites/abilities_sprite.svg#fireball"></use></svg>`;

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: {
                equippedAbilities: [{ abilityHrid: '/abilities/fireball' }],
                abilityCombatTriggersMap: {
                    '/abilities/fireball': [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 50,
                        },
                    ],
                },
            },
        });

        expect(html).toContain('Target: HP ≤ 50');
    });

    test('without the abilities sprite on the page, abilities are skipped even if present', () => {
        document.body.innerHTML = '';

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: { equippedAbilities: [{ abilityHrid: '/abilities/fireball' }] },
        });

        expect(html).not.toContain('fireball');
    });

    test('a "Food & Drinks" heading only appears when abilities are also present', () => {
        document.body.innerHTML = `
            <svg><use href="/sprites/abilities_sprite.svg#fireball"></use></svg>
            <svg><use href="/sprites/items_sprite.svg#tea"></use></svg>
        `;

        const html = combatScore.buildAbilitiesTriggersHTML({
            profile: {
                equippedAbilities: [{ abilityHrid: '/abilities/fireball' }],
                consumableTriggers: {},
                consumableCombatTriggersMap: { '/items/tea': [] },
            },
        });

        expect(html).toContain('Food & Drinks');

        const withoutAbilities = combatScore.buildAbilitiesTriggersHTML({
            profile: { consumableCombatTriggersMap: { '/items/tea': [] } },
        });

        expect(withoutAbilities).not.toContain('Food & Drinks');
    });
});

describe('the breakdown link', () => {
    /**
     * A scored profile, in the shape `showScorePanel` draws.
     * @param {number} characterId - Whose profile this is
     * @returns {{profileData: Object, scoreData: Object}}
     */
    function profile(characterId) {
        return {
            profileData: { profile: { sharableCharacter: { id: characterId, name: 'Someone' } } },
            scoreData: {
                total: 300,
                house: 50,
                ability: 100,
                equipment: 150,
                skillerTotal: 90,
                skillerEquipment: 90,
                equipmentHidden: false,
                hasEquipmentData: true,
                breakdown: { houses: [], abilities: [], equipment: [] },
                skillerBreakdown: { equipment: [] },
            },
        };
    }

    beforeEach(() => {
        document.body.innerHTML = '';
        stub.currentCharacterId = 7;
        stub.toggles = 0;
        stub.renders = 0;
        stub.shows = 0;
        stub.hides = 0;
        stub.open = false;
        stub.ownerChanged = false;
        stub.frontmost = true;
        stub.minimized = false;
        stub.expands = 0;
        combatScore.currentPanel = null;
    });

    test('your own profile offers a way through to the breakdown', () => {
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        expect(document.querySelector('#mwi-score-breakdown-link')).not.toBeNull();
    });

    test('the first click opens it, even when a stale handle is left behind', () => {
        // The reported failure: the link did nothing at all. `openBreakdown`
        // redrew whenever the owner changed and a `panel` handle existed, but
        // the handle outlives an element torn off the page, so it redrew
        // something invisible and returned. Measured live, the panel toggled
        // cleanly once built and only the first press was swallowed.
        stub.open = false;
        stub.ownerChanged = true;
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        document.querySelector('#mwi-score-breakdown-link').click();

        expect(stub.shows).toBe(1);
        expect(stub.renders).toBe(0);
    });

    test('clicking it again on the same profile puts it away', () => {
        stub.open = true;
        stub.ownerChanged = false;
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        document.querySelector('#mwi-score-breakdown-link').click();

        expect(stub.hides).toBe(1);
    });

    test('a press on a panel the user cannot see shows it instead of putting it away', () => {
        // Restored open after a refresh, underneath another panel at the same
        // default position: hiding it here is indistinguishable from the link
        // doing nothing, which is exactly how this was reported
        stub.open = true;
        stub.ownerChanged = false;
        stub.frontmost = false;
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        document.querySelector('#mwi-score-breakdown-link').click();

        expect(stub.hides).toBe(0);
        expect(stub.shows).toBe(1);
    });

    test('a press on a minimized panel unfolds it instead of putting it away', () => {
        stub.open = true;
        stub.ownerChanged = false;
        stub.minimized = true;
        const { profileData, scoreData } = profile(7);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        document.querySelector('#mwi-score-breakdown-link').click();

        expect(stub.hides).toBe(0);
        expect(stub.expands).toBe(1);
    });

    test('an open panel pointed at another profile redraws, and is raised, rather than closing', () => {
        // Closing here would read as the link failing, on the press where the
        // player most expects to see something
        stub.open = true;
        stub.ownerChanged = true;
        const { profileData, scoreData } = profile(99);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        document.querySelector('#mwi-score-breakdown-link').click();

        expect(stub.renders).toBe(1);
        expect(stub.hides).toBe(0);
        // Redrawing a buried panel is the same nothing as closing one
        expect(stub.shows).toBe(1);
    });

    test("another player's profile offers the same link, named after them", () => {
        const { profileData, scoreData } = profile(99);
        combatScore.showScorePanel(profileData, scoreData, document.createElement('div'));

        const link = document.querySelector('#mwi-score-breakdown-link');
        expect(link).not.toBeNull();
        expect(link.title).toContain("Someone's score");
    });

    test('a payload with no character id at all is not treated as yours', () => {
        expect(combatScore.isOwnProfile({ profile: {} })).toBe(false);
        expect(combatScore.isOwnProfile(null)).toBe(false);
    });

    test('the id is found wherever the payload happens to carry it', () => {
        expect(combatScore.isOwnProfile({ profile: { characterSkills: [{ characterID: 7 }] } })).toBe(true);
        expect(combatScore.isOwnProfile({ profile: { character: { id: 7 } } })).toBe(true);
        expect(combatScore.isOwnProfile({ profile: { character: { id: 8 } } })).toBe(false);
    });
});
