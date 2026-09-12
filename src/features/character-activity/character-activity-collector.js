/**
 * Character Activity Collector
 *
 * The character-scoped half of Character Activity Status: while a character is actually
 * connected, compute an activity projection and persist it, so the character-select screen can
 * say something true about that character later — from this tab or any other.
 *
 * Also mirrors the enable flag and the date/time presentation settings to an account-level key,
 * because character select has no active character and therefore no settings context to read.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { computeLiveProjection } from './character-activity-projection.js';
import { saveCharacterActivity, saveAccountPreferences } from './character-activity-storage.js';

class CharacterActivityCollector {
    constructor() {
        this.isInitialized = false;
        this.characterId = null;
        this.characterName = null;
        /**
         * Bumped on every cleanup so a recompute already in flight when the character switched
         * cannot write the departing character's queue under the arriving character's id.
         */
        this.lifecycleGeneration = 0;
        this.recomputeHandler = null;
        this.switchingHandler = null;
        this.beforeUnloadHandler = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;
        const generation = ++this.lifecycleGeneration;

        this.characterId = dataManager.getCurrentCharacterId();
        this.characterName = dataManager.getCurrentCharacterName();

        this.recomputeHandler = () => this.recomputeAndPersist(generation);
        dataManager.on('actions_updated', this.recomputeHandler);
        dataManager.on('character_info_updated', this.recomputeHandler);

        // Registered once and never removed, for the same reason queue-snapshot does it: the
        // feature registry disables every feature *during* character_switching, so a listener
        // this module unregisters in cleanup would be gone before the switch could fire it.
        // The departing character's data is still live at that point, and the event carries its
        // id, so the last projection of the character being left behind is the accurate one.
        if (!this.switchingHandler) {
            this.switchingHandler = (event) => this.captureDepartingCharacter(event);
            dataManager.on('character_switching', this.switchingHandler);
        }

        this.beforeUnloadHandler = () => this.recomputeAndPersist(generation, true);
        window.addEventListener('beforeunload', this.beforeUnloadHandler);

        // Not awaited: the persist rides the storage module's 3-second write
        // debounce, and awaiting it (twice, with the preferences mirror) held
        // the whole sequential feature init for six seconds. It catches its
        // own failures; nothing after this needs the write landed.
        this.recomputeAndPersist(generation);
    }

    /**
     * Build the record for whichever character is live right now.
     * @param {string} characterId
     * @param {string} characterName
     * @returns {Object}
     */
    buildRecord(characterId, characterName) {
        return {
            characterId,
            characterName,
            observedAt: Date.now(),
            offline: {
                hourCap: dataManager.getOfflineHourCap(),
                mooPassExpireTime: dataManager.getMooPassExpireTime(),
            },
            projection: computeLiveProjection(),
        };
    }

    /**
     * Recompute the current projection and persist it. Coalesced by the storage module's normal
     * debounced write path, except on page departure — a delayed write there would go with the
     * page — where `immediate` skips the debounce.
     * @param {number} generation - Lifecycle generation captured at registration time
     * @param {boolean} [immediate]
     * @returns {Promise<void>}
     */
    async recomputeAndPersist(generation, immediate = false) {
        if (generation !== this.lifecycleGeneration) return;
        if (!this.characterId) return;

        try {
            await saveCharacterActivity(
                this.characterId,
                this.buildRecord(this.characterId, this.characterName),
                immediate
            );
            if (generation !== this.lifecycleGeneration) return;
            await this.mirrorAccountPreferences();
        } catch (error) {
            console.error('[CharacterActivity] Failed to record activity:', error);
        }
    }

    /**
     * Snapshot the character being switched away from, while its data is still live.
     *
     * Awaited by the data manager, and written immediately rather than through the debounce:
     * three seconds later this character's data is gone.
     * @param {{oldId: string, oldName: string}} event
     * @returns {Promise<void>}
     */
    async captureDepartingCharacter(event) {
        const oldId = event?.oldId;
        if (!oldId) return;

        try {
            await saveCharacterActivity(oldId, this.buildRecord(oldId, event.oldName ?? this.characterName), true);
            await this.mirrorAccountPreferences();
        } catch (error) {
            console.error('[CharacterActivity] Failed to snapshot departing character:', error);
        }
    }

    /**
     * Copy the settings character select will need into an account-level key, since it renders
     * with no active character and cannot read per-character settings at all.
     *
     * `timeFormat` is mirrored as-is, including `'auto'` — it is deliberately left unresolved
     * here. Resolving it now would bake in whichever device last mirrored it; instead
     * `formatActivityStatusTime` resolves it against `Intl` on the device that renders it, so a
     * phone and a desktop on different locales each follow their own clock.
     * @returns {Promise<void>}
     */
    async mirrorAccountPreferences() {
        await saveAccountPreferences({
            enabled: config.getSetting('characterSelect_activityStatus'),
            dateFormat: config.getSettingValue('market_listingDateFormat', 'MM-DD'),
            timeFormat: config.getSettingValue('market_listingTimeFormat', '24hour'),
        });
    }

    cleanup() {
        this.lifecycleGeneration += 1;

        if (this.recomputeHandler) {
            dataManager.off('actions_updated', this.recomputeHandler);
            dataManager.off('character_info_updated', this.recomputeHandler);
            this.recomputeHandler = null;
        }
        // The character_switching listener stays registered on purpose — see initialize().
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
            this.beforeUnloadHandler = null;
        }

        this.isInitialized = false;
        this.characterId = null;
        this.characterName = null;
    }
}

const characterActivityCollector = new CharacterActivityCollector();

export default characterActivityCollector;
