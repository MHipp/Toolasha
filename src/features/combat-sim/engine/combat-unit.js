// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { randomSetup } from './rng.js';

/** Stand-in for a buff type nothing is currently applying */
const EMPTY_BOOST = { ratioBoost: 0, flatBoost: 0, boosts: [] };

// Buff-capture instrumentation. Off by default and behind a flag so the normal
// simulation path pays nothing; the monster-stat-check "blind sim" turns it on
// around a single fight to learn which buffs the engine applies to the monster
// on its own. The sink is module-level (not per-instance) so it survives the
// monster being cleared at the end of the fight, and scoped to non-player units
// so it collects the monster's self-buffs and the player's on-monster debuffs
// — exactly the set the game reports in a monster's combatBuffMap.
let CAPTURE_BUFFS = false;
let capturedMonsterBuffs = null;
/** @param {boolean} on - Start (fresh sink) or stop capturing monster buffs. */
export function setBuffCapture(on) {
    CAPTURE_BUFFS = Boolean(on);
    capturedMonsterBuffs = CAPTURE_BUFFS ? new Map() : null;
}
/** @returns {Array<{uniqueHrid,typeHrid,ratioBoost,flatBoost}>} Peak per buff. */
export function getCapturedMonsterBuffs() {
    return capturedMonsterBuffs ? [...capturedMonsterBuffs.values()] : [];
}

class CombatUnit {
    isPlayer;
    isStunned = false;
    stunExpireTime = null;
    isBlinded = false;
    blindExpireTime = null;
    isSilenced = false;
    silenceExpireTime = null;

    isOutOfMana = false;

    // Base levels which don't change after initialization
    staminaLevel = 1;
    intelligenceLevel = 1;
    attackLevel = 1;
    meleeLevel = 1;
    defenseLevel = 1;
    rangedLevel = 1;
    magicLevel = 1;

    experience = 0;
    experienceRate = 0;
    enrageTime = 0;

    abilities = [null, null, null, null];
    food = [null, null, null];
    drinks = [null, null, null];
    houseRooms = [];
    abilityManaCosts = new Map();

    // Calculated combat stats including temporary buffs
    combatDetails = {
        staminaLevel: 1,
        intelligenceLevel: 1,
        attackLevel: 1,
        meleeLevel: 1,
        defenseLevel: 1,
        rangedLevel: 1,
        magicLevel: 1,
        maxHitpoints: 110,
        currentHitpoints: 110,
        maxManapoints: 110,
        currentManapoints: 110,
        stabAccuracyRating: 11,
        slashAccuracyRating: 11,
        smashAccuracyRating: 11,
        rangedAccuracyRating: 11,
        magicAccuracyRating: 11,
        stabMaxDamage: 11,
        slashMaxDamage: 11,
        smashMaxDamage: 11,
        rangedMaxDamage: 11,
        magicMaxDamage: 11,
        stabEvasionRating: 11,
        slashEvasionRating: 11,
        smashEvasionRating: 11,
        rangedEvasionRating: 11,
        magicEvasionRating: 11,
        defensiveMaxDamage: 0,
        totalArmor: 0.2,
        totalWaterResistance: 0.4,
        totalNatureResistance: 0.4,
        totalFireResistance: 0.4,
        abilityHaste: 0,
        tenacity: 0,
        totalThreat: 100,
        combatStats: {
            combatStyleHrid: '/combat_styles/smash',
            damageType: '/damage_types/physical',
            attackInterval: 3000000000,
            autoAttackDamage: 0,
            abilityDamage: 0,
            criticalRate: 0,
            criticalDamage: 0,
            stabAccuracy: 0,
            slashAccuracy: 0,
            smashAccuracy: 0,
            rangedAccuracy: 0,
            magicAccuracy: 0,
            stabDamage: 0,
            slashDamage: 0,
            smashDamage: 0,
            rangedDamage: 0,
            magicDamage: 0,
            defensiveDamage: 0,
            taskDamage: 0,
            physicalAmplify: 0,
            waterAmplify: 0,
            natureAmplify: 0,
            fireAmplify: 0,
            healingAmplify: 0,
            physicalThorns: 0,
            elementalThorns: 0,
            maxHitpoints: 0,
            maxManapoints: 0,
            stabEvasion: 0,
            slashEvasion: 0,
            smashEvasion: 0,
            rangedEvasion: 0,
            magicEvasion: 0,
            armor: 0,
            waterResistance: 0,
            natureResistance: 0,
            fireResistance: 0,
            lifeSteal: 0,
            hpRegenPer10: 0.01,
            mpRegenPer10: 0.01,
            combatDropRate: 0,
            combatDropQuantity: 0,
            combatRareFind: 0,
            combatExperience: 0,
            maxHitpointsRatio: 0,
            maxManapointsRatio: 0,
            foodSlots: 1,
            drinkSlots: 1,
            armorPenetration: 0,
            waterPenetration: 0,
            naturePenetration: 0,
            firePenetration: 0,
            manaLeech: 0,
            castSpeed: 0,
            threat: 100,
            parry: 0,
            mayhem: 0,
            pierce: 0,
            curse: 0,
            ripple: 0,
            bloom: 0,
            blaze: 0,
            weaken: 0,
            fury: 0,
            foodHaste: 0,
            drinkConcentration: 0,
            damageTaken: 0,
            attackSpeed: 0,
            armorDamageRatio: 0,
            hpDrainRatio: 0,
            primaryTraining: '',
            focusTraining: '',
            staminaExperience: 0,
            intelligenceExperience: 0,
            attackExperience: 0,
            defenseExperience: 0,
            meleeExperience: 0,
            rangedExperience: 0,
            magicExperience: 0,
            retaliation: 0,
        },
    };
    combatBuffs = {};
    // All active sources per buff uniqueHrid; combatBuffs holds the strongest.
    // The game applies the strongest source of a buff and falls back to the
    // next strongest when it expires.
    buffSources = new Map();
    permanentBuffs = {};
    zoneBuffs = {};
    extraBuffs = {};
    furyAmount = 0;
    furyExpireTime = 0;
    /** The expiry currently in the queue, so a refreshed timer need not rewrite it */
    furyExpirationEvent = null;

    constructor() {}

    /**
     * Every active buff, totalled by type, in one pass.
     *
     * A stat rebuild asks for about thirty-five different buff types, and each
     * ask used to be an `Object.values` plus a filter over every active buff —
     * thirty-five scans and seventy throwaway arrays to read numbers that were
     * all sitting in the same object. One pass builds the lot.
     *
     * @returns {Map<string, {ratioBoost: number, flatBoost: number, boosts: Array}>}
     * @private
     */
    _buffIndex() {
        const index = new Map();
        for (const key in this.combatBuffs) {
            const buff = this.combatBuffs[key];
            let entry = index.get(buff.typeHrid);
            if (!entry) {
                entry = { ratioBoost: 0, flatBoost: 0, boosts: [] };
                index.set(buff.typeHrid, entry);
            }
            entry.ratioBoost += buff.ratioBoost;
            entry.flatBoost += buff.flatBoost;
            entry.boosts.push(buff);
        }
        return index;
    }

    updateCombatDetails() {
        const buffIndex = this._buffIndex();
        const boostOf = (type) => buffIndex.get(type) || EMPTY_BOOST;
        const boostsOf = (type) => (buffIndex.get(type) || EMPTY_BOOST).boosts;

        if (this.isPlayer) {
            if (this.combatDetails.combatStats.hpRegenPer10 === 0) {
                this.combatDetails.combatStats.hpRegenPer10 = 0.01;
            } else {
                this.combatDetails.combatStats.hpRegenPer10 = 0.01 + this.combatDetails.combatStats.hpRegenPer10;
            }
            if (this.combatDetails.combatStats.mpRegenPer10 === 0) {
                this.combatDetails.combatStats.mpRegenPer10 = 0.01;
            } else {
                this.combatDetails.combatStats.mpRegenPer10 = 0.01 + this.combatDetails.combatStats.mpRegenPer10;
            }
        }

        ['stamina', 'intelligence', 'attack', 'melee', 'defense', 'ranged', 'magic'].forEach((stat) => {
            this.combatDetails[stat + 'Level'] = this[stat + 'Level'];
            const boosts = boostsOf('/buff_types/' + stat + '_level');
            boosts.forEach((buff) => {
                this.combatDetails[stat + 'Level'] += this[stat + 'Level'] * buff.ratioBoost;
                this.combatDetails[stat + 'Level'] += buff.flatBoost;
            });
        });

        // Max HP/MP buffs (e.g. the guild shrine's +2%) arrive as
        // /buff_types/max_hitpoints and max_manapoints. Unlike the ~35 stats
        // above, nothing folded them in, so the formula ran on the equipment
        // ratio alone — the guild shrine's max-HP/MP bonus was silently dropped.
        // Applied in the formula (not written back to combatStats) so a repeated
        // updateCombatDetails call can't re-accumulate them.
        const maxHpBoost = boostOf('/buff_types/max_hitpoints');
        const maxMpBoost = boostOf('/buff_types/max_manapoints');
        this.combatDetails.maxHitpoints = Math.floor(
            (10 * (10 + this.combatDetails.staminaLevel) +
                this.combatDetails.combatStats.maxHitpoints +
                maxHpBoost.flatBoost) *
                (1 + this.combatDetails.combatStats.maxHitpointsRatio + maxHpBoost.ratioBoost)
        );
        this.combatDetails.maxManapoints = Math.floor(
            (10 * (10 + this.combatDetails.intelligenceLevel) +
                this.combatDetails.combatStats.maxManapoints +
                maxMpBoost.flatBoost) *
                (1 + this.combatDetails.combatStats.maxManapointsRatio + maxMpBoost.ratioBoost)
        );

        const accuracyRatioBoostFromFury = boostOf('/buff_types/fury_accuracy').ratioBoost;
        const damageRatioBoostFromFury = boostOf('/buff_types/fury_damage').ratioBoost;

        const accuracyRatioBoost = boostOf('/buff_types/accuracy').ratioBoost;
        const damageRatioBoost = boostOf('/buff_types/damage').ratioBoost;

        ['stab', 'slash', 'smash'].forEach((style) => {
            this.combatDetails[style + 'AccuracyRating'] =
                (10 + this.combatDetails.attackLevel) *
                (1 + this.combatDetails.combatStats[style + 'Accuracy']) *
                (1 + accuracyRatioBoost) *
                (1 + accuracyRatioBoostFromFury);
            this.combatDetails[style + 'MaxDamage'] =
                (10 + this.combatDetails.meleeLevel) *
                (1 + this.combatDetails.combatStats[style + 'Damage']) *
                (1 + damageRatioBoost) *
                (1 + damageRatioBoostFromFury);
            const baseEvasion =
                (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats[style + 'Evasion']);
            this.combatDetails[style + 'EvasionRating'] = baseEvasion;
            const evasionBoosts = boostsOf('/buff_types/evasion');
            for (const boost of evasionBoosts) {
                this.combatDetails[style + 'EvasionRating'] += boost.flatBoost;
                this.combatDetails[style + 'EvasionRating'] += baseEvasion * boost.ratioBoost;
            }
        });

        this.combatDetails.defensiveMaxDamage =
            (10 + this.combatDetails.defenseLevel) *
            (1 + this.combatDetails.combatStats.defensiveDamage) *
            (1 + damageRatioBoost) *
            (1 + damageRatioBoostFromFury);

        // when equiped bulwark
        if (this.equipment?.['/equipment_types/two_hand']?.hrid.includes('bulwark')) {
            this.combatDetails.smashMaxDamage += this.combatDetails.defensiveMaxDamage;
        }

        this.combatDetails.rangedAccuracyRating =
            (10 + this.combatDetails.attackLevel) *
            (1 + this.combatDetails.combatStats.rangedAccuracy) *
            (1 + accuracyRatioBoost) *
            (1 + accuracyRatioBoostFromFury);
        this.combatDetails.rangedMaxDamage =
            (10 + this.combatDetails.rangedLevel) *
            (1 + this.combatDetails.combatStats.rangedDamage) *
            (1 + damageRatioBoost) *
            (1 + damageRatioBoostFromFury);

        const baseRangedEvasion =
            (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats.rangedEvasion);
        this.combatDetails.rangedEvasionRating = baseRangedEvasion;
        const evasionBoosts = boostsOf('/buff_types/evasion');
        for (const boost of evasionBoosts) {
            this.combatDetails.rangedEvasionRating += boost.flatBoost;
            this.combatDetails.rangedEvasionRating += baseRangedEvasion * boost.ratioBoost;
        }

        this.combatDetails.combatStats.damageTaken = boostOf('/buff_types/damage_taken').flatBoost;

        this.combatDetails.magicAccuracyRating =
            (10 + this.combatDetails.attackLevel) *
            (1 + this.combatDetails.combatStats.magicAccuracy) *
            (1 + accuracyRatioBoost) *
            (1 + accuracyRatioBoostFromFury);
        this.combatDetails.magicMaxDamage =
            (10 + this.combatDetails.magicLevel) *
            (1 + this.combatDetails.combatStats.magicDamage) *
            (1 + damageRatioBoost) *
            (1 + damageRatioBoostFromFury);

        const baseMagicEvasion =
            (10 + this.combatDetails.defenseLevel) * (1 + this.combatDetails.combatStats.magicEvasion);
        this.combatDetails.magicEvasionRating = baseMagicEvasion;
        for (const boost of evasionBoosts) {
            this.combatDetails.magicEvasionRating += boost.flatBoost;
            this.combatDetails.magicEvasionRating += baseMagicEvasion * boost.ratioBoost;
        }

        this.combatDetails.combatStats.physicalAmplify += boostOf('/buff_types/physical_amplify').flatBoost;
        this.combatDetails.combatStats.waterAmplify += boostOf('/buff_types/water_amplify').flatBoost;
        this.combatDetails.combatStats.natureAmplify += boostOf('/buff_types/nature_amplify').flatBoost;
        this.combatDetails.combatStats.fireAmplify += boostOf('/buff_types/fire_amplify').flatBoost;
        this.combatDetails.combatStats.healingAmplify += boostOf('/buff_types/healing_amplify').flatBoost;

        this.combatDetails.combatStats.attackInterval /= 1 + this.combatDetails.attackLevel / 2000;

        const baseAttackSpeed = this.combatDetails.combatStats.attackSpeed;
        this.combatDetails.combatStats.attackInterval /= 1 + baseAttackSpeed;
        const attackIntervalBoosts = boostsOf('/buff_types/attack_speed');
        const attackIntervalRatioBoost = attackIntervalBoosts
            .map((boost) => boost.ratioBoost)
            .reduce((prev, cur) => prev + cur, 0);
        this.combatDetails.combatStats.attackInterval /= 1 + attackIntervalRatioBoost;

        const baseArmor = 0.2 * this.combatDetails.defenseLevel + this.combatDetails.combatStats.armor;
        this.combatDetails.totalArmor = baseArmor;
        const armorBoosts = boostsOf('/buff_types/armor');
        for (const boost of armorBoosts) {
            this.combatDetails.totalArmor += boost.flatBoost;
            this.combatDetails.totalArmor += baseArmor * boost.ratioBoost;
        }

        const baseWaterResistance =
            0.2 * this.combatDetails.defenseLevel + this.combatDetails.combatStats.waterResistance;
        this.combatDetails.totalWaterResistance = baseWaterResistance;
        const waterResistanceBoosts = boostsOf('/buff_types/water_resistance');
        for (const boost of waterResistanceBoosts) {
            this.combatDetails.totalWaterResistance += boost.flatBoost;
            this.combatDetails.totalWaterResistance += baseWaterResistance * boost.ratioBoost;
        }

        const baseNatureResistance =
            0.2 * this.combatDetails.defenseLevel + this.combatDetails.combatStats.natureResistance;
        this.combatDetails.totalNatureResistance = baseNatureResistance;
        const natureResistanceBoosts = boostsOf('/buff_types/nature_resistance');
        for (const boost of natureResistanceBoosts) {
            this.combatDetails.totalNatureResistance += boost.flatBoost;
            this.combatDetails.totalNatureResistance += baseNatureResistance * boost.ratioBoost;
        }

        const baseFireResistance =
            0.2 * this.combatDetails.defenseLevel + this.combatDetails.combatStats.fireResistance;
        this.combatDetails.totalFireResistance = baseFireResistance;
        const fireResistanceBoosts = boostsOf('/buff_types/fire_resistance');
        for (const boost of fireResistanceBoosts) {
            this.combatDetails.totalFireResistance += boost.flatBoost;
            this.combatDetails.totalFireResistance += baseFireResistance * boost.ratioBoost;
        }

        const hpRegenBoosts = boostOf('/buff_types/hp_regen');
        this.combatDetails.combatStats.hpRegenPer10 +=
            this.combatDetails.combatStats.hpRegenPer10 * hpRegenBoosts.ratioBoost;
        this.combatDetails.combatStats.hpRegenPer10 += hpRegenBoosts.flatBoost;

        const mpRegenBoosts = boostOf('/buff_types/mp_regen');
        this.combatDetails.combatStats.mpRegenPer10 +=
            this.combatDetails.combatStats.mpRegenPer10 * mpRegenBoosts.ratioBoost;
        this.combatDetails.combatStats.mpRegenPer10 += mpRegenBoosts.flatBoost;

        this.combatDetails.combatStats.lifeSteal += boostOf('/buff_types/life_steal').flatBoost;
        this.combatDetails.combatStats.physicalThorns += boostOf('/buff_types/physical_thorns').flatBoost;
        this.combatDetails.combatStats.elementalThorns += boostOf('/buff_types/elemental_thorns').flatBoost;
        this.combatDetails.combatStats.combatExperience += boostOf('/buff_types/wisdom').flatBoost;
        this.combatDetails.combatStats.criticalRate += boostOf('/buff_types/critical_rate').flatBoost;
        this.combatDetails.combatStats.criticalDamage += boostOf('/buff_types/critical_damage').flatBoost;

        this.combatDetails.combatStats.castSpeed += boostOf('/buff_types/cast_speed').flatBoost;
        this.combatDetails.combatStats.castSpeed += this.combatDetails['attackLevel'] / 2000;

        const combatDropRateBoosts = boostOf('/buff_types/combat_drop_rate');
        this.combatDetails.combatStats.combatDropRate +=
            (1 + this.combatDetails.combatStats.combatDropRate) * combatDropRateBoosts.ratioBoost;
        this.combatDetails.combatStats.combatDropRate += combatDropRateBoosts.flatBoost;
        const combatRareFindBoosts = boostOf('/buff_types/rare_find');
        this.combatDetails.combatStats.combatRareFind +=
            (1 + this.combatDetails.combatStats.combatRareFind) * combatRareFindBoosts.ratioBoost;
        this.combatDetails.combatStats.combatRareFind += combatRareFindBoosts.flatBoost;
        const combatDropQuantityBoosts = boostOf('/buff_types/combat_drop_quantity');
        this.combatDetails.combatStats.combatDropQuantity +=
            (1 + this.combatDetails.combatStats.combatDropQuantity) * combatDropQuantityBoosts.ratioBoost;
        this.combatDetails.combatStats.combatDropQuantity += combatDropQuantityBoosts.flatBoost;

        const baseThreat = 100 + this.combatDetails.combatStats.threat;
        this.combatDetails.totalThreat = baseThreat;
        const threatBoosts = boostOf('/buff_types/threat');
        // Scaled off baseThreat, which carries the 100-point baseline every unit
        // has. The ratio branch used to `+=` onto combatStats.threat, which at
        // this point still holds the equipment contribution alone — so a Provoke
        // or Taunt landed a unit on gearThreat + 100*ratio instead of
        // 100 + gearThreat + baseThreat*ratio, and a +30% threat buff took a
        // bare player from 100 down to 30: the taunt made them the LEAST likely
        // target the threat roll would pick. Identical to the old zero-ratio
        // branch when nothing boosts threat, which is the common case.
        this.combatDetails.combatStats.threat = baseThreat * (1 + threatBoosts.ratioBoost) + threatBoosts.flatBoost;

        this.combatDetails.combatStats.retaliation += boostOf('/buff_types/retaliation').flatBoost;
        this.combatDetails.combatStats.tenacity += boostOf('/buff_types/tenacity').flatBoost;
    }

    addBuff(buff, currentTime) {
        // Copied because buff definitions are shared across aura targets and sim
        // runs, and this one is about to be stamped with a start time.
        //
        // A spread rather than structuredClone: every field of a buff is a
        // primitive, so the two produce the same object, and structuredClone
        // takes fifty times longer for it. Buffs are applied on every tea tick,
        // every aura, every curse — it added up to real time.
        const instance = { ...buff, startTime: currentTime };

        let sources = this.buffSources.get(instance.uniqueHrid);
        if (!sources) {
            sources = [];
            this.buffSources.set(instance.uniqueHrid, sources);
        }

        // Drop expired sources, then refresh-in-place when the same-strength
        // source reapplies (recast/re-tick) so lists stay bounded
        const active = sources.filter((b) => b.startTime + b.duration > currentTime);
        const sameStrength = active.findIndex(
            (b) => b.ratioBoost === instance.ratioBoost && b.flatBoost === instance.flatBoost
        );
        if (sameStrength !== -1) {
            active[sameStrength] = instance;
        } else {
            active.push(instance);
        }
        this.buffSources.set(instance.uniqueHrid, active);

        this.combatBuffs[instance.uniqueHrid] = this.strongestBuff(active);

        // Record the peak (largest-magnitude, signed) boost the monster ever saw
        // per buff, so a blind fight can report which effects the sim produced.
        if (CAPTURE_BUFFS && capturedMonsterBuffs && !this.isPlayer) {
            const rec = capturedMonsterBuffs.get(instance.uniqueHrid) || {
                uniqueHrid: instance.uniqueHrid,
                typeHrid: instance.typeHrid,
                ratioBoost: 0,
                flatBoost: 0,
            };
            if (Math.abs(instance.ratioBoost) > Math.abs(rec.ratioBoost)) rec.ratioBoost = instance.ratioBoost;
            if (Math.abs(instance.flatBoost) > Math.abs(rec.flatBoost)) rec.flatBoost = instance.flatBoost;
            capturedMonsterBuffs.set(instance.uniqueHrid, rec);
        }

        this.updateCombatDetails();
    }

    /**
     * Pick the strongest source of a buff (largest magnitude — debuffs like
     * curse carry negative boosts, so compare absolute values).
     * @param {Array<Object>} sources - Active buff instances for one uniqueHrid
     * @returns {Object} The strongest buff instance
     */
    strongestBuff(sources) {
        let strongest = sources[0];
        for (let i = 1; i < sources.length; i++) {
            const b = sources[i];
            const ratioDiff = Math.abs(b.ratioBoost) - Math.abs(strongest.ratioBoost);
            if (ratioDiff > 0 || (ratioDiff === 0 && Math.abs(b.flatBoost) > Math.abs(strongest.flatBoost))) {
                strongest = b;
            }
        }
        return strongest;
    }

    /**
     * Update fury accuracy and damage buffs in a single batch, calling updateCombatDetails() once.
     * @param {number} furyAmount - Current fury stack count (0-5)
     * @param {number} furyStat - Fury combat stat value
     * @param {number} currentTime - Simulation time for buff start
     * @param {number} duration - Buff duration (fury expire time)
     */
    updateFuryBuffs(furyAmount, furyStat, currentTime, duration) {
        if (furyAmount > 0) {
            this.combatBuffs['/buff_uniques/fury_accuracy'] = {
                uniqueHrid: '/buff_uniques/fury_accuracy',
                typeHrid: '/buff_types/fury_accuracy',
                ratioBoost: furyAmount * furyStat,
                ratioBoostLevelBonus: 0,
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                startTime: currentTime,
                duration: duration,
            };
            this.combatBuffs['/buff_uniques/fury_damage'] = {
                uniqueHrid: '/buff_uniques/fury_damage',
                typeHrid: '/buff_types/fury_damage',
                ratioBoost: furyAmount * furyStat,
                ratioBoostLevelBonus: 0,
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                startTime: currentTime,
                duration: duration,
            };
        } else {
            delete this.combatBuffs['/buff_uniques/fury_accuracy'];
            delete this.combatBuffs['/buff_uniques/fury_damage'];
        }
        this.updateCombatDetails();
    }

    addPermanentBuff(buff) {
        if (this.permanentBuffs[buff.typeHrid]) {
            this.permanentBuffs[buff.typeHrid].flatBoost += buff.flatBoost;
            this.permanentBuffs[buff.typeHrid].ratioBoost += buff.ratioBoost;
        } else {
            // Clone: buff objects can be shared across party members (extraBuffs/zoneBuffs), so never mutate them
            this.permanentBuffs[buff.typeHrid] = { ...buff };
        }
    }

    generatePermanentBuffs() {
        for (let i = 0; i < this.houseRooms.length; i++) {
            const houseRoom = this.houseRooms[i];
            houseRoom.buffs.forEach((buff) => {
                this.addPermanentBuff(buff);
            });
        }
        if (this.zoneBuffs) {
            this.zoneBuffs.forEach((buff) => {
                this.addPermanentBuff(buff);
            });
        }
        if (this.extraBuffs) {
            this.extraBuffs.forEach((buff) => {
                this.addPermanentBuff(buff);
            });
        }
    }

    removeExpiredBuffs(currentTime) {
        for (const [uniqueHrid, sources] of this.buffSources) {
            const active = sources.filter((b) => b.startTime + b.duration > currentTime);
            if (active.length === sources.length) {
                continue;
            }
            if (active.length === 0) {
                this.buffSources.delete(uniqueHrid);
                delete this.combatBuffs[uniqueHrid];
            } else {
                // Strongest source expired → fall back to the next strongest
                this.buffSources.set(uniqueHrid, active);
                this.combatBuffs[uniqueHrid] = this.strongestBuff(active);
            }
        }

        // Buffs written directly to combatBuffs (fury) have no source list
        for (const buff of Object.values(this.combatBuffs)) {
            if (!this.buffSources.has(buff.uniqueHrid) && buff.startTime + buff.duration <= currentTime) {
                delete this.combatBuffs[buff.uniqueHrid];
            }
        }

        this.updateCombatDetails();
    }

    clearBuffs() {
        // One level deep: the map is fresh so the caller cannot disturb it, and
        // each buff is copied so a stamped start time stays local. Runs at every
        // encounter reset, which across a full run is a great many times.
        const buffs = {};
        for (const key in this.permanentBuffs) buffs[key] = { ...this.permanentBuffs[key] };
        this.combatBuffs = buffs;
        this.buffSources = new Map();
        this.furyAmount = 0;
        this.furyExpireTime = 0;
        this.furyExpirationEvent = null;
        this.updateCombatDetails();
    }

    clearCCs() {
        this.isStunned = false;
        this.stunExpireTime = null;
        this.isSilenced = false;
        this.silenceExpireTime = null;
        this.isBlinded = false;
        this.blindExpireTime = null;
        this.combatDetails.combatStats.damageTaken = 0;
    }

    getBuffBoosts(type) {
        const boosts = [];
        Object.values(this.combatBuffs)
            .filter((buff) => buff.typeHrid === type)
            .forEach((buff) => {
                boosts.push({ ratioBoost: buff.ratioBoost, flatBoost: buff.flatBoost });
            });

        return boosts;
    }

    getBuffBoost(type) {
        const boosts = this.getBuffBoosts(type);

        const boost = {
            ratioBoost: 0,
            flatBoost: 0,
        };

        for (let i = 0; i < boosts.length; i++) {
            boost.ratioBoost += boosts[i]?.ratioBoost ?? 0;
            boost.flatBoost += boosts[i]?.flatBoost ?? 0;
        }

        return boost;
    }

    reset(currentTime = 0) {
        this.clearCCs();

        if (currentTime === 0 || !this.isPlayer) {
            // First combat start or enemy reset: full reset
            this.clearBuffs();
            this.resetCooldowns(currentTime);
        } else {
            // Dungeon wipe restart (players only): remove expired buffs, keep cooldowns
            this.removeExpiredBuffs(currentTime);
        }

        this.updateCombatDetails();
        this.combatDetails.currentHitpoints = this.combatDetails.maxHitpoints;
        this.combatDetails.currentManapoints = this.combatDetails.maxManapoints;
    }

    resetCooldowns(currentTime = 0) {
        this.food.filter((food) => food !== null).forEach((food) => (food.lastUsed = Number.MIN_SAFE_INTEGER));
        this.drinks.filter((drink) => drink !== null).forEach((drink) => (drink.lastUsed = Number.MIN_SAFE_INTEGER));

        const haste = this.combatDetails.combatStats.abilityHaste;

        this.abilities
            .filter((ability) => ability !== null)
            .forEach((ability) => {
                if (this.isPlayer) {
                    ability.lastUsed = Number.MIN_SAFE_INTEGER;
                } else {
                    let cooldownDuration = ability.cooldownDuration;
                    if (haste > 0) {
                        cooldownDuration = (cooldownDuration * 100) / (100 + haste);
                    }
                    if (this.roomLevel > 0) {
                        // Labyrinth: the real game opens each ability at exactly
                        // half its cooldown — measured deterministically from tick
                        // captures (its specials at ~cd/2 ≈ 10-11s on a 20s
                        // cooldown, Toughness at ~15s on 30s, a guardian aura at
                        // 60s on 120s). A zone monster's random [0.5cd, cd) first
                        // availability delays the cast by another ~quarter cooldown
                        // on average, which robs the monster of resistance-buff
                        // uptime (Toughness, guardian aura), under-mitigates it,
                        // and over-credits the player's damage — an over-estimated
                        // clear rate. One monster per lab fight, so nothing needs
                        // the random de-synchronisation a zone pack does.
                        ability.lastUsed = currentTime - Math.floor(cooldownDuration * 0.5);
                    } else {
                        ability.lastUsed =
                            currentTime -
                            Math.floor(cooldownDuration * 0.5) +
                            Math.floor(randomSetup() * cooldownDuration * 0.5);
                    }
                }
            });
    }

    addHitpoints(hitpoints) {
        let hitpointsAdded = 0;

        if (this.combatDetails.currentHitpoints >= this.combatDetails.maxHitpoints) {
            return hitpointsAdded;
        }

        const newHitpoints = Math.min(this.combatDetails.currentHitpoints + hitpoints, this.combatDetails.maxHitpoints);
        hitpointsAdded = newHitpoints - this.combatDetails.currentHitpoints;
        this.combatDetails.currentHitpoints = newHitpoints;

        return hitpointsAdded;
    }

    addManapoints(manapoints) {
        let manapointsAdded = 0;

        if (this.combatDetails.currentManapoints >= this.combatDetails.maxManapoints) {
            return manapointsAdded;
        }

        const newManapoints = Math.min(
            this.combatDetails.currentManapoints + manapoints,
            this.combatDetails.maxManapoints
        );
        manapointsAdded = newManapoints - this.combatDetails.currentManapoints;
        this.combatDetails.currentManapoints = newManapoints;

        return manapointsAdded;
    }
}

export default CombatUnit;
