#!/usr/bin/env node
/**
 * Bundle-sharing check.
 *
 * The production build splits the script into several iife bundles, and any
 * `src/utils/**` module that two bundles both reach is silently copied into
 * each of them unless `rollup.config.js` declares it external (the
 * `utilsExternalGlobals` map) and `src/libraries/utils.js` exports it. Two
 * copies means divergent state — the config's own comments record the
 * casualties (duplicated watch timers, stale geometry caches, a second toast
 * stack) — and nothing used to notice until a panel misbehaved.
 *
 * The same hazard exists for `src/core/**`, whose modules are constructed
 * singletons meant to be reached through `Toolasha.Core.*` — a second copy
 * there registers a second set of WebSocket/DOM observers and runs a second
 * state machine.
 *
 * This script makes the rule executable: it walks the static import graph from
 * every production bundle entry, using the same `external` predicates the
 * build itself uses, and fails loudly on any module under a policed prefix
 * (see POLICED_PREFIXES) that ends up bundled inline into two or more bundles
 * without being allowlisted.
 *
 * What "inline" means here: a module an `external` predicate exempts is not
 * traversed for that bundle — it arrives at runtime through the shared
 * `Toolasha.*` global, which is the whole point. A module the predicate does
 * not exempt is compiled into the bundle, so reaching it from two bundles is
 * two copies.
 *
 * Deliberately out of scope:
 * - `?worker` imports: a Web Worker is its own realm with no `window.Toolasha`,
 *   so its graph is bundled inline per worker by design and cannot share.
 * - `?raw` imports: CSS text, no graph behind it.
 * - bare specifiers (node_modules): vendored per bundle on purpose; only
 *   `src/utils/**` sharing is this script's business.
 * - `rollup.config.enhancement.js`: the standalone enhancement build is a
 *   separate script, not one of the cooperating production bundles.
 *
 * Run standalone: `node scripts/check-bundle-sharing.mjs`
 * Wired into: `npm run build` (runs before rollup).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, normalize, relative, basename } from 'path';
import { fileURLToPath } from 'url';
import { init as initLexer, parse as parseModule } from 'es-module-lexer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

/**
 * Modules that are allowed to be bundled inline into more than one bundle.
 *
 * Every entry needs a justification. The bar: the module must be stateless by
 * design (constants or pure functions, no module-level mutable state, no DOM
 * or storage side effects at import time), so a second copy is only weight —
 * never a second, divergent truth. Anything stateful belongs in the externals
 * map instead.
 *
 * Keys are project-relative paths with forward slashes.
 */
/**
 * Stateful feature modules that must never be carried inline by two bundles.
 *
 * The sweep below polices only POLICED_PREFIXES — feature modules can and do get
 * duplicated freely, and most of that is benign (dead fallback copies behind
 * bundle-bridge accessors, or pure math). These are the ones a second copy has
 * actually broken: each holds module-level state that a user-facing surface in
 * another bundle read or wrote through the wrong copy (the Treasure tile drew
 * blank from a never-initialized duplicate; the settings scroll popup saved
 * emptiness over the real record; the tax toggle flipped a flag nothing read).
 * Each is in an externals map now; this list keeps a future import from
 * quietly re-inlining one.
 *
 * Keys are project-relative paths with forward slashes.
 */
const SINGLE_COPY_FEATURES = new Set([
    'src/features/inventory/treasure-tracker.js',
    'src/features/combat-stats/sales-tax-view.js',
    'src/features/combat/combat-record-control.js',
    'src/features/combat/scroll-simulator-ui.js',
    'src/features/market/network-alert.js',
    // The inventory badge pipeline: registered providers, the processed-item set
    // and the price caches the dots, category totals and custom tabs all read.
    // The sim bundle used to reach it through combat-sim-ui's bundled watchlist
    // fallback and carry a second copy — dead only because every live inventory
    // surface happens to sit in the market bundle. That fallback is gone; this
    // keeps a future import from quietly bringing the copy back.
    'src/features/inventory/inventory-badge-manager.js',
    // Reached the same way, and stateful for the same reason: the watchlist's
    // entries, zones and chests live at module scope, and only the market
    // bundle's copy backs the panel. Cross-bundle callers use the bridge.
    'src/features/inventory/watchlist.js',
    'src/features/inventory/equipment-savings-row.js',
]);

const ALLOWLIST = new Map([
    [
        'src/utils/combat-actions.js',
        // Pure functions over the actions array they are handed, no module
        // state. Imported wherever a feature asks "which action is running" —
        // combat, sim, actions, alchemy, tasks, character-activity and the
        // queue monitor; every copy picks the same running action.
        'stateless running-action selectors; no module state to share',
    ],
    [
        'src/utils/yield-to-browser.js',
        // One exported function, closes over nothing: a duplicated copy
        // behaves identically to a shared one.
        'stateless single-function macrotask yield; no module state to share',
    ],
    [
        'src/utils/async-pool.js',
        // One exported function over its own arguments, no module state; the
        // politeness bound it enforces is per call site, so two copies bound
        // their own sweeps identically to one.
        'stateless single-function concurrency pool; no module state to share',
    ],
    [
        'src/utils/game-server.js',
        // Pure hostname checks (isTestServer and friends), no module state.
        // Imported by core/settings-schema.js to hide a test-server-only
        // setting off the test server; core loads before utils so it cannot
        // reach Toolasha.Utils.gameServer — the copy in core is harmless.
        'stateless hostname predicates; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/market-listings.js',
        // One exported pure function (mergeMarketListings), no module state.
        // Imported by core/data-manager.js, and the core bundle loads before
        // the utils bundle so it cannot reference Toolasha.Utils.* — the copy
        // in core is unavoidable and harmless.
        'stateless pure function; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/scroll-buff-values.js',
        // Exported constants only. Same core-loads-first situation as
        // market-listings: data-manager needs it before the utils bundle exists.
        'constants only; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/bundle-bridge.js',
        // Null-safe accessors over window.Toolasha with no state of their own —
        // every call reads the live namespace, so each copy gives identical
        // answers. core/settings-schema.js uses it and core loads before the
        // utils bundle, so the copy in core is unavoidable.
        'stateless accessors over the live namespace; core loads before utils and must carry its own copy',
    ],
    [
        'src/utils/panel-minimize.js',
        // attachMinimize is a pure factory: all its state is per-call closure
        // state on the panel it is given, and the only persistence goes through
        // panel-geometry (itself a shared external, so one source of truth). No
        // module-level mutable state, no import-time side effects. Imported by
        // panels across every bundle, so a copy in each is only weight.
        'stateless factory; persistence delegated to the shared panel-geometry global',
    ],
    [
        'src/utils/class-inference.js',
        // Constants (the bucket table) and pure functions over arguments the
        // caller owns: newCastLog hands back a plain object, noteCast mutates
        // the one it is given, and inferClass reads game data passed in. No
        // module-level mutable state and no import-time side effects — the
        // accumulated evidence lives on guildTrialAbilities, which is a single
        // instance in the combat bundle. The trial panels are in the ui bundle
        // and the trial stream is in combat, so both reach it.
        'constants and pure functions; the accumulated state lives on the caller, not here',
    ],
    [
        'src/utils/item-picker-pins.js',
        // togglePin/orderTiles/sameOrder/mergePins each take their bucket map
        // or tile list as an argument and return a new value; nothing is kept
        // between calls. Used by alchemy item pins (actions bundle) and
        // enhancement item pins (ui bundle).
        'pure functions operating only on their arguments; no module state',
    ],
    [
        'src/utils/item-selector-dom.js',
        // tileItemHrid/menuTiles read the DOM node handed to them and nothing
        // else; MENU_SELECTOR/TILE_SELECTOR are constants. Used by the
        // alchemy and enhancement item selector finders (actions and ui
        // bundles respectively).
        'pure functions and constants; no module state',
    ],
]);

/**
 * Directory prefixes the sweep polices.
 *
 * `src/utils` is the historical scope. `src/core` joined it because the same
 * failure lives there and is worse: every module under it is a constructed
 * singleton exported as a default instance, so a second copy is a second
 * observer registration and a second state machine — not merely extra weight.
 * The core bundle loads first and every later bundle is meant to reach these
 * through `Toolasha.Core.*` (coreExternalGlobals in rollup.config.js), so the
 * fix for a violation here is always the externals map, never the allowlist.
 *
 * Paths use forward slashes.
 */
const POLICED_PREFIXES = ['src/utils/', 'src/core/'];

/** Import suffixes handled by custom rollup plugins; their targets are not part of the shared JS graph */
const PLUGIN_SUFFIXES = ['?raw', '?worker'];

/**
 * Extract static import/re-export specifiers from a module's source.
 * @param {string} filePath - Absolute path of the module
 * @returns {string[]} Raw specifiers as written
 */
function importSpecifiers(filePath) {
    const source = readFileSync(filePath, 'utf-8');
    const [imports] = parseModule(source, filePath);
    const specifiers = [];
    for (const record of imports) {
        // record.n is the specifier when statically analysable; dynamic
        // import(expr) has no n and the codebase has none in src/
        if (record.n) specifiers.push(record.n);
    }
    return specifiers;
}

/**
 * Resolve a specifier relative to its importer, or null when it is not part
 * of the bundled project graph (bare, virtual, or plugin-suffixed).
 * @param {string} specifier - As written in the import statement
 * @param {string} importer - Absolute path of the importing module
 * @returns {string|null} Absolute path, or null to skip
 */
function resolveSpecifier(specifier, importer) {
    if (PLUGIN_SUFFIXES.some((suffix) => specifier.endsWith(suffix))) return null;
    if (!specifier.startsWith('.')) return null; // bare (node_modules) or virtual: module
    const resolved = normalize(join(dirname(importer), specifier));
    if (!existsSync(resolved)) {
        console.warn(`[check-bundle-sharing] Unresolvable import '${specifier}' in ${relative(projectRoot, importer)}`);
        return null;
    }
    return resolved;
}

/**
 * Walk one bundle's import graph, honoring its external predicate.
 * @param {string} entry - Absolute path of the bundle entry module
 * @param {(id: string) => boolean} isExternal - The bundle's external predicate
 * @returns {Set<string>} Absolute paths of every module bundled inline
 */
function walkBundle(entry, isExternal) {
    const inline = new Set();
    const queue = [entry];
    while (queue.length > 0) {
        const current = queue.pop();
        if (inline.has(current)) continue;
        inline.add(current);
        for (const specifier of importSpecifiers(current)) {
            const resolved = resolveSpecifier(specifier, current);
            if (!resolved) continue;
            if (isExternal(resolved)) continue; // arrives via the shared global
            if (!inline.has(resolved)) queue.push(resolved);
        }
    }
    return inline;
}

async function main() {
    await initLexer;

    // The real build config, so the check can never drift from what rollup
    // actually does. BUILD_MODE selects the multi-bundle production array.
    process.env.BUILD_MODE = 'production';
    const configs = (await import('../rollup.config.js')).default;
    if (!Array.isArray(configs)) {
        console.error('[check-bundle-sharing] Expected the production config array from rollup.config.js');
        process.exit(2);
    }

    // module path -> Set of bundle names that carry it inline
    const inlineIn = new Map();

    for (const config of configs) {
        const entry = normalize(join(projectRoot, config.input));
        const bundleName = basename(config.input, '.js');
        const isExternal = typeof config.external === 'function' ? config.external : () => false;
        for (const modulePath of walkBundle(entry, isExternal)) {
            const relPath = relative(projectRoot, modulePath).split('\\').join('/');
            if (!POLICED_PREFIXES.some((prefix) => relPath.startsWith(prefix)) && !SINGLE_COPY_FEATURES.has(relPath))
                continue;
            if (!inlineIn.has(relPath)) inlineIn.set(relPath, new Set());
            inlineIn.get(relPath).add(bundleName);
        }
    }

    const violations = [];
    for (const [modulePath, bundles] of inlineIn) {
        if (bundles.size < 2) continue;
        // The single-copy feature list takes no allowlisting — an entry there
        // is stateful by definition and belongs in an externals map
        if (ALLOWLIST.has(modulePath) && !SINGLE_COPY_FEATURES.has(modulePath)) continue;
        violations.push({ modulePath, bundles: [...bundles].sort() });
    }
    violations.sort((a, b) => a.modulePath.localeCompare(b.modulePath));

    if (violations.length > 0) {
        console.error('');
        console.error('[check-bundle-sharing] FAILED: shared modules duplicated across production bundles.');
        console.error('');
        for (const { modulePath, bundles } of violations) {
            console.error(`  ${modulePath}`);
            console.error(`      bundled inline into: ${bundles.join(', ')}`);
        }
        console.error('');
        console.error('Each bundle above carries its own copy, with its own module state.');
        console.error('Fix by sharing one copy (the liquidity-cap entry is the precedent):');
        console.error('  1. add the module to utilsExternalGlobals in rollup.config.js, and');
        console.error('  2. import + export it in src/libraries/utils.js so the global exists.');
        console.error('A src/core module uses coreExternalGlobals and src/libraries/core.js instead.');
        console.error('When the second bundle loads BEFORE the owning one, it cannot reference the');
        console.error('global at all — cut the import instead and read the owner through');
        console.error('src/utils/bundle-bridge.js at call time.');
        console.error('Only a module that is stateless by design may instead be allowlisted');
        console.error('in scripts/check-bundle-sharing.mjs, with a justification.');
        console.error('');
        process.exit(1);
    }

    console.log(
        `[check-bundle-sharing] OK: no unshared cross-bundle src/utils or src/core modules (${inlineIn.size} checked).`
    );
}

await main();
