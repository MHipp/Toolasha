/** @vitest-environment happy-dom */
/**
 * Tests for the ability tooltip timing injection.
 *
 * The rules that matter are all about restraint: nothing is written when the
 * setting is off, nothing when the live stats cannot be read, and nothing when
 * the effective figure rounds to the base one — the native line the game drew is
 * correct in every one of those cases.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    clientData: null,
    stats: null,
    subscribers: new Map(),
    settingListeners: new Map(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TOOLTIP_INFO: '#2563eb',
        getSetting: (id) => mocks.settings[id],
        onSettingChange: (id, callback) => mocks.settingListeners.set(id, callback),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => mocks.clientData },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: {
        subscribe: (name, callback) => mocks.subscribers.set(name, callback),
        unsubscribe: (name) => mocks.subscribers.delete(name),
    },
}));

vi.mock('../combat-sim/ability-timing-calculator.js', () => ({
    getCurrentAbilityTimingStats: () => mocks.stats,
    calculateEffectiveAbilityTiming: (cooldownNs, castNs, stats) => {
        if (!stats) return null;
        const baseCooldown = cooldownNs / 1e9;
        const baseCastTime = castNs / 1e9;
        return {
            baseCooldown,
            effectiveCooldown: (baseCooldown * 100) / (100 + stats.abilityHaste),
            baseCastTime,
            effectiveCastTime: baseCastTime / (1 + stats.castSpeed),
        };
    },
}));

const { default: abilityTooltipTiming } = await import('./ability-tooltip-timing.js');

const ABILITY_DETAIL_MAP = {
    '/abilities/berserk': { name: 'Berserk', cooldownDuration: 20e9, castDuration: 2e9 },
};

/**
 * A popper carrying the game's ability tooltip, lines and all.
 * @param {string} name - Ability name the tooltip prints
 * @returns {HTMLElement}
 */
function abilityPopper(name = 'Berserk') {
    const el = document.createElement('div');
    el.innerHTML = `
        <div class="Ability_abilityTooltip__x">
            <div class="Ability_name__y">${name}</div>
            <div>Level: 42</div>
            <div>Cooldown: 20s</div>
            <div>Cast Time: 2s</div>
        </div>`;
    document.body.appendChild(el);
    return el;
}

/**
 * Deliver a tooltip to whatever subscriber the feature registered.
 * @param {HTMLElement} popper
 */
function openTooltip(popper) {
    const callback = mocks.subscribers.get('AbilityTooltipTiming');
    expect(callback).toBeTypeOf('function');
    callback(popper, 'opened', { abilityTooltip: popper.querySelector('[class*="Ability_abilityTooltip"]') });
}

/**
 * @param {HTMLElement} popper
 * @param {string} prefix
 * @returns {string}
 */
function lineText(popper, prefix) {
    return Array.from(popper.querySelectorAll('div'))
        .map((el) => el.textContent.trim())
        .find((text) => text.startsWith(prefix));
}

beforeEach(() => {
    document.body.innerHTML = '';
    mocks.subscribers.clear();
    mocks.settings = { abilityTooltip_effectiveTiming: true };
    mocks.clientData = { abilityDetailMap: ABILITY_DETAIL_MAP };
    mocks.stats = { abilityHaste: 25, castSpeed: 0.25, attackLevel: 90 };
    abilityTooltipTiming.disable();
});

describe('ability tooltip timing', () => {
    test('appends the effective cooldown and cast time', () => {
        abilityTooltipTiming.initialize();
        const popper = abilityPopper();
        openTooltip(popper);

        // 20s at 25 haste -> 16s; 2s at 0.25 cast speed -> 1.6s
        expect(lineText(popper, 'Cooldown:')).toBe('Cooldown: 20s (16s)');
        expect(lineText(popper, 'Cast Time:')).toBe('Cast Time: 2s (1.6s)');
    });

    test('adds nothing twice when the same tooltip is delivered again', () => {
        abilityTooltipTiming.initialize();
        const popper = abilityPopper();
        openTooltip(popper);
        openTooltip(popper);

        expect(popper.querySelectorAll('.mwi-ability-timing-injected')).toHaveLength(2);
    });

    test('leaves the native line alone when the effective figure matches the base', () => {
        mocks.stats = { abilityHaste: 0, castSpeed: 0, attackLevel: 1 };
        abilityTooltipTiming.initialize();
        const popper = abilityPopper();
        openTooltip(popper);

        expect(lineText(popper, 'Cooldown:')).toBe('Cooldown: 20s');
        expect(lineText(popper, 'Cast Time:')).toBe('Cast Time: 2s');
    });

    test('shows the base figure when the live stats cannot be read', () => {
        mocks.stats = null;
        abilityTooltipTiming.initialize();
        const popper = abilityPopper();
        openTooltip(popper);

        expect(popper.querySelectorAll('.mwi-ability-timing-injected')).toHaveLength(0);
        expect(lineText(popper, 'Cooldown:')).toBe('Cooldown: 20s');
    });

    test('shows the base figure for an ability the game data does not describe', () => {
        abilityTooltipTiming.initialize();
        const popper = abilityPopper('Not An Ability');
        openTooltip(popper);

        expect(popper.querySelectorAll('.mwi-ability-timing-injected')).toHaveLength(0);
    });

    test('does not subscribe at all when the setting is off', () => {
        mocks.settings = { abilityTooltip_effectiveTiming: false };
        abilityTooltipTiming.initialize();

        expect(mocks.subscribers.has('AbilityTooltipTiming')).toBe(false);
    });

    test('writes nothing when the setting goes off after subscribing', () => {
        abilityTooltipTiming.initialize();
        const popper = abilityPopper();
        mocks.settings = { abilityTooltip_effectiveTiming: false };
        openTooltip(popper);

        expect(popper.querySelectorAll('.mwi-ability-timing-injected')).toHaveLength(0);
    });

    test('disable removes the tooltip hook', () => {
        abilityTooltipTiming.initialize();
        expect(mocks.subscribers.has('AbilityTooltipTiming')).toBe(true);

        abilityTooltipTiming.disable();
        expect(mocks.subscribers.has('AbilityTooltipTiming')).toBe(false);

        // and re-initializing after a disable subscribes again
        abilityTooltipTiming.initialize();
        expect(mocks.subscribers.has('AbilityTooltipTiming')).toBe(true);
    });

    test('the setting listener turns the feature on and off', () => {
        const listener = mocks.settingListeners.get('abilityTooltip_effectiveTiming');
        expect(listener).toBeTypeOf('function');

        listener(true);
        expect(mocks.subscribers.has('AbilityTooltipTiming')).toBe(true);

        listener(false);
        expect(mocks.subscribers.has('AbilityTooltipTiming')).toBe(false);
    });
});
