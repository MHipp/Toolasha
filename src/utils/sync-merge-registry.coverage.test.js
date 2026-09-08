/**
 * Overlap and coverage probe over the registry's real production registrations.
 *
 * `sync-merge-registry.test.js` exercises the matching engine in isolation,
 * registering fake entries and clearing them between tests. This file never
 * calls `clearSyncMerges()` — it imports every module that calls
 * `registerSyncMerge()` (or, for a `ChunkedHistory`, causes it to be called)
 * and then checks the registry those imports actually built.
 *
 * Two things are worth automating here, because both silently degrade rather
 * than error:
 *
 * 1. **Disjointness.** `mergeForKey()`'s contract is that exactly one
 *    registration claims a key; a second match is a bug that resolves to
 *    "whichever bundle happened to load first" (see the registry's own
 *    doc comment) and is reported with a `console.warn`, not thrown. A test
 *    that never looks for that warning would not notice a new registration
 *    quietly starting to shadow an old one.
 * 2. **Coverage.** Every additive history this script keeps is on this list
 *    because a whole-key sync pull would otherwise throw away one device's
 *    entries. A rename that drops a `Rec` suffix or a scoping underscore
 *    would make `registerSyncMerge`'s matcher stop matching the real keys
 *    the feature writes, and nothing before this would fail — a pull would
 *    just start overwriting silently again. Asserting each real key shape
 *    still resolves to its registration is what makes that fail loudly.
 *
 * The import list below covers every `registerSyncMerge()` call site in
 * `src/` (grep is `grep -rl registerSyncMerge src`), grouped the way the
 * registry's own header describes the bundles: `utils` shapes first, then
 * `market`, `combat`/`labyrinth`, `guild`, `insights`, `inventory`,
 * `leaderboard`, `skills`, `networth`, `tasks`, `alchemy` — one instance of
 * this module, imported before any of them, is exactly what makes the
 * registrations from every bundle land in the same array.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, vi } from 'vitest';

import { mergeForKey } from './sync-merge-registry.js';

await import('./chest-tally.js');
await import('./inventory-reservations.js');
await import('./watchlist.js');
await import('../features/market/trade-history.js');
await import('../features/market/trade-ledger-store.js');
await import('../features/market/estimated-listing-age.js');
await import('../features/combat-stats/combat-session-history.js');
await import('../features/combat/labyrinth-fight-recorder.js');
await import('../features/combat/labyrinth-room-logs.js');
await import('../features/combat/labyrinth-outcomes.js');
await import('../features/combat/combat-replay-check.js');
await import('../features/combat/labyrinth-run-ledger.js');
await import('../features/combat/dungeon-tracker-storage.js');
await import('../features/combat/labyrinth-tracker.js');
await import('../features/guild/guild-xp-tracker.js');
await import('../features/guild/guild-trials-store.js');
await import('../features/guild/guild-member-skills.js');
await import('../features/guild/guild-loadouts.js');
await import('../features/guild/guild-trial-abilities.js');
await import('../features/guild/guild-trial-plan.js');
await import('../features/insights/enhancement-calibration.js');
await import('../features/insights/prediction-calibration.js');
await import('../features/inventory/custom-tabs/custom-tabs-data.js');
await import('../features/leaderboard/leaderboard-xp-tracker.js');
await import('../features/ui/overlay-layouts.js');
await import('../features/planner/goal-planner-store.js');
await import('../features/skills/xp-tracker.js');
await import('../features/skills/skill-checkpoints.js');
await import('../features/abilities/ability-checkpoints.js');
await import('../features/actions/loot-log-history.js');
await import('../features/networth/networth-history.js');
await import('../features/networth/chest-opening-recorder.js');
await import('../features/networth/production-income-recorder.js');
await import('../features/tasks/task-completion-tracker.js');
await import('../features/tasks/task-reroll-tracker.js');
await import('../features/alchemy/transmute-history-tracker.js');
await import('../features/alchemy/decompose-history-tracker.js');
await import('../features/alchemy/coinify-history-tracker.js');

const CHAR = 'char-A';

/**
 * Every real key shape the registrations above are meant to own, mined from
 * the registering modules themselves (their `store`/`base`/`prefix`/`key`
 * constants and, for a `ChunkedHistory`, its `prefix` + `legacyKey`):
 *
 * - the bare base for a scoped key (`xpHistory`)
 * - the character-scoped form (`xpHistory_char-A`)
 * - a chunked record key, `<recordPrefix>_<charId>_<chunkId>`
 * - a chunked history's legacy pre-split key, bare and scoped
 *
 * `label: null` marks a key that must land unclaimed — a lookalike key that a
 * broad matcher must NOT pick up (`sync-merge-registry.js`'s whole point is
 * that overlap is a bug, so a near-miss is worth checking as hard as a hit).
 *
 * @type {Array<{store: string, key: string, label: string|null}>}
 */
const corpus = [
    // skills/xp-tracker.js
    { store: 'xpHistory', key: 'xpHistory', label: 'Skill XP history' },
    { store: 'xpHistory', key: `xpHistory_${CHAR}`, label: 'Skill XP history' },

    // skills/skill-checkpoints.js — chunked, monthly buckets. The record
    // prefix is spelled apart from the legacy stem (`skillCheckpointRec_`
    // against `skillCheckpoints_`) so neither matcher can eat the other's keys
    { store: 'xpHistory', key: `skillCheckpointRec_${CHAR}_2026-01`, label: 'SkillCheckpoints records' },
    { store: 'xpHistory', key: `skillCheckpoints_${CHAR}`, label: 'SkillCheckpoints legacy key' },

    // abilities/ability-checkpoints.js — chunked, monthly buckets. The series
    // key inside an entry is `<characterId>|<abilityHrid>`; the record key is
    // scoped to the character as well, so the two must agree to be read at all
    { store: 'xpHistory', key: `abilityCheckpointRec_${CHAR}_2026-01`, label: 'AbilityCheckpoints records' },
    { store: 'xpHistory', key: `abilityCheckpoints_${CHAR}`, label: 'AbilityCheckpoints legacy key' },

    // leaderboard/leaderboard-xp-tracker.js
    { store: 'leaderboardHistory', key: 'playerXP', label: 'Leaderboard XP' },

    // guild/guild-xp-tracker.js
    { store: 'guildHistory', key: 'guildXP_Some Guild', label: 'Guild XP history' },
    { store: 'guildHistory', key: `memberXP_${CHAR}`, label: 'Guild member XP' },

    // guild/guild-trials-store.js — and the cache key its prefix must not eat
    { store: 'guildHistory', key: 'guildTrials_Some Guild', label: 'Guild trial records' },
    { store: 'guildHistory', key: 'guildTrialsRoster', label: null },

    // guild/guild-member-skills.js — by guild name, or the guild-less bucket
    { store: 'guildHistory', key: 'guildMemberSkills_Some Guild', label: 'Guild member skills' },
    { store: 'guildHistory', key: 'guildMemberSkills_default', label: 'Guild member skills' },

    // guild/guild-loadouts.js — by viewing character, then by their guild
    { store: 'guildHistory', key: `guildLoadouts_${CHAR}`, label: 'Guild loadout sightings' },
    { store: 'guildHistory', key: `guildLoadouts_${CHAR}_Some Guild`, label: 'Guild loadout sightings' },

    // guild/guild-trial-abilities.js and guild-trial-plan.js — two prefixes
    // that share `guildTrialAbilit` with each other and `guildTrial` with
    // `guildTrials_` above, which is exactly the near-miss this probe is for
    { store: 'guildHistory', key: 'guildTrialAbilities_Some Guild', label: 'Guild trial ability session' },
    { store: 'guildHistory', key: 'guildTrialAbilities_default', label: 'Guild trial ability session' },
    { store: 'guildHistory', key: `guildTrialAbilities_char_${CHAR}`, label: 'Guild trial ability session' },
    { store: 'guildHistory', key: 'guildTrialAbilityPlan_Some Guild', label: 'Guild trial ability plan' },
    { store: 'guildHistory', key: 'guildTrialAbilityPlan_default', label: 'Guild trial ability plan' },

    // market/trade-history.js
    { store: 'settings', key: 'tradeHistory', label: 'Personal trade prices' },
    { store: 'settings', key: `tradeHistory_${CHAR}`, label: 'Personal trade prices' },

    // market/trade-ledger-store.js — RECORDS_BASE ("tradeLedgerRecords") is
    // deliberately spelled apart from RECORD_PREFIX ("tradeLedgerRec_") so the
    // scoped base's own `_<id>` suffix can never be mistaken for a chunk key
    { store: 'marketListings', key: 'tradeLedgerRecords', label: 'Trade ledger fills' },
    { store: 'marketListings', key: `tradeLedgerRecords_${CHAR}`, label: 'Trade ledger fills' },
    { store: 'marketListings', key: `tradeLedgerRec_${CHAR}_2026-01-15`, label: 'Trade ledger fills (daily)' },
    { store: 'marketListings', key: 'tradeLedgerState', label: 'Trade ledger baselines' },
    { store: 'marketListings', key: `tradeLedgerState_${CHAR}`, label: 'Trade ledger baselines' },

    // market/estimated-listing-age.js
    { store: 'marketListings', key: 'marketListingTimestamps', label: 'Market listing log' },
    { store: 'marketListings', key: `marketListingTimestamps_${CHAR}`, label: 'Market listing log' },
    { store: 'marketListings', key: 'marketListingAnchors', label: 'Market listing anchors' },
    // The deletion tombstones beside the log. `marketListingGraves` is spelled
    // apart from both siblings so neither scoped base can reach across
    { store: 'marketListings', key: 'marketListingGraves', label: 'Market listing deletions' },
    { store: 'marketListings', key: `marketListingGraves_${CHAR}`, label: 'Market listing deletions' },

    // combat-stats/combat-session-history.js
    { store: 'combatStats', key: 'combatSessionHistory', label: 'Combat sessions' },
    { store: 'combatStats', key: `combatSessionHistory_${CHAR}`, label: 'Combat sessions' },

    // combat/labyrinth-fight-recorder.js
    { store: 'labyrinth', key: 'labyrinthFightRecorder', label: 'Labyrinth fights' },
    { store: 'labyrinth', key: `labyrinthFightRecorder_${CHAR}`, label: 'Labyrinth fights' },

    // combat/labyrinth-room-logs.js (lives in the settings store)
    { store: 'settings', key: 'labyrinthRoomLogs', label: 'Labyrinth room logs' },
    { store: 'settings', key: `labyrinthRoomLogs_${CHAR}`, label: 'Labyrinth room logs' },

    // combat/labyrinth-outcomes.js (lives in the settings store) — the sim
    // cache alongside it shares the `labyrinth` stem and must stay unclaimed
    { store: 'settings', key: 'labyrinthFightOutcomes', label: 'Labyrinth fight outcomes' },
    { store: 'settings', key: `labyrinthFightOutcomes_${CHAR}`, label: 'Labyrinth fight outcomes' },

    // combat/combat-replay-check.js — two lists in the settings store, which
    // every sync scope carries. `combatReplayCheck_` is one stem shared by two
    // registrations, so each must claim only its own half
    { store: 'settings', key: 'combatReplayCheck_observations', label: 'Replay check observations' },
    { store: 'settings', key: `combatReplayCheck_observations_${CHAR}`, label: 'Replay check observations' },
    { store: 'settings', key: 'combatReplayCheck_history', label: 'Replay check history' },
    { store: 'settings', key: `combatReplayCheck_history_${CHAR}`, label: 'Replay check history' },

    // combat/dungeon-tracker-storage.js — one account-wide list plus the clear
    // watermark beside it. Two exact keys, and the watermark's own name starts
    // with the list's, so the near-miss is worth stating
    { store: 'unifiedRuns', key: 'allRuns', label: 'Dungeon run history' },
    { store: 'unifiedRuns', key: 'allRunsClearedAt', label: 'Dungeon run history clear' },

    // combat/labyrinth-run-ledger.js
    { store: 'labyrinth', key: 'labyrinthRunLedger', label: 'Labyrinth run ledger' },
    { store: 'labyrinth', key: `labyrinthRunLedger_${CHAR}`, label: 'Labyrinth run ledger' },

    // combat/labyrinth-tracker.js
    { store: 'labyrinth', key: 'monsterBestLevels', label: 'Labyrinth best levels' },
    { store: 'labyrinth', key: `monsterBestLevels_${CHAR}`, label: 'Labyrinth best levels' },

    // insights/enhancement-calibration.js and prediction-calibration.js — the
    // near-miss between "calibration" and "calibrationEnhancing" is exactly
    // the kind of collision this registry exists to catch
    { store: 'lootLogHistory', key: 'calibrationEnhancing', label: 'Enhancement calibration' },
    { store: 'lootLogHistory', key: `calibrationEnhancing_${CHAR}`, label: 'Enhancement calibration' },
    { store: 'lootLogHistory', key: 'calibration', label: 'Prediction calibration' },
    { store: 'lootLogHistory', key: `calibration_${CHAR}`, label: 'Prediction calibration' },

    // inventory/custom-tabs/custom-tabs-data.js — a bespoke `match`, not `base`
    { store: 'settings', key: 'inventoryTabs_config', label: 'Custom inventory tabs' },
    { store: 'settings', key: `${CHAR}_inventoryTabs_config`, label: 'Custom inventory tabs' },

    // ui/overlay-layouts.js — one global key, layouts are not per character,
    // so the character-scoped form must NOT resolve to it
    { store: 'settings', key: 'overlayLayouts', label: 'Overlay layouts' },
    { store: 'settings', key: `overlayLayouts_${CHAR}`, label: null },

    // planner/goal-planner-store.js — character-scoped, and the two sibling
    // keys it shares a `goalPlanner` stem with are caches that must stay out
    { store: 'settings', key: 'goalPlannerGoals', label: 'Goal planner goals' },
    { store: 'settings', key: `goalPlannerGoals_${CHAR}`, label: 'Goal planner goals' },
    { store: 'settings', key: 'goalPlannerSnapshot', label: null },
    { store: 'settings', key: 'goalPlannerCombatGear', label: null },

    // utils/inventory-reservations.js — character-scoped. The stem is spelled
    // `inventoryReservationLedger` rather than `inventoryReservations` so the
    // base matcher can never reach the settings blob's own key of that name
    { store: 'settings', key: 'inventoryReservationLedger', label: 'Inventory reservations' },
    { store: 'settings', key: `inventoryReservationLedger_${CHAR}`, label: 'Inventory reservations' },
    { store: 'settings', key: 'inventoryReservations', label: null },

    // utils/chest-tally.js — and the lookalike record it must not absorb
    { store: 'settings', key: 'treasureTally', label: 'Treasure tally' },
    { store: 'settings', key: `treasureTally_${CHAR}`, label: 'Treasure tally' },
    { store: 'settings', key: 'treasureTallySettings', label: null },

    // utils/watchlist.js — character-scoped, and the panel's own geometry key
    // (`watchlistPanel`) is the lookalike the base matcher must not eat
    { store: 'settings', key: 'watchlist', label: 'Watchlist' },
    { store: 'settings', key: `watchlist_${CHAR}`, label: 'Watchlist' },
    { store: 'settings', key: 'watchlistPanel', label: null },

    // actions/loot-log-history.js — chunked, plus its legacy pre-split key
    { store: 'lootLogHistory', key: `lootLogRec_${CHAR}_2026-01`, label: 'LootLogHistory records' },
    { store: 'lootLogHistory', key: `lootLog_${CHAR}`, label: 'LootLogHistory legacy key' },

    // networth/networth-history.js — chunked
    { store: 'networthHistory', key: `networthSeries_${CHAR}_2026-01`, label: 'NetworthHistory records' },
    { store: 'networthHistory', key: `networth_${CHAR}`, label: 'NetworthHistory legacy key' },

    // networth/chest-opening-recorder.js — chunked
    { store: 'networthHistory', key: `chestOpenRec_${CHAR}_2026-01-15`, label: 'ChestOpenings records' },
    { store: 'networthHistory', key: `chestOpenings_${CHAR}`, label: 'ChestOpenings legacy key' },

    // networth/production-income-recorder.js — chunked
    { store: 'networthHistory', key: `prodIncomeRec_${CHAR}_2026-01-15`, label: 'ProductionIncome records' },
    { store: 'networthHistory', key: `prodIncome_${CHAR}`, label: 'ProductionIncome legacy key' },

    // tasks/task-completion-tracker.js — chunked, weekly buckets
    { store: 'rerollSpending', key: `taskCompletionRec_${CHAR}_2026-W03`, label: 'TaskCompletionTracker records' },
    { store: 'rerollSpending', key: `taskCompletions_${CHAR}`, label: 'TaskCompletionTracker legacy key' },

    // tasks/task-reroll-tracker.js — the retired-task history only. The live
    // map (`taskRerollData_<id>`) is curated and must stay unclaimed
    { store: 'rerollSpending', key: 'taskRerollHistory', label: 'Task reroll history' },
    { store: 'rerollSpending', key: `taskRerollHistory_${CHAR}`, label: 'Task reroll history' },
    { store: 'rerollSpending', key: `taskRerollData_${CHAR}`, label: null },

    // alchemy/transmute-history-tracker.js — chunked, daily buckets
    {
        store: 'alchemyHistory',
        key: `transmuteSessionsRec_${CHAR}_2026-01-15`,
        label: 'TransmuteHistoryTracker records',
    },
    { store: 'alchemyHistory', key: `transmuteSessions_${CHAR}`, label: 'TransmuteHistoryTracker legacy key' },
    // NO_CHARACTER's pre-login sessions live at the bare legacy key
    { store: 'alchemyHistory', key: 'transmuteSessions', label: 'TransmuteHistoryTracker legacy key' },

    // alchemy/decompose-history-tracker.js — chunked, daily buckets
    {
        store: 'alchemyHistory',
        key: `decomposeSessionsRec_${CHAR}_2026-01-15`,
        label: 'DecomposeHistoryTracker records',
    },
    { store: 'alchemyHistory', key: `decomposeSessions_${CHAR}`, label: 'DecomposeHistoryTracker legacy key' },

    // alchemy/coinify-history-tracker.js — chunked, daily buckets
    { store: 'alchemyHistory', key: `coinifySessionsRec_${CHAR}_2026-01-15`, label: 'CoinifyHistoryTracker records' },
    { store: 'alchemyHistory', key: `coinifySessions_${CHAR}`, label: 'CoinifyHistoryTracker legacy key' },

    // Every `ChunkedHistory` also keeps a per-character record of what the user
    // has DELETED, so a pull cannot hand a deleted entry back (see
    // `utils/chunked-history.js`). The key is `<recordPrefix>Tomb_<charId>`
    // rather than `<recordPrefix>_tomb_<charId>` precisely so the record
    // matcher cannot claim it as well — an overlap here would hand a tombstone
    // map to the array union, which would read it as "not an array" and take
    // the remote copy whole, which is the deletion coming back.
    { store: 'xpHistory', key: `skillCheckpointRecTomb_${CHAR}`, label: 'SkillCheckpoints deletions' },
    { store: 'xpHistory', key: `abilityCheckpointRecTomb_${CHAR}`, label: 'AbilityCheckpoints deletions' },
    { store: 'lootLogHistory', key: `lootLogRecTomb_${CHAR}`, label: 'LootLogHistory deletions' },
    { store: 'networthHistory', key: `networthSeriesTomb_${CHAR}`, label: 'NetworthHistory deletions' },
    { store: 'networthHistory', key: `chestOpenRecTomb_${CHAR}`, label: 'ChestOpenings deletions' },
    { store: 'networthHistory', key: `prodIncomeRecTomb_${CHAR}`, label: 'ProductionIncome deletions' },
    { store: 'rerollSpending', key: `taskCompletionRecTomb_${CHAR}`, label: 'TaskCompletionTracker deletions' },
    { store: 'alchemyHistory', key: `transmuteSessionsRecTomb_${CHAR}`, label: 'TransmuteHistoryTracker deletions' },
    { store: 'alchemyHistory', key: `decomposeSessionsRecTomb_${CHAR}`, label: 'DecomposeHistoryTracker deletions' },
    { store: 'alchemyHistory', key: `coinifySessionsRecTomb_${CHAR}`, label: 'CoinifyHistoryTracker deletions' },
];

describe('every registered store is disjoint over the real key corpus', () => {
    test('no key in the corpus is claimed by more than one registration', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        for (const { store, key } of corpus) mergeForKey(store, key);

        // mergeForKey() only ever warns when a second registration also
        // matched a key it had already resolved — see its own doc comment.
        // Silence across the whole corpus is the disjointness property.
        if (warnSpy.mock.calls.length > 0) {
            throw new Error(
                `Overlapping sync-merge registrations:\n${warnSpy.mock.calls.map((call) => call[0]).join('\n')}`
            );
        }

        warnSpy.mockRestore();
    });
});

describe('every additive history is reachable by its real key shape', () => {
    test.each(corpus.filter((entry) => entry.label !== null))(
        '$store/$key resolves to "$label"',
        ({ store, key, label }) => {
            expect(mergeForKey(store, key)?.label).toBe(label);
        }
    );
});

describe('lookalike keys are not swept up by a broader matcher', () => {
    test.each(corpus.filter((entry) => entry.label === null))('$store/$key has no merge', ({ store, key }) => {
        expect(mergeForKey(store, key)).toBeNull();
    });
});

/**
 * The corpus above is a list someone has to remember to add to, and the cost of
 * forgetting is silent: a new additive record simply gets overwritten on a pull,
 * with nothing failing anywhere. Twice now that has shipped and been found only
 * by an audit.
 *
 * So the last check is not about the registry at all — it is about the source.
 * `createChunkedHistory` registers itself, so a chunked history cannot be
 * forgotten; `createPersistedRecord` cannot, because the fold belongs to the
 * feature and the registry deliberately does not import features. That leaves
 * exactly one shape that can go missing, and it is greppable: a module that
 * calls `createPersistedRecord` and never calls `registerSyncMerge`.
 *
 * `createCuratedRecord` is not in scope. A curated record is one the user
 * edits — deletions are meaningful, and a union would resurrect them — so
 * whole-key replacement is the correct pull behaviour for it, which is the
 * distinction `persisted-record.js` draws between the two constructors.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Modules that build a `createPersistedRecord` and do not themselves call
 * `registerSyncMerge`, each with the reason that is right.
 *
 * Two shapes qualify, and only two: the key is registered by another module
 * that owns the fold, or a whole-key write really is the correct pull
 * behaviour. Anything else on this list is the data-loss bug wearing a
 * comment, so each entry names which of the two it is.
 * @type {Record<string, string>}
 */
const UNREGISTERED_ON_PURPOSE = {
    // Registered by `utils/chest-tally.js`, which owns `mergeStoredTally` and
    // claims `settings/treasureTally` for it — the tracker imports that fold
    // rather than declaring a second claim on the same key, which the registry
    // would report as an overlap. The key is in the corpus above.
    'features/inventory/treasure-tracker.js': 'registered by utils/chest-tally.js, which owns the fold',

    // A price cache with a max age, refilled from the marketplace within
    // minutes of a pull. There is nothing in it a device can be the only
    // holder of, and its fold is newest-wins on the writing device's clock —
    // which is the one merge shape that a skewed clock could get wrong.
    'features/market/mooket/market-price-store.js': 'a self-refilling price cache, not a history',
};

/**
 * Every `.js` file under `src`, tests excluded.
 * @param {string} directory - Absolute path to walk
 * @param {Array<string>} out - Accumulator of paths relative to `src`
 * @returns {Array<string>} `out`
 */
function collectSources(directory, out = []) {
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            collectSources(full, out);
            continue;
        }
        if (!entry.endsWith('.js') || entry.includes('.test.')) continue;
        out.push(full.slice(SRC.length).replace(/[\\]/g, '/'));
    }
    return out;
}

/**
 * Which stores some module actually registers a fold for, read off `src`.
 *
 * `registerSyncMerge({store: X, …})` names its store as a literal or as a
 * module constant, so both forms are resolved: a quoted value is taken as is,
 * an identifier is looked up against that same file's `const NAME = '…'`.
 * A `this.storeName` is skipped, which is why this is only half the witness:
 * `createChunkedHistory` registers on behalf of its caller and names the store
 * through a parameter, so the chunked stores are invisible here and the corpus
 * above is what speaks for them.
 * @returns {Set<string>} Store names with at least one registration
 */
function storesWithRegistrations() {
    const found = new Set();
    for (const relative of collectSources(SRC)) {
        const source = readFileSync(join(SRC, relative), 'utf8');
        if (!source.includes('registerSyncMerge')) continue;
        for (const match of source.matchAll(/registerSyncMerge\(\{[^}]*?\bstore:\s*([A-Za-z0-9_$.]+|'[^']+')/gs)) {
            const raw = match[1];
            if (raw.startsWith("'")) {
                found.add(raw.slice(1, -1));
                continue;
            }
            const constant = source.match(new RegExp(String.raw`\bconst ${raw} = '([^']+)'`));
            if (constant) found.add(constant[1]);
        }
    }
    return found;
}

/**
 * Every object store `core/storage.js` creates, and what claims it.
 *
 * The `createPersistedRecord` grep below is a guard on one SHAPE, and the
 * dungeon run history walked straight past it: it is not a persisted record and
 * not a chunked history, just a module holding a list in its own object store
 * and writing it with `storage.setJSON`. Nothing looked at it, so `unifiedRuns`
 * carried no registration at all and every `everything`-scope pull overwrote
 * the whole run history — data loss with nobody deleting anything, on a store
 * the source-shape guard was structurally incapable of noticing.
 *
 * The store argument is usually a constant or `this.storeName`, so no grep over
 * the source can tell which store a write lands in. What CAN be checked is the
 * registry: a dedicated store exists to hold one feature's records, so a
 * dedicated store with no registration at all is the hole this closes.
 *
 * A store that legitimately holds nothing mergeable says so here, with the
 * reason. `null` means "something claims this store" — witnessed either by a
 * readable `registerSyncMerge({store: …})` in the source or by an entry in the
 * corpus above, since neither witness alone sees every registration. Both take
 * a deliberate act, which is the point: the store nobody thought about at all
 * is the one that fails.
 * @type {Record<string, string|null>}
 */
const STORE_CLAIMS = {
    settings: null,
    marketListings: null,
    combatStats: null,
    xpHistory: null,
    alchemyHistory: null,
    labyrinth: null,
    guildHistory: null,
    networthHistory: null,
    leaderboardHistory: null,
    lootLogHistory: null,
    rerollSpending: null,
    unifiedRuns: null,

    // Superseded by `unifiedRuns`: the dungeon tracker reads these two on
    // migration and never writes them again, so there is nothing a pull can
    // lose that the unified list does not already hold.
    dungeonRuns: 'legacy pre-unification run stores, read-only since the migration',
    teamRuns: 'legacy pre-unification run stores, read-only since the migration',

    // A hand-triggered export blob and a rolling debug snapshot ring. Neither
    // is a history anyone can be the sole holder of, and both are rewritten
    // whole by the next export or snapshot.
    combatExport: 'a hand-triggered export blob, rewritten whole by the next export',
    queueSnapshots: 'a rolling debug snapshot ring, rewritten whole as it turns over',

    // Curated by the user: what is in a collection is what they put there, so
    // deletions are meaningful and whole-key replacement is the correct pull.
    collections: 'user-curated, so a union would resurrect what they removed',
};

describe('a dedicated object store cannot go entirely unclaimed', () => {
    test('every store core/storage.js creates is claimed or excused', () => {
        const storageSource = readFileSync(join(SRC, 'core/storage.js'), 'utf8');
        const stores = [...storageSource.matchAll(/createObjectStore\('([A-Za-z]+)'/g)].map((match) => match[1]);
        expect(stores.length).toBeGreaterThan(10);

        const unlisted = stores.filter((store) => !(store in STORE_CLAIMS));
        expect(unlisted, 'New object stores must be listed in STORE_CLAIMS above').toEqual([]);

        const claimed = storesWithRegistrations();
        for (const entry of corpus) if (entry.label !== null) claimed.add(entry.store);
        const unclaimed = stores.filter((store) => STORE_CLAIMS[store] === null && !claimed.has(store));
        expect(
            unclaimed,
            "These stores hold a feature's records and claim no sync merge, so an `everything`-scope pull " +
                'overwrites them whole. Register the fold the feature owns, or say here why a whole-key write ' +
                'is right for the store.'
        ).toEqual([]);
    });
});

describe('a new additive record cannot be forgotten by the registry', () => {
    test('every createPersistedRecord module registers a sync merge', () => {
        const missing = [];

        for (const relative of collectSources(SRC)) {
            if (relative === 'utils/persisted-record.js') continue;
            const source = readFileSync(join(SRC, relative), 'utf8');
            if (!source.includes('createPersistedRecord(')) continue;
            if (source.includes('registerSyncMerge')) continue;
            if (relative in UNREGISTERED_ON_PURPOSE) continue;
            missing.push(relative);
        }

        expect(
            missing,
            'These modules keep an additive record that a cross-device sync pull would overwrite whole. ' +
                'Call registerSyncMerge() with the fold the record already owns, add its key shapes to the ' +
                'corpus above, ' +
                'or — if a whole-key write really is right for it — say why in UNREGISTERED_ON_PURPOSE.'
        ).toEqual([]);
    });

    test('the deliberate exceptions still exist and still build a persisted record', () => {
        // An exception that has been renamed or converted to a curated record is
        // a licence nobody is using any more, and it would silently cover a
        // future file that lands on the same path
        for (const relative of Object.keys(UNREGISTERED_ON_PURPOSE)) {
            const source = readFileSync(join(SRC, relative), 'utf8');
            expect(source, `${relative} no longer builds a persisted record`).toContain('createPersistedRecord(');
        }
    });
});
