import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sliceForkChangelog, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_CHARS } from './changelog-slice.js';

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
        expect(result.text).toContain('35 earlier changes are not shown here');
        expect(result.text.trim().endsWith('the full list is in CHANGELOG.md on GitHub.')).toBe(true);
    });

    test('says it in the singular when exactly one is left out', () => {
        const result = sliceForkChangelog(changelogWith(4), { maxEntries: 3 });
        expect(result.text).toContain('One earlier change is not shown here');
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
        expect(result.text).toContain('2 earlier changes are not shown here');
    });

    test('the entry count is the binding limit, not the character ceiling', () => {
        const result = sliceForkChangelog(changelogWith(100));
        expect(result.shownEntries).toBe(DEFAULT_MAX_ENTRIES);
        expect(result.text.length).toBeLessThan(DEFAULT_MAX_CHARS);
    });

    test('returns nothing when there is no unreleased section', () => {
        const result = sliceForkChangelog('# Changelog\n\n## [3.47.0](x) (2026-09-10)\n\n* a fix\n');
        expect(result).toEqual({ text: '', totalEntries: 0, shownEntries: 0, omittedEntries: 0 });
    });

    test('falls back to the character clamp when the section has no entries', () => {
        const changelog = `# Changelog\n\n## Unreleased — branch \`main\`\n\n${'z'.repeat(50000)}\n`;
        const result = sliceForkChangelog(changelog, { maxChars: 100 });
        expect(result.text).toHaveLength(100);
        expect(result.totalEntries).toBe(0);
    });

    test('the real CHANGELOG.md ships whole entries inside both limits', () => {
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
