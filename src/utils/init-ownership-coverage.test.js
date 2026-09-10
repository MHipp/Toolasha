/**
 * The standing guard over the character-switch race in feature `initialize()`.
 *
 * Twenty-six sites have been fixed by hand across five commits. Every one of
 * them was the same shape: an `initialize()` that suspends on a storage read,
 * a `character_switching` teardown that lands inside the read, and a resumed
 * tail that registers listeners, observers or timers into fields the teardown
 * has just nulled — one live, unremovable registration per switch, for as long
 * as the tab lives. `utils/init-ownership.js` is the fix; three hand surveys
 * are how the sites were found. Nothing found by a hand survey stops site #27
 * being written next week, which is what this file is for.
 *
 * It is a source-text scan, in the idiom of the `notForwarded` block in
 * `src/entrypoint.test.js`: there is no parser in `package.json` and adding one
 * to answer a question this shape can answer is not worth the dependency.
 *
 * ## What it does
 *
 * Extracts the body of every `async initialize/init/start/register` under
 * `src/features` by brace matching, and flags one where a registration-shaped
 * call appears textually **after the first `await`** with no ownership marker
 * anywhere in the body. A flagged body must either grow a marker or earn an
 * entry in `KNOWN_SAFE` below.
 *
 * ## What it cannot do — read this before trusting a pass
 *
 * The scan is textual, not semantic. Specifically:
 *
 * - It cannot see through a helper that registers on the module's behalf. A
 *   tail calling `this._wireEverything()` reads as clean unless the call itself
 *   happens to match a registration shape by name.
 * - It cannot follow a registration into a function called from the tail rather
 *   than written inline in it.
 * - It cannot tell a live registration from an idempotent one. Every entry in
 *   `KNOWN_SAFE` exists because a human read the downstream code and the scan
 *   could not.
 * - `stripNestedAsync` removes nested `async` callbacks before looking for the
 *   first `await`, so an `await` inside a `run: async () => {…}` handed to
 *   `registerCommand` is correctly not treated as a suspension point of the
 *   initializer. A non-async nested function cannot contain `await` at all. An
 *   `(async () => {…})()` IIFE is deliberately *not* stripped — that is the
 *   initializer's own work, not a callback.
 * - Comments and string literals are blanked first, so prose about awaits does
 *   not read as an await. Regex literals are not, so a `/` opening one could in
 *   principle confuse the string pass; nothing under `src/features` does today.
 * - Only entry points declared `async` are candidates. A synchronous
 *   `initialize()` cannot suspend, whatever its callbacks await.
 *
 * A pass therefore means "nothing matching the shape we know how to see", not
 * "no races". The per-site `*.switch-race.test.js` files are what prove a
 * specific fix; this proves nobody added a new site of the known shape.
 *
 * ## Why the self-test at the bottom exists
 *
 * A refactor that silently breaks one of these regexes leaves a test that
 * passes forever and detects nothing — the exact failure mode the whole
 * exercise is about. So the matcher is driven against inline fixtures with
 * known-bad and known-good shapes, and against the real pre-fix source of an
 * already-fixed site pulled out of git.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

/**
 * Lifecycle entry points, restricted to the ones declared `async`.
 *
 * A synchronous `initialize()` cannot suspend, so it cannot be interrupted by a
 * teardown however many `await`s appear inside the callbacks it registers —
 * `labyrinth-clear-rate.js` is the live example, and matching it produced a
 * flag with nothing behind it.
 */
const LIFECYCLE_ENTRY =
    /(?:^|[\s;{},])(?:async\s+(initialize|init|start|register)\s*\([^()]*\)|(initialize|init|start|register)\s*[:=]\s*async\s*(?:function\s*)?\([^()]*\)\s*(?:=>)?)\s*\{/g;

/**
 * Shapes that mean "something live was just wired up".
 *
 * Derived from what the 26 fixed sites actually registered after their await —
 * not from a general idea of what registration looks like. Each one is
 * load-bearing: dropping `\.push\s*\(` loses the five array-shaped sites of
 * `a104def79`, dropping the handler-assignment shape loses `networth`,
 * `bulk-sell-assistant`, `trade-ledger-store` and `combat-stats-data-collector`.
 */
const REGISTRATION_SHAPES = [
    /\.addEventListener\s*\(/,
    /\bnew\s+\w*Observer\s*\(/,
    /\.observe\s*\(/,
    /\.(?:on|once|subscribe)\s*\(/,
    /\.on[A-Z]\w*\s*\(/,
    /\b(?:setInterval|setTimeout|requestAnimationFrame|requestIdleCallback)\s*\(/,
    /\.push\s*\(/,
    /\b(?:register|setup|install|attach|mount|bind|watch|listen)[A-Z]\w*\s*\(/,
    /\b\w*(?:Handler|Listener|Observer|Interval|Timer|Cleanup|Unsubscribe)s?\s*=[^=]/,
];

/**
 * What counts as the site having thought about ownership.
 *
 * `captureOwner`/`stillOurs` is the shared helper. `_stillOurs` and a
 * `generation` counter are the hand-rolled pairs that predate it —
 * `treasure-tracker.js` proved the shape and `estimated-listing-age.js` and
 * `action-timing-monitor.js` still carry their own; they are legitimately fine
 * and must not be forced to adopt the helper just to quiet a test.
 */
const OWNERSHIP_MARKER = /(?:captureOwner|stillOurs|_stillOurs|_?generation)\b/;

/**
 * Blank out comments and string literals, preserving every index and newline.
 *
 * Not optional politeness: `guild-trials.js` has a comment reading "before its
 * first `await`" sitting above the registrations it is explaining, and without
 * this pass that comment *is* the first await the scan finds — the site reads
 * as an offender because of the sentence documenting why it is not one. The
 * same pass keeps a `captureOwner` named only in prose from counting as a
 * marker.
 *
 * Regex literals are left alone. A `/` that opens one is indistinguishable from
 * division without parsing, and the failure mode of guessing wrong (swallowing
 * real code up to the next `/`) is worse than the failure mode of not trying.
 * @param {string} source - Any JavaScript text
 * @returns {string} The same text with comments and string bodies spaced out
 */
function stripCommentsAndStrings(source) {
    const out = source.split('');
    const blank = (from, to) => {
        for (let i = from; i < to && i < out.length; i++) {
            if (out[i] !== '\n') out[i] = ' ';
        }
    };

    for (let i = 0; i < source.length; i++) {
        const two = source.slice(i, i + 2);
        if (two === '//') {
            const end = source.indexOf('\n', i);
            blank(i, end < 0 ? source.length : end);
            i = end < 0 ? source.length : end;
        } else if (two === '/*') {
            const end = source.indexOf('*/', i + 2);
            blank(i, end < 0 ? source.length : end + 2);
            i = end < 0 ? source.length : end + 1;
        } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
            const quote = source[i];
            let j = i + 1;
            while (j < source.length) {
                if (source[j] === '\\') j += 2;
                else if (source[j] === quote) break;
                else j++;
            }
            blank(i, Math.min(j + 1, source.length));
            i = j;
        }
    }
    return out.join('');
}

/**
 * Blank out nested `async` function bodies so their `await`s are not mistaken
 * for the initializer's own suspension point.
 *
 * Replaced with spaces rather than removed, so every index into the result is
 * still an index into the original body and line numbers stay honest.
 * @param {string} body - An entry point's body text
 * @returns {string} The body with nested async bodies blanked
 */
function stripNestedAsync(body) {
    let out = body;
    let from = 0;
    for (;;) {
        const match = /\basync\b/.exec(out.slice(from));
        if (!match) break;
        const at = from + match.index;
        const open = out.indexOf('{', at);
        if (open < 0) break;
        const end = matchingBrace(out, open);
        if (end < 0) break;
        // An immediately-invoked `(async () => { … })()` is not a callback —
        // it *is* the initializer's own work, moved inside a promise the tail
        // then awaits (`action-panel-sort.js`). Blanking it would hide every
        // registration it makes.
        if (/^\s*\)\s*\(/.test(out.slice(end + 1))) {
            from = at + 5;
            continue;
        }
        out = out.slice(0, at) + ' '.repeat(end + 1 - at) + out.slice(end + 1);
        from = at;
    }
    return out;
}

/**
 * @param {string} source - Text to scan
 * @param {number} open - Index of an opening brace
 * @returns {number} Index of its matching close brace, or -1
 */
function matchingBrace(source, open) {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * @param {string} text - A body, already stripped of nested async bodies
 * @returns {{index: number, text: string}|null} The earliest registration-shaped match
 */
function firstRegistration(text) {
    let best = null;
    for (const shape of REGISTRATION_SHAPES) {
        const match = shape.exec(text);
        if (match && (best === null || match.index < best.index)) {
            best = { index: match.index, text: match[0].trim() };
        }
    }
    return best;
}

/**
 * Every lifecycle entry point in one file that registers after its first await.
 *
 * The single seam the whole file runs through — the real scan, the self-test
 * and the pre-fix regression check all call this, so a regex that stops working
 * fails all three rather than silently passing the first.
 * @param {string} source - A module's source text
 * @returns {Array<{method: string, line: number, registration: string, hasMarker: boolean}>} Findings
 */
export function scanForLateRegistration(original) {
    const source = stripCommentsAndStrings(original);
    const found = [];
    LIFECYCLE_ENTRY.lastIndex = 0;
    let match;
    while ((match = LIFECYCLE_ENTRY.exec(source))) {
        const brace = match.index + match[0].length - 1;
        const close = matchingBrace(source, brace);
        if (close < 0) continue;
        const body = source.slice(brace + 1, close);

        const awaitIndex = stripNestedAsync(body).search(/\bawait\b/);
        if (awaitIndex < 0) continue;

        const registration = firstRegistration(body.slice(awaitIndex));
        if (!registration) continue;

        const absolute = brace + 1 + awaitIndex + registration.index;
        found.push({
            method: match[1] || match[2],
            line: source.slice(0, absolute).split('\n').length,
            registration: registration.text,
            hasMarker: OWNERSHIP_MARKER.test(body),
        });
    }
    return found;
}

/**
 * Sites the scan flags that a human has read and cleared, each with the reason
 * it is not an oversight.
 *
 * **The reason string is mandatory, and it is the whole point of the map.** A
 * bare list of paths gets padded silently — one more line is nothing to add and
 * nobody can tell later which lines were investigated. A list where every entry
 * has to be a sentence saying *what downstream code makes this safe* does not:
 * writing the sentence is the investigation, and a wrong one can be checked.
 *
 * Before adding an entry, look at what the tail registers and answer: if a
 * teardown ran while this was parked, what happens to the handle? If the answer
 * is "it is stored in a field the teardown just nulled", it is not safe — it is
 * site #27, and it wants a ticket from `init-ownership.js`, not a line here.
 *
 * Keyed `<path from repo root>#<method>`.
 */
const KNOWN_SAFE = {
    'src/features/account/index.js#initialize':
        'Both post-await registrations replace by key rather than accumulate — `registerCommand` swaps ' +
        'the entry with the same name and `registerRow` the row with the same key — and the briefing ' +
        'listener is deliberately registered once and never removed, so a switch outlives it by design.',
    'src/features/actions/action-panel-sort.js#initialize':
        'Nothing calls `disable()` on this module at all; it self-manages across switches with its own ' +
        '`character_switching`/`character_initialized` listeners, each installed behind an ' +
        '`if (!this.handlers.x)` guard that makes a resumed tail a no-op.',
    'src/features/actions/tea-recommendation.js#initialize':
        '`actionFilter.initialize()` contains no `await` of its own, so this yields a single microtask ' +
        'tick and no teardown interleaves at that granularity — an invariant living in another file, ' +
        'which is why the site carries a comment saying to add a ticket if an await ever appears there.',
    'src/features/chat/chat-commands.js#initialize':
        'The post-await `dataManager.on` sits behind a module-level `switchListenerRegistered` flag that ' +
        'is never cleared, so the listener is installed exactly once for the life of the tab.',
    'src/features/combat/dungeon-tracker-chat-annotations.js#initialize':
        'The tail unregisters the previous handler before installing its own ' +
        '(`if (this.characterSwitchingHandler) dataManager.off(...)`), and `waitForChat()` is idempotent, ' +
        'so a resumed tail replaces rather than orphans.',
    'src/features/enhancement/enhancement-feature.js#initialize':
        '`setupEnhancementHandlers()` registers module-level named functions through `webSocketHook.on`, ' +
        'which dedupes on `handlers.includes(handler)` — the same reference cannot be registered twice, ' +
        'so a resumed tail adds nothing for `cleanupEnhancementHandlers()` to miss.',
    'src/features/guild/guild-trial-abilities-ui.js#initialize':
        'The tail explicitly `webSocketHook.off`s any previous `onTrialTick` before installing the new ' +
        'one, over a module-level singleton, so at most one registration exists at any time.',
    'src/features/house/house-panel-observer.js#initialize':
        '`cleanup()` replaces `this.cleanupRegistry` with a fresh registry rather than nulling it, so a ' +
        "resumed tail's unregister handle lands in the live registry and the next teardown removes it; " +
        'the observer it installs holds no character-scoped state.',
    'src/features/insights/index.js#initialize':
        '`registerCalibrationRow()` calls `registerRow({key: "predictionCalibration"})`, which replaces ' +
        'the row with that key rather than appending, so a resumed tail cannot leave a second one.',
    'src/features/ironcow/ironcow-panel.js#initialize':
        '`registerCommand` replaces by name, and `show()` returns early when `this.panel` is already in ' +
        'the document — so the tail can leave at most the one panel `this.panel` points at, which ' +
        '`disable()` removes.',
    'src/features/market/market-history-viewer.js#initialize':
        'The tail calls `this.unsubscribeMarkers?.()` before resubscribing, which is a deliberate guard ' +
        'against exactly this race and is documented as such at the call site.',
    'src/features/market/mooket/market-price-store.js#initialize':
        'Its record is `createPersistedRecord({scoped: false})` — global rather than character-scoped, ' +
        'so a switch has no meaning for it and there is no per-character layer to register against.',
    'src/features/market/tooltip-consumables.js#initialize':
        '`setupObserver()` calls `tooltipObserver.subscribe("TooltipConsumables", …)`, which is a `Map` ' +
        'keyed by name (replace on resubscribe), and `addTooltipStyles()` returns early when its style ' +
        'element already exists.',
    'src/features/market/tooltip-prices.js#initialize':
        'Registers into the same name-keyed `tooltipObserver` `Map` (replace on resubscribe), and ' +
        '`installEnhancementSourceToggle()` self-guards on a module-level `_sourceToggleHandlers`.',
    'src/features/planner/goal-planner-ui.js#initialize':
        '`registerCommand` replaces by name, and the only other tail effect is `reopenIfLeftOpen` → ' +
        '`show()`, which returns early when `this.panel` is already in the document, so no second panel ' +
        'can be stranded.',
    'src/features/ui/overlay-panel.js#initialize':
        '`registerCommand` replaces by name and `show()` is guarded the same way as the other panels; ' +
        'the entry point also already has a dedicated race test in `src/entrypoint.test.js`.',
};

const REPO_ROOT = process.cwd();
const FEATURES_ROOT = resolve(REPO_ROOT, 'src/features');

/**
 * @param {string} dir - Directory to walk
 * @param {Array<string>} out - Accumulator
 * @returns {Array<string>} Every non-test `.js` file beneath `dir`
 */
function featureSources(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) featureSources(path, out);
        else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(path);
    }
    return out;
}

/**
 * @param {string} path - Absolute path
 * @returns {string} The path relative to the repo root, with forward slashes
 */
function repoPath(path) {
    return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

/**
 * The whole tree's findings, computed once.
 * @returns {Array<{site: string, line: number, registration: string, hasMarker: boolean}>} Findings
 */
function scanFeatures() {
    const findings = [];
    for (const file of featureSources(FEATURES_ROOT)) {
        const source = readFileSync(file, 'utf8');
        for (const hit of scanForLateRegistration(source)) {
            findings.push({ site: `${repoPath(file)}#${hit.method}`, ...hit });
        }
    }
    return findings;
}

describe('initialize() bodies that register after an await', () => {
    const flagged = scanFeatures().filter((finding) => !finding.hasMarker);

    test('every one of them either takes an ownership ticket or is a recorded exemption', () => {
        const offenders = flagged.filter((finding) => !(finding.site in KNOWN_SAFE));

        const report = offenders
            .map((offender) => {
                const [file, method] = offender.site.split('#');
                return (
                    `  ${file}:${offender.line} — ${method}() registers \`${offender.registration}\` ` +
                    'after its first await, with no ownership marker in the body.'
                );
            })
            .join('\n');

        expect(
            offenders.map((offender) => offender.site),
            'A character switch tears every feature down while these awaits are in flight, so a tail that ' +
                'registers afterwards can wire a listener, observer or timer into a field the teardown just ' +
                `nulled — one unremovable registration per switch.\n${report}\n` +
                'Do one of two things. If a teardown landing in that await would strand the handle: take a ' +
                'ticket — `const ticket = captureOwner(this)` before the await, `if (!stillOurs(ticket)) return;` ' +
                'after it and before the first side effect, `noteTeardown(this)` first thing in disable() — from ' +
                '`src/utils/init-ownership.js`, and add a `*.switch-race.test.js` beside the module. If the ' +
                'registration is genuinely idempotent or the module is out of the teardown path, add the site to ' +
                'KNOWN_SAFE in src/utils/init-ownership-coverage.test.js with a one-sentence reason saying which ' +
                'downstream code makes it safe. A reason you cannot write is a site that is not safe.'
        ).toEqual([]);
    });

    test('no exemption outlives the thing it exempts', () => {
        // An allowlist nobody prunes is an allowlist that hides the next
        // regression: a site that has since been fixed, renamed or deleted
        // leaves an entry that would silently absorb a *new* flag at the same
        // path.
        const live = new Set(flagged.map((finding) => finding.site));
        const stale = Object.keys(KNOWN_SAFE).filter((site) => !live.has(site));

        expect(
            stale,
            `These sites are listed as exemptions but the scan no longer flags them — they were fixed, renamed ` +
                'or deleted. Remove the entries from src/utils/init-ownership-coverage.test.js.'
        ).toEqual([]);
    });

    test.each(Object.entries(KNOWN_SAFE))('%s carries a reason, not just a path', (site, reason) => {
        // The reason is the exemption. A one-word placeholder is a padded list
        // with extra steps.
        expect(typeof reason, `${site} needs a sentence`).toBe('string');
        expect(
            reason.trim().split(/\s+/).length,
            `${site}'s reason is too short to be an investigation`
        ).toBeGreaterThan(8);
    });
});

describe('the matcher itself', () => {
    // Without this block, a refactor that breaks one of the regexes above
    // leaves a test that passes forever and detects nothing — which is the
    // exact failure mode this whole file exists to prevent.

    const BAD = `
        class Thing {
            async initialize() {
                this.isInitialized = true;
                await storage.get('key', 'store', null);
                this.updateHandler = () => this.redraw();
                dataManager.on('items_updated', this.updateHandler);
            }
        }
    `;

    const GUARDED = `
        class Thing {
            async initialize() {
                const ticket = captureOwner(this);
                await storage.get('key', 'store', null);
                if (!stillOurs(ticket)) return;
                this.updateHandler = () => this.redraw();
                dataManager.on('items_updated', this.updateHandler);
            }
        }
    `;

    const REGISTERS_FIRST = `
        class Thing {
            async initialize() {
                this.updateHandler = () => this.redraw();
                dataManager.on('items_updated', this.updateHandler);
                await storage.get('key', 'store', null);
                this.loaded = true;
            }
        }
    `;

    const NESTED_AWAIT_ONLY = `
        class Thing {
            async initialize() {
                registerCommand({
                    name: 'Do it',
                    run: async () => {
                        await this.doIt();
                    },
                });
                this.updateHandler = () => this.redraw();
                dataManager.on('items_updated', this.updateHandler);
            }
        }
    `;

    const NOT_ASYNC = `
        class Thing {
            initialize() {
                registerCommand({ name: 'Do it', run: async () => { await this.doIt(); } });
                dataManager.on('items_updated', () => this.redraw());
            }
        }
    `;

    /**
     * @param {string} source - Fixture text
     * @returns {Array<Object>} Findings the real scan would treat as offences
     */
    const offences = (source) => scanForLateRegistration(source).filter((finding) => !finding.hasMarker);

    test('a registration after an unguarded await is flagged', () => {
        const found = offences(BAD);
        expect(found).toHaveLength(1);
        expect(found[0].method).toBe('initialize');
        expect(found[0].registration).toBe('updateHandler =');
    });

    test('the same body with a ticket is not flagged', () => {
        expect(offences(GUARDED)).toEqual([]);
    });

    test('registering before the await is not flagged', () => {
        expect(offences(REGISTERS_FIRST)).toEqual([]);
    });

    test('an await inside a nested async callback is not a suspension point', () => {
        expect(offences(NESTED_AWAIT_ONLY)).toEqual([]);
    });

    test('a synchronous initialize is not a candidate at all', () => {
        expect(offences(NOT_ASYNC)).toEqual([]);
    });

    test('prose about awaits is not an await', () => {
        // `guild-trials.js` registers everything above its first real await and
        // says so in a comment. Without the comment pass, that sentence is the
        // first `await` the scan finds and the file reads as an offender
        // because of the note explaining why it is not one.
        const commented = `
            class Thing {
                async initialize() {
                    // Registered above the first \`await\`, deliberately.
                    dataManager.on('items_updated', () => this.redraw());
                    await storage.get('key', 'store', null);
                    this.loaded = true;
                }
            }
        `;
        expect(offences(commented)).toEqual([]);
    });

    test('an async IIFE is the initializer, not a callback', () => {
        // `action-panel-sort.js` puts its whole body inside one. Blanking it
        // the way a callback is blanked would hide every registration it makes.
        const iife = `
            class Thing {
                async initialize() {
                    this._loading = (async () => {
                        await this._loadFor(currentOwner());
                        this.switchHandler = () => this.forget();
                        dataManager.on('character_switching', this.switchHandler);
                    })();
                    await this._loading;
                }
            }
        `;
        const found = offences(iife);
        expect(found).toHaveLength(1);
        expect(found[0].registration).toBe('switchHandler =');
    });

    test('the reported line is the registration, not the entry point', () => {
        const [found] = offences(BAD);
        expect(BAD.split('\n')[found.line - 1]).toContain('this.updateHandler =');
    });
});

describe('the matcher against a site that really was leaking', () => {
    /**
     * Worth more than any number of exemptions: the exemption list only proves
     * what the matcher tolerates, and this proves what it catches. Pulled out
     * of git rather than pasted, so it is the source that actually shipped the
     * bug rather than a reconstruction of it.
     */
    const PRE_FIX = [
        ['52582fea2', 'src/features/actions/gathering-stats.js'],
        ['52582fea2', 'src/features/combat/dungeon-tracker-ui.js'],
        ['a104def79', 'src/features/tasks/task-reroll-walk.js'],
        ['fde5372ca', 'src/features/market/bulk-sell-assistant.js'],
        ['55ac400f9', 'src/features/networth/index.js'],
    ];

    /**
     * @param {string} commit - The commit that fixed the site
     * @param {string} path - Repo-relative path to the module
     * @returns {string|null} The source as it stood before the fix, or null if git cannot answer
     */
    function preFixSource(commit, path) {
        try {
            return execFileSync('git', ['show', `${commit}~1:${path}`], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch {
            return null;
        }
    }

    test.each(PRE_FIX)('%s: the pre-fix %s is flagged', (commit, path) => {
        const source = preFixSource(commit, path);
        if (source === null) {
            // Not a silent pass: a tree without history (a tarball, a shallow
            // clone) cannot answer, and pretending it did would be the same
            // hollow green the self-test above exists to prevent.
            console.warn(`[init-ownership-coverage] skipped ${path}: git could not read ${commit}~1`);
            return;
        }

        const found = scanForLateRegistration(source).filter((finding) => !finding.hasMarker);

        expect(
            found.length,
            `${path} at ${commit}~1 is a known character-switch leak and the matcher no longer sees it — ` +
                'something in LIFECYCLE_ENTRY, REGISTRATION_SHAPES, OWNERSHIP_MARKER or stripNestedAsync has ' +
                'stopped working, and the tree-wide scan above is now passing for the wrong reason.'
        ).toBeGreaterThan(0);
    });

    test('and the same file after its fix is not', () => {
        const source = readFileSync(resolve(REPO_ROOT, 'src/features/actions/gathering-stats.js'), 'utf8');
        expect(scanForLateRegistration(source).filter((finding) => !finding.hasMarker)).toEqual([]);
    });
});
