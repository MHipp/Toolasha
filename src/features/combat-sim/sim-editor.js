/**
 * Shared Sim Editor
 * Loadout editor used by both Combat Sim and Lab Sim.
 * Manages equipment, abilities, consumables, skill levels, and house rooms.
 */

import dataManager from '../../core/data-manager.js';
import {
    buildGameDataPayload,
    buildAllPlayerDTOs,
    buildPlayerDTO,
    parseShykaiImport,
    applyLoadoutSnapshotToDTO,
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
    applyGuildBuffLevel,
} from './combat-sim-adapter.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import { loadoutSnapshot } from '../../utils/bundle-bridge.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';
import { COMBAT_SCROLL_LABELS, COMBAT_SCROLL_BUFF_TYPES } from '../../utils/combat-scroll-buffs.js';
import { achievementBuffLabel } from '../../utils/achievement-combat-buffs.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

const ACCENT = '#4a9eff';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';

/**
 * Highest level a community buff reaches in game — a maxed one reads
 * "Level: 20 (Max)".
 *
 * The inputs used to accept 30, which let the editor sim a state the game
 * cannot reach and put the sim at odds with the upgrade advisor's own ceiling
 * (`MAX_COMMUNITY_BUFF_LEVEL` in upgrade-advisor.js, the same 20).
 */
const MAX_COMMUNITY_BUFF_LEVEL = 20;

/**
 * Escape a string for interpolation into this file's `innerHTML` templates.
 * Import text is pasted by the user, so an item hrid that reaches the DOM as a
 * fallback label is not trusted markup.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Where the last Loadout dropdown selection is remembered, per character.
 *
 * Only the combat sim's own Configure tab uses it: the lab editor drives the
 * dropdown itself, one loadout per fight, and the skilling editor has no
 * dropdown at all.
 */
const LOADOUT_MEMORY_KEY = 'simEditorLoadoutName';

export class SimEditor {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.editorEl - Container element the editor renders into
     * @param {boolean} [options.labMode=false] - When true, filters coffees from consumable picker
     * @param {boolean} [options.skillingMode=false] - When true, shows skilling skills/loadouts/token upgrades
     */
    constructor({ editorEl, labMode = false, skillingMode = false }) {
        this._editorEl = editorEl;
        this.labMode = labMode;
        this.skillingMode = skillingMode;

        this._editedDTOs = null;
        this._editedPlayerInfo = null;
        this._originalDTOs = null;
        this._openSections = new Set();
        this._activeEditPlayer = null;
        this._selfHrid = null;
        this._missingMembers = [];
        this._importSkipped = [];
        this._editorInitialized = false;
        this._selectedLoadoutName = '';
    }

    getEditedDTOs() {
        this._syncHouseRoomsFromGame();
        return this._editedDTOs;
    }

    /**
     * Bring the self player's house rooms up to what the game says now.
     *
     * The DTO is built once, when the editor opens, and a room upgraded in
     * the House tab afterwards was invisible to every run until the panel
     * was reset — the Upgrade tab kept proposing the level already built. A
     * room the user has edited by hand in the editor is theirs and is left
     * alone; only rooms still at their opening value follow the game.
     */
    _syncHouseRoomsFromGame() {
        const self = this._selfHrid;
        const edited = this._editedDTOs?.[self];
        const original = this._originalDTOs?.[self];
        if (!edited || !original) return;
        let live;
        try {
            live = dataManager.getHouseRooms?.();
        } catch {
            return;
        }
        if (!live || typeof live.forEach !== 'function') return;
        edited.houseRooms = edited.houseRooms || {};
        original.houseRooms = original.houseRooms || {};
        live.forEach((room, hrid) => {
            const level = Number(room?.level) || 0;
            const was = original.houseRooms[hrid] || 0;
            if ((edited.houseRooms[hrid] || 0) !== was) return; // hand-edited: theirs
            if (level === was) return;
            edited.houseRooms[hrid] = level;
            original.houseRooms[hrid] = level;
        });
    }
    getPlayerInfo() {
        return this._editedPlayerInfo;
    }
    getSelfHrid() {
        return this._selfHrid;
    }
    getMissingMembers() {
        return this._missingMembers;
    }
    isInitialized() {
        return this._editorInitialized;
    }
    getSelectedLoadoutName() {
        return this._selectedLoadoutName;
    }

    /**
     * Apply a named loadout to the active player DTO and re-render.
     *
     * A name no snapshot answers to leaves the editor exactly as it was — the
     * remembered selection below is restored through here, and a loadout the
     * user has since deleted must fall back to current gear rather than half-
     * applying anything.
     *
     * @param {string} loadoutName - Snapshot name to apply
     * @returns {boolean} True when a snapshot of that name was applied
     */
    applyLoadoutByName(loadoutName) {
        if (!loadoutName || !this._editedDTOs) return false;
        if (!this._applyLoadoutToDTO(loadoutName)) return false;
        this._selectedLoadoutName = loadoutName;
        this._saveLoadoutMemory();
        this.renderEditor();
        return true;
    }

    /**
     * Whether this editor remembers its Loadout selection between openings.
     *
     * Only the combat sim's Configure tab does: the lab editor drives the
     * dropdown itself (one loadout per fight), the skilling editor has no
     * dropdown, and a DTO that is not this character's — an imported export, a
     * party member, a profile-simmed stranger, all of which carry a null
     * `_selfHrid` — keeps the gear it arrived with.
     *
     * @returns {boolean} True when the selection may be saved and restored
     * @private
     */
    _remembersLoadout() {
        if (this.labMode || this.skillingMode) return false;
        return Boolean(this._selfHrid) && this._activeEditPlayer === this._selfHrid;
    }

    /**
     * Persist the current Loadout selection for this character.
     * @private
     */
    async _saveLoadoutMemory() {
        if (!this._remembersLoadout()) return;
        try {
            await writeScoped(LOADOUT_MEMORY_KEY, this._selectedLoadoutName || '');
        } catch (error) {
            console.error('[SimEditor] Failed to save the loadout selection:', error);
        }
    }

    /**
     * Re-apply the loadout this character last simmed with.
     *
     * Goes through `applyLoadoutByName` rather than reaching into the DTO, so a
     * restored selection is the same state a manual pick leaves behind — and a
     * snapshot that no longer exists silently leaves current gear in place.
     * @private
     */
    async _restoreLoadoutMemory() {
        if (!this._remembersLoadout()) return;
        // Fixed before the read: `applyLoadoutByName` writes the name straight
        // back through `_saveLoadoutMemory`, whose key is resolved when the
        // write runs. A switch inside the read applied the departing
        // character's remembered loadout to the arriving character's editor —
        // and, where both characters have a loadout of that name, silently
        // simmed them in the wrong gear — then stored that name as the arriving
        // character's own memory.
        const owner = dataManager.getCurrentCharacterId?.() ?? null;
        try {
            const saved = await readScoped(LOADOUT_MEMORY_KEY, 'settings', '');
            if ((dataManager.getCurrentCharacterId?.() ?? null) !== owner) return;
            if (typeof saved !== 'string' || !saved) return;
            this.applyLoadoutByName(saved);
        } catch (error) {
            console.error('[SimEditor] Failed to restore the loadout selection:', error);
        }
    }

    /**
     * Load DTOs from live character data.
     * @param {Object} [options]
     * @param {boolean} [options.restoreLoadout=true] - Re-apply the remembered Loadout
     *   selection; false for the explicit resets, whose whole point is current gear
     */
    async initEditor({ restoreLoadout = true } = {}) {
        const editorArea = this._editorEl;
        if (!editorArea) return;

        // Fixed before the build. `buildAllPlayerDTOs()` reads the live
        // character, and everything below is adopted after it: a switch landing
        // inside that window left the departing character's gear, levels and
        // house in the rebuilt panel's editor, with `_editorInitialized` set so
        // nothing rebuilt it. A sim run from there reports the wrong
        // character's numbers as a measurement, and reads as one.
        const owner = dataManager.getCurrentCharacterId?.() ?? null;

        try {
            const { players, playerInfo, selfHrid, missingMembers } = await buildAllPlayerDTOs();
            if ((dataManager.getCurrentCharacterId?.() ?? null) !== owner) {
                // Left uninitialised on purpose: the next show()/initEditor
                // builds the arriving character's own DTOs
                this._editorInitialized = false;
                return;
            }
            if (!players.length) {
                editorArea.innerHTML =
                    '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">No character data available.</div>';
                return;
            }

            const dtoMap = {};
            for (const p of players) {
                dtoMap[p.hrid] = p;
            }

            this._originalDTOs = structuredClone(dtoMap);
            this._editedDTOs = structuredClone(dtoMap);
            this._editedPlayerInfo = playerInfo;
            this._selfHrid = selfHrid;
            this._activeEditPlayer = selfHrid;
            this._missingMembers = missingMembers;
            this._importSkipped = [];
            this._editorInitialized = true;

            this.renderEditor();
            if (restoreLoadout) await this._restoreLoadoutMemory();
        } catch (error) {
            console.error('[SimEditor] Failed to init editor:', error);
            editorArea.innerHTML =
                '<div style="color:#f66; font-size:12px; text-align:center; padding:20px 0;">Failed to load character data.</div>';
        }
    }

    /**
     * Pre-load editor with an external DTO (e.g. from character card).
     * @param {Object} dto - Player DTO
     * @param {string} playerName - Display name
     */
    openWithExternalDTO(dto, playerName) {
        dto.hrid = 'player1';
        const dtoMap = { player1: structuredClone(dto) };
        this._originalDTOs = structuredClone(dtoMap);
        this._editedDTOs = structuredClone(dtoMap);
        this._editedPlayerInfo = [{ hrid: 'player1', name: playerName }];
        // Not self: the DTO is another character's profile, and the self house
        // sync in getEditedDTOs would overwrite their rooms with this player's
        this._selfHrid = null;
        this._activeEditPlayer = 'player1';
        this._missingMembers = [];
        this._importSkipped = [];
        this._editorInitialized = true;
        this.renderEditor();
    }

    /**
     * Import players from parsed export data.
     * @param {Array<Object>} players - Player DTOs
     * @param {Array<string>} names - Player names
     * @param {Array<Object>} [skipped] - Equipment `parseShykaiImport` could not place
     */
    importPlayers(players, names, skipped = []) {
        if (!this._editedDTOs) {
            this._editedDTOs = {};
            this._originalDTOs = {};
            this._editedPlayerInfo = [];
        }

        const existingSlots = this._editedPlayerInfo.map((p) => {
            const match = p.hrid.match(/player(\d+)/);
            return match ? parseInt(match[1]) : 0;
        });
        let nextSlot = existingSlots.length > 0 ? Math.max(...existingSlots) + 1 : 1;

        for (let i = 0; i < players.length; i++) {
            const dto = players[i];
            dto.hrid = `player${nextSlot}`;
            this._editedDTOs[dto.hrid] = dto;
            this._originalDTOs[dto.hrid] = structuredClone(dto);
            this._editedPlayerInfo.push({ hrid: dto.hrid, name: names[i] || `Player ${nextSlot}` });
            nextSlot++;
        }

        this._activeEditPlayer = this._editedPlayerInfo[this._editedPlayerInfo.length - 1]?.hrid;
        this._selfHrid = this._selfHrid || null;
        this._missingMembers = [];
        this._importSkipped = Array.isArray(skipped) ? skipped : [];
        this._editorInitialized = true;
        this._selectedLoadoutName = '';

        this.renderEditor();
    }

    /**
     * Is there a party the editor could load right now?
     *
     * A solo character still carries a `partySlotMap` with one filled slot in it,
     * so "in a party" is two or more slots with a character in them — anything
     * less and "Reset to Party" would be the same button as "Reset to Me" with a
     * more interesting name.
     *
     * @returns {boolean} True when the character is grouped with someone
     */
    hasPartyData() {
        const slots = dataManager.characterData?.partyInfo?.partySlotMap;
        if (!slots) return false;
        return Object.values(slots).filter((member) => member?.characterID).length > 1;
    }

    /**
     * Throw away the loaded players and load just this character, as they are now.
     *
     * The point of the button is escaping a Configure tab full of imported
     * strangers, so it reads the character live rather than restoring
     * `_originalDTOs` — those are a snapshot of whatever was loaded last, which
     * after an import is the strangers. The selected loadout is cleared for the
     * same reason: what comes back is current gear, and the dropdown must say so.
     *
     * Zone, tier and hours live on the panel rather than in here, so they are
     * untouched by design.
     *
     * @returns {boolean} False when there is no character data to read
     */
    resetToSelf() {
        const selfDTO = buildPlayerDTO();
        if (!selfDTO) return false;

        selfDTO.hrid = 'player1';
        selfDTO.debuffOnLevelGap = 0;
        const dtoMap = { player1: selfDTO };

        this._originalDTOs = structuredClone(dtoMap);
        this._editedDTOs = structuredClone(dtoMap);
        this._editedPlayerInfo = [{ hrid: 'player1', name: dataManager.characterData?.character?.name || 'Player 1' }];
        this._selfHrid = 'player1';
        this._activeEditPlayer = 'player1';
        this._missingMembers = [];
        this._importSkipped = [];
        this._selectedLoadoutName = '';
        this._editorInitialized = true;

        this.renderEditor();
        this._saveLoadoutMemory();
        return true;
    }

    /**
     * Throw away the loaded players and load this character plus the current party.
     *
     * This is `initEditor` again, which is exactly right: that is the path that
     * reads the live party and it re-reads it every time. What a party member's
     * loadout is built from is a cached `profile_shared` payload — their gear,
     * skills, abilities and house from the last time their character card was
     * opened, plus live consumables when a fight is in progress — so a member
     * nobody has ever opened cannot be loaded at all. Those come back in
     * `missingMembers` and the editor says so rather than inventing a body for
     * them.
     *
     * @returns {Promise<void>}
     */
    async resetToParty() {
        this._selectedLoadoutName = '';
        this._editorInitialized = false;
        await this.initEditor({ restoreLoadout: false });
        this._saveLoadoutMemory();
    }

    /**
     * Reset all editor state.
     */
    reset() {
        this._editorInitialized = false;
        this._editedDTOs = null;
        this._originalDTOs = null;
        this._editedPlayerInfo = null;
        this._selfHrid = null;
        this._missingMembers = [];
        this._importSkipped = [];
        this._selectedLoadoutName = '';
    }

    /**
     * The two buttons that put the player list back to live data.
     *
     * They sit beside the chips because that is what they act on, and they are
     * rendered in the empty state too — a list emptied by removing everyone is
     * exactly when getting yourself back with one click is worth the most.
     *
     * "Reset to Party" is rendered whether or not there is a party, disabled
     * when there is not: a button that vanishes leaves the reader wondering
     * whether the sim can do it at all, where a greyed one with a reason
     * answers that.
     *
     * @private
     * @returns {string} HTML for the reset buttons
     */
    _renderResetControls() {
        const base =
            'padding:3px 8px; border-radius:5px; font-size:11px; font-family:inherit; ' +
            'background:rgba(255,255,255,0.04); border:1px solid #333;';
        const inParty = this.hasPartyData();
        const partyStyle = inParty
            ? `${base} color:#888; cursor:pointer;`
            : `${base} color:#555; cursor:default; opacity:0.55;`;
        const partyTitle = inParty
            ? 'Reload this character and the party you are in now, replacing everyone in the list'
            : 'You are not in a party right now';

        let html = `<button data-reset-players="self" style="${base} color:#888; cursor:pointer;"
            title="Reload just this character as they are right now, replacing everyone in the list">Reset to Me</button>`;
        html += `<button data-reset-players="party" style="${partyStyle}" title="${partyTitle}"${
            inParty ? '' : ' disabled'
        }>Reset to Party</button>`;
        return html;
    }

    /**
     * Party members the sim could not build, and why.
     * @private
     * @returns {string} HTML for the note, or '' when everyone loaded
     */
    _renderMissingMembersNote() {
        const missing = this._missingMembers || [];
        if (!missing.length) return '';
        return `<div style="color:#c9a227; font-size:11px; margin:-4px 0 8px;">
            Not loaded: ${missing.join(', ')} — a party member's loadout comes from their shared profile.
            Open their character card once, then reset again.
        </div>`;
    }

    /**
     * Equipment the last import could not place, and therefore left off the loadout.
     *
     * The import fails closed on an item the game's own sheet cannot resolve rather
     * than guessing its slot from the export's raw location string. Without this the
     * only trace is a console warning, and a dropped main hand simply reads as a
     * character who fights unarmed.
     * @private
     * @returns {string} HTML for the note, or '' when everything was placed
     */
    _renderImportSkippedNote() {
        const skipped = this._importSkipped || [];
        if (!skipped.length) return '';
        const names = [...new Set(skipped.map((entry) => entry.itemName || entry.itemHrid))];
        return `<div style="color:#c9a227; font-size:11px; margin:-4px 0 8px;">
            Not equipped from the import: ${escapeHtml(names.join(', '))} — this game version's item
            data has no equipment slot for ${names.length === 1 ? 'it' : 'them'}, so the sim runs
            without ${names.length === 1 ? 'it' : 'them'}.
        </div>`;
    }

    /**
     * @private
     * @param {HTMLElement} editorArea - Container the editor rendered into
     */
    _wireResetControls(editorArea) {
        editorArea.querySelectorAll('[data-reset-players]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (btn.disabled) return;
                if (btn.dataset.resetPlayers === 'party') {
                    await this.resetToParty();
                    return;
                }
                if (!this.resetToSelf()) {
                    editorArea.innerHTML =
                        '<div style="color:#f66; font-size:12px; text-align:center; padding:20px 0;">No character data available.</div>';
                }
            });
        });
    }

    /**
     * Render the loadout editor for the active player.
     */
    renderEditor() {
        const editorArea = this._editorEl;
        if (!editorArea || !this._editedDTOs) return;

        const playerInfo = this._editedPlayerInfo || [];
        const activePlayer = this._activeEditPlayer;
        const dto = this._editedDTOs[activePlayer];

        if (!dto && playerInfo.length === 0) {
            editorArea.innerHTML = `
                <div style="text-align:center; padding:20px 0;">
                    <div style="color:#888; font-size:12px; margin-bottom:10px;">No players loaded.</div>
                    <div style="display:flex; gap:6px; justify-content:center; margin-bottom:10px; flex-wrap:wrap;">
                        ${this._renderResetControls()}
                    </div>
                    <button id="mwi-csim-import-btn" style="
                        background:${ACCENT_BTN_BG}; border:1px solid ${ACCENT_BTN_BORDER}; color:${ACCENT};
                        padding:5px 14px; border-radius:5px; font-size:12px; cursor:pointer;
                        font-family:inherit; font-weight:600;">+ Import Player</button>
                    <div id="mwi-csim-import-area" style="display:none; margin-top:10px; text-align:left;">
                        <textarea id="mwi-csim-import-text" placeholder="Paste Combat Sim Export JSON here..." style="
                            width:100%; height:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                            border-radius:4px; padding:6px; font-size:11px; font-family:monospace; resize:vertical;
                            box-sizing:border-box;"></textarea>
                        <div style="display:flex; gap:6px; margin-top:4px;">
                            <button id="mwi-csim-import-go" style="
                                background:${ACCENT_BTN_BG}; border:1px solid ${ACCENT_BTN_BORDER}; color:${ACCENT};
                                padding:3px 12px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;
                                font-weight:600;">Import</button>
                            <button id="mwi-csim-import-cancel" style="
                                background:rgba(255,255,255,0.04); border:1px solid #333; color:#888;
                                padding:3px 12px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;">Cancel</button>
                            <span id="mwi-csim-import-error" style="color:#f44; font-size:11px; align-self:center;"></span>
                        </div>
                    </div>
                </div>
            `;

            this._wireResetControls(editorArea);

            const importBtn = editorArea.querySelector('#mwi-csim-import-btn');
            if (importBtn) {
                importBtn.addEventListener('click', () => {
                    const area = editorArea.querySelector('#mwi-csim-import-area');
                    if (area) area.style.display = area.style.display === 'none' ? 'block' : 'none';
                });
            }
            const importGo = editorArea.querySelector('#mwi-csim-import-go');
            if (importGo) {
                importGo.addEventListener('click', () => {
                    const text = editorArea.querySelector('#mwi-csim-import-text')?.value?.trim();
                    const errorEl = editorArea.querySelector('#mwi-csim-import-error');
                    if (!text) {
                        if (errorEl) errorEl.textContent = 'Paste export data first.';
                        return;
                    }
                    const result = parseShykaiImport(text);
                    if (!result || !result.players.length) {
                        if (errorEl) errorEl.textContent = 'Invalid format. Paste a Combat Sim Export JSON.';
                        return;
                    }
                    this.importPlayers(result.players, result.names, result.skipped);
                });
            }
            const importCancel = editorArea.querySelector('#mwi-csim-import-cancel');
            if (importCancel) {
                importCancel.addEventListener('click', () => {
                    const area = editorArea.querySelector('#mwi-csim-import-area');
                    if (area) area.style.display = 'none';
                });
            }
            return;
        }

        if (!dto) return;

        const gameData = buildGameDataPayload();
        if (!gameData) return;

        let html = '';

        // Player tabs + import/remove controls
        html += `<div style="display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap; align-items:center;">`;
        if (playerInfo.length > 1) {
            for (const { hrid, name } of playerInfo) {
                const isActive = hrid === activePlayer;
                const tabStyle = isActive
                    ? `background:${ACCENT_BG}; border:1px solid ${ACCENT_BORDER}; color:${ACCENT}; font-weight:700;`
                    : 'background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa;';
                html += `<button data-edit-tab="${hrid}" style="
                    ${tabStyle}
                    padding:3px 8px; border-radius:5px; font-size:12px; cursor:pointer;
                    font-family:inherit; transition:all 0.1s; position:relative;
                ">${name}<span data-remove-player="${hrid}" style="margin-left:4px; color:#f44; cursor:pointer; font-size:14px;" title="Remove player">\u00d7</span></button>`;
            }
        } else if (playerInfo.length === 1) {
            const { hrid, name } = playerInfo[0];
            html += `<button data-edit-tab="${hrid}" style="
                background:${ACCENT_BG}; border:1px solid ${ACCENT_BORDER}; color:${ACCENT}; font-weight:700;
                padding:3px 8px; border-radius:5px; font-size:12px; cursor:pointer;
                font-family:inherit; transition:all 0.1s; position:relative;
            ">${name}<span data-remove-player="${hrid}" style="margin-left:4px; color:#f44; cursor:pointer; font-size:14px;" title="Remove player">\u00d7</span></button>`;
        }
        html += `<button id="mwi-csim-import-btn" style="
            background:rgba(255,255,255,0.04); border:1px solid #333; color:#888;
            padding:3px 8px; border-radius:5px; font-size:11px; cursor:pointer;
            font-family:inherit;" title="Import players from Shykai export string">+ Import</button>`;
        html += this._renderResetControls();
        html += '</div>';
        html += this._renderMissingMembersNote();
        html += this._renderImportSkippedNote();

        // Import paste area (hidden by default)
        html += `<div id="mwi-csim-import-area" style="display:none; margin-bottom:10px;">
            <textarea id="mwi-csim-import-text" placeholder="Paste Shykai export JSON here..." style="
                width:100%; height:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:4px; padding:6px; font-size:11px; font-family:monospace; resize:vertical;
                box-sizing:border-box;"></textarea>
            <div style="display:flex; gap:6px; margin-top:4px;">
                <button id="mwi-csim-import-go" style="
                    background:${ACCENT_BTN_BG}; border:1px solid ${ACCENT_BTN_BORDER}; color:${ACCENT};
                    padding:3px 12px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;
                    font-weight:600;">Import</button>
                <button id="mwi-csim-import-cancel" style="
                    background:rgba(255,255,255,0.04); border:1px solid #333; color:#888;
                    padding:3px 12px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;">Cancel</button>
                <span id="mwi-csim-import-error" style="color:#f44; font-size:11px; align-self:center;"></span>
            </div>
        </div>`;

        // Loadout dropdown + Reset button (skip in skillingMode — loadouts assigned per-skill)
        if (!this.skillingMode) {
            // Read through the bridge: in the packaged multi-bundle build this
            // file's own copy of the store is never fed by the websocket, so a
            // direct getAllSnapshots() returns [] and the picker never renders.
            const allSnapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots();
            const filteredSnapshots = allSnapshots.filter(
                (s) => !s.actionTypeHrid || s.actionTypeHrid === '/action_types/combat'
            );

            html += `<div style="display:flex; align-items:center; gap:6px; margin-bottom:8px;">`;
            if (filteredSnapshots.length > 0) {
                html += `<label style="color:#888; font-size:11px; flex-shrink:0;">Loadout</label>`;
                html += `<select class="toolasha-select" id="mwi-csim-loadout-select" style="
                    flex:1; min-width:0; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                    border-radius:4px; padding:2px 6px; font-size:12px; font-family:inherit;">`;
                html += `<option value=""${!this._selectedLoadoutName ? ' selected' : ''}>— Current Gear —</option>`;
                for (const snap of filteredSnapshots) {
                    const label = snap.name + (snap.actionTypeHrid ? '' : ' (All Skills)');
                    const selected = this._selectedLoadoutName === snap.name ? ' selected' : '';
                    html += `<option value="${snap.name}"${selected}>${label}</option>`;
                }
                html += `</select>`;
            }
            html += `<button id="mwi-csim-reset" style="
                margin-left:auto; background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa;
                padding:2px 8px; border-radius:4px; font-size:11px; cursor:pointer;
                font-family:inherit; flex-shrink:0;">Reset to Current</button>`;
            html += '</div>';
        }

        if (!this.skillingMode) {
            html += this._renderEquipmentSection(dto, gameData);
            html += this._renderAbilitiesSection(dto, gameData);
            html += this._renderConsumablesSection(dto, gameData);
        }
        html += this._renderSkillLevelsSection(dto);
        html += this._renderHouseRoomsSection(dto, gameData);
        html += this._renderGuildShrinesSection(dto);
        html += this._renderScrollsSection(dto);
        html += this._renderAchievementsSection(dto);
        if (this.skillingMode) {
            html += this._renderTokenUpgradesSection(dto);
            html += this._renderCommunityBuffsSection(dto);
        }

        editorArea.innerHTML = html;
        this._wireEditorEvents(editorArea, dto);
    }

    /** @private */
    _renderEquipmentSection(dto, gameData) {
        const itemDetailMap = gameData.itemDetailMap || {};
        const slotOrder = [
            '/equipment_types/head',
            '/equipment_types/body',
            '/equipment_types/legs',
            '/equipment_types/feet',
            '/equipment_types/hands',
            '/equipment_types/main_hand',
            '/equipment_types/two_hand',
            '/equipment_types/off_hand',
            '/equipment_types/pouch',
            '/equipment_types/back',
            '/equipment_types/neck',
            '/equipment_types/earrings',
            '/equipment_types/ring',
            '/equipment_types/charm',
        ];
        const slotLabels = {
            '/equipment_types/head': 'Head',
            '/equipment_types/body': 'Body',
            '/equipment_types/legs': 'Legs',
            '/equipment_types/feet': 'Feet',
            '/equipment_types/hands': 'Hands',
            '/equipment_types/main_hand': 'Main Hand',
            '/equipment_types/two_hand': 'Two Hand',
            '/equipment_types/off_hand': 'Off Hand',
            '/equipment_types/pouch': 'Pouch',
            '/equipment_types/back': 'Back',
            '/equipment_types/neck': 'Neck',
            '/equipment_types/earrings': 'Earrings',
            '/equipment_types/ring': 'Ring',
            '/equipment_types/charm': 'Charm',
        };

        const equippedCount = slotOrder.filter((s) => dto.equipment[s]).length;
        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="equip-section">`;
        html += `<span data-arrow="equip-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Equipment (${equippedCount} items)`;
        html += '</div>';
        html += `<div id="mwi-csim-equip-section" style="display:none;">`;

        for (const slotType of slotOrder) {
            const equip = dto.equipment[slotType];
            const label = slotLabels[slotType] || slotType.split('/').pop();

            if (!equip) {
                html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">`;
                html += `<span style="color:#888; width:70px; flex-shrink:0;">${label}</span>`;
                html += `<span style="color:#555; flex:1; font-style:italic;">Empty</span>`;
                html += `<button data-equipment-slot="${slotType}" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:1px 6px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">add</button>`;
                html += '</div>';
                continue;
            }

            const item = itemDetailMap[equip.hrid];
            const name = item?.name || equip.hrid.split('/').pop();

            html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">`;
            html += `<span style="color:#888; width:70px; flex-shrink:0;">${label}</span>`;
            html += `<span style="color:#e0e0e0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
            html += `<span style="color:#666; font-size:11px;">+</span>`;
            html += `<input type="number" min="0" max="20" value="${equip.enhancementLevel}"
                data-enhance-slot="${slotType}"
                style="width:36px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += `<button data-equipment-slot="${slotType}" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:1px 6px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">change</button>`;
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /** @private */
    _renderAbilitiesSection(dto, gameData) {
        const abilityDetailMap = gameData.abilityDetailMap || {};
        const abilityCount = dto.abilities.filter((a) => a).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="ability-section">`;
        html += `<span data-arrow="ability-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Abilities (${abilityCount} equipped)`;
        html += '</div>';
        html += `<div id="mwi-csim-ability-section" style="display:none;">`;

        const maxSlots = 5;
        const slotCount = Math.max(dto.abilities.length, maxSlots);

        for (let i = 0; i < slotCount; i++) {
            const ability = dto.abilities[i];
            const slotLabel = i === 0 ? 'Special' : `Slot ${i}`;

            if (!ability) {
                html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">`;
                html += `<span style="color:#888; width:50px; flex-shrink:0;">${slotLabel}</span>`;
                html += `<span style="color:#555; flex:1; font-style:italic;">Empty</span>`;
                html += `<button data-ability-slot="${i}" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:1px 6px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">add</button>`;
                html += '</div>';
                continue;
            }

            const detail = abilityDetailMap[ability.hrid];
            const name = detail?.name || ability.hrid.split('/').pop();

            html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">`;
            html += `<span style="color:#888; width:50px; flex-shrink:0;">${slotLabel}</span>`;
            html += `<span style="color:#e0e0e0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
            html += `<span style="color:#666; font-size:11px;">Lv</span>`;
            html += `<input type="number" min="1" max="200" value="${ability.level}"
                data-ability-idx="${i}"
                style="width:42px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += this._renderTriggerButton('abilities', i, ability, gameData);
            html += `<button data-ability-slot="${i}" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:1px 6px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">change</button>`;
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /** @private */
    _renderConsumablesSection(dto, gameData) {
        const itemDetailMap = gameData?.itemDetailMap || {};
        const foodCount = dto.food.filter((f) => f).length;
        const drinkCount = dto.drinks.filter((d) => d).length;

        let html = '<div style="margin-bottom:10px;">';
        html +=
            '<div style="color:' +
            ACCENT +
            '; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="consumable-section">';
        html +=
            '<span data-arrow="consumable-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Consumables (' +
            foodCount +
            ' food, ' +
            drinkCount +
            ' drinks)';
        html += '</div>';
        html += '<div id="mwi-csim-consumable-section" style="display:none;">';

        html += '<div style="color:#888; font-size:11px; margin-bottom:3px;">Food</div>';
        for (let i = 0; i < 3; i++) {
            const item = dto.food[i];
            const name = item ? itemDetailMap[item.hrid]?.name || item.hrid.split('/').pop() : 'Empty';
            const nameColor = item ? '#e0e0e0' : '#555';
            html += '<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">';
            html += '<span style="color:#666; width:16px; flex-shrink:0;">' + (i + 1) + '</span>';
            html +=
                '<span style="color:' +
                nameColor +
                '; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
                name +
                '</span>';
            if (item) {
                html += this._renderTriggerButton('food', i, item, gameData);
            }
            html +=
                '<button data-consumable-slot="food-' +
                i +
                '" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:1px 6px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">change</button>';
            html += '</div>';
        }

        html += '<div style="color:#888; font-size:11px; margin-bottom:3px; margin-top:6px;">Drinks</div>';
        for (let i = 0; i < 3; i++) {
            const item = dto.drinks[i];
            const name = item ? itemDetailMap[item.hrid]?.name || item.hrid.split('/').pop() : 'Empty';
            const nameColor = item ? '#e0e0e0' : '#555';
            html += '<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">';
            html += '<span style="color:#666; width:16px; flex-shrink:0;">' + (i + 1) + '</span>';
            html +=
                '<span style="color:' +
                nameColor +
                '; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' +
                name +
                '</span>';
            if (item) {
                html += this._renderTriggerButton('drinks', i, item, gameData);
            }
            html +=
                '<button data-consumable-slot="drinks-' +
                i +
                '" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:1px 6px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">change</button>';
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /** @private */
    _openConsumablePicker(slotType, slotIndex, dto, gameData) {
        document.getElementById('mwi-csim-consumable-picker')?.remove();
        document.getElementById('mwi-csim-consumable-backdrop')?.remove();

        const itemDetailMap = gameData?.itemDetailMap || {};
        const isFood = slotType === 'food';

        const getConsumableType = (hrid) => {
            const detail = itemDetailMap[hrid]?.consumableDetail;
            if (!detail) return null;
            const hp = detail.hitpointRestore || 0;
            const mp = detail.manapointRestore || 0;
            const dur = detail.recoveryDuration || 0;
            if (hp > 0) return dur > 0 ? 'hp_over_time' : 'hp_instant';
            if (mp > 0) return dur > 0 ? 'mp_over_time' : 'mp_instant';
            const buffs = detail.buffs || [];
            if (buffs.length > 0) return 'buff:' + (buffs[0].uniqueHrid || 'unknown');
            return null;
        };

        const usedTypes = new Set();
        const slots = dto[slotType] || [];
        for (let i = 0; i < slots.length; i++) {
            if (i === slotIndex || !slots[i]) continue;
            const t = getConsumableType(slots[i].hrid);
            if (t) usedTypes.add(t);
        }

        const items = [];
        for (const [hrid, item] of Object.entries(itemDetailMap)) {
            if (!item.consumableDetail) continue;
            const cat = item.categoryHrid || '';
            const isFoodItem = cat.includes('food');
            const isDrinkItem =
                (cat.includes('drink') || hrid.includes('coffee')) && item.consumableDetail.cooldownDuration > 0;

            // In lab mode, filter out coffees from drink picker (they come from crate selectors)
            if (this.labMode && !isFood && (hrid.includes('coffee') || cat.includes('coffee'))) continue;

            if (isFood ? isFoodItem : isDrinkItem) {
                const cType = getConsumableType(hrid);
                const conflict = cType && usedTypes.has(cType);
                const itemLevel = item.itemLevel || 0;

                let categoryLabel;
                if (isFood) {
                    const hp = item.consumableDetail.hitpointRestore || 0;
                    const mp = item.consumableDetail.manapointRestore || 0;
                    const dur = item.consumableDetail.recoveryDuration || 0;
                    if (hp > 0 && dur > 0) categoryLabel = 'HP Over Time';
                    else if (hp > 0) categoryLabel = 'HP Instant';
                    else if (mp > 0 && dur > 0) categoryLabel = 'MP Over Time';
                    else if (mp > 0) categoryLabel = 'MP Instant';
                    else categoryLabel = 'Other';
                } else {
                    const buffs = item.consumableDetail.buffs || [];
                    if (buffs.length > 0) {
                        const buffName = buffs[0].uniqueHrid?.split('/').pop()?.replace(/_/g, ' ') || 'buff';
                        categoryLabel = buffName.charAt(0).toUpperCase() + buffName.slice(1);
                    } else categoryLabel = 'Other';
                }

                items.push({ hrid, name: item.name || hrid.split('/').pop(), conflict, itemLevel, categoryLabel });
            }
        }

        items.sort((a, b) => {
            const catCmp = a.categoryLabel.localeCompare(b.categoryLabel);
            if (catCmp !== 0) return catCmp;
            return b.itemLevel - a.itemLevel;
        });

        const popup = document.createElement('div');
        popup.id = 'mwi-csim-consumable-picker';
        popup.style.cssText =
            `position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:${PANEL_Z_CAP + 2};` +
            'background:rgba(10,10,20,0.97); border:2px solid rgba(74,158,255,0.5); border-radius:10px;' +
            'width:350px; max-height:400px; display:flex; flex-direction:column;' +
            "font-family:'Segoe UI',sans-serif; color:#e0e0e0; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,0.6);";

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; justify-content:space-between; align-items:center; padding:8px 14px; border-bottom:1px solid rgba(74,158,255,0.3); flex-shrink:0;';
        header.innerHTML =
            '<span style="font-weight:700; font-size:13px; color:#4a9eff;">Select ' +
            (isFood ? 'Food' : 'Drink') +
            '</span>' +
            '<button id="mwi-csim-picker-close" style="background:none; border:none; color:#aaa; font-size:20px; cursor:pointer; padding:0; line-height:1;">\u00d7</button>';
        popup.appendChild(header);

        const searchDiv = document.createElement('div');
        searchDiv.style.cssText = 'padding:6px 14px; flex-shrink:0;';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Search...';
        searchInput.style.cssText =
            'width:100%; padding:5px 8px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:6px; color:#e0e0e0; font-size:12px; font-family:inherit; outline:none;';
        searchDiv.appendChild(searchInput);
        popup.appendChild(searchDiv);

        const listEl = document.createElement('div');
        listEl.style.cssText = 'flex:1; overflow-y:auto; padding:4px 14px;';
        popup.appendChild(listEl);

        const currentHrid = dto[slotType][slotIndex]?.hrid || '';

        const renderList = (query) => {
            const lower = query.toLowerCase();
            const filtered = query
                ? items.filter(
                      (i) => i.name.toLowerCase().includes(lower) || i.categoryLabel.toLowerCase().includes(lower)
                  )
                : items;

            let html =
                '<div data-pick-hrid="" style="display:flex; align-items:center; gap:8px; padding:4px; cursor:pointer; border-bottom:1px solid #1a1a2e; color:#888; font-style:italic;"' +
                ' onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'\'">Empty (clear slot)</div>';

            let lastCategory = '';
            for (const item of filtered.slice(0, 80)) {
                if (item.categoryLabel !== lastCategory) {
                    lastCategory = item.categoryLabel;
                    html +=
                        '<div style="padding:6px 0 2px; font-size:10px; font-weight:700; color:' +
                        ACCENT +
                        '; border-bottom:1px solid #2a2a4e; margin-top:4px;">' +
                        item.categoryLabel +
                        '</div>';
                }

                const isCurrent = item.hrid === currentHrid;
                const lvlTag =
                    '<span style="color:#666; font-size:10px; margin-left:auto; flex-shrink:0;">Lv ' +
                    item.itemLevel +
                    '</span>';
                if (item.conflict) {
                    html +=
                        '<div style="display:flex; align-items:center; gap:8px; padding:3px 4px; border-bottom:1px solid #1a1a2e; color:#555; cursor:default;">' +
                        item.name +
                        ' <span style="font-size:10px; color:#664;">(in use)</span>' +
                        lvlTag +
                        '</div>';
                } else {
                    const color = isCurrent ? '#4a9eff' : '#ccc';
                    const indicator = isCurrent ? ' <span style="color:#4a9eff;">\u25cf</span>' : '';
                    html +=
                        '<div data-pick-hrid="' +
                        item.hrid +
                        '" style="display:flex; align-items:center; gap:8px; padding:3px 4px; cursor:pointer; border-bottom:1px solid #1a1a2e; color:' +
                        color +
                        ';"' +
                        ' onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'\'">' +
                        item.name +
                        indicator +
                        lvlTag +
                        '</div>';
                }
            }
            if (filtered.length > 80) {
                html +=
                    '<div style="color:#666; text-align:center; padding:6px;">...' +
                    (filtered.length - 80) +
                    ' more</div>';
            }
            listEl.innerHTML = html;

            listEl.querySelectorAll('[data-pick-hrid]').forEach((row) => {
                row.addEventListener('click', () => {
                    const hrid = row.dataset.pickHrid;
                    if (hrid) {
                        dto[slotType][slotIndex] = { hrid, triggers: null };
                    } else {
                        dto[slotType][slotIndex] = null;
                    }
                    closePicker();
                    this.renderEditor();
                });
            });
        };

        let searchTimeout;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => renderList(searchInput.value.trim()), 150);
        });

        const closePicker = () => {
            popup.remove();
            document.getElementById('mwi-csim-consumable-backdrop')?.remove();
        };

        popup.querySelector('#mwi-csim-picker-close').addEventListener('click', closePicker);

        const backdrop = document.createElement('div');
        backdrop.id = 'mwi-csim-consumable-backdrop';
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', closePicker);

        document.body.appendChild(backdrop);
        document.body.appendChild(popup);
        renderList('');
        searchInput.focus();
    }

    /** @private */
    _openEquipmentPicker(slotType, dto, gameData) {
        document.getElementById('mwi-csim-equipment-picker')?.remove();
        document.getElementById('mwi-csim-equipment-backdrop')?.remove();

        const itemDetailMap = gameData?.itemDetailMap || {};
        const slotName = slotType.split('/').pop().replace(/_/g, ' ');

        const items = [];
        for (const [hrid, item] of Object.entries(itemDetailMap)) {
            if (item.equipmentDetail?.type !== slotType) continue;
            const levelReqs = item.equipmentDetail.levelRequirements || [];
            const primaryReq = levelReqs[0];
            const reqLevel = primaryReq?.level || 0;
            const reqSkill = primaryReq?.skillHrid?.split('/').pop() || '';

            let categoryLabel;
            if (reqSkill === 'attack') categoryLabel = 'Attack';
            else if (reqSkill === 'defense') categoryLabel = 'Defense';
            else if (reqSkill === 'ranged') categoryLabel = 'Ranged';
            else if (reqSkill === 'magic') categoryLabel = 'Magic';
            else categoryLabel = 'General';

            items.push({
                hrid,
                name: item.name || hrid.split('/').pop(),
                itemLevel: item.itemLevel || 0,
                reqLevel,
                categoryLabel,
            });
        }

        items.sort((a, b) => {
            const catCmp = a.categoryLabel.localeCompare(b.categoryLabel);
            if (catCmp !== 0) return catCmp;
            return b.itemLevel - a.itemLevel;
        });

        const popup = document.createElement('div');
        popup.id = 'mwi-csim-equipment-picker';
        popup.style.cssText =
            `position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:${PANEL_Z_CAP + 2};` +
            'background:rgba(10,10,20,0.97); border:2px solid rgba(74,158,255,0.5); border-radius:10px;' +
            'width:350px; max-height:400px; display:flex; flex-direction:column;' +
            "font-family:'Segoe UI',sans-serif; color:#e0e0e0; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,0.6);";

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; justify-content:space-between; align-items:center; padding:8px 14px; border-bottom:1px solid rgba(74,158,255,0.3); flex-shrink:0;';
        header.innerHTML =
            `<span style="font-weight:700; font-size:13px; color:${ACCENT};">Select ${slotName}</span>` +
            '<button id="mwi-csim-equip-picker-close" style="background:none; border:none; color:#aaa; font-size:20px; cursor:pointer; padding:0; line-height:1;">\u00d7</button>';
        popup.appendChild(header);

        const searchDiv = document.createElement('div');
        searchDiv.style.cssText = 'padding:6px 14px; flex-shrink:0;';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Search...';
        searchInput.style.cssText =
            'width:100%; padding:5px 8px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:6px; color:#e0e0e0; font-size:12px; font-family:inherit; outline:none;';
        searchDiv.appendChild(searchInput);
        popup.appendChild(searchDiv);

        const listEl = document.createElement('div');
        listEl.style.cssText = 'flex:1; overflow-y:auto; padding:4px 14px;';
        popup.appendChild(listEl);

        const currentHrid = dto.equipment[slotType]?.hrid || '';

        const renderList = (query) => {
            const lower = query.toLowerCase();
            const filtered = query ? items.filter((i) => i.name.toLowerCase().includes(lower)) : items;

            let html =
                '<div data-pick-hrid="" style="display:flex; align-items:center; gap:8px; padding:4px; cursor:pointer; border-bottom:1px solid #1a1a2e; color:#888; font-style:italic;"' +
                ' onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'\'">Empty (remove slot)</div>';

            let lastCategory = '';
            for (const item of filtered.slice(0, 100)) {
                if (item.categoryLabel !== lastCategory) {
                    lastCategory = item.categoryLabel;
                    html += `<div style="padding:6px 0 2px; font-size:10px; font-weight:700; color:${ACCENT}; border-bottom:1px solid #2a2a4e; margin-top:4px;">${item.categoryLabel}</div>`;
                }

                const isCurrent = item.hrid === currentHrid;
                const color = isCurrent ? ACCENT : '#ccc';
                const indicator = isCurrent ? ` <span style="color:${ACCENT};">\u25cf</span>` : '';
                const lvlTag = `<span style="color:#666; font-size:10px; margin-left:auto; flex-shrink:0;">Lv ${item.reqLevel}</span>`;

                html +=
                    `<div data-pick-hrid="${item.hrid}" style="display:flex; align-items:center; gap:8px; padding:3px 4px; cursor:pointer; border-bottom:1px solid #1a1a2e; color:${color};"` +
                    ' onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'\'">' +
                    item.name +
                    indicator +
                    lvlTag +
                    '</div>';
            }
            if (filtered.length > 100) {
                html += `<div style="color:#666; text-align:center; padding:6px;">...${filtered.length - 100} more</div>`;
            }
            listEl.innerHTML = html;

            listEl.querySelectorAll('[data-pick-hrid]').forEach((row) => {
                row.addEventListener('click', () => {
                    const hrid = row.dataset.pickHrid;
                    if (hrid) {
                        dto.equipment[slotType] = { hrid, enhancementLevel: 0 };
                    } else {
                        delete dto.equipment[slotType];
                    }
                    closePicker();
                    this.renderEditor();
                });
            });
        };

        let searchTimeout;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => renderList(searchInput.value.trim()), 150);
        });

        const closePicker = () => {
            popup.remove();
            document.getElementById('mwi-csim-equipment-backdrop')?.remove();
        };

        popup.querySelector('#mwi-csim-equip-picker-close').addEventListener('click', closePicker);

        const backdrop = document.createElement('div');
        backdrop.id = 'mwi-csim-equipment-backdrop';
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', closePicker);

        document.body.appendChild(backdrop);
        document.body.appendChild(popup);
        renderList('');
        searchInput.focus();
    }

    /** @private */
    _openAbilityPicker(slotIndex, dto, gameData) {
        document.getElementById('mwi-csim-ability-picker')?.remove();
        document.getElementById('mwi-csim-ability-backdrop')?.remove();

        const abilityDetailMap = gameData?.abilityDetailMap || {};
        const isSpecialSlot = slotIndex === 0;

        const usedHrids = new Set();
        for (let i = 0; i < dto.abilities.length; i++) {
            if (i === slotIndex || !dto.abilities[i]) continue;
            usedHrids.add(dto.abilities[i].hrid);
        }

        const items = [];
        for (const [hrid, ability] of Object.entries(abilityDetailMap)) {
            if (isSpecialSlot && !ability.isSpecialAbility) continue;
            if (!isSpecialSlot && ability.isSpecialAbility) continue;

            const effects = ability.abilityEffects || [];
            const combatStyle = effects[0]?.combatStyleHrid?.split('/').pop() || '';
            let categoryLabel;
            if (combatStyle === 'stab' || combatStyle === 'slash' || combatStyle === 'smash') categoryLabel = 'Melee';
            else if (combatStyle === 'ranged') categoryLabel = 'Ranged';
            else if (combatStyle === 'magic') categoryLabel = 'Magic';
            else categoryLabel = 'Other';

            items.push({
                hrid,
                name: ability.name || hrid.split('/').pop(),
                categoryLabel,
                conflict: usedHrids.has(hrid),
            });
        }

        items.sort((a, b) => {
            const catCmp = a.categoryLabel.localeCompare(b.categoryLabel);
            if (catCmp !== 0) return catCmp;
            return a.name.localeCompare(b.name);
        });

        const popup = document.createElement('div');
        popup.id = 'mwi-csim-ability-picker';
        popup.style.cssText =
            `position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:${PANEL_Z_CAP + 2};` +
            'background:rgba(10,10,20,0.97); border:2px solid rgba(74,158,255,0.5); border-radius:10px;' +
            'width:350px; max-height:400px; display:flex; flex-direction:column;' +
            "font-family:'Segoe UI',sans-serif; color:#e0e0e0; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,0.6);";

        const slotLabel = isSpecialSlot ? 'Special Ability' : `Ability Slot ${slotIndex}`;
        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; justify-content:space-between; align-items:center; padding:8px 14px; border-bottom:1px solid rgba(74,158,255,0.3); flex-shrink:0;';
        header.innerHTML =
            `<span style="font-weight:700; font-size:13px; color:${ACCENT};">Select ${slotLabel}</span>` +
            '<button id="mwi-csim-ability-picker-close" style="background:none; border:none; color:#aaa; font-size:20px; cursor:pointer; padding:0; line-height:1;">\u00d7</button>';
        popup.appendChild(header);

        const searchDiv = document.createElement('div');
        searchDiv.style.cssText = 'padding:6px 14px; flex-shrink:0;';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Search...';
        searchInput.style.cssText =
            'width:100%; padding:5px 8px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15);' +
            'border-radius:6px; color:#e0e0e0; font-size:12px; font-family:inherit; outline:none;';
        searchDiv.appendChild(searchInput);
        popup.appendChild(searchDiv);

        const listEl = document.createElement('div');
        listEl.style.cssText = 'flex:1; overflow-y:auto; padding:4px 14px;';
        popup.appendChild(listEl);

        const currentHrid = dto.abilities[slotIndex]?.hrid || '';

        const renderList = (query) => {
            const lower = query.toLowerCase();
            const filtered = query ? items.filter((i) => i.name.toLowerCase().includes(lower)) : items;

            let html =
                '<div data-pick-hrid="" style="display:flex; align-items:center; gap:8px; padding:4px; cursor:pointer; border-bottom:1px solid #1a1a2e; color:#888; font-style:italic;"' +
                ' onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'\'">Empty (clear slot)</div>';

            let lastCategory = '';
            for (const item of filtered) {
                if (item.categoryLabel !== lastCategory) {
                    lastCategory = item.categoryLabel;
                    html += `<div style="padding:6px 0 2px; font-size:10px; font-weight:700; color:${ACCENT}; border-bottom:1px solid #2a2a4e; margin-top:4px;">${item.categoryLabel}</div>`;
                }

                if (item.conflict) {
                    html +=
                        '<div style="display:flex; align-items:center; gap:8px; padding:3px 4px; border-bottom:1px solid #1a1a2e; color:#555; cursor:default;">' +
                        item.name +
                        ' <span style="font-size:10px; color:#664;">(in use)</span></div>';
                } else {
                    const isCurrent = item.hrid === currentHrid;
                    const color = isCurrent ? ACCENT : '#ccc';
                    const indicator = isCurrent ? ` <span style="color:${ACCENT};">\u25cf</span>` : '';
                    html +=
                        `<div data-pick-hrid="${item.hrid}" style="display:flex; align-items:center; gap:8px; padding:3px 4px; cursor:pointer; border-bottom:1px solid #1a1a2e; color:${color};"` +
                        ' onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'\'">' +
                        item.name +
                        indicator +
                        '</div>';
                }
            }
            listEl.innerHTML = html;

            listEl.querySelectorAll('[data-pick-hrid]').forEach((row) => {
                row.addEventListener('click', () => {
                    const hrid = row.dataset.pickHrid;
                    const existingLevel = dto.abilities[slotIndex]?.level || 1;
                    if (hrid) {
                        while (dto.abilities.length <= slotIndex) dto.abilities.push(null);
                        dto.abilities[slotIndex] = { hrid, level: existingLevel, triggers: null };
                    } else if (slotIndex < dto.abilities.length) {
                        dto.abilities[slotIndex] = null;
                    }
                    closePicker();
                    this.renderEditor();
                });
            });
        };

        let searchTimeout;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => renderList(searchInput.value.trim()), 150);
        });

        const closePicker = () => {
            popup.remove();
            document.getElementById('mwi-csim-ability-backdrop')?.remove();
        };

        popup.querySelector('#mwi-csim-ability-picker-close').addEventListener('click', closePicker);

        const backdrop = document.createElement('div');
        backdrop.id = 'mwi-csim-ability-backdrop';
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', closePicker);

        document.body.appendChild(backdrop);
        document.body.appendChild(popup);
        renderList('');
        searchInput.focus();
    }

    /**
     * Resolve the default combat triggers for an ability or consumable.
     * @private
     * @param {string} slotType - 'abilities', 'food', or 'drinks'
     * @param {string} hrid - Ability or item HRID
     * @param {Object} gameData - Game data payload
     * @returns {Array<Object>} Default trigger definitions (possibly empty)
     */
    _getDefaultTriggers(slotType, hrid, gameData) {
        if (slotType === 'abilities') {
            return gameData?.abilityDetailMap?.[hrid]?.defaultCombatTriggers || [];
        }
        return gameData?.itemDetailMap?.[hrid]?.consumableDetail?.defaultCombatTriggers || [];
    }

    /**
     * Build a human-readable summary of a trigger list.
     * @private
     * @param {Array<Object>} triggers - Trigger definitions
     * @param {Object} gameData - Game data payload
     * @returns {string} One line per trigger
     */
    _describeTriggers(triggers, gameData) {
        if (!triggers?.length) return 'Always activates';
        const depMap = gameData?.combatTriggerDependencyDetailMap || {};
        const condMap = gameData?.combatTriggerConditionDetailMap || {};
        const compMap = gameData?.combatTriggerComparatorDetailMap || {};
        const symbols = { greater_than_equal: '≥', less_than_equal: '≤' };

        return triggers
            .map((t) => {
                const dep = depMap[t.dependencyHrid]?.name || t.dependencyHrid?.split('/').pop()?.replace(/_/g, ' ');
                const cond = condMap[t.conditionHrid]?.name || t.conditionHrid?.split('/').pop()?.replace(/_/g, ' ');
                const compKey = t.comparatorHrid?.split('/').pop();
                const comp = symbols[compKey] || compMap[t.comparatorHrid]?.name || compKey?.replace(/_/g, ' ');
                const usesValue = compKey === 'greater_than_equal' || compKey === 'less_than_equal';
                return `${dep}: ${cond} ${comp}${usesValue ? ' ' + (t.value || 0) : ''}`;
            })
            .join('\n');
    }

    /**
     * Render the trigger edit button for an ability/consumable row.
     * @private
     * @param {string} slotType - 'abilities', 'food', or 'drinks'
     * @param {number} slotIndex - Slot index
     * @param {Object} slotItem - DTO slot entry ({hrid, triggers, ...})
     * @param {Object} gameData - Game data payload
     * @returns {string} Button HTML
     */
    _renderTriggerButton(slotType, slotIndex, slotItem, gameData) {
        const hasCustom = Array.isArray(slotItem.triggers);
        const activeTriggers = hasCustom
            ? slotItem.triggers
            : this._getDefaultTriggers(slotType, slotItem.hrid, gameData);
        const summary = this._describeTriggers(activeTriggers, gameData);
        const title = `Triggers (${hasCustom ? 'custom' : 'default'}) — click to edit\n${summary}`
            .replace(/"/g, '&quot;')
            .replace(/\n/g, '&#10;');
        const color = hasCustom ? ACCENT : '#aaa';
        const border = hasCustom ? ACCENT_BTN_BORDER : '#444';
        return `<button data-trigger-slot="${slotType}-${slotIndex}" title="${title}" style="background:rgba(255,255,255,0.06); border:1px solid ${border}; color:${color}; padding:1px 5px; border-radius:3px; font-size:11px; cursor:pointer; font-family:inherit;">⚡</button>`;
    }

    /** @private */
    _openTriggerEditor(slotType, slotIndex, dto, gameData) {
        document.getElementById('mwi-csim-trigger-editor')?.remove();
        document.getElementById('mwi-csim-trigger-backdrop')?.remove();

        const slotItem = dto[slotType]?.[slotIndex];
        if (!slotItem) return;

        const isAbility = slotType === 'abilities';
        const detail = isAbility ? gameData.abilityDetailMap?.[slotItem.hrid] : gameData.itemDetailMap?.[slotItem.hrid];
        const itemName = detail?.name || slotItem.hrid.split('/').pop();
        const defaults = this._getDefaultTriggers(slotType, slotItem.hrid, gameData);

        const depMap = gameData.combatTriggerDependencyDetailMap || {};
        const condMap = gameData.combatTriggerConditionDetailMap || {};
        const compMap = gameData.combatTriggerComparatorDetailMap || {};

        const sortedHrids = (map) =>
            Object.keys(map).sort((a, b) => (map[a]?.sortIndex || 0) - (map[b]?.sortIndex || 0));
        const depHrids = sortedHrids(depMap);
        const condHrids = sortedHrids(condMap);
        const compHrids = sortedHrids(compMap);

        const displayName = (map, hrid) => map[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');

        // Conditions only usable with multi-target dependencies (all allies / all enemies)
        const MULTI_ONLY_CONDITIONS = new Set([
            '/combat_trigger_conditions/number_of_active_units',
            '/combat_trigger_conditions/number_of_dead_units',
            '/combat_trigger_conditions/lowest_hp_percentage',
        ]);
        const conditionAllowed = (condHrid, depHrid) => {
            if (!depMap[depHrid]?.isSingleTarget) return true;
            const cond = condMap[condHrid];
            if (typeof cond?.isSingleTarget === 'boolean') return cond.isSingleTarget;
            return !MULTI_ONLY_CONDITIONS.has(condHrid);
        };
        const comparatorsFor = (condHrid) => {
            const allowed = condMap[condHrid]?.allowedComparatorHrids;
            return Array.isArray(allowed) && allowed.length ? allowed : compHrids;
        };
        const valuelessComparator = (compHrid) =>
            compHrid === '/combat_trigger_comparators/is_active' ||
            compHrid === '/combat_trigger_comparators/is_inactive';

        const MAX_TRIGGERS = 4;
        const toRow = (t) => ({
            dependencyHrid: t.dependencyHrid,
            conditionHrid: t.conditionHrid,
            comparatorHrid: t.comparatorHrid,
            value: t.value || 0,
        });
        const rows = (Array.isArray(slotItem.triggers) ? slotItem.triggers : defaults).map(toRow);

        const newRow = () => {
            const dep = depMap['/combat_trigger_dependencies/self'] ? '/combat_trigger_dependencies/self' : depHrids[0];
            const cond = condHrids.find((c) => conditionAllowed(c, dep)) || condHrids[0];
            const comp = comparatorsFor(cond)[0];
            return { dependencyHrid: dep, conditionHrid: cond, comparatorHrid: comp, value: 0 };
        };

        const popup = document.createElement('div');
        popup.id = 'mwi-csim-trigger-editor';
        popup.style.cssText =
            `position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:${PANEL_Z_CAP + 2};` +
            'background:rgba(10,10,20,0.97); border:2px solid rgba(74,158,255,0.5); border-radius:10px;' +
            'width:400px; max-height:440px; display:flex; flex-direction:column;' +
            "font-family:'Segoe UI',sans-serif; color:#e0e0e0; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,0.6);";

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; justify-content:space-between; align-items:center; padding:8px 14px; border-bottom:1px solid rgba(74,158,255,0.3); flex-shrink:0;';
        header.innerHTML =
            `<span style="font-weight:700; font-size:13px; color:${ACCENT};">Triggers — ${itemName}</span>` +
            '<button id="mwi-csim-trigger-close" style="background:none; border:none; color:#aaa; font-size:20px; cursor:pointer; padding:0; line-height:1;">×</button>';
        popup.appendChild(header);

        const listEl = document.createElement('div');
        listEl.style.cssText = 'flex:1; overflow-y:auto; padding:8px 14px;';
        popup.appendChild(listEl);

        const footer = document.createElement('div');
        footer.style.cssText =
            'display:flex; align-items:center; gap:6px; padding:8px 14px; border-top:1px solid rgba(74,158,255,0.3); flex-shrink:0;';
        footer.innerHTML =
            `<button id="mwi-csim-trigger-add" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 10px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;">+ Add</button>` +
            `<button id="mwi-csim-trigger-default" style="background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 10px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;">Default</button>` +
            `<button id="mwi-csim-trigger-save" style="margin-left:auto; background:${ACCENT_BTN_BG}; border:1px solid ${ACCENT_BTN_BORDER}; color:${ACCENT}; padding:3px 14px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit; font-weight:600;">Save</button>`;
        popup.appendChild(footer);

        const selectStyle =
            'flex:1; min-width:0; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:2px 4px; font-size:11px; font-family:inherit;';

        const buildOptions = (hrids, selected, labelFor) =>
            hrids
                .map((h) => `<option value="${h}"${h === selected ? ' selected' : ''}>${labelFor(h)}</option>`)
                .join('');

        const renderRows = () => {
            if (!rows.length) {
                listEl.innerHTML =
                    '<div style="color:#888; font-style:italic; padding:10px 0; text-align:center;">No triggers — always activates.</div>';
            } else {
                let html = '';
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    const condOptions = condHrids.filter((c) => conditionAllowed(c, row.dependencyHrid));
                    const compOptions = comparatorsFor(row.conditionHrid);
                    const hideValue = valuelessComparator(row.comparatorHrid);

                    html += `<div style="border:1px solid #2a2a4e; border-radius:5px; padding:6px; margin-bottom:6px;">`;
                    html += `<div style="display:flex; gap:4px; align-items:center; margin-bottom:4px;">`;
                    html += `<select class="toolasha-select" data-trig-dep="${i}" style="${selectStyle}">${buildOptions(depHrids, row.dependencyHrid, (h) => displayName(depMap, h))}</select>`;
                    html += `<select class="toolasha-select" data-trig-cond="${i}" style="${selectStyle}">${buildOptions(condOptions, row.conditionHrid, (h) => displayName(condMap, h))}</select>`;
                    html += `<button data-trig-remove="${i}" title="Remove trigger" style="background:none; border:none; color:#f44; font-size:15px; cursor:pointer; padding:0 2px; line-height:1; flex-shrink:0;">×</button>`;
                    html += `</div>`;
                    html += `<div style="display:flex; gap:4px; align-items:center;">`;
                    html += `<select class="toolasha-select" data-trig-comp="${i}" style="${selectStyle}">${buildOptions(compOptions, row.comparatorHrid, (h) => displayName(compMap, h))}</select>`;
                    html += `<input type="number" data-trig-value="${i}" value="${row.value}" min="0"
                        style="width:70px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px;
                        padding:2px 4px; font-size:11px; text-align:center; ${hideValue ? 'visibility:hidden;' : ''}">`;
                    html += `</div></div>`;
                }
                listEl.innerHTML = html;
            }

            const addBtn = footer.querySelector('#mwi-csim-trigger-add');
            addBtn.disabled = rows.length >= MAX_TRIGGERS;
            addBtn.style.opacity = addBtn.disabled ? '0.4' : '1';
            addBtn.style.cursor = addBtn.disabled ? 'default' : 'pointer';

            listEl.querySelectorAll('[data-trig-dep]').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const i = parseInt(sel.dataset.trigDep);
                    rows[i].dependencyHrid = sel.value;
                    if (!conditionAllowed(rows[i].conditionHrid, sel.value)) {
                        rows[i].conditionHrid = condHrids.find((c) => conditionAllowed(c, sel.value)) || condHrids[0];
                    }
                    const comps = comparatorsFor(rows[i].conditionHrid);
                    if (!comps.includes(rows[i].comparatorHrid)) {
                        rows[i].comparatorHrid = comps[0];
                    }
                    renderRows();
                });
            });
            listEl.querySelectorAll('[data-trig-cond]').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const i = parseInt(sel.dataset.trigCond);
                    rows[i].conditionHrid = sel.value;
                    const comps = comparatorsFor(sel.value);
                    if (!comps.includes(rows[i].comparatorHrid)) {
                        rows[i].comparatorHrid = comps[0];
                    }
                    renderRows();
                });
            });
            listEl.querySelectorAll('[data-trig-comp]').forEach((sel) => {
                sel.addEventListener('change', () => {
                    const i = parseInt(sel.dataset.trigComp);
                    rows[i].comparatorHrid = sel.value;
                    renderRows();
                });
            });
            listEl.querySelectorAll('[data-trig-value]').forEach((input) => {
                input.addEventListener('change', () => {
                    const i = parseInt(input.dataset.trigValue);
                    const val = Math.max(0, parseInt(input.value) || 0);
                    input.value = val;
                    rows[i].value = val;
                });
            });
            listEl.querySelectorAll('[data-trig-remove]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    rows.splice(parseInt(btn.dataset.trigRemove), 1);
                    renderRows();
                });
            });
        };

        const closeEditor = () => {
            popup.remove();
            document.getElementById('mwi-csim-trigger-backdrop')?.remove();
        };

        footer.querySelector('#mwi-csim-trigger-add').addEventListener('click', () => {
            if (rows.length >= MAX_TRIGGERS) return;
            rows.push(newRow());
            renderRows();
        });
        footer.querySelector('#mwi-csim-trigger-default').addEventListener('click', () => {
            rows.length = 0;
            for (const t of defaults) rows.push(toRow(t));
            renderRows();
        });
        footer.querySelector('#mwi-csim-trigger-save').addEventListener('click', () => {
            const normalized = rows.map((r) => ({ ...r, value: Number(r.value) || 0 }));
            const matchesDefault =
                normalized.length === defaults.length &&
                normalized.every((r, i) => {
                    const d = defaults[i];
                    return (
                        r.dependencyHrid === d.dependencyHrid &&
                        r.conditionHrid === d.conditionHrid &&
                        r.comparatorHrid === d.comparatorHrid &&
                        r.value === (Number(d.value) || 0)
                    );
                });
            slotItem.triggers = matchesDefault ? null : normalized;
            closeEditor();
            this.renderEditor();
        });
        popup.querySelector('#mwi-csim-trigger-close').addEventListener('click', closeEditor);

        const backdrop = document.createElement('div');
        backdrop.id = 'mwi-csim-trigger-backdrop';
        backdrop.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; z-index:${PANEL_Z_CAP + 1};`;
        backdrop.addEventListener('click', closeEditor);

        document.body.appendChild(backdrop);
        document.body.appendChild(popup);
        renderRows();
    }

    /** @private */
    _renderSkillLevelsSection(dto) {
        const combatSkills = [
            { key: 'staminaLevel', label: 'Stamina' },
            { key: 'intelligenceLevel', label: 'Intelligence' },
            { key: 'attackLevel', label: 'Attack' },
            { key: 'meleeLevel', label: 'Melee' },
            { key: 'defenseLevel', label: 'Defense' },
            { key: 'rangedLevel', label: 'Ranged' },
            { key: 'magicLevel', label: 'Magic' },
        ];
        const skillingSkills = [
            { key: 'woodcuttingLevel', label: 'Woodcutting' },
            { key: 'foragingLevel', label: 'Foraging' },
            { key: 'milkingLevel', label: 'Milking' },
            { key: 'cookingLevel', label: 'Cooking' },
            { key: 'brewingLevel', label: 'Brewing' },
            { key: 'cheesesmithingLevel', label: 'Cheesesmithing' },
            { key: 'craftingLevel', label: 'Crafting' },
            { key: 'tailoringLevel', label: 'Tailoring' },
            { key: 'alchemyLevel', label: 'Alchemy' },
            { key: 'enhancingLevel', label: 'Enhancing' },
        ];
        const skills = this.skillingMode ? skillingSkills : combatSkills;

        const summary = skills.map((s) => `${s.label.slice(0, 3)} ${dto[s.key]}`).join(' / ');

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="skill-section">`;
        html += `<span data-arrow="skill-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Skill Levels`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${summary}</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-skill-section" style="display:none;">`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">`;

        for (const skill of skills) {
            html += `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">`;
            html += `<span style="color:#888; width:70px;">${skill.label}</span>`;
            html += `<input type="number" min="1" max="200" value="${dto[skill.key]}"
                data-skill="${skill.key}"
                style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div></div>';
        return html;
    }

    /** @private */
    _renderHouseRoomsSection(dto, gameData) {
        const houseRoomDetailMap = gameData.houseRoomDetailMap || {};
        const roomHrids = Object.keys(houseRoomDetailMap).sort();
        const activeCount = roomHrids.filter((hrid) => (dto.houseRooms[hrid] || 0) > 0).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="house-section">`;
        html += `<span data-arrow="house-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> House Rooms`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${activeCount} active</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-house-section" style="display:none;">`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">`;

        for (const hrid of roomHrids) {
            const room = houseRoomDetailMap[hrid];
            const name = room.name || hrid.split('/').pop();
            const level = dto.houseRooms[hrid] || 0;
            html += `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">`;
            html += `<span style="color:#888; width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${name}">${name}</span>`;
            html += `<input type="number" min="0" max="8" value="${level}"
                data-house-hrid="${hrid}"
                style="width:40px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div></div>';
        return html;
    }

    /**
     * The guild shrine levels this player has bought, as editable numbers.
     *
     * Only the side of the game being simulated is listed: a combat sim cannot
     * show a change in Force Skilling, and a skilling run cannot show one in
     * Force Combat, so offering the other half would only invite edits that go
     * nowhere. The shrine's own level is shown beside the input as a cap you can
     * still type past — the guild can raise it, and the point of the editor is
     * asking what would happen if it did.
     * @param {Object} dto - Player DTO
     * @returns {string} HTML, empty when the client has no guild buff data
     * @private
     */
    _renderGuildShrinesSection(dto) {
        const detailMap = getGuildBuffDetailMap();
        const wantCombat = !this.skillingMode;
        const entries = Object.entries(detailMap)
            .filter(([, detail]) => Boolean(detail.isCombat) === wantCombat)
            .sort((a, b) => (a[1].sortIndex ?? 0) - (b[1].sortIndex ?? 0));
        if (entries.length === 0) return '';

        const levels = dto.guildShrineLevels || {};
        const activeCount = entries.filter(([hrid]) => (levels[hrid] || 0) > 0).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="guild-section">`;
        html += `<span data-arrow="guild-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Guild Shrines`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${activeCount} active</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-guild-section" style="display:none;">`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">`;

        for (const [buffHrid, detail] of entries) {
            const label = (detail.shrineHrid || buffHrid)
                .split('/')
                .pop()
                .split('_')
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
            const maxLevel = guildBuffMaxLevel(detail) || 20;
            const level = Math.max(0, Math.floor(Number(levels[buffHrid]) || 0));
            html += `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">`;
            html += `<span style="color:#888; width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${label}">${label}</span>`;
            html += `<input type="number" min="0" max="${maxLevel}" value="${level}"
                data-guild-buff="${buffHrid}"
                style="width:40px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div></div>';
        return html;
    }

    /**
     * The Labyrinth combat scrolls the player can carry into a fight. Each grants
     * a 30-minute buff effective in normal combat (not the Labyrinth or Guild
     * Trials); ticking one folds its buff into the sim. Skilling mode hides the
     * section — its scroll picker lives elsewhere.
     * @private
     */
    _renderScrollsSection(dto) {
        if (this.skillingMode) return '';
        const active = new Set(Array.isArray(dto.scrollBuffs) ? dto.scrollBuffs : []);
        const activeCount = COMBAT_SCROLL_BUFF_TYPES.filter((typeHrid) => active.has(typeHrid)).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="scroll-section">`;
        html += `<span data-arrow="scroll-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Scrolls`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${activeCount} active</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-scroll-section" style="display:none;">`;

        for (const typeHrid of COMBAT_SCROLL_BUFF_TYPES) {
            const label = COMBAT_SCROLL_LABELS[typeHrid] || typeHrid;
            const checked = active.has(typeHrid) ? ' checked' : '';
            html += `<label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:3px; cursor:pointer;">`;
            html += `<input type="checkbox" data-scroll-buff="${typeHrid}"${checked} style="cursor:pointer;">`;
            html += `<span style="color:#888;">${label}</span>`;
            html += '</label>';
        }
        html += `<div style="color:#666; font-size:10px; margin-top:4px;">Each scroll's 30-minute buff, applied to the whole run.</div>`;

        html += '</div></div>';
        return html;
    }

    /**
     * The combat buffs the player's completed achievements grant (e.g. Damage
     * +2%). For your own character these are auto-detected off your own data and
     * applied by default; the section lets you untick one to sim without it. A
     * shared profile carries no resolved field for this, but when it carries
     * `characterAchievements` and the achievement catalog is loaded, an
     * imported/party-member DTO (`achievementBuffsDerived`) instead has the
     * three buffs pre-checked from that player's completed achievement tiers.
     * Older payloads without `characterAchievements` fall back to
     * `achievementBuffsManual` — the same three buffs offered unchecked. Either
     * way the checkboxes stay manually toggleable — the caption below says
     * which situation applies. A player with no achievement combat buffs at
     * all, or the skilling tab, shows nothing.
     * @private
     */
    _renderAchievementsSection(dto) {
        if (this.skillingMode) return '';
        const buffs = Array.isArray(dto.achievementCombatBuffs) ? dto.achievementCombatBuffs : [];
        if (buffs.length === 0) return '';
        const off = new Set(Array.isArray(dto.achievementBuffsOff) ? dto.achievementBuffsOff : []);
        const activeCount = buffs.filter((buff) => !off.has(buff?.typeHrid)).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="achievement-section">`;
        html += `<span data-arrow="achievement-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Achievements`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${activeCount} active</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-achievement-section" style="display:none;">`;

        for (const buff of buffs) {
            const typeHrid = buff?.typeHrid;
            if (!typeHrid) continue;
            const checked = off.has(typeHrid) ? '' : ' checked';
            html += `<label style="display:flex; align-items:center; gap:6px; font-size:12px; margin-bottom:3px; cursor:pointer;">`;
            html += `<input type="checkbox" data-achievement-buff="${typeHrid}"${checked} style="cursor:pointer;">`;
            html += `<span style="color:#888;">${achievementBuffLabel(buff)}</span>`;
            html += '</label>';
        }
        const caption = dto.achievementBuffsDerived
            ? 'Derived from their completed achievements — adjust if needed.'
            : dto.achievementBuffsManual
              ? 'Not in shared profiles — set manually.'
              : 'From your completed achievements. Untick to sim without one.';
        html += `<div style="color:#666; font-size:10px; margin-top:4px;">${caption}</div>`;

        html += '</div></div>';
        return html;
    }

    /** @private */
    _renderTokenUpgradesSection(dto) {
        const upgrades = [
            { key: 'speed', label: 'Speed' },
            { key: 'efficiency', label: 'Efficiency' },
            { key: 'success', label: 'Success Rate' },
            { key: 'doubleProgress', label: 'Double Progress' },
            { key: 'experience', label: 'Experience' },
        ];
        const tokens = dto.tokenUpgrades || {};
        const activeCount = upgrades.filter((u) => (tokens[u.key] || 0) > 0).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="token-section">`;
        html += `<span data-arrow="token-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Token Upgrades`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${activeCount} active</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-token-section" style="display:none;">`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">`;

        for (const upgrade of upgrades) {
            const val = tokens[upgrade.key] || 0;
            html += `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">`;
            html += `<span style="color:#888; width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${upgrade.label}</span>`;
            html += `<input type="number" min="0" max="12" value="${val}"
                data-token-upgrade="${upgrade.key}"
                style="width:40px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div></div>';
        return html;
    }

    /** @private */
    _renderCommunityBuffsSection(dto) {
        const buffs = [
            { key: 'productionEfficiency', label: 'Prod. Efficiency' },
            { key: 'enhancingSpeed', label: 'Enhancing Speed' },
            { key: 'gatheringQuantity', label: 'Gathering Qty' },
            { key: 'experience', label: 'Experience' },
        ];
        const levels = dto.communityBuffLevels || {};
        const activeCount = buffs.filter((b) => (levels[b.key] || 0) > 0).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="community-section">`;
        html += `<span data-arrow="community-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Community Buffs`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${activeCount} active</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-community-section" style="display:none;">`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">`;

        for (const buff of buffs) {
            const val = levels[buff.key] || 0;
            html += `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">`;
            html += `<span style="color:#888; width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${buff.label}">${buff.label}</span>`;
            html += `<input type="number" min="0" max="${MAX_COMMUNITY_BUFF_LEVEL}" value="${val}"
                data-community-buff="${buff.key}"
                style="width:40px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div></div>';
        return html;
    }

    /** @private */
    _wireEditorEvents(editorArea, dto) {
        editorArea.querySelectorAll('[data-toggle]').forEach((el) => {
            el.addEventListener('click', () => {
                const sectionId = el.dataset.toggle;
                const section = editorArea.querySelector('#mwi-csim-' + sectionId);
                const arrow = editorArea.querySelector('[data-arrow="' + sectionId + '"]');
                if (section) {
                    const isOpen = section.style.display !== 'none';
                    section.style.display = isOpen ? 'none' : 'block';
                    if (arrow) arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
                    if (isOpen) {
                        this._openSections.delete(sectionId);
                    } else {
                        this._openSections.add(sectionId);
                    }
                }
            });

            const sectionId = el.dataset.toggle;
            if (this._openSections.has(sectionId)) {
                const section = editorArea.querySelector('#mwi-csim-' + sectionId);
                const arrow = editorArea.querySelector('[data-arrow="' + sectionId + '"]');
                if (section) {
                    section.style.display = 'block';
                    if (arrow) arrow.innerHTML = '&#9660;';
                }
            }
        });

        editorArea.querySelectorAll('[data-enhance-slot]').forEach((input) => {
            input.addEventListener('change', () => {
                const slotType = input.dataset.enhanceSlot;
                const val = Math.min(20, Math.max(0, parseInt(input.value) || 0));
                input.value = val;
                if (dto.equipment[slotType]) {
                    dto.equipment[slotType].enhancementLevel = val;
                }
            });
        });

        editorArea.querySelectorAll('[data-ability-idx]').forEach((input) => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.abilityIdx);
                const val = Math.max(1, parseInt(input.value) || 1);
                input.value = val;
                if (dto.abilities[idx]) {
                    dto.abilities[idx].level = val;
                }
            });
        });

        editorArea.querySelectorAll('[data-skill]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.dataset.skill;
                const val = Math.max(1, parseInt(input.value) || 1);
                input.value = val;
                dto[key] = val;
            });
        });

        editorArea.querySelectorAll('[data-house-hrid]').forEach((input) => {
            input.addEventListener('change', () => {
                const hrid = input.dataset.houseHrid;
                const val = Math.max(0, Math.min(8, parseInt(input.value) || 0));
                input.value = val;
                if (val === 0) {
                    delete dto.houseRooms[hrid];
                } else {
                    dto.houseRooms[hrid] = val;
                }
            });
        });

        editorArea.querySelectorAll('[data-token-upgrade]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.dataset.tokenUpgrade;
                const val = Math.max(0, Math.min(12, parseInt(input.value) || 0));
                input.value = val;
                if (!dto.tokenUpgrades) dto.tokenUpgrades = {};
                dto.tokenUpgrades[key] = val;
            });
        });

        editorArea.querySelectorAll('[data-guild-buff]').forEach((input) => {
            input.addEventListener('change', () => {
                const buffHrid = input.dataset.guildBuff;
                const detail = getGuildBuffDetailMap()[buffHrid];
                const maxLevel = guildBuffMaxLevel(detail) || 20;
                const val = Math.max(0, Math.min(maxLevel, parseInt(input.value) || 0));
                input.value = val;
                if (!dto.guildShrineLevels) dto.guildShrineLevels = {};
                dto.guildShrineLevels[buffHrid] = val;
                // The combat engine reads the resolved buff array, not the level,
                // so a combat shrine's entries are rebuilt at the level just typed
                if (detail?.isCombat) {
                    dto.guildCombatBuffs = applyGuildBuffLevel(dto.guildCombatBuffs, detail, val);
                }
            });
        });

        editorArea.querySelectorAll('[data-community-buff]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.dataset.communityBuff;
                const val = Math.max(0, Math.min(MAX_COMMUNITY_BUFF_LEVEL, parseInt(input.value) || 0));
                input.value = val;
                if (!dto.communityBuffLevels) dto.communityBuffLevels = {};
                dto.communityBuffLevels[key] = val;
            });
        });

        editorArea.querySelectorAll('[data-scroll-buff]').forEach((input) => {
            input.addEventListener('change', () => {
                const typeHrid = input.dataset.scrollBuff;
                const set = new Set(Array.isArray(dto.scrollBuffs) ? dto.scrollBuffs : []);
                if (input.checked) {
                    set.add(typeHrid);
                } else {
                    set.delete(typeHrid);
                }
                dto.scrollBuffs = [...set];
            });
        });

        editorArea.querySelectorAll('[data-achievement-buff]').forEach((input) => {
            input.addEventListener('change', () => {
                const typeHrid = input.dataset.achievementBuff;
                // The buff is applied by default; the DTO carries the *excluded*
                // set, so an unticked box adds the type and a ticked box removes it.
                const set = new Set(Array.isArray(dto.achievementBuffsOff) ? dto.achievementBuffsOff : []);
                if (input.checked) {
                    set.delete(typeHrid);
                } else {
                    set.add(typeHrid);
                }
                dto.achievementBuffsOff = [...set];
            });
        });

        editorArea.querySelectorAll('[data-consumable-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const [slotType, idx] = btn.dataset.consumableSlot.split('-');
                const gameData = buildGameDataPayload();
                if (gameData) this._openConsumablePicker(slotType, parseInt(idx), dto, gameData);
            });
        });

        editorArea.querySelectorAll('[data-equipment-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const slotType = btn.dataset.equipmentSlot;
                const gameData = buildGameDataPayload();
                if (gameData) this._openEquipmentPicker(slotType, dto, gameData);
            });
        });

        editorArea.querySelectorAll('[data-ability-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const slotIndex = parseInt(btn.dataset.abilitySlot);
                const gameData = buildGameDataPayload();
                if (gameData) this._openAbilityPicker(slotIndex, dto, gameData);
            });
        });

        editorArea.querySelectorAll('[data-trigger-slot]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.triggerSlot;
                const dashIdx = key.lastIndexOf('-');
                const slotType = key.slice(0, dashIdx);
                const slotIndex = parseInt(key.slice(dashIdx + 1));
                const gameData = buildGameDataPayload();
                if (gameData) this._openTriggerEditor(slotType, slotIndex, dto, gameData);
            });
        });

        const resetBtn = editorArea.querySelector('#mwi-csim-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this._editedDTOs = structuredClone(this._originalDTOs);
                this._selectedLoadoutName = '';
                this.renderEditor();
            });
        }

        this._wireResetControls(editorArea);

        editorArea.querySelectorAll('[data-edit-tab]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                if (e.target.dataset.removePlayer) return;
                this._activeEditPlayer = btn.dataset.editTab;
                this.renderEditor();
            });
        });

        editorArea.querySelectorAll('[data-remove-player]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const hrid = btn.dataset.removePlayer;
                if (!this._editedDTOs) return;
                delete this._editedDTOs[hrid];
                if (this._originalDTOs) delete this._originalDTOs[hrid];
                this._editedPlayerInfo = this._editedPlayerInfo.filter((p) => p.hrid !== hrid);
                if (this._activeEditPlayer === hrid) {
                    this._activeEditPlayer = this._editedPlayerInfo[0]?.hrid || null;
                }
                if (Object.keys(this._editedDTOs).length === 0) {
                    this._editedDTOs = {};
                    this._originalDTOs = {};
                    this._editedPlayerInfo = [];
                    this._editorInitialized = true;
                    this._activeEditPlayer = null;
                    this._selfHrid = null;
                    this.renderEditor();
                    return;
                }
                this.renderEditor();
            });
        });

        const importBtn = editorArea.querySelector('#mwi-csim-import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                const area = editorArea.querySelector('#mwi-csim-import-area');
                if (area) area.style.display = area.style.display === 'none' ? 'block' : 'none';
            });
        }

        const importGo = editorArea.querySelector('#mwi-csim-import-go');
        if (importGo) {
            importGo.addEventListener('click', () => {
                const text = editorArea.querySelector('#mwi-csim-import-text')?.value?.trim();
                const errorEl = editorArea.querySelector('#mwi-csim-import-error');
                if (!text) {
                    if (errorEl) errorEl.textContent = 'Paste export data first.';
                    return;
                }
                const result = parseShykaiImport(text);
                if (!result || !result.players.length) {
                    if (errorEl) errorEl.textContent = 'Invalid format. Paste a Shykai export JSON.';
                    return;
                }
                this.importPlayers(result.players, result.names, result.skipped);
                const area = editorArea.querySelector('#mwi-csim-import-area');
                if (area) area.style.display = 'none';
            });
        }

        const importCancel = editorArea.querySelector('#mwi-csim-import-cancel');
        if (importCancel) {
            importCancel.addEventListener('click', () => {
                const area = editorArea.querySelector('#mwi-csim-import-area');
                if (area) area.style.display = 'none';
            });
        }

        const loadoutSelect = editorArea.querySelector('#mwi-csim-loadout-select');
        if (loadoutSelect) {
            loadoutSelect.addEventListener('change', () => {
                const selectedName = loadoutSelect.value;
                this._selectedLoadoutName = selectedName;
                if (!selectedName) {
                    const activePlayer = this._activeEditPlayer;
                    if (this._originalDTOs?.[activePlayer]) {
                        this._editedDTOs[activePlayer] = structuredClone(this._originalDTOs[activePlayer]);
                    }
                } else {
                    this._applyLoadoutToDTO(selectedName);
                }
                this._saveLoadoutMemory();
                this.renderEditor();
            });
        }
    }

    /**
     * Generate a descriptive label by diffing edited DTOs against original.
     * @returns {string}
     */
    generateSimLabel() {
        const selfHrid = this._selfHrid || this._activeEditPlayer;
        const original = this._originalDTOs?.[selfHrid];
        const edited = this._editedDTOs?.[selfHrid];
        if (!original || !edited) return this._selectedLoadoutName || 'Current Gear';

        const gameData = buildGameDataPayload();
        const itemDetailMap = gameData?.itemDetailMap || {};
        const abilityDetailMap = gameData?.abilityDetailMap || {};

        const changes = [];

        const slotNames = {
            '/equipment_types/head': 'Head',
            '/equipment_types/body': 'Body',
            '/equipment_types/legs': 'Legs',
            '/equipment_types/feet': 'Feet',
            '/equipment_types/hands': 'Hands',
            '/equipment_types/main_hand': 'Main Hand',
            '/equipment_types/two_hand': 'Two Hand',
            '/equipment_types/off_hand': 'Off Hand',
            '/equipment_types/pouch': 'Pouch',
            '/equipment_types/back': 'Back',
            '/equipment_types/neck': 'Neck',
            '/equipment_types/earrings': 'Earrings',
            '/equipment_types/ring': 'Ring',
            '/equipment_types/charm': 'Charm',
        };

        for (const slot of Object.keys(slotNames)) {
            const origEquip = original.equipment?.[slot];
            const editEquip = edited.equipment?.[slot];
            if (!origEquip && !editEquip) continue;

            if (origEquip?.hrid !== editEquip?.hrid) {
                const origName = itemDetailMap[origEquip?.hrid]?.name || origEquip?.hrid?.split('/').pop() || 'Empty';
                const editName = itemDetailMap[editEquip?.hrid]?.name || editEquip?.hrid?.split('/').pop() || 'Empty';
                changes.push(`${origName} \u2192 ${editName}`);
            } else if (origEquip?.enhancementLevel !== editEquip?.enhancementLevel) {
                const label = slotNames[slot];
                changes.push(`${label} +${origEquip.enhancementLevel}\u2192+${editEquip.enhancementLevel}`);
            }
        }

        for (let i = 0; i < 5; i++) {
            const origAb = original.abilities?.[i];
            const editAb = edited.abilities?.[i];
            if (!origAb && !editAb) continue;

            if (origAb?.hrid !== editAb?.hrid) {
                const origName = abilityDetailMap[origAb?.hrid]?.name || origAb?.hrid?.split('/').pop() || 'None';
                const editName = abilityDetailMap[editAb?.hrid]?.name || editAb?.hrid?.split('/').pop() || 'None';
                changes.push(`${origName} \u2192 ${editName}`);
            } else if (origAb && editAb && origAb.level !== editAb.level) {
                const name = abilityDetailMap[editAb.hrid]?.name || editAb.hrid.split('/').pop();
                changes.push(`${name} Lv ${origAb.level}\u2192${editAb.level}`);
            } else if (
                origAb &&
                editAb &&
                JSON.stringify(origAb.triggers ?? null) !== JSON.stringify(editAb.triggers ?? null)
            ) {
                const name = abilityDetailMap[editAb.hrid]?.name || editAb.hrid.split('/').pop();
                changes.push(`${name} triggers`);
            }
        }

        const skillLabels = {
            staminaLevel: 'Stamina',
            intelligenceLevel: 'Intelligence',
            attackLevel: 'Attack',
            meleeLevel: 'Melee',
            defenseLevel: 'Defense',
            rangedLevel: 'Ranged',
            magicLevel: 'Magic',
            woodcuttingLevel: 'Woodcutting',
            foragingLevel: 'Foraging',
            milkingLevel: 'Milking',
            cookingLevel: 'Cooking',
            brewingLevel: 'Brewing',
            cheesesmithingLevel: 'Cheesesmithing',
            craftingLevel: 'Crafting',
            tailoringLevel: 'Tailoring',
            alchemyLevel: 'Alchemy',
            enhancingLevel: 'Enhancing',
        };
        for (const [key, label] of Object.entries(skillLabels)) {
            if (original[key] !== edited[key]) {
                changes.push(`${label} ${original[key]}\u2192${edited[key]}`);
            }
        }

        const slotLabels = { food: 'Food', drinks: 'Drink' };
        for (const [slotType, prefix] of Object.entries(slotLabels)) {
            for (let i = 0; i < 3; i++) {
                const origHrid = original[slotType]?.[i]?.hrid;
                const editHrid = edited[slotType]?.[i]?.hrid;
                if (origHrid !== editHrid) {
                    const origName = origHrid ? itemDetailMap[origHrid]?.name || origHrid.split('/').pop() : 'Empty';
                    const editName = editHrid ? itemDetailMap[editHrid]?.name || editHrid.split('/').pop() : 'Empty';
                    changes.push(`${prefix} ${i + 1}: ${origName}\u2192${editName}`);
                } else if (
                    origHrid &&
                    JSON.stringify(original[slotType][i]?.triggers ?? null) !==
                        JSON.stringify(edited[slotType][i]?.triggers ?? null)
                ) {
                    const name = itemDetailMap[origHrid]?.name || origHrid.split('/').pop();
                    changes.push(`${name} triggers`);
                }
            }
        }

        const tokenLabels = {
            speed: 'Speed',
            efficiency: 'Efficiency',
            success: 'Success',
            doubleProgress: 'DblProg',
            experience: 'Exp',
        };
        for (const [key, label] of Object.entries(tokenLabels)) {
            const origVal = original.tokenUpgrades?.[key] || 0;
            const editVal = edited.tokenUpgrades?.[key] || 0;
            if (origVal !== editVal) {
                changes.push(`Token ${label} ${origVal}\u2192${editVal}`);
            }
        }

        const guildLevels = { ...(original.guildShrineLevels || {}), ...(edited.guildShrineLevels || {}) };
        for (const buffHrid of Object.keys(guildLevels)) {
            const origVal = original.guildShrineLevels?.[buffHrid] || 0;
            const editVal = edited.guildShrineLevels?.[buffHrid] || 0;
            if (origVal === editVal) continue;
            const label = buffHrid.split('/').pop().replace(/_/g, ' ');
            changes.push(`Shrine ${label} ${origVal}→${editVal}`);
        }

        const cbLabels = {
            productionEfficiency: 'ProdEff',
            enhancingSpeed: 'EnhSpd',
            gatheringQuantity: 'GathQty',
            experience: 'Exp',
        };
        for (const [key, label] of Object.entries(cbLabels)) {
            const origVal = original.communityBuffLevels?.[key] || 0;
            const editVal = edited.communityBuffLevels?.[key] || 0;
            if (origVal !== editVal) {
                changes.push(`CB ${label} ${origVal}\u2192${editVal}`);
            }
        }

        const loadoutPrefix = this._selectedLoadoutName || '';
        if (changes.length === 0) return loadoutPrefix || 'Current Gear';
        const changesStr = changes.join(', ');
        return loadoutPrefix ? loadoutPrefix + ': ' + changesStr : changesStr;
    }

    /**
     * @param {string} loadoutName - Snapshot name
     * @returns {boolean} True when a snapshot of that name was found and applied
     * @private
     */
    _applyLoadoutToDTO(loadoutName) {
        const gameData = buildGameDataPayload();
        if (!gameData) return false;
        const dto = this._editedDTOs?.[this._activeEditPlayer];
        if (!dto) return false;
        return applyLoadoutSnapshotToDTO(dto, loadoutName, gameData) !== false;
    }
}
