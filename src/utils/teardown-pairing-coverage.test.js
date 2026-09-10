/**
 * The standing guard over sub-modules a feature starts and never stops.
 *
 * A registered feature's `initialize()` starts something that is not itself a
 * registered feature, and the feature's teardown does not stop it. Both ends
 * look correct in isolation — the sub-module has a working `disable()`, the
 * parent has a working `cleanup()` — and nothing connects them. Three sites
 * accumulated a listener per character switch (`d86ec6125`, four leaked
 * `dataManager` listeners per `initializeFeatures()`, stable over twelve
 * cycles); two more served the departed character's data (`95d15e357`); a
 * sixth, `guild-trials.js` → `guildMemberSkills`, kept recording into a stale
 * guild's bucket after the feature was switched off. All six were found by
 * hand, by enumerating sixty-four parent→sub-module pairs and reading each.
 *
 * A seventh — `guild-trials.js` → `guildTrialAlerts`, still raising "the guild
 * trial has begun" for a feature the player had switched off — was found by
 * this scan, on its first tree-wide run, and is the reason to keep it.
 *
 * `init-ownership-coverage.test.js` cannot see this class and never could. It
 * looks for an `initialize()` that registers *after an await* without an
 * ownership ticket — a suspend race. `house-cost-display.js`'s `initialize()`
 * was perfectly well behaved; the defect was that nothing ever called its
 * `disable()`. No amount of await-scanning finds that, so this is a separate
 * scan in the same idiom: regex over source text, because `package.json` has no
 * parser and adding one to answer a question this shape can answer is not worth
 * the dependency.
 *
 * ## What it enumerates
 *
 * Every call of the shape `<module>.initialize(…)` / `.init(…)` / `.start(…)`
 * made from a file under `src/features`, where `<module>` is a *cross-file*
 * binding: an identifier imported from a relative path, or a module-level
 * `const` built by an imported factory (`const autofill =
 * createAutofillManager(…)`). Cross-file is the definition of a sub-module, and
 * it is also what keeps the scan honest — a module-level `const guildTrials =
 * new GuildTrials()` called from that same file's own `export default` is the
 * module starting *itself*, and admitting those added forty-four pairs and
 * eight flags with nothing behind any of them.
 *
 * ## What it asserts, per pair
 *
 * That the parent's teardown contains a matching teardown call on the same
 * binding — `.cleanup()`, `.disable()`, `.close()`, `.stop()` and the rest of
 * {@link TEARDOWN_CALL}. "The parent's teardown" is every function or method in
 * the file whose name starts with `disable`, `cleanup`, `teardown`, `destroy`
 * or `dispose`, because that is what the registry ends up calling:
 * `feature-registry.js:400` calls `disable()`, `entrypoint.js:2322-2327` maps a
 * module's `cleanup` onto `disable`, and `panel-observer.js` names its own
 * `disablePanelObserver()`.
 *
 * A pair that has no such call must earn an entry in {@link KNOWN_SAFE} with a
 * one-sentence reason. **The sentence is the whole point.** A bare list of
 * paths gets padded silently; a list where every entry has to say *what makes
 * this one safe* does not, because writing the sentence is the investigation
 * and a wrong sentence can be checked. Deliberately there is no second map for
 * known-but-unfixed sites: this test has two states, clean or actionable, and a
 * standing debt list is a suppression mechanism that accumulates.
 *
 * ## What it cannot do — read this before trusting a pass
 *
 * - It matches on the *binding name*, not on identity. A teardown that stops
 *   the sub-module through a different reference, or through a helper it calls,
 *   reads as missing; a parent whose teardown happens to name the binding in an
 *   unrelated call reads as paired.
 * - `forget()` and `reset()` are deliberately **not** teardown calls. They are
 *   the character-switch clear, which is a different obligation — the
 *   `guildMemberSkills` bug was precisely a `forget()` on the switch path
 *   standing in for a `cleanup()` that never came.
 * - Teardown bodies are pooled per file rather than tracked per method, so a
 *   sub-module stopped from a *different* teardown than the one the registry
 *   calls still reads as paired.
 * - `.start(steps)` is a job, not a lifecycle, and the scan cannot tell the two
 *   apart. Three such pairs sit in `KNOWN_SAFE` saying so.
 * - It says nothing about *ordering* — a teardown that stops a sub-module after
 *   something else has already torn out what it needs passes here.
 *
 * A pass therefore means "every cross-file start has a matching stop, or a
 * reason", not "no leaks".
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

/** Calls that mean "start this sub-module" */
const START_VERBS = 'initialize|init|start';

/**
 * Calls that mean "stop it again".
 *
 * `forget` and `reset` are absent on purpose — see the module comment. Both are
 * the character-switch clear, and treating one as a teardown is exactly the
 * reasoning that left `guildMemberSkills` listening after Guild Trials was
 * switched off.
 */
const TEARDOWN_CALL = 'cleanup|disable|destroy|teardown|dispose|stop|close|unregister|detach|unsubscribe|uninstall';

/**
 * Names a teardown function goes by.
 *
 * Prefix-matched rather than exact: `panel-observer.js` calls its teardown
 * `disablePanelObserver()` and a scan that insisted on a bare `cleanup` read
 * that file — which does call `actionFilter.cleanup()` — as an offender.
 */
const TEARDOWN_NAME = '_?(?:disable|cleanup|teardown|destroy|dispose)[A-Za-z0-9_$]*';

const TEARDOWN_DECL = new RegExp(
    '(?:^|[\\s;{},])(?:(?:async\\s+)?(' +
        TEARDOWN_NAME +
        ')\\s*\\([^()]*\\)|(' +
        TEARDOWN_NAME +
        ')\\s*[:=]\\s*(?:async\\s*)?(?:function\\s*)?\\([^()]*\\)\\s*(?:=>)?)\\s*\\{',
    'g'
);

/** `import x from './y.js'`, `import { a, b as c } from '../z.js'` — relative specifiers only */
const RELATIVE_IMPORT = /import\s+([^;]*?)\s+from\s+['"](\.[^'"]+)['"]/g;

/** `const autofill = createAutofillManager('AbilityBookPanel');` at the left margin */
const FACTORY_BINDING = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;

/**
 * Blank out comments and string literals, preserving every index and newline.
 *
 * Shared reasoning with `init-ownership-coverage.test.js`: prose about a
 * `cleanup()` that is not there must not read as the call itself, and a path in
 * an import string must not read as code. Regex literals are left alone — a `/`
 * opening one is indistinguishable from division without parsing, and guessing
 * wrong swallows real code.
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
 * Every cross-file binding in one module, name → where it came from.
 *
 * Imports are read off the *original* text rather than the stripped copy, since
 * the specifier lives in a string literal the stripper has just blanked.
 * @param {string} original - A module's source text
 * @returns {Map<string, string>} binding name → import specifier (with the factory, when built by one)
 */
function crossFileBindings(original) {
    const bindings = new Map();
    RELATIVE_IMPORT.lastIndex = 0;
    let match;
    while ((match = RELATIVE_IMPORT.exec(original))) {
        for (const clause of match[1].replace(/[{}]/g, ',').split(',')) {
            const name = clause.trim().match(/([A-Za-z_$][\w$]*)$/);
            if (name) bindings.set(name[1], match[2]);
        }
    }

    // A helper the module builds for itself out of an imported factory is still
    // a sub-module living in another file — `ability-book-panel.js`'s autofill
    // manager is one, and it is one of the pairs the hand survey had to read.
    const imported = new Map(bindings);
    FACTORY_BINDING.lastIndex = 0;
    while ((match = FACTORY_BINDING.exec(original))) {
        if (!bindings.has(match[1]) && imported.has(match[2])) {
            bindings.set(match[1], `${imported.get(match[2])} via ${match[2]}()`);
        }
    }
    return bindings;
}

/**
 * The pooled text of every teardown function in a module.
 * @param {string} source - Source already stripped of comments and strings
 * @returns {string} Their bodies, concatenated
 */
function teardownBodies(source) {
    let text = '';
    TEARDOWN_DECL.lastIndex = 0;
    let match;
    while ((match = TEARDOWN_DECL.exec(source))) {
        const brace = match.index + match[0].length - 1;
        const close = matchingBrace(source, brace);
        if (close > 0) text += `${source.slice(brace, close + 1)}\n`;
    }
    return text;
}

/**
 * Every sub-module one file starts, and whether its teardown stops it again.
 *
 * The single seam the whole file runs through — the tree-wide scan, the
 * self-test and the retroactive check all call this, so a regex that stops
 * working fails all three rather than silently passing the first.
 *
 * One finding per (module, binding) pair rather than per call: `queue-monitor.js`
 * starts `queueAlerts` from two branches of the same `initialize()` and it is
 * one obligation, not two. The line reported is the first start.
 * @param {string} original - A module's source text
 * @returns {Array<{module: string, from: string, verb: string, line: number, paired: boolean}>} Findings
 */
export function scanForUnpairedStarts(original) {
    const source = stripCommentsAndStrings(original);
    const teardown = teardownBodies(source);
    const found = new Map();

    for (const [name, from] of crossFileBindings(original)) {
        const start = new RegExp(`\\b${name}\\s*\\??\\.\\s*(${START_VERBS})\\s*\\??\\.?\\s*\\(`, 'g');
        const stop = new RegExp(`\\b${name}\\s*\\??\\.\\s*(?:${TEARDOWN_CALL})\\s*\\??\\.?\\s*\\(`);
        let match;
        while ((match = start.exec(source))) {
            if (found.has(name)) continue;
            found.set(name, {
                module: name,
                from,
                verb: match[1],
                line: source.slice(0, match.index).split('\n').length,
                paired: stop.test(teardown),
            });
        }
    }
    return [...found.values()];
}

/**
 * Pairs the scan flags that a human has read and cleared, each with the reason
 * it is not an oversight.
 *
 * Before adding an entry, answer one question: when the registry tears the
 * parent down, what is the sub-module still holding? If the answer is "a
 * listener, a timer, an observer, or this character's data", it is not safe —
 * it wants a teardown call in the parent, not a line here.
 *
 * Keyed `<path from repo root>#<binding name>`.
 */
const KNOWN_SAFE = {
    'src/features/actions/gathering-stats.js#actionPanelSort':
        'One of two parents — `max-produceable.js` starts the same singleton — and it self-manages across ' +
        'switches with its own `character_switching`/`character_initialized` handlers, so a `disable()` from ' +
        'either parent would take those listeners away from the other.',
    'src/features/actions/max-produceable.js#actionPanelSort':
        'The other of the two parents, same reasoning: `action-panel-sort.js` installs its own switch ' +
        'listeners behind `if (!this.handlers.x)` guards and re-derives pins and sort mode per character, so ' +
        'no parent owns its lifecycle and neither may end it.',
    'src/features/actions/tea-recommendation.js#actionFilter':
        'The filter is owned by `panel-observer.js`, whose `disablePanelObserver()` does call ' +
        '`actionFilter.cleanup()`; this second caller only needs it up before reading ' +
        '`getCurrentSkillName()`, and holds nothing of its own to give back.',
    'src/features/abilities/ability-book-panel.js#autofill':
        'The buy-modal observer is registered once, lazily, behind a module-level `autofillReady` flag that ' +
        'nothing resets, so a `cleanup()` here would leave the arming machinery permanently dead rather than ' +
        'merely stale — the panel drops the armed quantity with `clearQuantity()` instead.',
    'src/features/tasks/task-claim-toast.js#taskCompletionTracker':
        'The tracker is self-managing — it registers its own `character_switching` → `forget()` and carries a ' +
        'generation ticket across its storage read — and its own docstring records that neither of its two ' +
        'parents owns it, so a `cleanup()` from this one would stop recording for the other.',
    'src/features/tasks/task-tokens-row.js#taskCompletionTracker':
        'The second of that tracker’s two parents, same reasoning: stopping it from here would deafen ' +
        '`task-claim-toast.js`, which is a peer rather than a dependant.',
    'src/features/crafting-plan/task-crafting-train.js#craftingPlanWalk':
        'The walk ends itself on `character_switching` and re-subscribes from `start()`, and it is shared ' +
        'with the action panel’s plan — `crafting-plan/index.js` is the parent that pairs `initialize()` with ' +
        '`disable()`, so a second `disable()` from here would leave the other surface’s walk deaf.',
    'src/features/crafting-plan/crafting-plan-display.js#craftingPlanWalk':
        '`start(steps)` here is a job, not a lifecycle — the Walk button running one plan — and the module’s ' +
        'own `initialize()`/`disable()` pair is held by `crafting-plan/index.js`.',
    'src/features/ironcow/ironcow-queue-walk.js#craftingPlanWalk':
        'Same shape: `startQueueWalk()` hands the shared walk one batch of steps to run, and `start()` ' +
        're-subscribes for itself; the lifecycle stays with `crafting-plan/index.js`.',
    'src/features/house/house-panel-observer.js#houseCostCalculator':
        'A pure costing helper in `utils/`: its `initialize()` only warms market data behind a `marketReady` ' +
        'flag, and it has no teardown to call because it registers nothing and holds no character state.',
    'src/features/planner/goal-planner-context.js#houseCostCalculator':
        'The same market-data warm-up, from the planner’s second caller — nothing registered, nothing to stop.',
    'src/features/settings/settings-ui.js#syncManager':
        'Cross-device sync is a registered feature in its own right (`features/sync/index.js` pairs ' +
        '`syncManager.initialize()` with `syncManager.cleanup()`); the settings panel starts it early because ' +
        'its buttons live here, and stopping it from here would take it from the registry.',
    'src/features/tasks/task-profit-display.js#expectedValueCalculator':
        'A registered feature (`entrypoint.js` key `expectedValueCalculator`), so the registry owns both ends ' +
        'of its lifecycle; `ensureMarketDataInitialized()` only makes sure it is up before asking it for a ' +
        'container value.',
    'src/features/ui/command-palette.js#pformancePanel':
        'Deliberate, and documented at the call site: `disable()` would also take the panel off the page, and ' +
        'the palette’s `cleanup()` runs on every character switch — a diagnostic the user is watching must ' +
        'not vanish because they changed character, so the command is withdrawn by name instead.',
};

const REPO_ROOT = process.cwd();
const FEATURES_ROOT = resolve(REPO_ROOT, 'src/features');

/**
 * @param {string} dir - Directory to walk
 * @param {Array<string>} out - Accumulator
 * @returns {Array<string>} Every non-test, non-fixture `.js` file beneath `dir`
 */
function featureSources(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) featureSources(path, out);
        else if (entry.endsWith('.js') && !entry.endsWith('.test.js') && !entry.endsWith('.fixture.js')) out.push(path);
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
 * Every parent→sub-module pair in the tree.
 * @returns {Array<{pair: string, file: string}>} Findings, one per pair
 */
function scanFeatures() {
    const findings = [];
    for (const file of featureSources(FEATURES_ROOT)) {
        const source = readFileSync(file, 'utf8');
        for (const hit of scanForUnpairedStarts(source)) {
            findings.push({ pair: `${repoPath(file)}#${hit.module}`, file: repoPath(file), ...hit });
        }
    }
    return findings;
}

describe('sub-modules a feature starts and never stops', () => {
    const findings = scanFeatures();
    const unpaired = findings.filter((finding) => !finding.paired);

    test('every started sub-module is stopped by its starter’s teardown, or is a recorded exemption', () => {
        const offenders = unpaired.filter((finding) => !(finding.pair in KNOWN_SAFE));

        const report = offenders
            .map(
                (offender) =>
                    `  ${offender.file}:${offender.line} starts ${offender.module} (${offender.from}) with ` +
                    `${offender.module}.${offender.verb}(), and no teardown in ${offender.file} calls ` +
                    `${offender.module}.cleanup()/disable().`
            )
            .join('\n');

        expect(
            offenders.map((offender) => offender.pair),
            'A feature started a sub-module that its own teardown does not stop. The registry tears the parent ' +
                'down on every character switch and on every settings toggle; the sub-module keeps its ' +
                'listeners, its timers and the departed character’s data, and the re-initialise that follows ' +
                `registers a fresh set on top.\n${report}\n` +
                'Do one of two things. Call the sub-module’s teardown from the parent’s — ' +
                '`sub.cleanup()`/`sub.disable()` beside its siblings, in its own try/catch if it can throw, and ' +
                'check that call is safe when initialize() never ran or is still in flight. Or, if the ' +
                'sub-module is shared with another parent, self-manages across switches, or is a registered ' +
                'feature the registry already owns, add the pair to KNOWN_SAFE in ' +
                'src/utils/teardown-pairing-coverage.test.js with a one-sentence reason naming what makes it ' +
                'safe. A reason you cannot write is a pair that is not safe.'
        ).toEqual([]);
    });

    test('no exemption outlives the thing it exempts', () => {
        // An allowlist nobody prunes is an allowlist that hides the next
        // regression: a pair that has since been fixed, renamed or deleted
        // leaves an entry that would silently absorb a *new* miss at the same
        // path and binding.
        const live = new Set(unpaired.map((finding) => finding.pair));
        const stale = Object.keys(KNOWN_SAFE).filter((pair) => !live.has(pair));

        expect(
            stale,
            'These pairs are listed as exemptions but the scan no longer flags them — they were paired up, ' +
                'renamed or deleted. Remove the entries from src/utils/teardown-pairing-coverage.test.js.'
        ).toEqual([]);
    });

    test.each(Object.entries(KNOWN_SAFE))('%s carries a reason, not just a path', (pair, reason) => {
        expect(typeof reason, `${pair} needs a sentence`).toBe('string');
        expect(
            reason.trim().split(/\s+/).length,
            `${pair}'s reason is too short to be an investigation`
        ).toBeGreaterThan(8);
    });

    test('the scan is actually looking at something', () => {
        // A walker that quietly stopped finding files would make every
        // assertion above pass on an empty list.
        expect(findings.length).toBeGreaterThan(30);
    });
});

describe('the matcher itself', () => {
    // Without this block, a refactor that breaks one of the regexes above
    // leaves a test that passes forever and detects nothing — the exact failure
    // mode this file exists to prevent.

    const UNPAIRED = `
        import subModule from './sub-module.js';

        class Parent {
            async initialize() {
                subModule.initialize(this.guildName);
            }
            cleanup() {
                this.timers.clearAll();
            }
        }
    `;

    const PAIRED = `
        import subModule from './sub-module.js';

        class Parent {
            async initialize() {
                subModule.initialize(this.guildName);
            }
            cleanup() {
                this.timers.clearAll();
                subModule.cleanup();
            }
        }
    `;

    const PAIRED_THROUGH_A_RENAMED_TEARDOWN = `
        import subModule from './sub-module.js';

        export function initializePanelObserver() {
            subModule.initialize();
        }
        export function disablePanelObserver() {
            subModule.cleanup();
        }
    `;

    const OPTIONAL_CALLS = `
        import subModule from './sub-module.js';

        class Parent {
            initialize() {
                subModule.initialize?.();
            }
            cleanup() {
                subModule.cleanup?.();
            }
        }
    `;

    const FORGET_IS_NOT_A_TEARDOWN = `
        import subModule from './sub-module.js';

        class Parent {
            initialize() {
                subModule.initialize();
            }
            _forgetCharacter() {
                subModule.forget?.();
            }
            cleanup() {
                this.timers.clearAll();
            }
        }
    `;

    const SELF_SINGLETON = `
        class Parent {
            initialize() {}
            cleanup() {}
        }
        const parent = new Parent();
        export default {
            name: 'Parent',
            initialize: () => parent.initialize(),
        };
    `;

    // Deliberately flush left: {@link FACTORY_BINDING} anchors at the start of a
    // line, because a `const` built inside a function is a local helper rather
    // than a module's sub-module. Indenting this fixture would quietly stop it
    // exercising the rule it exists for.
    const FACTORY_HELPER = `
import { createAutofillManager } from '../../utils/marketplace-autofill.js';

const autofill = createAutofillManager('Panel');

export function arm() {
    autofill.initialize();
}
export function disablePanel() {
    autofill.clearQuantity();
}
`;

    /**
     * @param {string} source - Fixture text
     * @returns {Array<Object>} The pairs the real scan would treat as offences
     */
    const offences = (source) => scanForUnpairedStarts(source).filter((finding) => !finding.paired);

    test('a start with no matching stop is flagged', () => {
        const found = offences(UNPAIRED);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ module: 'subModule', verb: 'initialize', from: './sub-module.js' });
    });

    test('the same file with the stop in its teardown is not', () => {
        expect(offences(PAIRED)).toEqual([]);
    });

    test('a teardown that does not go by the name `cleanup` still counts', () => {
        // `panel-observer.js` calls its own teardown `disablePanelObserver()`,
        // and an exact-name match read that file — which does stop the filter —
        // as an offender.
        expect(offences(PAIRED_THROUGH_A_RENAMED_TEARDOWN)).toEqual([]);
    });

    test('optional-call syntax is the same call', () => {
        expect(offences(OPTIONAL_CALLS)).toEqual([]);
    });

    test('a forget() on the switch path is not a teardown', () => {
        // This is the `guildMemberSkills` bug exactly: the switch path called
        // `forget()`, which kept the listener alive on purpose, and nothing
        // ever called `cleanup()`.
        expect(offences(FORGET_IS_NOT_A_TEARDOWN)).toHaveLength(1);
    });

    test('a module starting its own singleton is not a pair at all', () => {
        expect(scanForUnpairedStarts(SELF_SINGLETON)).toEqual([]);
    });

    test('a helper built by an imported factory is a sub-module', () => {
        const found = offences(FACTORY_HELPER);
        expect(found).toHaveLength(1);
        expect(found[0].from).toContain('createAutofillManager()');
    });

    test('the reported line is the start call', () => {
        const [found] = offences(UNPAIRED);
        expect(UNPAIRED.split('\n')[found.line - 1]).toContain('subModule.initialize(');
    });
});

describe('the matcher against the pairs that really were leaking', () => {
    /**
     * Worth more than any number of exemptions: `KNOWN_SAFE` only proves what
     * the matcher tolerates, and this proves what it catches. Pulled out of git
     * rather than pasted, so it is the source that actually shipped the bug.
     *
     * Each entry names the commit that *fixed* the pair; the check runs against
     * that commit and its parent. The two older ones are named by hash because
     * they are already on `main`. The two from this session are named by a
     * fragment of their subject instead, which survives the cherry-pick onto
     * `main` that a hash would not.
     */
    const PRE_FIX = [
        ['d86ec6125', 'src/features/house/house-panel-observer.js', 'houseCostDisplay'],
        ['95d15e357', 'src/features/guild/guild-roster-view.js', 'guildLoadoutCapture'],
        ['stop the guild member-skills tracker', 'src/features/guild/guild-trials.js', 'guildMemberSkills'],
        ['stop the guild trial chat alerts', 'src/features/guild/guild-trials.js', 'guildTrialAlerts'],
    ];

    /**
     * @param {Array<string>} args - Arguments to `git`
     * @returns {string|null} Its stdout, or null when git cannot answer
     */
    function git(args) {
        try {
            return execFileSync('git', args, {
                cwd: REPO_ROOT,
                encoding: 'utf8',
                maxBuffer: 32 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch {
            return null;
        }
    }

    /**
     * @param {string} spec - A commit hash, or a fragment of a commit subject
     * @returns {string|null} The commit hash, or null when it cannot be found
     */
    function commitFor(spec) {
        if (/^[0-9a-f]{7,40}$/.test(spec)) return git(['rev-parse', '--verify', `${spec}^{commit}`])?.trim() || null;
        return git(['rev-list', '-1', '--fixed-strings', `--grep=${spec}`, 'HEAD'])?.trim() || null;
    }

    /**
     * @param {string} revision - A git revision
     * @param {string} path - Repo-relative path to the module
     * @returns {Array<string>} The sub-modules that revision's copy starts and never stops
     */
    function unpairedAt(revision, path) {
        const source = git(['show', `${revision}:${path}`]);
        if (source === null) return null;
        return scanForUnpairedStarts(source)
            .filter((finding) => !finding.paired)
            .map((finding) => finding.module);
    }

    test.each(PRE_FIX)('%s: %s not stopping %s is flagged, and stopping it is not', (spec, path, subModule) => {
        const commit = commitFor(spec);
        const before = commit && unpairedAt(`${commit}~1`, path);
        const after = commit && unpairedAt(commit, path);
        if (!before || !after) {
            // Not a silent pass: a tree without history (a tarball, a shallow
            // clone, a rewritten subject) cannot answer, and pretending it did
            // would be the same hollow green the self-test above exists to
            // prevent.
            console.warn(`[teardown-pairing-coverage] skipped ${path}: git could not read ${spec}`);
            return;
        }

        expect(
            before,
            `${path} before ${spec} started ${subModule} and never stopped it, and the matcher no longer sees ` +
                'it — something in the binding, start or teardown patterns has stopped working, and the ' +
                'tree-wide scan above is now passing for the wrong reason.'
        ).toContain(subModule);
        expect(after, `the fix at ${spec} should have cleared this pair`).not.toContain(subModule);
    });
});
