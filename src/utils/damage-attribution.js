/**
 * Damage attribution
 *
 * Who hit what, derived from a payload that never says.
 *
 * `battle_updated` carries every unit's current state and no events. Working out
 * that "Bob crit the rat for 4,120" from two of those snapshots is the whole
 * problem, and there is no attribution field to read — the trick is elsewhere.
 *
 * ## An attack counter identifies the attacker
 *
 * Each player carries `atkCounter`, and it goes up when they attack. On a
 * five-player recording it decided 89% of all damage exactly — the join
 * between a player and a monster's lost health, and the one signal that also
 * expresses misses, crits and the per-ability split.
 *
 * That recording predates a server change: counters then arrived for the
 * viewer's own unit alone, and now arrive for every present player. In a small
 * party a lone riser is still the swinger, so the rung is unchanged there; in a
 * full trial snapshot it is one of fifty-seven rosters ticking over and no
 * longer proof, so it is capped at {@link COLLISION_SPLIT_THRESHOLD} like the
 * mana rung. The rung's own comment carries the measurement.
 *
 * ## Presence is the attribution when no counter moved
 *
 * The server groups each `battle_updated` by **actor**: the player in a tick's
 * `pMap` is the one whose action the tick reports — their swing's damage,
 * their damage-over-time effect ticking, their thorns firing. So when nobody's
 * counter rose and exactly one player is in the tick, the damage is theirs.
 *
 * This module used to believe the opposite, and the correction is worth
 * keeping on record. On that five-player recording, 82 of 440 damage ticks
 * had the lone character present because their own health and damage counter
 * had moved — being *hit*, not attacking — and crediting them looked like
 * handing 8,500 points of other people's damage to whoever held aggro. So the
 * fallback became "the last character to swing". Adjudicating the same
 * recording against the counters showed the diagnosis was wrong: every one of
 * those ticks also carried the **monster's own attack counter rising** — the
 * monster attacked, the tank was hit, and the health the monster lost in the
 * same breath was the tank's **thorns**. The last-swinger fallback was not
 * protecting the tank's teammates; it was stealing the tank's reflect, 5.7%
 * of the party's damage, tick by provable tick. The remaining lone-present
 * ticks were players present with *nothing* changed about them while the
 * monster took a counted hit — their DoT ticking, which is itself the
 * actor-grouping stated as plainly as a payload can state it.
 *
 * Mana sits below both: only an ability costs mana, so a **unique** `cMP` drop
 * still separates the caster out of a *small* party. Unique, not
 * last-of-several — with synchronized builds two casts land on the same tick,
 * and "whoever iterated last wins" is an iteration-order artifact, not an
 * attribution. And only up to {@link COLLISION_SPLIT_THRESHOLD} present
 * players: past that, "exactly one person spent mana" stops being evidence,
 * because most of a trial's roster auto-attacks and leaves no mana trace, so
 * the one caster on the tick would collect everybody's damage. The last swinger
 * remains as the final fallback for the multi-player tick nothing else can
 * split.
 *
 * ## Every payload arrives twice
 *
 * 757 of 1,465 `battle_updated` messages in that recording are byte-identical to
 * the one before. Nothing here has to care — a duplicate diffs to no change and
 * produces no events — but it is why the swing behind a hit looks two ticks back
 * rather than one.
 *
 * ## A counter distinguishes a hit from a tick
 *
 * Health falling is not sufficient — bleeds and regeneration move it too. A hit
 * is `dmgCounter` **rising**, and a crit is `critCounter` rising. Which also
 * gives the one case a health diff can never express: `dmgCounter` up with the
 * health unchanged is a **miss**, not a non-event.
 *
 * ## What it deliberately does not do
 *
 * It does not guess. A small tick where several players act at once falls back
 * to the lone mana drop, because the payload cannot separate them otherwise —
 * and a tick that names nobody at all credits nobody rather than the wrong body.
 *
 * ## Health that fell without a counter is still damage
 *
 * A hit is `dmgCounter` rising, and everything else used to be discarded. A
 * bleed tick and a thorns reflect move a monster's health without moving its
 * hit counter, so every point of it fell out of the per-player tables while
 * still showing up in the party total measured off the boss bar — the two
 * disagreed by exactly the damage-over-time volume. Those ticks are now their
 * own event class (`isDot`), attributed by the same rungs as a hit and folded
 * into a `dotDamage` subtotal that rides *inside* `damage`, so every total that
 * already existed is now right and the breakdown can still name the share.
 * Hit, miss and crit counts do not move for them: a bleed is not a swing.
 *
 * ## A collision too big to adjudicate is split, not awarded
 *
 * When several players act on one tick and nothing above can separate them, the
 * last rung used to hand the whole tick to whoever swung most recently. In a
 * five-person party that is a rounding error; in a thirty-person guild trial it
 * is a systematic bias towards one slot, and the slot is chosen by iteration
 * order rather than by anything that happened. Above
 * {@link COLLISION_SPLIT_THRESHOLD} players present, the tick's damage is split
 * equally between them instead — imperfect, but bounded: nobody who acted reads
 * zero, and nobody collects a crowd's work.
 *
 * Equal rather than weighted by damage already confirmed. KikiMeter tried the
 * weighted version on real trial captures and abandoned it: players who never
 * won a solo-confirmed tick stayed at zero while the early winners took the
 * whole ambiguous stream — rich-get-richer, 56% mean error against the game's
 * own end-of-trial figures.
 *
 * ## A slot's maximum health changing is a new monster in it
 *
 * `new_guild_battle` arrives once to three times in a whole hour, so a trial's
 * baselines have no periodic safety net the way a personal fight's do (a
 * `new_battle` every wave). A monster respawning into the same slot would read
 * as its predecessor healing, or worse as phantom damage. Any change to a
 * slot's `mHP` is therefore a new instance: re-baseline the slot and count
 * nothing across the transition.
 *
 * The model is DPs' and the Floating Combat Text tool's, from MWI Combat Suite
 * by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The un-countered-damage event class, the
 * bounded equal split and the max-health respawn guard are KikiMeter v3.32.1's
 * by ZhuLiMoon (MIT) — see `third-party/kikimeter/`. The code is Toolasha's own.
 */

/**
 * A fresh set of the counters a tick is measured against.
 * @returns {Object}
 */
export function newAttributionState() {
    return {
        playersMP: {},
        playersAtk: {},
        party: {},
        lastSwing: null,
        monstersHP: {},
        // Each slot's stated maximum, so a respawn into it is recognised
        monstersMaxHP: {},
        dmgCounter: {},
        critCounter: {},
        actions: {},
    };
}

/**
 * Note what each player is preparing, so a hit can be labelled with an ability.
 *
 * The ability when one is mid-cast, `auto` when it is an auto-attack, and
 * `idle` otherwise — the same three cases MCS distinguishes, and what the
 * non-damaging filter keys off.
 *
 * ## Two spellings of the same field
 *
 * `new_battle` writes `preparingAbilityHrid` and `isPreparingAutoAttack`; the
 * per-tick `battle_updated` abbreviates them to `abilityHrid` and `isAutoAtk`.
 * Reading only the long pair means the label is whatever was being prepared
 * when the battle began and never changes again — which credits the entire
 * fight to one ability, and to the wrong one at that.
 *
 * ## When to call it
 *
 * **After attributing a tick, not before.** The hit that lands on a tick was
 * cast by what was being prepared *before* it; by the time the payload arrives
 * the player has already begun the next thing. Updating first credits every hit
 * to the ability that follows it.
 *
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} players - A `new_battle` player list or a tick's `pMap`
 */
export function noteActions(state, players) {
    for (const [index, player] of Object.entries(players || {})) {
        // A `new_battle` carries the whole roster, which is the only place the
        // party's size is stated — and it is what tells a solo run apart from a
        // party where one member happens to be alone in this tick
        state.party[index] = true;
        const ability = player?.preparingAbilityHrid || player?.abilityHrid;
        const auto = player?.isPreparingAutoAttack || player?.isAutoAtk;

        state.actions[index] = ability ? ability : auto ? 'auto' : 'idle';
    }
}

/**
 * How many players may be present in one tick before an unresolved collision is
 * split rather than awarded.
 *
 * Three is where a party stops being adjudicable by inspection. Below it the
 * existing chain — mana, then the last swinger — is a reasonable guess about a
 * handful of people; above it, in a guild trial's twenty-plus, "whoever swung
 * last" is an iteration-order artifact dressed as an attribution. KikiMeter's
 * field figures on real trial captures: ~13% of messages are collisions, up to
 * 23 actors at once.
 *
 * It gates the **counter and mana rungs as well as the fallback**, and for the
 * same reason rather than a merely similar one: a lone `cMP` drop identifies the caster
 * only while everybody present could plausibly have cast. In a twelve- to
 * twenty-three-player trial most of the roster is auto-attacking and never
 * touches its mana, so "exactly one drop" is temporal coincidence — the one
 * spender is simply the only person who *could* leave a trace — and awarding
 * them the tick systematically inflates whoever casts most. The counter rung
 * joined it once the server began streaming `atkCounter` for every present
 * player rather than the viewer's own unit — see the note on that rung. Above
 * the threshold all three are skipped and the tick reaches the equal split.
 */
export const COLLISION_SPLIT_THRESHOLD = 3;

/**
 * Who acted this tick, and whether the tick had to be shared between them.
 *
 * The rungs, strongest first: a lone attack counter rising in a party no larger
 * than {@link COLLISION_SPLIT_THRESHOLD}, a lone player in the tick, a lone
 * mana drop in a party no larger than the same threshold, a party of one. When
 * none of them fires and more
 * than {@link COLLISION_SPLIT_THRESHOLD} players are present, the tick is
 * *shared* — every present player gets an equal fraction of it — and below that
 * it falls to the last swinger as it always did.
 *
 * @param {Object} pMap - This tick's players
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - `{soloFallback, collisionThreshold}`
 * @param {boolean} [options.soloFallback] - Whether "the party has one member, so it was them"
 *   may be used on a tick that names nobody at all. True for this client's own fights, where
 *   the party is genuinely known from `new_battle`; false for a spectated guild trial, where
 *   there is no party statement and the rung would fire off whichever slot happened to appear
 *   first. The presence rung above it is unaffected — it reads this tick's own payload
 * @param {number} [options.collisionThreshold] - Overrides {@link COLLISION_SPLIT_THRESHOLD}
 * @returns {{actors: string[], shared: boolean}} The players the tick belongs to, and whether
 *   it is being divided between them rather than owned by one
 */
export function findActors(pMap, state, { soloFallback = true, collisionThreshold = COLLISION_SPLIT_THRESHOLD } = {}) {
    const indices = Object.keys(pMap || {});
    const swung = [];
    const spent = [];

    for (const index of indices) {
        const player = pMap[index];

        const attacks = Number(player?.atkCounter);
        const attacksBefore = state.playersAtk[index];
        if (Number.isFinite(attacks)) {
            if (attacksBefore !== undefined && attacks > attacksBefore) swung.push(index);
            state.playersAtk[index] = attacks;
        }

        const mana = Number(player?.cMP);
        if (Number.isFinite(mana)) {
            const before = state.playersMP[index];
            if (before !== undefined && mana < before) spent.push(index);
            state.playersMP[index] = mana;
        }
    }

    const one = (index) => ({ actors: [index], shared: false });

    // `atkCounter` is what it sounds like, and it almost always names one person:
    // in a five-character party, two of them swung on the same tick three times
    // in fourteen hundred, one of which dealt damage. Rare enough to identify
    // by, not so rare that the tie can be pretended away.
    //
    // Gated on the same threshold as the mana rung, and for a reason that only
    // became true later. The rung was written when the server streamed action
    // counters for the **viewer's own unit alone**: a counter rise was then a
    // statement that this player acted and an absence of one said nothing about
    // anybody else, so "exactly one riser" really did mean "exactly one known
    // swinger, and the tick is his". The server now sends `atkCounter`,
    // `critCounter` and `dmgCounter` for **every player present** — all 57 slots
    // of a guild trial, in every tick bucket — and the same shape means
    // something much weaker: one of a full roster ticked over while the rest
    // were mid-swing. Measured over a 150,642-tick trial, treating the lone
    // riser as the owner moves 1,332 ticks and 100,379 damage (0.32% of 31.6M)
    // off the party and onto one name, and it is the only rung in the new
    // stream that *concentrates* rather than spreads.
    //
    // So above the threshold a lone riser is no longer authoritative and the
    // tick falls through to the equal split below: it spreads the uncertainty
    // instead of piling it on whoever happened to tick over first, and it keeps
    // figures recorded either side of the server change comparable. Below the
    // threshold nothing changes — with a couple of units in play a lone counter
    // rise is still the swinger, which is what this rung was always for.
    if (swung.length === 1) {
        // Recorded whether or not the rung fires: the swing is a fact about who
        // acted, and the small-collision fallback below still wants it
        state.lastSwing = swung[0];
        if (indices.length <= collisionThreshold) return one(swung[0]);
    }

    // The delta names the actor. A tick's `pMap` carries the player whose
    // action this tick reports, so a lone entry with no counter movement is a
    // DoT ticking or thorns firing — theirs either way. Adjudicated against
    // the counters on a five-player recording: this rung was right on every
    // tick the counters could decide, and the last-swinger fallback it
    // replaces was provably wrong on 5.7% of the party's damage.
    if (indices.length === 1) return one(indices[0]);

    // Several people at once. A unique mana drop separates the caster; two
    // drops on one tick separate nothing, and "whoever iterated last" is an
    // artifact of key order, not an attribution.
    //
    // Only in a party small enough for "exactly one person cast" to be a fact
    // rather than a coincidence. In a five-person fight a lone mana drop is the
    // caster; in a twenty-three-person trial most actors are auto-attacking and
    // leave no mana trace at all, so the one member who happened to spend mana
    // this tick collects the whole crowd's damage. KikiMeter's field hardening
    // (26/07) capped the same rung at the same threshold for the same reason.
    // Above it the rung is skipped outright and the tick falls to the equal
    // split below, which is wrong about every individual and right about the
    // shape.
    if (spent.length === 1 && indices.length <= collisionThreshold) return one(spent[0]);

    // A tick that names nobody at all, in a fight whose party is one person.
    if (soloFallback && Object.keys(state.party).length === 1) {
        return one(Object.keys(state.party)[0]);
    }

    // A crowd nothing could separate. Splitting it equally is wrong about every
    // individual and right about the shape: the alternative awards the whole
    // thing to one slot for no reason a player could point at.
    if (indices.length > collisionThreshold) return { actors: [...indices], shared: true };

    // The last character to swing — still the fallback for the small collision,
    // where a handful of people is a guess rather than a bias.
    return state.lastSwing ? one(state.lastSwing) : { actors: [], shared: false };
}

/**
 * Which player acted this tick.
 *
 * The single-owner view of {@link findActors}, kept for callers that want one
 * name or nothing: a shared tick answers null, because no one player owns it.
 *
 * @param {Object} pMap - This tick's players
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - Passed to {@link findActors}
 * @returns {string|null} The player index, or null when nobody can be identified
 */
export function findCaster(pMap, state, options) {
    const { actors, shared } = findActors(pMap, state, options);
    return shared ? null : (actors[0] ?? null);
}

/**
 * The label an un-countered health loss is filed under.
 *
 * Not the ability the player was preparing: a bleed landing now was applied
 * some seconds ago, and thorns are not cast at all. Filing it under whatever
 * happened to be mid-cast would credit a rotation with damage it did not do.
 */
export const DOT_ACTION = 'dot';

/**
 * The hits in one tick.
 *
 * @param {Object} tick - A `battle_updated` payload
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - Passed to {@link findActors}; `{soloFallback, collisionThreshold}`
 * @returns {Array<Object>} Hits as
 *   `{playerIndex, monsterIndex, amount, isCrit, isMiss, isHeal, isDot, weight, action}`, and
 *   deaths as `{monsterIndex, isKill}` — the two are separate events because a
 *   bleed can land the killing blow on a tick where no counter moved. `weight`
 *   is 1 for a tick one player owns and 1/n for one shared between n of them,
 *   so a swing count still sums to the number of swings
 */
export function attributeTick(tick, state, options) {
    const { mMap, pMap } = tick || {};
    const { actors } = findActors(pMap, state, options);
    const events = [];
    const weight = actors.length ? 1 / actors.length : 0;

    for (const [index, monster] of Object.entries(mMap || {})) {
        const health = Number(monster?.currentHitpoints ?? monster?.cHP);
        if (!Number.isFinite(health)) continue;

        const maxHealth = Number(monster?.maxHitpoints ?? monster?.mHP);
        const beforeHealth = state.monstersHP[index];
        const beforeMax = state.monstersMaxHP[index];
        const beforeDamage = state.dmgCounter[index];
        const beforeCrits = state.critCounter[index];

        const damageCount = Number(monster?.dmgCounter) || 0;
        const critCount = Number(monster?.critCounter) || 0;

        state.monstersHP[index] = health;
        state.dmgCounter[index] = damageCount;
        state.critCounter[index] = critCount;
        if (Number.isFinite(maxHealth)) state.monstersMaxHP[index] = maxHealth;

        // First sighting of a monster is not a hit for its entire health bar
        if (beforeHealth === undefined) continue;

        // A different maximum in the same slot is a different monster in it.
        // The trial stream only restates its roster once or twice an hour, so
        // a respawn between those has nothing else to announce it — and the
        // slot's previous corpse read against the newcomer's full bar is
        // either a phantom heal or, with residual health, phantom damage.
        if (Number.isFinite(maxHealth) && beforeMax !== undefined && maxHealth !== beforeMax) continue;

        // A death is its own event, separate from the hit that caused it.
        // Merging the two would lose every kill landed by a bleed — the health
        // reaches zero on a tick where no counter moved — and a kill counted
        // only when a hit lands undercounts exactly the fights that take
        // longest, which are the ones worth measuring.
        if (beforeHealth > 0 && health <= 0) {
            events.push({ monsterIndex: index, isKill: true });
        }

        if (!actors.length) continue;

        const change = beforeHealth - health;
        // A hit is the counter rising. Health falling without it is a bleed
        // ticking or a reflect firing — real damage, and the actor rungs name
        // its owner exactly as they name a swing's, so it is emitted as its own
        // class rather than discarded. It is emphatically not a swing, which is
        // why it carries no crit, miss or ability of its own.
        const hit = beforeDamage !== undefined && damageCount > beforeDamage;
        if (!hit) {
            if (!(change > 0)) continue;
            for (const actor of actors) {
                events.push({
                    playerIndex: actor,
                    monsterIndex: index,
                    amount: change * weight,
                    isCrit: false,
                    isMiss: false,
                    isHeal: false,
                    isDot: true,
                    weight,
                    action: DOT_ACTION,
                });
            }
            continue;
        }

        for (const actor of actors) {
            events.push({
                playerIndex: actor,
                monsterIndex: index,
                amount: Math.abs(change) * weight,
                isCrit: beforeCrits !== undefined && critCount > beforeCrits,
                // The one case a health diff cannot express on its own
                isMiss: change === 0,
                isHeal: change < 0,
                isDot: false,
                weight,
                action: state.actions[actor] || 'idle',
            });
        }
    }
    return events;
}

/** Abilities that deal no damage, so a hit credited during one is not theirs */
const NON_DAMAGING = new Set(['idle']);

/**
 * Whether an action should count towards damage.
 *
 * @param {string} action - From an event
 * @param {Set<string>} [nonDamaging] - Ability hrids known to deal no damage
 * @returns {boolean}
 */
export function isDamagingAction(action, nonDamaging = NON_DAMAGING) {
    return !nonDamaging.has(action);
}

/**
 * Fold events into a per-player tally.
 *
 * ## Fractions are expected
 *
 * A tick shared between the players present carries `weight` below 1, and both
 * the damage and the swing counts take that weight — so a party's hits still
 * sum to the number of swings the payload showed, and nothing is rounded here
 * where the rounding would compound. Display code rounds; the ledger does not.
 *
 * ## `damage` includes `dotDamage`
 *
 * Deliberately, and it is the reason nothing downstream had to be taught about
 * damage-over-time to stop under-reporting it: `damage` is the whole of what a
 * player did, and `dotDamage` is the part of that which no swing counter ever
 * confirmed. A breakdown can name the share ("incl. X DoT/reflect"); a total
 * cannot get it wrong by forgetting to add a second field.
 *
 * @param {Object} tally - `{}` or a previous return, mutated
 * @param {Array<Object>} events - From `attributeTick`
 * @param {Object} [options] - `{filterNonDamaging, nonDamaging, nameOf}`. `nameOf`
 *   turns a monster index into a name; without it the per-enemy split is skipped.
 * @returns {Object} Player index → `{damage, dotDamage, dotTicks, hits, crits, misses, byAbility, byEnemy}`
 */
export function foldEvents(tally, events, { filterNonDamaging = true, nonDamaging, nameOf } = {}) {
    for (const event of events || []) {
        // A death is not a swing, and counting it as one would add a phantom
        // hit to whoever happened to be casting
        if (event.isKill) continue;

        const player = (tally[event.playerIndex] = tally[event.playerIndex] || {
            damage: 0,
            dotDamage: 0,
            dotTicks: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            byAbility: {},
            byEnemy: {},
        });
        // A row banked before these fields existed, or merged from one
        if (!Number.isFinite(player.dotDamage)) player.dotDamage = 0;
        if (!Number.isFinite(player.dotTicks)) player.dotTicks = 0;
        const weight = Number.isFinite(event.weight) && event.weight > 0 ? event.weight : 1;

        // Counted before the filter: a miss is a swing that happened, and
        // dropping it would flatter the hit rate of whatever was cast
        if (event.isMiss) player.misses += weight;
        if (filterNonDamaging && !isDamagingAction(event.action, nonDamaging)) continue;

        if (event.isDot) {
            player.damage += event.amount;
            player.dotDamage += event.amount;
            // Counted, not merely summed. A tick lands for a fraction of the
            // blow that applied it, so the RATIO of ticks to swings moves
            // damage-per-hit on its own — and the damage subtotal cannot say
            // how many ticks made it up. The labyrinth replay compares this
            // ratio against the sim's to decide whether a soft-hit gap is the
            // monster's mitigation or just a different hit mix.
            player.dotTicks += weight;
        } else if (!event.isMiss && !event.isHeal) {
            player.damage += event.amount;
            player.hits += weight;
            if (event.isCrit) player.crits += weight;
        }

        const ability = (player.byAbility[event.action] = player.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });
        if (event.isMiss) ability.misses += weight;
        // A bleed has no swing behind it on this tick, so it moves the damage
        // under its own label and leaves the counts alone
        else if (event.isDot) ability.damage += event.amount;
        else if (!event.isHeal) {
            ability.damage += event.amount;
            ability.hits += weight;
            if (event.isCrit) ability.crits += weight;
        }

        // The same split again, by what was being hit rather than by what was
        // swung. A party's enemy rows belong under the player who fought them —
        // one player kiting while another burns the boss is two different
        // fights, and a party-wide enemy total averages them into neither.
        const name = nameOf ? nameOf(event.monsterIndex) : null;
        if (!name) continue;

        const enemy = (player.byEnemy[name] = player.byEnemy[name] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            byAbility: {},
        });
        const against = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });

        if (event.isMiss) {
            enemy.misses += weight;
            against.misses += weight;
        } else if (event.isDot) {
            enemy.damage += event.amount;
            against.damage += event.amount;
        } else if (!event.isHeal) {
            enemy.damage += event.amount;
            enemy.hits += weight;
            against.damage += event.amount;
            against.hits += weight;
            if (event.isCrit) {
                enemy.crits += weight;
                against.crits += weight;
            }
        }
    }
    return tally;
}

/**
 * Fold events into a per-monster tally.
 *
 * The player table answers "who is doing the damage". This answers "to what",
 * which is the other half of a fight: a run that looks slow is often one zone's
 * worth of a single tanky monster rather than a rotation problem, and no
 * per-ability figure can say so.
 *
 * Keyed by name rather than by index, because an index is one spawn — a zone
 * cycles through dozens of them and the question is about the kind of monster,
 * not this particular rat.
 *
 * @param {Object} tally - `{}` or a previous return, mutated
 * @param {Array<Object>} events - From `attributeTick`
 * @param {Function} nameOf - `(monsterIndex) => string|null`
 * @returns {Object} Monster name → `{damage, dotDamage, hits, crits, misses, kills, byAbility}`
 */
export function foldEnemies(tally, events, nameOf) {
    for (const event of events || []) {
        const name = nameOf(event.monsterIndex);
        if (!name) continue;

        const enemy = (tally[name] = tally[name] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            kills: 0,
            dotDamage: 0,
            byAbility: {},
        });

        if (event.isKill) {
            enemy.kills++;
            continue;
        }

        const ability = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });

        const weight = Number.isFinite(event.weight) && event.weight > 0 ? event.weight : 1;
        if (event.isMiss) {
            enemy.misses += weight;
            ability.misses += weight;
        } else if (event.isDot) {
            // Real damage the monster took, with no swing behind it here
            enemy.damage += event.amount;
            enemy.dotDamage = (enemy.dotDamage || 0) + event.amount;
            ability.damage += event.amount;
        } else if (!event.isHeal) {
            enemy.damage += event.amount;
            enemy.hits += weight;
            ability.damage += event.amount;
            ability.hits += weight;
            if (event.isCrit) {
                enemy.crits += weight;
                ability.crits += weight;
            }
        }
    }
    return tally;
}
