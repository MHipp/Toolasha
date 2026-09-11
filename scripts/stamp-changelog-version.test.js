import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { stampChangelog, hasMarker, markerFor } from './stamp-changelog-version.js';
import { markerVersions } from '../src/features/settings/changelog-markers.js';

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

    it('puts the new marker first and keeps every marker that was already there, in order', () => {
        // A pin to today's single real marker (['9.9.9']) breaks on the next
        // release, once a second marker exists — see the note below. Reading
        // the raw markers with `markerVersions` (not through the slice, which
        // only reports markers that happen to fall inside its shown entries)
        // is what `stampChangelog`'s own contract promises: it only ever
        // inserts one line, directly under the heading, and never touches any
        // other marker already in the file.
        const before = markerVersions(real);
        const after = markerVersions(stampChangelog(real, '9.9.9').text);
        expect(after).toEqual(['9.9.9', ...before]);

        // Deliberately not asserted here: that `sliceForkChangelog`'s entry
        // counts are unchanged by the stamp. That held for today's real
        // changelog (a single marker, nothing between it and the previous
        // release) but is not a general invariant of stamping, so pinning it
        // would only fail again a couple of releases from now for the same
        // reason the four tests this change fixes did. Once
        // `DEFAULT_RELEASES_BACK` (2) or more prior releases already have
        // entries between their markers, adding one more marker — even with
        // no new entries of its own — shifts which stamped marker
        // `entriesToCover` in changelog-slice.js measures against, and the
        // counts change. Confirmed directly: a changelog with 3 markers
        // holding [6, 7, 8] entries, stamped with a 4th that adds nothing new
        // above it, moves shownEntries from 13 to 12 (the floor).
    });
});
