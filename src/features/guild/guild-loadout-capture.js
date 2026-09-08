/**
 * Catching a loadout as it goes past.
 *
 * `guild-loadouts.js` knows what a snapshot is and where it is kept. This knows
 * *when* one happens: a unit popup opening, a party assembling for a trial, a
 * combat session ending. It listens, it extracts, it writes, and it does nothing
 * else — so the shapes it reads are testable without a socket and the timing is
 * testable without a stat sheet.
 *
 * ## The popup, twice over
 *
 * The popup is expected to be websocket-fed: `battle_unit_fetched` is the
 * message the client already treats as un-deduplicable because consecutive
 * fetches of *different units* look identical in the first hundred characters,
 * which is only a problem if the thing being fetched is a unit somebody is
 * looking at. When that message arrives with a stat sheet on it, that is the
 * popup's own data and nothing needs reading off the screen.
 *
 * It has not been possible to verify that from a live client, so the modal is
 * read as well — and the two do not fight, because the scrape stands down when a
 * socket snapshot has just landed ({@link POPUP_SOCKET_WINDOW_MS}). If the
 * message does feed the popup, the scrape never runs. If it does not, the scrape
 * is the only thing that produces a snapshot and the feature still works. The
 * cost of being wrong in either direction is nothing.
 *
 * The scrape itself is deliberately structural, in the same discipline the
 * trials scrape uses: no class name is trusted beyond `Modal_`, which is already
 * load-bearing elsewhere in the codebase. A unit popup is *whatever modal shows
 * a name with a level beside it and a column of labelled numbers* — see
 * {@link readUnitPopup}.
 */

import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { textLines } from './guild-trials-scrape.js';
import { gameDigitsSource } from '../../utils/number-parser.js';
import {
    extractLoadout,
    extractPartyLoadouts,
    foldLoadout,
    isMonsterUnit,
    isItemName,
    loadLoadouts,
    loadoutKey,
    loadoutList,
    pruneCharacterOnlyLoadouts,
    purgeMonsterLoadouts,
    saveLoadouts,
} from './guild-loadouts.js';

/**
 * How recently a socket snapshot has to have arrived for the modal scrape to
 * stand down. A popup and the message that filled it are the same gesture, and
 * a few seconds is generous for a round trip.
 */
export const POPUP_SOCKET_WINDOW_MS = 5000;

/** Fewer labelled numbers than this and the modal is not a stat sheet */
export const MIN_POPUP_ROWS = 4;

/** Writes are batched: a party of five arrives as five messages in one frame */
const SAVE_DEBOUNCE_MS = 1000;

/**
 * A value as the sheet writes one: `1,240`, `12.5%`, `+3` (or, in a
 * period-grouping locale, `1.240`).
 *
 * Built fresh from {@link gameDigitsSource} on every call rather than a
 * frozen `[\d,]+(?:\.\d+)?` constant, which only recognised comma grouping
 * and read a period as the decimal point unconditionally — wrong the moment
 * the game's language is not en-US.
 *
 * @returns {RegExp}
 */
function valuePattern() {
    return new RegExp(`^[+-]?(?:${gameDigitsSource()})\\s*%?$`);
}

/** A name with its level beside it: `Tib - Lv.150`, or `Lv.150` under a name */
const HEADER_PATTERN = /^(.*?)[\s-–—]*Lv\.?\s*(\d+)\s*$/i;

/**
 * A loadout snapshot read off an open modal, or null when the modal is not one.
 *
 * Found rather than named. A unit popup is a modal that carries a name with a
 * level after it and at least {@link MIN_POPUP_ROWS} label/number pairs beneath
 * it; a settings dialog has neither, and an item tooltip has the numbers without
 * the header. Both halves are required, so neither on its own can produce a
 * player who does not exist.
 *
 * Text runs rather than `textContent`, for the reason the trials scrape spells
 * out at length: welding siblings together invents digit runs nobody displayed.
 *
 * The abilities are not read here. The popup draws them as icons with a level
 * badge and there is no text pairing that survives being wrong, so a snapshot
 * scraped from the screen carries the stat sheet and says nothing about the kit
 * — which is better than a kit assembled out of whichever numbers happened to
 * sit near an image.
 *
 * @param {Element} root - The modal
 * @param {number} [at] - When it was read
 * @returns {Object|null} A snapshot in the {@link extractLoadout} shape, or null
 */
export function readUnitPopup(root, at = Date.now()) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;

    const lines = textLines(root);
    if (lines.length < MIN_POPUP_ROWS) return null;

    let name = null;
    let level = null;
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(HEADER_PATTERN);
        if (!match) continue;

        const parsed = Number(match[2]);
        if (!Number.isFinite(parsed)) continue;

        // The name is usually on the same run as the level and sometimes the run
        // before it, because the game styles the two differently
        const inline = match[1].trim();
        const previous = index > 0 ? lines[index - 1].replace(/[-–—]\s*$/, '').trim() : '';
        const candidate = inline || previous;
        if (!candidate || !/[a-z]/i.test(candidate)) continue;

        name = candidate;
        level = parsed;
        break;
    }
    if (!name) return null;

    const rows = [];
    for (let index = 0; index < lines.length - 1; index += 1) {
        const label = lines[index];
        const value = lines[index + 1];
        const isValue = valuePattern();
        if (!isValue.test(value)) continue;
        if (isValue.test(label) || !/[a-z]/i.test(label)) continue;

        rows.push({ label: label.replace(/[:\s]+$/, ''), value });
        index += 1;
    }
    if (rows.length < MIN_POPUP_ROWS) return null;

    // The boss's popup has exactly this shape — "Trial Chameleon - Lv.110" over
    // a stat sheet — and was scraped into the roster as a member. So does an
    // ITEM detail modal: "Chance Cape ★" with a level requirement over stat
    // rows landed in the trial roster the same way. Neither is a loadout,
    // whichever way it arrived
    if (isMonsterUnit({ name }) || isItemName(name)) return null;

    // The empty list is "not read", not "none equipped" — `abilitiesAuthoritative`
    // is what keeps foldLoadout from erasing a kit a socket payload captured
    return {
        name,
        characterId: null,
        level,
        rows,
        abilities: [],
        abilitiesAuthoritative: false,
        stats: {},
        source: 'popup',
        at,
    };
}

class GuildLoadoutCapture {
    constructor() {
        this.initialized = false;
        this.record = { players: {}, updatedAt: 0 };
        this.characterId = null;
        /** The guild the record is keyed by; null before the name has arrived */
        this.guildName = null;
        /** When this session began, so pre-adoption sightings can be told apart */
        this.startedAt = 0;
        /**
         * When the record last stopped belonging to a guild — a character
         * switch, or a guild the character has left. Sightings older than this
         * cannot be shown to belong to whatever guild is named next.
         */
        this.guildEpochAt = 0;
        this.unregister = [];
        this.timers = createTimerRegistry();
        this.lastSocketAt = 0;
        this.saveQueued = false;
        /** How many features are currently relying on this; see {@link cleanup} */
        this.owners = 0;
        /** Who hears about each recorded loadout; see {@link onCaptured} */
        this.listeners = new Set();
    }

    /**
     * Hear about every loadout the moment it is recorded — before the batched
     * save, so a panel can redraw without waiting on either the debounce or its
     * own refresh timer.
     *
     * @param {Function} listener - Called with
     *   `{characterId, name, source, abilitiesAuthoritative, at}`
     * @returns {Function} Unsubscribe
     */
    onCaptured(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Tell the listeners a loadout landed. One failing listener must not
     * silence the rest, or the capture itself.
     * @param {Object} loadout - The snapshot just folded into the record
     */
    _emitCaptured(loadout) {
        const event = {
            characterId: loadout?.characterId ?? null,
            name: loadout?.name ?? null,
            source: loadout?.source ?? null,
            abilitiesAuthoritative: loadout?.abilitiesAuthoritative === true,
            at: loadout?.at ?? null,
        };
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error('[GuildLoadoutCapture] A capture listener failed:', error);
            }
        }
    }

    /**
     * Start listening.
     *
     * Idempotent, and called from both the trials feature and the roster view —
     * either of them being switched on is reason enough to be recording, and
     * neither should have to know whether the other already is. Counted rather
     * than merely guarded, so one of the two being cleaned up does not take the
     * listeners away from the other.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        this.owners += 1;
        if (this.initialized) return;
        this.initialized = true;

        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        this.startedAt = Date.now();
        this.record = await loadLoadouts(this.characterId, this.guildName);

        // Self-heal on the way in. Clicking the boss in a trial's fight view
        // fetched its sheet exactly as clicking a member does, and it was filed
        // under the roster — so "Trial Chameleon Lv.110" is already on disk for
        // anybody who opened one before this shipped, and would otherwise be
        // exported and shared out in the estimated damage split forever
        const cleaned = purgeMonsterLoadouts(this.record);
        if (cleaned.purged.length) {
            console.warn('[GuildLoadoutCapture] Dropping stored monster sheets:', cleaned.purged.join(', '));
            this.record = cleaned.record;
            await saveLoadouts(this.characterId, this.record, this.guildName);
        }

        this.onUnitFetched = (message) => this._onUnitFetched(message);
        this.onNewBattle = (message) => this._onNewBattle(message);
        webSocketHook.on('battle_unit_fetched', this.onUnitFetched);
        webSocketHook.on('new_battle', this.onNewBattle);
        this.unregister.push(() => {
            webSocketHook.off('battle_unit_fetched', this.onUnitFetched);
            webSocketHook.off('new_battle', this.onNewBattle);
        });

        this.unregister.push(
            domObserver.onClass('GuildLoadoutPopup', ['Modal_modalContent', 'Modal_modalContainer'], (node) =>
                this._onModal(node)
            )
        );
    }

    /** Stop listening, once nothing is relying on it any more */
    cleanup() {
        this.owners = Math.max(0, this.owners - 1);
        if (this.owners > 0) return;

        for (const unregister of this.unregister) unregister();
        this.unregister = [];
        this.timers.clearAll();
        this.saveQueued = false;
        this.listeners.clear();
        this.initialized = false;
    }

    /**
     * Move the record onto the guild's own key, once the guild is known.
     *
     * The same lazy adoption the trial record does, for the same reason: the
     * guild's name arrives on socket traffic after this initialises. The guild
     * key is always the base — whatever is stored under it is this guild's own
     * history — and the only question is which of the sightings in hand may
     * join it.
     *
     * **The rule: only sightings this session could have watched happen in
     * *this* guild.** That is `at >= max(startedAt, guildEpochAt)`, and only
     * when no other guild has been named since — the window between this
     * module initialising and the guild's name arriving, during which the
     * character was demonstrably in the guild now being named. Anything older
     * is a sighting from a previous session under no guild at all, and a
     * previous session may have been a previous guild.
     *
     * What that costs and why it is worth it: a character who has never
     * switched guilds loses nothing stored under the guild key and keeps
     * re-collecting into it, but the sightings sitting in the *character-only*
     * key from before this shipped are not carried over. They are not deleted
     * either — the character-only key stands as legacy, so nothing is
     * destroyed on the strength of a name that has just arrived. The
     * alternative is what was reported: `guildLoadouts_30404` and
     * `guildLoadouts_30404_SuperMoo` byte-identical minutes after the switch,
     * the whole of the Testmaxxing roster adopted onto SuperMoo's key because
     * SuperMoo's key happened to be empty.
     *
     * `null` forgets which guild the record is keyed by, for a character
     * switch, and starts a new epoch; the next name to arrive re-adopts.
     *
     * @param {string|null} name - The guild's name, or null to forget
     * @returns {Promise<void>}
     */
    async setGuildName(name) {
        try {
            if (!name) {
                if (this.guildName !== null) this.guildEpochAt = Date.now();
                this.guildName = null;
                return;
            }
            if (name === this.guildName) return;

            const held = this.record;
            const before = this.guildName;
            // The character, not just the name. The old check compared the
            // NAME, and the name a switch leaves behind is `null` — which is
            // also what an ordinary first adoption starts from, so `null` back
            // to `null` read as nothing having happened. Meanwhile `_note` had
            // moved `this.characterId` on to the arriving character and reset
            // the record for them, and everything below then wrote the
            // DEPARTING character's roster under the arriving character's guild
            // key and handed it to the prune — which deletes from their
            // character-only record every player that roster happens to name,
            // and for two alts in one guild that is the whole of it.
            const characterId = this.characterId;
            const stored = await loadLoadouts(characterId, name);
            // A switch, or another guild, may have arrived while the read was in flight
            if (this.guildName !== before || this.characterId !== characterId) return;

            // A name arriving over another name is a guild change, and every
            // sighting in hand was taken inside the guild being left
            const since = before === null ? Math.max(this.startedAt, this.guildEpochAt) : Infinity;

            let record = purgeMonsterLoadouts(stored).record || { players: {}, updatedAt: 0 };
            for (const player of loadoutList(held)) {
                if (Number.isFinite(player?.at) && player.at >= since) record = foldLoadout(record, player);
            }

            this.record = record;
            this.guildName = name;
            this.guildEpochAt = Date.now();
            this._queueSave();

            // Now that the guild key holds them, the character-only key must
            // not go on holding them too — that duplicate is what the old
            // wholesale adoption spread across guilds
            const dropped = await pruneCharacterOnlyLoadouts(characterId, this.record);
            if (dropped.length) {
                console.info('[GuildLoadoutCapture] Character-only record pruned:', dropped.join(', '));
            }
        } catch (error) {
            console.error('[GuildLoadouts] Adopting the guild key failed:', error);
        }
    }

    /** @returns {Array<Object>} Every snapshot held, most recently seen first */
    seen() {
        return loadoutList(this.record);
    }

    /**
     * @param {string} name - A player name
     * @returns {Object|null} Their most recent snapshot
     */
    forPlayer(name) {
        return this.seen().find((entry) => entry.name?.toLowerCase() === String(name || '').toLowerCase()) || null;
    }

    /**
     * @param {Object} message - `battle_unit_fetched`
     */
    _onUnitFetched(message) {
        try {
            const loadout = extractLoadout(message);
            // The end-of-session variant carries loot and no sheet, and
            // `extractLoadout` returns null for it — the clock is only stamped
            // when a real sheet arrived, so the modal scrape is not stood down
            // by a message that could not have filled a popup
            if (!loadout) return;
            this.lastSocketAt = Date.now();
            this._note(loadout);
        } catch (error) {
            console.error('[GuildLoadouts] Reading a fetched unit failed:', error);
        }
    }

    /**
     * @param {Object} message - `new_battle`
     */
    _onNewBattle(message) {
        try {
            for (const loadout of extractPartyLoadouts(message)) {
                // The local player's own `new_battle` fires on every wave of
                // their personal fights, which kept their own row pinned at
                // "seen Just now" forever — a freshness the sheet never earned,
                // and one that hid the "open your Battle Info" prompt. The same
                // discipline the trial abilities panel keeps: the local
                // player's loadout refreshes only when their Battle Info is
                // actually opened (`battle_unit_fetched` or the popup scrape).
                // Everyone *else* in the party keeps folding — a teammate's
                // sighting is exactly what this message is for.
                if (this._isLocalPlayer(loadout)) continue;
                this._note(loadout);
            }
        } catch (error) {
            console.error('[GuildLoadouts] Reading a party roster failed:', error);
        }
    }

    /**
     * Whether a snapshot is the local player's own.
     *
     * Matched on the character id when both sides have one, and on the name
     * otherwise — a `new_battle` player entry does not always carry an id, and
     * the name comparison uses {@link loadoutKey} so it is exactly as
     * case-insensitive as the store the snapshot would land in.
     *
     * @param {Object} loadout - A snapshot from {@link extractPartyLoadouts}
     * @returns {boolean} True when it is the current character
     */
    _isLocalPlayer(loadout) {
        if (!loadout) return false;

        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (characterId != null && loadout.characterId != null) {
            return String(loadout.characterId) === String(characterId);
        }

        const name = dataManager.getCurrentCharacterName?.() ?? dataManager.characterData?.characterInfo?.name ?? null;
        if (name && loadout.name) return loadoutKey(loadout.name) === loadoutKey(name);

        return false;
    }

    /**
     * @param {Element} node - A modal that has just appeared
     */
    _onModal(node) {
        try {
            if (Date.now() - this.lastSocketAt < POPUP_SOCKET_WINDOW_MS) return;
            const loadout = readUnitPopup(node);
            if (loadout) this._note(loadout);
        } catch (error) {
            console.error('[GuildLoadouts] Reading a unit popup failed:', error);
        }
    }

    /**
     * Keep a snapshot, and schedule a write.
     * @param {Object} loadout - From `extractLoadout` or `readUnitPopup`
     */
    _note(loadout) {
        // Asked at each write rather than cached: the user switches characters
        // without reloading, and an alt's sightings must not land in this one's
        // record
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (characterId !== this.characterId) {
            this.characterId = characterId;
            // The arriving character's guild is not knowable yet; the trials
            // feature re-states it and the record re-adopts then
            this.guildName = null;
            this.record = { players: {}, updatedAt: 0 };
            this._adopt(characterId, loadout);
            return;
        }

        this.record = foldLoadout(this.record, loadout);
        this._emitCaptured(loadout);
        this._queueSave();
    }

    /**
     * Bring in the arriving character's own record before folding into it.
     * @param {string|number|null} characterId - The character now current
     * @param {Object} loadout - The snapshot that noticed the switch
     * @returns {Promise<void>}
     */
    async _adopt(characterId, loadout) {
        try {
            const record = await loadLoadouts(characterId);
            // Another switch may have happened while the read was in flight
            if (characterId !== this.characterId) return;
            this.record = foldLoadout(record, loadout);
            this._emitCaptured(loadout);
            this._queueSave();
        } catch (error) {
            console.error('[GuildLoadouts] Reloading after a character switch failed:', error);
        }
    }

    /** Batch the writes: a party of five arrives as five snapshots in one frame */
    _queueSave() {
        if (this.saveQueued) return;
        this.saveQueued = true;

        this.timers.registerTimeout(
            setTimeout(async () => {
                this.saveQueued = false;
                await saveLoadouts(this.characterId, this.record, this.guildName);
            }, SAVE_DEBOUNCE_MS)
        );
    }
}

const guildLoadoutCapture = new GuildLoadoutCapture();

export default guildLoadoutCapture;
export { guildLoadoutCapture };
