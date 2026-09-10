import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { stampChangelog, hasMarker, markerFor } from './stamp-changelog-version.js';
import { sliceForkChangelog } from './changelog-slice.js';

const CHANGELOG = `# Changelog

## Fork Changelog (Millennium44/Toolasha)

Preamble text.

## Unreleased — branch \`main\`

### Newest entry

Body.

### Older entry

Body.

## [3.47.0](https://example.invalid/compare)

### Features

- something
`;

describe('stampChangelog', () => {
    it('inserts the marker directly under the unreleased heading', () => {
        const { text, changed } = stampChangelog(CHANGELOG, '3.48.0');
        expect(changed).toBe(true);
        expect(text).toContain('## Unreleased — branch `main`\n\n<!-- shipped in 3.48.0 -->\n\n### Newest entry');
    });

    it('puts the marker above every entry, so later entries land above it', () => {
        const { text } = stampChangelog(CHANGELOG, '3.48.0');
        expect(text.indexOf(markerFor('3.48.0'))).toBeLessThan(text.indexOf('### Newest entry'));
    });

    it('leaves the release-please sections below untouched', () => {
        const { text } = stampChangelog(CHANGELOG, '3.48.0');
        expect(text).toContain('## [3.47.0](https://example.invalid/compare)');
        expect(text.slice(text.indexOf('## [3.47.0]'))).not.toContain('shipped in');
    });

    it('is idempotent — a re-run of the workflow does not stamp twice', () => {
        const once = stampChangelog(CHANGELOG, '3.48.0');
        const twice = stampChangelog(once.text, '3.48.0');
        expect(twice.changed).toBe(false);
        expect(twice.reason).toContain('already marked');
        expect(twice.text).toBe(once.text);
        expect(once.text.match(/shipped in 3\.48\.0/g)).toHaveLength(1);
    });

    it('stamps a later release above the previous marker', () => {
        const first = stampChangelog(CHANGELOG, '3.48.0');
        const second = stampChangelog(first.text, '3.49.0');
        expect(second.changed).toBe(true);
        expect(second.text.indexOf(markerFor('3.49.0'))).toBeLessThan(second.text.indexOf(markerFor('3.48.0')));
    });

    it('does not confuse 3.4.0 with 3.48.0', () => {
        const { text } = stampChangelog(CHANGELOG, '3.48.0');
        expect(hasMarker(text, '3.4')).toBe(false);
        expect(hasMarker(text, '3.48.0')).toBe(true);
    });

    it('refuses anything that is not a version', () => {
        for (const bad of ['', null, undefined, 'v3.48.0', 'main']) {
            const result = stampChangelog(CHANGELOG, bad);
            expect(result.changed).toBe(false);
            expect(result.text).toBe(CHANGELOG);
        }
    });

    it('does nothing when there is no unreleased heading to stamp under', () => {
        const result = stampChangelog('# Changelog\n\n## [3.47.0]\n\n- something\n', '3.48.0');
        expect(result.changed).toBe(false);
        expect(result.reason).toContain('Unreleased');
    });

    it('takes the version the release ships, which is what package.json holds on the release branch', () => {
        // The workflow runs this with no argument, so package.json decides. On a
        // release-please branch that file is already bumped — the same source
        // release.yml stamps the published userscript's @version from.
        const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(stampChangelog(CHANGELOG, version).text).toContain(markerFor(version));
    });
});

describe('the real CHANGELOG.md', () => {
    const real = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

    it('stamps under the fork section, not the upstream history', () => {
        const { text, changed } = stampChangelog(real, '9.9.9');
        expect(changed).toBe(true);
        const marker = text.indexOf(markerFor('9.9.9'));
        expect(marker).toBeGreaterThan(text.indexOf('## Unreleased'));
        expect(marker).toBeLessThan(text.indexOf('###'));
    });

    it('a stamped changelog still slices to the same number of entries', () => {
        const before = sliceForkChangelog(real);
        const after = sliceForkChangelog(stampChangelog(real, '9.9.9').text);
        expect(after.shownEntries).toBe(before.shownEntries);
        expect(after.totalEntries).toBe(before.totalEntries);
        expect(after.omittedEntries).toBe(before.omittedEntries);
        expect(after.markerVersions).toEqual(['9.9.9']);
    });
});
