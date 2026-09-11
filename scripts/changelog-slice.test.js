import { describe, test, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
    sliceForkChangelog,
    DEFAULT_RELEASES_BACK,
    DEFAULT_MIN_ENTRIES,
    DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_CHARS,
} from './changelog-slice.js';
import { stampChangelog, markerFor } from './stamp-changelog-version.js';
import { compareVersions } from '../src/utils/compare-versions.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Build a changelog whose unreleased section holds `count` numbered entries. */
function changelogWith(count, body = 'A sentence about what changed.') {
    const entries = [];
    for (let i = 1; i <= count; i++) {
        entries.push(`### Entry ${i}\n\n${body}\n`);
    }
    return [
        '# Changelog',
        '',
        '## Fork Changelog (Millennium44/Toolasha)',
        '',
        'Newest first.',
        '',
        '## Unreleased — branch `main`',
        '',
        entries.join('\n'),
        '## [3.47.0](https://example.invalid) (2026-09-10)',
        '',
        '### Bug Fixes',
        '',
        '* something release-please wrote',
        '',
    ].join('\n');
}

describe('sliceForkChangelog', () => {
    test('passes a small section through untouched', () => {
        const changelog = changelogWith(3);
        const result = sliceForkChangelog(changelog);
        expect(result.totalEntries).toBe(3);
        expect(result.shownEntries).toBe(3);
        expect(result.omittedEntries).toBe(0);
        expect(result.text).toContain('## Unreleased — branch `main`');
        expect(result.text.trim()).toBe(
            changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('## [3.47.0]')).trim()
        );
    });

    test('never bleeds into the release-please sections below', () => {
        const result = sliceForkChangelog(changelogWith(2));
        expect(result.text).not.toContain('3.47.0');
        expect(result.text).not.toContain('release-please wrote');
    });

    test('keeps the newest entries and drops the rest', () => {
        const result = sliceForkChangelog(changelogWith(40), { maxEntries: 5 });
        expect(result.totalEntries).toBe(40);
        expect(result.shownEntries).toBe(5);
        expect(result.omittedEntries).toBe(35);
        for (let i = 1; i <= 5; i++) expect(result.text).toContain(`### Entry ${i}\n`);
        expect(result.text).not.toContain('### Entry 6');
        expect(result.text).not.toContain('### Entry 40');
    });

    test('says how many entries are not shown, once, at the end', () => {
        const result = sliceForkChangelog(changelogWith(40), { maxEntries: 5 });
        expect(result.text).toContain('35 more changes are not shown here');
        expect(result.text.trim().endsWith('the full list is in CHANGELOG.md on GitHub.')).toBe(true);
    });

    test('says it in the singular when exactly one is left out', () => {
        const result = sliceForkChangelog(changelogWith(4), { maxEntries: 3 });
        expect(result.text).toContain('One more change is not shown here');
    });

    test('never calls what it left out "earlier" — the build cannot know that', () => {
        const result = sliceForkChangelog(changelogWith(40), { maxEntries: 5 });
        expect(result.text).not.toContain('earlier');
    });

    test('says nothing about omissions when nothing was omitted', () => {
        const result = sliceForkChangelog(changelogWith(4), { maxEntries: 12 });
        expect(result.text).not.toContain('not shown here');
    });

    test('drops a whole entry rather than cutting one in half', () => {
        // Four entries of ~500 characters against a 1200-character ceiling: two
        // fit, the third would not, and no fragment of it may survive.
        const long = 'x'.repeat(500);
        const result = sliceForkChangelog(changelogWith(4, long), { maxEntries: 12, maxChars: 1200 });
        expect(result.shownEntries).toBe(2);
        expect(result.omittedEntries).toBe(2);
        expect(result.text).not.toContain('### Entry 3');
        // Every entry that did ship carries its whole body.
        const bodies = result.text.match(/x+/g) ?? [];
        expect(bodies).toHaveLength(2);
        for (const found of bodies) expect(found).toHaveLength(500);
    });

    test('keeps the newest entry even when it alone exceeds the ceiling', () => {
        const result = sliceForkChangelog(changelogWith(3, 'y'.repeat(5000)), { maxChars: 1000 });
        expect(result.shownEntries).toBe(1);
        expect(result.text).toContain('y'.repeat(5000));
        expect(result.text).toContain('2 more changes are not shown here');
    });

    test('an unmarked changelog falls back to the floor, which is what it always shipped', () => {
        const result = sliceForkChangelog(changelogWith(100));
        expect(result.shownEntries).toBe(DEFAULT_MIN_ENTRIES);
        expect(result.text.length).toBeLessThan(DEFAULT_MAX_CHARS);
    });

    test('returns nothing when there is no unreleased section', () => {
        const result = sliceForkChangelog('# Changelog\n\n## [3.47.0](x) (2026-09-10)\n\n* a fix\n');
        expect(result).toEqual({ text: '', totalEntries: 0, shownEntries: 0, omittedEntries: 0, markerVersions: [] });
    });

    test('falls back to the character clamp when the section has no entries', () => {
        const changelog = `# Changelog\n\n## Unreleased — branch \`main\`\n\n${'z'.repeat(50000)}\n`;
        const result = sliceForkChangelog(changelog, { maxChars: 100 });
        expect(result.text).toHaveLength(100);
        expect(result.totalEntries).toBe(0);
    });

    test('the real CHANGELOG.md ships whole entries inside every limit', () => {
        const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf-8');
        const result = sliceForkChangelog(changelog);
        expect(result.shownEntries).toBeGreaterThan(0);
        expect(result.shownEntries).toBeLessThanOrEqual(DEFAULT_MAX_ENTRIES);
        expect(result.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
        // The last thing shown is either a whole entry or the omission line —
        // never a sentence stopped mid-word.
        expect(/[.!?)`”]\s*$/.test(result.text.trim())).toBe(true);
        if (result.omittedEntries > 0) expect(result.text).toContain('not shown here');
    });
});

/**
 * The real changelog is not a fixed fixture: a release stamps a new marker
 * into it every day, so a test pinned to today's exact marker count goes red
 * on the next release (as happened when 3.48.0 became the first marked one).
 * These instead check invariants the code documents, at three points in the
 * changelog's life: before any release ever stamped a marker, today (however
 * many markers it has), and one release from now (a newer marker with a new
 * entry shipped under it). Nothing here may depend on how many entries sit
 * above a marker, which changes with every changelog entry. The last two are built with the modules' own helpers
 * rather than hand-typed markdown, so they track the real marker format
 * instead of a guess at it.
 */
describe('the real CHANGELOG.md across release states', () => {
    const real = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf-8');

    const states = {
        'no markers': real.replace(/^<!--\s*shipped in\s+[\d.]+\s*-->\n\n/gm, ''),
        'as it stands today': real,
        'one release from now': (() => {
            const stamped = stampChangelog(real, '9.9.9').text;
            return stamped.replace(
                markerFor('9.9.9'),
                `${markerFor('9.9.9')}\n\n### Something new for 9.9.9\n\nBody text.`
            );
        })(),
    };

    test.each(Object.entries(states))('%s: markers are well-formed semver, newest first', (_label, changelog) => {
        const result = sliceForkChangelog(changelog);
        for (const version of result.markerVersions) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        const descending = [...result.markerVersions].sort(compareVersions).reverse();
        expect(result.markerVersions).toEqual(descending);
    });

    test.each(Object.entries(states))('%s: ships within the documented bounds', (_label, changelog) => {
        const result = sliceForkChangelog(changelog);
        // No marker: nothing to slice on, so the floor answers exactly
        // (`entriesToCover` returns 0). Any marker, even a lone one, asks for the
        // entries above it, which the floor and ceiling then clamp.
        if (result.markerVersions.length === 0) {
            expect(result.shownEntries).toBe(DEFAULT_MIN_ENTRIES);
        } else {
            expect(result.shownEntries).toBeGreaterThanOrEqual(DEFAULT_MIN_ENTRIES);
            expect(result.shownEntries).toBeLessThanOrEqual(DEFAULT_MAX_ENTRIES);
        }
        expect(result.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    });

    it('never marks the real changelog with a version newer than package.json ships', () => {
        // Only the untouched real file — the synthetic "one release from now"
        // state above deliberately stamps a version ahead of package.json.
        const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;
        for (const version of sliceForkChangelog(real).markerVersions) {
            expect(compareVersions(version, pkgVersion)).toBeLessThanOrEqual(0);
        }
    });
});

/**
 * A changelog as it looks at build time, with `perRelease[i]` entries in the
 * release `i` releases back.
 *
 * A release stamps its marker above *everything*, so the newest marker has no
 * entries above it and its own entries sit directly below it; the next marker
 * down sits between that release's entries and the one before it. Entries are
 * numbered from the top so a test can name them.
 */
function markedChangelog(perRelease, { body = 'A sentence about what changed.' } = {}) {
    const lines = ['# Changelog', '', '## Unreleased — branch `main`', ''];
    let entry = 0;
    perRelease.forEach((count, index) => {
        lines.push(`<!-- shipped in 3.${50 - index}.0 -->`, '');
        for (let i = 0; i < count; i++) lines.push(`### Entry ${++entry}`, '', body, '');
    });
    lines.push('## [3.20.0](https://example.invalid) (2026-01-01)', '', '* older history', '');
    return lines.join('\n');
}

describe('slicing by release boundary', () => {
    test('ships every entry back to the marker that serves a player two releases behind', () => {
        // 3.50 shipped 8, 3.49 shipped 7: a player who last ran 3.48 has 15 to
        // read, and the marker naming their build has to ship with them.
        const result = sliceForkChangelog(markedChangelog([8, 7, 6, 5]));
        expect(DEFAULT_RELEASES_BACK).toBe(2);
        expect(result.shownEntries).toBe(15);
        expect(result.markerVersions).toEqual(['3.50.0', '3.49.0', '3.48.0']);
        expect(result.text).toContain('### Entry 15');
        expect(result.text).not.toContain('### Entry 16');
    });

    test('a busy release ships more than a quiet one', () => {
        const busy = sliceForkChangelog(markedChangelog([15, 8, 6, 6, 6]));
        const quiet = sliceForkChangelog(markedChangelog([2, 1, 6, 6, 6]));
        expect(busy.shownEntries).toBe(23);
        expect(quiet.shownEntries).toBeLessThan(busy.shownEntries);
        // Nothing forced a fixed twelve on either of them.
        expect(busy.shownEntries).not.toBe(DEFAULT_MIN_ENTRIES);
    });

    test('the floor still applies when two releases hold almost nothing', () => {
        const result = sliceForkChangelog(markedChangelog([1, 1, 4, 4, 4]));
        expect(result.shownEntries).toBe(DEFAULT_MIN_ENTRIES);
    });

    test('the entry cap binds when one release is enormous', () => {
        const result = sliceForkChangelog(markedChangelog([50, 20, 5]));
        expect(result.shownEntries).toBe(DEFAULT_MAX_ENTRIES);
        expect(result.omittedEntries).toBe(45);
        expect(result.text).toContain('45 more changes are not shown here');
    });

    test('the character cap binds when a release is enormous by the word', () => {
        const result = sliceForkChangelog(markedChangelog([20, 20, 5], { body: 'w'.repeat(2000) }));
        expect(result.shownEntries).toBeLessThan(20);
        expect(result.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS + 200);
    });

    test('ships to the oldest marker there is when there are fewer than asked for', () => {
        // The first marked release: one marker, stamped above everything, so no
        // boundary can say where its predecessor ended. The floor answers.
        const result = sliceForkChangelog(markedChangelog([30]));
        expect(result.markerVersions).toEqual(['3.50.0']);
        expect(result.shownEntries).toBe(DEFAULT_MIN_ENTRIES);
    });

    test('two markers cover one release, and the floor covers the rest', () => {
        const result = sliceForkChangelog(markedChangelog([20, 20]));
        expect(result.shownEntries).toBe(20);
        expect(result.markerVersions).toEqual(['3.50.0', '3.49.0']);
    });

    test('unreleased entries above the newest marker always ship', () => {
        const changelog = markedChangelog([8, 8, 8, 8]).replace(
            '<!-- shipped in 3.50.0 -->',
            '### Not released yet\n\nBody.\n\n<!-- shipped in 3.50.0 -->'
        );
        const result = sliceForkChangelog(changelog);
        expect(result.text).toContain('### Not released yet');
        expect(result.shownEntries).toBe(17);
    });

    test('markers are not entries: the caps count entries', () => {
        const result = sliceForkChangelog(markedChangelog([40, 40, 40]));
        expect(result.totalEntries).toBe(120);
        expect(result.shownEntries).toBe(DEFAULT_MAX_ENTRIES);
    });

    test('markers ship, so the runtime has something to filter on', () => {
        const result = sliceForkChangelog(markedChangelog([4, 4, 4, 4]));
        expect(result.markerVersions.length).toBeGreaterThan(0);
        for (const version of result.markerVersions) expect(result.text).toContain(`shipped in ${version}`);
    });

    test('how many releases back is a knob, and it moves what ships', () => {
        const changelog = markedChangelog([9, 9, 9, 9, 9]);
        const one = sliceForkChangelog(changelog, { releasesBack: 1, minEntries: 0 });
        const three = sliceForkChangelog(changelog, { releasesBack: 3, minEntries: 0 });
        expect(one.shownEntries).toBe(9);
        expect(three.shownEntries).toBe(27);
    });
});
