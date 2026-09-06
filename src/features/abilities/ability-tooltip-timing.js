/**
 * Ability Tooltip Timing
 *
 * Puts the character's live effective cooldown and cast time on the game's own
 * ability tooltip, which only ever prints the base numbers.
 *
 * The figure is appended in parentheses after the native line, and only when it
 * differs from the base at two decimals — an unhasted character sees nothing
 * added. Whenever the live stats cannot be read the native line is left exactly
 * as the game drew it: a base figure is right, a guessed one is not.
 *
 * The calculation itself is `Toolasha.Sim.abilityTimingCalculator` (sim bundle);
 * this file only locates the lines and writes the text.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import tooltipObserver from '../../core/tooltip-observer.js';
import dom from '../../utils/dom.js';
import {
    getCurrentAbilityTimingStats,
    calculateEffectiveAbilityTiming,
} from '../combat-sim/ability-timing-calculator.js';

const SETTING_ID = 'abilityTooltip_effectiveTiming';
const SUBSCRIBER_NAME = 'AbilityTooltipTiming';
const INJECTED_CLASS = 'mwi-ability-timing-injected';

class AbilityTooltipTiming {
    constructor() {
        this.isInitialized = false;
        this.nameToHrid = null;
        this.nameToHridSource = null;
    }

    /**
     * Follow the setting for the rest of the session, so a toggle takes effect
     * without a reload.
     */
    setupSettingListener() {
        config.onSettingChange(SETTING_ID, (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING_ID)) return;

        this.isInitialized = true;
        tooltipObserver.subscribe(SUBSCRIBER_NAME, (element, eventType, info) => {
            if (eventType !== 'opened') return;
            this.handleTooltip(element, info);
        });
    }

    /**
     * Annotate one tooltip, if it is an ability tooltip and the stats are readable.
     * @param {Element} tooltipElement - The popper element
     * @param {Object} [info] - Classification from the tooltip observer
     */
    handleTooltip(tooltipElement, info) {
        // Re-checked per tooltip: the setting can go off between subscribe and hover
        if (!config.getSetting(SETTING_ID)) return;

        const abilityTooltip =
            info?.abilityTooltip || tooltipElement.querySelector('[class*="Ability_abilityTooltip"]');
        if (!abilityTooltip) return;

        const name = abilityTooltip.querySelector('[class*="Ability_name"]')?.textContent?.trim();
        const abilityHrid = this.hridFromName(name);
        if (!abilityHrid) return;

        const details = dataManager.getInitClientData()?.abilityDetailMap?.[abilityHrid];
        if (!details) return;

        const stats = getCurrentAbilityTimingStats();
        if (!stats) return;

        const timing = calculateEffectiveAbilityTiming(details.cooldownDuration, details.castDuration, stats);
        if (!timing) return;

        this.injectInline(abilityTooltip, 'Cooldown:', timing.baseCooldown, timing.effectiveCooldown);
        this.injectInline(abilityTooltip, 'Cast Time:', timing.baseCastTime, timing.effectiveCastTime);
    }

    /**
     * Append ` (Ns)` to the native line, unless the effective value rounds to the
     * base one.
     *
     * The native tooltip renders each line as a plain, class-less div, so the
     * target is found by its own leaf text rather than by a selector. Once
     * annotated a line has an element child and stops matching, so a second call
     * for the same tooltip adds nothing — no separate bookkeeping needed.
     *
     * @param {Element} abilityTooltip - The `Ability_abilityTooltip` container
     * @param {string} linePrefix - Text the native line starts with, e.g. 'Cooldown:'
     * @param {number} base - Base value in seconds
     * @param {number} effective - Effective value in seconds
     */
    injectInline(abilityTooltip, linePrefix, base, effective) {
        const rounded = Math.round(effective * 100) / 100;
        if (rounded === Math.round(base * 100) / 100) return;

        const lineElement = Array.from(abilityTooltip.querySelectorAll('div')).find(
            (el) => el.children.length === 0 && el.textContent.trim().startsWith(linePrefix)
        );
        if (!lineElement) return;

        lineElement.appendChild(
            dom.createStyledSpan({ color: config.COLOR_TOOLTIP_INFO }, ` (${rounded}s)`, INJECTED_CLASS)
        );
    }

    /**
     * Ability HRID for a displayed name, over a map cached on the ability map's
     * own identity so a game-data reload rebuilds it.
     * @param {string} [name] - Displayed ability name
     * @returns {string|null} HRID, or null when unknown
     */
    hridFromName(name) {
        if (!name) return null;

        const abilityDetailMap = dataManager.getInitClientData()?.abilityDetailMap;
        if (!abilityDetailMap) return null;

        if (this.nameToHridSource !== abilityDetailMap) {
            const map = new Map();
            for (const [hrid, ability] of Object.entries(abilityDetailMap)) {
                if (ability?.name) map.set(ability.name.toLowerCase(), hrid);
            }
            if (map.size === 0) return null;
            this.nameToHrid = map;
            this.nameToHridSource = abilityDetailMap;
        }

        return this.nameToHrid.get(name.toLowerCase()) || null;
    }

    disable() {
        tooltipObserver.unsubscribe(SUBSCRIBER_NAME);
        this.isInitialized = false;
        this.nameToHrid = null;
        this.nameToHridSource = null;
    }
}

const abilityTooltipTiming = new AbilityTooltipTiming();
abilityTooltipTiming.setupSettingListener();

export default abilityTooltipTiming;
