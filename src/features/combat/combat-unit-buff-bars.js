/**
 * Buff and debuff bars under every combat unit.
 *
 * A fight is decided by which effects are up, and the game shows almost none of
 * it: your own buffs are a row of icons in one corner, a monster's debuffs are
 * nowhere, and a party member's are nowhere either. So the question "is the
 * boss still cursed, and for how long" is answered by counting seconds in your
 * head from when you last saw the cast. This puts the answer under the unit it
 * is about — the player, each party member, and each monster — as a strip of
 * the game's own ability icons with a live countdown on each.
 *
 * ## The buff maps are authoritative; nothing here is inferred
 *
 * Every `battle_updated` carries each unit's `combatBuffMap`, keyed by unique
 * hrid, with the duration and start time the server is actually running. That
 * is the whole data source. A cast is *not* watched and an effect is *not*
 * assumed to have landed: an inference would put a debuff on a monster that
 * resisted it, and a strip that lies about what is up is worse than no strip.
 * `new_battle` seeds the same way from the combatant list, so a fight that
 * opens with effects already on it draws them at once rather than at the first
 * tick.
 *
 * The map names its entries by unique hrid and says nothing about which ability
 * produced them or whether they help — `utils/ability-effects.js` is the index
 * that answers both, and the sprite slug a chip draws comes from there too.
 *
 * ## Only what an ability applied
 *
 * The map is not a list of fight state: it is everything standing on the unit,
 * and for a player most of it is their loadout — achievements, community
 * buffs, house rooms, drinks, one entry per source. A real mid-dungeon map
 * carried 27 entries of only 17 distinct types, five of them wisdom, most with
 * `duration: 0` and the zero-time start that marks a permanent passive. None of
 * that is decided by the fight, all of it is stated elsewhere in the game's own
 * UI, and drawing it buried the two chips that mattered under a row of
 * identical ones. So a chip is drawn only for an effect the ability index
 * declares: the question the strip exists to answer is whether a
 * damage-over-time is still ticking and how long is left on the boss's debuff.
 *
 * ## One cast, one chip
 *
 * A chip's icon is the *ability*'s, so one cast granting several effects — the
 * three amplifies of Mystic Aura, of Elemental Affinity — drew that icon three
 * times over the same countdown, the same complaint the filter above answers.
 * Effects agreeing on both the ability and the expiry are collapsed into one
 * chip, marked with the count they stand for and titled with each of their
 * names; `readBuffMap` states the rule.
 *
 * ## Joined by name for players, by slot for monsters
 *
 * The same split `portrait-dps.js` makes, for the same reasons. A player's slot
 * is a seat in *this* fight and the moment somebody leaves every index after
 * them means a different person, so the payload's slot is translated to a name
 * at `new_battle` and the tiles are matched on that; a tile whose name is not
 * in the fight gets no strip rather than somebody else's effects. Monsters have
 * no names worth joining on — two of the same monster side by side are two
 * different fights — so they keep the slot, which is stable for the length of a
 * battle.
 *
 * ## The guild trial's fight view draws nothing
 *
 * A spectated trial renders the *same* `BattlePanel_playersArea` and the same
 * `CombatUnit` tiles, inside the Guild panel — and its fight is not on this
 * client's `new_battle`/`battle_updated` feed at all (it streams as
 * `new_guild_battle`/`guild_battle_updated`, which nothing here reads). The
 * watcher's own name is on a tile in both places, so the name join happily
 * painted the *live* fight's buff map onto the trial tile, kept fresh by the
 * watcher's own combat still running in the background. Monsters are worse
 * again: joined by slot, so the trial's boss wore whatever slot 0 of the live
 * fight was carrying.
 *
 * So a players or monsters area inside the guild panel is skipped and any strip
 * already in it removed. Not "reset on trial start" — the live fight's own
 * messages would re-seed the state and draw it again on the next tick; the
 * *drawing* is what has to stand down. The discriminator is structural rather
 * than a message-stream flag on purpose: the trial stream keeps flowing after
 * the fight view is closed (`guild-trial-damage.js` says so outright), so a
 * "trial is live" flag would blank the player's own bars, while
 * `closest('[class*="GuildPanel"]')` answers the only question that matters —
 * whose panel is this tile in — and needs no timeout in either direction.
 * `combat-dps-panel.js` keeps its opener out of the same panel the same way.
 *
 * The anchor discovery is `portrait-dps.js`'s: the shared `GAME` selectors, the
 * strip appended in the tile's own flow as its last child (the battle panel
 * clips its children, so anything hung outside the box is drawn and cropped
 * away), and the same `domObserver` class registration to catch React rebuilding
 * the panel and taking every injected node with it.
 *
 * ## One interval, and only the changed text is written
 *
 * This redraws every second in combat, so: one shared interval for every unit
 * rather than one per unit, stopped the moment no unit carries an effect and
 * stopped again when the battle panel goes, so a fight that ended with an
 * effect of unstated length on a unit leaves no timer behind; a chip added only
 * when an effect appears and removed only when it expires; and
 * a countdown written only when its *rounded* second changes, which is once a
 * second per chip rather than once a frame. Nothing is measured off the layout,
 * so no draw here forces one.
 *
 * Off by default: the tiles already carry health, mana, an ability bar and
 * whatever the other portrait features are drawing, and a purely visual
 * addition to a crowded tile should be asked for rather than assumed.
 *
 * Adapted from MWITools battleBuffs, CC-BY-NC-SA-4.0, see third-party/mwitools/.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { effectForBuff, effectLabel, effectSourceLabel, hridSlug } from '../../utils/ability-effects.js';
import { GAME } from '../../utils/selectors.js';

/** Where the party's tiles live, as opposed to the monsters' */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';

/**
 * Whether an area belongs to a spectated guild trial rather than this
 * character's own fight.
 *
 * The trial's In Progress fight view renders the same battle-panel areas and
 * the same unit tiles inside the guild panel, and nothing here has ever read
 * the trial's own stream — see the header. `combat-dps-panel.js` fences its
 * opener off the same way.
 *
 * @param {Element|null} area - A players or monsters area
 * @returns {boolean}
 */
export function isTrialArea(area) {
    return Boolean(area?.closest?.(GAME.GUILD_PANEL));
}

/** Marks a strip as ours, so a rebuild cannot leave two */
export const STRIP_MARK = 'data-toolasha-buff-strip';

/** Marks one effect's chip inside a strip; its value is the effect's unique hrid */
export const CHIP_MARK = 'data-toolasha-buff';

/** Slow enough not to fight the game's own redraw, fast enough for a countdown */
export const REFRESH_MS = 1000;

/** The engine's time unit, as `combat-simulator.js` declares it */
const NANOSECONDS_PER_SECOND = 1e9;

/**
 * How far apart two expiries may be and still count as the same one.
 *
 * One second, which is the countdown's own resolution: `countdownText` ceils to
 * whole seconds below a minute and to whole minutes above one, so two effects
 * closer together than this cannot be told apart by the number a chip draws.
 * A wider tolerance would merge effects a player can see running out at
 * different times; a narrower one would split a single cast whose effects the
 * server stamped a few milliseconds apart.
 */
export const EXPIRY_TOLERANCE_MS = 1000;

/**
 * The bucket prefix for an effect whose record names no ability.
 *
 * A space, which no hrid contains and no ability hrid can start with, so an
 * effect parked under it can never share a bucket with a real ability's — or
 * with another nameless effect, since the unique hrid is appended.
 */
const NO_ABILITY_BUCKET = ' ';

/** Green for something helping the unit it is on, red for something hurting it */
const KIND_COLORS = { buff: '#7ddc7d', debuff: '#ff8b7a' };

/**
 * The `abilities_sprite` URL, scraped from the page and cached.
 *
 * The game serves it under a webpack hash that changes with every update, so it
 * cannot be hardcoded — but it is already on the page, on every ability icon
 * the game itself drew, so one query answers it without a fetch. Cached because
 * this runs per chip per battle, and re-read only while it is still unknown
 * (before the combat panel has drawn anything there is nothing to scrape).
 */
let spriteUrl = null;

/**
 * The sprite href for an ability slug, or null when the page has not drawn an
 * ability icon yet and the chip should fall back to its text label.
 *
 * @param {string} slug - The ability's sprite fragment, e.g. `toughness`
 * @returns {string|null}
 */
export function abilitySpriteHref(slug) {
    if (!slug) return null;
    if (!spriteUrl) {
        const href = document.querySelector('use[href*="abilities_sprite"]')?.getAttribute('href');
        spriteUrl = href ? href.split('#')[0] : null;
    }
    return spriteUrl ? `${spriteUrl}#${slug}` : null;
}

/** Forget the scraped sprite URL — for tests, and for a page that replaced it. */
export function _resetSpriteUrl() {
    spriteUrl = null;
}

/**
 * Seconds from a live buff's duration.
 *
 * Nanoseconds, like every other duration the game states — `buff.duration` in
 * the ability data, `enrageTimerDuration` on a monster's sheet. A value that
 * does not come out positive is not guessed at in another unit; the caller
 * falls back to the duration the ability index carries.
 *
 * @param {*} duration - A `combatBuffMap` entry's `duration`
 * @returns {number|null}
 */
export function liveDurationSeconds(duration) {
    const seconds = Number(duration) / NANOSECONDS_PER_SECOND;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * One unit's effects, read from the buff map the server states for it.
 *
 * Anything already expired is dropped here rather than drawn and removed a
 * frame later. An effect whose duration nothing states is kept with no expiry:
 * it is genuinely on the unit, and a chip with no countdown says so honestly
 * where dropping it would claim the unit is clean.
 *
 * ## One cast, one chip
 *
 * A single cast can grant several effects — Mystic Aura grants three amplifies,
 * Elemental Affinity the same — and every one of them resolves its sprite from
 * the *ability*, so they draw the identical icon under the identical countdown
 * and read as the same buff three times over. So effects that agree on both the
 * ability that applied them and the moment they expire are collapsed into one
 * group, which is what a chip is drawn for. The group's `title` still names
 * every effect it covers, so the detail is a hover away rather than gone.
 *
 * Only both together collapse: two effects of one ability with expiries further
 * apart than {@link EXPIRY_TOLERANCE_MS} were applied or refreshed separately
 * and are genuinely different state, so they keep their own chips and their own
 * countdowns. An effect whose record names no ability collapses with nothing —
 * there is no cast to attribute it to.
 *
 * @param {Object} combatBuffMap - The unit's `combatBuffMap`, keyed by unique hrid
 * @param {number} now - `Date.now()` for this pass, taken once by the caller
 * @param {Object} [abilityDetailMap] - Passed through to the effect index
 * @returns {Map<string, {key: string, uniqueHrids: string[], kind: string, slug: string, label: string, expiresAt: number|null}>}
 *   Keyed by group identity, which for the ordinary one-effect group is that
 *   effect's own unique hrid
 */
export function readBuffMap(combatBuffMap, now, abilityDetailMap) {
    // Insertion-ordered by the ability first seen, so the output keeps the
    // order the buff map states rather than reshuffling chips on collapse
    const byAbility = new Map();
    for (const [uniqueHrid, buff] of Object.entries(combatBuffMap || {})) {
        // An entry the index does not declare was not applied by an ability, so
        // it is loadout rather than fight state and gets no chip — see the
        // module comment. Drinks go with the rest: pre-fight setup on a
        // several-minute timer, already on screen in the consumables UI.
        const record = effectForBuff(uniqueHrid, abilityDetailMap);
        if (!record) continue;

        const seconds = liveDurationSeconds(buff?.duration) ?? record.durationSeconds ?? null;
        const started = Date.parse(String(buff?.startTime ?? ''));
        const startedAt = Number.isFinite(started) ? started : now;
        const expiresAt = seconds === null ? null : startedAt + seconds * 1000;
        // This is what a permanent passive's zero-time start also lands in:
        // `0001-01-01T00:00:00Z` parses finite and two millennia past, so such
        // an entry reads as long expired here rather than needing a case of its
        // own and a second chance to draw a nonsense countdown.
        if (expiresAt !== null && expiresAt <= now) continue;

        // A record naming no ability has nothing to collapse on, so it is given
        // a bucket of its own that no other effect can land in
        const bucket = record.abilityHrid || `${NO_ABILITY_BUCKET}${uniqueHrid}`;
        if (!byAbility.has(bucket)) byAbility.set(bucket, []);
        byAbility.get(bucket).push({ uniqueHrid, record, expiresAt });
    }

    const effects = new Map();
    const labels = new Set();
    for (const entries of byAbility.values()) {
        for (const group of collapseByExpiry(entries)) {
            const anchor = group[0].record;
            const uniqueHrids = group.map((entry) => entry.uniqueHrid).sort();
            // The group is its members, so the key changes only when the set
            // does — a chip's identity survives every tick that changes nothing
            const key = uniqueHrids.join(' ');
            // A collapsed chip stands for the cast, so it abbreviates the
            // ability; a lone effect keeps abbreviating itself, because several
            // effects of one ability would otherwise all read alike
            const source = group.length > 1 ? anchor.slug : hridSlug(anchor.uniqueHrid);
            const base = (group.length > 1 ? effectLabel(anchor.slug) : effectSourceLabel(anchor)) || '?';
            const label = distinctLabel(base, source, labels);
            labels.add(label);
            effects.set(key, {
                key,
                uniqueHrids,
                kind: anchor.kind,
                slug: anchor.slug,
                label,
                // The latest of the group, so a chip never vanishes while one
                // of the effects it stands for is still running. A group is
                // either all timed or all untimed, so one member decides which.
                expiresAt: group[0].expiresAt === null ? null : Math.max(...group.map((entry) => entry.expiresAt)),
            });
        }
    }
    return effects;
}

/**
 * Split one ability's effects into groups that share an expiry.
 *
 * Sorted by expiry and taken greedily: each group opens on the earliest effect
 * not yet placed and takes everything within {@link EXPIRY_TOLERANCE_MS} of it.
 * An effect with no stated expiry joins only other effects with none — "unknown"
 * is not a time, and cannot be shown to agree with one.
 *
 * @param {Array<{uniqueHrid: string, record: Object, expiresAt: number|null}>} entries
 * @returns {Array<Array<{uniqueHrid: string, record: Object, expiresAt: number|null}>>}
 */
function collapseByExpiry(entries) {
    const sorted = [...entries].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    const groups = [];
    for (const entry of sorted) {
        const open = groups[groups.length - 1];
        const anchor = open?.[0]?.expiresAt ?? null;
        const agrees =
            open &&
            (entry.expiresAt === null
                ? anchor === null
                : anchor !== null && entry.expiresAt - anchor <= EXPIRY_TOLERANCE_MS);
        if (agrees) open.push(entry);
        else groups.push([entry]);
    }
    return groups;
}

/**
 * A label no other effect on the same unit is already using.
 *
 * Abbreviations name the effect rather than the stat it moves, because one unit
 * can carry two ability effects of the same type — Fury's accuracy and an
 * accuracy ability's are both `/buff_types/accuracy`. Where two of those names
 * still abbreviate alike the later one lengthens, so two chips never read the
 * same without being the same thing.
 *
 * @param {string} base - The abbreviation for this effect
 * @param {string} source - The name it abbreviates, the source of the longer forms
 * @param {Set<string>} taken - The labels already used on this unit
 * @returns {string}
 */
function distinctLabel(base, source, taken) {
    const slug = String(source ?? '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase();
    let label = base;
    for (let length = base.length + 1; taken.has(label) && length <= slug.length; length += 1) {
        label = slug.slice(0, length);
    }
    // Two hrids differing only above their last segment abbreviate identically
    // however far they are followed; the map tells them apart, so the strip must
    while (taken.has(label)) label += '+';
    return label;
}

/**
 * What a chip's countdown says: whole seconds, minutes once it is over a
 * minute, and nothing at all for an effect with no stated duration.
 *
 * @param {number|null} expiresAt - ms since epoch, or null
 * @param {number} now - `Date.now()` for this pass
 * @returns {string}
 */
export function countdownText(expiresAt, now) {
    if (expiresAt === null || expiresAt === undefined) return '';
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    return seconds > 60 ? `${Math.ceil(seconds / 60)}m` : String(seconds);
}

/**
 * Whether a node was injected by this script, which every feature marks with a
 * `data-toolasha-*` attribute of its own.
 *
 * @param {Element} node
 * @returns {boolean}
 */
function isInjected(node) {
    for (const attribute of node.attributes || []) {
        if (attribute.name.startsWith('data-toolasha')) return true;
    }
    return false;
}

/**
 * Whether a strip has to be moved to sit under the tile's own content.
 *
 * Last child, except that other injected nodes are allowed to sit after it.
 * `portrait-dps.js` and `combat-unit-badges.js` both re-seat their own node as
 * the tile's last child on every draw, so a strip that insisted on last place
 * moved theirs and had its own moved straight back — a re-seat war that
 * rewrote the whole strip subtree on every tick of every fight, for nothing.
 * Yielding to them settles after one exchange; the game's own children are
 * still moved above.
 *
 * @param {HTMLElement} tile - The tile the strip belongs to
 * @param {HTMLElement} strip - The strip
 * @returns {boolean}
 */
function needsSeating(tile, strip) {
    if (strip.parentElement !== tile) return true;
    for (let node = strip.nextElementSibling; node; node = node.nextElementSibling) {
        if (!isInjected(node)) return true;
    }
    return false;
}

/**
 * The name each player slot holds, from a `new_battle` payload.
 *
 * @param {Object} payload - A `new_battle` message
 * @returns {Object} slot key → name, skipping slots that state none
 */
export function slotNames(payload) {
    const names = {};
    for (const [slot, player] of Object.entries(payload?.players || {})) {
        const name = player?.name || player?.character?.name || null;
        if (name) names[slot] = name;
    }
    return names;
}

class CombatUnitBuffBars {
    constructor() {
        this.isInitialized = false;
        this.timers = createTimerRegistry();
        this.cleanups = createCleanupRegistry();
        this.unregisterClass = null;
        this.unregisterReady = null;
        this.ticking = false;
        this._reset();
    }

    /** Forget the fight: no names, no effects, nothing to draw */
    _reset() {
        /** Player slot → name, from `new_battle`; the join for player tiles */
        this.names = {};
        /** Player name → Map of their effects */
        this.players = new Map();
        /** Monster slot → Map of its effects */
        this.monsters = new Map();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('combatUnitBuffBars')) return;
        this.isInitialized = true;

        this.onNewBattle = (payload) => this._guard('new battle', () => this._newBattle(payload));
        this.onBattleUpdated = (payload) => this._guard('combat tick', () => this._battleUpdated(payload));
        // Stand down rather than carry one character's effects onto another's
        // tiles: the strips are cleared here and refilled by the arriving
        // character's first battle message, which is the first honest reading
        this.onCharacterSwitching = () => this._guard('character switch', () => this._standDown());

        webSocketHook.on('new_battle', this.onNewBattle);
        webSocketHook.on('battle_updated', this.onBattleUpdated);
        dataManager.on?.('character_switching', this.onCharacterSwitching);

        // React rebuilds the battle panel whenever the fight changes and
        // whenever the Combat tab is left and returned to, taking the strips
        // with it. The redraw is from state, so re-attaching is just drawing
        // again — there is nothing to re-acquire.
        this.unregisterClass = domObserver.onClass('CombatUnitBuffBars', 'BattlePanel_playersArea', () => this.draw());
        // @run-at document-start: a battle panel rendered before the shared observer
        // attaches is invisible to the class watcher, so the catch-up waits for the
        // observer's own ready signal (immediate when it is already attached)
        this.unregisterReady = domObserver.onReady('CombatUnitBuffBarsCatchUp', () => this.draw());
    }

    disable() {
        if (this.onNewBattle) webSocketHook.off('new_battle', this.onNewBattle);
        if (this.onBattleUpdated) webSocketHook.off('battle_updated', this.onBattleUpdated);
        if (this.onCharacterSwitching) dataManager.off?.('character_switching', this.onCharacterSwitching);
        this.onNewBattle = null;
        this.onBattleUpdated = null;
        this.onCharacterSwitching = null;

        this.unregisterClass?.();
        this.unregisterClass = null;
        this.unregisterReady?.();
        this.unregisterReady = null;

        this._stopTicking();
        this.cleanups.cleanupAll();
        this._reset();
        this._removeStrips();
        this.isInitialized = false;
    }

    /**
     * @param {string} what - What was being read, for the log
     * @param {Function} work - The read
     */
    _guard(what, work) {
        try {
            work();
        } catch (error) {
            console.error(`[CombatUnitBuffBars] Reading a ${what} failed:`, error);
        }
    }

    /** Every strip in the document, gone. */
    _removeStrips() {
        for (const strip of document.querySelectorAll(`[${STRIP_MARK}]`)) strip.remove();
    }

    /** A switch clears the fight and the tiles together — see `onCharacterSwitching` */
    _standDown() {
        this._reset();
        this._stopTicking();
        this._removeStrips();
    }

    /**
     * Seed from the combatant list. Slots are re-read every battle: a slot is a
     * seat in this fight, and last fight's slot 0 was somebody else.
     * @param {Object} payload - A `new_battle` message
     */
    _newBattle(payload) {
        const now = Date.now();
        const map = dataManager.getInitClientData?.()?.abilityDetailMap;
        this._reset();
        this.names = slotNames(payload);

        for (const [slot, player] of Object.entries(payload?.players || {})) {
            const name = this.names[slot];
            if (!name) continue;
            this.players.set(name, readBuffMap(player?.combatBuffMap, now, map));
        }
        for (const [slot, monster] of Object.entries(payload?.monsters || {})) {
            this.monsters.set(String(slot), readBuffMap(monster?.combatBuffMap, now, map));
        }

        this.draw(now);
    }

    /**
     * Reconcile against the maps this tick states.
     *
     * A unit the payload does not mention keeps what it had — a tick is a patch,
     * not a census — but a unit it *does* mention has its whole set replaced,
     * because the map it carries is the complete list of what is on that unit.
     * That replacement is what expires an effect: the server simply stops
     * listing it.
     *
     * @param {Object} payload - A `battle_updated` message
     */
    _battleUpdated(payload) {
        const now = Date.now();
        const map = dataManager.getInitClientData?.()?.abilityDetailMap;

        for (const [slot, unit] of Object.entries(payload?.pMap || {})) {
            if (!unit?.combatBuffMap) continue;
            const name = this.names[slot];
            if (!name) continue;
            this.players.set(name, readBuffMap(unit.combatBuffMap, now, map));
        }
        for (const [slot, unit] of Object.entries(payload?.mMap || {})) {
            if (!unit?.combatBuffMap) continue;
            this.monsters.set(String(slot), readBuffMap(unit.combatBuffMap, now, map));
        }

        this.draw(now);
    }

    /** Whether any unit still carries something worth counting down */
    _hasEffects() {
        for (const effects of this.players.values()) if (effects.size) return true;
        for (const effects of this.monsters.values()) if (effects.size) return true;
        return false;
    }

    /**
     * The one interval, started on demand and stopped the moment the fight has
     * nothing on it. One timer for every unit on screen, never one per unit.
     */
    _startTicking() {
        if (this.ticking) return;
        this.ticking = true;
        this.timers.registerInterval(
            setInterval(() => {
                if (document.hidden) return;
                this._guard('countdown tick', () => this.draw());
            }, REFRESH_MS),
            'combatUnitBuffBars.tick'
        );
    }

    /** Stop the interval. This module registers exactly one, so `clearAll` is it. */
    _stopTicking() {
        if (!this.ticking) return;
        this.ticking = false;
        this.timers.clearAll();
    }

    /**
     * Draw every strip from state.
     *
     * Expiry happens here rather than on the wire: an effect whose stated
     * expiry has passed is dropped from the state on the pass that notices,
     * so the next tick has nothing to redraw and the interval can stop.
     *
     * @param {number} [now] - `Date.now()`, taken once for the whole pass
     */
    draw(now = Date.now()) {
        this._expire(now);
        const players = this._ownArea(PLAYERS_AREA);
        const monsters = this._ownArea(GAME.BATTLE_MONSTERS_AREA);
        this._drawSide(players, now, true);
        this._drawSide(monsters, now, false);
        // No panel is no countdown to write, and holding the interval open for
        // one is a timer that outlives the fight: a battle ends without a
        // message saying so, and an effect `readBuffMap` kept with no stated
        // expiry never expires, so `_hasEffects()` alone would have ticked for
        // the rest of the session. The class watcher draws again when the panel
        // comes back, which is what restarts it.
        if ((players || monsters) && this._hasEffects()) this._startTicking();
        else this._stopTicking();
    }

    /**
     * This character's own area of a kind, and no trial's.
     *
     * A spectated guild trial draws the same areas inside the guild panel with
     * this fight's units nowhere in them, so one is never drawn on — and any
     * strip left in one from before the view opened is taken out here, so
     * nothing is left to flash on the way in or out. The first area outside the
     * guild panel is the party's own; there is only ever one, and taking the
     * first keeps the old `querySelector` behaviour when no trial is on screen.
     *
     * @param {string} selector - `PLAYERS_AREA` or the monsters area's
     * @returns {HTMLElement|null} The party's own area, or null when only a
     *   trial's is on screen
     */
    _ownArea(selector) {
        let own = null;
        for (const area of document.querySelectorAll(selector)) {
            if (isTrialArea(area)) {
                for (const strip of area.querySelectorAll(`[${STRIP_MARK}]`)) strip.remove();
            } else if (!own) own = area;
        }
        return own;
    }

    /**
     * @param {number} now - `Date.now()` for this pass
     */
    _expire(now) {
        for (const effects of [...this.players.values(), ...this.monsters.values()]) {
            for (const [uniqueHrid, effect] of effects) {
                if (effect.expiresAt !== null && effect.expiresAt <= now) effects.delete(uniqueHrid);
            }
        }
    }

    /**
     * @param {HTMLElement|null} area - The players or monsters area
     * @param {number} now - `Date.now()` for this pass
     * @param {boolean} byName - Players join on the name, monsters on the slot
     */
    _drawSide(area, now, byName) {
        if (!area) return;
        // Players come in two tile shapes and both are matched, because the
        // name is the join and a mini unit carries one. Monsters are joined by
        // slot, so their tiles must stay in one DOM-ordered list — a second
        // selector concatenated onto the first would renumber every slot.
        const tiles = byName
            ? [...area.querySelectorAll(`${GAME.COMBAT_UNIT}, ${GAME.MINI_UNIT}`)]
            : [...area.querySelectorAll(GAME.COMBAT_UNIT)];
        tiles.forEach((tile, index) => {
            let effects;
            if (byName) {
                const name =
                    tile.querySelector(GAME.COMBAT_UNIT_NAME)?.textContent?.trim() ||
                    tile.querySelector(GAME.MINI_UNIT_NAME)?.textContent?.trim() ||
                    '';
                // No name match is no strip. Falling back to position is what
                // puts one player's effects on another's tile the moment
                // somebody leaves the party.
                effects = name ? this.players.get(name) : null;
            } else {
                effects = this.monsters.get(String(index));
            }
            this._strip(tile, effects, now);
        });
    }

    /**
     * One tile's strip, diffed against what is already on it.
     *
     * Three writes and no more: a chip for an effect that appeared, a removal
     * for one that expired, and a countdown for one whose rounded second
     * changed. An unchanged chip is not touched at all — which, in a fight
     * where the panel mutates at frame rate, is nearly all of them.
     *
     * @param {HTMLElement} tile - A combat unit tile
     * @param {Map<string, Object>|null|undefined} effects - What is on that unit
     * @param {number} now - `Date.now()` for this pass
     */
    _strip(tile, effects, now) {
        const existing = tile.querySelector(`:scope > [${STRIP_MARK}]`);
        if (!effects || effects.size === 0) {
            existing?.remove();
            return;
        }

        let strip = existing;
        if (!strip) {
            strip = document.createElement('div');
            strip.setAttribute(STRIP_MARK, '1');
            // In the tile's flow as its last child, the way `portrait-dps.js`
            // seats a monster meter: the battle panel clips its children, so a
            // strip positioned outside the tile's box is drawn and cropped away
            Object.assign(strip.style, {
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '3px',
                pointerEvents: 'none',
                lineHeight: '1',
                padding: '1px 0',
            });
        }
        if (needsSeating(tile, strip)) tile.appendChild(strip);

        const chips = new Map();
        for (const chip of strip.children) chips.set(chip.getAttribute(CHIP_MARK), chip);

        for (const [key, effect] of effects) {
            let chip = chips.get(key);
            if (chip) chips.delete(key);
            else {
                chip = this._chip(effect);
                strip.appendChild(chip);
            }
            const text = countdownText(effect.expiresAt, now);
            // The whole point of the diff: written once a second per chip
            // rather than on every draw the observer asks for
            if (chip.dataset.left !== text) {
                chip.dataset.left = text;
                chip.lastElementChild.textContent = text;
            }
        }

        // Whatever the loop did not claim is an effect that is no longer on the
        // unit — expired, dispelled, or the unit is a different one now
        for (const chip of chips.values()) chip.remove();
    }

    /**
     * @param {Object} effect - One entry from {@link readBuffMap}
     * @returns {HTMLElement} A chip: the ability's sprite where there is one, its
     *   abbreviation where there is not, and the countdown under both
     */
    _chip(effect) {
        const chip = document.createElement('span');
        chip.setAttribute(CHIP_MARK, effect.key);
        Object.assign(chip.style, {
            // The stack count is hung off this, so it costs the strip no room
            position: 'relative',
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'center',
            fontSize: '9px',
            fontWeight: 'bold',
            color: KIND_COLORS[effect.kind] || KIND_COLORS.buff,
            textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
        });
        const kindName = effect.kind === 'debuff' ? 'Debuff' : 'Buff';
        chip.title =
            effect.uniqueHrids.length > 1
                ? [`${kindName} (${effect.uniqueHrids.length}):`, ...effect.uniqueHrids].join('\n')
                : `${kindName}: ${effect.uniqueHrids[0]}`;

        const href = abilitySpriteHref(effect.slug);
        if (href) {
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('width', '14');
            icon.setAttribute('height', '14');
            icon.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', href);
            icon.appendChild(use);
            chip.appendChild(icon);
        } else {
            // Every effect drawn here is one an ability declares, so a sprite
            // exists for all of them — but none resolves before the game has
            // drawn an ability icon for the URL to be scraped off. The
            // abbreviation stands in until it has.
            const label = document.createElement('span');
            label.textContent = effect.label;
            chip.appendChild(label);
        }

        // A collapsed chip says how many effects it stands for the way a stack
        // count is drawn anywhere else — a corner mark on the icon. Out of flow,
        // so a chip that carries one is exactly the size of a chip that does
        // not, and the strip does not grow.
        if (effect.uniqueHrids.length > 1) {
            const count = document.createElement('span');
            count.textContent = `×${effect.uniqueHrids.length}`;
            Object.assign(count.style, {
                position: 'absolute',
                top: '-2px',
                right: '-3px',
                fontSize: '8px',
                pointerEvents: 'none',
            });
            chip.appendChild(count);
        }

        // Last child by contract: the diff writes the countdown through it
        const countdown = document.createElement('span');
        chip.appendChild(countdown);
        return chip;
    }
}

const combatUnitBuffBars = new CombatUnitBuffBars();

/** The singleton, exposed for tests. */
export { combatUnitBuffBars as _instance };

export default {
    name: 'Combat Unit Buff Bars',
    initialize: () => combatUnitBuffBars.initialize(),
    cleanup: () => {
        try {
            return combatUnitBuffBars.disable();
        } catch (error) {
            console.error('[Combat Unit Buff Bars] Disable failed part-way:', error);
        } finally {
            combatUnitBuffBars.isInitialized = false;
        }
    },
    /** Draw now rather than on the next tick — for tests, and for a settings change */
    redraw: () => combatUnitBuffBars.draw(),
};
